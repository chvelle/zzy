import {createPublicClient, http, parseAbi} from 'viem';

// Every address here is from an official doc, cited inline. Nothing is guessed.
// If you change one, cite where the new value came from.

export const ROBINHOOD_CHAIN = {
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
  rpcUrls: {default: {http: ['https://rpc.mainnet.chain.robinhood.com']}},
  blockExplorers: {default: {name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com'}},
};

// Public testnet (docs.robinhood.com/chain/connecting). Same stack, fake ETH.
// Stock Tokens and pons are mainnet products, so the testnet is for proving
// the signing pipeline, not the strategy.
export const ROBINHOOD_TESTNET = {
  id: 46630,
  name: 'Robinhood Chain Testnet',
  nativeCurrency: {name: 'Test Ether', symbol: 'ETH', decimals: 18},
  rpcUrls: {default: {http: ['https://rpc.testnet.chain.robinhood.com']}},
  blockExplorers: {default: {name: 'Explorer', url: 'https://explorer.testnet.chain.robinhood.com'}},
  faucet: 'https://faucet.testnet.chain.robinhood.com',
};

// docs.robinhood.com/chain/contracts + docs.ponsfamily.com (Contracts section)
export const ADDRESSES = {
  WETH: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
  USDG: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  // Uniswap V3 on Robinhood Chain, as listed by pons docs
  UNISWAP_V3_FACTORY: '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA',
  UNISWAP_SWAP_ROUTER: '0xCaf681a66D020601342297493863E78C959E5cb2',
  UNISWAP_QUOTER_V2: '0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7',
  UNISWAP_POSITION_MANAGER: '0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3',
  // pons v1 (tokens launch straight into a Uniswap V3 WETH pool)
  PONS_FACTORY: '0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB',
  PONS_LOCKER: '0x736D76699C26D0d966744cAe304C000d471f7F35',
};

// Official read-only Stock Token REST API (docs.robinhood.com/chain/stock-token-apis)
export const RHJ_API = 'https://api.robinhood.com/rhj';

export const PONS_POOL_FEE = 10000; // 1%, per pons docs

// Standard, public ABIs. ERC-20 and Uniswap fragments are the canonical
// interfaces; the pons fragments are copied verbatim from docs.ponsfamily.com.
export const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  'function increaseAllowance(address spender, uint256 addedValue) returns (bool)',
  'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
]);

export const WETH_ABI = parseAbi([
  'function deposit() payable',
  'function withdraw(uint256 wad)',
]);

// pons launch token (self-describing, per docs)
export const PONS_TOKEN_ABI = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function liquidityPool() view returns (address)',
  'function deployer() view returns (address)',
]);

export const PONS_FACTORY_ABI = parseAbi([
  'function locker() view returns (address)',
  'function graduationStatus(address token) view returns (uint256 pairedPrincipal, uint256 threshold, bool graduated)',
  'function getLaunchedToken(address token) view returns ((address token, address deployer, address pairedToken, address positionManager, uint256 positionId, uint256 dexId, uint256 launchConfigId, uint256 restrictionsEndBlock, uint256 supply, bool isToken0, uint24 poolFee, bool exists, uint256 initialBuyAmount) launched)',
]);

export const PONS_LOCKER_READ_ABI = parseAbi([
  'function tokenProtocolFeeShares(address token) view returns (uint256)',
  'function feeRedirects(address token) view returns (address)',
  'function protocolFeeRecipient() view returns (address)',
]);

// Uniswap V3 pool price
export const UNI_POOL_ABI = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
]);

// QuoterV2 (standard)
export const QUOTER_V2_ABI = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);

// The two standard router ABIs. Which one is deployed at
// ADDRESSES.UNISWAP_SWAP_ROUTER is NOT stated in the pons docs -- check the
// verified source on Blockscout and set config.uniswap.routerVariant. The
// signer refuses to sign a swap until that is set.
export const SWAP_ROUTER_ABI = {
  // SwapRouter (original): exactInputSingle has a deadline field
  SwapRouter: parseAbi([
    'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
  ]),
  // SwapRouter02: no deadline field
  SwapRouter02: parseAbi([
    'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
  ]),
};

// Chainlink AggregatorV3 (standard) -- Stock Tokens publish per-asset feeds
export const CHAINLINK_ABI = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
]);

export function publicClient(rpcUrl) {
  return createPublicClient({
    chain: {...ROBINHOOD_CHAIN, rpcUrls: {default: {http: [rpcUrl ?? ROBINHOOD_CHAIN.rpcUrls.default.http[0]]}}},
    transport: http(),
  });
}
