import test from 'node:test';
import assert from 'node:assert/strict';
import {getAddress, isAddress} from 'viem';
import {catalogProblems, isSupported, listSymbols, resolveToken} from '../src/catalog.mjs';
import {evaluateSnapshot} from '../src/policy.mjs';

const config = {
  assetScope: {allowedAssetClasses: ['tokenized-stock'], blockedAssetClasses: ['memecoin']},
  catalog: {requireVerified: true, maxAgeDays: 7},
  policy: {maxSnapshotAgeSeconds: 30, maxPriceMovePercent: 3, maxOpenOrders: 1, maxTotalExposureUsd: 250},
};
const now = new Date('2026-09-07T00:00:00.000Z');
const fresh = (symbols, overrides = {}) => ({verified: true, fetchedAt: '2026-09-06T00:00:00.000Z', symbols, ...overrides});
const snapshot = (symbol) => ({
  source: 'https://example.invalid/test',
  observedAt: now.toISOString(),
  asset: {symbol, assetClass: 'tokenized-stock'},
  market: {priceUsd: 100, pricePreviewUsd: 100, priceMove5mPercent: 0.1, volume24hUsd: 1e6, volatilityScore: 20},
  account: {buyingPowerUsd: 500, currentExposureUsd: 0, openOrders: 0},
});

test('a missing catalog fails closed', () => {
  assert.deepEqual(catalogProblems(null, config, now), ['catalog-unavailable']);
});

test('an unverified or empty catalog cannot clear the gate', () => {
  assert.ok(catalogProblems({verified: false, fetchedAt: now.toISOString(), symbols: [{symbol: 'AAPL', address: '0x1'}]}, config, now).includes('catalog-unverified'));
  assert.ok(catalogProblems({verified: true, fetchedAt: now.toISOString(), symbols: []}, config, now).includes('catalog-empty'));
});

test('the shipped catalog is real: verified, populated, every address EIP-55 canonical and unique', async () => {
  const {default: shipped} = await import('../data/stock-token-catalog.json', {with: {type: 'json'}});
  assert.equal(shipped.verified, true);
  assert.equal(shipped.source, 'https://api.robinhood.com/rhj/assets');
  assert.equal(shipped.chainId, 4663);
  assert.ok(shipped.symbols.length > 100, `expected a substantial catalog, got ${shipped.symbols.length}`);
  // symbol + address are what the lookup needs; name is optional context
  // that catalog:refresh fills in. Nothing else belongs in an entry.
  for (const e of shipped.symbols) {
    assert.ok(e.symbol && e.address, 'every entry needs a symbol and an address');
    for (const k of Object.keys(e)) assert.ok(['symbol', 'name', 'address'].includes(k), `unexpected field ${k} on ${e.symbol}`);
  }
  const seen = new Set();
  for (const e of shipped.symbols) {
    assert.ok(isAddress(e.address), `${e.symbol}: not an address`);
    assert.equal(getAddress(e.address), e.address, `${e.symbol}: address is not EIP-55 canonical -- likely a transcription error`);
    assert.ok(!seen.has(e.address.toLowerCase()), `${e.symbol}: duplicate address`);
    seen.add(e.address.toLowerCase());
  }
});

test('resolveToken returns the canonical contract address for a known ticker', async () => {
  const {default: shipped} = await import('../data/stock-token-catalog.json', {with: {type: 'json'}});
  assert.equal(resolveToken(shipped, 'NVDA').address, '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC');
  assert.equal(resolveToken(shipped, 'AAPL').address, '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9');
});

test('resolveToken throws for an unknown ticker rather than returning null', () => {
  // The critical case: a ticker with no catalog entry must never fall through
  // into a swap against whatever token happens to share that ticker.
  assert.throws(() => resolveToken(fresh([{symbol: 'AAPL', address: '0x1'}]), 'NVDA'), /not in the local catalog/);
  assert.throws(() => resolveToken(null, 'AAPL'), /no catalog loaded/);
  assert.throws(() => resolveToken(fresh(['AAPL']), 'AAPL'), /no contract address/);
});

test('a catalog older than maxAgeDays is rejected as stale', () => {
  const stale = fresh(['AAPL'], {fetchedAt: '2026-08-01T00:00:00.000Z'});
  assert.ok(catalogProblems(stale, config, now).includes('catalog-stale'));
});

test('a fresh verified catalog is usable', () => {
  assert.deepEqual(catalogProblems(fresh(['AAPL']), config, now), []);
});

test('a symbol outside the catalog is rejected by the policy gate', () => {
  const result = evaluateSnapshot(snapshot('NOT_LISTED'), config, now, fresh(['AAPL']));
  assert.equal(result.accepted, false);
  assert.ok(result.failures.includes('symbol-not-in-catalog'));
});

test('a symbol inside a fresh verified catalog passes the gate', () => {
  const result = evaluateSnapshot(snapshot('AAPL'), config, now, fresh(['AAPL']));
  assert.equal(result.accepted, true);
});

test('an unverified catalog blocks even a symbol that is listed in it', () => {
  const unverified = fresh(['AAPL'], {verified: false});
  const result = evaluateSnapshot(snapshot('AAPL'), config, now, unverified);
  assert.equal(result.accepted, false);
  assert.ok(result.failures.includes('catalog-unverified'));
});

test('catalog helpers accept both string and object symbol entries', () => {
  const objects = fresh([{symbol: 'AAPL', name: 'Apple'}, {symbol: 'SPY'}]);
  assert.deepEqual(listSymbols(objects), ['AAPL', 'SPY']);
  assert.equal(isSupported(objects, 'SPY'), true);
  assert.equal(isSupported(objects, 'TSLA'), false);
});
