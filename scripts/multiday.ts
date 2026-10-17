import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, relative } from "node:path";
import { ethers } from "ethers";
import { config as chain } from "../src/config";
import { rpc } from "../src/chain";
import { readBook, log10 } from "../src/book";
import { TradeFeed } from "../src/trades";
import { dec } from "../src/research/ledger";
import { completeTradePoll } from "../src/research/recording";
import { HoldingStudy, STUDY_PROTOCOL, STUDY_VERSION } from "../src/research/holding-study";
import { StudyStore } from "../src/research/study-store";
import { ENGINE_VERSION } from "../src/research/engine";
import { frameTime } from "../src/research/patient";
import { loadDataset } from "../src/research/dataset";
import { invariant } from "../src/research/validation";
import type { Frame } from "../src/research/types";
import { args, output, settings, protectOutput } from "./research-args";

const root = resolve(import.meta.dir, "..");
function sourceDigest() {
  const walk = (p: string): string[] => readdirSync(p, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(resolve(p, e.name)) : e.name.endsWith(".ts") ? [resolve(p, e.name)] : []);
  const files = [...walk(resolve(root, "src")), resolve(import.meta.filename), resolve(import.meta.dir, "research-args.ts"), resolve(root, "bun.lock"), resolve(root, "package.json")].sort();
  const hash = createHash("sha256"); for (const file of files) hash.update(relative(root, file)).update(readFileSync(file)); return hash.digest("hex");
}
const iface = new ethers.utils.Interface(["function getMarketParams() view returns (uint32,uint96,address,uint256,address,uint256,uint32,uint96,uint96,uint256,uint256)"]);
async function parameters(block: number) {
  const raw = await rpc<string>("eth_call", [{ to: chain.market, data: iface.encodeFunctionData("getMarketParams") }, "0x" + block.toString(16)], chain.readRpcUrl);
  const r = iface.decodeFunctionResult("getMarketParams", raw);
  return { pricePrecision: r[0], sizePrecision: r[1], tickSize: r[6],
    costs: { observedBlock: block, makerFeeBps: r[10].toString(), takerFeeBps: r[9].toString(), minSizeMon: dec(r[7].toString()).div(r[1].toString()).toString() } };
}
let stopping = false, store: StudyStore | undefined, study: HoldingStudy | undefined;
let reportPath: string | undefined, runStatus = "starting", lastError: string | null = null, errors = 0, identity: unknown;
process.on("SIGINT", () => { stopping = true; }); process.on("SIGTERM", () => { stopping = true; });
function save() {
  if (study?.last) output(reportPath, { ...study.report(), runStatus, updatedAt: new Date().toISOString(),
    feedLagSeconds: runStatus === "development-replay" ? null : Math.max(0, (Date.now() - frameTime(study.last)) / 1000), lastError, transientErrorsThisRun: errors,
    journalDigest: store?.sha256 ?? null, identity, processId: process.pid,
    scheduledEndAt: new Date(frameTime(study.first!) + STUDY_PROTOCOL.durationMs).toISOString() });
}
try {
  const a = args(["config", "state", "out", "input", "max-frames"]);
  invariant(a.out && (a.state || a.input), "usage: bun run study --state data/study.sqlite --out data/study.json [--config edgefoundry.patient.example.json]");
  reportPath = a.out; protectOutput(a.out, [a.state, a.input, a.config ?? "edgefoundry.patient.example.json"]);
  const { header, config, jev } = settings(a.config ?? "edgefoundry.patient.example.json");
  invariant(!jev && config.strategy === "patient", "study uses deterministic paper strategies only");
  const frozen = sourceDigest(); identity = { studyVersion: STUDY_VERSION, engineVersion: ENGINE_VERSION, sourceDigest: frozen, header, config, protocol: STUDY_PROTOCOL };
  study = new HoldingStudy(header, config);
  if (a.input) {
    invariant(!a.state && !a["max-frames"], "offline replay must not write to an online journal");
    const data = loadDataset(a.input); study = new HoldingStudy(data.header, config);
    identity = { ...identity as object, datasetSha256: data.sha256, evaluationRole: "development-replay" };
    for (const frame of data.frames) study.step(frame);
    runStatus = "development-replay"; save();
  } else {
    invariant(process.env.DRY_RUN === "true", "DRY_RUN=true is required; no wallet or submission code is imported");
    invariant(header.dataKind === "recorded" && header.chainId === chain.chainId && header.market.toLowerCase() === chain.market.toLowerCase(), "market/chain configuration mismatch");
    invariant(Number(BigInt(await rpc<string>("eth_chainId", [], chain.readRpcUrl))) === header.chainId, "RPC chain differs from study");
    // The collector deliberately has no Market, Wallet, signer, order-submission or Jev dependency.
    store = new StudyStore(a.state!, identity);
    for (const frame of store.replay()) study.step(frame);
    const limit = a["max-frames"] ? Number(a["max-frames"]) : Infinity;
    invariant(limit === Infinity || (Number.isSafeInteger(limit) && limit > 0), "invalid max-frames");
    let count = 0, cachedHead = 0, next = study.last ? study.last.block + 1 : 0;
    let params: Awaited<ReturnType<typeof parameters>> | undefined, feed: TradeFeed | undefined;
    let lastSave = 0, retry = 0, lastProgress = Date.now();
    runStatus = "running";
    while (!stopping && count < limit && (!study.first || study.last!.marketTs! - study.first.marketTs! < STUDY_PROTOCOL.durationMs)) {
      let frame: Frame;
      try {
        if (next === 0 || next > cachedHead) {
          const head = await rpc<{ number: string } | null>("eth_getBlockByNumber", ["finalized", false], chain.readRpcUrl);
          invariant(head, "finalized block unavailable"); cachedHead = Number(BigInt(head.number)); next ||= cachedHead;
          if (next > cachedHead) { invariant(Date.now() - lastProgress < 30000, "finalized feed stalled"); await Bun.sleep(300); continue; }
        }
        if (!params || next - params.costs.observedBlock >= 200) {
          const fresh = await parameters(next);
          invariant(!params || fresh.sizePrecision.toString() === params.sizePrecision.toString(), "market size precision changed"); params = fresh;
        }
        invariant(dec(params.tickSize.toString()).div(params.pricePrecision.toString()).eq(header.tickSize), "market tick changed");
        invariant(dec(config.orderSizeMon).gte(params.costs.minSizeMon), "market minimum order exceeds fixed size");
        if (!feed) { feed = new TradeFeed({ market: chain.market, url: chain.readRpcUrl, sizeDec: log10(params.sizePrecision) }); feed.lastBlock = next - 1; }
        const tag = "0x" + next.toString(16);
        const [book, block] = await Promise.all([
          readBook(chain.readRpcUrl, chain.market, params, { vault: true, blockTag: tag, timeoutMs: 5000 }),
          rpc<{ baseFeePerGas: string; hash: string; parentHash: string; timestamp: string }>("eth_getBlockByNumber", [tag, false], chain.readRpcUrl),
        ]);
        invariant(book.block === next && block?.baseFeePerGas, "incomplete finalized block observation");
        await completeTradePoll(feed, next);
        frame = { kind: "frame", block: next, ts: Math.max(Date.now(), (study.last?.ts ?? 0) + 1), marketTs: Number(BigInt(block.timestamp)) * 1000,
          blockHash: block.hash, parentHash: block.parentHash, bids: book.levels.bids.map(([p, s]) => [dec(p).toFixed(), dec(s).toFixed()]),
          asks: book.levels.asks.map(([p, s]) => [dec(p).toFixed(), dec(s).toFixed()]),
          trades: feed.drainPrints().filter((p) => p.block === next).map((p) => ({ id: p.id, side: p.side, price: dec(p.price).toFixed(), size: dec(p.size).toFixed() })),
          gasPriceWei: (BigInt(block.baseFeePerGas) + 2_000_000_000n).toString(), marketCosts: params.costs };
      } catch (e) {
        errors++; retry++; lastError = (e as Error).message; runStatus = "retrying"; save();
        if (retry >= 20) throw new Error("20 consecutive acquisition failures: " + lastError);
        await Bun.sleep(Math.min(60000, 1000 * 2 ** Math.min(retry, 6))); continue;
      }
      study.primary.validate(frame); store.append(frame); study.step(frame); next++; count++; retry = 0; lastError = null; runStatus = "running"; lastProgress = Date.now();
      if (Date.now() - lastSave > 60000 || count === 1) {
        invariant(sourceDigest() === frozen, "source changed during frozen study");
        invariant(statSync(a.state!).size < STUDY_PROTOCOL.maxBytes, "study disk budget exceeded");
        save(); lastSave = Date.now(); store.db.exec("PRAGMA wal_checkpoint(PASSIVE)");
      }
    }
    runStatus = study.first && study.last!.marketTs! - study.first.marketTs! >= STUDY_PROTOCOL.durationMs ? "completed" : "interrupted"; save();
  }
} catch (e) { runStatus = "failed"; lastError = (e as Error).message; console.error(lastError); process.exitCode = 1; save(); }
finally { store?.close(); }
