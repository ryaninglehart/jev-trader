import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { scan } from "./cloud-study";
import { args, output, protectOutput } from "./research-args";
import { fitSwingModel, PatientSwing, SWING_VERSION, swingPolicy } from "../src/swing/patient-swing";
import { validateSwingArchive } from "../src/swing/history";
import { frameTime } from "../src/research/patient";
import { dec } from "../src/research/ledger";
import { invariant, validateFrame } from "../src/research/validation";
import type { Frame } from "../src/research/types";
try {
 const a=args(["state","history","previous","out"]);invariant(a.state&&a.out,"usage: bun --no-env-file scripts/backtest-swing.ts --state RESTORED_READ_ONLY_COPY.sqlite --out report.json");protectOutput(a.out,[a.state,a.history,a.previous]);
 const db=new Database(a.state,{readonly:true});db.exec('BEGIN');const verified=scan(db);
 const identity=JSON.parse((db.query("SELECT value FROM metadata WHERE key='identity'").get() as any).value);
 invariant(identity.header.dataKind==='recorded'&&!identity.header.inference,'recorded market-only input required');
 const frames:Frame[]=[];const ids=new Set<string>();
 for(const row of db.query('SELECT body FROM frames ORDER BY block').iterate() as Iterable<any>){const f=JSON.parse(row.body) as Frame;validateFrame(f,frames.at(-1));for(const t of f.trades){invariant(!ids.has(t.id),'repeated market trade');ids.add(t.id);}frames.push(f);}db.close();
 const first=frameTime(frames[0]!),end=frameTime(frames.at(-1)!);
 invariant(end-first>=swingPolicy.horizonMs*3,'need at least six hours of recorded input');
 const split=first+Math.floor((end-first)*swingPolicy.trainingFraction);
 const extra=a.history?validateSwingArchive(JSON.parse(readFileSync(a.history,'utf8')),frames):null;
 const model=extra?.model??fitSwingModel(frames,split),stressModel=extra?.stressModel??fitSwingModel(frames,split,0.5);
 const variants=[new PatientSwing(identity.header,model,split,end),new PatientSwing(identity.header,stressModel,split,end,2,0.5)];
 for(const f of frames)for(const v of variants)v.step(f);
 const reports=variants.map(v=>v.report());for(const r of reports)if(r.netAfterExitUsd!==null)invariant(dec(100).add(r.netAfterExitUsd).eq(r.equityAfterExitUsd!),"net accounting mismatch");
 const prior=a.previous?JSON.parse(readFileSync(a.previous,'utf8')):null;
 if(prior)invariant(prior.schema==='edgefoundry-swing-backtest-v1'&&prior.liveTradingEnabled===false,'invalid earlier result');
 const previousRuns=prior?[...(prior.previousRuns??[]),{label:'Initial 15-hour recording',report:prior,sourceDigest:prior.sourceDigest,inputDigest:prior.dataset.inputDigest,samples:prior.model.samples,entryAttempts:prior.variants[0].entryAttempts,netAfterExitUsd:prior.variants[0].netAfterExitUsd}]:[];
 const digest=createHash('sha256').update(readFileSync('src/swing/patient-swing.ts')).update(readFileSync('scripts/backtest-swing.ts')).update(readFileSync('src/swing/history.ts')).digest('hex');
 output(a.out,{schema:'edgefoundry-swing-backtest-v1',previousRuns,candidateVersion:SWING_VERSION,liveTradingEnabled:false,sourceDigest:digest,policy:swingPolicy,
  dataset:{dataKind:'recorded',frames:frames.length,firstBlock:verified.firstBlock,lastBlock:verified.lastBlock,inputDigest:verified.lastDigest,firstAt:new Date(first).toISOString(),lastAt:new Date(end).toISOString(),durationHours:(end-first)/3600000},
  split:{trainingEnd:new Date(model.trainedThrough).toISOString(),evaluationStart:new Date(split).toISOString(),evaluationEnd:new Date(end).toISOString(),trainingFraction:0.6,purgeHorizonHours:2,modelFrozen:true},model,stressModel,...(extra?{trainingHistory:extra.summary}:{}),variants:reports,
  conclusion:model.qualified?(dec(model.lowerMoveBps).lte(0)?'The training count requirement is met, but the conservative directional forecast is nonpositive. The economic gate rejects it; no profitable edge is established.':reports.every(r=>r.entryAttempts===0)?'The training count requirement is met, but no evaluation trade clears all signal, cost and risk checks. No profitable edge or fill-rate improvement is established.':'Chronological retrospective evaluation only. No claim of an independently validated profitable edge.'):'Training evidence is insufficient. Directional edge remains zero and the gate fails closed. No profitable edge or fill-rate improvement is established.',
  methodology:(extra?'Additional archival candles calibrate the model; their final 40% is price-label diagnostics only. Execution uses only the later 40% of the separate full-resolution recording. '+extra.summary.methodology+' ':'')+'Previously observed canonical market data, not a new forward test or untouched dataset. First 60% fits one fixed signal cohort; two-hour labels must mature strictly before the split, sampled at least two hours apart. Mean minus two standard errors and Wilson z=2 execution score are conservative heuristics, not calibrated confidence guarantees. At least 20 mature samples are required. The full-resolution evaluation window is replayed without refitting; no entries in its final two hours. Real input does not make simulated fills or returns real execution. Includes fee floors, full gas for failures, depth, latency, slippage and liquidation. No parameter search, cloud activation, promotion or live execution.',
  originalTestsUnchanged:true,riskHistoryVerified:true,netAccountingVerified:true,holdCashNetUsd:'0'});
}catch(e){console.error((e as Error).message);process.exitCode=1;}
