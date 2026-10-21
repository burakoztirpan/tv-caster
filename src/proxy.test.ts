import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trim } from './proxy.ts';

test('trim drops segments that end before the seek point, keeps header, key and endlist', () => {
  const pl = [
    '#EXTM3U', '#EXT-X-TARGETDURATION:10',
    '#EXT-X-KEY:METHOD=AES-128,URI="k1"', '#EXTINF:10,', 'a.ts',
    '#EXTINF:10,', 'b.ts',
    '#EXT-X-KEY:METHOD=AES-128,URI="k2"', '#EXTINF:10,', 'c.ts',
    '#EXTINF:10,', 'd.ts',
    '#EXT-X-ENDLIST',
  ];
  const out = trim(pl, 25);
  assert.deepEqual(out, ['#EXTM3U', '#EXT-X-TARGETDURATION:10', '#EXT-X-KEY:METHOD=AES-128,URI="k2"', '#EXTINF:10,', 'c.ts', '#EXTINF:10,', 'd.ts', '#EXT-X-ENDLIST']);
  assert.deepEqual(trim(pl, 0).filter((l) => l.endsWith('.ts')), ['a.ts', 'b.ts', 'c.ts', 'd.ts']);
  // nearest (audio): segment b starts 6s before 16 and c starts 4s after → c; at 11, b (1s lead) wins
  assert.deepEqual(trim(pl, 16, true).filter((l) => l.endsWith('.ts')), ['c.ts', 'd.ts']);
  assert.deepEqual(trim(pl, 11, true).filter((l) => l.endsWith('.ts')), ['b.ts', 'c.ts', 'd.ts']);
  assert.deepEqual(trim(pl, 16).filter((l) => l.endsWith('.ts')), ['b.ts', 'c.ts', 'd.ts']);
});

test('proxy refuses hosts the video did not point at (no open proxy)', async () => {
  const { createSession, handle } = await import('./proxy.ts');
  const http = await import('node:http');
  const id = createSession({ url: 'http://127.0.0.1:1/video.mp4', headers: { cookie: 'secret' }, kind: 'mp4' });
  const srv = http.createServer((req, res) => handle(req, res, 'http://127.0.0.1')).listen(0);
  const port = (srv.address() as { port: number }).port;
  const enc = (u: string) => Buffer.from(u).toString('base64url');
  const foreign = await fetch(`http://127.0.0.1:${port}/s/${id}/${enc('http://192.0.2.1/admin')}.mp4`);
  const own = await fetch(`http://127.0.0.1:${port}/s/${id}/${enc('http://127.0.0.1:1/video.mp4')}.mp4`);
  srv.close();
  assert.equal(foreign.status, 403);
  assert.notEqual(own.status, 403); // allowed through (upstream itself is unreachable here → 502)
});
