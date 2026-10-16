/** Read-only audit of a separately restored original-input copy and paired report. */
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { SelectiveStudy } from "../src/research/selective-study";
import { codeDigest } from "./selective-cloud";
import { scan } from "./cloud-study";
import { invariant } from "../src/research/validation";
import { args, output, protectOutput } from "./research-args";
try {
 const a=args(["state","report","out"]);invariant(a.state&&a.report&&a.out,"require --state, --report and --out");protectOutput(a.out,[a.state,a.report,"selective-cloud-plan.json"]);
 const plan=JSON.parse(readFileSync('selective-cloud-plan.json','utf8')), saved=JSON.parse(readFileSync(a.report,'utf8')), config=JSON.parse(readFileSync('edgefoundry.patient.example.json','utf8'));
 invariant(codeDigest()===plan.codeDigest && Bun.version==='1.4.3','frozen comparison runtime changed');
 invariant(saved.liveTradingEnabled===false && saved.study.codeDigest===plan.codeDigest,'comparison report identity differs');
 const db=new Database(a.state,{readonly:true});db.exec('BEGIN');scan(db,saved.sourceLastBlock);
 const study=new SelectiveStudy(config.dataset,config.engine,plan);let lastDigest='',lastBlock=0;
 for(const row of db.query('SELECT block,body,digest FROM frames WHERE block<=? ORDER BY block').iterate(saved.sourceLastBlock) as Iterable<any>){study.step(JSON.parse(row.body));lastBlock=row.block;lastDigest=row.digest;}
 invariant(lastBlock===saved.sourceLastBlock && lastDigest===saved.sourceLastDigest,'comparison input anchor differs');
 invariant(JSON.stringify(study.report())===JSON.stringify(saved.study),'comparison deterministic replay differs');db.close();
 output(a.out,{checkpointSequence:saved.checkpointSequence,sourceLastBlock:lastBlock,sourceLastDigest:lastDigest,exactReplay:true,riskHistoryVerified:true,netAccountingVerified:true,liveTradingEnabled:false,runStatus:saved.study.runStatus,marketThrough:saved.study.marketThrough});
}catch(e){console.error((e as Error).message);process.exitCode=1;}
