// Position sizing as portfolio allocation.
//
// The engine used to size a buy as min(maxOrderUsd, maxOrderUsd * conviction),
// a fixed dollar number. That has two failures. It cannot express conviction:
// at $50 of a $250 book the most bullish possible call is 20% of the
// portfolio. And it does not scale: when the book has compounded to $10,000,
// each buy is still $50.
//
// Here the unit is the portfolio. The model states a target weight for a
// name, as a percent of the whole book. The engine works out what that is in
// dollars given what is already held, then adds toward it in bounded steps.
// A name the agent wants to be most of the book can become most of the book,
// over several cycles, inside a ceiling the operator sets.
//
// Everything is a pure function of numbers so it can be tested without a
// chain, and so the caps are visible in one place.

export const DEFAULT_SIZING = {
  maxPositionPercent: 60,   // ceiling on any single name as a share of the book
  maxOrderPercent: 25,      // most it will add to one name in one cycle (scale in, not lump in)
  minOrderUsd: 5,           // below this a swap is not worth its gas
};

export function sizingConfig(config) {
  return {...DEFAULT_SIZING, ...(config.policy?.sizing ?? {})};
}

// How much to buy of `symbol` this cycle.
//
//   portfolioUsd   free cash inside the exposure cap + open positions at market
//   currentUsd     what is already held in this symbol, at market
//   remainingUsd   free cash still unallocated this cycle
//   targetWeight   the model's target for this name, percent of the book
//   conviction     0-100, used only when the model gave no target
//   maxOrderUsd    optional hard dollar cap from config; null disables it
export function sizeBuy({portfolioUsd, currentUsd = 0, remainingUsd, targetWeightPercent, conviction = 50, maxOrderUsd = null, sizing = DEFAULT_SIZING}) {
  const s = {...DEFAULT_SIZING, ...sizing};
  const book = Math.max(0, Number(portfolioUsd) || 0);
  const held = Math.max(0, Number(currentUsd) || 0);
  const room = Math.max(0, Number(remainingUsd) || 0);

  // The target is the model's, capped by the operator. With no target, fall
  // back to conviction as a fraction of the ceiling, so an 80-confidence call
  // with a 60% ceiling aims at 48%.
  // null and undefined mean "no target given", and must not be read as 0:
  // Number(null) is 0, which would size every such call to nothing.
  let target = targetWeightPercent == null || targetWeightPercent === '' ? NaN : Number(targetWeightPercent);
  if (!Number.isFinite(target)) target = s.maxPositionPercent * (Math.max(0, Math.min(100, Number(conviction) || 0)) / 100);
  target = Math.max(0, Math.min(s.maxPositionPercent, target));

  const desiredUsd = book * target / 100;
  const gapUsd = desiredUsd - held;
  if (gapUsd <= 0) return {usd: 0, reason: `already at or above target (${pct(held, book)}% held, target ${target.toFixed(0)}%)`, targetPercent: target, desiredUsd, gapUsd};

  const stepCap = book * s.maxOrderPercent / 100;
  let usd = Math.min(gapUsd, stepCap, room);
  if (maxOrderUsd != null && Number.isFinite(maxOrderUsd)) usd = Math.min(usd, maxOrderUsd);

  if (usd < s.minOrderUsd) return {usd: 0, reason: usd <= 0 ? 'no free cash' : `step $${usd.toFixed(2)} is under the $${s.minOrderUsd} minimum`, targetPercent: target, desiredUsd, gapUsd};

  const bound = usd === gapUsd ? 'reaches target' : usd === stepCap ? `one step of ${s.maxOrderPercent}%` : usd === room ? 'all remaining cash' : 'hard dollar cap';
  return {usd: round2(usd), reason: `${pct(held, book)}% held, target ${target.toFixed(0)}%, ${bound}`, targetPercent: target, desiredUsd: round2(desiredUsd), gapUsd: round2(gapUsd)};
}

// The book as the model should see it: whole-portfolio numbers and each
// position's weight. This is what turns "is NVDA good" into "should NVDA be
// a bigger part of what I hold".
export function portfolioView({room, held, sizing = DEFAULT_SIZING}) {
  const positionsUsd = held.totalUsd ?? 0;
  const portfolioUsd = Math.max(0, room) + positionsUsd;
  const rows = (held.rows ?? []).map(r => ({
    symbol: r.symbol,
    valueUsd: r.valueUsd == null ? null : round2(r.valueUsd),
    weightPercent: r.valueUsd == null || portfolioUsd <= 0 ? null : round2(r.valueUsd / portfolioUsd * 100),
    unrealizedPercent: r.unrealizedPercent == null ? null : round2(r.unrealizedPercent),
    openedAt: r.openedAt ?? null,
    thesis: r.thesis ?? null,
  })).sort((a, b) => (b.weightPercent ?? 0) - (a.weightPercent ?? 0));
  return {
    portfolioUsd: round2(portfolioUsd),
    cashUsd: round2(Math.max(0, room)),
    cashPercent: portfolioUsd > 0 ? round2(Math.max(0, room) / portfolioUsd * 100) : 100,
    positions: rows,
    limits: {maxPositionPercent: sizing.maxPositionPercent, maxOrderPercent: sizing.maxOrderPercent},
  };
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const pct = (part, whole) => whole > 0 ? (part / whole * 100).toFixed(0) : '0';
