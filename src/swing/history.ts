import { createHash } from 'node:crypto';
import { invariant,validateFrame } from '../research/validation';
import { CandleClock,fitSwingBars,swingPolicy,type Bar } from './patient-swing';
import { dec } from '../research/ledger';
import type { Frame } from '../research/types';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
export interface ArchiveBar extends Bar { next:Frame;fromBlock:number;closeBlock:number;closeHash:string;prints:number }
export function validateSwingArchive(data:any,execution:readonly Frame[]){
 invariant(data.schema==='edgefoundry-swing-history-v1'&&data.liveTradingEnabled===false&&data.chainId===143&&data.market==='0x065C9d28E428A0db40191a54d33d5b7c71a9C394','wrong historical market/schema');
 const start=Date.parse(data.startAt),end=Date.parse(data.endAt);invariant(end<=execution[0]!.marketTs!&&start<end,'historical training overlaps execution recording');
 invariant(data.bars.length===(end-start)/300000,'missing historical candles');let digest='';const next=new Map<number,Frame>();
 for(let i=0;i<data.bars.length;i++){
  const b=data.bars[i] as ArchiveBar;invariant(b.end===start+(i+1)*300000,'historical candles reordered');
  validateFrame(b.trigger);validateFrame(b.next);invariant(b.trigger.blockHash&&b.trigger.parentHash&&b.next.blockHash&&b.next.parentHash&&b.closeHash,"canonical historical hashes required");
  invariant(b.trigger.marketTs!>=b.end&&b.trigger.marketTs!<b.end+300000&&b.next.marketTs!>=b.trigger.marketTs!&&b.next.block===b.trigger.block+1&&b.next.parentHash===b.trigger.blockHash&&b.trigger.parentHash===b.closeHash&&b.closeBlock===b.trigger.block-1,'historical boundary/parent differs');
  if(i)invariant(b.fromBlock===data.bars[i-1].trigger.block,'historical trade coverage gap');
  invariant(dec(b.close).gt(0)&&dec(b.buy).gte(0)&&dec(b.sell).gte(0),'invalid historical candle');
  next.set(b.next.block,b.next);digest=hash(digest+JSON.stringify(b));
 }
 invariant(digest===data.digest,'historical bar digest differs');
 const clock=new CandleClock(),observed=new Map<number,Bar>();const byBlock=new Map(execution.map(f=>[f.block,f]));
 for(const f of execution){const b=clock.observe(f);if(b)observed.set(b.end,b);}
 invariant(data.overlap.length>=12,'need one hour of independent archive overlap');
 invariant(data.overlap.every((b:ArchiveBar,i:number)=>!i||b.end===data.overlap[i-1].end+300000),'overlap candles must cover consecutive unique intervals');
 for(const b of data.overlap as ArchiveBar[]){
  validateFrame(b.trigger);validateFrame(b.next);
  const ref=observed.get(b.end),nextRef=byBlock.get(b.next.block);invariant(ref&&nextRef,'overlap not in verified recording');
  invariant(b.close===ref.close&&dec(b.buy).sub(ref.buy).abs().lte('0.000001')&&dec(b.sell).sub(ref.sell).abs().lte('0.000001')&&b.trigger.blockHash===ref.trigger.blockHash,'archive candle differs from full-block recording');
  for(const [a,z] of [[b.trigger,ref.trigger],[b.next,nextRef]])invariant(a!.gasPriceWei===z!.gasPriceWei&&a!.marketCosts?.makerFeeBps===z!.marketCosts?.makerFeeBps&&a!.marketCosts?.takerFeeBps===z!.marketCosts?.takerFeeBps&&a!.marketCosts?.minSizeMon===z!.marketCosts?.minSizeMon,'archive costs differ from recording');
  for(const side of ['bids','asks'] as const)invariant(JSON.stringify(b.trigger[side])===JSON.stringify(ref.trigger[side])&&JSON.stringify(b.next[side])===JSON.stringify(nextRef[side]),'archive execution depth differs from recording');
 }
 const cutoff=start+Math.floor((end-start)*swingPolicy.trainingFraction);
 const model=fitSwingBars(data.bars,next,cutoff),stressModel=fitSwingBars(data.bars,next,cutoff,0.5);
 const heldout=fitSwingBars(data.bars,next,end+1).samplesDetail.filter(r=>r.at>=cutoff&&r.labelAt<end);
 return {model,stressModel,summary:{startAt:data.startAt,endAt:data.endAt,durationDays:(end-start)/86400000,bars:data.bars.length,digest,source:data.source,trainingEnd:new Date(cutoff).toISOString(),overlapCandlesVerified:data.overlap.length,trainingOnly:true,heldoutDirectionalLabels:heldout.length,heldoutMeanMidMoveBps:heldout.length?heldout.reduce((s,r)=>s.add(r.moveBps),dec(0)).div(heldout.length).toString():null,methodology:'Additional exact five-minute training candles, not a full execution tape. Same fixed 60% training fraction and two-hour purged labels. Remaining 40% supports price-label diagnostics only; no intrabar risk or historical trading returns are inferred from those candles. The full-resolution execution window stays unchanged. Archive snapshot clocks use canonical block timestamps. One hour independently matches the existing full-block recording in midpoints and decision/next-block depth; signed flow agrees within 0.000001 MON to allow the original recorder’s float conversion.'}};
}
