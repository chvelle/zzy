import {writeJsonAtomic} from './storage.mjs';
import {readJson} from './storage.mjs';
import {fetchCatalog} from './adapters/robinhood-rhj.mjs';

// The set of tradable Robinhood Stock Tokens is NOT hardcoded in this repo,
// on purpose. Robinhood adds symbols on its own schedule, and AGENT.md rule
// #2 forbids inventing supported assets. This module loads a catalog file
// that YOU refresh from an authoritative source, and it refuses to vouch for
// a catalog that is unverified, stale, or missing.
//
// The only authoritative source is Robinhood itself, via the MCP capability
// inventory for your own authenticated account (`npm run discover`). A
// catalog scraped from a news article or from an LLM's memory is by
// definition `verified: false` and will not clear the policy gate.

export function catalogAgeDays(catalog, now = new Date()) {
  const fetched = new Date(catalog.fetchedAt);
  if (Number.isNaN(fetched.getTime())) return Infinity;
  return Math.max(0, (now - fetched) / 86400000);
}

// Returns a list of reasons the catalog cannot be trusted for order
// preparation. An empty list means it is usable.
export function catalogProblems(catalog, config, now = new Date()) {
  const problems = [];
  if (!catalog) return ['catalog-unavailable'];
  if (!Array.isArray(catalog.symbols) || catalog.symbols.length === 0) problems.push('catalog-empty');
  if (catalog.verified !== true) problems.push('catalog-unverified');
  const maxAgeDays = config.catalog?.maxAgeDays ?? 7;
  if (catalogAgeDays(catalog, now) > maxAgeDays) problems.push('catalog-stale');
  return problems;
}

export function isSupported(catalog, symbol) {
  if (!catalog || !Array.isArray(catalog.symbols)) return false;
  return catalog.symbols.some(entry => (typeof entry === 'string' ? entry : entry?.symbol) === symbol);
}

// THE lookup the trading path uses. Given a ticker, return the canonical
// Robinhood Stock Token contract address from the local catalog file --
// no API call, no DEX search, no guessing. Throws rather than returning
// null, because a missing entry must never fall through into a swap
// against some other token that happens to share the ticker.
//
// Robinhood's own docs are explicit that ticker collisions are the risk
// here: "a token with a matching name/ticker but a different contract
// address is not a Robinhood Stock Token". This function is what makes
// the bot immune to that.
export function resolveToken(catalog, symbol) {
  if (!catalog) throw new Error(`cannot resolve ${symbol}: no catalog loaded`);
  const entry = (catalog.symbols ?? []).find(e => (typeof e === 'string' ? e : e?.symbol) === symbol);
  if (!entry) throw new Error(`${symbol} is not in the local catalog (${listSymbols(catalog).length} symbols) -- refusing to trade a ticker with no known contract address. Run: npm run catalog:refresh`);
  if (typeof entry === 'string' || !entry.address) throw new Error(`${symbol} is in the catalog but has no contract address -- refusing to trade it`);
  return {symbol: entry.symbol, address: entry.address, name: entry.name ?? null};
}

export function listSymbols(catalog) {
  if (!catalog || !Array.isArray(catalog.symbols)) return [];
  return catalog.symbols.map(entry => (typeof entry === 'string' ? entry : entry?.symbol)).filter(Boolean);
}

export async function loadCatalog(config) {
  const path = config.catalog?.path ?? 'data/stock-token-catalog.json';
  try {
    return await readJson(path);
  } catch {
    return null; // missing catalog is a fail-closed condition, not a crash
  }
}

// Refresh from Robinhood's official /rhj/assets and write verified:true.
export async function refreshCatalog(config, {fetchImpl = fetch, now = new Date()} = {}) {
  const catalog = await fetchCatalog({fetchImpl, now});
  const file = config.catalog?.path ?? 'data/stock-token-catalog.json';
  // A refresh that dies mid-write must not leave the bot with a truncated
  // catalog: that would be an empty allowlist and a stalled stock leg.
  await writeJsonAtomic(file, catalog, {backup: true});
  return {file, symbolCount: catalog.symbols.length};
}
