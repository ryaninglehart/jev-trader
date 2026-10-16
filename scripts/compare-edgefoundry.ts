import { Engine, midOf } from "../src/research/engine";
import { loadDataset } from "../src/research/dataset";
import { dec } from "../src/research/ledger";
import type { DatasetHeader, EngineConfig, Frame } from "../src/research/types";
import { args, output, protectOutput, settings } from "./research-args";

export function compareEdgeFoundry(header: DatasetHeader, frames: Frame[], config: EngineConfig, sha256: string, candidate?: EngineConfig, reference?: EngineConfig, evaluationRole: "replay" | "development" | "heldout" = "replay") {
  if (!config.economicGate?.enabled || !config.quotePolicy) throw new Error("EdgeFoundry comparison requires an enabled economic gate and explicit quote policy");
  if (reference && !candidate) throw new Error("reference requires a candidate");
  for (const trial of [candidate, reference]) if (trial) {
    if (trial.strategy !== "patient") throw new Error("candidate must use the patient strategy");
    for (const key of ["initialCashUsd", "initialMon", "orderSizeMon", "maxPositionMon", "maxLossUsd", "maxDrawdownPct", "minConfidence", "minSpreadBps", "maxSpreadBps", "latencyBlocks", "orderTtlBlocks", "decisionDeadlineMs", "queueFactor", "economicGate", "quotePolicy"] as const) {
      if (JSON.stringify(trial[key]) !== JSON.stringify(config[key])) throw new Error(`candidate must preserve baseline risk/cost controls: ${key}`);
    }
  }
  const run = (c: EngineConfig, h = header, data = frames) => {
    const engine = new Engine(h, c);
    const curve: { block: number; ts: number; netPnlUsd: string; costsUsd: string; inventoryMon: string }[] = [];
    const interval = Math.max(1, Math.ceil(data.length / 180));
    data.forEach((f, i) => {
      engine.step(f);
      if (i % interval === 0 || i === data.length - 1) {
        const r = engine.report(); curve.push({ block: f.block, ts: f.marketTs ?? f.ts, netPnlUsd: r.netPnlUsd, costsUsd: r.costs.totalUsd, inventoryMon: r.inventoryMon });
      }
    });
    return { ...engine.report(), curve };
  };
  const variants = (["momentum", "maker"] as const).flatMap((strategy) => [
    { id: `${strategy}-baseline`, label: "Original cadence", stage: "baseline", ...run({ ...config, strategy, economicGate: undefined, quotePolicy: undefined, orderTtlBlocks: 5 }) },
    { id: `${strategy}-churn`, label: "Fewer replacements", stage: "churn", ...run({ ...config, strategy, economicGate: undefined }) },
    { id: `${strategy}-edge`, label: "EdgeFoundry", stage: "edge", ...run({ ...config, strategy }) },
  ]);
  variants.push({ id: "hold", label: "Hold cash", stage: "hold", ...run({ ...config, strategy: "hold" }) });
  if (candidate) variants.push({ id: "patient-edge", label: "Patient candidate", stage: "edge", ...run(candidate) });
  if (reference) variants.push({ id: "patient-v1", label: "Patient v1 (archived)", stage: "reference", ...run(reference) });
  const c: EngineConfig = candidate ?? { ...config, strategy: "momentum" };
  const doubleGasHeader = { ...header, costs: { ...header.costs, gasPriceWei: dec(header.costs.gasPriceWei).mul(2).toString() } };
  return {
    schema: "edgefoundry-comparison-v1", name: "EdgeFoundry", liveTradingEnabled: false, evaluationRole,
    dataset: { sha256, dataKind: header.dataKind, source: header.source, market: header.market, frames: frames.length,
      firstBlock: frames[0]!.block, lastBlock: frames.at(-1)!.block,
      firstObservedAt: new Date(frames[0]!.ts).toISOString(), lastObservedAt: new Date(frames.at(-1)!.ts).toISOString(),
      durationSeconds: ((frames.at(-1)!.marketTs ?? frames.at(-1)!.ts) - (frames[0]!.marketTs ?? frames[0]!.ts)) / 1000,
      clock: frames[0]!.marketTs === undefined ? "collector observation time" : "canonical block timestamps (1-second resolution)",
      tradePrints: frames.reduce((n, f) => n + f.trades.length, 0),
      marketReturnPct: dec(midOf(frames.at(-1)!)).div(midOf(frames[0]!)).sub(1).mul(100).toString() },
    methodology: "Fixed configurations on identical recorded inputs and capital/risk limits. Original cadence uses 5-block TTL; reduced replacement and EdgeFoundry variants use the supplied TTL/policy. Optional patient candidate adds time-based trend/flow/depth eligibility and joins the touch; it must preserve all risk, size, gate, timing and quote-policy controls. This replay performs no automated parameter optimization; development data may inform later rule changes. Gate assumptions are uncalibrated. Net equity is marked to mid, not executable liquidation value. Quote costs/fills are simulated; this run cannot establish profitability.",
    sensitivityStrategy: c.strategy,
    researchTrials: { patientVariants: (candidate ? 1 : 0) + (reference ? 1 : 0), selection: "No winner selected or parameters optimized on this recording. Archived patient v1 is retained when supplied. All variant configurations are included in their reports." },
    jev: "Not run: no TypeSafe API key. These are deterministic baseline strategies, not Jev results.",
    variants,
    sensitivity: [
      { label: "Double gas", result: run(c, doubleGasHeader, frames.map((f) => f.gasPriceWei ? { ...f, gasPriceWei: dec(f.gasPriceWei).mul(2).toString() } : f)) },
      { label: "5 bps maker fee", result: run(c, { ...header, costs: { ...header.costs, makerFeeBps: "5" } }) },
      { label: "Double latency", result: run({ ...c, latencyBlocks: c.latencyBlocks * 2 }) },
      { label: "Double queue", result: run({ ...c, queueFactor: dec(c.queueFactor).mul(2).toString() }) },
    ],
  };
}

if (import.meta.main) {
  try {
    const a = args(["input", "config", "candidate", "reference", "role", "out"]);
    if (!a.input) throw new Error("usage: bun run edgefoundry:compare --input data/market.jsonl [--config edgefoundry.example.json] [--out data/edgefoundry.json]");
    protectOutput(a.out, [a.input, a.config ?? "edgefoundry.example.json", a.candidate, a.reference]);
    const role = a.role ?? "replay";
    if (!["replay", "development", "heldout"].includes(role)) throw new Error("role must be replay, development or heldout");
    const { header, frames, sha256 } = loadDataset(a.input);
    const { config } = settings(a.config ?? "edgefoundry.example.json");
    output(a.out, compareEdgeFoundry(header, frames, config, sha256, a.candidate ? settings(a.candidate).config : undefined, a.reference ? settings(a.reference).config : undefined, role as "replay" | "development" | "heldout"));
  } catch (e) { console.error((e as Error).message); process.exitCode = 1; }
}
