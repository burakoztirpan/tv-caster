import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { parseEpisode, type Season } from './episodes.ts';

// "Recently watched", kept on the Mac so every phone/browser sees the same list.
export type Entry = {
  key: string; // series key (domain-agnostic) or the film page URL
  name: string;
  url: string; // last page played
  season?: number;
  episode?: number;
  seasons?: Season[]; // cached episode list
  pos?: number; // seconds watched into `url`
  dur?: number;
  updatedAt: number;
};

const FILE = new URL('../data/history.json', import.meta.url);
let entries: Entry[] = (() => {
  try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return []; }
})();

function save() {
  mkdirSync(new URL('.', FILE), { recursive: true });
  const tmp = new URL('history.json.tmp', FILE);
  writeFileSync(tmp, JSON.stringify(entries, null, 1)); // write + rename: a crash never leaves half a file
  renameSync(tmp, FILE);
}

export const list = () => [...entries].sort((a, b) => b.updatedAt - a.updatedAt);
export const get = (key: string) => entries.find((e) => e.key === key);

export function remove(key: string) {
  entries = entries.filter((e) => e.key !== key);
  save();
}

/** Record a cast. Series episodes collapse into one entry per series. */
export function record(url: string, title: string) {
  const ep = parseEpisode(url);
  const key = ep?.key ?? url;
  const prev = get(key);
  const name = ep ? prev?.name || title.replace(/\s*\d+\.\s*sezon.*$/i, '').trim() || title : title;
  const entry: Entry = { ...prev, key, name, url, season: ep?.season, episode: ep?.episode, updatedAt: Date.now() };
  if (prev?.url !== url) delete entry.pos; // another episode: old position doesn't apply
  entries = [entry, ...entries.filter((e) => e.key !== key)].slice(0, 30);
  save();
  return entry;
}

export function setSeasons(key: string, name: string, seasons: Season[]) {
  const e = get(key);
  if (!e) return;
  e.seasons = seasons;
  if (name) e.name = name;
  save();
}

// position updates arrive every few seconds; write to disk at most every 20s
let dirtyAt = 0;
export function setPos(key: string, url: string, pos: number, dur: number) {
  const e = get(key);
  if (!e || e.url !== url) return;
  e.pos = Math.round(pos);
  if (dur) e.dur = Math.round(dur);
  if (!pos) delete e.pos;
  if (!pos || Date.now() - dirtyAt > 20_000) { dirtyAt = Date.now(); save(); }
}
export const flush = () => save();
