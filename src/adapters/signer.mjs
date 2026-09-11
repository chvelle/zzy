import {createWalletClient, http, decodeFunctionData, getAddress, isAddress, toFunctionSelector} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {ROBINHOOD_CHAIN, ADDRESSES, ERC20_ABI, WETH_ABI, SWAP_ROUTER_ABI} from '../chain.mjs';

// The one place in this codebase that can sign. Everything that wants a
// signature goes through guard() first, and guard() decodes the calldata and
// refuses anything that could dispose of $ZZY. The invariant lives HERE, at
// the bottom of the stack, not in a planner that a caller could bypass.
//
// Key handling:
//   - Read once from ZZY_OPERATOR_PRIVATE_KEY, never logged, never written.
//   - Use a DEDICATED operator wallet that holds only what this loop needs.
//     Do not point this at a wallet holding anything you can't afford to lose
//     to a bug in this file.
//   - Live signing additionally requires ZZY_LIVE_EXECUTION_ACK to equal the
//     exact phrase below, so a stray `mode: live` in config can't sign alone.

export const LIVE_ACK_PHRASE = 'I_UNDERSTAND_THIS_SIGNS_TRANSACTIONS_WITH_REAL_FUNDS';

export class SignerGuardError extends Error {
  constructor(msg) { super(`Signer refused: ${msg}`); this.name = 'SignerGuardError'; }
}

const eq = (a, b) => isAddress(a) && isAddress(b) && getAddress(a) === getAddress(b);

// Given a tx {to, data, value}, decide whether it is allowed. Throws otherwise.
// Pure and synchronous so it can be unit-tested without a chain.
export function guard(tx, ctx) {
  const {zzyTokenAddress, allowedStockTokens = [], maxValueWei = 0n, ponsLocker = ADDRESSES.PONS_LOCKER, routerVariant} = ctx;
  if (!zzyTokenAddress) throw new SignerGuardError('zzyTokenAddress not configured -- cannot evaluate whether a tx touches $ZZY');
  if (!tx?.to || !isAddress(tx.to)) throw new SignerGuardError('tx.to is not a valid address');

  const to = getAddress(tx.to);
  const value = BigInt(tx.value ?? 0);
  const data = tx.data ?? '0x';

  // 1. Any call whose target IS the $ZZY contract is a disposal risk
  //    (transfer, approve, permit, increaseAllowance ... anything). Blocked.
  //    Reading is done via publicClient, never via a signed tx, so there is
  //    no legitimate reason for the signer to ever target this contract.
  if (eq(to, zzyTokenAddress)) throw new SignerGuardError('tx targets the $ZZY token contract itself -- no signed call to $ZZY is ever permitted');

  // 2. Native ETH may only go to WETH (deposit) or nothing. No bare sends.
  if (value > 0n && !eq(to, ADDRESSES.WETH) && !eq(to, ADDRESSES.UNISWAP_SWAP_ROUTER)) {
    throw new SignerGuardError('native ETH transfer to an address other than WETH/router');
  }
  if (value > maxValueWei) throw new SignerGuardError(`tx value ${value} exceeds per-tx cap ${maxValueWei}`);

  // 3. Destination allowlist: WETH, USDG, router, pons locker, allowed stock tokens.
  const allowedTargets = [ADDRESSES.WETH, ADDRESSES.USDG, ADDRESSES.UNISWAP_SWAP_ROUTER, ponsLocker, ...allowedStockTokens];
  if (!allowedTargets.some(a => eq(a, to))) throw new SignerGuardError(`destination ${to} is not on the allowlist`);

  // 4. Decode what the call actually does and check the direction.
  if (data === '0x') return true; // bare value to WETH/router only, already checked

  if (eq(to, ADDRESSES.WETH)) {
    const {functionName} = decodeSafely([...WETH_ABI, ...ERC20_ABI], data);
    if (functionName === 'approve') {
      const {args} = decodeSafely(ERC20_ABI, data);
      if (!eq(args[0], ADDRESSES.UNISWAP_SWAP_ROUTER)) throw new SignerGuardError('WETH approve to a spender other than the router');
      return true;
    }
    if (functionName === 'deposit') return true;
    if (functionName === 'withdraw') return true; // WETH->ETH for gas, fine
    throw new SignerGuardError(`unexpected WETH call ${functionName}`);
  }

  if (eq(to, ADDRESSES.USDG)) {
    // The book's cash. Only ever approved to the router, never transferred.
    const {functionName, args} = decodeSafely(ERC20_ABI, data);
    if (functionName === 'approve' && eq(args[0], ADDRESSES.UNISWAP_SWAP_ROUTER)) return true;
    throw new SignerGuardError(`USDG call ${functionName} is not permitted (only approve->router)`);
  }

  if (allowedStockTokens.some(a => eq(a, to))) {
    const {functionName, args} = decodeSafely(ERC20_ABI, data);
    // Stock tokens may be approved to the router (so they can be sold).
    // That's a legitimate sale of a stock token, not of $ZZY.
    if (functionName === 'approve' && eq(args[0], ADDRESSES.UNISWAP_SWAP_ROUTER)) return true;
    throw new SignerGuardError(`stock token call ${functionName} is not permitted (only approve->router)`);
  }

  if (eq(to, ADDRESSES.UNISWAP_SWAP_ROUTER)) {
    if (!routerVariant || !SWAP_ROUTER_ABI[routerVariant]) {
      throw new SignerGuardError('config.uniswap.routerVariant must be "SwapRouter" or "SwapRouter02" (verify on Blockscout) before any swap is signed');
    }
    const {functionName, args} = decodeSafely(SWAP_ROUTER_ABI[routerVariant], data);
    if (functionName !== 'exactInputSingle') throw new SignerGuardError(`router call ${functionName} is not permitted (only exactInputSingle)`);
    const params = args[0];
    // THE invariant: $ZZY may be tokenOut, never tokenIn.
    if (eq(params.tokenIn, zzyTokenAddress)) throw new SignerGuardError('swap has $ZZY as tokenIn -- that is a sale');
    // Swap output must come back to us, not to a third party. Mandatory: an
    // absent recipient in ctx used to skip this check entirely, which made the
    // guard weaker exactly when it was constructed carelessly.
    if (!ctx.recipient) throw new SignerGuardError('ctx.recipient is required -- refusing to sign a swap without knowing where the output goes');
    if (!eq(params.recipient, ctx.recipient)) throw new SignerGuardError('swap recipient is not the operator wallet');
    // A swap with no minimum output is an open invitation to be sandwiched:
    // the pool can be moved against us and we accept whatever comes back. The
    // engine always sets one, but the engine is not the trust boundary.
    if (BigInt(params.amountOutMinimum ?? 0) <= 0n) throw new SignerGuardError('swap has amountOutMinimum of 0 -- unbounded slippage is never signed');
    if (BigInt(params.amountIn ?? 0) <= 0n) throw new SignerGuardError('swap has amountIn of 0');
    // The legs that exist: WETH->$ZZY (buyback), WETH->USDG (fund the book),
    // USDG->stock (buy), stock->USDG (sell). Anything else is refused, which
    // among other things means cash can never be swapped back out to ETH by
    // the agent, and one stock is never swapped straight into another.
    const isStock = (a) => allowedStockTokens.some(x => eq(x, a));
    const legs = [
      [eq(params.tokenIn, ADDRESSES.WETH), eq(params.tokenOut, zzyTokenAddress)],
      [eq(params.tokenIn, ADDRESSES.WETH), eq(params.tokenOut, ADDRESSES.USDG)],
      [eq(params.tokenIn, ADDRESSES.USDG), isStock(params.tokenOut)],
      [isStock(params.tokenIn), eq(params.tokenOut, ADDRESSES.USDG)],
    ];
    if (!legs.some(([a, b]) => a && b)) throw new SignerGuardError('swap is not one of the permitted legs: WETH->$ZZY, WETH->USDG, USDG->stock, stock->USDG');
    return true;
  }

  if (eq(to, ponsLocker)) {
    // Fee claim. pons does not document the claim signature, so it is read
    // from the verified source and put in config (npm run verify). Until it
    // is there, this branch used to wave through ANY calldata to the locker,
    // which made the locker an unguarded destination on the allowlist. It now
    // fails closed: no configured selector, no signature.
    if (!ctx.ponsClaimSelector) {
      throw new SignerGuardError('pons.claim.functionName is not configured -- refusing to sign an unidentified call to the locker. Run: npm run verify');
    }
    if (!data.toLowerCase().startsWith(ctx.ponsClaimSelector.toLowerCase())) {
      throw new SignerGuardError('call to pons locker does not match the configured claim selector');
    }
    return true;
  }

  throw new SignerGuardError('unreachable: destination passed allowlist but no rule matched');
}

