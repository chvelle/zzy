// Whether to spend a review.
//
// The cadence used to be a timer: every intervalSeconds, call the model.
// Running 24/7 that is 288 reviews a day, and between 8pm and 4am, and all
// weekend, most of them read exactly the inputs the last one read. A review
// is the only thing in the loop that costs money, so it has to earn its
// place the same way a position does.
//
// Two gates, both deterministic:
//
//   1. Cadence by session. Regular hours use research.intervalSeconds. Pre
//      and after hours use a longer interval. Closed and weekend use a much
//      longer one. Filings and headlines still arrive off hours, and the
//      fingerprint below catches them, so this only governs how often the
//      bot checks whether there is anything to think about.
//
//   2. Nothing new. A fingerprint of everything the model would be shown
//      (which names, which filings, which headlines, which notes, what is
//      held) is compared to the last review's. If it matches and no holding
//      has moved materially and no new cash has arrived, the review is
//      skipped. The model cannot form a different view of identical inputs,
//      so asking it to is pure cost.
//
// Fork overrides bypass both, because they exist to prove plumbing.

import {createHash} from 'node:crypto';

export const DEFAULT_CADENCE = {
  intervalSeconds: 300,          // regular session
  intervalSecondsExtended: 900,  // pre-market and after-hours
  intervalSecondsClosed: 3600,   // overnight and weekend
  skipIfNothingNew: true,
  materialMovePercent: 2,        // a holding moving this much since the last review is new information
};

export function cadenceConfig(config) { return {...DEFAULT_CADENCE, ...(config.research ?? {})}; }

export function intervalFor(session, config) {
  const c = cadenceConfig(config);
  if (!session || session.phase === 'regular') return c.intervalSeconds;
  if (session.phase === 'premarket' || session.phase === 'afterhours') return c.intervalSecondsExtended;
  return c.intervalSecondsClosed;
}

// Everything that could change the model's answer, reduced to one hash.
export function reviewFingerprint({shortlist = [], holdings = [], notebook = [], portfolioCashUsd = 0}) {
  const h = createHash('sha256');
  const sym = (x) => x.symbol ?? x.snapshot?.asset?.symbol ?? '';
  const ids = (list) => (list ?? []).map(x => x.url ?? x.title ?? x.form ?? '').filter(Boolean).sort().join('|');
  for (const c of [...shortlist].sort((a, b) => sym(a).localeCompare(sym(b)))) {
    h.update(`C:${sym(c)}:${ids(c.headlines)}:${ids(c.events)};`);
  }
  for (const p of [...holdings].sort((a, b) => sym(a).localeCompare(sym(b)))) {
    h.update(`H:${sym(p)}:${ids(p.headlines)}:${ids(p.events)};`);
  }
  for (const n of [...notebook].sort((a, b) => sym(a).localeCompare(sym(b)))) h.update(`N:${sym(n)}:${n.note};`);
  // Cash is bucketed so a few cents of price drift on an unrelated position
  // does not count as new money. New fees do.
  h.update(`$:${Math.floor(portfolioCashUsd / 5)}`);
  return h.digest('hex').slice(0, 16);
}

// Returns {review: bool, reason}. `state` carries lastCheckAt (when the gate
// last ran), lastReviewAt (when the model was last called), lastFingerprint
// and lastPrices (symbol -> price at the last real review).
// The cadence gate (intervalFor) runs in the engine before any fetch. This
// is the second gate only: given that a review is due, is there anything
// new to think about?
export function shouldReview({state, fingerprint, holdingPrices = {}, overridesPending = false}, config) {
  const c = cadenceConfig(config);
  if (overridesPending) return {review: true, reason: 'fork override pending'};
  if (!state.lastReviewAt) return {review: true, reason: 'first review'};
  if (!c.skipIfNothingNew) return {review: true, reason: 'due'};

  const moved = Object.entries(holdingPrices).find(([s, px]) => {
    const prev = state.lastPrices?.[s];
    return prev > 0 && Math.abs((px - prev) / prev) * 100 >= c.materialMovePercent;
  });
  if (moved) return {review: true, reason: `${moved[0]} moved ${(((moved[1] - state.lastPrices[moved[0]]) / state.lastPrices[moved[0]]) * 100).toFixed(1)}% since the last review`};
  if (fingerprint !== state.lastFingerprint) return {review: true, reason: 'new information since the last review'};
  return {review: false, reason: 'nothing new since the last review, skipping the model call'};
}
