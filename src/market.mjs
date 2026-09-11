// What the tape did. Built from the quotes the engine already pulls for the
// whole catalog every tick, so it costs nothing and needs no new feed.
//
// A person managing money does not look at one stock in a vacuum. They know
// whether the market is up or down today, whether semis are leading or
// lagging, whether a move in NVDA is NVDA or just the index. The benchmark
// tokens in the catalog give the model exactly that: SPY for the market, QQQ
// for growth, SMH and SOXX for semis, XLK for tech, GLD for risk-off, VTI for
// the whole thing.

import {moveOverPercent} from './prices.mjs';

export const BENCHMARKS = {
  SPY: 'S&P 500', QQQ: 'Nasdaq 100', VTI: 'total US market',
  SMH: 'semiconductors', SOXX: 'semiconductors', XLK: 'technology', GLD: 'gold',
};

const r2 = (n) => n == null ? null : Math.round(n * 100) / 100;

export function marketContext(quotes, priceStore, now = new Date(), {catalog = null, topN = 5} = {}) {
  const symbols = Object.keys(quotes);
  const name = (s) => catalog?.symbols?.find(x => x.symbol === s)?.name?.replace(/ • Robinhood Token$/i, '') ?? null;

  const benchmarks = [];
  for (const [sym, label] of Object.entries(BENCHMARKS)) {
    if (!quotes[sym]) continue;
    benchmarks.push({symbol: sym, tracks: label, priceUsd: quotes[sym].mid,
      move1hPercent: r2(moveOverPercent(priceStore, sym, 3600, now)),
      move24hPercent: r2(moveOverPercent(priceStore, sym, 86400, now))});
  }

  const rows = symbols.filter(s => !BENCHMARKS[s]).map(s => ({
    symbol: s, name: name(s),
    move1hPercent: moveOverPercent(priceStore, s, 3600, now),
    move24hPercent: moveOverPercent(priceStore, s, 86400, now),
    spreadPercent: quotes[s].spreadPercent,
    halted: Boolean(quotes[s].isTradingHalt),
  }));
  const with24 = rows.filter(x => Number.isFinite(x.move24hPercent));
  const with1h = rows.filter(x => Number.isFinite(x.move1hPercent));
  const breadth = {
    names: rows.length,
    up24hPercent: with24.length ? r2(with24.filter(x => x.move24hPercent > 0).length / with24.length * 100) : null,
    up1hPercent: with1h.length ? r2(with1h.filter(x => x.move1hPercent > 0).length / with1h.length * 100) : null,
    median24hPercent: with24.length ? r2(median(with24.map(x => x.move24hPercent))) : null,
    halted: rows.filter(x => x.halted).map(x => x.symbol),
  };
  const sorted = [...with24].sort((a, b) => b.move24hPercent - a.move24hPercent);
  const strip = (x) => ({symbol: x.symbol, name: x.name, move24hPercent: r2(x.move24hPercent), move1hPercent: r2(x.move1hPercent)});

  return {
    benchmarks,
    breadth,
    leaders24h: sorted.slice(0, topN).map(strip),
    laggards24h: sorted.slice(-topN).reverse().map(strip),
    // A move in a name that the whole tape shares is not a signal about the
    // name. The model is told what "beta" looked like so it can subtract it.
    note: benchmarks.length ? 'Compare any single-name move against the benchmarks before reading it as news about the name.' : 'No benchmark tokens quoted this cycle.',
  };
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
