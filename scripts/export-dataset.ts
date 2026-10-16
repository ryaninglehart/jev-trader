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
  let inferenceLock: string | undefined;
  try {
    const bytes = readFileSync(a.state, "utf8");
    invariant(bytes.endsWith("\n"), "incomplete journal; preserve it before repair");
    const rows = bytes.trimEnd().split("\n").map((l) => JSON.parse(l));
    const identity = rows.shift();
    invariant(identity.kind === "paper-session" && identity.version === 1, "unsupported journal");
    if (identity.externalLedger) {
      invariant(identity.externalLedger.kind === "jev" && typeof identity.externalLedger.path === "string" && identity.header.inference, "unsupported external cost ledger");
      const path = identity.externalLedger.path as string;
      closeSync(openSync(path + ".lock", "wx", 0o600));
      inferenceLock = path + ".lock";
      const { readUnappliedInference } = await import("../src/research/jev-runner");
      const consumed = new Set<string>(rows.flatMap((f) => f.decision?.requestId ? [f.decision.requestId] : []));
      const extra = readUnappliedInference(path, identity.header.inference, consumed);
      if (extra.requestIds.length) identity.header.terminalInferenceLiability = { block: rows.at(-1)?.block, ...extra };
    }
    const content = [identity.header, ...rows].map((r) => JSON.stringify(r)).join("\n") + "\n";
    parseDataset(content);
    mkdirSync(dirname(a.out), { recursive: true });
    writeFileSync(a.out, content, { flag: "wx" });
    console.log(`Dataset: ${a.out}`);
  } finally { if (inferenceLock) unlinkSync(inferenceLock); unlinkSync(lock); }
} catch (e) { console.error((e as Error).message); process.exitCode = 1; }
