/** Offline-only alternative execution model. No collectors, credentials or live adapters. */
import { dec, Ledger } from "../research/ledger";
import { frameTime } from "../research/patient";
import { midOf } from "../research/engine";
import { exitFee, transactionCost } from "../research/execution-costs";
import { FillQualityTracker } from "../research/fill-quality";
import { invariant, validateFrame, validateHeader } from "../research/validation";
import type { DatasetHeader, Frame } from "../research/types";
export const SWING_VERSION = "patient-swing-v1";
export const swingPolicy = Object.freeze({ barMs:300000, minSpreadBps:2, maxSpreadBps:100, horizonMs:7200000, sizeMon:"200", initialCashUsd:"100", maxPositionMon:"400", maxLossUsd:"1", maxDrawdownPct:1, maxTradeRiskUsd:"0.10", stopBps:"100", slippageBps:"10", feeFloorBps:"5", adverseBps:"5", uncertaintyBps:"2", minNetEdgeUsd:"0.0005", inferenceReserveUsd:"0.00002", maxAttemptsRolling24h:2, minimumTrainingSamples:20, trainingFraction:0.6 });
export interface Bar { end:number; close:string; buy:string; sell:string; trigger:Frame }
export class CandleClock {
 private bucket:number|null=null;private complete=false;private close="0";private buy=dec(0);private sell=dec(0);
 observe(f:Frame):Bar|null {
  const now=frameTime(f), bucket=Math.floor(now/swingPolicy.barMs)*swingPolicy.barMs;let result:Bar|null=null;
  if(this.bucket===null){this.bucket=bucket;this.complete=now===bucket;}
  else if(bucket!==this.bucket){
   invariant(bucket===this.bucket+swingPolicy.barMs,"missing five-minute clock coverage");
   if(this.complete)result={end:bucket,close:this.close,buy:this.buy.toString(),sell:this.sell.toString(),trigger:f};
   this.bucket=bucket;this.complete=true;this.buy=dec(0);this.sell=dec(0);
  }
  this.close=midOf(f);for(const t of f.trades){if(t.side==='buy')this.buy=this.buy.add(t.size);else this.sell=this.sell.add(t.size);}
  return result;
 }
}
export function swingSignal(bars:readonly Bar[]) {
 const last=bars.at(-1), prior=bars.at(-2), hour=bars.at(-13), pullback=bars.at(-5);
 if(!last||!prior||!hour||!pullback)return false;
 return dec(last.close).gt(hour.close)&&dec(prior.close).lt(pullback.close)&&dec(last.close).gt(prior.close)&&dec(last.buy).gt(last.sell)&&dec(last.buy).add(last.sell).gte("200");
}
export function walk(f:Frame,side:'buy'|'sell',depthFactor=1){
 let left=dec(swingPolicy.sizeMon),value=dec(0);
 for(const [px,q] of side==='buy'?f.asks:f.bids){const available=dec(q).mul(depthFactor), take=left.lt(available)?left:available;left=left.sub(take);value=value.add(take.mul(px));if(left.eq(0))break;}
 return {complete:left.eq(0),price:value.div(swingPolicy.sizeMon).toString(),notional:value.toString()};
}
export interface SwingModel { trainedThrough:number; samples:number; successfulNextBlockQuotes:number; qualified:boolean; meanMoveBps:string; lowerMoveBps:string; successLower:string; samplesDetail:{at:number;labelAt:number;moveBps:string;success:boolean}[] }
export function fitSwingModel(frames:readonly Frame[],cutoff:number,depthFactor=1):SwingModel {
 const clock=new CandleClock(),bars:Bar[]=[];
 for(const f of frames){if(frameTime(f)>=cutoff)break;const b=clock.observe(f);if(b)bars.push(b);}
 const byBlock=new Map(frames.filter(f=>frameTime(f)<cutoff).map(f=>[f.block,f]));
 return fitSwingBars(bars,byBlock,cutoff,depthFactor);
}
/** Same calibration on independently archived exact candles, never execution inputs. */
export function fitSwingBars(bars:readonly Bar[],byBlock:ReadonlyMap<number,Frame>,cutoff:number,depthFactor=1):SwingModel {
 const rows:SwingModel['samplesDetail']=[];let last=-Infinity;
 for(let i=12;i<bars.length;i++){
  const b=bars[i]!;if(frameTime(b.trigger)>=cutoff)continue;if(!swingSignal(bars.slice(0,i+1))||b.end-last<swingPolicy.horizonMs)continue;
  const future=bars.find(x=>x.end>=b.end+swingPolicy.horizonMs);
  // Purge labels that touch/cross evaluation. No unfinished label becomes zero.
  if(!future||frameTime(future.trigger)>=cutoff)continue;
  const spread=dec(b.trigger.asks[0]![0]).sub(b.trigger.bids[0]![0]).div(midOf(b.trigger)).mul(10000);if(spread.lt(2)||spread.gt(100))continue;
  const next=byBlock.get(b.trigger.block+1);if(!next||frameTime(next)>=cutoff)continue;
  const quote=walk(next,'buy',depthFactor),limit=dec(walk(b.trigger,'buy',depthFactor).price).mul(dec(1).add(dec(swingPolicy.slippageBps).div(10000)));
  const success=quote.complete&&dec(quote.price).lte(limit)&&!!next.marketCosts&&dec(next.marketCosts.minSizeMon).lte(swingPolicy.sizeMon);
  rows.push({at:b.end,labelAt:future.end,moveBps:dec(future.close).div(b.close).sub(1).mul(10000).toString(),success});last=b.end;
 }
 const n=rows.length, mean=n?rows.reduce((s,r)=>s.add(r.moveBps),dec(0)).div(n):dec(0);
 const variance=n>1?rows.reduce((s,r)=>s.add(dec(r.moveBps).sub(mean).pow(2)),dec(0)).div(n-1):dec(0);
 const qualified=n>=swingPolicy.minimumTrainingSamples;
 const lower=qualified?mean.sub(variance.div(n).sqrt().mul(2)):dec(0);
 const successes=rows.filter(x=>x.success).length;
 // Wilson lower score with z=2; an execution diagnostic, not a guaranteed probability.
 const rate=n?dec(successes).div(n):dec(0),z=dec(2);
 const successLower=qualified?rate.add(z.pow(2).div(2*n)).sub(z.mul(rate.mul(dec(1).sub(rate)).div(n).add(z.pow(2).div(4*n*n)).sqrt())).div(dec(1).add(z.pow(2).div(n))):dec(0);
 return {trainedThrough:cutoff,samples:n,successfulNextBlockQuotes:successes,qualified,meanMoveBps:mean.toString(),lowerMoveBps:lower.toString(),successLower:successLower.toString(),samplesDetail:rows};
}
export function swingGate(h:DatasetHeader,f:Frame,model:SwingModel,gas=1,depth=1){
 const buy=walk(f,'buy',depth),sell=walk(f,'sell',depth),mid=dec(midOf(f)),size=dec(swingPolicy.sizeMon);
 const upper=dec(buy.price).mul(dec(1).add(dec(swingPolicy.slippageBps).div(10000)));
 const lowerExit=mid.mul(dec(1).add(dec(model.lowerMoveBps).div(10000))).sub(mid.sub(sell.price)).mul(dec(1).sub(dec(swingPolicy.slippageBps).div(10000)));
 const fee=dec(f.marketCosts?.takerFeeBps??'0').gte(swingPolicy.feeFloorBps)?f.marketCosts!.takerFeeBps:swingPolicy.feeFloorBps;
 const fees=size.mul(upper.add(lowerExit.gt(0)?lowerExit:mid)).mul(fee).div(10000),gasReserve=transactionCost(h,f,gas).mul(3);
 const buffer=size.mul(mid).mul(dec(swingPolicy.adverseBps).add(swingPolicy.uncertaintyBps)).div(10000);
 const conditional=size.mul(lowerExit.sub(upper)).sub(fees);
 const expected=conditional.mul(model.successLower).sub(gasReserve).sub(buffer).sub(swingPolicy.inferenceReserveUsd);
 const tradeRisk=size.mul(upper).mul(swingPolicy.stopBps).div(10000).add(fees).add(gasReserve).add(buffer);
 const spread=dec(f.asks[0]![0]).sub(f.bids[0]![0]).div(mid).mul(10000);
 const reason=spread.lt(2)||spread.gt(100)?'spread_outside_original_limits':!model.qualified?'insufficient_training_evidence':dec(model.lowerMoveBps).lte(0)?'nonpositive_forecast':!buy.complete||!sell.complete?'insufficient_depth':!f.marketCosts||dec(f.marketCosts.minSizeMon).gt(size)?'minimum_size_unknown_or_too_large':tradeRisk.gt(swingPolicy.maxTradeRiskUsd)?'trade_risk_budget':expected.lt(swingPolicy.minNetEdgeUsd)?'net_edge_below_costs':'accepted';
 return {accepted:reason==='accepted',reason,entryPriceLimit:upper.toString(),expectedNetEdgeUsd:expected.toString(),gasReserveUsd:gasReserve.toString(),feesReserveUsd:fees.toString(),bufferUsd:buffer.toString(),plannedTradeRiskUsd:tradeRisk.toString(),successLower:model.successLower,lowerMoveBps:model.lowerMoveBps};
}
export class PatientSwing {
 ledger:Ledger|null=null;halted:string|null=null;readonly quality=new FillQualityTracker();
 private previous?:Frame;private clock=new CandleClock();private bars:Bar[]=[];private pending:{side:'buy'|'sell';block:number;limit:string|null;reason:string}|null=null;
 private entryAt:number|null=null;private entryPrice:string|null=null;private attemptsAt:number[]=[];private peak=dec(100);private drawdown=dec(0);private last?:Frame;private first?:Frame;
 private lastExitAttemptBlock:number|null=null;private cycleCash:string|null=null;private roundTrips:{netUsd:string;reason:string}[]=[];
 private counts:Record<string,number>={};private stats={entryAttempts:0,exitAttempts:0,rejected:0,fills:0};private gateRecent:ReturnType<typeof swingGate>[]=[];
 constructor(readonly header:DatasetHeader,readonly model:SwingModel,readonly start:number,readonly end:number,readonly gas=1,readonly depth=1){validateHeader(header);invariant(!header.inference&&!header.terminalInferenceLiability,"market-only inputs required");invariant(!model.qualified||model.samples>=swingPolicy.minimumTrainingSamples,"unsupported forecast qualification");invariant(dec(model.successLower).gte(0)&&dec(model.successLower).lte(1),"invalid success estimate");invariant(gas===1||gas===2,'fixed gas scenarios only');invariant(depth===1||depth===0.5,'fixed depth scenarios only');invariant(start>=model.trainedThrough&&end>start,'forecast overlaps evaluation');}
 step(f:Frame){
  validateFrame(f,this.previous);this.previous=f;
  const now=frameTime(f),bar=this.clock.observe(f);if(bar)this.bars.push(bar);
  if(now<this.start)return;
  invariant(now<=this.end,'evaluation exceeded fixed window');this.first??=f;this.last=f;
  this.ledger??=new Ledger('100','0',midOf(f));const l=this.ledger,tx=transactionCost(this.header,f,this.gas);
  if(this.pending&&f.block>=this.pending.block){
   const p=this.pending;this.pending=null;
   // Actual settlement follows the decision block; failure still pays full gas.
   l.gas(this.header.costs.gasLimit*this.gas,f.gasPriceWei??this.header.costs.gasPriceWei,midOf(f));
   const q=walk(f,p.side,this.depth),fee=dec(f.marketCosts?.takerFeeBps??'0').gte(swingPolicy.feeFloorBps)?f.marketCosts!.takerFeeBps:swingPolicy.feeFloorBps;
   const valid=q.complete&&!!f.marketCosts&&dec(f.marketCosts.minSizeMon).lte(swingPolicy.sizeMon)&&(p.limit===null||(p.side==='buy'?dec(q.price).lte(p.limit):dec(q.price).gte(p.limit)));
   if(!valid||(p.side==='buy'&&l.cash.lt(dec(q.notional).mul(dec(1).add(dec(fee).div(10000))).add(tx)))){this.stats.rejected++;if(p.side==='buy')this.cycleCash=null;}
   else{
    l.fill(p.side,swingPolicy.sizeMon,q.price,fee);this.stats.fills++;this.quality.add(f,p.side,q.price,swingPolicy.sizeMon,fee);
    if(p.side==='buy'){this.entryAt=now;this.entryPrice=q.price;this.lastExitAttemptBlock=null;}
    else{this.roundTrips.push({netUsd:l.cash.sub(this.cycleCash!).toString(),reason:p.reason});this.entryAt=null;this.entryPrice=null;this.cycleCash=null;}
   }
  }
  this.quality.observe(f);
  const equity=this.exitValue(f);if(equity===null)this.halted??='insufficient exit depth';
  else{if(equity.gt(this.peak))this.peak=equity;const dd=this.peak.sub(equity).div(this.peak).mul(100);if(dd.gt(this.drawdown))this.drawdown=dd;if(equity.sub(100).lte(-1))this.halted??='maximum loss';if(dd.gte(1))this.halted??='maximum drawdown';}
  invariant(l.cash.gte(0)&&l.mon.gte(0)&&l.mon.add(this.pending?.side==='buy'?200:0).lte(400),'funded spot/cap invariant');
  if(l.cash.lt(tx)){this.halted??='gas reserve exhausted';return;}
  if(this.pending)return;
  const reverse=bar&&this.bars.length>=13&&dec(bar.close).lte(this.bars.at(-13)!.close);
  const stop=this.entryPrice&&dec(midOf(f)).lte(dec(this.entryPrice).mul('0.99'));
  if(l.mon.gt(0)&&(this.halted||stop||now-this.entryAt!>=swingPolicy.horizonMs||reverse)){
   // Exit retries are bounded to one per completed bar after a failed attempt.
   if(bar||this.lastExitAttemptBlock===null){this.lastExitAttemptBlock=f.block;this.pending={side:'sell',block:f.block+1,limit:null,reason:this.halted??(stop?'trade_stop':reverse?'trend_reversal':'holding_limit')};this.stats.exitAttempts++;}return;
  }
  if(!bar||l.mon.gt(0)||this.halted)return;
  if(now+swingPolicy.horizonMs>this.end){this.count('end_window');return;}
  if(!swingSignal(this.bars)){this.count('no_signal');return;}
  this.attemptsAt=this.attemptsAt.filter(t=>now-t<86400000);
  if(this.attemptsAt.length>=2){this.count('attempt_budget');return;}
  const gate=swingGate(this.header,f,this.model,this.gas,this.depth);this.count(gate.reason);this.gateRecent.push(gate);if(this.gateRecent.length>50)this.gateRecent.shift();
  if(!gate.accepted)return;
  if(l.cash.lt(dec(gate.entryPriceLimit).mul(200).mul('1.001').add(gate.gasReserveUsd))){this.count('cash_reserve');return;}
  this.attemptsAt.push(now);this.stats.entryAttempts++;this.cycleCash=l.cash.toString();this.pending={side:'buy',block:f.block+1,limit:gate.entryPriceLimit,reason:'signal'};
 }
 private count(k:string){this.counts[k]=(this.counts[k]??0)+1;}
 private exitValue(f:Frame){const l=this.ledger!;if(l.mon.eq(0))return l.cash.sub(this.pending?transactionCost(this.header,f,this.gas).mul(this.pending.side==='buy'?2:1):0);
  const q=walk(f,'sell',this.depth);if(!q.complete||!f.marketCosts||dec(f.marketCosts.minSizeMon).gt(swingPolicy.sizeMon))return null;
  const fee=dec(f.marketCosts?.takerFeeBps??'0').gte(swingPolicy.feeFloorBps)?f.marketCosts!.takerFeeBps:swingPolicy.feeFloorBps;
  return l.cash.add(dec(q.notional).mul(dec(1).sub(dec(fee).div(10000)))).sub(transactionCost(this.header,f,this.gas));
 }
 report(){invariant(this.ledger&&this.last&&this.first,'no evaluation observations');const l=this.ledger,eq=this.exitValue(this.last);
  return {id:this.gas===1?'swing-standard':'swing-double-gas-half-depth',liveTradingEnabled:false,initialEquityUsd:'100',firstBlock:this.first.block,lastBlock:this.last.block,marketThrough:new Date(frameTime(this.last)).toISOString(),cashUsd:l.cash.toString(),inventoryMon:l.mon.toString(),potentialInventoryMon:l.mon.add(this.pending?.side==='buy'?200:0).toString(),netMarkedUsd:l.net(midOf(this.last)).toString(),netAfterExitUsd:eq?.sub(100).toString()??null,equityAfterExitUsd:eq?.toString()??null,costs:{gasUsd:l.gasUsd.toString(),feesUsd:l.makerFeesUsd.toString(),totalSettledUsd:l.costs().toString()},maxDrawdownPct:this.drawdown.toString(),halted:this.halted,pending:this.pending,roundTrips:this.roundTrips.length,completedTrades:this.roundTrips,...this.stats,decisionCounts:{...this.counts},recentGates:this.gateRecent,fillQuality:this.quality.report(),risk:{maxLossUsd:'1',maxDrawdownPct:1,maxPositionMon:'400',maxTradeRiskUsd:'0.10'},assumptions:{gasMultiplier:this.gas,displayedDepthFactor:this.depth,feeFloorBps:'5',slippageLimitBps:'10',execution:'Delayed full-size depth walk or charged failure; no partial entry. Emergency/time/reversal exits walk available depth without a price floor. No fabricated exit when depth is insufficient. Retry exits once per completed bar; risk triggers may overshoot during delay.'}};
 }
}
