import test from 'node:test';
import assert from 'node:assert/strict';
import {_resetCashDecimals} from '../src/cash.mjs';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {interestScore, parseAtom, parseRss} from '../src/intel.mjs';

test('interest scoring rewards movement and fresh filings, discounts names already held', () => {
  const calm = {market: {priceMove5mPercent: 0.1, priceMove1hPercent: 0.2, priceMove24hPercent: 0.5, volume24hUsd: 1e6}};
  const mover = {market: {priceMove5mPercent: 2.4, priceMove1hPercent: 3, priceMove24hPercent: 6, volume24hUsd: 1e8}};
  assert.ok(interestScore(mover).score > interestScore(calm).score);
  const withFiling = interestScore(calm, {events: [{form: '8-K'}]});
  assert.ok(withFiling.score >= 40, 'a fresh 8-K alone should clear any sane threshold');
  assert.ok(withFiling.reasons.some(r => /8-K/.test(r)));
  const held = interestScore(mover, {held: true});
  assert.ok(held.score < interestScore(mover).score, 'held names are reviewed on their own schedule, not re-researched for buys');
});

test('the SEC Atom feed is parsed into form, company, CIK and link', () => {
  const xml = `<feed><entry><title>8-K - NVIDIA CORP (0001045810) (Filer)</title><link rel="alternate" href="https://www.sec.gov/x"/><updated>2026-09-09T00:00:00-04:00</updated><id>urn:1</id></entry></feed>`;
  const [e] = parseAtom(xml);
  assert.equal(e.form, '8-K'); assert.equal(e.cik, '0001045810'); assert.equal(e.company, 'NVIDIA CORP');
  assert.equal(e.link, 'https://www.sec.gov/x');
});

test('Google News RSS is parsed and CDATA is stripped', () => {
  const xml = `<rss><channel><item><title><![CDATA[Nvidia raises guidance]]></title><link>https://n/1</link><pubDate>Tue, 09 Sep 2026</pubDate><source url="x">Reuters</source></item></channel></rss>`;
  const [i] = parseRss(xml);
  assert.equal(i.title, 'Nvidia raises guidance'); assert.equal(i.source, 'Reuters'); assert.equal(i.url, 'https://n/1');
});

