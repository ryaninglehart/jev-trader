import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SelectiveCandidate } from "../src/research/selective";
import type { DatasetHeader, EngineConfig, Frame } from "../src/research/types";
const config = (): EngineConfig => JSON.parse(readFileSync("edgefoundry.patient.example.json", "utf8")).engine;
const header: DatasetHeader = { kind: "dataset", version: 1, dataKind: "synthetic", source: "selective causal tests", market: "test", chainId: 0, blockMs: 1000, tickSize: "0.000001", costs: { makerFeeBps: "0", gasLimit: 1, gasPriceWei: "1", aiCostPerDecisionUsd: "0" } };
function frame(block: number, sells = true, depth = "1"): Frame {
 const bid = 0.01 + block / 1000000;
 return { kind: "frame", block, ts: block * 1000, marketTs: block * 1000,
  bids: [0,1,2].map(i => [(bid-i/1000000).toFixed(6),depth]), asks: [0,1,2].map(i => [(bid+0.0001+i/1000000).toFixed(6),depth]),
  trades: [{id:`b${block}`,side:"buy",price:(bid+0.0001).toFixed(6),size:"800"},...(sells ? [{id:`s${block}`,side:"sell" as const,price:(bid-0.00001).toFixed(6),size:"300"}] : [])] };
}
function run(n: number, sells = true, depth = "1") { const e = new SelectiveCandidate(header, config()); for(let b=1;b<=n;b++) e.step(frame(b,sells,depth)); return e; }
test("thin opposing flow and deep queues block entries despite bullish signal", () => {
 const thin=run(40,false), deep=run(40,true,"100000");
 expect(thin.report().filterCounts.insufficient_queue_flow).toBeGreaterThan(0);
 expect(deep.report().filterCounts.insufficient_queue_flow).toBeGreaterThan(0);
 expect(thin.report().attempts).toBe(0); expect(deep.report().attempts).toBe(0);
});
test("persistence waits, old prints cannot fill new quotes, and entry cooldown limits retries", () => {
 const e=run(33); expect(e.report().attempts).toBe(0);
 e.step(frame(34)); expect(e.report().attempts).toBe(1); expect(e.report().fills).toBe(0);
 e.step(frame(35)); expect(e.report().fills).toBe(0); // settlement follows old-order fills
 const before = e.report();
 for(let b=36;b<=70;b++) e.step(frame(b));
 expect(e.report().fills).toBeGreaterThan(0); expect(e.report().attempts).toBe(1);
 expect(e.report().filterCounts.entry_cooldown).toBeGreaterThan(0);
 expect(before.fills).toBe(0); expect(e.report().risk.potentialInventoryMon).toBe("200");
});
test("eligible resting quotes retain their original price without replacements", () => {
 const e=run(35); const price=e.engine.active!.price;
 const f=frame(36); f.trades=f.trades.filter(t=>t.side==='buy'); e.step(f);
 expect(e.engine.active!.price).toBe(price); expect(e.report().attempts).toBe(1);
 expect(e.report().filterCounts.retain_original_quote).toBe(1);
});
test("economic rejection and sticky risk stops still override candidate eligibility", () => {
 const expensive = new SelectiveCandidate({...header,costs:{...header.costs,gasLimit:350000,gasPriceWei:"1000000000000"}},config());
 for(let b=1;b<=40;b++) expensive.step(frame(b));
 expect(expensive.report().economicGate.blocked).toBeGreaterThan(0); expect(expensive.report().attempts).toBe(0);
 const e=run(35); e.engine.ledger!.cash=e.engine.ledger!.cash.sub("2"); e.step(frame(36));
 expect(e.engine.pending?.side ?? null).toBeNull(); expect(e.report().halted).toBe("maximum loss");
});
test("deterministic replay, malformed data rejection and strict config guards", () => {
 expect(run(70).report()).toEqual(run(70).report());
 const e=run(35), before=e.report(); expect(()=>e.step(frame(37))).toThrow("missing"); expect(e.report()).toEqual(before);
 expect(()=>new SelectiveCandidate(header,{...config(),maxLossUsd:"2"})).toThrow("strict risk");
 expect(()=>new SelectiveCandidate(header,{...config(),economicGate:{...config().economicGate!,enabled:false}})).toThrow();
 expect(()=>new SelectiveCandidate(header,{...config(),queueFactor:"0.5"})).toThrow("conservative queue");
});

test("retention expires at original TTL and unsafe economics cancel instead of repricing", () => {
 const e=run(35);
 for(let b=36;b<=65;b++) { const f=frame(b); f.trades=f.trades.filter(t=>t.side==='buy'); e.step(f); }
 expect(e.engine.pending?.side).toBeNull();
 expect(e.report().attempts).toBe(2); // one entry, one TTL cancellation
 const bad=run(35), f=frame(36); f.trades=f.trades.filter(t=>t.side==='buy'); f.gasPriceWei="1000000000000000000"; bad.step(f);
 expect(bad.engine.pending?.side).toBeNull();
 expect(()=>new SelectiveCandidate(header,{...config(),economicGate:{...config().economicGate!,expectedFillFraction:"1"}})).toThrow("weaken");
});

import { SelectiveStudy } from "../src/research/selective-study";
const plan = { startAt: new Date(31000).toISOString(), endAt: new Date(70000).toISOString(), codeDigest: "test", releaseId: 1, namespace: "test" };
test("forward comparison excludes pre-cutoff returns and restores all four portfolios by replay", () => {
 const a=new SelectiveStudy(header,config(),plan), b=new SelectiveStudy(header,config(),plan);
 for(let n=1;n<=30;n++){a.step(frame(n));b.step(frame(n));}
 expect(a.report().arms).toHaveLength(0);expect(a.report().runStatus).toBe('waiting_for_start');
 for(let n=31;n<=65;n++){a.step(frame(n));b.step(frame(n));}
 expect(a.report()).toEqual(b.report());expect(a.report().firstBlock).toBe(31);
 expect(a.report().arms).toHaveLength(4);expect(a.report().runStatus).toBe('running');
 for(const r of a.report().arms){expect(r.initialEquityUsd).toBe('100');expect(r.liveTradingEnabled).toBe(false);expect(r.economicGate.enabled).toBe(true);expect(r.risk.maxLossUsd).toBe('1');}
 for(let n=66;n<=70;n++)a.step(frame(n));expect(a.report().runStatus).toBe('completed');
});
test("forward test refuses a missing start boundary and cannot call partial coverage complete", () => {
 const a=new SelectiveStudy(header,config(),plan);expect(()=>a.step(frame(31))).toThrow('predecessor');
 const b=new SelectiveStudy(header,config(),plan);b.step(frame(29));expect(()=>b.step(frame(31))).toThrow('boundary');
 const c=new SelectiveStudy(header,config(),plan);c.step(frame(30));c.step(frame(31));expect(c.report().runStatus).toBe('running');
});
