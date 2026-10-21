import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

export type Media = { url: string; headers: Record<string, string>; kind: 'hls' | 'mp4' };
type Session = Media & { from?: number; hosts: Set<string> }; // hosts: only these may be fetched (no open proxy) // from = seek point (s) for the ts remux, applied by trimming playlists
// ponytail: in-memory, sessions live until restart; fine for one TV
const sessions = new Map<string, Session>();

const KEEP = ['user-agent', 'referer', 'origin', 'cookie', 'authorization', 'accept-language'];
const DLNA = {
  'transferMode.dlna.org': 'Streaming',
  'contentFeatures.dlna.org': 'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000',
};

// The CDN sometimes stalls a segment download forever. Like browser players we time out, retry, and read ahead
// so one stuck segment doesn't drain the TV's buffer (an empty buffer makes the Samsung player quit and drop Wi-Fi).
const PREFETCH = 4;
const SEG_TIMEOUT = 6_000; // healthy segments arrive in <2s
const nextOf = new Map<string, string[]>();
type Seg = { buf: Buffer; type: string };
const segCache = new Map<string, Promise<Seg>>();
function getSeg(url: string, headers: Record<string, string>, id: string): Promise<Seg> {
  let p = segCache.get(url);
  if (p) return p;
  p = (async () => {
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await fetch(url, { headers, signal: AbortSignal.timeout(SEG_TIMEOUT) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return { buf: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') ?? 'application/octet-stream' };
      } catch (e: any) {
        console.warn(`[proxy] ${id} segment attempt ${attempt}/5 failed (${e.name === 'TimeoutError' ? 'stalled' : e.message}): ${url.slice(-50)}`);
        if (attempt >= 5) throw e;
      }
    }
  })();
  segCache.set(url, p);
  p.catch(() => segCache.delete(url));
  // ponytail: FIFO cap ~ a few hundred MB worst case; plenty for one stream
  while (segCache.size > 40) segCache.delete(segCache.keys().next().value!);
  return p;
}

const SEG_EXT = ['m3u8', 'ts', 'm4s', 'mp4', 'm4a', 'm4v', 'aac', 'mp3', 'vtt', 'key'];
// live remux can't serve byte ranges: OP=00
const LIVE = { ...DLNA, 'contentFeatures.dlna.org': 'DLNA.ORG_OP=00;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000' };
const enc = (u: string) => Buffer.from(u).toString('base64url');
const dec = (s: string) => Buffer.from(s, 'base64url').toString();

export function createSession(m: Media) {
  const id = randomBytes(4).toString('hex');
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(m.headers)) if (KEEP.includes(k.toLowerCase())) headers[k.toLowerCase()] = v;
  headers['user-agent'] ??= 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
  sessions.set(id, { ...m, headers, hosts: new Set([new URL(m.url).host]) });
  return id;
}

export const sessionUrl = (base: string, id: string) => `${base}/s/${id}/${enc(sessions.get(id)!.url)}${sessions.get(id)!.kind === 'hls' ? '.m3u8' : '.mp4'}`;
// where the running ts stream actually starts (seek point snapped to a video segment start)
export const streamStart = (id: string) => sessions.get(id)?.from;
export const tsUrl = (base: string, id: string, ss = 0) => `${base}/s/${id}/live.ts${ss ? `?ss=${ss}` : ''}`;

