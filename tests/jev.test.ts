import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildJevState, createJevEvaluator, JEV_PROMPT_HASH, type JevAnswer, type JevEvaluator, type JevTransport } from "../src/research/jev";
import { JevRunner, withInferenceCosts } from "../src/research/jev-runner";
import { defaultConfig, type DatasetHeader, type EngineConfig, type Frame, type JevSettings } from "../src/research/types";
import { Engine } from "../src/research/engine";
import { dec } from "../src/research/ledger";
import { PaperSession } from "../src/research/session";
import { loadDataset } from "../src/research/dataset";
import { replay } from "../src/research/evaluate";

const settings: JevSettings = { modelId: "jev-latest", horizonBlocks: 100, timeoutMs: 500, maxSignalAgeBlocks: 3, requestEveryBlocks: 1, maxRequests: 10, maxEstimatedSpendUsd: "1", unknownCostReserveUsd: "0.001", inputUsdPerMTok: "0.042", outputUsdPerMTok: "0" };
const header: DatasetHeader = { kind: "dataset", version: 1, dataKind: "synthetic", source: "offline transport test, not a Jev service run", market: "test", chainId: 0, blockMs: 300, tickSize: "1", costs: { makerFeeBps: "0", gasLimit: 1, gasPriceWei: "1", aiCostPerDecisionUsd: "0" } };
const config: EngineConfig = { ...defaultConfig, strategy: "recorded", orderSizeMon: "1", maxPositionMon: "10", minSpreadBps: 0, maxSpreadBps: 1000, initialCashUsd: "1000", decisionDeadlineMs: 1000 };
const frame = (block: number): Frame => ({ kind: "frame", block, ts: block * 300, bids: [["100", "10"]], asks: [["102", "10"]], trades: [] });
const portfolio = { mon: "0", cash: "1000", restingBuy: "0", restingSell: "0" };
const state = (f = frame(1)) => buildJevState(f, [], portfolio, header, config, settings);
const answer: JevAnswer = { action: "buy", confidence: 0.9, modelId: "jev-test", inputTokens: 1000, outputTokens: 0 };
const transportOf = (fn: (...args: Parameters<JevTransport>) => ReturnType<JevTransport>): JevTransport => Object.assign(fn, { preconnect() {} });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const success = { model: "jev-test", answers: { direction: { type: "choice", choice: "buy", probabilities: { buy: 0.8, sell: 0.1, hold: 0.1 } } }, usage: { input_tokens: 1000, output_tokens: 0 } };

