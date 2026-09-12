import {readJsonOrDefault, writeJsonAtomic} from './storage.mjs';

// Open positions. The agent did not have this before, which meant it could
// buy but never knew what it held, never re-examined a position, and never
// sold. For an agent meant to run unattended that is not a gap, it is the
// whole job left undone.
//
// A position is recorded only from a settled transaction, the same rule the
// treasury ledger follows. Quantity comes from the token balance before and
// after the swap, not from what the router promised, so a partial fill is
// recorded as what actually arrived.

const EMPTY = {schemaVersion: 1, positions: {}};

export async function loadPositions(config) {
  const file = config.positions?.path ?? 'data/positions.json';
  return readJsonOrDefault(file, EMPTY);
}

export async function savePositions(store, config) {
  const file = config.positions?.path ?? 'data/positions.json';
  return writeJsonAtomic(file, store, {backup: true});
}

export function listPositions(store) {
  return Object.values(store.positions ?? {});
}

export function getPosition(store, symbol) {
  return store.positions?.[symbol] ?? null;
}

// Opens or adds to a position. costBasisUsd accumulates, qty accumulates,
// the thesis is replaced by the newest one because that is the view the
// agent currently holds.
export function recordBuy(store, {symbol, address, qty, costUsd, priceUsd, txHash, thesis, falsifier, target, targetWeightPercent, at = new Date()}) {
  if (!(qty > 0) || !(costUsd > 0)) throw new Error(`recordBuy ${symbol}: qty and costUsd must be positive`);
  if (!txHash) throw new Error(`recordBuy ${symbol}: a settled txHash is required`);
  const prev = store.positions[symbol];
  store.positions[symbol] = {
    symbol, address,
    qty: (prev?.qty ?? 0) + qty,
    costBasisUsd: (prev?.costBasisUsd ?? 0) + costUsd,
    entryPriceUsd: priceUsd,
    openedAt: prev?.openedAt ?? at.toISOString(),
    lastBuyAt: at.toISOString(),
    lastExitAt: prev?.lastExitAt ?? null,
    lastReviewAt: prev?.lastReviewAt ?? null,
    thesis: thesis ?? prev?.thesis ?? null,
    falsifier: falsifier ?? prev?.falsifier ?? null,
    target: target ?? prev?.target ?? null,
    targetWeightPercent: targetWeightPercent ?? prev?.targetWeightPercent ?? null,
    fills: [...(prev?.fills ?? []), {side: 'buy', qty, usd: costUsd, priceUsd, txHash, at: at.toISOString()}],
  };
  return store.positions[symbol];
}

// Records a sale. Realised P&L is proportional cost basis against proceeds.
// Returns the realised amount so the caller can post it to the ledger.
export function recordSell(store, {symbol, qty, proceedsUsd, priceUsd, txHash, at = new Date()}) {
  const p = store.positions[symbol];
  if (!p) throw new Error(`recordSell ${symbol}: no open position`);
  if (!(qty > 0) || qty > p.qty + 1e-12) throw new Error(`recordSell ${symbol}: qty ${qty} exceeds held ${p.qty}`);
  if (!txHash) throw new Error(`recordSell ${symbol}: a settled txHash is required`);
  const fraction = Math.min(1, qty / p.qty);
  const basisSold = p.costBasisUsd * fraction;
  const realizedUsd = proceedsUsd - basisSold;
  const remainingQty = p.qty - qty;
  const fill = {side: 'sell', qty, usd: proceedsUsd, priceUsd, txHash, realizedUsd, at: at.toISOString()};
  if (remainingQty <= 1e-12) {
    // A closed position keeps its record: the fills are the trade history
    // and the count of real orders comes from them, not from verdicts.
    store.closed = [...(store.closed ?? []), {...p, qty: 0, closedAt: at.toISOString(), fills: [...p.fills, fill]}].slice(-500);
    delete store.positions[symbol];
  } else {
    store.positions[symbol] = {
      ...p, qty: remainingQty, costBasisUsd: p.costBasisUsd - basisSold,
      lastExitAt: at.toISOString(), fills: [...p.fills, fill],
    };
  }
  return {realizedUsd, remainingQty, basisSold};
}

export function markReviewed(store, symbol, at = new Date()) {
  if (store.positions[symbol]) store.positions[symbol].lastReviewAt = at.toISOString();
}

// Current exposure and per-position value at the latest prices.
export function valuePositions(store, priceBySymbol) {
  // pricedCostUsd is the cost basis of the positions that actually got a
  // price. Unrealised PnL must compare like with like: including the cost of
  // an unpriced position would report a loss equal to its full cost.
  let totalUsd = 0, totalCost = 0, pricedCost = 0, unpriced = 0;
  const rows = listPositions(store).map(p => {
    const price = priceBySymbol[p.symbol] ?? null;
    const valueUsd = price != null ? p.qty * price : null;
    if (valueUsd != null) { totalUsd += valueUsd; pricedCost += p.costBasisUsd; } else unpriced++;
    totalCost += p.costBasisUsd;
    return {
      symbol: p.symbol, qty: p.qty, costBasisUsd: p.costBasisUsd, priceUsd: price, valueUsd,
      unrealizedUsd: valueUsd != null ? valueUsd - p.costBasisUsd : null,
      unrealizedPercent: valueUsd != null && p.costBasisUsd > 0 ? ((valueUsd - p.costBasisUsd) / p.costBasisUsd) * 100 : null,
      openedAt: p.openedAt, thesis: p.thesis,
    };
  });
  return {rows, totalUsd, totalCostUsd: totalCost, pricedCostUsd: pricedCost, unpricedCount: unpriced, count: rows.length};
}

// Settled stock orders, lifetime: every buy and sell fill on open and closed
// positions. This is what "trades" means anywhere it is counted.
export function countFills(store) {
  const open = Object.values(store?.positions ?? {}).reduce((n, pos) => n + (pos.fills?.length ?? 0), 0);
  const closed = (store?.closed ?? []).reduce((n, pos) => n + (pos.fills?.length ?? 0), 0);
  return open + closed;
}
