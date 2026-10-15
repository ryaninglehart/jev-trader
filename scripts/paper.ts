import { config as chainConfig } from "../src/config";
import { rpc } from "../src/chain";
import { Market } from "../src/market";
import { log10, readBook } from "../src/book";
import { TradeFeed } from "../src/trades";
import { PaperSession } from "../src/research/session";
import { invariant } from "../src/research/validation";
import { args, output, protectOutput, settings } from "./research-args";
import type { Frame } from "../src/research/types";
import { dec } from "../src/research/ledger";

let session: PaperSession | undefined;
let stopping = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });
try {
  const a = args(["config", "state", "blocks", "out"]);
  invariant(a.config && a.state, "usage: bun run paper --config research.example.json --state data/paper.jsonl [--blocks 1000] [--out data/paper-report.json]");
  protectOutput(a.out, [a.config, a.state]);
  invariant(chainConfig.dryRun, "Paper recorder requires DRY_RUN=true; it never accepts a live wallet");
  const { header, config } = settings(a.config);
  invariant(header.dataKind === "recorded", "paper collector requires recorded provenance");
  invariant(header.market.toLowerCase() === chainConfig.market.toLowerCase() && header.chainId === chainConfig.chainId, "dataset market/chain does not match RPC configuration");
  invariant(config.strategy !== "recorded", "AI replay requires previously recorded causal decisions; this collector supports deterministic strategies only");
  const blocks = Number(a.blocks ?? 1000);
  invariant(Number.isSafeInteger(blocks) && blocks >= 1 && blocks <= 1_000_000, "blocks must be 1..1000000");
  const market = new Market();
  await market.init(); // dry-run guard prevents deposits, approvals and transaction submission
  session = new PaperSession(a.state, header, config);
  const feed = new TradeFeed({ market: chainConfig.market, url: chainConfig.readRpcUrl, sizeDec: log10(market.params.sizePrecision) });
  if (session.lastFrame) feed.lastBlock = session.lastFrame.block;
  let next = session.lastFrame ? session.lastFrame.block + 1 : 0;
  let lastProgress = Date.now();
  let count = 0;
  while (!stopping && count < blocks) {
    const finalized = await rpc<{ number: string; timestamp: string } | null>("eth_getBlockByNumber", ["finalized", false], chainConfig.readRpcUrl);
    invariant(finalized, "RPC does not provide finalized blocks; refusing latest-head fallback");
    const head = parseInt(finalized.number, 16);
    invariant(Number.isSafeInteger(head) && head > 0, "invalid finalized head");
    if (next === 0) next = head;
    if (next > head) {
      invariant(Date.now() - lastProgress < 30_000, "finalized feed stalled for 30 seconds");
      await Bun.sleep(100);
      continue;
    }
    // Backfill every block on restart instead of silently skipping a gap.
    const tag = "0x" + next.toString(16);
    const [book, gasBlock] = await Promise.all([
      readBook(chainConfig.readRpcUrl, chainConfig.market, market.params, { vault: true, blockTag: tag, timeoutMs: 5000 }),
      rpc<{ baseFeePerGas?: string; hash: string; parentHash: string }>("eth_getBlockByNumber", [tag, false], chainConfig.readRpcUrl),
    ]);
    invariant(book.block === next, "RPC book snapshot block differs from requested finalized block");
    await feed.poll(next);
    invariant(feed.lastBlock === next, "trade log poll incomplete; refusing incomplete frame");
    const prints = feed.drainPrints().filter((p) => p.block === next);
    invariant(gasBlock?.baseFeePerGas, "block has no base fee; an explicit gas estimate cannot be computed");
    const gasPriceWei = (BigInt(gasBlock.baseFeePerGas) + BigInt(Math.round(chainConfig.priorityFeeGwei * 1e9))).toString();
    const frame: Frame = {
      kind: "frame", block: next, ts: Date.now(),
      blockHash: gasBlock.hash, parentHash: gasBlock.parentHash,
      bids: book.levels.bids.map(([p, s]) => [dec(p).toFixed(), dec(s).toFixed()]),
      asks: book.levels.asks.map(([p, s]) => [dec(p).toFixed(), dec(s).toFixed()]),
      trades: prints.map((p) => ({ id: p.id, side: p.side, price: dec(p.price).toFixed(), size: dec(p.size).toFixed() })), gasPriceWei,
    };
    session.step(frame);
    next++; count++; lastProgress = Date.now();
    if (count % 100 === 0) console.log(`Paper blocks ${count}; net P&L $${session.engine.report().netPnlUsd}`);
  }
  if (session.lastFrame) output(a.out, session.engine.report());
} catch (e) { console.error((e as Error).message); process.exitCode = 1; }
finally { session?.close(); }