function decodeSafely(abi, data) {
  try { return decodeFunctionData({abi, data}); }
  catch { throw new SignerGuardError('calldata does not decode against the expected ABI -- refusing to sign an opaque call'); }
}

// The 4-byte selector of the configured pons claim function. Derived from the
// same fragment the adapter encodes with, so the guard and the caller can
// never drift apart. Returns null when nothing is configured, which the guard
// treats as a refusal rather than as permission.
export function ponsClaimSelector(config) {
  const c = config.pons?.claim;
  if (!c?.abi?.length || !c.functionName) return null;
  const frag = c.abi.find(f => typeof f === 'string' && f.includes(`${c.functionName}(`));
  if (!frag) return null;
  try { return toFunctionSelector(frag); } catch { return null; }
}

export function createGuardedSigner(config, env = process.env) {
  if (config.mode !== 'live') {
    return {account: null, address: null, live: false, async send() { throw new SignerGuardError('mode is not live'); }};
  }
  // A local fork signs without the acknowledgement because the money is fake.
  // config._fork is only ever set by fork.mjs, and only after it has proved
  // the RPC is on loopback AND is an Anvil node forking Robinhood Chain. It
  // is not a config file option, so it cannot be set by editing config.
  if (!config._fork && env.ZZY_LIVE_EXECUTION_ACK !== LIVE_ACK_PHRASE) {
    throw new SignerGuardError(`live mode requires ZZY_LIVE_EXECUTION_ACK=${LIVE_ACK_PHRASE}`);
  }
  const pk = env.ZZY_OPERATOR_PRIVATE_KEY;
  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new SignerGuardError('ZZY_OPERATOR_PRIVATE_KEY missing or malformed');
  const account = privateKeyToAccount(pk);
  const wallet = createWalletClient({account, chain: ROBINHOOD_CHAIN, transport: http(config.chain?.rpcUrl)});

  const ctx = {
    zzyTokenAddress: config.treasury?.zzyTokenAddress,
    allowedStockTokens: config.runtime?.allowedStockTokens ?? [],
    maxValueWei: BigInt(config.execution?.maxTxValueWei ?? 0),
    routerVariant: config.uniswap?.routerVariant,
    ponsLocker: config.pons?.locker ?? ADDRESSES.PONS_LOCKER,
    ponsClaimSelector: ponsClaimSelector(config),
    recipient: account.address,
  };

  return {
    account, address: account.address, live: true,
    async send(tx) {
      guard(tx, ctx); // throws before anything is signed
      return wallet.sendTransaction({to: tx.to, data: tx.data, value: tx.value ?? 0n});
    },
  };
}
