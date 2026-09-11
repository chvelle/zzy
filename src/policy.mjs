export function finite(value,name){if(typeof value!=='number'||!Number.isFinite(value)||value<0)throw new Error(`${name} must be a finite non-negative number`);}

import {catalogProblems,isSupported} from './catalog.mjs';

export function evaluateSnapshot(snapshot,config,now=new Date(),catalog=null){
  if(!snapshot||typeof snapshot!=='object')throw new Error('snapshot is required');
  if(!snapshot.source)throw new Error('source is required');
  if(!snapshot.asset?.symbol)throw new Error('asset symbol is required');
  if(!snapshot.asset?.assetClass)throw new Error('asset assetClass is required');
  const observed=new Date(snapshot.observedAt);if(Number.isNaN(observed.getTime()))throw new Error('observedAt must be an ISO timestamp');
  const ageSeconds=Math.max(0,(now-observed)/1000),m=snapshot.market||{},a=snapshot.account||{};
  for(const [key,value] of Object.entries({priceUsd:m.priceUsd,pricePreviewUsd:m.pricePreviewUsd,volume24hUsd:m.volume24hUsd,buyingPowerUsd:a.buyingPowerUsd,currentExposureUsd:a.currentExposureUsd,openOrders:a.openOrders}))finite(value,key);
  const scope=config.assetScope||{},assetClass=snapshot.asset.assetClass;
  const failures=[];
  // Asset-class boundary comes first and short-circuits nothing else: a
  // blocked or non-allow-listed asset class (e.g. a memecoin) is rejected
  // regardless of price, confidence, or any other signal.
  if((scope.blockedAssetClasses||[]).includes(assetClass))failures.push('asset-class-blocked');
  else if(scope.allowedAssetClasses&&!scope.allowedAssetClasses.includes(assetClass))failures.push('asset-class-not-permitted');
  // Catalog gate: the symbol must appear in a catalog that is present,
  // verified, and fresh. A placeholder/unverified catalog fails closed here,
  // which is why the shipped placeholder can never prepare an order.
  if(config.catalog?.requireVerified){
    const problems=catalogProblems(catalog,config,now);
    if(problems.length)failures.push(...problems);
    else if(!isSupported(catalog,snapshot.asset.symbol))failures.push('symbol-not-in-catalog');
  }
  if(ageSeconds>config.policy.maxSnapshotAgeSeconds)failures.push('snapshot-stale');
  // A null move means there is not enough price history to judge yet. That is
  // an unknown, not a zero, and must fail rather than sail through the gate.
  if(m.priceMove5mPercent==null)failures.push('price-history-unavailable');
  else if(!Number.isFinite(m.priceMove5mPercent))failures.push('price-move-malformed');
  else if(Math.abs(m.priceMove5mPercent)>config.policy.maxPriceMovePercent)failures.push('price-move-above-maximum');
  if(m.volatilityScore!=null&&!Number.isFinite(m.volatilityScore))failures.push('volatility-malformed');
  if(a.openOrders>=config.policy.maxOpenOrders)failures.push('open-order-limit-reached');
  if(a.currentExposureUsd>=config.policy.maxTotalExposureUsd)failures.push('exposure-limit-reached');
  return {accepted:failures.length===0,failures,ageSeconds};
}

export const LIVE_ACK='I_UNDERSTAND_THIS_SIGNS_TRANSACTIONS_WITH_REAL_FUNDS';
// Preview is the default and needs nothing. Live requires BOTH config.mode
// and an explicit env ack, so a stray config edit can never sign alone.
export function assertExecutionMode(config,env=process.env){
  if(config.mode==='preview')return 'preview';
  if(config.mode!=='live')throw new Error(`mode must be "preview" or "live", got ${config.mode}`);
  if(env.ZZY_LIVE_EXECUTION_ACK!==LIVE_ACK)throw new Error(`Live execution is disabled: set ZZY_LIVE_EXECUTION_ACK=${LIVE_ACK} to sign transactions`);
  return 'live';
}
// kept for callers/tests that only ever want preview
export function assertPreviewMode(config){if(config.mode!=='preview')throw new Error('Live order submission is structurally disabled in this scaffold');}
