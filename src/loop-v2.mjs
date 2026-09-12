// Treasury tick for a Pons V2 launch.
//
// The shape is the same as V1: claim, split fifty-fifty, buy $ZZY with one
// half (which is then burned), turn the other half into the book's cash. The
// plumbing is different at every step, so it lives in its own file.
//
//   claim     fee escrow, in the launch's quote asset (ETH, USDG, or a stock)
//   buyback   the bonding curve while the launch is on it; the Uniswap v4
//             pool through the Universal Router once it has graduated
//   cash      quote asset -> USDG: wrap+swap for ETH, nothing for USDG, a v3
//             sell for a stock token
//
// A buyback that cannot be executed right now (launch mid-graduation, no
// quote, price impact) is not lost and not spent on anything else: it is
// recorded as a pending buyback in the ledger and retried on every tick
// until it goes through. $ZZY is bought and burned, never sold.

import {formatEther, parseEther, zeroAddress, formatUnits, parseUnits} from 'viem';
import {ADDRESSES, ERC20_ABI, WETH_ABI} from './chain.mjs';
import {encodeFunctionData} from 'viem';
import {readLedger, recordBuyback, writeLedger, assertZzyDisposalBlocked, planFeeClaim} from './treasury.mjs';
import {bestQuote, buildApproveTx, buildSwapTx, applySlippage as v3Slippage, planWethToCash} from './adapters/uniswap.mjs';
import {cashBalance, fromCash, CASH} from './cash.mjs';
import {
  PONS_V2, UNISWAP_V4, PHASE, readLaunch, escrowOwed, unsweptFees, quoteCurveBuy, quoteV4Buy,
  buildClaimTx, buildCurveBuyTx, buildV4BuyTx, buildPermit2ApproveTx, buildApproveTx as approveTo, applySlippage, fmt,
} from './adapters/pons-v2.mjs';

const eq = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

async function settled(client, hash, what) {
  const r = await client.waitForTransactionReceipt({hash});
  if (r?.status && r.status !== 'success') throw new Error(`${what} reverted (${hash})`);
  return r;
}

async function pairDecimals(client, launch) {
  if (launch.native) return 18;
  return Number(await client.readContract({address: launch.pairToken, abi: ERC20_ABI, functionName: 'decimals'}));
}

// USD value of one unit of the quote asset. ETH from the price feed, USDG is
// a dollar, a stock token from its reference quote. Unknown -> null, and the
// tick declines to act rather than book a number it cannot stand behind.
async function pairUsd(client, launch, {ethUsd, catalog, fetchQuote}) {
  if (launch.native) return ethUsd;
  if (eq(launch.pairToken, ADDRESSES.USDG)) return 1;
  const entry = catalog?.symbols?.find(s => eq(s.address, launch.pairToken));
  if (entry && fetchQuote) { try { const q = await fetchQuote(entry.symbol); if (q?.mid > 0) return q.mid; } catch {} }
  return null;
}

// Buy $ZZY with `amount` of the quote asset. Returns {hash, venue, expectedOut} or throws.
async function buyZzy({client, signer, config, launch, amount, log}) {
  const slippage = config.execution?.slippageBps ?? 300;
  if (launch.phase === PHASE.NotGraduated) {
    const q = await quoteCurveBuy(client, launch.curve, amount, signer.address);
    if (q.tokensOut <= 0n) throw new Error('curve quote returned nothing');
    // minTokensOut bounds the price, not the quantity (docs), so size it from the rate
    const minOut = applySlippage(q.tokensOut, slippage);
    if (!launch.native) await settled(client, await signer.send(approveTo(launch.pairToken, launch.curve, amount)), 'pair approve to curve');
    const hash = await signer.send(buildCurveBuyTx({curve: launch.curve, quoteIn: amount, minTokensOut: minOut, recipient: signer.address, native: launch.native}));
    await settled(client, hash, 'curve buy');
    return {hash, venue: 'curve', expectedOut: q.tokensOut, refund: q.refund};
  }
  if (launch.phase === PHASE.PoolCreated) {
    const q = await quoteV4Buy(client, launch, amount);
    if (q.amountOut <= 0n) throw new Error('v4 quote returned nothing');
    const minOut = applySlippage(q.amountOut, slippage);
    if (!launch.native) {
      // Permit2 is how the Universal Router pulls an ERC-20: token -> Permit2 (once, max), Permit2 -> router (per trade).
      const allowance = await client.readContract({address: launch.pairToken, abi: ERC20_ABI, functionName: 'allowance', args: [signer.address, UNISWAP_V4.PERMIT2]});
      if (allowance < amount) await settled(client, await signer.send(approveTo(launch.pairToken, UNISWAP_V4.PERMIT2, 2n ** 160n - 1n)), 'pair approve to Permit2');
      await settled(client, await signer.send(buildPermit2ApproveTx(launch.pairToken, amount)), 'Permit2 approve to router');
    }
    const tx = buildV4BuyTx({launch, amountIn: amount, amountOutMinimum: minOut});
    const hash = await signer.send({to: tx.to, data: tx.data, value: tx.value});
    await settled(client, hash, 'v4 buy');
    return {hash, venue: 'v4', expectedOut: q.amountOut};
  }
  throw new Error(`launch is ${launch.phaseName}; buyback deferred`);
}

