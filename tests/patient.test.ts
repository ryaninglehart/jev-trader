import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { patientIntent } from "../src/research/patient";
import { Engine } from "../src/research/engine";
import { PaperSession } from "../src/research/session";
import { liquidationEstimate } from "../src/research/liquidation";
import { compareEdgeFoundry } from "../scripts/compare-edgefoundry";
import { completeTradePoll } from "../src/research/recording";
import { SignalQualityTracker } from "../src/research/signal-quality";
import { defaultConfig, type DatasetHeader, type EngineConfig, type Frame } from "../src/research/types";

const h: DatasetHeader = { kind: "dataset", version: 1, dataKind: "synthetic", source: "patient tests", market: "test", chainId: 0, blockMs: 1000, tickSize: "0.01", costs: { gasLimit: 1, gasPriceWei: "1", makerFeeBps: "0", aiCostPerDecisionUsd: "0" } };
const c: EngineConfig = { ...defaultConfig, strategy: "patient", initialCashUsd: "10000", orderSizeMon: "1", maxPositionMon: "10", maxLossUsd: "10", maxDrawdownPct: 1, minSpreadBps: 0, quoteInsideTicks: 0,
  economicGate: { enabled: true, expectedFillFraction: "0.1", adverseSelectionBps: "0", exitFeeBps: "0", uncertaintyBps: "0", minNetEdgeUsd: "0", inferenceBudgetUsd: "0" },
  patient: { lookbackMs: 30000, shortLookbackMs: 5000, minFlowVolumeMon: "200", minFlowImbalance: "0.2", minBookImbalance: "0.15", minTrendBps: "1", maxTrendBps: "50", maxShortMoveBps: "20", depthLevels: 3 } };
function f(block: number, bearish = false): Frame {
  const bid = bearish ? 100 - block / 100 : 100 + block / 100, depth = bearish ? ["10", "30"] : ["30", "10"];
  return { kind: "frame", block, ts: block * 1000, marketTs: block * 1000,
    bids: [0, 1, 2].map((i) => [(bid - i / 100).toFixed(2), depth[0]!]),
    asks: [0, 1, 2].map((i) => [(bid + 0.02 + i / 100).toFixed(2), depth[1]!]),
    trades: block === 30 ? [{ id: `t${block}`, side: bearish ? "sell" : "buy", price: bid.toFixed(2), size: "400" }] : [] };
}
const history = (bearish = false) => Array.from({ length: 30 }, (_, i) => f(i + 1, bearish));

