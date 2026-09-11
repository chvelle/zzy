import {writeJsonAtomic} from './storage.mjs';
import {readFile} from 'node:fs/promises';

// Price tracking.
//
// The agent had no memory of price. Each tick it read one quote and threw it
// away, which left two of the policy gates inert: priceMove5mPercent was
// hardcoded to 0 (so the "reject anything that just jumped" rule could never
// fire) and volatilityScore was hardcoded to 50. This module gives the agent
// an actual series so those checks mean something.
//
// Market capitalisation is deliberately absent and should stay absent. For a
// tokenised equity it is supply multiplied by price, and supply moves with
// issuance and redemption rather than with anything about the instrument. It
// carries no information the price does not already carry.

const MAX_SAMPLES = 720;   // per symbol

export function emptyStore() { return {schemaVersion: 1, symbols: {}}; }

export function recordPrice(store, symbol, priceUsd, at = new Date(), {maxAgeHours = 26} = {}) {
  if (!(priceUsd > 0)) throw new Error(`refusing to record a non-positive price for ${symbol}`);
  const t = at instanceof Date ? at.getTime() : new Date(at).getTime();
  const list = store.symbols[symbol] ?? (store.symbols[symbol] = []);
  list.push([t, priceUsd]);
  list.sort((a, b) => a[0] - b[0]);
  const cutoff = t - maxAgeHours * 3600_000;
  let i = 0; while (i < list.length && list[i][0] < cutoff) i++;
  if (i) list.splice(0, i);
  if (list.length > MAX_SAMPLES) list.splice(0, list.length - MAX_SAMPLES);
  return store;
}

export function latestPrice(store, symbol) {
  const l = store.symbols[symbol];
  return l && l.length ? l.at(-1)[1] : null;
}

// Percentage move over the last `seconds`.
//
// If there is no sample that old yet, the oldest one available is used
// instead and the window actually measured is reported. That is deliberate
// and it is the conservative direction: a 9% move over 60 seconds is at
// least as alarming as 9% over 300, so judging it against the same limit
// rejects more, never less. Returning null here instead would mean the agent
// stays blind for the first five minutes of every run, which is worse.
//
// Null still means what it always meant: fewer than two samples, so there is
// genuinely nothing to compare.
export function moveDetail(store, symbol, seconds, now = new Date()) {
  const list = store.symbols[symbol];
  if (!list || list.length < 2) return null;
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const target = nowMs - seconds * 1000;
  let ref = null;
  for (const s of list) { if (s[0] <= target) ref = s; else break; }
  if (!ref) ref = list[0];                    // fall back to the oldest we have
  if (!(ref[1] > 0)) return null;
  const [refAt, refPrice] = ref;
  const last = list.at(-1);
  return {
    percent: ((last[1] - refPrice) / refPrice) * 100,
    windowSeconds: Math.max(0, Math.round((last[0] - refAt) / 1000)),
    full: refAt <= target,                    // did we have the window we asked for
    samples: list.length,
  };
}

export function moveOverPercent(store, symbol, seconds, now = new Date()) {
  const d = moveDetail(store, symbol, seconds, now);
  return d ? d.percent : null;
}

// Realised volatility of the sampled returns, mapped onto the 0-100 score the
// policy engine expects. Null when there is not enough history to say.
export function volatilityScore(store, symbol, {minSamples = 12} = {}) {
  const list = store.symbols[symbol];
  if (!list || list.length < minSamples) return null;
  const rets = [];
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1][1], b = list[i][1];
    if (a > 0) rets.push((b - a) / a);
  }
  if (rets.length < 2) return null;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  const sd = Math.sqrt(variance);
  // 1% per-sample standard deviation maps to roughly 50.
  return Math.max(0, Math.min(100, Math.round(sd * 100 * 50)));
}

// Recent samples for the research layer, oldest first.
export function series(store, symbol, limit = 60) {
  const list = store.symbols[symbol] ?? [];
  return list.slice(-limit).map(([t, close]) => ({at: new Date(t).toISOString(), close}));
}

// How far the on-chain pool price sits from Robinhood's reference quote.
// These are two different prices: the reference is what the instrument is
// meant to be worth, the pool price is what the agent actually pays. They are
// held together by arbitrage, not by a peg, so the gap can be wide when
// liquidity is thin, and buying into a large positive premium means
// overpaying for the same exposure.
export function poolPremiumPercent(poolPriceUsd, referencePriceUsd) {
  if (!(poolPriceUsd > 0) || !(referencePriceUsd > 0)) return null;
  return ((poolPriceUsd - referencePriceUsd) / referencePriceUsd) * 100;
}

export async function loadPrices(config) {
  const file = config.prices?.path ?? 'data/prices.json';
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return emptyStore(); }
}

export async function savePrices(store, config) {
  const file = config.prices?.path ?? 'data/prices.json';
  // Price history is re-derivable, so a corrupt file may start over (loadPrices
  // above), but the write is still atomic so a kill mid-tick cannot corrupt it.
  return writeJsonAtomic(file, store, {pretty: false});
}