async function temporary(fn: (path: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "jev-inference-"));
  try { await fn(join(dir, "inference.jsonl")); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("real SDK transport uses TypeSafe evaluation, hold criteria, usage and no retries", async () => {
  let calls = 0;
  const transport = transportOf(async (url, init) => {
    calls++;
    expect(String(url)).toBe("https://api.typesafe.ai/v1/systemone");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer offline-test-key");
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe("jev-latest"); expect(body.state.block).toBe(1);
    expect(body.questions.direction.criteria.hold).toBeDefined();
    return response(success);
  });
  const evaluate = createJevEvaluator(settings, { apiKey: "offline-test-key", fetch: transport });
  expect(await evaluate(state(), new AbortController().signal)).toEqual({ action: "buy", confidence: 0.8, modelId: "jev-test", inputTokens: 1000, outputTokens: 0 });
  expect(calls).toBe(1);
});

test("SDK rejects invalid probabilities and does not retry provider errors", async () => {
  const bad = createJevEvaluator(settings, { apiKey: "offline-test-key", fetch: transportOf(async () => response({ ...success, answers: { direction: { ...success.answers.direction, probabilities: { buy: 1, sell: 1, hold: 1 } } } })) });
  await expect(bad(state(), new AbortController().signal)).rejects.toThrow();
  let calls = 0;
  const denied = createJevEvaluator(settings, { apiKey: "offline-test-key", fetch: transportOf(async () => { calls++; return response({ message: "unauthorized" }, 401); }) });
  await expect(denied(state(), new AbortController().signal)).rejects.toThrow();
  expect(calls).toBe(1);
});

test("state builder rejects future data and exposes funded spot constraints", () => {
  expect(() => buildJevState(frame(1), [frame(2)], portfolio, header, config, settings)).toThrow("future");
  expect(state().allowed).toEqual({ buy: true, sell: false });
});

test("single-flight replies become available only on a later frame and charge once", async () => temporary(async (path) => {
  let resolve!: (value: JevAnswer) => void;
  const evaluate: JevEvaluator = () => new Promise((r) => { resolve = r; });
  const ids = new Set<string>(), runner = new JevRunner(path, settings, evaluate, "test", ids);
  try {
    expect(runner.decision(frame(1), ids).status).toBe("pending");
    expect(runner.launch(frame(1), state(), ids)).toBe(true);
    expect(runner.launch(frame(2), state(frame(2)), ids)).toBe(false);
    expect(runner.decision(frame(2), ids).status).toBe("pending");
    resolve(answer); await runner.wait();
    const d = runner.decision(frame(3), ids);
    expect(d.action).toBe("buy"); expect(d.sourceBlock).toBe(1); expect(d.availableBlock).toBe(3);
    expect(d.costUsd).toBe("0.000042"); expect(d.costBasis).toBe("token_estimate");
    ids.add(d.requestId!);
    expect(runner.decision(frame(4), ids).requestId).toBeUndefined();
    expect(runner.audit(ids).unappliedUsd).toBe("0");
  } finally { await runner.close(); }
}));

test("late source decisions hold but their usage is charged", async () => temporary(async (path) => {
  const runner = new JevRunner(path, settings, async () => answer, "test", new Set());
  try {
    runner.launch(frame(1), state(), new Set()); await runner.wait();
    const d = runner.decision(frame(8), new Set());
    expect(d.status).toBe("stale"); expect(d.action).toBe("hold"); expect(d.costUsd).toBe("0.000042");
  } finally { await runner.close(); }
}));

test("hard timeout bounds an uncooperative transport and preserves unknown cost", async () => temporary(async (path) => {
  const runner = new JevRunner(path, { ...settings, timeoutMs: 15 }, () => new Promise(() => {}), "test", new Set());
  try {
    runner.launch(frame(1), state(), new Set()); await runner.wait();
    const d = runner.decision(frame(2), new Set());
    expect(d.status).toBe("timeout"); expect(d.action).toBe("hold");
    expect(d.costUsd).toBe("0.001"); expect(d.costBasis).toBe("unknown_reserve");
  } finally { await runner.close(); }
}));

test("missing usage is reserved rather than treated as a free API call", async () => temporary(async (path) => {
  const runner = new JevRunner(path, settings, async () => ({ action: "hold", confidence: 0.9, modelId: "jev-test" }), "test", new Set());
  try {
    runner.launch(frame(1), state(), new Set()); await runner.wait();
    expect(runner.decision(frame(2), new Set()).costBasis).toBe("unknown_reserve");
    expect(runner.audit(new Set()).unknownReserveUsd).toBe("0.001");
  } finally { await runner.close(); }
}));

test("authentication errors stop further calls and never persist the error body or key", async () => temporary(async (path) => {
  const runner = new JevRunner(path, settings, async () => { throw { statusCode: 401, message: "SECRET_DO_NOT_SAVE" }; }, "test", new Set());
  try {
    runner.launch(frame(1), state(), new Set()); await runner.wait();
    const d = runner.decision(frame(2), new Set());
    expect(d.status).toBe("error");
    const consumed = new Set([d.requestId!]);
    expect(runner.launch(frame(2), state(frame(2)), consumed)).toBe(false);
    expect(readFileSync(path, "utf8")).not.toContain("SECRET_DO_NOT_SAVE");
  } finally { await runner.close(); }
}));

test("budget and request cap persist across restarts", async () => temporary(async (path) => {
  const cap = { ...settings, maxRequests: 1 };
  const first = new JevRunner(path, cap, async () => answer, "test", new Set());
  first.launch(frame(1), state(), new Set()); await first.wait();
  const id = first.decision(frame(2), new Set()).requestId!; await first.close();
  const ids = new Set([id]), next = new JevRunner(path, cap, async () => { throw new Error("must not call"); }, "test", ids);
  try {
    expect(next.launch(frame(3), state(frame(3)), ids)).toBe(false);
    expect(next.decision(frame(3), ids).status).toBe("budget");
    expect(next.audit(ids).requests).toBe(1);
  } finally { await next.close(); }
}));

test("abandoned request recovery is conservative and does not resend or lose cost", async () => temporary(async (path) => {
  const first = new JevRunner(path, settings, async () => answer, "test", new Set()); await first.close();
  appendFileSync(path, JSON.stringify({ kind: "start", id: "crashed", sourceBlock: 1, startedAt: 1, stateHash: "00".repeat(32) }) + "\n");
  let calls = 0;
  const resumed = new JevRunner(path, settings, async () => { calls++; return answer; }, "test", new Set());
  try {
    const d = resumed.decision(frame(2), new Set());
    expect(d.status).toBe("recovered"); expect(d.action).toBe("hold"); expect(d.costUsd).toBe("0.001");
    expect(resumed.launch(frame(2), state(frame(2)), new Set())).toBe(false);
    expect(calls).toBe(0);
  } finally { await resumed.close(); }
}));

test("engine does not double-count elapsed inference or reuse a received response", () => {
  const e = new Engine(header, config);
  e.step({ ...frame(1), decision: { action: "hold", confidence: 0, latencyMs: 0, costUsd: "0", status: "pending" } });
  e.step({ ...frame(2), decision: { action: "buy", confidence: 0.9, latencyMs: 650, costUsd: "0.01", requestId: "once", status: "ok", sourceBlock: 1, availableBlock: 2 } });
  expect(e.pending!.applyBlock).toBe(3);
  e.step({ ...frame(3), decision: { action: "hold", confidence: 0, latencyMs: 0, costUsd: "0", status: "pending" } });
  expect(e.active).not.toBeNull(); expect(e.pending).toBeNull();
  expect(() => e.step({ ...frame(4), decision: { action: "buy", confidence: 0.9, latencyMs: 0, costUsd: "0.01", requestId: "once" } })).toThrow("twice");
  expect(() => e.step({ ...frame(4), decision: { action: "buy", confidence: 0.9, latencyMs: 0, sourceBlock: 5, availableBlock: 4 } })).toThrow("source observation");
});

test("unapplied inference costs reconcile into the final report", async () => temporary(async (path) => {
  const runner = new JevRunner(path, settings, async () => answer, "test", new Set());
  try {
    runner.launch(frame(1), state(), new Set()); await runner.wait();
    const e = new Engine(header, { ...config, strategy: "hold" }); e.step(frame(1));
    const report = withInferenceCosts(e.report(), runner.audit(new Set()));
    expect(report.costs.aiUsd).toBe("0.000042");
    expect(dec(report.grossPnlUsd).sub(report.costs.totalUsd).toString()).toBe(report.netPnlUsd);
    expect(dec(report.initialEquityUsd).add(report.netPnlUsd).toString()).toBe(report.equityUsd);
  } finally { await runner.close(); }
}));

test("online CLI refuses missing credentials before market I/O, journal creation or mock fallback", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-missing-")), statePath = join(dir, "paper.jsonl");
  try {
    const p = Bun.spawnSync([process.execPath, "scripts/paper.ts", "--config", "research.jev.example.json", "--state", statePath, "--blocks", "1"], { env: { ...process.env, TYPESAFE_AI_API_KEY: "", DRY_RUN: "true", RPC_URL: "http://127.0.0.1:1" }, timeout: 10_000 });
    expect(p.exitCode).not.toBe(0);
    expect(p.stderr.toString()).toContain("No mock fallback");
    expect(existsSync(statePath)).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 15_000);

test("unknown-cost spending budget stops additional requests, independently of request count", async () => temporary(async (path) => {
  const capped = { ...settings, maxEstimatedSpendUsd: "0.001" };
  const r = new JevRunner(path, capped, async () => ({ action: "hold", confidence: 0.9, modelId: "jev-test" }), "test", new Set());
  try {
    r.launch(frame(1), state(), new Set()); await r.wait();
    const d = r.decision(frame(2), new Set()), consumed = new Set([d.requestId!]);
    expect(r.launch(frame(2), state(frame(2)), consumed)).toBe(false);
    expect(r.audit(consumed).committedUsd).toBe("0.001");
  } finally { await r.close(); }
}));

test("corrupt token cost in a complete inference ledger fails closed", async () => temporary(async (path) => {
  const r = new JevRunner(path, settings, async () => answer, "test", new Set());
  r.launch(frame(1), state(), new Set()); await r.wait(); await r.close();
  const content = readFileSync(path, "utf8").replace('"costUsd":"0.000042"', '"costUsd":"0"');
  await Bun.write(path, content);
  expect(() => new JevRunner(path, settings, async () => answer, "test", new Set())).toThrow("differs from token usage");
  expect(existsSync(path + ".lock")).toBe(false);
}));

test("pending inference preserves a quote only until its TTL", () => {
  const e = new Engine(header, { ...config, orderTtlBlocks: 1 });
  const pending = { action: "hold" as const, confidence: 0, latencyMs: 0, costUsd: "0", status: "pending" as const };
  e.step({ ...frame(1), decision: pending });
  e.step({ ...frame(2), decision: { action: "buy", confidence: 0.9, latencyMs: 100, costUsd: "0", status: "ok", sourceBlock: 1, availableBlock: 2 } });
  e.step({ ...frame(3), decision: pending });
  expect(e.active).not.toBeNull(); expect(e.pending).toBeNull();
  e.step({ ...frame(4), decision: pending });
  expect(e.pending!.side).toBeNull(); expect(e.pending!.applyBlock).toBe(5);
});

test("exported replay retains final unapplied inference costs and keeps baselines free of AI charges", async () => temporary(async (path) => {
  const paperPath = path + ".paper", out = path + ".export";
  const h: DatasetHeader = { ...header, inference: { provider: "typesafe-ai", modelId: settings.modelId, promptHash: JEV_PROMPT_HASH, settings } };
  const paper = new PaperSession(paperPath, h, config, { kind: "jev", path });
  const r = new JevRunner(path, settings, async () => answer, "test", new Set());
  paper.step({ ...frame(1), decision: { action: "hold", confidence: 0, latencyMs: 0, costUsd: "0", status: "pending" } });
  r.launch(frame(1), state(), new Set()); await r.wait(); await r.close(); paper.close();
  const proc = Bun.spawnSync([process.execPath, "scripts/export-dataset.ts", "--state", paperPath, "--out", out], { timeout: 10_000 });
  expect(proc.exitCode).toBe(0);
  const data = loadDataset(out);
  expect(data.header.terminalInferenceLiability?.usd).toBe("0.000042");
  const result = replay(data.header, data.frames, config);
  expect(result.costs.aiUsd).toBe("0.000042"); expect(result.netPnlUsd).toBe("-0.000042");
  expect(replay(data.header, data.frames, { ...config, strategy: "hold" }).costs.aiUsd).toBe("0");
}), 15_000);
