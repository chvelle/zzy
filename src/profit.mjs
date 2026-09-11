import {readLedger} from './treasury.mjs';

// What happens to trading profit.
//
// Three quantities, kept distinct because conflating them is how a book
// quietly eats its own capital:
//
//   principal   the trading half of every fee claim. This only ever grows
//               when fees are claimed. It is the money the agent was given
//               to trade with.
//   realised    profit and loss actually booked from closed positions.
//   swept       profit already moved out of the book into $ZZY buybacks.
//
//   book value  = principal + realised - swept
//
// A sweep is measured against a high water mark, so profit that has already
// been swept is never swept a second time after a drawdown recovers. Without
// that, a book that goes 100 -> 120 -> 100 -> 120 would pay out twice on the
// same twenty dollars and end up below its principal.

export const MODES = ['compound', 'buyback', 'threshold'];

export const DEFAULT_PROFIT = {
  mode: 'threshold',
  compoundUntilUsd: 10000,  // grow the book to here, then sweep the excess
  minSweepUsd: 25,          // below this a sweep is not worth the gas
  sweepShareBps: 10000,     // how much of the excess to sweep, 10000 = all
};

export function bookState(ledger, config = {}) {
  const p = {...DEFAULT_PROFIT, ...(config.profitPolicy ?? {})};
  const sum = (type, field) => ledger.entries
    .filter(e => e.type === type)
    .reduce((s, e) => s + (e[field] ?? 0), 0);

  const principalUsd = sum('fee-claim', 'tradingUsd') + sum('deposit', 'tradingUsd');
  const realisedPnlUsd = sum('realized-pnl', 'amountUsd');
  const sweptUsd = sum('profit-sweep', 'amountUsd');
  const bookValueUsd = principalUsd + realisedPnlUsd - sweptUsd;
  // Lifetime profit, whether it is still in the book or already swept out.
  const lifetimeProfitUsd = realisedPnlUsd;

  let targetUsd;
  if (p.mode === 'compound') targetUsd = Infinity;
  else if (p.mode === 'buyback') targetUsd = principalUsd;
  else targetUsd = Math.min(p.compoundUntilUsd, Math.max(p.compoundUntilUsd, principalUsd));

  const excess = Number.isFinite(targetUsd) ? Math.max(0, bookValueUsd - targetUsd) : 0;
  const sweepableUsd = Number((excess * (p.sweepShareBps / 10000)).toFixed(8));

  return {
    mode: p.mode,
    principalUsd: round(principalUsd),
    realisedPnlUsd: round(realisedPnlUsd),
    sweptToBuybackUsd: round(sweptUsd),
    bookValueUsd: round(bookValueUsd),
    lifetimeProfitUsd: round(lifetimeProfitUsd),
    targetUsd: Number.isFinite(targetUsd) ? round(targetUsd) : null,
    sweepableUsd: round(sweepableUsd),
    // How far through the compounding phase the book is, for display.
    progressPercent: Number.isFinite(targetUsd) && targetUsd > 0
      ? Math.min(100, round((bookValueUsd / targetUsd) * 100)) : null,
  };
}

// Returns a sweep to execute, or null. The sweep is a BUY of $ZZY, which is
// the only $ZZY action this system can emit at all (see treasury.mjs).
export function planProfitSweep(ledger, config = {}) {
  const p = {...DEFAULT_PROFIT, ...(config.profitPolicy ?? {})};
  if (!MODES.includes(p.mode)) throw new Error(`profitPolicy.mode must be one of ${MODES.join(', ')}`);
  const state = bookState(ledger, config);
  if (p.mode === 'compound') return null;
  if (state.sweepableUsd < p.minSweepUsd) return null;
  return {
    action: 'BUY',
    amountUsd: state.sweepableUsd,
    disposition: 'hold-permanently',
    reason: p.mode === 'buyback'
      ? 'profit above principal, sweeping to $ZZY'
      : `book above the $${state.targetUsd} compounding target, sweeping the excess to $ZZY`,
    state,
  };
}

function round(n) { return Number((n ?? 0).toFixed(2)); }

// Deployable capital for the trading leg: the book, capped by the hard
// exposure ceiling in policy. The ceiling still binds independently.
export function deployable(ledger, config = {}) {
  const state = bookState(ledger, config);
  const ceiling = config.policy?.maxTotalExposureUsd ?? 0;
  const inBook = Math.max(0, state.bookValueUsd - state.sweepableUsd);
  return {
    ...state,
    deployableUsd: round(Math.min(inBook, ceiling)),
    cappedByPolicy: inBook > ceiling,
    exposureCapUsd: ceiling,
  };
}

export async function readBookState(config) {
  return bookState(await readLedger(config), config);
}
