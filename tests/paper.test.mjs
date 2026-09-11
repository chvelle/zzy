import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {seedPaperCapital, paperConfig, paperState} from '../src/paper.mjs';
import {buildSiteData} from '../src/site-data.mjs';
import {deployable} from '../src/profit.mjs';
import {readLedger} from '../src/treasury.mjs';

const base = (dir) => ({
  agentName:'ZZY', mode:'preview', chain:{id:4663},
  policy:{maxTotalExposureUsd:250, maxOrderUsd:50},
  catalog:{path:'data/stock-token-catalog.json', requireVerified:true, maxAgeDays:3650},
  treasury:{zzyTokenAddress:null, buybackShareBps:5000, tradingShareBps:5000, ledgerPath:path.join(dir,'real-ledger.json')},
  paper:{ledgerPath:path.join(dir,'paper-ledger.json')},
  pons:{claimThresholdEth:0.42},
});

test('paper capital gives the agent something to deploy without any fees claimed', async () => {
  const dir = await mkdtemp(path.join(tmpdir(),'zzy-paper-'));
  try {
    const {config: cfg} = await seedPaperCapital(base(dir), 500);
    const d = deployable(await readLedger(cfg), cfg);
    assert.equal(d.principalUsd, 500);
    assert.equal(d.deployableUsd, 250, 'still capped by the real exposure ceiling');
  } finally { await rm(dir,{recursive:true}); }
});

test('paper never writes to the real ledger', async () => {
  const dir = await mkdtemp(path.join(tmpdir(),'zzy-paper-'));
  try {
    const cfg = base(dir);
    await seedPaperCapital(cfg, 500);
    // the real ledger path must still be untouched
    await assert.rejects(() => readFile(cfg.treasury.ledgerPath,'utf8'), /ENOENT/);
    const real = await readLedger(cfg);
    assert.equal(real.entries.length, 0, 'the real book must stay empty');
  } finally { await rm(dir,{recursive:true}); }
});

test('SECURITY: simulated money never reaches the public site data', async () => {
  const dir = await mkdtemp(path.join(tmpdir(),'zzy-paper-'));
  try {
    const cfg = base(dir);
    const {config: paperCfg} = await seedPaperCapital(cfg, 5000);
    // point the exporter straight at the paper ledger, the worst case
    const d = await buildSiteData({...cfg, treasury:{...cfg.treasury, ledgerPath: paperCfg.treasury.ledgerPath}});
    assert.equal(d.treasury.feesClaimedUsd, 0, 'paper fees must not show as collected');
    assert.equal(d.treasury.zzyBoughtUsd, 0, 'paper buybacks must not show as bought');
    assert.equal(d.portfolio.principalUsd, 0);
    assert.equal(d.treasury.claimCount, 0);
    assert.ok(!JSON.stringify(d).includes('paper'), 'no paper marker should leak into the page data either');
  } finally { await rm(dir,{recursive:true}); }
});

test('paper mode forces preview, so it can never sign even if config says live', async () => {
  const dir = await mkdtemp(path.join(tmpdir(),'zzy-paper-'));
  try {
    const cfg = paperConfig({...base(dir), mode:'live'});
    assert.equal(cfg.mode, 'preview');
  } finally { await rm(dir,{recursive:true}); }
});

test('paper entries are labelled so they are identifiable anywhere they turn up', async () => {
  const dir = await mkdtemp(path.join(tmpdir(),'zzy-paper-'));
  try {
    const {config: cfg} = await seedPaperCapital(base(dir), 100);
    const led = await readLedger(cfg);
    assert.equal(led.paper, true);
    for (const e of led.entries) { assert.equal(e.paper, true); assert.equal(e.txHash, 'paper'); }
  } finally { await rm(dir,{recursive:true}); }
});

test('a non-positive paper capital is refused', async () => {
  const dir = await mkdtemp(path.join(tmpdir(),'zzy-paper-'));
  try {
    await assert.rejects(() => seedPaperCapital(base(dir), 0), /must be positive/);
    await assert.rejects(() => seedPaperCapital(base(dir), -100), /must be positive/);
  } finally { await rm(dir,{recursive:true}); }
});

test('paperState reports whether there is anything to practise with', async () => {
  const dir = await mkdtemp(path.join(tmpdir(),'zzy-paper-'));
  try {
    assert.equal((await paperState(base(dir))).entries, 0);
    await seedPaperCapital(base(dir), 500);
    const st = await paperState(base(dir));
    assert.equal(st.entries, 1); assert.equal(st.isPaper, true);
  } finally { await rm(dir,{recursive:true}); }
});