test("patient candidate waits for a complete time-based warmup", () => {
  expect(patientIntent(f(30), history().slice(0, -1), "0", c).signal?.reason).toBe("warmup");
  expect(patientIntent(f(31), history(), "0", c).action).toBe("buy");
});
test("aligned trend, actual volume and depth allow funded spot directions only", () => {
  const buy = patientIntent(f(31), history(), "0", c);
  expect(buy.signal?.reason).toBe("ready"); expect(buy.confidence).toBe(1);
  expect(buy.signal?.flowVolumeMon).toBe("400");
  expect(patientIntent(f(31, true), history(true), "1", c).action).toBe("sell");
  expect(patientIntent(f(31, true), history(true), "0", c).signal?.reason).toBe("spot_balance");
  expect(patientIntent(f(31), history(), "10", c).signal?.reason).toBe("spot_balance");
});
test("thin flow, missing depth and conflicting flow produce explained holds", () => {
  const noTrades = history().map((x) => ({ ...x, trades: [] }));
  expect(patientIntent(f(31), noTrades, "0", c).signal?.reason).toBe("thin_flow");
  const shallow = f(31); shallow.bids = shallow.bids.slice(0, 1);
  expect(patientIntent(shallow, history(), "0", c).signal?.reason).toBe("insufficient_depth");
  const conflicts = history().map((x) => ({ ...x, trades: x.trades.map((t) => ({ ...t, side: "sell" as const })) }));
  expect(patientIntent(f(31), conflicts, "0", c).signal?.reason).toBe("conflicting_signals");
});
test("fast markets are blocked independently of strong signal eligibility", () => {
  const fast = f(31); fast.bids = [["102", "90"], ["101.99", "30"], ["101.98", "30"]]; fast.asks = [["102.02", "10"], ["102.03", "10"], ["102.04", "10"]];
  expect(patientIntent(fast, history(), "0", c).signal?.reason).toBe("fast_market");
});
test("same-second earlier blocks contribute flow; future observations cannot alter decisions", () => {
  const past = history(); past.at(-1)!.marketTs = 31000;
  const a = patientIntent(f(31), past, "0", c);
  expect(a.action).toBe("buy");
  expect(patientIntent(f(31), [...past, f(100, true)], "0", c)).toEqual(a);
});
test("old flow is excluded by time rather than frame count", () => {
  const past = history(); past[0]!.trades = [{ id: "old", side: "buy", price: "100", size: "10000" }]; past[29]!.trades = [];
  expect(patientIntent(f(31), past, "0", c).signal?.reason).toBe("thin_flow");
});
test("v2 permits neutral depth but continues to veto materially opposing depth", () => {
  const neutral = f(31); neutral.bids.forEach((x) => x[1] = "10");
  expect(patientIntent(neutral, history(), "0", c).signal?.reason).toBe("conflicting_signals");
  const v2 = { ...c, patient: { ...c.patient!, bookPolicy: "veto_opposition" as const } };
  expect(patientIntent(neutral, history(), "0", v2).action).toBe("buy");
  neutral.asks.forEach((x) => x[1] = "30");
  expect(patientIntent(neutral, history(), "0", v2).signal?.reason).toBe("conflicting_signals");
});
test("signal eligibility cannot override economic costs or position risk", () => {
  const e = new Engine(h, { ...c, economicGate: { ...c.economicGate!, inferenceBudgetUsd: "100" } });
  for (let i = 1; i <= 31; i++) e.step(f(i));
  expect(e.report().strategyDiagnostics.counts.ready).toBe(1);
  expect(e.report().economicGate.blocked).toBe(1); expect(e.report().attempts).toBe(0);
  expect(e.report().netPnlUsd).toBe("0");
});
test("touch economics exposes cost infeasibility even before signals are ready", () => {
  const e = new Engine(h, { ...c, economicGate: { ...c.economicGate!, inferenceBudgetUsd: "100" } }); e.step(f(1));
  const r = e.report(); expect(r.economicGate.touchEconomics.quotesChecked).toBe(2);
  expect(r.economicGate.touchEconomics.quotesClearing).toBe(0);
  expect(Number(r.economicGate.touchEconomics.averageRequiredCaptureBps)).toBeGreaterThan(1000);
});
test("patient configuration cannot disable the cost gate or use malformed thresholds", () => {
  expect(() => new Engine(h, { ...c, economicGate: undefined })).toThrow("enabled economic gate");
  expect(() => new Engine(h, { ...c, patient: { ...c.patient!, minFlowImbalance: "1.1" } })).toThrow("thresholds");
  expect(() => new Engine(h, { ...c, patient: { ...c.patient!, shortLookbackMs: 30000 } })).toThrow("short lookback");
});
test("journal recovery restores time windows, diagnostics and cost accounting exactly", () => {
  const dir = mkdtempSync(join(tmpdir(), "patient-recovery-")), path = join(dir, "state.jsonl");
  try {
    const expected = new Engine(h, c), first = new PaperSession(path, h, c);
    for (let i = 1; i <= 31; i++) { expected.step(f(i)); first.step(f(i)); } first.close();
    const resumed = new PaperSession(path, h, c);
    for (let i = 32; i <= 65; i++) { expected.step(f(i)); resumed.step(f(i)); }
    expect(resumed.engine.report()).toEqual(expected.report());
    expect(resumed.engine.report().strategyDiagnostics.counts.warmup).toBe(30);
    resumed.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("depth-based exit value walks bids and includes fees, exit gas and prior provisions", () => {
  const frame = f(1); frame.bids = [["100", "1"], ["99", "1"], ["98", "10"]]; frame.asks = [["102", "1"]];
  const r = liquidationEstimate({ ...h, costs: { ...h.costs, gasLimit: 1000000, gasPriceWei: "1000000000" } }, frame, { ...c, economicGate: { ...c.economicGate!, exitFeeBps: "10" } }, "10", "3", "310", "0.2");
  expect(r.proceedsBeforeFeesUsd).toBe("297"); expect(r.exitFeeReserveUsd).toBe("0.297");
  expect(r.exitGasReserveUsd).toBe("0.101"); expect(r.netAfterExitUsd).toBe("-3.598");
  const missing = liquidationEstimate(h, frame, c, "10", "20", "2010", "0");
  expect(missing.equityAfterExitUsd).toBeNull(); expect(missing.uncoveredMon).toBe("8");
});
test("fixed candidate comparison rejects relaxed risk limits", () => {
  expect(() => compareEdgeFoundry(h, [f(1)], { ...c, quotePolicy: { minRestBlocks: 1, minRepriceBps: "1", minReplacementImprovementUsd: "0" } }, "test", { ...c, maxLossUsd: "100" })).toThrow("maxLossUsd");
});
test("market-log retries stay bounded and never skip incomplete blocks", async () => {
  let calls = 0; const pauses: number[] = [];
  const feed = { lastBlock: 10, async poll(block: number) { calls++; if (calls === 3) this.lastBlock = block; } };
  await completeTradePoll(feed, 11, async (ms) => { pauses.push(ms); });
  expect(calls).toBe(3); expect(pauses).toEqual([250, 500]); expect(feed.lastBlock).toBe(11);
  await expect(completeTradePoll({ lastBlock: 10, async poll() {} }, 11, async () => {})).rejects.toThrow("incomplete after bounded retries");
});
test("signal outcome diagnostics space samples, preserve causality and censor missing horizons", () => {
  const q = new SignalQualityTracker(); q.add(f(1), "buy"); q.add(f(2), "buy");
  const prefix = q.report(); expect(prefix.samples).toHaveLength(1); expect(prefix.horizons[0]!.averageSignedBps).toBeNull();
  q.observe(f(6)); expect(q.report().horizons[0]!.positive).toBe(1); expect(q.report().horizons[1]!.censored).toBe(1);
  q.add(f(31), "sell"); q.observe(f(31));
  expect(q.report().samples).toHaveLength(2); expect(prefix.samples[0]!.outcomes).toHaveLength(0);
  q.observe(f(40)); expect(q.report().horizons[0]!.late).toBe(1);
});
