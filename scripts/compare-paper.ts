import { loadDataset } from "../src/research/dataset";
import { replay } from "../src/research/evaluate";
import { midOf } from "../src/research/engine";
import { dec } from "../src/research/ledger";
import { args, output, protectOutput, settings } from "./research-args";

try {
  const a = args(["input", "config", "out"]);
  if (!a.input) throw new Error("usage: bun run paper:compare --input data/market.jsonl [--config research.example.json] [--out data/comparison.json]");
  protectOutput(a.out, [a.input, a.config ?? "research.example.json"]);
  const { header, frames, sha256 } = loadDataset(a.input);
  const { config } = settings(a.config ?? "research.example.json");
  const strategies = ["hold", "maker", "momentum"] as const;
  const results = Object.fromEntries(strategies.map((strategy) => [strategy, replay(header, frames, { ...config, strategy })]));
  const spreads = frames.map((f) => dec(f.asks[0]![0]).sub(f.bids[0]![0]).div(midOf(f)).mul(10_000).toNumber()).sort((x, y) => x - y);
  const requests = frames.filter((f) => f.decision?.requestId);
  const terminal = header.terminalInferenceLiability?.requestIds ?? [];
  const jev = header.inference && (requests.length || terminal.length) ? {
    status: "recorded_decisions", requests: requests.length + terminal.length,
    result: replay(header, frames, { ...config, strategy: "recorded" }),
    latencyMs: requests.map((f) => f.decision!.latencyMs),
  } : { status: "not_run", reason: "This dataset contains no Jev service decisions; baseline results must not be labeled Jev performance.", requests: 0 };
  output(a.out, {
    datasetSha256: sha256, dataKind: header.dataKind, source: header.source, market: header.market,
    methodology: "Full-period comparison with supplied fixed settings; no parameter selection or retrospective tuning. Paper fills and costs remain explicit assumptions. Initial portfolio and risk settings are identical across baselines.",
    frames: frames.length, firstBlock: frames[0]!.block, lastBlock: frames.at(-1)!.block,
    firstObservedAt: new Date(frames[0]!.ts).toISOString(), lastObservedAt: new Date(frames.at(-1)!.ts).toISOString(),
    observedSeconds: (frames.at(-1)!.ts - frames[0]!.ts) / 1000,
    firstMid: midOf(frames[0]!), lastMid: midOf(frames.at(-1)!),
    marketReturnPct: dec(midOf(frames.at(-1)!)).div(midOf(frames[0]!)).sub(1).mul(100).toString(),
    tradePrints: frames.reduce((n, f) => n + f.trades.length, 0),
    spreadBps: { min: spreads[0], median: spreads[Math.floor(spreads.length / 2)], p95: spreads[Math.min(spreads.length - 1, Math.floor(spreads.length * 0.95))], max: spreads.at(-1) },
    liveTradingEnabled: false, jev, results,
    sensitivity: Object.fromEntries(strategies.map((strategy) => [strategy, {
      doubleGas: replay({ ...header, costs: { ...header.costs, gasPriceWei: dec(header.costs.gasPriceWei).mul(2).toString() } }, frames.map((f) => f.gasPriceWei ? { ...f, gasPriceWei: dec(f.gasPriceWei).mul(2).toString() } : f), { ...config, strategy }),
      makerFee1Bps: replay({ ...header, costs: { ...header.costs, makerFeeBps: "1" } }, frames, { ...config, strategy }),
      makerFee5Bps: replay({ ...header, costs: { ...header.costs, makerFeeBps: "5" } }, frames, { ...config, strategy }),
      doubleLatency: replay(header, frames, { ...config, strategy, latencyBlocks: config.latencyBlocks * 2 }),
      doubleQueue: replay(header, frames, { ...config, strategy, queueFactor: dec(config.queueFactor).mul(2).toString() }),
    }]))
  });
} catch (e) { console.error((e as Error).message); process.exitCode = 1; }
