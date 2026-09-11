import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readdir, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {recordReview} from '../src/decisions.mjs';
import {buildSiteData} from '../src/site-data.mjs';

test('a review is written as one file per name, and the public exporter reads it back', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zzy-dec-'));
  try {
    const now = new Date('2026-09-09T12:00:00Z');
    await recordReview({
      holdings: [{symbol: 'NVDA', action: 'CLOSE', replacedBy: 'TSLA', reason: 'Done what it was bought for.', source: 'allocator'}],
      candidates: [{symbol: 'TSLA', verdict: 'PREPARE', confidence: 85, targetWeightPercent: 55, rationale: 'Better use of the capital.', downsideCase: 'x', falsifier: 'y', sources: ['https://a']},
                   {symbol: 'AMD', verdict: 'WATCH', reason: 'thin'}],
      summary: 'Rotated NVDA into TSLA.',
    }, {now, dir: path.join(dir, 'decisions')});
    const files = (await readdir(path.join(dir, 'decisions'))).sort();
    assert.equal(files.length, 4, 'one per holding, one per candidate, one summary');
    const nvda = JSON.parse(await readFile(path.join(dir, 'decisions', files.find(f => f.includes('NVDA'))), 'utf8'));
    assert.equal(nvda.decision, 'CLOSE');
    assert.match(nvda.rationale, /Capital to TSLA/);

    // and it lands on the site
    const cwd = process.cwd(); process.chdir(dir);
    try {
      const d = await buildSiteData({catalog: {path: 'nope.json', requireVerified: false}, treasury: {ledgerPath: 'l.json'}, positions: {path: 'p.json'}, policy: {}, pons: {}}, {quote: async () => null});
      const syms = d.activity.recent.map(e => e.symbol);
      assert.ok(syms.includes('NVDA') && syms.includes('TSLA') && syms.includes('AMD'));
      assert.equal(d.activity.decisionsLogged, 4);
      assert.equal(d.activity.ordersExecuted, 1, 'one PREPARE');
    } finally { process.chdir(cwd); }
  } finally { await rm(dir, {recursive: true}); }
});

test('paper and fork reviews are flagged and the site drops them', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zzy-dec-'));
  try {
    await recordReview({holdings: [], candidates: [{symbol: 'TSLA', verdict: 'PREPARE', confidence: 90, rationale: 'x'}]}, {dir: path.join(dir, 'decisions'), sample: true});
    const cwd = process.cwd(); process.chdir(dir);
    try {
      const d = await buildSiteData({catalog: {path: 'nope.json', requireVerified: false}, treasury: {ledgerPath: 'l.json'}, positions: {path: 'p.json'}, policy: {}, pons: {}}, {quote: async () => null});
      assert.equal(d.activity.recent.length, 0);
    } finally { process.chdir(cwd); }
  } finally { await rm(dir, {recursive: true}); }
});
