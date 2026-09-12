#!/usr/bin/env node
import {resolve} from 'node:path';
import {formatEther} from 'viem';
import {assertExecutionMode} from './policy.mjs';
import {loadCatalog,catalogProblems,listSymbols,refreshCatalog} from './catalog.mjs';
import {planFeeClaim,readLedger,zzyHeldForever} from './treasury.mjs';
import {deployable} from './profit.mjs';
import {loadPositions,valuePositions} from './positions.mjs';
import {writeSiteData} from './site-data.mjs';
import {seedPaperCapital, paperConfig, paperState} from './paper.mjs';
import {preflight} from './preflight.mjs';
import {Runner} from './runner.mjs';
import {createOperatorWallet, operatorAddress, loadEnv, envPermissionsOk} from './wallet.mjs';
import {smokeTest} from './smoke.mjs';
import {assertLocalFork, fundOnFork, wrapOnFork, cashOnFork, forkStatus, seedForkBook, FORK_RPC} from './fork.mjs';
import {ROBINHOOD_TESTNET} from './chain.mjs';
import {listenControl} from './control-server.mjs';
import {listen as serveSite} from './site-server.mjs';
import {readJson} from './storage.mjs';
import {publicClient} from './chain.mjs';
import {createGuardedSigner} from './adapters/signer.mjs';
import {fetchQuote} from './adapters/robinhood-rhj.mjs';
import {readTokenInfo,graduation,readClaimableWeth,wethBalance} from './adapters/pons.mjs';
import {treasuryTick} from './loop.mjs';
import {verify} from './verify.mjs';
import {composePost, postTweet, scanPost, dailyEvent, loadSocialLog, socialConfig, xCredentials} from './social.mjs';
import {buildSiteData} from './site-data.mjs';
await loadEnv();
// Unattended operation. An unhandled rejection anywhere must not take the
// process down; it gets logged and the next tick runs. Fatal conditions (a
// missing key in live mode, a wrong chain) are still thrown deliberately at
// startup, before any loop begins.
process.on('unhandledRejection',(e)=>console.error(`[${new Date().toISOString()}] unhandled rejection: ${e?.stack??e}`));
process.on('uncaughtException',(e)=>console.error(`[${new Date().toISOString()}] uncaught exception: ${e?.stack??e}`));
let config=await readJson(resolve('config/default.json'));const mode=assertExecutionMode(config);
const [command,...args]=process.argv.slice(2);
const arg=(flag)=>{const i=args.indexOf(flag);return i===-1?null:args[i+1]??null;};
const fail=(m)=>{console.error(`Refused: ${m}`);process.exitCode=1;};

