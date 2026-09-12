import {readJsonOrDefault, writeJsonAtomic} from './storage.mjs';

// $ZZY treasury accounting.
//
// SCOPE BOUNDARY, read this before extending the file:
// This module is ACCOUNTING ONLY. It computes splits, enforces invariants,
// and records what happened. It does not hold a private key, sign a
// transaction, claim fees on-chain, or execute a swap -- per AGENT.md rule
// #7. Buybacks are emitted as an *intent* that you (or an external signer
// you control) execute, and are only written to the ledger once you supply
// the resulting transaction hash. The ledger therefore records settled
// reality, never wishful intent.
//
// ASSET BOUNDARY: $ZZY is a Pons memecoin. It is a TREASURY asset here, and
// is never a trading candidate -- the `memecoin` asset class remains blocked
// in policy.mjs and nothing in this file relaxes that. The only $ZZY
// operation this codebase will ever model is BUY.

// Hard invariant. Not a config value, not a policy knob, not overridable by
// any flag, environment variable, or LLM verdict. Deliberately not exported
// as something mutable.
const ZZY_SELL_PERMANENTLY_BLOCKED = true;

export class ZzySellAttemptError extends Error {
  constructor(action) {
    super(`Refused: $ZZY may never be sold, swapped out, transferred out, or otherwise disposed of. Attempted action: ${action}. This is a permanent invariant in treasury.mjs and is not configurable.`);
    this.name = 'ZzySellAttemptError';
  }
}

const DISPOSAL_ACTIONS = new Set(['SELL', 'SWAP_OUT', 'TRANSFER_OUT', 'WITHDRAW', 'BURN', 'BRIDGE_OUT', 'APPROVE_SPEND']);

// Call this on the way into ANY treasury operation touching $ZZY.
export function assertZzyDisposalBlocked(action) {
  const normalized = String(action || '').toUpperCase();
  if (ZZY_SELL_PERMANENTLY_BLOCKED && DISPOSAL_ACTIONS.has(normalized)) {
    throw new ZzySellAttemptError(normalized);
  }
  return true;
}

