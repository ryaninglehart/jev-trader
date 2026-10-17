import { loadDataset } from "../src/research/dataset";
import { PaperSession } from "../src/research/session";
import { args, output, protectOutput, settings } from "./research-args";
import { invariant } from "../src/research/validation";

try {
  const a = args(["input", "config", "state", "out"]);
  invariant(a.input && a.state, "usage: bun run paper:replay --input data/market.jsonl --state data/paper.jsonl [--config research.example.json]");
  protectOutput(a.out, [a.input, a.state, a.config ?? "research.example.json"]);
  const { header, frames } = loadDataset(a.input);
  const { config } = settings(a.config ?? "research.example.json");
  const session = new PaperSession(a.state, header, config);
  try {
    invariant(session.frames.length <= frames.length, "input is shorter than the saved session");
    for (let i = 0; i < session.frames.length; i++) invariant(JSON.stringify(frames[i]) === JSON.stringify(session.frames[i]), `input diverges from saved journal at frame ${i}`);
    for (const frame of frames.slice(session.frames.length)) session.step(frame);
    output(a.out, session.engine.report());
  } finally { session.close(); }
} catch (e) { console.error((e as Error).message); process.exitCode = 1; }
