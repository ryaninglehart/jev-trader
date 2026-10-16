/** Free read-only archival training data. Never imports config, wallets or active study stores. */
import { Database } from 'bun:sqlite';
import { ethers } from 'ethers';
import { createHash } from 'node:crypto';
import { mkdirSync,readFileSync,writeFileSync,existsSync,openSync,closeSync,unlinkSync } from 'node:fs';
import { dirname,resolve } from 'node:path';
import { buildBook,decodeVaultParams } from '../src/book';
import { dec } from '../src/research/ledger';
import { invariant,validateFrame } from '../src/research/validation';
import { args } from './research-args';
import type { Frame } from '../src/research/types';
const URL='https://rpc2.monad.xyz',MARKET='0x065C9d28E428A0db40191a54d33d5b7c71a9C394',MULTI='0xcA11bde05977b3631167028862bE2a173976CA11';
const TOPIC='0xf16924fba1c18c108912fcacaac7450c98eb3f2d8c0a3cdf3df7066c08f21581';
const START=Date.parse('2026-10-02T06:15:00Z'),END=Date.parse('2026-10-16T06:15:00Z');
const anchor={block:113824494,ts:Date.parse('2026-10-16T06:17:22Z')};
const abi=new ethers.utils.Interface(['function aggregate(tuple(address target,bytes callData)[] calls) payable returns(uint256 blockNumber,bytes[] returnData)']);
const paramsABI=new ethers.utils.Interface(['function getMarketParams() view returns(uint32,uint96,address,uint256,address,uint256,uint32,uint96,uint96,uint256,uint256)']);
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
let db:Database,nextAt=0,calls=0,retries=0,done=0,total=4032,stopping=false,lastError:string|null=null;
let statusPath='';const active=new Map<string,Promise<any>>();const headers=new Map<number,any>();
function saveStatus(status:string){writeFileSync(statusPath,JSON.stringify({schema:'edgefoundry-swing-history-status-v1',status,updatedAt:new Date().toISOString(),source:URL,market:MARKET,startAt:new Date(START).toISOString(),endAt:new Date(END).toISOString(),barsComplete:done,barsTarget:total,rpcCalls:calls,retries,lastError,liveTradingEnabled:false,trainingOnly:true,originalTestsUnchanged:true},null,2)+'\n');}
async function request(method:string,params:any[]):Promise<any>{
 invariant(['eth_chainId','eth_getBlockByNumber','eth_call','eth_getLogs'].includes(method),'read-only RPC allowlist');
 const k=JSON.stringify([method,params]);const cached=db.query('SELECT body,digest FROM rpc WHERE key=?').get(k) as any;
 if(cached){invariant(hash(cached.body)===cached.digest,'historical response cache changed');return JSON.parse(cached.body);}
 if(active.has(k))return active.get(k)!;
 const promise=(async()=>{
  for(let n=0;n<7;n++){
   const pause=Math.max(0,nextAt-Date.now());nextAt=Math.max(nextAt,Date.now())+35;if(pause)await Bun.sleep(pause);
   try{calls++;const r=await fetch(URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(20000)});const x=await r.json() as any;
    invariant(r.ok&&x&&!x.error&&x.result!==undefined&&x.result!==null,`archive ${method}: ${r.status} ${x?.error?.message??'empty/malformed response'}`);
    const body=JSON.stringify(x.result);db.query('INSERT INTO rpc VALUES(?,?,?)').run(k,body,hash(body));return x.result;
   }catch(e){retries++;lastError=(e as Error).message;saveStatus('retrying');if(n===6)throw e;await Bun.sleep(Math.min(15000,1000*2**n));}
  }
 })();active.set(k,promise);try{return await promise;}finally{active.delete(k);}
}
async function header(n:number){if(headers.has(n))return headers.get(n);const b=await request('eth_getBlockByNumber',['0x'+n.toString(16),false]);invariant(b?.hash&&b?.timestamp&&b?.baseFeePerGas,'archive block missing');const h={block:n,ts:Number(BigInt(b.timestamp))*1000,hash:b.hash,parent:b.parentHash,gas:(BigInt(b.baseFeePerGas)+2000000000n).toString()};headers.set(n,h);return h;}
async function boundary(target:number,prior:{block:number;ts:number}){
 let n=Math.max(1,prior.block+Math.round((target-prior.ts)/300)),lo=0,hi=Number.MAX_SAFE_INTEGER;
 for(let i=0;i<40;i++){
  const b=await header(n);
  if(b.ts>=target){const p=await header(n-1);invariant(b.parent===p.hash,'boundary parent differs');if(p.ts<target)return b;hi=Math.min(hi,n);n=Math.max(lo+1,n-Math.max(1,Math.ceil((b.ts-target)/300)+1));}
  else{lo=Math.max(lo,n);n=Math.min(hi-1,n+Math.max(1,Math.ceil((target-b.ts)/300)));}
  if(n<=lo||n>=hi)n=Math.floor((lo+hi)/2);
 }
 throw Error('timestamp boundary search did not converge');
}
async function frame(n:number):Promise<Frame>{
 const h=await header(n),tag='0x'+n.toString(16);
 const data=abi.encodeFunctionData('aggregate',[[{target:MARKET,callData:paramsABI.encodeFunctionData('getMarketParams')},{target:MARKET,callData:'0x46fdfbb1'},{target:MARKET,callData:'0x88bb4f60'}]]);
 const raw=await request('eth_call',[{to:MULTI,data},tag]),r=abi.decodeFunctionResult('aggregate',raw);invariant(Number(r[0])===n,'archive multicall block differs');
 const p=paramsABI.decodeFunctionResult('getMarketParams',r[1][0]);
 invariant(p[0].toString()==='100000000'&&p[1].toString()==='10000000000'&&p[6].toString()==='100','historical precision/tick changed');
 const book=buildBook(r[1][1],{pricePrecision:p[0],sizePrecision:p[1],tickSize:p[6]},decodeVaultParams(r[1][2]));invariant(book.block===n,'historical book block differs');
 const f:Frame={kind:'frame',block:n,ts:h.ts,marketTs:h.ts,blockHash:h.hash,parentHash:h.parent,gasPriceWei:h.gas,bids:book.levels.bids.map(([p,q])=>[dec(p).toFixed(),dec(q).toFixed()]),asks:book.levels.asks.map(([p,q])=>[dec(p).toFixed(),dec(q).toFixed()]),trades:[],marketCosts:{observedBlock:n,makerFeeBps:p[10].toString(),takerFeeBps:p[9].toString(),minSizeMon:dec(p[7].toString()).div(p[1].toString()).toString()}};
 validateFrame(f);return f;
}
async function trades(from:number,to:number,start:number,end:number){
 invariant(to>=from&&to-from<2000,'unexpected five-minute block span');
 const logs=await request('eth_getLogs',[{address:MARKET,topics:[TOPIC],fromBlock:'0x'+from.toString(16),toBlock:'0x'+to.toString(16)}]);invariant(Array.isArray(logs)&&logs.length<10000,'log limit/incomplete response');
 let buy=dec(0),sell=dec(0);const ids=new Set<string>();
 for(const l of logs){const b=Number(BigInt(l.blockNumber)),ts=Number(BigInt(l.blockTimestamp))*1000;invariant(!l.removed&&b>=from&&b<=to&&ts>=start&&ts<end&&l.address.toLowerCase()===MARKET.toLowerCase()&&l.topics[0]===TOPIC,'historical trade range differs');const id=l.transactionHash+':'+l.logIndex;invariant(!ids.has(id),'duplicate historical print');ids.add(id);const s=l.data.slice(2);invariant(s.length===64*8,'unsupported historical Trade data');const word=(i:number)=>BigInt('0x'+s.slice(i*64,(i+1)*64));invariant(word(2)===0n||word(2)===1n,'invalid trade side');const qty=dec(word(7).toString()).div('10000000000');if(word(2)===1n)buy=buy.add(qty);else sell=sell.add(qty);}
 return {buy:buy.toString(),sell:sell.toString(),prints:logs.length};
}
async function bar(start:number,first:any){
 const end=start+300000,trigger=await boundary(end,first),close=await frame(trigger.block-1),f=await frame(trigger.block),next=await frame(trigger.block+1),flow=await trades(first.block,trigger.block-1,start,end);
 invariant(f.parentHash===close.blockHash&&next.parentHash===f.blockHash,'historical local block chain differs');
 const value={end,close:dec(close.bids[0]![0]).add(close.asks[0]![0]).div(2).toString(),buy:flow.buy,sell:flow.sell,trigger:f,next,closeBlock:close.block,closeHash:close.blockHash,fromBlock:first.block,prints:flow.prints};
 const body=JSON.stringify(value),old=db.query('SELECT body,digest FROM bars WHERE end=?').get(end) as any;if(old)invariant(old.body===body&&old.digest===hash(body),'saved historical candle changed');else db.query('INSERT INTO bars VALUES(?,?,?)').run(end,body,hash(body));
 return trigger;
}
async function main(){
 const a=args(['state','out','status']);invariant(a.state&&a.out&&a.status,'require --state --out --status');statusPath=a.status;mkdirSync(dirname(resolve(a.state)),{recursive:true});mkdirSync(dirname(resolve(a.out)),{recursive:true});
 const lock=a.state+'.lock';if(existsSync(lock)){const pid=Number(readFileSync(lock,'utf8'));try{process.kill(pid,0);throw Error('historical data writer still active');}catch(e){if((e as any).code!=='ESRCH')throw e;}unlinkSync(lock);}closeSync(openSync(lock,'wx'));writeFileSync(lock,String(process.pid));
 db=new Database(a.state,{create:true});db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS rpc(key TEXT PRIMARY KEY,body TEXT NOT NULL,digest TEXT NOT NULL);CREATE TABLE IF NOT EXISTS bars(end INTEGER PRIMARY KEY,body TEXT NOT NULL,digest TEXT NOT NULL);CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
 const identity=JSON.stringify({schema:'swing-history-v1',source:URL,market:MARKET,chainId:143,start:START,end:END,barMs:300000});const old=db.query("SELECT value FROM metadata WHERE key='identity'").get() as any;if(old)invariant(old.value===identity,'archive identity changed');else db.query("INSERT INTO metadata VALUES('identity',?)").run(identity);
 try{
  invariant(await request('eth_chainId',[])==='0x8f','archive wrong chain');done=(db.query('SELECT COUNT(*) n FROM bars WHERE end<=?').get(END) as any).n;saveStatus('collecting');
  process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
  await Promise.all(Array.from({length:14},async(_,day)=>{let start=START+day*86400000,first=await boundary(start,anchor);for(let k=0;k<288&&!stopping;k++,start+=300000){const existing=db.query('SELECT body FROM bars WHERE end=?').get(start+300000) as any;if(existing){first=await header(JSON.parse(existing.body).trigger.block);continue;}first=await bar(start,first);done++;lastError=null;if(done%25===0){saveStatus('collecting');console.log(JSON.stringify({bars:done,total,rpcCalls:calls,retries}));}}}));
  invariant(!stopping&&done===total,'collection interrupted; preserve archive and resume identical plan');
  const bars:any[]=[];let digest='';for(const r of db.query('SELECT body,digest FROM bars WHERE end<=? ORDER BY end').iterate(END) as Iterable<any>){invariant(hash(r.body)===r.digest,'bar cache hash changed');digest=hash(digest+r.body);bars.push(JSON.parse(r.body));}
  invariant(bars.length===total&&bars.every((b,i)=>b.end===START+(i+1)*300000),'historical candle coverage incomplete');
  // Archive-only overlap for independent comparison to existing full-block data.
  let overlapFirst=await boundary(Date.parse('2026-10-16T06:20:00Z'),anchor);for(let start=Date.parse('2026-10-16T06:20:00Z');start<Date.parse('2026-10-16T07:20:00Z');start+=300000)overlapFirst=await bar(start,overlapFirst);
  const overlap=(db.query('SELECT body FROM bars WHERE end>? ORDER BY end').all(END) as any[]).map(r=>JSON.parse(r.body));
  writeFileSync(a.out,JSON.stringify({schema:'edgefoundry-swing-history-v1',liveTradingEnabled:false,market:MARKET,chainId:143,source:URL,startAt:new Date(START).toISOString(),endAt:new Date(END).toISOString(),bars,digest,overlap,methodology:'Exact UTC five-minute training candles from block-pinned book midpoints and complete timestamped Trade log ranges. Each includes the first boundary block and its immediate successor with real depth, fees and gas. This is not a full per-block execution history.'})+'\n',{flag:'wx',mode:0o600});saveStatus('completed');console.log(JSON.stringify({status:'completed',bars:done,digest,rpcCalls:calls,retries}));
 }finally{db.close();unlinkSync(lock);}
}
main().catch(e=>{lastError=e.message;if(statusPath)saveStatus('failed');console.error(e.message);process.exitCode=1;});
