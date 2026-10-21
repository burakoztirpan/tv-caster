import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chromium, type Browser, type Frame, type Page } from 'playwright';
import type { Media } from './proxy.ts';

const blocklist = (() => {
  try {
    return readFileSync(process.env.BLOCKLIST || new URL('../blocklist.txt', import.meta.url), 'utf8')
      .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  } catch { return []; }
})();
export const blocked = (url: string) => {
  const host = new URL(url).hostname;
  return blocklist.some((d) => host === d || host.endsWith('.' + d));
};

const isM3u8 = (url: string, ct = '') => /\.m3u8(\?|$)/i.test(url) || /mpegurl/i.test(ct);
const isMp4 = (url: string, ct = '') => /\.mp4(\?|$)/i.test(url) || /^video\/(mp4|webm)/i.test(ct);
const isAd = (url: string) => /[/._-](ads?|vast|preroll|advert)[/._-]/i.test(url);

let browser: Browser | undefined;
export const getBrowser = async () =>
  (browser?.isConnected() && browser) ||
  (browser = await chromium.launch({ headless: process.env.HEADLESS !== '0', channel: 'chromium', args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] }));

// Click anything that looks like a play button, in every frame. Errors are expected (detached frames etc).
async function poke(frames: Frame[]) {
  for (const f of frames) {
    await f.evaluate(() => {
      document.querySelectorAll('video').forEach((v) => { v.muted = true; v.play().catch(() => {}); });
      const sel = '.jw-icon-display, .vjs-big-play-button, .plyr__control--overlaid, [aria-label*="Play" i], [title*="Play" i], .fp-play';
      document.querySelectorAll<HTMLElement>(sel).forEach((b) => b.click());
      // custom overlays: class like "playSheilaBtn"/"play-btn", or a "Videoyu Başlat" ("start video")-style label (Turkish and English labels); never links (they navigate away)
      document.querySelectorAll<HTMLElement>('button, div, span').forEach((b) => {
        if (b.closest('a[href]') || !b.offsetWidth) return;
        const cls = typeof b.className === 'string' ? b.className.split(/\s+/) : [];
        const label = b.children.length ? '' : (b.textContent ?? '').trim();
        if (cls.some((c) => /^(play[-_]?\w*(btn|button)|btn[-_]?play)$/i.test(c) && !/list/i.test(c)) || /^(videoyu )?(başlat|oynat|izle|play|watch)$/i.test(label)) b.click();
      });
    }).catch(() => {});
  }
}

export const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const MIN_MP4 = 30_000_000; // smaller mp4s are preroll ads, not the film

