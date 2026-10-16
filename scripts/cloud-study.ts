/** Cloud transport/supervision only. Never edits the frozen collector or its strategy. */
import { Database } from "bun:sqlite";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { resolve, relative, dirname } from "node:path";

export const FROZEN_COMMIT = "098447cb730b6d68416f291d7534e2cf3fe85fac";
export const FROZEN_DIGEST = "235a71db4706ae4ef1a909c38e5f0fc630a684ebaac943bb806eb87e1367b081";
const REPO = "ryaninglehart/jev-trader";
const START = "2026-10-16T06:17:23.000Z", END = "2026-10-19T06:17:23.000Z";
const MAGIC = Buffer.from("EDGEFOUNDRY-CLOUD-1\n");
type Row = { block: number; body: string; digest: string };
type Plan = { repository: string; releaseId: number; seedName: string; seedSha256: string; namespace: string; minimumBlock: number; mode: "preflight" | "active" };
type Checkpoint = { version: 1; kind: "seed" | "delta"; sequence: number; identityValue: string; previousBlock: number; previousDigest: string; lastBlock: number; lastDigest: string; report: any; database?: string; rows?: Row[]; savedAt: string };
const invariant: (condition: unknown, reason: string) => asserts condition = (c, r) => { if (!c) throw Error(r); };
export const sha = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
export function seal(data: Uint8Array, key: Uint8Array) {
  invariant(key.length === 32, "invalid encryption key");
  const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, nonce); cipher.setAAD(MAGIC);
  const encrypted = Buffer.concat([cipher.update(gzipSync(data)), cipher.final()]);
  return Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), encrypted]);
}
export function unseal(data: Uint8Array, key: Uint8Array) {
  const b = Buffer.from(data); invariant(b.subarray(0, MAGIC.length).equals(MAGIC), "unknown checkpoint format");
  const d = createDecipheriv("aes-256-gcm", key, b.subarray(MAGIC.length, MAGIC.length + 12)); d.setAAD(MAGIC);
  d.setAuthTag(b.subarray(MAGIC.length + 12, MAGIC.length + 28));
  return gunzipSync(Buffer.concat([d.update(b.subarray(MAGIC.length + 28)), d.final()]));
}
function key(file?: string) {
  const value = file ? readFileSync(file, "utf8").trim() : process.env.EDGEFOUNDRY_CHECKPOINT_KEY;
  invariant(value && /^[a-f0-9]{64}$/.test(value), "checkpoint encryption key unavailable"); return Buffer.from(value, "hex");
}
function saveJson(path: string, data: unknown) { mkdirSync(dirname(resolve(path)), { recursive: true }); writeFileSync(path, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 }); }
function readJson(path: string) { return JSON.parse(readFileSync(path, "utf8")); }
function identity(db: Database) { const row = db.query("SELECT value FROM metadata WHERE key='identity'").get() as { value: string } | null; invariant(row, "journal identity missing"); return row.value; }
function checkIdentity(value: string) {
  const i = JSON.parse(value), c = i.config;
  invariant(i.sourceDigest === FROZEN_DIGEST && i.engineVersion === "edgefoundry-v5" && i.studyVersion === "holding-study-v1", "frozen runtime identity differs");
  for (const [k, v] of Object.entries({ strategy: "patient", initialCashUsd: "100", initialMon: "0", orderSizeMon: "200", maxPositionMon: "400", maxLossUsd: "1", maxDrawdownPct: 1 })) invariant(c[k] === v, "risk configuration differs: " + k);
  invariant(c.economicGate?.enabled && i.protocol.durationMs === 259200000, "economic gate/window differs");
  invariant(JSON.stringify(i.protocol.horizonsMs) === "[300000,900000,3600000]" && i.protocol.scenarios.length === 2, "frozen scenarios differ");
  return i;
}
function checkRuntime(root: string) {
  const walk = (p: string): string[] => readdirSync(p, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(resolve(p, e.name)) : e.name.endsWith(".ts") ? [resolve(p, e.name)] : []);
  const files = [...walk(resolve(root, "src")), ...["scripts/multiday.ts", "scripts/research-args.ts", "bun.lock", "package.json"].map(p => resolve(root, p))].sort();
  const h = createHash("sha256"); for (const f of files) h.update(relative(root, f)).update(readFileSync(f));
  invariant(h.digest("hex") === FROZEN_DIGEST && Bun.version === "1.4.3", "source/runtime version changed");
}
export function scan(db: Database, through = Number.MAX_SAFE_INTEGER) {
  checkIdentity(identity(db)); let previous: any, digest = "", count = 0, firstBlock = 0;
  for (const row of db.query("SELECT block,body,digest FROM frames WHERE block<=? ORDER BY block").iterate(through) as Iterable<Row>) {
    const f = JSON.parse(row.body); digest = sha(digest + row.body);
    invariant(row.digest === digest && row.block === f.block, "journal hash/row mismatch");
    if (previous) invariant(row.block === previous.block + 1 && f.parentHash === previous.blockHash && f.marketTs >= previous.marketTs && f.ts > previous.ts, "journal block/time chain mismatch");
    else { firstBlock = row.block; invariant(new Date(f.marketTs).toISOString() === START, "original market window changed"); }
    previous = f; count++;
  }
  invariant(previous, "empty journal is forbidden"); return { count, firstBlock, lastBlock: previous.block as number, lastDigest: digest, last: previous };
}
export function appendDelta(db: Database, part: Checkpoint, previousSequence: number) {
  invariant(part.version === 1 && part.kind === "delta" && part.sequence === previousSequence + 1 && part.identityValue === identity(db), "checkpoint identity/sequence mismatch");
  const last = db.query("SELECT block,body,digest FROM frames ORDER BY block DESC LIMIT 1").get() as Row;
  invariant(last.block === part.previousBlock && last.digest === part.previousDigest, "missing or overlapping checkpoint blocks");
  let previous = JSON.parse(last.body), digest = last.digest, block = last.block;
  db.transaction(() => {
    for (const row of part.rows ?? []) {
      const f = JSON.parse(row.body); digest = sha(digest + row.body);
      invariant(row.block === block + 1 && f.block === row.block && row.digest === digest && f.parentHash === previous.blockHash && f.marketTs >= previous.marketTs && f.ts > previous.ts, "checkpoint input integrity failure");
      db.query("INSERT INTO frames(block,body,digest) VALUES (?,?,?)").run(row.block, row.body, row.digest); previous = f; block = row.block;
    }
    invariant(block === part.lastBlock && digest === part.lastDigest, "checkpoint ending differs");
  })();
}
async function verify(root: string, state: string, report: any) {
  checkRuntime(root); const db = new Database(state, { readonly: true });
  const i = checkIdentity(identity(db)), journal = scan(db);
  invariant(report.liveTradingEnabled === false && report.startedAt === START && report.scheduledEndAt === END, "report paper/window guard differs");
  invariant(JSON.stringify(report.identity) === iString(i), "report identity differs");
  const { HoldingStudy } = await import(resolve(root, "src/research/holding-study.ts"));
  const { dec } = await import(resolve(root, "src/research/ledger.ts"));
  const study = new HoldingStudy(i.header, i.config); const halts = new Map<string, string>(); let digest = "";
  for (const row of db.query("SELECT body,digest FROM frames WHERE block<=? ORDER BY block").iterate(report.lastBlock) as Iterable<Row>) {
    study.step(JSON.parse(row.body)); digest = row.digest;
    const primary = study.primary, l = primary.ledger!;
    invariant(l.cash.gte(0) && l.mon.gte(0) && l.mon.add(primary.active?.side === "buy" ? primary.active.remaining : 0).add(primary.pending?.side === "buy" ? primary.pending.size : 0).lte(400), "primary spot/cap history failure");
    for (const [id, arm] of [["primary", primary], ...study.arms.map((a: any, n: number) => [String(n), a])] as [string, any][]) {
      if (halts.has(id)) invariant(arm.halted === halts.get(id), "risk halt was reset");
      if (arm.halted) halts.set(id, arm.halted);
      invariant(arm.ledger.cash.gte(0) && arm.ledger.mon.gte(0), "negative funded spot balance");
      if (id !== "primary") invariant(arm.ledger.mon.add(arm.entry?.remaining ?? 0).lte(400), "research position cap exceeded");
    }
  }
  const expected = study.report();
  for (const k of Object.keys(expected)) invariant(JSON.stringify(expected[k]) === JSON.stringify(report[k]), "deterministic report mismatch: " + k);
  invariant(digest === report.journalDigest && expected.frames === report.frames, "report journal prefix differs");
  invariant(dec(expected.primary.initialEquityUsd).add(expected.primary.netPnlUsd).eq(expected.primary.equityUsd), "net equity does not reconcile");
  db.close(); return { ...journal, last: undefined, exactReplay: true, riskHistoryVerified: true, halts: Object.fromEntries(halts) };
}
const iString = (i: any) => JSON.stringify(i);
async function api(path: string, init: RequestInit = {}) {
  invariant(process.env.GH_TOKEN, "cloud repository credential missing");
  const response = await fetch("https://api.github.com" + path, { ...init, headers: { Accept: "application/vnd.github+json", Authorization: "Bearer " + process.env.GH_TOKEN, "X-GitHub-Api-Version": "2022-11-28", ...init.headers }, signal: AbortSignal.timeout(90000) });
  invariant(response.ok, "GitHub request failed: " + response.status + " " + path); return response;
}
async function release(plan: Plan) {
  invariant(plan.repository === REPO && Number.isSafeInteger(plan.releaseId), "unexpected cloud repository");
  const repo = await (await api("/repos/" + REPO)).json() as any; invariant(repo.visibility === "public", "free standard runner requires public repository");
  const r = await (await api(`/repos/${REPO}/releases/${plan.releaseId}`)).json() as any;
  invariant(r.draft === true && r.assets.length < 900, "checkpoint release must stay private draft and bounded"); return r;
}
async function assets(plan: Plan) {
  await release(plan); const result: any[] = [];
  for (let page = 1; page <= 9; page++) {
    const items = await (await api(`/repos/${REPO}/releases/${plan.releaseId}/assets?per_page=100&page=${page}`)).json() as any[];
    result.push(...items); if (items.length < 100) return result;
  }
  throw Error("checkpoint asset bound exceeded");
}
async function download(id: number) { return Buffer.from(await (await api(`/repos/${REPO}/releases/assets/${id}`, { headers: { Accept: "application/octet-stream" } })).arrayBuffer()); }
async function uploadOnce(plan: Plan, name: string, data: Uint8Array, encryptionKey: Buffer) {
  invariant(data.length < 200_000_000, "encrypted checkpoint exceeds transport bound");
  const existing = (await assets(plan)).find(a => a.name === name);
  if (existing) { invariant(sha(unseal(await download(existing.id), encryptionKey)) === sha(unseal(data, encryptionKey)), "existing checkpoint conflicts; never overwrite"); return; }
  const response = await fetch(`https://uploads.github.com/repos/${REPO}/releases/${plan.releaseId}/assets?name=${encodeURIComponent(name)}`, { method: "POST", headers: { Authorization: "Bearer " + process.env.GH_TOKEN, "Content-Type": "application/octet-stream", "X-GitHub-Api-Version": "2022-11-28" }, body: Buffer.from(data), signal: AbortSignal.timeout(120000) });
  invariant(response.ok, "checkpoint upload failed: " + response.status);
  const saved = await response.json() as any;
  invariant(sha(await download(saved.id)) === sha(data), "uploaded checkpoint read-back differs");
}
async function upload(plan: Plan, name: string, data: Uint8Array, encryptionKey: Buffer) {
  let failure: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await uploadOnce(plan, name, data, encryptionKey); return; }
    catch (e) { failure = e; if (attempt < 2) await Bun.sleep(2000 * (attempt + 1)); }
  }
  throw failure;
}
async function restore(plan: Plan, state: string, reportPath: string, encryptionKey: Buffer) {
  invariant(!existsSync(state) && !existsSync(state + "-wal") && !existsSync(state + ".lock"), "restore destination must be new; never replace a journal");
  const list = await assets(plan), seedAsset = list.find(a => a.name === plan.seedName); invariant(seedAsset, "original seed missing; cannot start fresh");
  const encrypted = await download(seedAsset.id); invariant(sha(encrypted) === plan.seedSha256, "seed archive hash differs");
  const seed = JSON.parse(unseal(encrypted, encryptionKey).toString()) as Checkpoint;
  invariant(seed.version === 1 && seed.kind === "seed" && seed.sequence === 0 && seed.lastBlock === plan.minimumBlock && seed.database, "seed/cutover differs"); checkIdentity(seed.identityValue);
  mkdirSync(dirname(state), { recursive: true }); writeFileSync(state, Buffer.from(seed.database, "base64"), { flag: "wx", mode: 0o600 });
  const db = new Database(state); db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
  invariant(identity(db) === seed.identityValue, "seed identity differs"); const start = scan(db);
  invariant(start.lastBlock === seed.lastBlock && start.lastDigest === seed.lastDigest, "seed journal differs");
  let sequence = 0, report = seed.report, lastBlock = seed.lastBlock, lastDigest = seed.lastDigest;
  const prefix = plan.namespace + "-part-";
  const parts = list.filter(a => a.name.startsWith(prefix)).sort((a, b) => a.name.localeCompare(b.name));
  for (const asset of parts) {
    const part = JSON.parse(unseal(await download(asset.id), encryptionKey).toString()) as Checkpoint;
    invariant(asset.name === prefix + String(part.sequence).padStart(6, "0") + ".efc", "checkpoint asset name differs");
    appendDelta(db, part, sequence); sequence = part.sequence; report = part.report; lastBlock = part.lastBlock; lastDigest = part.lastDigest;
  }
  db.close(); saveJson(reportPath, report); return { sequence, lastBlock, lastDigest };
}
async function makeSeed(state: string, reportPath: string, out: string, encryptionKey: Buffer) {
  invariant(!existsSync(out), "refusing to replace a seed archive");
  const report = readJson(reportPath);
  const db = new Database(state, { readonly: true }); db.exec("BEGIN");
  const value = identity(db), journal = scan(db), bytes = db.serialize();
  invariant(report.lastBlock <= journal.lastBlock && report.identity.sourceDigest === FROZEN_DIGEST, "seed report/journal mismatch");
  const part: Checkpoint = { version: 1, kind: "seed", sequence: 0, identityValue: value, previousBlock: 0, previousDigest: "", lastBlock: journal.lastBlock, lastDigest: journal.lastDigest, database: Buffer.from(bytes).toString("base64"), report, savedAt: new Date().toISOString() };
  db.exec("COMMIT"); db.close(); const encrypted = seal(Buffer.from(JSON.stringify(part)), encryptionKey); writeFileSync(out, encrypted, { flag: "wx", mode: 0o600 });
  return { lastBlock: part.lastBlock, journalDigest: part.lastDigest, archiveSha256: sha(encrypted), bytes: encrypted.length };
}
async function segment(plan: Plan, root: string, state: string, reportPath: string, encryptionKey: Buffer) {
  invariant(plan.mode === "active" && process.env.GITHUB_ACTIONS === "true" && process.env.GITHUB_REPOSITORY === REPO, "active study may run only in the selected cloud workflow");
  let remote = await restore(plan, state, reportPath, encryptionKey);
  const audit = await verify(root, state, readJson(reportPath)); invariant(audit.lastBlock >= plan.minimumBlock, "cutover prefix missing");
  if (readJson(reportPath).runStatus === "completed") { console.log("Study already completed; no collector started."); return; }
  invariant(readJson(reportPath).runStatus !== "failed" && readJson(reportPath).lastError === null, "saved collector failure requires investigation; refusing automatic resume");
  const cleanEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", DRY_RUN: "true" };
  const log = Bun.file(resolve(dirname(state), "collector.log"));
  const child = Bun.spawn([process.execPath, "--no-env-file", "run", "scripts/multiday.ts", "--state", state, "--out", reportPath], { cwd: root, env: cleanEnv, stdin: "ignore", stdout: log, stderr: log });
  let stopped = false; const stop = async () => {
    if (stopped) return; stopped = true;
    if (child.exitCode === null) child.kill("SIGTERM");
    const ended = await Promise.race([child.exited.then(() => true), Bun.sleep(60000).then(() => false)]);
    invariant(ended, "collector did not stop; refusing to hand off a live writer");
  };
  const checkpoint = async () => {
    const report = readJson(reportPath), db = new Database(state, { readonly: true }); db.exec("BEGIN");
    invariant(report.processId === child.pid, "collector has not produced its own report");
    invariant(report.liveTradingEnabled === false && report.startedAt === START && report.scheduledEndAt === END, "collector safety report differs");
    const value = identity(db); checkIdentity(value);
    const prior = db.query("SELECT digest FROM frames WHERE block=?").get(remote.lastBlock) as { digest: string } | null;
    invariant(prior?.digest === remote.lastDigest, "remote journal prefix changed");
    const rows = db.query("SELECT block,body,digest FROM frames WHERE block>? ORDER BY block").all(remote.lastBlock) as Row[];
    const last = rows.at(-1); const prefix = db.query("SELECT digest FROM frames WHERE block=?").get(report.lastBlock) as { digest: string } | null;
    invariant(prefix?.digest === report.journalDigest, "snapshot report prefix differs");
    const part: Checkpoint = { version: 1, kind: "delta", sequence: remote.sequence + 1, identityValue: value, previousBlock: remote.lastBlock, previousDigest: remote.lastDigest, lastBlock: last?.block ?? remote.lastBlock, lastDigest: last?.digest ?? remote.lastDigest, rows, report, savedAt: new Date().toISOString() };
    db.exec("COMMIT"); db.close();
    await upload(plan, plan.namespace + "-part-" + String(part.sequence).padStart(6, "0") + ".efc", seal(Buffer.from(JSON.stringify(part)), encryptionKey), encryptionKey);
    remote = { sequence: part.sequence, lastBlock: part.lastBlock, lastDigest: part.lastDigest };
    console.log(JSON.stringify({ checkpoint: remote.sequence, lastBlock: remote.lastBlock, status: report.runStatus, liveTradingEnabled: false }));
  };
  let interrupted = false; process.on("SIGTERM", () => { interrupted = true; }); process.on("SIGINT", () => { interrupted = true; });
  const until = Date.now() + 270 * 60000; let nextSave = Date.now() + 60000;
  try {
    while (child.exitCode === null && Date.now() < until && !interrupted) {
      await Bun.sleep(5000);
      if (Date.now() >= nextSave) { await checkpoint(); nextSave = Date.now() + 15 * 60000; }
    }
    await stop(); const report = readJson(reportPath);
    invariant(report.processId === child.pid, "collector never produced its own report");
    await verify(root, state, report); await checkpoint();
    invariant(report.runStatus === "completed" || report.runStatus === "interrupted", "collector failed; next segment must not continue automatically");
    invariant(!interrupted, "workflow interrupted; saved checkpoint requires inspection before resuming");
    if (report.runStatus === "completed") console.log("Completed original 72-hour market window; replay, net accounting and risk history verified. No live trading or strategy promotion.");
  } finally { await stop(); }
}
async function main() {
  const [mode, ...rest] = process.argv.slice(2); const options: Record<string, string> = {};
  for (let n = 0; n < rest.length; n += 2) { invariant(rest[n]?.startsWith("--") && rest[n + 1], "expected --name value"); options[rest[n]!.slice(2)] = rest[n + 1]!; }
  const encryptionKey = key(options["key-file"]);
  if (mode === "seed") { console.log(JSON.stringify(await makeSeed(resolve(options.state!), options.report!, options.out!, encryptionKey))); return; }
  if (mode === "audit") { console.log(JSON.stringify(await verify(resolve(options.runtime!), resolve(options.state!), readJson(options.report!)))); return; }
  const plan = readJson(options.plan ?? "cloud-study-plan.json") as Plan;
  if (mode === "status") {
    const list = await assets(plan), parts = list.filter(a => a.name.startsWith(plan.namespace + "-part-")).sort((a, b) => a.name.localeCompare(b.name));
    const asset = parts.at(-1) ?? list.find(a => a.name === plan.seedName); invariant(asset, "study checkpoint unavailable");
    const part = JSON.parse(unseal(await download(asset.id), encryptionKey).toString()) as Checkpoint; checkIdentity(part.identityValue);
    saveJson(options.out!, { ...part.report, cloudCheckpoint: { sequence: part.sequence, savedAt: part.savedAt, lastBlock: part.lastBlock }, executionHost: "github-actions" }); return;
  }
  const state = resolve(options.state ?? "data/cloud/study.sqlite"), reportPath = resolve(options.report ?? "data/cloud/report.json"), root = resolve(options.runtime ?? "frozen-runtime");
  if (mode === "restore") { console.log(JSON.stringify(await restore(plan, state, reportPath, encryptionKey))); return; }
  if (mode === "preflight") {
    invariant(plan.mode === "preflight", "preflight plan required"); await restore(plan, state, reportPath, encryptionKey);
    const evidence = await verify(root, state, readJson(reportPath));
    const publicCheck = Bun.spawn([process.execPath, "--no-env-file", "-e", `
      import {rpc} from "./src/chain";import {config} from "./src/config";import {ethers} from "ethers";
      import {readBook,log10} from "./src/book";import {TradeFeed} from "./src/trades";import {completeTradePoll} from "./src/research/recording";
      const next=${evidence.lastBlock}+1,tag="0x"+next.toString(16);
      const b=await rpc("eth_getBlockByNumber",[tag,false],config.readRpcUrl);if(!b?.hash)throw Error("archive block unavailable");
      const iface=new ethers.utils.Interface(["function getMarketParams() view returns (uint32,uint96,address,uint256,address,uint256,uint32,uint96,uint96,uint256,uint256)"]);
      const raw=await rpc("eth_call",[{to:config.market,data:iface.encodeFunctionData("getMarketParams")},tag],config.readRpcUrl);
      const r=iface.decodeFunctionResult("getMarketParams",raw),params={pricePrecision:r[0],sizePrecision:r[1],tickSize:r[6]};
      const book=await readBook(config.readRpcUrl,config.market,params,{vault:true,blockTag:tag,timeoutMs:5000});
      const feed=new TradeFeed({market:config.market,url:config.readRpcUrl,sizeDec:log10(params.sizePrecision)});feed.lastBlock=next-1;await completeTradePoll(feed,next);
      if(book.block!==next||!book.levels.bids.length||!book.levels.asks.length)throw Error("archive book unavailable");
      console.log("Public archive block, fee parameters, vault book and complete trade logs available; no journal changed.");
    `], { cwd: root, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", DRY_RUN: "true" }, stdout: "pipe", stderr: "pipe" });
    const publicExit = await publicCheck.exited;
    invariant(publicExit === 0, "public archive data unavailable from cloud: " + (await new Response(publicCheck.stderr).text()).slice(-1500));
    console.log(JSON.stringify({ ...evidence, preflight: "passed", liveTradingEnabled: false })); return;
  }
  invariant(mode === "segment", "unknown cloud operation"); await segment(plan, root, state, reportPath, encryptionKey);
}
if (import.meta.main) main().catch(e => { console.error(e.message); process.exitCode = 1; });
