import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeFunctionData, parseEther} from 'viem';
import {guard, SignerGuardError, createGuardedSigner, LIVE_ACK_PHRASE, ponsClaimSelector} from '../src/adapters/signer.mjs';
import {ADDRESSES, ERC20_ABI, SWAP_ROUTER_ABI, WETH_ABI} from '../src/chain.mjs';

const ZZY = '0x1111111111111111111111111111111111111111';
const STOCK = '0x2222222222222222222222222222222222222222';
const ME = '0x3333333333333333333333333333333333333333';
const STRANGER = '0x4444444444444444444444444444444444444444';
const ctx = {zzyTokenAddress: ZZY, allowedStockTokens: [STOCK], maxValueWei: parseEther('1'), routerVariant: 'SwapRouter02', recipient: ME};

const swap = (tokenIn, tokenOut, recipient = ME, amountOutMinimum = 1n) => ({
  to: ADDRESSES.UNISWAP_SWAP_ROUTER,
  data: encodeFunctionData({abi: SWAP_ROUTER_ABI.SwapRouter02, functionName: 'exactInputSingle', args: [{tokenIn, tokenOut, fee: 10000, recipient, amountIn: 1n, amountOutMinimum, sqrtPriceLimitX96: 0n}]}),
});
const erc20 = (to, fn, args) => ({to, data: encodeFunctionData({abi: ERC20_ABI, functionName: fn, args})});

test('buying $ZZY with WETH is allowed', () => {
  assert.equal(guard(swap(ADDRESSES.WETH, ZZY), ctx), true);
});

test('selling $ZZY for WETH is refused at the signer', () => {
  assert.throws(() => guard(swap(ZZY, ADDRESSES.WETH), ctx), /tokenIn -- that is a sale/);
});

test('selling $ZZY for a stock token is refused', () => {
  assert.throws(() => guard(swap(ZZY, STOCK), ctx), /that is a sale/);
});

test('any signed call targeting the $ZZY contract is refused: transfer, approve, transferFrom, increaseAllowance', () => {
  for (const [fn, args] of [['transfer', [STRANGER, 1n]], ['approve', [ADDRESSES.UNISWAP_SWAP_ROUTER, 1n]], ['transferFrom', [ME, STRANGER, 1n]], ['increaseAllowance', [STRANGER, 1n]]]) {
    assert.throws(() => guard(erc20(ZZY, fn, args), ctx), /targets the \$ZZY token contract/, fn);
  }
});

test('$ZZY bought must land in the operator wallet, not a third party', () => {
  assert.throws(() => guard(swap(ADDRESSES.WETH, ZZY, STRANGER), ctx), /recipient is not the operator wallet/);
});

test('stock tokens are bought with USDG and sold for USDG; the four legs and nothing else', () => {
  assert.equal(guard(swap(ADDRESSES.USDG, STOCK), ctx), true, 'buy');
  assert.equal(guard(swap(STOCK, ADDRESSES.USDG), ctx), true, 'sell');
  assert.equal(guard(swap(ADDRESSES.WETH, ADDRESSES.USDG), ctx), true, 'fund the book from a fee claim');
  assert.equal(guard(swap(ADDRESSES.WETH, ZZY), ctx), true, 'buyback');
  assert.equal(guard(erc20(STOCK, 'approve', [ADDRESSES.UNISWAP_SWAP_ROUTER, 1n]), ctx), true);
  assert.equal(guard(erc20(ADDRESSES.USDG, 'approve', [ADDRESSES.UNISWAP_SWAP_ROUTER, 1n]), ctx), true);
  // stock tokens have no WETH pool worth using; the agent never trades them for WETH
  assert.throws(() => guard(swap(ADDRESSES.WETH, STOCK), ctx), /permitted legs/);
  assert.throws(() => guard(swap(STOCK, ADDRESSES.WETH), ctx), /permitted legs/);
  // cash never leaves for ETH, and stocks never swap straight into stocks
  assert.throws(() => guard(swap(ADDRESSES.USDG, ADDRESSES.WETH), ctx), /permitted legs/);
  assert.throws(() => guard(swap(STOCK, STOCK), ctx), /permitted legs/);
  // USDG itself can only be approved to the router
  assert.throws(() => guard(erc20(ADDRESSES.USDG, 'transfer', [STRANGER, 1n]), ctx), /only approve->router/);
});

test('a stock token not in the catalog allowlist cannot be swapped into', () => {
  assert.throws(() => guard(swap(ADDRESSES.USDG, STRANGER), ctx), /permitted legs/);
});

test('stock token transfer to a stranger is refused (only approve->router)', () => {
  assert.throws(() => guard(erc20(STOCK, 'transfer', [STRANGER, 1n]), ctx), /only approve->router/);
});

