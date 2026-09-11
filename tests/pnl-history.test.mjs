import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {addPoint, DEFAULT_HISTORY} from '../src/pnl-history.mjs';
import {writeSiteData} from '../src/site-data.mjs';

test('the live series is capped and the archive keeps one point per minute', () => {
  let s = {live: [], archive: []};
  const t0 = Date.parse('2026-09-10T12:00:00Z');
  for (let i = 0; i < 1000; i++) s = addPoint(s, {t: t0 + i * 5000, book: 100 + i, pnl: i, open: 0}, {...DEFAULT_HISTORY, liveMax: 720});
  assert.equal(s.live.length, 720);
  assert.equal(s.live.at(-1)[2], 999);
  // 1000 points at 5s = 83.3 minutes -> 84 minute buckets, each holding the last value of its minute
  assert.equal(s.archive.length, 84);
  assert.equal(s.archive[0][2], 11, 'minute 0 ends with the 12th point');
});

test('the archive expires past archiveDays', () => {
  let s = {live: [], archive: [[0, 1, 1, 0]]};
  s = addPoint(s, {t: 40 * 86400_000, book: 2, pnl: 2, open: 0}, {...DEFAULT_HISTORY, archiveDays: 30});
  assert.equal(s.archive.length, 1);
});

test('every site export adds a point and the page payload carries the live series', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zzy-hist-'));
  try {
    const config = {catalog: {path: 'nope.json', requireVerified: false}, treasury: {ledgerPath: path.join(dir, 'l.json')}, positions: {path: path.join(dir, 'p.json')},
      policy: {}, pons: {}, history: {path: path.join(dir, 'h.json')}, decisions: {path: path.join(dir, 'd')}};
    const out = path.join(dir, 'data.json');
    const a = await writeSiteData(config, {outFile: out, now: new Date('2026-09-10T12:00:00Z')});
    const b = await writeSiteData(config, {outFile: out, now: new Date('2026-09-10T12:00:05Z')});
    assert.equal(a.data.history.live.length, 1);
    assert.equal(b.data.history.live.length, 2);
    assert.equal(b.data.history.archiveUrl, './history.json');
    const hist = JSON.parse(await readFile(path.join(dir, 'history.json'), 'utf8'));
    assert.ok(Array.isArray(hist.points));
  } finally { await rm(dir, {recursive: true}); }
});
