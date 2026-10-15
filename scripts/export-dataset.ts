import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { args } from "./research-args";
import { parseDataset } from "../src/research/dataset";
import { invariant } from "../src/research/validation";

try {
  const a = args(["state", "out"]);
  invariant(a.state && a.out, "usage: bun run paper:export --state data/paper.jsonl --out data/market.jsonl");
  // Acquire the writer's lock rather than racing a check-then-read.
  const lock = a.state + ".lock";
  closeSync(openSync(lock, "wx", 0o600));
  try {
    const bytes = readFileSync(a.state, "utf8");
    invariant(bytes.endsWith("\n"), "incomplete journal; preserve it before repair");
    const rows = bytes.trimEnd().split("\n").map((l) => JSON.parse(l));
    const identity = rows.shift();
    invariant(identity.kind === "paper-session" && identity.version === 1, "unsupported journal");
    const content = [identity.header, ...rows].map((r) => JSON.stringify(r)).join("\n") + "\n";
    parseDataset(content);
    mkdirSync(dirname(a.out), { recursive: true });
    writeFileSync(a.out, content, { flag: "wx" });
    console.log(`Dataset: ${a.out}`);
  } finally { unlinkSync(lock); }
} catch (e) { console.error((e as Error).message); process.exitCode = 1; }
