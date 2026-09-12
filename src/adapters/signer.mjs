import {createWalletClient, http, decodeFunctionData, decodeAbiParameters, getAddress, isAddress, toFunctionSelector, zeroAddress} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {ROBINHOOD_CHAIN, ADDRESSES, ERC20_ABI, WETH_ABI, SWAP_ROUTER_ABI} from '../chain.mjs';
import {PONS_V2, UNISWAP_V4, V2_ESCROW_ABI, V2_CURVE_ABI, UNIVERSAL_ROUTER_ABI, PERMIT2_ABI, UR_COMMAND_V4_SWAP, V4_ACTION, RH_V4_SWAP_EXACT_IN_SINGLE, readLaunch} from './pons-v2.mjs';

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
  // Pons V2 surfaces. ctx.ponsV2 is set by the signer itself from the V2
  // factory (see resolvePonsV2); until it is, every V2 destination is refused.
  const v2 = ctx.ponsV2 ?? null;
  const v2Escrow = v2?.escrow ?? PONS_V2.FEE_ESCROW;
  const v2Curve = v2?.curve ?? null;
  const v2Pair = v2?.pairToken ?? null;   // zero address for a native launch
  const v2PairIsErc20 = v2Pair && !eq(v2Pair, zeroAddress);
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

  // 2. Native ETH may only go to WETH (deposit), the v3 router, the launch's
  //    own curve (a native buy), or the Universal Router (a native v4 buy).
  //    No bare sends anywhere.
  const nativeOk = eq(to, ADDRESSES.WETH) || eq(to, ADDRESSES.UNISWAP_SWAP_ROUTER) || (v2Curve && eq(to, v2Curve)) || eq(to, UNISWAP_V4.UNIVERSAL_ROUTER);
  if (value > 0n && !nativeOk) throw new SignerGuardError('native ETH transfer to an address other than WETH/router/curve/universal router');
  if (value > maxValueWei) throw new SignerGuardError(`tx value ${value} exceeds per-tx cap ${maxValueWei}`);

  // 3. Destination allowlist: WETH, USDG, v3 router, pons v1 locker, allowed
  //    stock tokens, and (once resolved) the v2 escrow, curve, Universal
  //    Router and Permit2.
  const allowedTargets = [ADDRESSES.WETH, ADDRESSES.USDG, ADDRESSES.UNISWAP_SWAP_ROUTER, ponsLocker, ...allowedStockTokens,
    UNISWAP_V4.UNIVERSAL_ROUTER, UNISWAP_V4.PERMIT2,
    ...(v2 ? [v2Escrow, ...(v2Curve ? [v2Curve] : [])] : [])];
  if (!allowedTargets.some(a => eq(a, to))) throw new SignerGuardError(`destination ${to} is not on the allowlist`);

  // 4. Decode what the call actually does and check the direction.
  if (data === '0x') return true; // bare value to WETH/router only, already checked

  // The spenders an ERC-20 may ever be approved to: the v3 router, the
  // launch's own curve, and Permit2 (which only the Universal Router draws
  // on, and only per our own Permit2.approve). $ZZY is never approved to
  // anyone: rule 1 already refused any call targeting it.
  const spenderOk = (sp) => eq(sp, ADDRESSES.UNISWAP_SWAP_ROUTER) || (v2Curve && eq(sp, v2Curve)) || eq(sp, UNISWAP_V4.PERMIT2);

  if (eq(to, ADDRESSES.WETH)) {
    const {functionName} = decodeSafely([...WETH_ABI, ...ERC20_ABI], data);
    if (functionName === 'approve') {
      const {args} = decodeSafely(ERC20_ABI, data);
      if (!spenderOk(args[0])) throw new SignerGuardError('WETH approve to a spender other than the router/curve/Permit2');
      return true;
    }
    if (functionName === 'deposit') return true;
    if (functionName === 'withdraw') return true; // WETH->ETH for gas, fine
    throw new SignerGuardError(`unexpected WETH call ${functionName}`);
  }

  if (eq(to, ADDRESSES.USDG)) {
    // The book's cash. Only ever approved to the router, never transferred.
    const {functionName, args} = decodeSafely(ERC20_ABI, data);
    if (functionName === 'approve' && spenderOk(args[0])) return true;
    throw new SignerGuardError(`USDG call ${functionName} is not permitted (only approve->router/curve/Permit2)`);
  }

  if (allowedStockTokens.some(a => eq(a, to))) {
    const {functionName, args} = decodeSafely(ERC20_ABI, data);
    // Stock tokens may be approved to the router (so they can be sold).
    // That's a legitimate sale of a stock token, not of $ZZY.
    if (functionName === 'approve' && spenderOk(args[0])) return true;
    throw new SignerGuardError(`stock token call ${functionName} is not permitted (only approve->router/curve/Permit2)`);
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

  if (v2 && eq(to, v2Escrow)) {
    // Withdraw what the escrow owes us. Two functions exist and nothing else.
    const {functionName, args} = decodeSafely(V2_ESCROW_ABI, data);
    if (functionName === 'claim') return true;
    if (functionName === 'claimToken') { if (eq(args[0], zzyTokenAddress)) throw new SignerGuardError('claimToken($ZZY) would withdraw a vested buyback as $ZZY into a path that could sell it; refused'); return true; }
    throw new SignerGuardError(`escrow call ${functionName} is not permitted (only claim/claimToken)`);
  }

  if (v2Curve && eq(to, v2Curve)) {
    // The bonding curve. buy() is the buyback; sell() is a sale of $ZZY.
    const {functionName, args} = decodeSafely(V2_CURVE_ABI, data);
    if (functionName === 'sell') throw new SignerGuardError('curve.sell is a sale of $ZZY -- never signed');
    if (functionName !== 'buy') throw new SignerGuardError(`curve call ${functionName} is not permitted (only buy)`);
    const [quoteIn, minTokensOut, recipient] = args;
    if (!ctx.recipient || !eq(recipient, ctx.recipient)) throw new SignerGuardError('curve buy recipient is not the operator wallet');
    if (BigInt(quoteIn) <= 0n) throw new SignerGuardError('curve buy with quoteIn of 0');
    if (BigInt(minTokensOut) <= 0n) throw new SignerGuardError('curve buy with minTokensOut of 0 -- unbounded price is never signed');
    if (v2PairIsErc20 ? value !== 0n : value !== BigInt(quoteIn)) throw new SignerGuardError('curve buy value does not match the launch quote asset (native pays value == quoteIn, ERC-20 pays 0)');
    return true;
  }

  if (eq(to, UNISWAP_V4.PERMIT2)) {
    const {functionName, args} = decodeSafely(PERMIT2_ABI, data);
    if (functionName !== 'approve') throw new SignerGuardError(`Permit2 call ${functionName} is not permitted (only approve)`);
    const [token, spender] = args;
    if (eq(token, zzyTokenAddress)) throw new SignerGuardError('Permit2 approve of $ZZY -- refused');
    if (!eq(spender, UNISWAP_V4.UNIVERSAL_ROUTER)) throw new SignerGuardError('Permit2 approve to a spender other than the Universal Router');
    return true;
  }

  if (eq(to, UNISWAP_V4.UNIVERSAL_ROUTER)) {
    // One V4_SWAP command whose actions are exactly [SWAP_EXACT_IN_SINGLE,
    // SETTLE_ALL, TAKE_ALL], with a minimum set, and the swap on one of the
    // permitted legs: pair -> $ZZY on the Pons hook pool (the buyback), or
    // USDG -> stock / stock -> USDG on a hookless pool (the book). Anything
    // else in the calldata is refused.
    const {functionName, args} = decodeSafely(UNIVERSAL_ROUTER_ABI, data);
    if (functionName !== 'execute') throw new SignerGuardError(`universal router call ${functionName} is not permitted`);
    const [commands, inputs] = args;
    const cmdBytes = commands.slice(2);
    if (cmdBytes.length !== 2 || parseInt(cmdBytes, 16) !== UR_COMMAND_V4_SWAP) throw new SignerGuardError('universal router: only a single V4_SWAP command is permitted');
    if (inputs.length !== 1) throw new SignerGuardError('universal router: expected exactly one input');
    let actions, params;
    try { [actions, params] = decodeAbiParameters([{type: 'bytes'}, {type: 'bytes[]'}], inputs[0]); }
    catch { throw new SignerGuardError('universal router: v4 input does not decode'); }
    const want = [V4_ACTION.SWAP_EXACT_IN_SINGLE, V4_ACTION.SETTLE_ALL, V4_ACTION.TAKE_ALL].map(b => b.toString(16).padStart(2, '0')).join('');
    if (actions.slice(2).toLowerCase() !== want || params.length !== 3) throw new SignerGuardError('universal router: actions must be exactly [SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL]');
    let swap;
    try {
      [swap] = decodeAbiParameters(RH_V4_SWAP_EXACT_IN_SINGLE, params[0]);
    } catch { throw new SignerGuardError('universal router: swap params do not decode'); }
    const tokenIn = swap.zeroForOne ? swap.poolKey.currency0 : swap.poolKey.currency1;
    const tokenOut = swap.zeroForOne ? swap.poolKey.currency1 : swap.poolKey.currency0;
    if (eq(tokenIn, zzyTokenAddress)) throw new SignerGuardError('v4 swap has $ZZY as the input -- that is a sale');
    const isStock = (a) => allowedStockTokens.some(x => eq(x, a));
    const buyback = eq(tokenOut, zzyTokenAddress);
    const bookLeg = (eq(tokenIn, ADDRESSES.USDG) && isStock(tokenOut)) || (isStock(tokenIn) && eq(tokenOut, ADDRESSES.USDG));
    if (!buyback && !bookLeg) throw new SignerGuardError('v4 swap is not a permitted leg: pair -> $ZZY, USDG -> stock, or stock -> USDG');
    if (buyback && !v2) throw new SignerGuardError('v4 buyback of $ZZY before the V2 launch is resolved -- refused');
    if (buyback && !eq(swap.poolKey.hooks, PONS_V2.MEME_HOOK)) throw new SignerGuardError('v4 swap is not on the Pons hook pool');
    const hookAllowed = eq(swap.poolKey.hooks, zeroAddress) || (ctx.allowedHooks ?? []).some(h => eq(h, swap.poolKey.hooks));
    if (bookLeg && !hookAllowed) throw new SignerGuardError(`v4 stock swap on hook ${swap.poolKey.hooks} is not permitted (add it to uniswap.v4.allowedHooks after verifying it)`);
    if (BigInt(swap.amountIn) <= 0n) throw new SignerGuardError('v4 swap with amountIn of 0');
    if (BigInt(swap.amountOutMinimum) <= 0n) throw new SignerGuardError('v4 swap with amountOutMinimum of 0 -- unbounded slippage is never signed');
    let takeCurrency;
    try { [takeCurrency] = decodeAbiParameters([{type: 'address'}, {type: 'uint256'}], params[2]); } catch { throw new SignerGuardError('universal router: TAKE_ALL params do not decode'); }
    if (!eq(takeCurrency, tokenOut)) throw new SignerGuardError('v4 TAKE_ALL currency is not the swap output');
    const nativeIn = eq(tokenIn, zeroAddress);
    if (nativeIn ? value !== BigInt(swap.amountIn) : value !== 0n) throw new SignerGuardError('v4 swap value does not match the input currency');
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
    allowedHooks: config.uniswap?.v4?.allowedHooks ?? [],
    ponsLocker: config.pons?.locker ?? ADDRESSES.PONS_LOCKER,
    ponsClaimSelector: ponsClaimSelector(config),
    recipient: account.address,
  };

  return {
    account, address: account.address, live: true,
    // The signer learns the launch's own curve and quote asset from the V2
    // factory itself, not from the caller. Until this has run, every V2
    // destination is refused. A V1 token leaves ctx.ponsV2 unset.
    async resolvePonsV2(client) {
      if (!ctx.zzyTokenAddress) return null;
      try {
        const launch = await readLaunch(client, ctx.zzyTokenAddress, config.pons?.v2?.factory);
        if (!launch) { ctx.ponsV2 = null; return null; }
        ctx.ponsV2 = {curve: launch.curve, pairToken: launch.native ? zeroAddress : launch.pairToken, escrow: config.pons?.v2?.escrow ?? PONS_V2.FEE_ESCROW, phase: launch.phase};
        return ctx.ponsV2;
      } catch { ctx.ponsV2 = null; return null; }
    },
    async send(tx) {
      guard(tx, ctx); // throws before anything is signed
      return wallet.sendTransaction({to: tx.to, data: tx.data, value: tx.value ?? 0n});
    },
  };
}
