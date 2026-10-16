import { expect,test } from "bun:test";
import { CandleClock,fitSwingModel,PatientSwing,swingGate,swingPolicy,swingSignal,walk,type Bar,type SwingModel } from "../src/swing/patient-swing";
import type { DatasetHeader,Frame } from "../src/research/types";
import { dec } from "../src/research/ledger";
const h:DatasetHeader={kind:'dataset',version:1,dataKind:'synthetic',source:'Patient Swing unit fixtures, not historical returns',market:'test',chainId:0,blockMs:300000,tickSize:'0.000001',costs:{makerFeeBps:'0',gasLimit:350000,gasPriceWei:'102000000000',aiCostPerDecisionUsd:'0'}};
const model:SwingModel={trainedThrough:0,samples:20,successfulNextBlockQuotes:20,qualified:true,meanMoveBps:'150',lowerMoveBps:'100',successLower:'0.8',samplesDetail:[]};
function f(b:number,p=0.02061,q='1000'):Frame{return {kind:'frame',block:b,ts:b*300000,marketTs:b*300000,bids:[[(p-0.00001).toFixed(6),q]],asks:[[(p+0.00001).toFixed(6),q]],gasPriceWei:'102000000000',marketCosts:{observedBlock:b,makerFeeBps:'0',takerFeeBps:'0',minSizeMon:'200'},trades:[{id:`t${b}`,side:'buy',price:(p+0.00001).toFixed(6),size:'1000'}]};}
const prices=[.02,.0201,.0202,.0203,.0204,.0205,.0206,.0207,.0208,.0207,.0206,.0205,.0206,.02061];
function initial(){const e=new PatientSwing(h,model,300000,86400000);prices.forEach((p,i)=>e.step(f(i+1,p)));return e;}
test('candles close only on next bucket; a partial initial candle is discarded',()=>{
 const c=new CandleClock();expect(c.observe({...f(1),ts:310000,marketTs:310000})).toBeNull();expect(c.observe(f(2))).toBeNull();expect(c.observe(f(3))?.end).toBe(900000);
 expect(()=>c.observe(f(5))).toThrow('clock coverage');
});
test('entry uses complete signal history and cannot fill its decision block',()=>{
 const e=initial();expect(e.report().entryAttempts).toBe(1);expect(e.report().fills).toBe(0);expect(e.report().potentialInventoryMon).toBe('200');
 e.step(f(15));expect(e.report().fills).toBe(1);expect(e.report().inventoryMon).toBe('200');expect(dec(e.report().costs.totalSettledUsd).gt(0)).toBe(true);
});
test('price movement and insufficient full depth cause charged failures, never invented partial fills',()=>{
 const a=initial();a.step(f(15,.03));expect(a.report().rejected).toBe(1);expect(a.report().fills).toBe(0);expect(a.report().inventoryMon).toBe('0');expect(dec(a.report().costs.gasUsd).gt(0)).toBe(true);
 const b=initial();b.step(f(15,.02061,'100'));expect(b.report().rejected).toBe(1);expect(b.report().inventoryMon).toBe('0');
 expect(walk(f(1,.02,'300'),'buy',0.5).complete).toBe(false);
});
test('unknown minimum size or unqualified/nonpositive forecast fails closed',()=>{
 const unknown={...f(1),marketCosts:undefined};expect(swingGate(h,unknown,model).accepted).toBe(false);
 expect(swingGate(h,f(1),{...model,qualified:false,samples:1,lowerMoveBps:'0',successLower:'0'}).reason).toBe('insufficient_training_evidence');
 expect(swingGate(h,f(1),{...model,lowerMoveBps:'-1'}).reason).toBe('nonpositive_forecast');
 expect(swingGate(h,{...f(1),asks:[['0.03','1000']]},model).reason).toBe('spread_outside_original_limits');
 expect(swingGate(h,{...f(1),gasPriceWei:'99999999999999999'},model).accepted).toBe(false);
});
test('trade/portfolio stops submit delayed exits immediately and portfolio halt is sticky',()=>{
 const e=initial();e.step(f(15));e.step(f(16,.01));expect(e.report().halted).toBe('maximum loss');expect(e.report().pending?.side).toBe('sell');expect(e.report().inventoryMon).toBe('200');
 e.step(f(17,.01));expect(e.report().inventoryMon).toBe('0');expect(e.report().halted).toBe('maximum loss');
 e.step(f(18,.02061));expect(e.report().halted).toBe('maximum loss');expect(e.report().entryAttempts).toBe(1);
});
test('two-hour exits settle later and net accounting includes entry/exit fees and gas',()=>{
 const e=initial();e.step(f(15));for(let b=16;b<=39;b++)e.step(f(b,.021+(b-16)*.000001));expect(e.report().pending?.side).toBe('sell');expect(e.report().roundTrips).toBe(0);
 e.step(f(40));const r=e.report();expect(r.roundTrips).toBe(1);expect(r.fills).toBe(2);expect(dec(r.equityAfterExitUsd!).eq(dec(100).add(r.netAfterExitUsd!))).toBe(true);expect(dec(r.netAfterExitUsd!).lt(0)).toBe(true);
});
test('unavailable exit depth remains unresolved, with no fabricated liquidation profit',()=>{
 const e=initial();e.step(f(15));e.step(f(16,.02061,'100'));expect(e.report().netAfterExitUsd).toBeNull();expect(e.report().halted).toBe('insufficient exit depth');expect(e.report().inventoryMon).toBe('200');
});
test('future evaluation observations cannot alter calibration, and short histories cannot qualify',()=>{
 const frames=Array.from({length:100},(_,i)=>f(i+1));const cutoff=15000000;
 const a=fitSwingModel(frames,cutoff),b=fitSwingModel(frames.map(x=>x.ts>=cutoff?{...x,bids:[['1','1000']],asks:[['2','1000']]}:x),cutoff);
 expect(a).toEqual(b);expect(a.qualified).toBe(false);expect(a.lowerMoveBps).toBe('0');expect(a.samplesDetail.every(x=>x.labelAt<cutoff)).toBe(true);
});
test('fixed risk policy, malformed input and deterministic execution remain enforced',()=>{
 expect(swingPolicy.maxLossUsd).toBe('1');expect(swingPolicy.maxDrawdownPct).toBe(1);expect(swingPolicy.maxPositionMon).toBe('400');
 expect(initial().report()).toEqual(initial().report());const e=initial();const before=e.report();expect(()=>e.step(f(16))).toThrow('missing');expect(e.report()).toEqual(before);
 expect(()=>new PatientSwing(h,{...model,samples:1},300000,86400000)).toThrow('qualification');expect(()=>new PatientSwing(h,model,-1,86400000)).toThrow('overlaps');
});
function wave(b:number){const offsets=[0,.0001,.0002,.0003,.0004,.0005,.0006,.0007,.0008,.0007,.0006,.0005,.0006,.0007,.0008,.0009];return f(b,.02+Math.floor((b-1)/16)*.001+offsets[(b-1)%16]!);}
test('rolling attempt budget includes failures and never resets with a new signal',()=>{
 const e=new PatientSwing(h,model,300000,5*86400000);
 for(let b=1;b<=160;b++){const next=wave(b);if(e.report && b>1 && e.report().pending?.side==='buy'){next.asks=[['0.09','1000']];}e.step(next);}
 expect(e.report().entryAttempts).toBe(2);expect(e.report().decisionCounts.attempt_budget).toBeGreaterThan(0);expect(e.report().fills).toBe(0);expect(e.report().rejected).toBe(2);
});
test('qualified calibration uses mature separated labels and conservative execution score',()=>{
 const frames=Array.from({length:1000},(_,i)=>wave(i+1));const cutoff=frames[950]!.ts;
 const m=fitSwingModel(frames,cutoff);expect(m.qualified).toBe(true);expect(m.samples).toBeGreaterThanOrEqual(20);expect(dec(m.lowerMoveBps).lte(m.meanMoveBps)).toBe(true);expect(dec(m.successLower).lt(1)).toBe(true);
 for(let i=1;i<m.samplesDetail.length;i++)expect(m.samplesDetail[i]!.at-m.samplesDetail[i-1]!.at).toBeGreaterThanOrEqual(7200000);
 expect(m.samplesDetail.every(x=>x.labelAt<cutoff)).toBe(true);
});
