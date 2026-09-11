// Exit guards.
//
// There is no fixed profit target. Exit decisions are made by the allocator
// (allocator.mjs), which reviews every position against every alternative on
// the table and asks whether the capital would do more elsewhere. A name that
// still has the best claim on its capital rides. One that no longer earns
// its place is closed or trimmed and the capital named for its replacement.
//
// Around that judgement sit three deterministic guards. They run before the
// allocator is consulted and it cannot overrule them. Two of them only stop
// an exit that is mechanically self-defeating; the third is the one thing
// that can force a sale without asking:
//
//   1. Fee viability. A swap costs gas plus the pool fee plus slippage.
//      Selling a position whose proceeds do not clear that cost turns a gain
//      into a loss however good the reasoning was. This is a solvency check
//      on the transaction, not a profit target.
//   2. Cooldown. Stops the same name being churned.
//   3. Stop loss. A backstop, checked before the agent is consulted, so a
//      position cannot bleed out while the agent talks itself into holding.
//
// Every failure path resolves to HOLD, never to a sale.

export const DEFAULT_EXIT = {
  minProceedsUsd: 5,
  estimatedExitCostUsd: 1.5,
  cooldownSeconds: 900,
  maxLossPercent: 25,       // backstop. null disables it.
  minTranchePercent: 20,    // if the agent trims, clamp it into this band
  maxTranchePercent: 75,
};

export function gainPercent(position, priceUsd) {
  if (!(position.costBasisUsd > 0) || !(position.qty > 0)) throw new Error('position needs costBasisUsd and qty');
  if (!(priceUsd > 0)) throw new Error('priceUsd must be positive');
  return ((position.qty * priceUsd - position.costBasisUsd) / position.costBasisUsd) * 100;
}

// Deterministic layer. Returns a decision when one is forced, else null to
// hand the call to the agent.
export function exitGuards(position, priceUsd, config = {}, {now = new Date()} = {}) {
  const p = {...DEFAULT_EXIT, ...(config.exitPolicy ?? {})};
  const gain = gainPercent(position, priceUsd);

  if (p.maxLossPercent != null && gain <= -Math.abs(p.maxLossPercent)) {
    return {action: 'CLOSE', gainPercent: gain, sellQty: position.qty, sellFraction: 1,
            source: 'guard', reason: `down ${gain.toFixed(1)} percent, past the ${p.maxLossPercent} percent stop`};
  }
  if (position.lastExitAt) {
    const since = (now - new Date(position.lastExitAt)) / 1000;
    if (since < p.cooldownSeconds) {
      return {action: 'HOLD', gainPercent: gain, source: 'guard',
              reason: `cooling down, ${Math.ceil(p.cooldownSeconds - since)}s left`};
    }
  }
  const value = position.qty * priceUsd;
  if (value < Math.max(p.minProceedsUsd, p.estimatedExitCostUsd * 2)) {
    return {action: 'HOLD', gainPercent: gain, source: 'guard',
            reason: `position is $${value.toFixed(2)}, an exit would not clear its own fees`};
  }
  return null;
}
