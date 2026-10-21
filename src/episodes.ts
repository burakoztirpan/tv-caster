import { blocked, getBrowser, UA } from './extractor.ts';

export type Episode = { episode: number; url: string };
export type Season = { season: number; episodes: Episode[] };
export type Series = { key: string; name: string; seasons: Season[] };

// Episode URLs across sites: /sezon-1/bolum-2, one-piece-2-sezon-3-bolum, season-1-episode-2, s01e02
const EP = [
  /\/sezon-(\d+)\/bolum-(\d+)/i,
  /-(\d+)-sezon-(\d+)-bolum/i,
  /season-(\d+)[-/].*?episode-(\d+)/i,
  /[-_/]s(\d{1,2})e(\d{1,3})(?=[-_/.]|$)/i,
];

/** Season/episode of a page URL, plus a key for the series that survives domain hops (site2141.com → site2142.com). */
export function parseEpisode(href: string) {
  let u: URL;
  try { u = new URL(href); } catch { return undefined; }
  for (const re of EP) {
    const m = re.exec(u.pathname);
    if (!m) continue;
    const slug = u.pathname.slice(0, m.index);
    return {
      season: Number(m[1]),
      episode: Number(m[2]),
      key: u.hostname.replace(/^www\./, '').replace(/\d+/g, '') + slug,
      core: slug.split('/').filter(Boolean).pop() ?? '', // "one-piece", "my-brilliant-friend-izle-1"
    };
  }
}

const seasonPage = (path: string, core: string) =>
  path.includes(core) && /(?:^|[/-])(\d+)-sezon(?:[-/]|$)|\/sezon-(\d+)\/?$/i.test(path) && !EP.some((re) => re.test(path));

/**
 * Find all seasons/episodes of the series `pageUrl` belongs to: links on the episode page, then the series page
 * ("Tüm Bölümler" = "all episodes", /diziler/<name>/) and any per-season pages it links to.
 */
export async function findEpisodes(pageUrl: string): Promise<Series> {
  const me = parseEpisode(pageUrl);
  if (!me) throw new Error('This link does not look like a TV show episode');
  const ctx = await (await getBrowser()).newContext({ userAgent: UA, locale: 'tr-TR' });
  await ctx.route('**/*', (r) => (blocked(r.request().url()) || ['image', 'font', 'media'].includes(r.request().resourceType()) ? r.abort() : r.continue()));
  const page = await ctx.newPage();
  const eps = new Map<string, Episode & { season: number }>();
  eps.set(`${me.season}x${me.episode}`, { season: me.season, episode: me.episode, url: pageUrl });
  const visited = new Set<string>();
  let name = '';

  const scan = async (url: string) => {
    if (visited.has(url) || visited.size >= 14) return [] as { href: string; text: string }[];
    visited.add(url);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(800);
    const links = await page.$$eval('a[href]', (as) => as.map((a) => ({ href: (a as HTMLAnchorElement).href.split('#')[0], text: a.textContent?.trim() ?? '' }))).catch(() => []);
    for (const l of links) {
      const p = parseEpisode(l.href);
      if (p?.key === me.key) eps.set(`${p.season}x${p.episode}`, { season: p.season, episode: p.episode, url: l.href });
    }
    return links;
  };

  try {
    const first = await scan(pageUrl);
    const title = await page.title().catch(() => '');
    name = title.split(/\s[|–-]\s/)[0].replace(/\s*\d+\.\s*sezon.*$/i, '').replace(/\s+izle$/i, '').trim();

    // series home: same host, last path segment = series name, not an episode
    const host = new URL(pageUrl).host;
    const home = first
      .map((l) => l.href)
      .filter((h) => { try { const u = new URL(h); return u.host === host && u.pathname.split('/').filter(Boolean).pop() === me.core && !parseEpisode(h); } catch { return false; } })
      .sort((a, b) => Number(/\/(dizi|diziler|series)\//.test(b)) - Number(/\/(dizi|diziler|series)\//.test(a)))[0];
    const homeLinks = home ? await scan(home) : [];
    if (home) {
      const t = await page.title().catch(() => '');
      name = t.split(/\s[|–-]\s/)[0].replace(/\s+izle$/i, '').trim() || name;
    }

    // per-season pages (some sites list only one season on the series page)
    const seasons = [...new Set([...first, ...homeLinks].map((l) => l.href))].filter((h) => {
      try { return new URL(h).host === host && seasonPage(new URL(h).pathname, me.core); } catch { return false; }
    });
    for (const s of seasons) await scan(s);
  } finally {
    await ctx.close().catch(() => {});
  }

  const bySeason = new Map<number, Episode[]>();
  for (const e of eps.values()) bySeason.set(e.season, [...(bySeason.get(e.season) ?? []), { episode: e.episode, url: e.url }]);
  const seasons = [...bySeason].sort(([a], [b]) => a - b).map(([season, list]) => ({ season, episodes: list.sort((a, b) => a.episode - b.episode) }));
  console.log(`[episodes] ${name}: ${seasons.map((s) => `S${s.season}:${s.episodes.length}`).join(' ')} (${visited.size} pages)`);
  return { key: me.key, name, seasons };
}

/** Same URL with the season/episode numbers swapped: manual fallback when the episode list can't be found. */
export function episodeUrl(href: string, season: number, episode: number) {
  const u = new URL(href);
  for (const re of EP) {
    const m = re.exec(u.pathname);
    if (!m) continue;
    let i = 0;
    const part = m[0].replace(/\d+/g, (n) => String([season, episode][i++] ?? n));
    u.pathname = u.pathname.slice(0, m.index) + part + u.pathname.slice(m.index + m[0].length);
    return u.href;
  }
}
