import http from 'node:http';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import * as dlna from './dlna.ts';
import { findMedia } from './extractor.ts';
import { episodeUrl, findEpisodes, parseEpisode } from './episodes.ts';
import * as history from './history.ts';
import { createSession, handle, sessionUrl, streamStart, tsUrl, type Media } from './proxy.ts';

const PORT = Number(process.env.PORT ?? 8787);
const HOST_IP =
  process.env.HOST_IP ||
  Object.values(os.networkInterfaces()).flat().find((i) => i?.family === 'IPv4' && !i.internal)?.address ||
  '127.0.0.1';
const BASE = `http://${HOST_IP}:${PORT}`;
// 'auto' = playlist straight to the TV (native seek) unless audio is a separate rendition, which Samsung's DMR
// can't merge → ffmpeg remux. 'hls' / 'ts' force one path.
const HLS_MODE = process.env.HLS_MODE ?? 'auto';
const secs = (t: string) => t.split(':').reduce((a, p) => a * 60 + Number(p), 0) || 0;
const hms = (s: number) => new Date(s * 1000).toISOString().slice(11, 19);
// sum of EXTINF in the (single, best) media playlist our proxy serves
async function hlsDuration(url: string): Promise<number> {
  let text = await (await fetch(url)).text();
  const variant = /#EXT-X-STREAM-INF[^\n]*\n(\S+)/.exec(text)?.[1];
  if (variant) text = await (await fetch(variant)).text();
  if (!text.includes('#EXT-X-ENDLIST')) return 0; // live stream
  return Math.round([...text.matchAll(/#EXTINF:([\d.]+)/g)].reduce((a, m) => a + Number(m[1]), 0));
}

const page = readFileSync(new URL('../public/index.html', import.meta.url));

let last: { title: string; source: string; media: string; key: string; season?: number; episode?: number } | undefined;
// ts mode: TV sees a live stream and can't seek, so we restart ffmpeg at an offset instead
let live: { id: string; title: string; offset: number } | undefined;
const offset = () => (live ? (streamStart(live.id) ?? live.offset) : 0);
let duration = 0; // seconds, from the playlist (TV reports 0 for ts streams)
// what's on the TV now, so the watchdog can re-send it
let current: { id: string; url: string; mime: string; title: string } | undefined;
let wantPlaying = false; // user intent: true from cast until Stop
let quietUntil = 0; // watchdog ignores the TV while a cast/seek/resume is settling

async function cast(url: string, resume = false) {
  const t0 = Date.now();
  const direct = /\.(m3u8|mp4)(\?|$)/i.test(url);
  const m: Media & { title?: string } = direct
    ? { url, headers: {}, kind: /\.m3u8/i.test(url) ? 'hls' : 'mp4' }
    : await findMedia(url);
  const id = createSession(m);
  const saved = history.get(parseEpisode(url)?.key ?? url);
  const savedPos = saved?.url === url && saved.pos && saved.pos > 60 ? saved.pos : 0;
  const startAt = resume ? savedPos : 0;
  const toTv =
    HLS_MODE === 'hls' ||
    (HLS_MODE === 'auto' && m.kind === 'hls' &&
      !/#EXT-X-MEDIA:[^\n]*TYPE=AUDIO[^\n]*URI=/.test(await (await fetch(sessionUrl(BASE, id))).text().catch(() => '')));
  const [tvUrl, mime] =
    m.kind === 'mp4' ? [sessionUrl(BASE, id), 'video/mp4']
    : toTv ? [sessionUrl(BASE, id), 'application/vnd.apple.mpegurl']
    : [tsUrl(BASE, id, startAt), 'video/mp2t'];
  console.log(`[cast] path: ${m.kind === 'mp4' ? 'mp4' : toTv ? 'hls (TV direct)' : 'ts (ffmpeg, separate audio)'}, session ${id}`);
  const title = m.title?.split(/\s[|–]\s/)[0].replace(/\s+izle$/i, '') || new URL(url).hostname;
  quietUntil = Date.now() + 25_000;
  await dlna.cast(tvUrl, mime, title);
  live = mime === 'video/mp2t' ? { id, title, offset: startAt } : undefined;
  current = { id, url: tvUrl, mime, title };
  wantPlaying = true;
  watch = { good: startAt, lastPos: -1, since: Date.now(), tries: 0, from: 0, total: 0, stoppedAt: 0, offlineAt: 0, wentOffline: false };
  userPaused = false;
  duration = m.kind === 'hls' ? await hlsDuration(sessionUrl(BASE, id)).catch(() => 0) : 0;
  const h = history.record(url, title);
  last = { title, source: url, media: m.url, key: h.key, season: h.season, episode: h.episode };
  // ts streams start at the offset directly; HLS/MP4 on the TV need a Seek once it's actually playing
  if (startAt && mime !== 'video/mp2t') seekWhenPlaying(startAt);
  if (h.season && !h.seasons) episodesOf(h.key).catch(() => {}); // warm the episode list in the background
  console.log(`[cast] ${((Date.now() - t0) / 1000).toFixed(1)}s: ${title}`);
  return { ...last, savedPos: resume ? 0 : savedPos };
}

// Episode lists are slow to build (several pages); cache per series, one search at a time per series.
const searching = new Map<string, Promise<history.Entry['seasons']>>();
async function episodesOf(key: string) {
  const e = history.get(key);
  if (!e) throw new Error('No such show in history');
  if (e.seasons?.length) return e.seasons;
  let p = searching.get(key);
  if (!p) {
    p = findEpisodes(e.url).then((s) => (history.setSeasons(key, s.name, s.seasons), s.seasons)).finally(() => searching.delete(key));
    searching.set(key, p);
  }
  return p;
}
function nextEpisode(e: history.Entry) {
  const all = (e.seasons ?? []).flatMap((s) => s.episodes.map((x) => ({ season: s.season, ...x })));
  const i = all.findIndex((x) => x.season === e.season && x.episode === e.episode);
  return i >= 0 ? all[i + 1] : undefined;
}

const json = (res: http.ServerResponse, code: number, body: unknown) =>
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));

async function readBody(req: http.IncomingMessage) {
  let s = '';
  for await (const c of req) s += c;
  try { return JSON.parse(s); } catch { return { url: s.trim() }; }
}

let seekTarget: number | undefined;
let seeking: Promise<void> | undefined;
async function seekWhenPlaying(t: number) {
  for (let i = 0; i < 30; i++) {
    await new Promise((ok) => setTimeout(ok, 1000));
    if ((await dlna.status().catch(() => undefined))?.state === 'PLAYING') return dlna.seekTo(t).catch(() => {});
  }
}
async function seekTo(t: number) {
  quietUntil = Date.now() + 25_000;
  Object.assign(watch, { good: t, lastPos: -1, since: Date.now(), stoppedAt: 0, wentOffline: false });
  if (!live) return dlna.seekTo(t);
  live.offset = t;
  await dlna.cast(tsUrl(BASE, live.id, t), 'video/mp2t', live.title);
}

// Watchdog: resume after the TV's player gives up on its own. A crash looks like STOPPED followed within ~40s by the
// TV dropping off Wi-Fi; a remote-control stop leaves it reachable. So: STOPPED + went offline → resume when back;
// STOPPED and still reachable after 60s → the user stopped it, leave it alone. A 30s freeze while playing also resumes.
let watch = { good: 0, lastPos: -1, since: Date.now(), tries: 0, from: 0, total: 0, stoppedAt: 0, offlineAt: 0, wentOffline: false };
let userPaused = false;
let resuming = false;
setInterval(async () => {
  if (!wantPlaying || !current || userPaused || resuming || Date.now() < quietUntil) return;
  const st = await tvState().then(([s]) => s, () => undefined);
  if (!st) {
    watch.offlineAt ||= Date.now();
    if (watch.stoppedAt) watch.wentOffline = true;
    if (Date.now() - watch.offlineAt > 5 * 60_000) wantPlaying = false; // TV switched off: forget it
    return;
  }
  watch.offlineAt = 0;
  const pos = secs(st.position) + offset();
  if (st.state === 'PLAYING') watch.total = secs(st.duration) || watch.total;
  if (st.state === 'PAUSED_PLAYBACK') return void (watch.since = Date.now());
  if (st.state === 'PLAYING' && pos !== watch.lastPos) {
    Object.assign(watch, { lastPos: pos, good: pos, since: Date.now(), stoppedAt: 0, wentOffline: false });
    if (last) history.setPos(last.key, last.source, pos, duration || watch.total);
    if (pos - watch.from > 120) watch.tries = 0; // healthy for 2 min: forget earlier hiccups
    return;
  }
  const end = duration || watch.total;
  if (end && watch.good > end - 60) {
    // reached the end: nothing to resume next time
    if (last) history.setPos(last.key, last.source, 0, end);
    return void (wantPlaying = false);
  }
  if (st.state === 'STOPPED') {
    watch.stoppedAt ||= Date.now();
    if (!watch.wentOffline) {
      if (Date.now() - watch.stoppedAt > 60_000) wantPlaying = false; // stopped on purpose (remote / other app)
      return;
    }
  } else if (Date.now() - watch.since < 30_000) return; // playing/transitioning but not frozen long enough
  await resume(st.state === 'STOPPED' ? 'stopped' : 'froze');
}, 5000);

async function resume(why: string) {
  if (++watch.tries > 8) return void ((wantPlaying = false), console.warn('[watch] too many attempts, giving up'));
  const t = Math.max(0, Math.round(watch.good) - 5);
  console.warn(`[watch] TV ${why} at ${hms(watch.good)}, resuming from ${hms(t)} (attempt ${watch.tries})`);
  Object.assign(watch, { since: Date.now(), from: t, stoppedAt: 0, wentOffline: false });
  resuming = true;
  try {
    if (watch.tries >= 3 && last) {
      // links may have expired: extract again from the page, then seek
      const tries = watch.tries;
      await cast(last.source);
      watch.tries = tries;
      await seekTo(t);
    } else if (live) await seekTo(t);
    else {
      quietUntil = Date.now() + 25_000;
      await dlna.cast(current!.url, current!.mime, current!.title);
      // TV refuses Seek until it is actually playing
      for (let i = 0; i < 20; i++) {
        await new Promise((ok) => setTimeout(ok, 1000));
        if ((await dlna.status().catch(() => undefined))?.state === 'PLAYING') { await dlna.seekTo(t); break; }
      }
    }
  } catch (e: any) {
    console.warn(`[watch] resume failed: ${e.message}`);
  } finally {
    resuming = false;
  }
}

// Samsung's DMR chokes on frequent SOAP polling; every client shares one TV query per 2s
let cache: { at: number; p: ReturnType<typeof queryTv> } | undefined;
const queryTv = () => Promise.all([dlna.status(), dlna.getVolume()]);
function tvState() {
  if (!cache || Date.now() - cache.at > 2000) {
    cache = { at: Date.now(), p: queryTv() };
    cache.p.catch(() => (cache = undefined));
  }
  return cache.p;
}

// save where we are right now (stop/pause), not up to 20s ago
function keepPos() {
  if (!last || !watch.good) return;
  history.setPos(last.key, last.source, watch.good, duration || watch.total);
  history.flush();
}

const controls: Record<string, (q: URLSearchParams) => Promise<unknown>> = {
  play: () => ((userPaused = false), dlna.play()),
  pause: () => ((userPaused = true), keepPos(), dlna.pause()),
  stop: () => ((wantPlaying = false), keepPos(), dlna.stop()),
  // ?t=abs seconds or ?d=relative seconds. Rapid seeks (slider + button) collapse into the last one.
  seek: async (q) => {
    const pos = secs((await dlna.status()).position) + offset();
    const t = q.has('t') ? Number(q.get('t')) : pos + Number(q.get('d') ?? 0);
    seekTarget = Math.round(Math.max(0, duration ? Math.min(t, duration - 5) : t));
    seeking ??= (async () => {
      while (seekTarget !== undefined) {
        const t = seekTarget;
        seekTarget = undefined;
        await seekTo(t);
      }
    })().finally(() => (seeking = undefined));
    await seeking;
  },
  // ?v=abs 0-100 or ?d=relative
  volume: async (q) => ({ volume: await dlna.setVolume(q.has('v') ? Number(q.get('v')) : (await dlna.getVolume()).volume + Number(q.get('d') ?? 0)) }),
  mute: async (q) => dlna.setMute(q.get('on') === '1'),
};

const server = http.createServer(async (req, res) => {
    const u = new URL(req.url!, BASE);
    if (!u.pathname.startsWith('/s/') && u.pathname !== '/status') console.log(`[http] ${req.socket.remoteAddress} ${req.method} ${u.pathname}`);
    // CSRF: any website the user visits could fire simple cross-origin POSTs at this LAN server. Requiring a JSON
    // content type forces a CORS preflight, which we never grant, so only our own panel/scripts get through.
    if (req.method === 'POST' && !/^application\/json/i.test(req.headers['content-type'] ?? ''))
      return json(res, 415, { ok: false, error: 'Content-Type must be application/json' });
    try {
      if (u.pathname.startsWith('/s/')) {
        if (process.env.DEBUG) console.log(`[http] ${req.socket.remoteAddress} ${req.method} ${u.pathname.slice(0, 60)} range=${req.headers.range ?? '-'} ua=${req.headers['user-agent']}`);
        return await handle(req, res, BASE);
      }
      if (u.pathname === '/' && req.method === 'GET') return void res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page);
      if (u.pathname === '/cast' && req.method === 'POST') {
        const { url, resume } = await readBody(req);
        // iOS share sheet sometimes sends "title https://..." text
        const target = /https?:\/\/\S+/.exec(String(url ?? ''))?.[0];
        if (!target) return json(res, 400, { ok: false, error: 'url is required' });
        console.log(`[cast] request: ${target}`);
        return json(res, 200, { ok: true, ...(await cast(target, !!resume)) });
      }
      if (u.pathname === '/history' && req.method === 'GET') {
        return json(res, 200, history.list().map(({ seasons, ...e }) => ({ ...e, series: !!e.season, next: nextEpisode({ seasons, ...e }) })));
      }
      if (u.pathname === '/history/remove' && req.method === 'POST') {
        history.remove(u.searchParams.get('key') ?? '');
        return json(res, 200, { ok: true });
      }
      // play season/episode of a series in history: the real link from the episode list, else rewrite the last URL
      if (u.pathname === '/play-episode' && req.method === 'POST') {
        const e = history.get(u.searchParams.get('key') ?? '');
        const season = Number(u.searchParams.get('season')), episode = Number(u.searchParams.get('episode'));
        if (!e || !season || !episode) return json(res, 400, { ok: false, error: 'Season and episode are required' });
        const url = e.seasons?.find((s) => s.season === season)?.episodes.find((x) => x.episode === episode)?.url ?? episodeUrl(e.url, season, episode);
        if (!url) return json(res, 400, { ok: false, error: 'No season/episode found in this link' });
        console.log(`[cast] request: ${url}`);
        return json(res, 200, { ok: true, ...(await cast(url)) });
      }
      if (u.pathname === '/episodes' && req.method === 'GET') {
        const key = u.searchParams.get('key') ?? '';
        const e = history.get(key);
        // ?refresh=1 drops the cache (new episodes aired)
        if (e && u.searchParams.get('refresh')) history.setSeasons(key, '', []);
        const seasons = await episodesOf(key);
        return json(res, 200, { ok: true, name: history.get(key)?.name, season: e?.season, episode: e?.episode, seasons });
      }
      if (u.pathname === '/status') {
        const [st, vol] = await tvState();
        const position = secs(st.position) + offset();
        return json(res, 200, { ...st, ...vol, ...last, position: hms(position), seconds: position, total: duration || secs(st.duration) });
      }
      const action = u.pathname.slice(1);
      if (req.method === 'POST' && controls[action]) {
        // ponytail: no retry while the TV is TRANSITIONING; hammering it there crashes Samsung's DMR. UI blocks instead.
        const r = await controls[action](u.searchParams);
        return json(res, 200, { ok: true, ...(r && typeof r === 'object' ? r : {}) });
      }
      json(res, 404, { ok: false, error: 'not found' });
    } catch (e: any) {
      console.error(`[err] ${u.pathname}: ${e.message}`);
      if (!res.headersSent) json(res, 500, { ok: false, error: e.message });
    }
});
// a stray error in one request (e.g. a Playwright callback) must not take down the server and the film on the TV
process.on('uncaughtException', (e) => console.error('[crash prevented]', e));
process.on('unhandledRejection', (e) => console.error('[crash prevented]', e));
server.keepAliveTimeout = 65_000; // default 5s races ffmpeg's connection reuse → "Error reading HTTP response: End of file"
server.headersTimeout = 66_000;
server.listen(PORT, () => console.log(`[server] ${BASE}  (HLS_MODE=${HLS_MODE})`));
