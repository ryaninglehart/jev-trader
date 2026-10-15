import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = (script: string, ...args: string[]) => Bun.spawnSync([process.execPath, script, ...args], { timeout: 10_000 });

test("CLI replay resumes exactly and rejects a changed earlier observation without modifying state", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-cli-"));
  try {
    const state = join(dir, "paper.jsonl"), report = join(dir, "report.json");
    const args = ["--input", "fixtures/synthetic.jsonl", "--state", state, "--out", report];
    expect(run("scripts/paper-replay.ts", ...args).exitCode).toBe(0);
    const original = readFileSync(report, "utf8"), journal = readFileSync(state, "utf8");
    expect(run("scripts/paper-replay.ts", ...args).exitCode).toBe(0);
    expect(readFileSync(report, "utf8")).toBe(original);
    expect(readFileSync(state, "utf8")).toBe(journal);
    const rows = readFileSync("fixtures/synthetic.jsonl", "utf8").trimEnd().split("\n").map((l) => JSON.parse(l));
    rows[1].bids[0][1] = "501";
    const changed = join(dir, "changed.jsonl");
    writeFileSync(changed, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const rejected = run("scripts/paper-replay.ts", "--input", changed, "--state", state, "--out", report);
    expect(rejected.exitCode).not.toBe(0);
    expect(rejected.stderr.toString()).toContain("diverges");
    expect(readFileSync(state, "utf8")).toBe(journal);
    const overwrite = run("scripts/paper-replay.ts", "--input", "fixtures/synthetic.jsonl", "--state", state, "--out", state);
    expect(overwrite.exitCode).not.toBe(0);
    expect(readFileSync(state, "utf8")).toBe(journal);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CLI export yields the original dataset and refuses to overwrite an existing export", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-export-"));
  try {
    const state = join(dir, "paper.jsonl"), dataset = join(dir, "export.jsonl");
    expect(run("scripts/paper-replay.ts", "--input", "fixtures/synthetic.jsonl", "--state", state).exitCode).toBe(0);
    expect(run("scripts/export-dataset.ts", "--state", state, "--out", dataset).exitCode).toBe(0);
    expect(readFileSync(dataset, "utf8")).toBe(readFileSync("fixtures/synthetic.jsonl", "utf8"));
    expect(run("scripts/export-dataset.ts", "--state", state, "--out", dataset).exitCode).not.toBe(0);
    expect(readFileSync(dataset, "utf8")).toBe(readFileSync("fixtures/synthetic.jsonl", "utf8"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