// Quote asset -> USDG for the trading half. Returns USDG received (number) and the hash.
async function toCash({client, signer, config, launch, amount, log}) {
  const before = await cashBalance(client, signer.address);
  let hash = null;
  if (eq(launch.pairToken, ADDRESSES.USDG) && !launch.native) {
    return {usd: fromCash(amount, before.decimals), hash: null, note: 'already USDG'};
  }
  if (launch.native) {
    // wrap, then WETH -> USDG through the deepest pool
    const wrap = {to: ADDRESSES.WETH, data: encodeFunctionData({abi: WETH_ABI, functionName: 'deposit'}), value: amount};
    await settled(client, await signer.send(wrap), 'wrap ETH');
    const plan = await planWethToCash(client, {amountWei: amount, slippageBps: config.execution?.cashSlippageBps ?? 50, recipient: signer.address, routerVariant: config.uniswap?.routerVariant});
    await settled(client, await signer.send(plan.approve), 'WETH approve');
    hash = await signer.send(plan.swap);
    await settled(client, hash, 'WETH -> USDG');
  } else {
    // a stock token: sell it for USDG on its own v3 pool
    const q = await bestQuote(client, {tokenIn: launch.pairToken, tokenOut: CASH, amountIn: amount});
    await settled(client, await signer.send(buildApproveTx(launch.pairToken, amount)), 'pair approve');
    hash = await signer.send(buildSwapTx({tokenIn: launch.pairToken, tokenOut: CASH, fee: q.fee, amountIn: amount, amountOutMinimum: v3Slippage(q.amountOut, config.execution?.stockSlippageBps ?? 100), recipient: signer.address, routerVariant: config.uniswap?.routerVariant}));
    await settled(client, hash, 'pair -> USDG');
  }
  const after = await cashBalance(client, signer.address);
  const usd = fromCash(after.raw - before.raw, after.decimals);
  if (!(usd > 0)) throw new Error(`conversion ${hash} settled but no USDG arrived`);
  return {usd, hash};
}