// ETH/USD: the pons interface uses DeFiLlama; you can swap this for Chainlink.
if(command==='buy'){
  // Operator-directed live buy through the normal path. Posts to X like any buy.
  const sym=(args[0]||'').toUpperCase(); const usd=Number(args[1]);
  if(!sym||!(usd>0)){fail('usage: npm run buy -- SYMBOL USD [--max-premium N] [--note "why"]');process.exit(1);}
  const {operatorBuy}=await import('./engine.mjs');
  const {createGuardedSigner}=await import('./adapters/signer.mjs');
  const {loadCatalog}=await import('./catalog.mjs');
  const {socialAfterTick}=await import('./social.mjs');
  const {readLedger}=await import('./treasury.mjs');
  const client=publicClient(config.chain?.rpcUrl);
  const signer=createGuardedSigner(config,process.env);
  const catalog=await loadCatalog(config);
  const mp=arg('--max-premium'); const note=arg('--note')??'operator-directed buy';
  const r=await operatorBuy({client,signer,config,catalog,symbol:sym,usd,note,maxPremiumPercent:mp!=null?Number(mp):null,log:console.log});
  console.log(JSON.stringify(r,null,2));
  await writeSiteData(config,{wallet:signer.address});
  try{
    const out={trading:{buys:[{symbol:r.symbol,usd:r.usd,qty:r.qty,hash:r.hash,venue:r.venue,rationale:note}],exits:[]},treasury:{}};
    const site=(await writeSiteData(config,{wallet:signer.address})).data;
    const sr=await socialAfterTick({out,site,config,env:process.env,log:console.log,ledger:await readLedger(config).catch(()=>null),tradesCount:site?.activity?.ordersExecuted??0});
    console.log('social:',JSON.stringify(sr));
  }catch(e){console.log('social skipped:',e.message);}
}else if(command==='release:check'){
  const {releaseCheck}=await import('./release-check.mjs');
  const r=await releaseCheck();
  if(r.clean){console.log('clean: nothing personal or secret in the tree');}
  else{console.log(`NOT CLEAN: ${r.findings.length} finding(s)`);for(const f of r.findings)console.log(`  ${f.file}: ${f.kind}${f.sample?' ('+f.sample+')':''}${f.hint?' -- '+f.hint:''}`);process.exit(1);}
}else if(command==='site:push'){
  // One push by hand: exports, sends both files to the blob, writes feed.json.
  const {pushSite,writeFeedFile,_resetPushState}=await import('./site-push.mjs');
  await writeSiteData(config,{wallet:await operatorAddress()});
  _resetPushState();
  const r=await pushSite({config,log:console.log});
  if(r.skipped)throw new Error(`push skipped: ${r.skipped}`);
  if(!r.urls)throw new Error('nothing pushed');
  await writeFeedFile({urls:r.urls});
  console.log(`pushed ${r.pushed.join(', ')}\nlive feed: ${r.urls.data}\nfeed.json written. Deploy the site folder once: npm run site:deploy`);
}else if(command==='fund'){
  // Records operator-funded principal. Send USDG to the operator wallet
  // first; this checks it is there, then tells the ledger the book may
  // deploy it. Nothing is signed.
  const usd=Number(arg('--usd'));
  if(!(usd>0)){fail('usage: npm run fund -- --usd 500   (after sending that much USDG to the operator wallet)');process.exit(1);}
  const addr=await operatorAddress(); if(!addr){fail('no operator wallet in .env');process.exit(1);}
  const {cashBalance}=await import('./cash.mjs');
  const {recordDeposit}=await import('./treasury.mjs');
  const client=publicClient(config.chain?.rpcUrl);
  const bal=await cashBalance(client,addr);
  console.log(`wallet ${addr} holds $${bal.usd.toFixed(2)} USDG`);
  const ledger=await recordDeposit({amountUsd:usd,walletUsd:bal.usd,note:'operator deposit via npm run fund'},config);
  const {deployable}=await import('./profit.mjs');
  const d=deployable(ledger,config);
  console.log(`recorded a $${usd.toFixed(2)} deposit; the book may now deploy $${d.deployableUsd.toFixed(2)} (cap $${config.policy?.maxTotalExposureUsd})`);
}else if(command==='social:preview'){
  // Composes the daily post from the current book and prints it. Nothing is sent.
  const site = await buildSiteData(config);
  const text = await composePost(dailyEvent(site), config);
  const bad = scanPost(text, socialConfig(config));
  console.log(bad ? `REFUSED (${bad}):\n${text}` : `WOULD POST (${text.length} chars):\n${text}`);
}else if(command==='social:hello'){
  // The first real post. Requires social.enabled true and X keys in .env.
  if (!socialConfig(config).enabled) throw new Error('social.enabled is false in config; this command only runs when posting is on');
  if (!xCredentials()) throw new Error('X credentials missing from .env');
  const site = await buildSiteData(config);
  const text = await composePost({kind: 'hello', bookUsd: site.portfolio.markToMarketUsd, universe: site.universe.tracked, chain: 4663, at: new Date().toISOString(), note: 'first post; introduce yourself in your own words, briefly, and say who created you'}, config);
  const bad = scanPost(text, socialConfig(config)); if (bad) throw new Error(`refused: ${bad}: ${text}`);
  console.log(`posting: ${text}`);
  const r = await postTweet(text);
  console.log(`posted ${r.id ? 'https://x.com/' + socialConfig(config).handle + '/status/' + r.id : '(no id returned)'}`);
}else if(command==='social:log'){
  const l = await loadSocialLog(config);
  for (const p of (l.posts ?? []).slice(-20)) console.log(`${p.at}  ${p.dryRun ? '[dry-run] ' : ''}${p.kind.padEnd(7)}  ${p.text}`);
  if (!(l.posts ?? []).length) console.log('nothing posted yet');
}else if(command==='verify'){
  console.log(await verify({write:args.includes('--write')}));
}else if(command==='catalog'){
  if(args[0]==='refresh'){const r=await refreshCatalog(config);console.log(JSON.stringify({...r,source:'https://api.robinhood.com/rhj/assets'},null,2));}
  else{const catalog=await loadCatalog(config);const problems=catalogProblems(catalog,config);
    console.log(JSON.stringify({usable:problems.length===0,problems,symbolCount:listSymbols(catalog).length,source:catalog?.source??null,fetchedAt:catalog?.fetchedAt??null},null,2));
    if(problems.length)console.log('\nRun: npm run catalog:refresh  (pulls the live list from Robinhood\'s official API)');}
}else if(command==='site'&&args[0]==='serve'){
  await writeSiteData(config);
  serveSite(config);
}else if(command==='site'){
  const {file,data}=await writeSiteData(config);
  console.log(JSON.stringify({file,mode:data.agent.mode,tracked:data.universe.tracked,zzyBoughtUsd:data.treasury.zzyBoughtUsd,decisions:data.activity.decisionsLogged,orders:data.activity.ordersExecuted},null,2));
  console.log('\nServe it:  npx serve site   (or open site/index.html)');
}else if(command==='quote'){
  const sym=args[0];if(!sym)throw new Error('Usage: quote <SYMBOL>');console.log(JSON.stringify(await fetchQuote(sym),null,2));
}else if(command==='zzy'){
  const zzy=config.treasury?.zzyTokenAddress;if(!zzy){fail('treasury.zzyTokenAddress not set');process.exit(1);}
  const client=publicClient(config.chain?.rpcUrl);
  const {ponsVersion}=await import('./loop.mjs');
  const version=await ponsVersion(client,config);
  if(version==='v2'){
    const {readLaunch,escrowOwed,unsweptFees,fmt,poolId,PONS_V2}=await import('./adapters/pons-v2.mjs');
    const {zeroAddress,formatUnits}=await import('viem');
    const launch=await readLaunch(client,zzy,config.pons?.v2?.factory);
    const wallet=(await operatorAddress())??config.runtime?.watchAddress??launch.creatorFeeRecipient;
    const {ERC20_ABI}=await import('./chain.mjs');
    let pairSymbol='ETH',dec=18;
    if(!launch.native){try{[pairSymbol,dec]=await Promise.all([client.readContract({address:launch.pairToken,abi:ERC20_ABI,functionName:'symbol'}),client.readContract({address:launch.pairToken,abi:ERC20_ABI,functionName:'decimals'}).then(Number)]);}catch{pairSymbol=launch.pairToken;}}
    const owed=await escrowOwed(client,wallet,launch.native?zeroAddress:launch.pairToken,config.pons?.v2?.escrow);
    const unswept=await unsweptFees(client,launch).catch(e=>({error:e.message.split('\n')[0]}));
    const out={
      pons:'v2',token:zzy,curve:launch.curve,phase:launch.phaseName,
      quoteAsset:launch.native?'ETH (native)':`${pairSymbol} ${launch.pairToken}`,
      creatorFeeRecipient:launch.creatorFeeRecipient,
      payoutGoesToThisWallet:wallet.toLowerCase()===launch.creatorFeeRecipient.toLowerCase(),
      creatorTaxBps:launch.creatorTaxBps,ponsBuybackEnabled:launch.buybackEnabled,
      escrowOwed:`${fmt(owed,dec)} ${pairSymbol}`,
      unswept:unswept.error?unswept:{where:unswept.where,amount:`${fmt(unswept.quoteFee+unswept.creatorTax,dec)} ${pairSymbol}`},
      v4PoolId:launch.phase===2?poolId(launch):null,
      claimThresholdUsd:config.pons?.claimThresholdUsd??20,
    };
    console.log(JSON.stringify(out,null,2));
    if(!out.payoutGoesToThisWallet)console.log(`\nWARNING: creator fees are paid to ${launch.creatorFeeRecipient}, not the operator wallet ${wallet}. The bot cannot claim them. Either run the bot from that wallet, or call transferCreatorFeeRecipient on the Pons factory from that wallet to point fees at ${wallet}.`);
    if(launch.buybackEnabled)console.log('\nNote: Pons-side buybacks are on for this launch. Part of the creator share is spent by Pons on its own buyback and vested over five years; that is separate from, and in addition to, the half ZZY buys and holds itself.');
    process.exit(0);
  }
  const [info,grad]=await Promise.all([readTokenInfo(client,zzy,config.pons?.factory),graduation(client,zzy,config.pons?.factory)]);
  const claimable=await readClaimableWeth(client,zzy,config).catch(e=>`error: ${e.message}`);
  const watch=config.runtime?.watchAddress??info.creatorPayout;const weth=await wethBalance(client,watch);
  console.log(JSON.stringify({...info,graduation:grad,claimableWeth:claimable,claimThresholdEth:config.pons?.claimThresholdEth,payoutWalletWeth:weth.eth},null,2));
}else if(command==='treasury'){
  if(args[0]==='plan'){try{console.log(JSON.stringify(planFeeClaim(Number(arg('--claim-usd')),config),null,2));}catch(e){fail(e.message);}}
  else{const ledger=await readLedger(config);const pos=await loadPositions(config);
    console.log(JSON.stringify({mode,book:deployable(ledger,config),zzy:zzyHeldForever(ledger),positions:valuePositions(pos,{}).rows.map(r=>({symbol:r.symbol,qty:r.qty,costBasisUsd:r.costBasisUsd,openedAt:r.openedAt})),wethBaselineEth:ledger.wethBaselineEth??0,entries:ledger.entries.length},null,2));}
}else if(command==='wallet'){
  if(args[0]==='new'){
    try{const {address,file}=await createOperatorWallet();
      console.log(JSON.stringify({address,savedTo:file,permissions:'owner only'},null,2));
      console.log(`\nThat is your operator wallet. The key is in ${file} and was never printed.\nBack that file up somewhere offline now. If it is lost, everything the wallet holds is lost with it.\n\nTest ETH:  ${ROBINHOOD_TESTNET.faucet}`);
    }catch(e){fail(e.message);}
  }else{
    const address=await operatorAddress();const perms=await envPermissionsOk();
    if(!address)console.log('No operator wallet yet. Run:  npm run wallet:new\nOr paste an existing key into .env as ZZY_OPERATOR_PRIVATE_KEY=0x...');
    else console.log(JSON.stringify({address,envPermissionsOk:perms,note:perms===false?'.env is readable by other users on this machine. Run: chmod 600 .env':undefined},null,2));
  }
}else if(command==='smoke'){
  try{
    const r=await smokeTest({privateKey:process.env.ZZY_OPERATOR_PRIVATE_KEY,log:m=>console.log('  '+m)});
    console.log(`\n${r.ok?'PASS':'FAIL'}: the key signs, the RPC broadcasts, the chain mines it.\n${r.explorer}`);
    if(!r.ok)process.exitCode=1;
  }catch(e){fail(e.message);}
}else if(command==='preflight'){
  const client=publicClient(config.chain?.rpcUrl);
  const account=arg('--address')??config.runtime?.watchAddress??null;
  console.log(account?`Simulating from ${account}\n`:'No wallet given, running the checks that do not need one.\nAdd --address 0x... (or set runtime.watchAddress) to simulate the actual transactions.\n');
  let report;
  try{report=await preflight(client,config,{account});}
  catch(e){console.error(`Preflight could not run: ${e.message.split('\n')[0]}`);process.exit(1);}
  for(const c of report.checks){
    const mark=c.skipped?'--':c.ok?'ok':'XX';
    console.log(`  [${mark}] ${c.name.padEnd(26)} ${c.detail}`);
  }
  console.log(`\n${report.passed} passed, ${report.failed} failed.`);
  if(report.ready&&account)console.log('Every transaction simulated clean against live chain state. It will go through.');
  else if(report.ready)console.log('Plumbing is good. Re-run with --address once the wallet is funded to simulate the transactions themselves.');
  else{console.log('Fix the failures above before going live. Nothing was broadcast.');process.exitCode=1;}
}else if(command==='fork'){
  const rpc=arg('--rpc')??FORK_RPC;
  const sub=args[0];
  const addr=await operatorAddress();
  if(sub==='setup'){
    if(!addr){fail('no operator wallet. Run: npm run wallet:new');process.exit(1);}
    try{
      const info=await assertLocalFork(rpc);
      console.log(`fork of ${info.forkedFrom} at block ${info.blockNumber}, chain ${info.chainId}`);
      const funded=await fundOnFork(rpc,addr,arg('--eth')??'10');
      console.log(`funded ${funded.address} with ${funded.balanceEth} fake ETH`);
      const wethAmount=arg('--weth')??'2';
      const wrapped=await wrapOnFork(rpc,process.env.ZZY_OPERATOR_PRIVATE_KEY,wethAmount);
      console.log(`wrapped into ${wrapped.wethEth} WETH`);
      // The book trades in USDG. Convert most of the WETH through the real
      // pool on the fork, and seed the ledger with what actually arrived.
      const cashEth=arg('--cash-eth')??String(Number(wethAmount)*0.75);
      const variant=config.uniswap?.routerVariant??'SwapRouter02';
      const cashed=await cashOnFork(rpc,process.env.ZZY_OPERATOR_PRIVATE_KEY,cashEth,variant);
      console.log(`swapped ${cashEth} WETH -> ${cashed.usdg.toFixed(2)} USDG on the fork (fee tier ${cashed.fee}, ${cashed.hash})`);
      const {file}=await seedForkBook(config,{tradingUsd:cashed.usdg,rpcUrl:rpc});
      console.log(`book seeded with $${cashed.usdg.toFixed(2)} of trading capital in ${file}`);
      console.log('\nNow run:  npm run control:fork');
    }catch(e){fail(e.message);process.exit(1);}
  }else{
    try{console.log(JSON.stringify(await forkStatus(rpc,addr),null,2));}
    catch(e){fail(e.message);process.exit(1);}
  }
}else if(command==='fork:buy'||command==='fork:sell'){
  const runner=new Runner({fork:true,forkRpc:arg('--rpc')??FORK_RPC});
  runner.onLog=(l)=>console.log(`[${l.at}] ${l.msg}`);
  try{
    await runner.start();
    const sym=(args[0]||'').toUpperCase();if(!sym){fail('usage: fork:buy SYMBOL [usd]  |  fork:sell SYMBOL');process.exit(1);}
    const r=command==='fork:buy'?await runner.forceBuy(sym,Number(args[1]||20)):await runner.forceSell(sym,1);
    console.log(JSON.stringify(r,null,2));
  }catch(e){fail(e.message);process.exit(1);}
}else if(command==='paper'){
  const sub=args[0];
  if(sub==='reset'){
    const amount=Number(arg('--capital')??500);
    const {file,tradingUsd}=await seedPaperCapital(config,amount);
    console.log(JSON.stringify({file,tradingCapitalUsd:tradingUsd,note:'simulated, never shown on the site'},null,2));
  }else{
    const st=await paperState(config);
    console.log(JSON.stringify(st,null,2));
    if(!st.entries)console.log('\nNo paper capital yet. Run:  npm run paper:reset');
  }
}else if(command==='tick'||command==='run'||command==='control'){
  const paper=args.includes('--paper');
  const fork=args.includes('--fork');
  if(paper&&fork){fail('pick one: --paper or --fork');process.exit(1);}
  const runner=new Runner({paper,fork,forkRpc:arg('--rpc')??FORK_RPC});
  runner.onLog=(l)=>console.log(`[${l.at}] ${l.msg}`);
  // The panel opens even when the runner cannot start yet (no paper capital,
  // say) so you can fix that from the panel. tick/run still need it up front.
  try{await runner.start();}
  catch(e){if(command!=='control'){fail(e.message);process.exit(1);}runner.log(`not started: ${e.message}`);}
  if(paper)console.log('PAPER MODE: simulated capital, preview only, nothing written to the real ledger or the site.');
  if(fork)console.log('FORK MODE: real contracts, fake money. Transactions are signed and executed on your machine only.');
  if(command==='tick'){await runner.tick();}
  else if(command==='run'){console.log(`ZZY running in ${runner.mode} mode, every ${runner.snapshot().intervalSeconds}s. Ctrl-C to stop.`);await runner.resume();}
  else{
    // control panel: loop starts PAUSED. You press Start in the panel.
    listenControl({runner,port:config.control?.port??4664});
    console.log(`Loop is paused. Press Start in the panel, or use "Run one tick" to step it.`);
  }
}else console.log(`ZZY (${mode}) commands:
  catalog [refresh]          check / refresh Stock Token catalog from Robinhood's official API
  site                       export site/data.json for the public dashboard
  site serve                 export + serve site/ read-only on 127.0.0.1:4663
  quote <SYMBOL>             live bid/ask from api.robinhood.com/rhj/prices
  zzy                        $ZZY on-chain state: pool, fee split, graduation, claimable, payout wallet WETH
  treasury [plan --claim-usd n]
  wallet [new]               show the operator address, or generate a fresh key into .env
  smoke                      testnet only: sign and mine one real transaction to prove the pipeline
  preflight [--address 0x..] simulate every transaction against live chain state
  fork [setup]               check the local mainnet fork, or fund the wallet on it
  fork:buy SYMBOL [usd]      fork only: force a real swap through the buy path
  fork:sell SYMBOL           fork only: close a position through the exit path
  (in the panel, fork mode)  queue a Claude verdict or exit verdict for the next cycle
  paper                      show simulated capital
  paper reset --capital <n>  give the agent simulated money to practise with
  tick [--paper]             one cycle (preview logs what it would do)
  run                        loop tick forever
  control [--paper|--fork]   open the local control panel (loop starts paused)
`);