function assertPositive(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a finite positive number`);
  }
}

// Deterministic split of a claimed fee amount. Shares are basis points and
// MUST sum to exactly 10000 -- a config that doesn't is a hard error rather
// than something silently normalized, so a typo can't quietly redirect funds.
export function planFeeClaim(claimUsd, config) {
  assertPositive(claimUsd, 'claimUsd');
  const t = config.treasury ?? {};
  const buybackBps = t.buybackShareBps ?? 5000;
  const tradingBps = t.tradingShareBps ?? 5000;
  if (buybackBps + tradingBps !== 10000) {
    throw new Error(`treasury.buybackShareBps + treasury.tradingShareBps must equal exactly 10000, got ${buybackBps + tradingBps}`);
  }
  if (!t.zzyTokenAddress) {
    throw new Error('treasury.zzyTokenAddress is not configured -- refusing to plan a buyback against an unknown token address');
  }

  // Round the buyback DOWN and give the remainder to trading, so rounding can
  // never manufacture buyback dollars that were not actually claimed.
  const buybackUsd = Math.floor(claimUsd * buybackBps) / 10000;
  const tradingUsd = Number((claimUsd - buybackUsd).toFixed(8));

  return {
    claimUsd,
    buyback: {
      action: 'BUY',            // the only $ZZY action this system will ever emit
      token: t.zzyTokenAddress,
      amountUsd: buybackUsd,
      disposition: 'hold-permanently',
      note: 'Execute with your own signer. This process holds no key and signs nothing.',
    },
    trading: {
      amountUsd: tradingUsd,
      purpose: 'tokenized-stock-strategy',
      note: 'Moving on-chain proceeds into a Robinhood Stock Token account is a manual off-ramp/deposit. This number is an accounting allocation, not an executed transfer.',
    },
    executed: false,
  };
}

const EMPTY_LEDGER = {schemaVersion: 1, entries: []};

export async function readLedger(config) {
  const file = config.treasury?.ledgerPath ?? 'treasury/ledger.json';
  return readJsonOrDefault(file, EMPTY_LEDGER);
}

export async function writeLedger(ledger, config) {
  const file = config.treasury?.ledgerPath ?? 'treasury/ledger.json';
  return writeJsonAtomic(file, ledger, {backup: true});
}

// Records a buyback that ALREADY happened. txHash is required: without a
// settled transaction there is nothing to record, and this module will not
// pretend an intent is a fill (AGENT.md rule #8).
export async function recordBuyback({claimUsd, claimEth, buybackUsd, tradingUsd, txHash, at, cashTxHash = null, claimTxHash = null, extra = null}, config) {
  assertZzyDisposalBlocked('BUY'); // sanity: BUY is allowed, disposals throw
  if (!txHash || typeof txHash !== 'string') {
    throw new Error('recordBuyback requires the txHash of an already-settled buyback transaction');
  }
  const ledger = await readLedger(config);
  ledger.entries.push({
    type: 'fee-claim',
    at: at ?? new Date().toISOString(),
    claimUsd,
    claimEth: claimEth ?? null,
    buybackUsd,
    tradingUsd,
    txHash,
    ...(cashTxHash ? {cashTxHash} : {}),
    ...(claimTxHash ? {claimTxHash} : {}),
    ...(extra ?? {}),
    zzyDisposition: 'held-permanently',
  });
  const file = await writeLedger(ledger, config);
  return {file, entries: ledger.entries.length};
}

// Records profit moved out of the trading book into a $ZZY buyback. Like
// every other $ZZY action this is a BUY, and like recordBuyback it demands a
// settled txHash so the ledger never carries an intention as a fact.
export async function recordProfitSweep({amountUsd, txHash, at}, config) {
  assertZzyDisposalBlocked('BUY');
  if (!(amountUsd > 0)) throw new Error('amountUsd must be positive');
  if (!txHash || typeof txHash !== 'string') throw new Error('recordProfitSweep requires the txHash of a settled buyback');
  const ledger = await readLedger(config);
  ledger.entries.push({type:'profit-sweep', at: at ?? new Date().toISOString(), amountUsd, txHash, zzyDisposition:'held-permanently'});
  const file = await writeLedger(ledger, config);
  return {file, entries: ledger.entries.length};
}

export async function recordRealizedPnl({amountUsd, note, at}, config) {
  if (typeof amountUsd !== 'number' || !Number.isFinite(amountUsd)) {
    throw new Error('amountUsd must be a finite number (negative for a loss)');
  }
  const ledger = await readLedger(config);
  ledger.entries.push({type: 'realized-pnl', at: at ?? new Date().toISOString(), amountUsd, note: note ?? ''});
  const file = await writeLedger(ledger, config);
  return {file, entries: ledger.entries.length};
}

// The treasury leg measures fee proceeds as WETH above a baseline. The
// trading leg also moves WETH: a stock buy spends it, a stock sale returns
// it. Without this, sale proceeds looked like fresh creator fees and half of
// them were bought into $ZZY, and a buy pushed the wallet under the baseline
// so real fees were invisible until it climbed back. Every trade that moves
// WETH calls this with the signed delta.
export async function adjustWethBaseline(deltaEth, config) {
  if (!Number.isFinite(deltaEth) || deltaEth === 0) return null;
  const file = config.treasury?.ledgerPath ?? 'treasury/ledger.json';
  const ledger = await readLedger(config);
  const next = Math.max(0, (ledger.wethBaselineEth ?? 0) + deltaEth);
  await writeJsonAtomic(file, {...ledger, wethBaselineEth: Number(next.toFixed(12))}, {backup: true});
  return next;
}

// Operator-funded principal. The operator sends USDG to the wallet, then
// records it here so the ledger knows the book may deploy it. The amount is
// checked against the wallet: you cannot record what is not there.
export async function recordDeposit({amountUsd, walletUsd, note, at}, config) {
  if (!(amountUsd > 0)) throw new Error('deposit amount must be positive');
  if (walletUsd != null && amountUsd > walletUsd + 0.01) throw new Error(`cannot record a $${amountUsd.toFixed(2)} deposit: the wallet holds $${walletUsd.toFixed(2)} USDG`);
  const ledger = await readLedger(config);
  ledger.entries.push({type: 'deposit', at: at ?? new Date().toISOString(), tradingUsd: amountUsd, note: note ?? 'operator deposit'});
  await writeLedger(ledger, config);
  return ledger;
}

export function zzyHeldForever(ledger) {
  // Every buyback: the half recorded on a claim, plus deferred buybacks that
  // settled later. An older settled record without a usd figure is valued
  // from its USDG amount (6 decimals), the only asset a V2 launch here pays.
  const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
  const totalBoughtUsd = ledger.entries.reduce((sum, e) => {
    if (e.type === 'fee-claim') return sum + (e.buybackUsd ?? 0);
    if (e.type === 'buyback-settled') {
      if (typeof e.usd === 'number') return sum + e.usd;
      if (typeof e.asset === 'string' && e.asset.toLowerCase() === USDG && e.amount) return sum + Number(e.amount) / 1e6;
    }
    return sum;
  }, 0);
  return {totalBoughtUsd: Number(totalBoughtUsd.toFixed(8)), everSold: false, sellPossible: false, disposition: 'burned'};
}