test('WETH may only be approved to the router', () => {
  assert.equal(guard(erc20(ADDRESSES.WETH, 'approve', [ADDRESSES.UNISWAP_SWAP_ROUTER, 1n]), ctx), true);
  assert.throws(() => guard(erc20(ADDRESSES.WETH, 'approve', [STRANGER, 1n]), ctx), /spender other than the router/);
});

test('bare ETH sends to unknown addresses are refused', () => {
  assert.throws(() => guard({to: STRANGER, value: 1n, data: '0x'}, ctx), /native ETH transfer/);
});

test('per-tx value cap is enforced', () => {
  assert.throws(() => guard({to: ADDRESSES.WETH, value: parseEther('2'), data: encodeFunctionData({abi: WETH_ABI, functionName: 'deposit'})}, ctx), /exceeds per-tx cap/);
});

test('opaque calldata to the router is refused rather than trusted', () => {
  assert.throws(() => guard({to: ADDRESSES.UNISWAP_SWAP_ROUTER, data: '0xdeadbeef'}, ctx), /does not decode/);
});

test('no swap is signed until the router variant is verified', () => {
  assert.throws(() => guard(swap(ADDRESSES.WETH, ZZY), {...ctx, routerVariant: null}), /routerVariant must be/);
});

test('guard cannot evaluate without a $ZZY address, so it refuses everything', () => {
  assert.throws(() => guard(swap(ADDRESSES.WETH, STOCK), {...ctx, zzyTokenAddress: null}), /zzyTokenAddress not configured/);
});

test('live signer refuses without the explicit ack phrase', () => {
  assert.throws(() => createGuardedSigner({mode: 'live'}, {ZZY_OPERATOR_PRIVATE_KEY: '0x' + '11'.repeat(32)}), SignerGuardError);
  assert.throws(() => createGuardedSigner({mode: 'live'}, {ZZY_LIVE_EXECUTION_ACK: 'yes', ZZY_OPERATOR_PRIVATE_KEY: '0x' + '11'.repeat(32)}), /requires ZZY_LIVE_EXECUTION_ACK/);
});

test('preview mode signer cannot send anything', async () => {
  const s = createGuardedSigner({mode: 'preview'}, {});
  assert.equal(s.live, false);
  await assert.rejects(() => s.send({to: ADDRESSES.WETH, data: '0x'}), /mode is not live/);
});

test('live signer with ack and key constructs, and still refuses a $ZZY sale', async () => {
  const s = createGuardedSigner(
    {mode: 'live', treasury: {zzyTokenAddress: ZZY}, uniswap: {routerVariant: 'SwapRouter02'}, execution: {maxTxValueWei: '0'}},
    {ZZY_LIVE_EXECUTION_ACK: LIVE_ACK_PHRASE, ZZY_OPERATOR_PRIVATE_KEY: '0x' + '11'.repeat(32)},
  );
  assert.equal(s.live, true);
  assert.match(s.address, /^0x[0-9a-fA-F]{40}$/);
  await assert.rejects(() => s.send(swap(ZZY, ADDRESSES.WETH, s.address)), /that is a sale/);
});

test('a swap with no minimum output is refused, whatever else is correct', () => {
  assert.throws(() => guard(swap(ADDRESSES.WETH, STOCK, ME, 0n), ctx), /amountOutMinimum of 0/);
});

test('a swap is refused when ctx has no recipient to compare against', () => {
  const {recipient, ...noRecipient} = ctx;
  assert.throws(() => guard(swap(ADDRESSES.WETH, STOCK), noRecipient), /ctx.recipient is required/);
});

test('the pons locker is not a wildcard destination when no claim selector is set', () => {
  const tx = {to: ADDRESSES.PONS_LOCKER, data: '0xdeadbeef', value: 0n};
  assert.throws(() => guard(tx, ctx), /refusing to sign an unidentified call to the locker/);
});

test('once a claim selector is configured, only that selector is signable', () => {
  const withSel = {...ctx, ponsClaimSelector: '0x12345678'};
  assert.equal(guard({to: ADDRESSES.PONS_LOCKER, data: '0x12345678', value: 0n}, withSel), true);
  assert.throws(() => guard({to: ADDRESSES.PONS_LOCKER, data: '0x87654321', value: 0n}, withSel),
    /does not match the configured claim selector/);
});

test('ponsClaimSelector derives from config and returns null when unset', () => {
  assert.equal(ponsClaimSelector({}), null);
  assert.equal(ponsClaimSelector({pons: {claim: {abi: ['function claimFees(address token)'], functionName: 'claimFees'}}}).length, 10);
  assert.equal(ponsClaimSelector({pons: {claim: {abi: ['function other(address)'], functionName: 'claimFees'}}}), null);
});