type Hit = { url: string; headers: Record<string, string> };
const unescape = (s: string) => s.replace(/\\\//g, '/').replace(/\\u0026/g, '&');
// players often hardcode the stream in their HTML/JSON (jwplayer setup, ajax configs) and only fetch it after a click
const findM3u8 = (body: string) => [...unescape(body).matchAll(/https?:\/\/[^"'\s<>\\]+\.m3u8[^"'\s<>\\]*/gi)].map((m) => m[0]);
const findEmbeds = (body: string) => [...unescape(body).matchAll(/https?:\/\/[^"'\s<>\\]+\/(?:embed|e|v|player)[-/][^"'\s<>\\]+/gi)].map((m) => m[0]);

export async function extract(pageUrl: string, timeoutMs = Number(process.env.EXTRACT_TIMEOUT ?? 25000)): Promise<Media & { title: string }> {
  const ctx = await (await getBrowser()).newContext({ viewport: { width: 1280, height: 720 }, userAgent: UA, locale: 'tr-TR' });
  await ctx.addInitScript(() => { window.open = () => null; });
  // once the page is up, the main frame may only navigate where we send it; stray clicks on site links would lose the player
  let navLock = false;
  await ctx.route('**/*', (r) => {
    const q = r.request();
    // frame() throws for navigations of frames/popups that don't exist yet; those are never the main frame
    let main = false;
    try { main = q.isNavigationRequest() && q.frame() === page.mainFrame(); } catch {}
    if (navLock && main) return r.fulfill({ status: 204 }).catch(() => {}); // 204 = stay on page
    if (blocked(q.url())) return r.abort().catch(() => {});
    return r.continue().catch(() => {});
  });
  // anti-automation "devtools-detector" redirects players to a 404 under CDP; replace it with a no-op
  await ctx.route(/devtools?[-_]?(console[-_]?)?detect|disable-devtool/i, (r) =>
    r.fulfill({ contentType: 'application/javascript', body: 'window.devtoolsDetector={addListener(){},removeListener(){},launch(){},stop(){},isLaunch(){return false},setDetectDelay(){}};' }));
  const page: Page = await ctx.newPage();
  ctx.on('page', (p) => p !== page && p.close().catch(() => {})); // pop-unders

  try {
    return await new Promise(async (resolve, reject) => {
      let mp4: Hit | undefined;
      let m3u8: Hit | undefined;
      let done = false;
      let poker: NodeJS.Timeout | undefined;
      let pageTitle = '';
      const embeds = new Set<string>();
      const tried = new Set<string>();
      const finish = async (h: Hit, kind: Media['kind']) => {
        if (done) return;
        done = true;
        clearTimeout(timer); clearInterval(poker);
        const title = pageTitle || (await page.title().catch(() => ''));
        console.log(`[extract] found (${kind}): ${h.url}`);
        resolve({ ...h, kind, title });
      };
      const gotPlaylist = (h: Hit, body: string) => {
        if (body.includes('#EXT-X-STREAM-INF')) return finish(h, 'hls'); // master: best case
        if (!m3u8) { m3u8 = h; setTimeout(() => finish(h, 'hls'), 2000); } // give the master a moment
      };
      const giveUp = () => {
        if (m3u8) return finish(m3u8, 'hls');
        if (mp4) return finish(mp4, 'mp4');
        done = true;
        clearInterval(poker);
        reject(new Error('No video found on the page (timeout)'));
      };
      // search clock starts once the page is open; slow sites shouldn't eat the search time
      let timer: NodeJS.Timeout | undefined;

      // a playlist URL seen only in page source: fetch it ourselves with the embedding page as referer
      const tryStatic = async (url: string, from: string) => {
        if (done || tried.has(url)) return;
        tried.add(url);
        const headers = { referer: from, origin: new URL(from).origin, 'user-agent': UA };
        const body = await fetch(url, { headers }).then((r) => (r.ok ? r.text() : '')).catch(() => '');
        if (!body.includes('#EXTM3U')) return;
        console.log(`[extract] found in page source: ${url}`);
        gotPlaylist({ url, headers }, body);
      };

      ctx.on('response', async (res) => {
        const r = res.request(), url = r.url(), h = res.headers(), ct = h['content-type'] ?? '', type = r.resourceType();
        if (isAd(url) || res.status() >= 400) return;
        // playlists are often disguised (.txt, text/plain); sniff small xhr/fetch bodies too
        const sniff = ['xhr', 'fetch'].includes(type) && /text\/plain|octet-stream/i.test(ct) && Number(h['content-length'] ?? 0) < 200_000;
        if (isM3u8(url, ct) || sniff) {
          const body = await res.text().catch(() => '');
          if (body.includes('#EXTM3U')) gotPlaylist({ url, headers: await r.allHeaders() }, body);
        } else if (!mp4 && isMp4(url, ct) && !/\bblob:/.test(url)) {
          const size = Number(/\/(\d+)$/.exec(h['content-range'] ?? '')?.[1] ?? h['content-length'] ?? 0);
          if (size && size < MIN_MP4) return;
          mp4 = { url, headers: await r.allHeaders() };
          setTimeout(() => !m3u8 && mp4 && finish(mp4, 'mp4'), 1500);
        } else if (type === 'document' || (['xhr', 'fetch'].includes(type) && /json|html|javascript/i.test(ct))) {
          const body = await res.text().catch(() => '');
          findM3u8(body).forEach((u) => tryStatic(u, url));
          if (type !== 'document') findEmbeds(body).forEach((u) => embeds.add(u));
        }
      });

      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch((e) => console.warn(`[extract] goto: ${e.message}`));
      pageTitle = await page.title().catch(() => '');
      navLock = true;
      console.log(`[extract] opened: ${pageTitle}`);
      if (done) return;
      timer = setTimeout(giveUp, timeoutMs);
      let clicks = 0, ticking = false, embedOpened = false;
      // ticks overlap when a page loads slowly; run one at a time or the embed gets reopened (and cancelled) every 2s
      const tick = async () => {
        if (done || ticking) return;
        ticking = true;
        try { await step(); } finally { ticking = false; }
      };
      const step = async () => {
        // parent page blocked (Cloudflare) or stuck behind preroll ads → open the player embed directly
        if (clicks === 2 && !m3u8 && !mp4 && !embedOpened) {
          embedOpened = true;
          const frames = await page.$$eval('iframe', (fs) => fs.map((f) => f.src || f.dataset.src || '')).catch(() => [] as string[]);
          const all = [...frames, ...embeds].filter((u) => /^https?:/.test(u) && !/challenges\.cloudflare|google|facebook|youtube|youtu\.be|vimeo|dailymotion/.test(u) && !blocked(u));
          const embed = all.find((u) => /embed|player|video|iframe/i.test(u)) ?? all[0];
          if (embed) {
            console.log(`[extract] opening embed: ${embed}`);
            navLock = false;
            await page.goto(embed, { referer: pageUrl, waitUntil: 'domcontentloaded' }).catch(() => {});
            navLock = true;
          }
        }
        if (process.env.DEBUG) console.log(`[extract] tick ${clicks}: ${page.frames().map((f) => f.url().slice(0, 60)).filter((u) => u !== 'about:blank').join(' | ')}`);
        await poke(page.frames());
        // real click on the biggest player element; first clicks often just eat an overlay ad
        if (clicks++ < 6) {
          const box = await page.evaluate(() => {
            const els = [...document.querySelectorAll('iframe, video')].map((e) => e.getBoundingClientRect()).filter((r) => r.width > 200 && r.height > 120);
            const r = els.sort((a, b) => b.width * b.height - a.width * a.height)[0];
            return r && { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          }).catch(() => undefined);
          if (box) await page.mouse.click(box.x, box.y).catch(() => {});
        }
      };
      if (!done) poker = setInterval(tick, 2000);
      tick();
    });
  } finally {
    await ctx.close().catch(() => {});
  }
}

/**
 * Fallback: yt-dlp knows thousands of mainstream sites (YouTube, Vimeo, news sites…). It can't open pages like a
 * browser, so it fails on the sites the Playwright path handles; together they cover both.
 * Picks a single-file format (HLS or MP4 with audio) since the TV needs one URL.
 */
export function ytdlp(pageUrl: string): Promise<Media & { title: string; generic: boolean }> {
  return new Promise((resolve, reject) => {
    execFile('yt-dlp', ['--no-warnings', '--no-playlist', '-j', '-f', 'b[protocol^=m3u8]/b[ext=mp4]/b', '--', pageUrl], { timeout: 30_000, maxBuffer: 50e6 }, (err, out, errOut) => {
      if (err) return reject(new Error(errOut.split('\n').find((l) => l.startsWith('ERROR')) ?? err.message));
      try {
        const j = JSON.parse(out);
        const kind: Media['kind'] = /m3u8/.test(j.protocol ?? '') || /\.m3u8/.test(j.url) ? 'hls' : 'mp4';
        console.log(`[extract] yt-dlp found (${kind}, ${j.extractor_key}): ${String(j.url).slice(0, 100)}`);
        // 'Generic' = yt-dlp guessed from raw HTML (may be a trailer); site-specific extractors are trustworthy
        resolve({ url: j.url, headers: j.http_headers ?? {}, kind, title: j.title ?? '', generic: j.extractor_key === 'Generic' });
      } catch (e) { reject(e); }
    });
  });
}

// Browser extraction and yt-dlp run side by side. A site-specific yt-dlp hit (YouTube, Dailymotion…) wins right
// away; yt-dlp's generic HTML guess is only used if the browser path fails (it can pick a trailer instead of the film).
export async function findMedia(url: string) {
  const yt = ytdlp(url).catch(() => undefined);
  const site = yt.then((r) => (r && !r.generic ? r : new Promise<never>(() => {})));
  const r = await Promise.race([extract(url).catch((e: Error) => e), site]);
  if (!(r instanceof Error)) return r;
  const g = await yt;
  if (!g) throw r;
  console.warn(`[extract] browser found nothing, using yt-dlp result`);
  return g;
}
