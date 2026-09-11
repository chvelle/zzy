import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {parseEther} from 'viem';
import {treasuryTick} from '../src/loop.mjs';
import {ADDRESSES} from '../src/chain.mjs';
import {readLedger} from '../src/treasury.mjs';

const ZZY = '0x1111111111111111111111111111111111111111';
const ME = '0x3333333333333333333333333333333333333333';

function fakeClient({wethEth = 0, claimableEth = null, quoteOut = 1000n, usdgRaw = 0n} = {}) {
  const state = {wethEth, claimableEth, calls: [], usdgRaw, swaps: 0};
  return {
    state,
    async readContract({address, functionName, args}) {
      state.calls.push(functionName);
      if (address === ADDRESSES.USDG && functionName === 'decimals') return 6;
      if (address === ADDRESSES.USDG && functionName === 'balanceOf') return state.usdgRaw;
      if (address === ADDRESSES.WETH && functionName === 'balanceOf') return parseEther(String(state.wethEth));
      if (functionName === 'claimable') return parseEther(String(state.claimableEth ?? 0));
      throw new Error(`fake: unhandled read ${functionName}`);
    },
    async simulateContract({functionName}) {
      if (functionName === 'quoteExactInputSingle') return {result: [quoteOut, 0n, 0, 0n]};
      throw new Error('fake: unhandled simulate');
    },
    async waitForTransactionReceipt() { return {status: 'success'}; },
    // the test bumps USDG itself after the conversion swap, see below
  };
}

function fakeSigner(live, onSend = () => {}) {
  const sent = [];
  return {sent, live, address: ME, async send(tx) { sent.push(tx); onSend(tx); return `0xhash${sent.length}`; }};
}

async function cfg(dir, extra = {}) {
  return {
    mode: 'preview',
    treasury: {zzyTokenAddress: ZZY, buybackShareBps: 5000, tradingShareBps: 5000, ledgerPath: path.join(dir, 'ledger.json'), minProceedsEth: 0.01},
    policy: {maxTotalExposureUsd: 250},
    uniswap: {routerVariant: 'SwapRouter02'},
    execution: {slippageBps: 300, maxTxValueWei: '0'},
    pons: {
      claimThresholdEth: 0.42,
      claimable: {abi: ['function claimable(address) view returns (uint256)'], functionName: 'claimable'},
      claim: {abi: ['function claimFees(address token)'], functionName: 'claimFees'},
    },
    ...extra,
  };
}

test('below threshold and no unallocated WETH: nothing happens', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zzy-'));
  try {
    const r = await treasuryTick({client: fakeClient({claimableEth: 0.2, wethEth: 0}), signer: fakeSigner(false), config: await cfg(dir), ethUsd: 3000});
    assert.equal(r.acted, false);
    assert.equal(r.claimTxHash, null);
  } finally { await rm(dir, {recursive: true}); }
});

test('preview: at threshold it plans a claim and a 50/50 buy but signs nothing', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zzy-'));
  try {
    const signer = fakeSigner(false);
    const logs = [];
    const r = await treasuryTick({client: fakeClient({claimableEth: 0.5, wethEth: 0.5}), signer, config: await cfg(dir), ethUsd: 3000, log: m => logs.push(m)});
    assert.equal(r.acted, true);
    assert.equal(signer.sent.length, 0);
    assert.equal(r.buybackEth, 0.25);
    assert.equal(r.tradingEth, 0.25);
    assert.ok(logs.some(l => l.includes('would claim')));
    assert.ok(logs.some(l => l.includes('would buy')));
  } finally { await rm(dir, {recursive: true}); }
});