export async function treasuryTickV2({client, signer, config, ethUsd, catalog = null, fetchQuote = null, log = () => {}, now = new Date()}) {
  const token = config.treasury?.zzyTokenAddress;
  if (!token) return {skipped: true, reason: 'treasury.zzyTokenAddress not set'};
  assertZzyDisposalBlocked('BUY');
  const wallet = signer.address ?? config.runtime?.watchAddress;
  if (!wallet) return {skipped: true, reason: 'no wallet address'};

  const launch = await readLaunch(client, token, config.pons?.v2?.factory ?? PONS_V2.FACTORY);
  if (!launch) return {skipped: true, reason: 'token is not a Pons V2 launch on this factory'};
  if (!eq(launch.creatorFeeRecipient, wallet)) {
    log(`treasury: creator fees for ${token} go to ${launch.creatorFeeRecipient}, not this wallet; nothing to claim here`);
    return {acted: false, reason: 'not the creator fee recipient', launch};
  }

  const dec = await pairDecimals(client, launch);
  const price = await pairUsd(client, launch, {ethUsd, catalog, fetchQuote});
  const ledger = await readLedger(config);

  // 1. anything still owed from a previous tick's deferred buyback?
  const pending = ledger.pendingBuyback && BigInt(ledger.pendingBuyback.amount || 0) > 0n ? ledger.pendingBuyback : null;

  // 2. what is in the escrow now
  const owed = await escrowOwed(client, wallet, launch.native ? zeroAddress : launch.pairToken, config.pons?.v2?.escrow ?? PONS_V2.FEE_ESCROW);
  const unswept = await unsweptFees(client, launch).catch(() => null);
  const owedUnits = fmt(owed, dec), owedUsd = price != null ? owedUnits * price : null;
  const thresholdUsd = config.pons?.claimThresholdUsd ?? 20;

  const summary = `escrow owes ${owedUnits.toFixed(6)} ${launch.native ? 'ETH' : 'pair'}${owedUsd != null ? ` ($${owedUsd.toFixed(2)})` : ''}` +
    (unswept ? `; unswept on ${unswept.where}: ${fmt(unswept.quoteFee + unswept.creatorTax, dec).toFixed(6)}` : '') + `; launch ${launch.phaseName}`;

  if (!pending && (owedUsd == null || owedUsd < thresholdUsd)) {
    return {acted: false, reason: price == null ? `cannot price the quote asset ${launch.pairToken}; ${summary}` : `${summary}; below $${thresholdUsd}`, launch, owed: owed.toString()};
  }

  if (!signer.live) {
    log(`[preview] would claim ${owedUnits.toFixed(6)} from the Pons V2 escrow, buy ~half into $ZZY on the ${launch.phase === PHASE.NotGraduated ? 'curve' : 'v4 pool'}, and convert the rest to USDG`);
    return {acted: true, preview: true, launch, owed: owed.toString(), owedUsd};
  }

  const out = {acted: true, launch, claimTxHash: null, buyTxHash: null, cashTxHash: null};

  // 3. retry a deferred buyback first, with money already in the wallet
  if (pending) {
    try {
      const r = await buyZzy({client, signer, config, launch, amount: BigInt(pending.amount), log});
      log(`deferred buyback done on the ${r.venue}: ${r.hash}`);
      const l = await readLedger(config);
      l.entries.push({type: 'buyback-settled', at: now.toISOString(), amount: pending.amount, asset: pending.asset, usd: price != null ? Number((fmt(BigInt(pending.amount), dec) * price).toFixed(2)) : null, txHash: r.hash, venue: r.venue, zzyDisposition: 'burned'});
      delete l.pendingBuyback;
      await writeLedger(l, config);
      out.deferredBuyTxHash = r.hash;
      out.deferredBuybackUsd = price != null ? Number((fmt(BigInt(pending.amount), dec) * price).toFixed(2)) : null;
      out.deferredBuybackVenue = r.venue;
    } catch (e) { log(`deferred buyback still waiting: ${e.message.split('\n')[0]}`); }
  }

  if (!(owedUsd >= thresholdUsd)) return out;

  // 4. claim
  const claimTx = buildClaimTx(launch.native ? zeroAddress : launch.pairToken, config.pons?.v2?.escrow ?? PONS_V2.FEE_ESCROW);
  out.claimTxHash = await signer.send(claimTx);
  await settled(client, out.claimTxHash, 'escrow claim');
  log(`claimed ${owedUnits.toFixed(6)} from the Pons V2 escrow (${out.claimTxHash})`);

  // 5. split
  const claimUsd = owedUsd;
  const plan = planFeeClaim(claimUsd, config);
  const buybackAmt = owed * BigInt(config.treasury?.buybackShareBps ?? 5000) / 10000n;
  const tradingAmt = owed - buybackAmt;

  // 6. buyback: curve or v4; if it cannot run now, park it
  let buyback = null;
  try {
    buyback = await buyZzy({client, signer, config, launch, amount: buybackAmt, log});
    out.buyTxHash = buyback.hash;
    log(`bought ~${formatEther(buyback.expectedOut)} $ZZY on the ${buyback.venue} with ${fmt(buybackAmt, dec).toFixed(6)} (${buyback.hash})`);
  } catch (e) {
    log(`buyback deferred: ${e.message.split('\n')[0]}; ${fmt(buybackAmt, dec).toFixed(6)} of the quote asset is parked for it`);
    const l = await readLedger(config);
    const prev = BigInt(l.pendingBuyback?.amount || 0);
    l.pendingBuyback = {asset: launch.native ? 'ETH' : launch.pairToken, amount: (prev + buybackAmt).toString(), since: l.pendingBuyback?.since ?? now.toISOString()};
    await writeLedger(l, config);
  }

  // 7. cash
  const cash = await toCash({client, signer, config, launch, amount: tradingAmt, log});
  out.cashTxHash = cash.hash;

  out.buybackDeferredUsd = buyback ? 0 : Number((fmt(buybackAmt, dec) * price).toFixed(2));
  await recordBuyback({
    claimUsd, claimEth: launch.native ? fmt(owed, 18) : null,
    buybackUsd: buyback ? plan.buyback.amountUsd : 0, tradingUsd: cash.usd,
    txHash: buyback?.hash ?? out.claimTxHash, cashTxHash: cash.hash, claimTxHash: out.claimTxHash,
    at: now.toISOString(),
    extra: {pons: 'v2', venue: buyback?.venue ?? 'deferred', quoteAsset: launch.native ? 'ETH' : launch.pairToken, quoteAmount: owed.toString()},
  }, config);
  log(`book credited with $${cash.usd.toFixed(2)} USDG${cash.note ? ` (${cash.note})` : ''}`);
  return {...out, claimUsd, buybackUsd: buyback ? plan.buyback.amountUsd : 0, tradingUsd: cash.usd};
}
