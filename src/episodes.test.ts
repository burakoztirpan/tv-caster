import { test } from 'node:test';
import assert from 'node:assert/strict';
import { episodeUrl, parseEpisode } from './episodes.ts';

test('parseEpisode reads season/episode and a domain-hop-proof series key', () => {
  const a = parseEpisode('https://series-site2141.example/bolum/sample-show-2-sezon-3-bolum');
  const b = parseEpisode('https://series-site2142.example/bolum/sample-show-1-sezon-8-bolum');
  assert.deepEqual([a?.season, a?.episode, a?.core], [2, 3, 'sample-show']);
  assert.equal(a?.key, b?.key);
  const h = parseEpisode('https://www.movie-site.example/dizi/sample-show-izle-1/sezon-2/bolum-5-hd2/');
  assert.deepEqual([h?.season, h?.episode, h?.core], [2, 5, 'sample-show-izle-1']);
  const d = parseEpisode('https://www.other-site.example/other-show-1-sezon-10-bolum-sezon-finali-izle/');
  assert.deepEqual([d?.season, d?.episode, d?.core], [1, 10, 'other-show']);
  assert.equal(parseEpisode('https://series-site2142.example/film/sample-movie'), undefined);
});

test('episodeUrl swaps season/episode in place', () => {
  assert.equal(episodeUrl('https://series-site2142.example/bolum/sample-show-2-sezon-3-bolum', 1, 7), 'https://series-site2142.example/bolum/sample-show-1-sezon-7-bolum');
  assert.equal(episodeUrl('https://www.movie-site.example/dizi/x-izle-1/sezon-2/bolum-5-hd2/', 3, 1), 'https://www.movie-site.example/dizi/x-izle-1/sezon-3/bolum-1-hd2/');
});