test('the engine actually consults Claude on policy-passing names, and buys on PREPARE', async () => {
  _resetCashDecimals();
  // This is the test the old design would have failed: nothing ever reached
  // the model. Here, with stubbed quotes, feed and model, one name passes
  // policy, gets shortlisted, gets a PREPARE, and a buy is recorded.
  const {tradingCycle} = await import('../src/engine.mjs');
  const {loadPositions} = await import('../src/positions.mjs');
  const dir = await mkdtemp(path.join(tmpdir(), 'zzy-engine-'));
  try {
    const config = {
      mode: 'live', chain: {id: 4663},
      assetScope: {allowedAssetClasses: ['tokenized-stock'], blockedAssetClasses: ['memecoin']},
      catalog: {requireVerified: false},
      policy: {maxSnapshotAgeSeconds: 3600, maxPriceMovePercent: 3, maxOpenOrders: 5, maxTotalExposureUsd: 250, maxOrderUsd: 50},
      research: {intervalSeconds: 0, maxCandidatesPerCycle: 3, minInterestScore: 0, maxSearchesPerCycle: 1},
      execution: {quoteConcurrency: 4, maxPoolPremiumPercent: 50, stockSlippageBps: 100},
      uniswap: {routerVariant: 'SwapRouter02'},
      treasury: {ledgerPath: path.join(dir, 'ledger.json')},
      prices: {path: path.join(dir, 'prices.json')},
      positions: {path: path.join(dir, 'positions.json')}, decisions: {path: path.join(dir, 'decisions')}, notebook: {path: path.join(dir, 'nb.json')}, earnings: {path: path.join(dir, 'earn.json')},
      profitPolicy: {mode: 'compound'}, news: {edgarUserAgent: 'test test@test'},
    };
    await writeFile(config.treasury.ledgerPath, JSON.stringify({schemaVersion: 1, entries: [{type: 'fee-claim', tradingUsd: 500, buybackUsd: 500}]}));
    // two ticks of price history so the move gate has something to judge
    const now = new Date('2026-09-09T12:00:00Z');
    await writeFile(config.prices.path, JSON.stringify({schemaVersion: 1, symbols: {NVDA: [[now.getTime() - 300000, 100]]}}));

    const catalog = {verified: true, fetchedAt: now.toISOString(), symbols: [{symbol: 'NVDA', name: 'NVIDIA • Robinhood Token', address: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC'}]};
    const sent = [];
    const signer = {live: true, address: '0x3333333333333333333333333333333333333333', async send(tx) { sent.push(tx); return '0xhash' + sent.length; }};
    let bal = 0n, usdg = 1000n * 10n ** 6n;
    const client = {
      async readContract({address, functionName}) {
        if (functionName === 'decimals') return address.toLowerCase() === '0x5fc5360d0400a0fd4f2af552add042d716f1d168' ? 6 : 18;
        return address.toLowerCase() === '0x5fc5360d0400a0fd4f2af552add042d716f1d168' ? usdg : bal;
      },
      async simulateContract() { return {result: [10n ** 18n, 0n, 0, 0n]}; },
      async waitForTransactionReceipt() { bal = 5n * 10n ** 17n; return {status: 'success'}; },
    };
    // stub the network: quote, SEC, news, model
    const {default: rhj} = await import('../src/adapters/robinhood-rhj.mjs').then(m => ({default: m}));
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('rhj/prices')) return {ok: true, json: async () => ({quotes: [{tokenSymbol: 'NVDA', bid: '100.9', ask: '101.1', dailyTradingVolume: '1000000', isTradingHalt: false, generatedAt: now.toISOString()}]})};
      if (u.includes('company_tickers')) return {ok: true, json: async () => ({0: {ticker: 'NVDA', cik_str: 1045810}})};
      if (u.includes('getcurrent')) return {ok: true, text: async () => `<feed><entry><title>8-K - NVIDIA CORP (0001045810) (Filer)</title><link href="https://sec/x"/><updated>${now.toISOString()}</updated></entry></feed>`};
      if (u.includes('news.google')) return {ok: true, text: async () => '<rss><channel><item><title>NVDA up</title><link>https://n</link></item></channel></rss>'};
      if (u.includes('api.anthropic.com')) return {ok: true, json: async () => ({content: [{type: 'text', text: JSON.stringify({candidates: [{symbol: 'NVDA', verdict: 'PREPARE', confidence: 80, rationale: 'Filing looks strong.', downsideCase: 'x', falsifier: 'y', sources: ['https://sec/x']}]})}]})};
      throw new Error('unexpected fetch ' + u);
    };
    process.env.ANTHROPIC_API_KEY = 'test';
    try {
      const r = await tradingCycle({client, signer, config, catalog, ethUsd: 3000, now, log: () => {}, state: {}});
      assert.deepEqual(r.researched, ['NVDA'], 'the name reached Claude');
      assert.equal(r.buys.length, 1);
      assert.equal(r.buys[0].symbol, 'NVDA');
      assert.equal(r.buys[0].usd, 50, 'conviction 80 with no target aims at 48% of a $250 book; the $50 hard cap binds this cycle');
      assert.equal(sent.length, 2, 'approve then swap');
      const pos = await loadPositions(config);
      assert.ok(pos.positions.NVDA, 'the position is recorded');
      assert.equal(pos.positions.NVDA.qty, 0.5, 'qty from the balance delta, not the router promise');
      assert.equal(pos.positions.NVDA.thesis, 'Filing looks strong.');
    } finally { globalThis.fetch = realFetch; delete process.env.ANTHROPIC_API_KEY; }
  } finally { await rm(dir, {recursive: true}); }
});

test('the engine holds a position the agent still believes in, and sells one it does not', async () => {
  _resetCashDecimals();
  const {tradingCycle} = await import('../src/engine.mjs');
  const {loadPositions} = await import('../src/positions.mjs');
  const {readLedger} = await import('../src/treasury.mjs');
  const dir = await mkdtemp(path.join(tmpdir(), 'zzy-engine-'));
  try {
    const now = new Date('2026-09-09T12:00:00Z');
    const config = {
      mode: 'live', chain: {id: 4663},
      assetScope: {allowedAssetClasses: ['tokenized-stock'], blockedAssetClasses: ['memecoin']}, catalog: {requireVerified: false},
      policy: {maxSnapshotAgeSeconds: 3600, maxPriceMovePercent: 3, maxOpenOrders: 5, maxTotalExposureUsd: 250, maxOrderUsd: 50},
      research: {intervalSeconds: 999999}, execution: {quoteConcurrency: 4}, uniswap: {routerVariant: 'SwapRouter02'},
      exitPolicy: {maxLossPercent: 25, minProceedsUsd: 1, estimatedExitCostUsd: 0.1, cooldownSeconds: 0},
      treasury: {ledgerPath: path.join(dir, 'ledger.json')}, prices: {path: path.join(dir, 'prices.json')}, positions: {path: path.join(dir, 'positions.json')}, decisions: {path: path.join(dir, 'decisions')}, notebook: {path: path.join(dir, 'nb.json')}, earnings: {path: path.join(dir, 'earn.json')},
      profitPolicy: {mode: 'compound'}, news: {edgarUserAgent: 't t@t'},
    };
    await writeFile(config.treasury.ledgerPath, JSON.stringify({schemaVersion: 1, entries: [{type: 'fee-claim', tradingUsd: 500, buybackUsd: 500}]}));
    await writeFile(config.prices.path, JSON.stringify({schemaVersion: 1, symbols: {NVDA: [[now.getTime() - 300000, 100]]}}));
    await writeFile(config.positions.path, JSON.stringify({schemaVersion: 1, positions: {NVDA: {symbol: 'NVDA', address: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC', qty: 1, costBasisUsd: 100, openedAt: now.toISOString(), fills: [], thesis: 'capex', falsifier: 'guidance cut'}}}));
    const catalog = {verified: true, fetchedAt: now.toISOString(), symbols: [{symbol: 'NVDA', name: 'NVIDIA', address: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC'}]};
    const sent = [];
    const signer = {live: true, address: '0x3333333333333333333333333333333333333333', async send(tx) { sent.push(tx); return '0xh' + sent.length; }};
    let usdg = 0n;
    const client = {async readContract({address, functionName}) { if (functionName === 'decimals') return address.toLowerCase() === '0x5fc5360d0400a0fd4f2af552add042d716f1d168' ? 6 : 18; return address.toLowerCase() === '0x5fc5360d0400a0fd4f2af552add042d716f1d168' ? usdg : 10n ** 18n; }, async simulateContract() { return {result: [10n ** 18n, 0n, 0, 0n]}; }, async waitForTransactionReceipt() { usdg = 120n * 10n ** 6n; return {status: 'success'}; }};
    const realFetch = globalThis.fetch;
    let verdict = 'HOLD';
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('rhj/prices')) return {ok: true, json: async () => ({quotes: [{tokenSymbol: 'NVDA', bid: '119', ask: '121', dailyTradingVolume: '1', isTradingHalt: false, generatedAt: now.toISOString()}]})};
      if (u.includes('api.anthropic.com')) return {ok: true, json: async () => ({content: [{type: 'text', text: JSON.stringify({
        holdings: [{symbol: 'NVDA', action: verdict, thesisIntact: verdict === 'HOLD', replacedBy: verdict === 'CLOSE' ? 'cash' : null,
          reason: verdict === 'HOLD' ? 'Still the best use of that capital.' : 'No longer earns its place; nothing on the table is better, so cash.'}],
        candidates: [], summary: 'reviewed'})}]})};
      throw new Error('unexpected fetch ' + u);
    };
    process.env.ANTHROPIC_API_KEY = 'test';
    try {
      let r = await tradingCycle({client, signer, config, catalog, ethUsd: 3000, now, log: () => {}, state: {}});
      assert.equal(r.exits[0].action, 'HOLD');
      assert.equal(sent.length, 0, 'a hold signs nothing');
      verdict = 'CLOSE';
      r = await tradingCycle({client, signer, config, catalog, ethUsd: 3000, now: new Date(now.getTime() + 1000), log: () => {}, state: {}});
      assert.equal(r.exits[0].action, 'CLOSE');
      assert.equal(sent.length, 2, 'approve the stock token, then swap it to WETH');
      assert.equal((await loadPositions(config)).positions.NVDA, undefined, 'position closed');
      const led = await readLedger(config);
      const pnl = led.entries.find(e => e.type === 'realized-pnl');
      assert.ok(pnl, 'realised P&L posted to the ledger');
      assert.equal(pnl.amountUsd, 0.04 * 3000 - 100, 'proceeds from the WETH delta minus basis');
    } finally { globalThis.fetch = realFetch; delete process.env.ANTHROPIC_API_KEY; }
  } finally { await rm(dir, {recursive: true}); }
});

test('research is budgeted: no Claude call until the interval has elapsed', async () => {
  _resetCashDecimals();
  const {tradingCycle} = await import('../src/engine.mjs');
  const dir = await mkdtemp(path.join(tmpdir(), 'zzy-engine-'));
  try {
    const now = new Date('2026-09-09T12:00:00Z');
    const config = {mode: 'preview', assetScope: {allowedAssetClasses: ['tokenized-stock'], blockedAssetClasses: []}, catalog: {requireVerified: false},
      policy: {maxSnapshotAgeSeconds: 3600, maxPriceMovePercent: 3, maxOpenOrders: 5, maxTotalExposureUsd: 250, maxOrderUsd: 50},
      research: {intervalSeconds: 300}, execution: {}, treasury: {ledgerPath: path.join(dir, 'l.json')}, prices: {path: path.join(dir, 'p.json')}, positions: {path: path.join(dir, 'pos.json')}, decisions: {path: path.join(dir, 'decisions')}, notebook: {path: path.join(dir, 'nb.json')}, earnings: {path: path.join(dir, 'earn.json')}, profitPolicy: {mode: 'compound'}};
    await writeFile(config.treasury.ledgerPath, JSON.stringify({schemaVersion: 1, entries: [{type: 'fee-claim', tradingUsd: 500}]}));
    const catalog = {verified: true, symbols: [{symbol: 'NVDA', name: 'N', address: '0x' + '1'.repeat(40)}]};
    let claudeCalls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('rhj/prices')) return {ok: true, json: async () => ({quotes: [{tokenSymbol: 'NVDA', bid: '100', ask: '100', dailyTradingVolume: '1', generatedAt: now.toISOString()}]})};
      if (u.includes('api.anthropic.com')) { claudeCalls++; return {ok: true, json: async () => ({content: []})}; }
      return {ok: true, json: async () => ({}), text: async () => ''};
    };
    try {
      const state = {lastCheckAt: new Date(now.getTime() - 60_000).toISOString()};   // checked a minute ago
      const r = await tradingCycle({client: {}, signer: {live: false}, config, catalog, ethUsd: 3000, now, log: () => {}, state});
      assert.match(r.reason, /review not due/);
      assert.equal(claudeCalls, 0);
    } finally { globalThis.fetch = realFetch; }
  } finally { await rm(dir, {recursive: true}); }
});

test('SECURITY: forced trades refuse to run anywhere but a verified fork', async () => {
  _resetCashDecimals();
  const {forceBuy, forceSell} = await import('../src/engine.mjs');
  const live = {mode: 'live', treasury: {}, positions: {path: '/tmp/never'}};   // no _fork
  await assert.rejects(() => forceBuy({client: {}, signer: {live: true}, config: live, catalog: {symbols: []}, symbol: 'NVDA', usd: 20, ethUsd: 3000}), /only runs on a local fork/);
  await assert.rejects(() => forceSell({client: {}, signer: {live: true}, config: live, catalog: {symbols: []}, symbol: 'NVDA', ethUsd: 3000}), /only runs on a local fork/);
});

test('a forced buy then a forced sell round-trips through the real path and posts P&L', async () => {
  _resetCashDecimals();
  const {forceBuy, forceSell} = await import('../src/engine.mjs');
  const {loadPositions} = await import('../src/positions.mjs');
  const {readLedger} = await import('../src/treasury.mjs');
  const dir = await mkdtemp(path.join(tmpdir(), 'zzy-force-'));
  try {
    const config = {_fork: true, uniswap: {routerVariant: 'SwapRouter02'}, execution: {}, treasury: {ledgerPath: path.join(dir, 'l.json')}, positions: {path: path.join(dir, 'p.json')}, decisions: {path: path.join(dir, 'decisions')}, notebook: {path: path.join(dir, 'nb.json')}, earnings: {path: path.join(dir, 'earn.json')}};
    const catalog = {symbols: [{symbol: 'NVDA', name: 'NVIDIA', address: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC'}]};
    const sent = [];
    const signer = {live: true, address: '0x3333333333333333333333333333333333333333', async send(tx) { sent.push(tx); return '0xh' + sent.length; }};
    let tok = 0n, usdg = 1000n * 10n ** 6n;
    const client = {
      async readContract({address, functionName}) { if (functionName === 'decimals') return address.toLowerCase() === '0x5fc5360d0400a0fd4f2af552add042d716f1d168' ? 6 : 18; return address.toLowerCase() === '0x5fc5360d0400a0fd4f2af552add042d716f1d168' ? usdg : tok; },
      async simulateContract() { return {result: [10n ** 17n, 0n, 0, 0n]}; },
      async waitForTransactionReceipt() { if (sent.length === 2) tok = 10n ** 17n; if (sent.length === 4) usdg += 24n * 10n ** 6n; return {status: 'success', blockNumber: 99n}; },
    };
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ok: true, json: async () => ({quotes: [{tokenSymbol: 'NVDA', bid: '100', ask: '100', dailyTradingVolume: '1', generatedAt: new Date().toISOString()}]})});
    try {
      const b = await forceBuy({client, signer, config, catalog, symbol: 'NVDA', usd: 20, ethUsd: 3000, log: () => {}});
      assert.equal(b.status, 'success'); assert.equal(b.qty, 0.1); assert.equal(sent.length, 2);
      assert.equal((await loadPositions(config)).positions.NVDA.qty, 0.1);
      const s = await forceSell({client, signer, config, catalog, symbol: 'NVDA', fraction: 1, ethUsd: 3000, log: () => {}});
      assert.equal(sent.length, 4, 'approve + swap for the sell');
      assert.equal(s.remainingQty, 0);
      assert.equal(s.proceedsUsd, 24, '24 USDG arrived');
      assert.equal(s.realizedUsd, 4);
      assert.equal((await loadPositions(config)).positions.NVDA, undefined);
      assert.ok((await readLedger(config)).entries.some(e => e.type === 'realized-pnl' && e.amountUsd === 4));
    } finally { globalThis.fetch = realFetch; }
  } finally { await rm(dir, {recursive: true}); }
});

test('a fork verdict override drives a real buy through the normal engine path, then an exit override sells it', async () => {
  _resetCashDecimals();
  // Proves the wiring from "Claude said PREPARE" to a swap, and from "the
  // review said CLOSE" to a sale, with only the model's answer substituted.
  const {tradingCycle} = await import('../src/engine.mjs');
  const {loadPositions} = await import('../src/positions.mjs');
  const dir = await mkdtemp(path.join(tmpdir(), 'zzy-ovr-'));
  try {
    const now = new Date('2026-09-09T12:00:00Z');
    const config = {
      _fork: true, mode: 'live', chain: {id: 4663},
      assetScope: {allowedAssetClasses: ['tokenized-stock'], blockedAssetClasses: []}, catalog: {requireVerified: false},
      policy: {maxSnapshotAgeSeconds: 3600, maxPriceMovePercent: 3, maxOpenOrders: 5, maxTotalExposureUsd: 250, maxOrderUsd: 50},
      research: {intervalSeconds: 300, maxCandidatesPerCycle: 1, minInterestScore: 9999},   // nothing would be shortlisted on its own
      execution: {quoteConcurrency: 4, maxPoolPremiumPercent: 50}, uniswap: {routerVariant: 'SwapRouter02'},
      exitPolicy: {minProceedsUsd: 1, estimatedExitCostUsd: 0.1, cooldownSeconds: 0},
      treasury: {ledgerPath: path.join(dir, 'l.json')}, prices: {path: path.join(dir, 'p.json')}, positions: {path: path.join(dir, 'pos.json')}, decisions: {path: path.join(dir, 'decisions')}, notebook: {path: path.join(dir, 'nb.json')}, earnings: {path: path.join(dir, 'earn.json')},
      profitPolicy: {mode: 'compound'}, news: {edgarUserAgent: 't t@t'},
    };
    await writeFile(config.treasury.ledgerPath, JSON.stringify({schemaVersion: 1, entries: [{type: 'fee-claim', tradingUsd: 500}]}));
    await writeFile(config.prices.path, JSON.stringify({schemaVersion: 1, symbols: {NVDA: [[now.getTime() - 300000, 100]]}}));
    const catalog = {verified: true, symbols: [{symbol: 'NVDA', name: 'NVIDIA', address: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC'}]};
    const sent = [];
    const signer = {live: true, address: '0x3333333333333333333333333333333333333333', async send(tx) { sent.push(tx); return '0xh' + sent.length; }};
    let tok = 0n, usdg = 1000n * 10n ** 6n;
    const client = {
      async readContract({address, functionName}) { if (functionName === 'decimals') return address.toLowerCase() === '0x5fc5360d0400a0fd4f2af552add042d716f1d168' ? 6 : 18; return address.toLowerCase() === '0x5fc5360d0400a0fd4f2af552add042d716f1d168' ? usdg : tok; },
      // $40 at $100/share is 0.4 tokens; quote at par so the premium guard passes
      async simulateContract() { return {result: [4n * 10n ** 17n, 0n, 0, 0n]}; },
      async waitForTransactionReceipt() { if (sent.length === 2) tok = 4n * 10n ** 17n; if (sent.length === 4) usdg += 42n * 10n ** 6n; return {status: 'success'}; },
    };
    let claudeCalls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('rhj/prices')) return {ok: true, json: async () => ({quotes: [{tokenSymbol: 'NVDA', bid: '100', ask: '100', dailyTradingVolume: '1', generatedAt: now.toISOString()}]})};
      if (u.includes('api.anthropic.com')) { claudeCalls++; return {ok: true, json: async () => ({content: [{type: 'text', text: JSON.stringify({candidates: [{symbol: 'NVDA', verdict: 'WATCH'}]})}]})}; }
      return {ok: true, json: async () => ({}), text: async () => ''};
    };
    process.env.ANTHROPIC_API_KEY = 'test';
    try {
      // 1. research is not due and the threshold is unreachable: nothing happens
      let state = {lastCheckAt: now.toISOString(), lastReviewAt: now.toISOString()};
      let r = await tradingCycle({client, signer, config, catalog, ethUsd: 3000, now, log: () => {}, state});
      assert.equal(r.buys?.length ?? 0, 0);
      // 2. queue PREPARE: research becomes due, NVDA is forced on, Claude is still called for real, the answer is replaced, a swap fires
      state = {lastCheckAt: now.toISOString(), lastReviewAt: now.toISOString(), verdictOverrides: {NVDA: {verdict: 'PREPARE', confidence: 80}}};
      r = await tradingCycle({client, signer, config, catalog, ethUsd: 3000, now, log: () => {}, state});
      assert.equal(claudeCalls, 1, 'the real model call still happens');
      assert.equal(r.buys.length, 1); assert.equal(r.buys[0].usd, 50);
      assert.equal(sent.length, 2, 'approve + swap');
      assert.equal((await loadPositions(config)).positions.NVDA.qty, 0.4);
      assert.deepEqual(state.verdictOverrides, {}, 'consumed once');
      // 3. queue CLOSE on the position: the review runs now and the sale goes through
      state.exitOverrides = {NVDA: {action: 'CLOSE'}};
      r = await tradingCycle({client, signer, config, catalog, ethUsd: 3000, now: new Date(now.getTime() + 1000), log: () => {}, state});
      assert.equal(r.exits[0].action, 'CLOSE');
      assert.equal(sent.length, 4);
      assert.equal((await loadPositions(config)).positions.NVDA, undefined);
    } finally { globalThis.fetch = realFetch; delete process.env.ANTHROPIC_API_KEY; }
  } finally { await rm(dir, {recursive: true}); }
});

test('SECURITY: verdict overrides are ignored outside a fork', async () => {
  _resetCashDecimals();
  const {Runner} = await import('../src/runner.mjs');
  const r = new Runner({fork: false});
  assert.throws(() => r.setForkVerdict('NVDA', 'PREPARE'), /only exist on a local fork/);
  assert.throws(() => r.setForkExit('NVDA', 'CLOSE'), /only exist on a local fork/);
});