test('live: claims, buys $ZZY with half, converts the other half to USDG, records what arrived, moves the baseline', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zzy-'));
  try {
    const client = fakeClient({claimableEth: 0.5, wethEth: 0.5});
    let swaps = 0;
    const signer = fakeSigner(true, tx => {
      if (tx.to !== ADDRESSES.UNISWAP_SWAP_ROUTER) return;
      swaps++;
      if (swaps === 1) client.state.wethEth = 0.25;                       // buyback spent 0.25 WETH
      if (swaps === 2) { client.state.wethEth = 0; client.state.usdgRaw = 748_500_000n; }   // conversion: 0.25 WETH -> 748.50 USDG
    });
    const config = await cfg(dir, {mode: 'live'});
    const r = await treasuryTick({client, signer, config, ethUsd: 3000});
    assert.equal(r.acted, true);
    assert.deepEqual(signer.sent.map(t => t.to), [ADDRESSES.PONS_LOCKER, ADDRESSES.WETH, ADDRESSES.UNISWAP_SWAP_ROUTER, ADDRESSES.WETH, ADDRESSES.UNISWAP_SWAP_ROUTER],
      'claim, approve, buyback swap, approve, conversion swap');
    const ledger = await readLedger(config);
    assert.equal(ledger.entries.length, 1);
    assert.equal(ledger.entries[0].buybackUsd, 750);
    assert.equal(ledger.entries[0].tradingUsd, 748.5, 'the book is credited with the USDG that actually arrived, not the ETH-price estimate');
    assert.equal(ledger.entries[0].zzyDisposition, 'held-permanently');
    assert.equal(ledger.wethBaselineEth, 0, 'nothing left in WETH after both swaps');
  } finally { await rm(dir, {recursive: true}); }
});

test('fees already routed to the wallet by pons automation are picked up without a claim', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zzy-'));
  try {
    const config = await cfg(dir, {pons: {claimThresholdEth: 0.42}}); // no claimable view configured
    const r = await treasuryTick({client: fakeClient({wethEth: 0.6}), signer: fakeSigner(false), config, ethUsd: 3000});
    assert.equal(r.acted, true);
    assert.equal(r.claimable, null);
    assert.equal(r.proceedsEth, 0.6);
  } finally { await rm(dir, {recursive: true}); }
});

test('a missing claim ABI refuses to claim instead of guessing a selector', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zzy-'));
  try {
    const config = await cfg(dir, {mode: 'live', pons: {claimThresholdEth: 0.42, claimable: {abi: ['function claimable(address) view returns (uint256)'], functionName: 'claimable'}}});
    await assert.rejects(() => treasuryTick({client: fakeClient({claimableEth: 1, wethEth: 0}), signer: fakeSigner(true), config, ethUsd: 3000}), /will not be guessed/);
  } finally { await rm(dir, {recursive: true}); }
});

test('the loop never builds a swap with $ZZY as tokenIn', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zzy-'));
  try {
    const client = fakeClient({claimableEth: 0.5, wethEth: 0.5});
    let swaps = 0;
    const signer = fakeSigner(true, tx => { if (tx.to === ADDRESSES.UNISWAP_SWAP_ROUTER && ++swaps === 2) client.state.usdgRaw = 700_000_000n; });
    await treasuryTick({client, signer, config: await cfg(dir, {mode: 'live'}), ethUsd: 3000});
    const {decodeFunctionData} = await import('viem');
    const {SWAP_ROUTER_ABI} = await import('../src/chain.mjs');
    const swapTxs = signer.sent.filter(t => t.to === ADDRESSES.UNISWAP_SWAP_ROUTER);
    assert.equal(swapTxs.length, 2);
    for (const tx of swapTxs) {
      const {args} = decodeFunctionData({abi: SWAP_ROUTER_ABI.SwapRouter02, data: tx.data});
      assert.equal(args[0].tokenIn.toLowerCase(), ADDRESSES.WETH.toLowerCase(), 'both legs spend WETH; $ZZY is never tokenIn');
      assert.ok([ZZY, ADDRESSES.USDG.toLowerCase()].includes(args[0].tokenOut.toLowerCase()));
    }
  } finally { await rm(dir, {recursive: true}); }
});
