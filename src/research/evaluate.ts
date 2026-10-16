import { Engine, midOf } from "./engine";
import { dec } from "./ledger";
import { invariant } from "./validation";
import type { DatasetHeader, EngineConfig, Frame } from "./types";

export function replay(header: DatasetHeader, frames: Frame[], config: EngineConfig, warmup: string[] = []) {
  const engine = new Engine(header, config, warmup);
  for (const f of frames) engine.step(f);
  return engine.report();
}

/** Single chronological development/test split; parameters never use test returns. */
export function evaluate(header: DatasetHeader, frames: Frame[], config: EngineConfig, trainFraction = 0.7) {
  invariant(Number.isFinite(trainFraction) && trainFraction >= 0.5 && trainFraction <= 0.9, "trainFraction must be 0.5..0.9");
  const split = Math.floor(frames.length * trainFraction);
  invariant(split >= 20 && frames.length - split >= 10, "need at least 20 development and 10 test frames");
  const development = frames.slice(0, split), test = frames.slice(split);
  const candidates = config.strategy === "momentum" ? [0.55, 0.6, 0.65, 0.7].map((minConfidence) => ({ ...config, minConfidence })) : [config];
  const ranked = candidates.map((c) => ({ config: c, report: replay(header, development, c) }))
    .sort((a, b) => dec(b.report.netPnlUsd).cmp(a.report.netPnlUsd));
  const selected = ranked[0]!;
  const warmup = development.slice(-100).map(midOf);
  const selectedTest = replay(header, test, selected.config, warmup);
  const baselines = ["hold", "maker"] as const;
  return {
    warning: header.dataKind === "synthetic" ? "SYNTHETIC FIXTURE: validates mechanics only; not trading performance evidence." : "Historical simulation with explicit assumptions; not evidence of future returns.",
    methodology: "Chronological development/test split. Select confidence on development net P&L only; restart test capital at the boundary with past prices as warmup. Test results must not be reused for tuning.",
    split: { developmentFrames: development.length, testFrames: test.length, testStartsAtBlock: test[0]!.block },
    development: ranked.map(({ config: c, report }) => ({ minConfidence: c.minConfidence, netPnlUsd: report.netPnlUsd })),
    selectedConfig: selected.config,
    test: selectedTest,
    baselines: Object.fromEntries(baselines.map((strategy) => [strategy, replay(header, test, { ...config, strategy }, warmup)])),
    sensitivity: {
      doubleGas: replay({ ...header, costs: { ...header.costs, gasPriceWei: dec(header.costs.gasPriceWei).mul(2).toString() } }, test.map((f) => f.gasPriceWei ? { ...f, gasPriceWei: dec(f.gasPriceWei).mul(2).toString() } : f), selected.config, warmup),
      doubleLatency: replay(header, test, { ...selected.config, latencyBlocks: selected.config.latencyBlocks * 2 }, warmup),
      doubleQueue: replay(header, test, { ...selected.config, queueFactor: dec(selected.config.queueFactor).mul(2).toString() }, warmup),
    },
  };
}
