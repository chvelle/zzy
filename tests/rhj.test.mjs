import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchCatalog, fetchQuote} from '../src/adapters/robinhood-rhj.mjs';

// Sample bodies copied verbatim from docs.robinhood.com/chain/stock-token-apis
const ASSETS = {assets: [
  {id: '0x00', tokenSymbol: 'P', tokenName: 'Everpure • Robinhood Token', deployments: [{contractAddress: '0x1Cdad396DB64BDa184d5182A97Dd9B3C62100b7D', chainId: 4663}], currentMultiplier: '1.000000000000000000', status: 'ASSET_STATUS_ACTIVE', tradingCapabilities: {fractionalTradability: 'tradable'}},
  // nested shape, as the LIVE payload returns it
  {id: '0x01', tokenSymbol: 'APLD', tokenName: 'Applied Digital • Robinhood Token', deployments: [{contractAddress: '0xb8DBf92F9741c9ac1c32115E78581f23509916FD', chainId: 4663}], currentMultiplier: '1.000000000000000000', status: 'ASSET_STATUS_ACTIVE', tradingCapabilities: {market: {whole: 'TRADING_STATUS_TRADABLE', fractional: 'TRADING_STATUS_TRADABLE'}}},
  // whole-share only -- must be excluded
  {id: '0x04', tokenSymbol: 'WHOLE', tokenName: 'Whole Only', deployments: [{contractAddress: '0x0000000000000000000000000000000000000003', chainId: 4663}], currentMultiplier: '1.000000000000000000', status: 'ASSET_STATUS_ACTIVE', tradingCapabilities: {market: {whole: 'TRADING_STATUS_TRADABLE', fractional: 'TRADING_STATUS_UNTRADABLE'}}},
  // no tradability info at all -- must be excluded (fail closed)
  {id: '0x05', tokenSymbol: 'UNKNOWN', tokenName: 'No Caps', deployments: [{contractAddress: '0x0000000000000000000000000000000000000004', chainId: 4663}], currentMultiplier: '1.000000000000000000', status: 'ASSET_STATUS_ACTIVE'},
  {id: '0x02', tokenSymbol: 'GONE', tokenName: 'Delisted', deployments: [{contractAddress: '0x0000000000000000000000000000000000000001', chainId: 4663}], status: 'ASSET_STATUS_INACTIVE'},
  {id: '0x03', tokenSymbol: 'OTHER', tokenName: 'Other chain', deployments: [{contractAddress: '0x0000000000000000000000000000000000000002', chainId: 42161}], status: 'ASSET_STATUS_ACTIVE'},
]};
const PRICES = {quotes: [{tokenSymbol: 'AAPL', deployments: [{contractAddress: '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01', chainId: 4663}], bid: '213.45', ask: '213.47', currency: 'USD', dailyTradingVolume: '48293710', isTradingHalt: false, generatedAt: '2026-06-23T15:53:30Z'}]};
const fake = (body) => async () => ({ok: true, json: async () => body});

test('catalog keeps only ACTIVE, chain-4663, fractionally-tradable assets', async () => {
  const c = await fetchCatalog({fetchImpl: fake(ASSETS), now: new Date('2026-09-07T00:00:00Z')});
  assert.equal(c.verified, true);
  assert.equal(c.source, 'https://api.robinhood.com/rhj/assets');
  // P (flat docs shape) and APLD (nested live shape) are tradable and kept.
  // GONE (inactive), OTHER (wrong chain), WHOLE (fractional untradable) and
  // UNKNOWN (no tradability info) are all excluded.
  assert.deepEqual(c.symbols.map(s => s.symbol), ['P', 'APLD']);
  assert.equal(c.symbols[0].address, '0x1Cdad396DB64BDa184d5182A97Dd9B3C62100b7D');
  assert.equal(c.chainId, 4663);
});

test('quote maps bid/ask/volume/halt/generatedAt into the snapshot vocabulary', async () => {
  const q = await fetchQuote('AAPL', {fetchImpl: fake(PRICES)});
  assert.equal(q.mid, 213.46);
  assert.equal(q.dailyTradingVolume, 48293710);
  assert.equal(q.isTradingHalt, false);
  assert.equal(q.generatedAt, '2026-06-23T15:53:30Z');
  assert.ok(q.spreadPercent > 0 && q.spreadPercent < 0.01);
});

test('a non-2xx from the API throws instead of returning an empty catalog', async () => {
  await assert.rejects(() => fetchCatalog({fetchImpl: async () => ({ok: false, status: 503})}), /RHJ 503/);
});

test('isFractionallyTradable reads both the documented and live schema shapes, and fails closed', async () => {
  const {isFractionallyTradable} = await import('../src/adapters/robinhood-rhj.mjs');
  // documented flat shape
  assert.equal(isFractionallyTradable({tradingCapabilities: {fractionalTradability: 'tradable'}}), true);
  assert.equal(isFractionallyTradable({tradingCapabilities: {fractionalTradability: 'untradable'}}), false);
  assert.equal(isFractionallyTradable({tradingCapabilities: {fractionalTradability: 'position_closing_only'}}), false);
  // live nested shape
  assert.equal(isFractionallyTradable({tradingCapabilities: {market: {fractional: 'TRADING_STATUS_TRADABLE'}}}), true);
  assert.equal(isFractionallyTradable({tradingCapabilities: {market: {fractional: 'TRADING_STATUS_UNTRADABLE'}}}), false);
  // anything unreadable is treated as not tradable, so an upstream schema
  // change drops assets instead of silently admitting them
  for (const bad of [{}, {tradingCapabilities: null}, {tradingCapabilities: {}}, {tradingCapabilities: {market: {}}}]) {
    assert.equal(isFractionallyTradable(bad), false);
  }
});

test('the shipped catalog contains no whole-share-only assets', async () => {
  const {default: cat} = await import('../data/stock-token-catalog.json', {with: {type: 'json'}});
  for (const sym of ['WYFI', 'SLS', 'XNDU']) {
    assert.ok(!cat.symbols.some(s => s.symbol === sym), `${sym} is fractional-untradable and should not be in the catalog`);
  }
  assert.equal(cat.symbols.length, 191);
});

test('a 429 is retried with backoff and then succeeds', async () => {
  const {fetchQuote} = await import('../src/adapters/robinhood-rhj.mjs');
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls < 3) return {ok: false, status: 429, headers: {get: () => '0.01'}};   // Retry-After: 10ms
    return {ok: true, json: async () => PRICES};
  };
  const q = await fetchQuote('AAPL', {fetchImpl});
  assert.equal(q.mid, 213.46);
  assert.equal(calls, 3, 'two 429s, then the real answer');
});

test('a 429 that never clears gives up with a clear error rather than hanging', async () => {
  const {fetchQuote} = await import('../src/adapters/robinhood-rhj.mjs');
  const fetchImpl = async () => ({ok: false, status: 429, headers: {get: () => '0.001'}});
  await assert.rejects(() => fetchQuote('AAPL', {fetchImpl}), /RHJ 429.*retries/);
});

test('requests identify themselves instead of going out as "node"', async () => {
  const {fetchQuote} = await import('../src/adapters/robinhood-rhj.mjs');
  let ua = null;
  await fetchQuote('AAPL', {fetchImpl: async (u, o) => { ua = o.headers['user-agent']; return {ok: true, json: async () => PRICES}; }});
  assert.match(ua, /zzy-agent/);
});
