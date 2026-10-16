import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {CandleClock,fitSwingModel,type Bar} from '../src/swing/patient-swing';
import {validateSwingArchive} from '../src/swing/history';
import type {Frame} from '../src/research/types';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const bh=(b:number)=>'0x'+b.toString(16).padStart(64,'0');
function frame(b:number):Frame{
 const wave=[0,.0001,.0002,.0003,.0004,.0005,.0006,.0007,.0008,.0007,.0006,.0005,.0006,.0007,.0008,.0009];const p=.02+Math.floor((b-1)/16)*.001+wave[(b-1)%16]!;
 return {kind:'frame',block:b,blockHash:bh(b),parentHash:bh(b-1),ts:b*300000,marketTs:b*300000,bids:[[(p-.00001).toFixed(6),'1000']],asks:[[(p+.00001).toFixed(6),'1000']],gasPriceWei:'102000000000',marketCosts:{observedBlock:b,makerFeeBps:'0',takerFeeBps:'0',minSizeMon:'200'},trades:[{id:`t${b}`,side:'buy',price:p.toFixed(6),size:'1000'}]};
}
function fixture(){
 const frames=Array.from({length:1102},(_,i)=>frame(i+1));const clock=new CandleClock();const bars:Bar[]=[];for(const f of frames){const b=clock.observe(f);if(b)bars.push(b);}
 const archive=(b:Bar)=>structuredClone({...b,next:frames[b.trigger.block]!,fromBlock:b.trigger.block-1,closeBlock:b.trigger.block-1,closeHash:bh(b.trigger.block-1),prints:1});
 const selected=bars.slice(0,960).map(archive);let digest='';for(const b of selected)digest=hash(digest+JSON.stringify(b));
 return {data:{schema:'edgefoundry-swing-history-v1',chainId:143,market:'0x065C9d28E428A0db40191a54d33d5b7c71a9C394',source:'synthetic test fixture, never historical results',liveTradingEnabled:false,startAt:new Date(300000).toISOString(),endAt:new Date(961*300000).toISOString(),bars:selected,digest,overlap:bars.slice(1000,1012).map(archive)},execution:frames.slice(1000),frames};
}
test('independent candle calibration matches the existing full-frame fit and purges labels',()=>{
 const {data,execution,frames}=fixture();const result=validateSwingArchive(data,execution);const cutoff=300000+960*300000*.6;
 expect(result.model).toEqual(fitSwingModel(frames,cutoff));expect(result.model.samplesDetail.every(x=>x.labelAt<cutoff)).toBe(true);expect(result.summary.overlapCandlesVerified).toBe(12);
});
test('archive holdout cannot change the frozen model',()=>{
 const {data,execution}=fixture();const original=validateSwingArchive(data,execution).model;for(const b of data.bars.slice(576))b.close='1';let digest='';for(const b of data.bars)digest=hash(digest+JSON.stringify(b));data.digest=digest;
 expect(validateSwingArchive(data,execution).model).toEqual(original);
});
test('missing, reordered, changed or execution-overlapping archive fails closed',()=>{
 let a=fixture();a.data.bars.pop();expect(()=>validateSwingArchive(a.data,a.execution)).toThrow('missing historical');
 a=fixture();a.data.bars[20]!.next.parentHash=bh(0);expect(()=>validateSwingArchive(a.data,a.execution)).toThrow('boundary/parent');
 a=fixture();a.data.bars[20]!.buy='2001';expect(()=>validateSwingArchive(a.data,a.execution)).toThrow('digest');
 a=fixture();a.data.endAt=new Date(a.execution[1]!.ts).toISOString();expect(()=>validateSwingArchive(a.data,a.execution)).toThrow('overlaps');
});
test('independent overlap rejects changed books, flow and too few observations',()=>{
 let a=fixture();a.data.overlap[0]!.trigger.asks=[['1','1000']];expect(()=>validateSwingArchive(a.data,a.execution)).toThrow('depth');
 a=fixture();a.data.overlap[0]!.buy='2000';expect(()=>validateSwingArchive(a.data,a.execution)).toThrow('candle differs');
 a=fixture();a.data.overlap[0]!.next.gasPriceWei='999';expect(()=>validateSwingArchive(a.data,a.execution)).toThrow('costs');
 a=fixture();a.data.overlap[1]=structuredClone(a.data.overlap[0]!);expect(()=>validateSwingArchive(a.data,a.execution)).toThrow('consecutive unique');
 a=fixture();a.data.overlap.pop();expect(()=>validateSwingArchive(a.data,a.execution)).toThrow('one hour');
});
