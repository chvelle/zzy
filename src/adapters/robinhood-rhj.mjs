import {RHJ_API, ROBINHOOD_CHAIN} from '../chain.mjs';

// Read-only client for Robinhood's official Stock Token REST API
// (docs.robinhood.com/chain/stock-token-apis). 60 req/s, cached server-side.
// This is the authoritative catalog and the authoritative quote.

const UA = 'zzy-agent/0.3 (+https://github.com/zzy)';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// GET with a real User-Agent and polite retry on 429. Node's default UA is
// literally "node", which public APIs tend to throttle hard. Retry-After is
// honoured when present; otherwise backoff is 1s, 2s, 4s.
async function getJson(url, fetchImpl = fetch, {retries = 3} = {}) {
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    // A hung request used to stall the whole tick, and with it the dashboard.
    const res = await fetchImpl(url, {headers: {accept: 'application/json', 'user-agent': UA}, signal: AbortSignal.timeout(15000)});
    if (res.ok) return res.json();
    last = res.status;
    if (res.status === 429 && attempt < retries) {
      const ra = Number(res.headers?.get?.('retry-after'));
      await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * 2 ** attempt);
      continue;
    }
    throw new Error(res.status === 429 ? `RHJ 429 for ${url} after ${retries} retries, still rate limited` : `RHJ ${res.status} for ${url}`);
  }
  throw new Error(`RHJ ${last} for ${url} after ${retries} retries`);
}

// Is this asset fractionally tradable?
// The published docs show a flat `tradingCapabilities.fractionalTradability`
// string, but the live payload returns a nested shape
// (`tradingCapabilities.market.fractional`). Both are handled; anything we
// can't positively read as tradable is treated as NOT tradable, so a schema
// change upstream drops assets rather than silently admitting them.
export function isFractionallyTradable(asset) {
  const tc = asset?.tradingCapabilities;
  if (!tc) return false;
  if (typeof tc.fractionalTradability === 'string') return tc.fractionalTradability === 'tradable';
  const nested = tc.market?.fractional;
  if (typeof nested === 'string') return nested === 'TRADING_STATUS_TRADABLE';
  return false;
}

// Full catalog, shaped for data/stock-token-catalog.json.
//
// Filtered to assets that are ACTIVE, deployed on Robinhood Chain, AND
// fractionally tradable. The agent sizes positions in dollars, so a
// whole-share-only asset doesn't fit how it trades.
export async function fetchCatalog({fetchImpl = fetch, now = new Date()} = {}) {
  const {assets = []} = await getJson(`${RHJ_API}/assets`, fetchImpl);
  const symbols = assets
    .filter(a => a.status === 'ASSET_STATUS_ACTIVE')
    .filter(isFractionallyTradable)
    .map(a => {
      const dep = (a.deployments ?? []).find(d => d.chainId === ROBINHOOD_CHAIN.id);
      if (!dep) return null;
      return {
        symbol: a.tokenSymbol,
        name: a.tokenName,
        address: dep.contractAddress,
      };
    })
    .filter(Boolean);
  return {
    verified: true,
    source: `${RHJ_API}/assets`,
    fetchedAt: now.toISOString(),
    assetClass: 'tokenized-stock',
    chainId: ROBINHOOD_CHAIN.id,
    symbolCountClaimed: symbols.length,
    symbols,
  };
}

// Live quote -> the market/observedAt shape the policy engine expects.
export async function fetchQuote(symbol, {fetchImpl = fetch} = {}) {
  const {quotes = []} = await getJson(`${RHJ_API}/prices/${encodeURIComponent(symbol)}`, fetchImpl);
  const q = quotes.find(x => x.tokenSymbol === symbol) ?? quotes[0];
  if (!q) throw new Error(`no quote for ${symbol}`);
  const bid = Number(q.bid), ask = Number(q.ask);
  return {
    symbol: q.tokenSymbol,
    bid, ask,
    mid: Number(((bid + ask) / 2).toFixed(6)),
    spreadPercent: bid > 0 ? ((ask - bid) / bid) * 100 : null,
    dailyTradingVolume: Number(q.dailyTradingVolume ?? 0),
    isTradingHalt: Boolean(q.isTradingHalt),
    generatedAt: q.generatedAt,
    currency: q.currency,
  };
}
