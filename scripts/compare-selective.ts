import { Engine } from "../src/research/engine";
import { loadDataset } from "../src/research/dataset";
import { SelectiveCandidate } from "../src/research/selective";
import { args, output, protectOutput, settings } from "./research-args";

try {
  const a = args(["input", "config", "out"]);
  if (!a.input) throw new Error("usage: bun --no-env-file scripts/compare-selective.ts --input recorded.jsonl --config edgefoundry.patient.example.json --out report.json");
  protectOutput(a.out, [a.input, a.config ?? "edgefoundry.patient.example.json"]);
  const data = loadDataset(a.input), { config } = settings(a.config ?? "edgefoundry.patient.example.json");
  const baseline = new Engine(data.header, config), candidate = new SelectiveCandidate(data.header, config);
  for (const frame of data.frames) { baseline.step(frame); candidate.step(frame); }
  output(a.out, { schema: "edgefoundry-selective-comparison-v1", liveTradingEnabled: false, datasetSha256: data.sha256,
    evaluation: "Retrospective comparison on previously observed data, not a new forward test or untouched holdout. The running 72-hour study is unchanged. Both portfolios retain the economic gate and identical risk limits.",
    baseline: baseline.report(), candidate: candidate.report() });
} catch (e) { console.error((e as Error).message); process.exitCode = 1; }
