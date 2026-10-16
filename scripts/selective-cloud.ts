/** Independent forward evaluation reader. Original release and workflow are read-only. */
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { resolve, relative, dirname } from "node:path";
import { sha, seal, unseal, scan, appendDelta, FROZEN_DIGEST } from "./cloud-study";
import { SelectiveStudy, type SelectivePlan } from "../src/research/selective-study";
import { invariant } from "../src/research/validation";
const REPO = "ryaninglehart/jev-trader";
const sourcePlan = JSON.parse(readFileSync("cloud-study-plan.json", "utf8"));
export function codeDigest() {
 const walk = (p: string): string[] => readdirSync(p,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(resolve(p,e.name)):e.name.endsWith('.ts')?[resolve(p,e.name)]:[]);
 return sha([...walk(resolve('src/research')), ...['scripts/selective-cloud.ts','scripts/cloud-study.ts','edgefoundry.patient.example.json','bun.lock','package.json'].map(p=>resolve(p))].sort().map(p=>relative(process.cwd(),p)+readFileSync(p,'utf8')).join(''));
}
const plan = () => JSON.parse(readFileSync("selective-cloud-plan.json", "utf8")) as SelectivePlan;
async function api(path: string, init: RequestInit = {}) {
 invariant(process.env.GH_TOKEN, "infrastructure credential unavailable");
 for(let n=0;n<3;n++) {
  try {
   const r=await fetch('https://api.github.com'+path,{...init,headers:{Accept:'application/vnd.github+json',Authorization:'Bearer '+process.env.GH_TOKEN,'X-GitHub-Api-Version':'2022-11-28',...init.headers},signal:AbortSignal.timeout(90000)});
   if(r.status>=500 || r.status===429) { if(n<2){await Bun.sleep(2000*(n+1));continue;} }
   invariant(r.ok,'GitHub transport status '+r.status); return r;
  } catch(e){if(n===2)throw e;await Bun.sleep(2000*(n+1));}
 }
 throw Error('bounded GitHub retries exhausted');
}
async function list(releaseId: number) {
 const r=await (await api(`/repos/${REPO}/releases/${releaseId}`)).json() as any;
 invariant(r.draft===true,'checkpoints must remain private draft');
 const result:any[]=[];
 for(let page=1;page<=9;page++) { const a=await(await api(`/repos/${REPO}/releases/${releaseId}/assets?per_page=100&page=${page}`)).json() as any[]; result.push(...a);if(a.length<100)return result; }
 throw Error('checkpoint asset bound exceeded');
}
async function download(id: number){return Buffer.from(await(await api(`/repos/${REPO}/releases/assets/${id}`,{headers:{Accept:'application/octet-stream'}})).arrayBuffer());}
async function saved(p: SelectivePlan,key: Buffer){
 const items=(await list(p.releaseId)).filter(a=>a.name.startsWith(p.namespace+'-')).sort((a,b)=>a.name.localeCompare(b.name));
 let previous='', sequence=0, latest:any=null;
 for(const a of items){
  const data=unseal(await download(a.id),key), x=JSON.parse(data.toString());
  invariant(x.sequence===sequence+1 && x.previousDigest===previous && x.codeDigest===p.codeDigest && a.name===`${p.namespace}-${String(x.sequence).padStart(6,'0')}.efc`,'comparison checkpoint chain differs');
  invariant(x.report.liveTradingEnabled===false && x.report.study.liveTradingEnabled===false && x.report.study.startAt===p.startAt && x.report.study.endAt===p.endAt,'comparison checkpoint safety/window differs');
  previous=sha(data);sequence=x.sequence;latest=x;
 }
 return {sequence,digest:previous,latest};
}
async function publish(p: SelectivePlan,key:Buffer,prior:Awaited<ReturnType<typeof saved>>,report:any){
 const body=Buffer.from(JSON.stringify({sequence:prior.sequence+1,previousDigest:prior.digest,codeDigest:p.codeDigest,report}));
 const bytes=seal(body,key), name=`${p.namespace}-${String(prior.sequence+1).padStart(6,'0')}.efc`;
 const r=await fetch(`https://uploads.github.com/repos/${REPO}/releases/${p.releaseId}/assets?name=${name}`,{method:'POST',headers:{Authorization:'Bearer '+process.env.GH_TOKEN,'Content-Type':'application/octet-stream'},body:bytes,signal:AbortSignal.timeout(120000)});
 invariant(r.ok,'comparison checkpoint upload failed '+r.status); const a=await r.json() as any;
 invariant(sha(await download(a.id))===sha(bytes),'comparison checkpoint readback differs');
 return {sequence:prior.sequence+1,digest:sha(body),latest:JSON.parse(body.toString())};
}
function save(path:string,data:any){mkdirSync(dirname(resolve(path)),{recursive:true});writeFileSync(path,JSON.stringify(data,null,2)+'\n',{mode:0o600});}
async function run(p:SelectivePlan,key:Buffer,once:boolean){
 invariant(Bun.version==='1.4.3' && codeDigest()===p.codeDigest,'comparison frozen runtime changed');
 invariant(p.releaseId!==sourcePlan.releaseId && p.endAt==='2026-10-19T06:17:23.000Z','comparison isolation/window differs');
 const settings=JSON.parse(readFileSync('edgefoundry.patient.example.json','utf8'));
 let own=await saved(p,key);
 const path=resolve('data/selective-cloud/source.sqlite'); invariant(!existsSync(path),'comparison source destination must be new');mkdirSync(dirname(path),{recursive:true});
 const items=await list(sourcePlan.releaseId), asset=items.find(a=>a.name===sourcePlan.seedName);invariant(asset,'original seed missing');
 const encrypted=await download(asset.id);invariant(sha(encrypted)===sourcePlan.seedSha256,'original seed checksum differs');
 const seed=JSON.parse(unseal(encrypted,key).toString());
 invariant(seed.sequence===0 && seed.kind==='seed' && seed.lastBlock===sourcePlan.minimumBlock,'original cutover differs');
 writeFileSync(path,Buffer.from(seed.database,'base64'),{flag:'wx',mode:0o600});const db=new Database(path);db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
 const identity=(db.query("SELECT value FROM metadata WHERE key='identity'").get() as any).value;
 invariant(identity===seed.identityValue && JSON.parse(identity).sourceDigest===FROZEN_DIGEST,'original identity differs');
 invariant(JSON.stringify(settings.dataset)===JSON.stringify(JSON.parse(identity).header) && JSON.stringify(settings.engine)===JSON.stringify(JSON.parse(identity).config),'comparison baseline differs from frozen original configuration');
 const initial=scan(db);invariant(initial.lastDigest===seed.lastDigest && initial.lastBlock===seed.lastBlock,'original seed journal differs');
 const study=new SelectiveStudy(settings.dataset,settings.engine,p);
 let sourceSequence=0, processed=0, prefixVerified=!own.latest, stop=false;
 const consume=()=>{
  for(const row of db.query('SELECT block,body,digest FROM frames WHERE block>? ORDER BY block').iterate(processed) as Iterable<any>){
   const f=JSON.parse(row.body);study.step(f);processed=row.block;
   if(own.latest?.report.sourceLastBlock===row.block){
    invariant(row.digest===own.latest.report.sourceLastDigest,'comparison prior source prefix differs');
    invariant(JSON.stringify(study.report())===JSON.stringify(own.latest.report.study),'comparison deterministic replay mismatch');prefixVerified=true;
   }
  }
 };
 consume();
 process.on('SIGTERM',()=>{stop=true;});process.on('SIGINT',()=>{stop=true;});
 const until=Date.now()+270*60000;
 try{
  while(!stop && Date.now()<until){
   const parts=(await list(sourcePlan.releaseId)).filter(a=>a.name.startsWith(sourcePlan.namespace+'-part-')).sort((a,b)=>a.name.localeCompare(b.name));
   for(const a of parts){
    const seq=Number(a.name.match(/part-(\d+)\.efc$/)?.[1]);invariant(Number.isSafeInteger(seq),'invalid source checkpoint name');if(seq<=sourceSequence)continue;
    invariant(seq===sourceSequence+1,'source checkpoint missing');const delta=JSON.parse(unseal(await download(a.id),key).toString());appendDelta(db,delta,sourceSequence);sourceSequence=seq;
   }
   consume();invariant(prefixVerified,'prior comparison checkpoint is ahead of restored source');
   const last=db.query('SELECT block,digest FROM frames ORDER BY block DESC LIMIT 1').get() as any;
   const studyReport=study.report();
   if(!own.latest || last.block!==own.latest.report.sourceLastBlock){
    const report={schema:'edgefoundry-selective-cloud-v1',liveTradingEnabled:false,executionHost:'github-actions',updatedAt:new Date().toISOString(),sourceSequence,sourceLastBlock:last.block,sourceLastDigest:last.digest,study:studyReport};
    own=await publish(p,key,own,report);save('data/selective-cloud/report.json',report);
    console.log(JSON.stringify({checkpoint:own.sequence,sourceCheckpoint:sourceSequence,marketThrough:studyReport.marketThrough,status:studyReport.runStatus,liveTradingEnabled:false}));
   }
   if(studyReport.runStatus==='completed' || once)break;
   await Bun.sleep(60000);
  }
 }finally{db.close();}
}
async function main(){
 const mode=process.argv[2];if(mode==='digest'){console.log(codeDigest());return;}
 const p=plan(), file=process.argv.indexOf('--key-file'), raw=file>=0?readFileSync(process.argv[file+1]!,'utf8').trim():process.env.EDGEFOUNDRY_CHECKPOINT_KEY;
 invariant(raw && /^[a-f0-9]{64}$/.test(raw),'checkpoint recovery key unavailable');const key=Buffer.from(raw,'hex');
 if(mode==='status'){const s=await saved(p,key);invariant(s.latest,'comparison checkpoint not yet available');const i=process.argv.indexOf('--out');invariant(i>=0,'output required');save(process.argv[i+1]!,{...s.latest.report,checkpointSequence:s.sequence});return;}
 invariant(mode==='segment' && process.env.GITHUB_ACTIONS==='true' && process.env.GITHUB_REPOSITORY===REPO,'comparison collector may run only in authorized cloud workflow');
 const r=await(await api(`/repos/${REPO}`)).json() as any;invariant(r.visibility==='public','free standard runners require public repository');
 await run(p,key,false);
}
if(import.meta.main)main().catch(e=>{console.error(e.message);process.exitCode=1;});