// Seek by dropping media segments that end before `from`. ffmpeg's own -ss on split audio/video renditions starts
// audio ~5s before the first video frame, and Samsung rejects that ("file information not detected").
// Segments start on keyframes, so both renditions begin together. KEY/MAP state tags are kept.
// Start (s) of the best variant's segment containing `ss`: the seek point both renditions are trimmed to.
async function videoStart(s: Session, ss: number) {
  const get = async (u: string) => (await fetch(u, { headers: s.headers, signal: AbortSignal.timeout(8000) })).text();
  let url = s.url, text = await get(url);
  const inf = [...text.matchAll(/#EXT-X-STREAM-INF:([^\n]*)\n\s*(\S+)/g)];
  if (inf.length) {
    const best = inf.reduce((a, b) => (Number(/BANDWIDTH=(\d+)/.exec(b[1])?.[1] ?? 0) > Number(/BANDWIDTH=(\d+)/.exec(a[1])?.[1] ?? 0) ? b : a));
    url = new URL(best[2], url).href;
    text = await get(url);
  }
  let t = 0;
  for (const m of text.matchAll(/#EXTINF:([\d.]+)/g)) {
    if (t + Number(m[1]) > ss) return t;
    t += Number(m[1]);
  }
  return ss;
}

export function trim(lines: string[], from: number, nearest = false) {
  const head: string[] = [], keep: string[] = [], state = new Map<string, string>();
  let t = 0, seg: string[] = [], started = false, dropping = true;
  for (const l of lines) {
    if (!started && !l.startsWith('#EXTINF') && !(l.trim() && !l.startsWith('#'))) {
      const k = /^#EXT-X-(KEY|MAP)/.exec(l)?.[1];
      if (k) state.set(k, l); else head.push(l);
      continue;
    }
    started = true;
    seg.push(l);
    if (!l.trim() || l.startsWith('#')) continue;
    const dur = Number(/#EXTINF:([\d.]+)/.exec(seg.find((x) => x.startsWith('#EXTINF')) ?? '')?.[1] ?? 0);
    // contain: keep the segment holding `from`. nearest (audio): if that segment starts >2s early and the next
    // one is closer, skip it too, so audio starts within ~2s of the video keyframe at `from`
    const lead = from - t, lag = t + dur - from;
    if (dropping && (t + dur <= from || (nearest && lead > 2 && lag < lead))) {
      for (const x of seg) { const k = /^#EXT-X-(KEY|MAP)/.exec(x)?.[1]; if (k) state.set(k, x); }
    } else {
      // carry KEY/MAP from dropped segments unless this segment sets its own
      if (dropping) keep.push(...[...state].filter(([k]) => !seg.some((x) => x.startsWith(`#EXT-X-${k}`))).map(([, v]) => v));
      dropping = false;
      keep.push(...seg);
    }
    t += dur;
    seg = [];
  }
  return [...head, ...keep, ...seg];
}

function rewrite(body: string, src: string, prefix: string, from = 0, audio = false, hosts?: Set<string>) {
  const p = (u: string, playlist = false, aud = false) => {
    const abs = new URL(u, src).href;
    hosts?.add(new URL(abs).host);
    if (aud) return `${prefix}/${enc(abs)}.a.m3u8`; // audio rendition: trimmed to the segment nearest the video start
    const ext = playlist ? 'm3u8' : /\.(\w+)$/.exec(new URL(abs).pathname)?.[1]?.toLowerCase() ?? '';
    // ffmpeg's hls demuxer only accepts known segment extensions; disguised segments (.png/.jpg/.txt) become .ts
    return `${prefix}/${enc(abs)}.${SEG_EXT.includes(ext) ? ext : 'ts'}`;
  };
  let lines = body.split(/\r?\n/);
  // master playlist: keep only the highest-bandwidth variant (home LAN, no need for ABR)
  const bw = (l: string) => Number(/BANDWIDTH=(\d+)/.exec(l)?.[1] ?? 0);
  const inf = lines.map((l, i) => [l, i] as const).filter(([l]) => l.startsWith('#EXT-X-STREAM-INF'));
  if (inf.length > 1) {
    const best = inf.reduce((a, b) => (bw(b[0]) > bw(a[0]) ? b : a))[1];
    const drop = new Set(inf.filter(([, i]) => i !== best).flatMap(([, i]) => [i, i + 1]));
    lines = lines.filter((_, i) => !drop.has(i));
  }
  if (from > 0 && body.includes('#EXTINF')) lines = trim(lines, from, audio);
  // media playlist: remember segment order so a request for one segment can prefetch the next few
  if (body.includes('#EXTINF')) {
    const segs = lines.filter((l) => l.trim() && !l.startsWith('#')).map((l) => new URL(l.trim(), src).href);
    segs.forEach((u, i) => nextOf.set(u, segs.slice(i + 1, i + 1 + PREFETCH)));
  }
  return lines
    .map((line, i) => {
      const l = line.trim();
      if (!l) return line;
      // EXT-X-MEDIA / I-FRAME-STREAM-INF URIs and lines after STREAM-INF are playlists even without .m3u8 in the path
      if (l.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${p(u, /^#EXT-X-(MEDIA|I-FRAME-STREAM-INF):/.test(l), /^#EXT-X-MEDIA:.*TYPE=AUDIO/.test(l))}"`);
      return p(l, lines[i - 1]?.startsWith('#EXT-X-STREAM-INF'));
    })
    .join('\n');
}

export async function handle(req: IncomingMessage, res: ServerResponse, base: string) {
  const [, , id, rest = ''] = req.url!.split('?')[0].split('/'); // /s/:id/:rest
  const s = sessions.get(id);
  if (!s) return void res.writeHead(404).end('no session');

  if (rest === 'live.ts') {
    if (req.method === 'HEAD') return void res.writeHead(200, { 'content-type': 'video/mp2t', ...LIVE }).end();
    const ss = Number(new URL(req.url!, base).searchParams.get('ss')) || 0;
    s.from = ss && (await videoStart(s, ss).catch(() => ss));
    return remux(res, `${base}/s/${id}/${enc(s.url)}.m3u8`, id, s.from);
  }

  const target = dec(rest.split('.')[0]);
  // only hosts the video itself points at (its playlists/segments), never arbitrary URLs with the site's cookies
  let host = '';
  try { host = new URL(target).host; } catch {}
  if (!s.hosts.has(host)) return void res.writeHead(403).end('host not allowed');
  const headers: Record<string, string> = { ...s.headers };
  if (req.headers.range) headers.range = req.headers.range;

  // HLS segments: served from a prefetch cache (see getSeg); only complete segments reach ffmpeg/TV
  const ext = rest.split('.').pop() ?? '';
  if (s.kind === 'hls' && req.method === 'GET' && ext !== 'm3u8' && SEG_EXT.includes(ext)) {
    for (const n of nextOf.get(target) ?? []) getSeg(n, headers, id).catch(() => {});
    try {
      const { buf, type } = await getSeg(target, headers, id);
      return void res.writeHead(200, { 'content-type': ext === 'ts' ? 'video/mp2t' : type, 'content-length': buf.length }).end(buf);
    } catch {
      return void res.writeHead(504).end();
    }
  }

  let up: Response;
  try {
    up = await fetch(target, { method: req.method === 'HEAD' ? 'HEAD' : 'GET', headers, redirect: 'follow' });
  } catch (e) {
    console.error(`[proxy] ${id} fetch error: ${target}`, e);
    return void res.writeHead(502).end();
  }
  const ct = up.headers.get('content-type') ?? '';
  const isPlaylist = /mpegurl/i.test(ct) || /\.m3u8(\?|$)/i.test(target) || rest.endsWith('.m3u8');

  if (isPlaylist && up.ok) {
    const text = await up.text();
    if (text.trimStart().startsWith('#EXTM3U')) {
      s.hosts.add(new URL(up.url).host); // after redirects
      const out = rewrite(text, up.url, `${base}/s/${id}`, s.from, rest.endsWith('.a.m3u8'), s.hosts);
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-cache', ...DLNA });
      return void (req.method === 'HEAD' ? res.end() : res.end(out));
    }
    // ponytail: not actually a playlist, serve as-is
    res.writeHead(up.status, { 'content-type': ct || 'application/octet-stream' });
    return void res.end(text);
  }

  const out: Record<string, string> = { ...DLNA, 'accept-ranges': 'bytes' };
  for (const h of ['content-type', 'content-length', 'content-range', 'last-modified', 'etag']) {
    const v = up.headers.get(h);
    if (v) out[h] = v;
  }
  // some CDNs disguise TS segments as image/text; TV must not see that
  if (!/video|audio|octet|mp2t|mp4/i.test(out['content-type'] ?? '')) out['content-type'] = s.kind === 'mp4' ? 'video/mp4' : 'video/mp2t';
  if (!up.ok) console.warn(`[proxy] ${id} upstream ${up.status}: ${target.slice(0, 120)}`);
  res.writeHead(up.status, out);
  if (req.method === 'HEAD' || !up.body) return void res.end();
  const body = Readable.fromWeb(up.body as any);
  res.on('close', () => body.destroy());
  body.pipe(res);
}

// Fallback for TVs that won't play HLS: remux (no re-encode) the proxied playlist into one MPEG-TS stream.
function remux(res: ServerResponse, input: string, id: string, ss: number) {
  console.log(`[proxy] ${id} ffmpeg remux started${ss ? ` (at ${ss}s)` : ''}`);
  res.writeHead(200, { 'content-type': 'video/mp2t', ...LIVE });
  const ff = spawn('ffmpeg', ['-loglevel', 'error', '-reconnect', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '5',
    // pace output: 60s head start, then 2x realtime (gentler on Wi-Fi than unpaced bursts); rw_timeout = never hang forever
    '-readrate', '2', '-readrate_initial_burst', '60', '-rw_timeout', '60000000',
    '-i', input, '-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy', '-f', 'mpegts', 'pipe:1']);
  ff.stdout.pipe(res);
  ff.stderr.on('data', (d) => console.error(`[ffmpeg] ${d}`.trim()));
  const t0 = Date.now();
  let sent = 0;
  ff.stdout.on('data', (c: Buffer) => (sent += c.length));
  const info = () => `${(sent / 1e6).toFixed(1)} MB / ${Math.round((Date.now() - t0) / 1000)}s`;
  const tick = process.env.DEBUG ? setInterval(() => console.log(`[proxy] ${id} stream: ${info()}`), 15_000) : undefined;
  ff.on('exit', (code, sig) => console.log(`[proxy] ${id} ffmpeg exited (${sig ?? code}), ${info()}`));
  res.on('close', () => {
    clearInterval(tick);
    console.log(`[proxy] ${id} TV closed the connection, ${info()}`);
    ff.kill('SIGKILL');
  });
}
