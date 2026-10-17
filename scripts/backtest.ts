import { loadDataset } from "../src/research/dataset";
import { evaluate } from "../src/research/evaluate";
import { args, output, protectOutput, settings } from "./research-args";

try {
  const a = args(["input", "config", "out", "train-fraction"]);
  if (!a.input) throw new Error("usage: bun run backtest --input data/market.jsonl --config research.example.json [--out data/report.json]");
  protectOutput(a.out, [a.input, a.config ?? "research.example.json"]);
  const dataset = loadDataset(a.input);
  const { config } = settings(a.config ?? "research.example.json");
  output(a.out, { datasetSha256: dataset.sha256, ...evaluate(dataset.header, dataset.frames, config, Number(a["train-fraction"] ?? 0.7)) });
} catch (e) { console.error((e as Error).message); process.exitCode = 1; }
