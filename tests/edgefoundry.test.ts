import { expect, test } from "bun:test";
import { Engine } from "../src/research/engine";
import { economicEstimate } from "../src/research/economics";
import { FillQualityTracker } from "../src/research/fill-quality";
import { defaultConfig, type DatasetHeader, type Frame, type EconomicGateConfig, type EngineConfig } from "../src/research/types";

const h: DatasetHeader = { kind: "dataset", version: 1, dataKind: "synthetic", source: "test", market: "test", chainId: 0, blockMs: 300, tickSize: "0.01", costs: { gasLimit: 100, gasPriceWei: "1000000000", makerFeeBps: "0", aiCostPerDecisionUsd: "0" } };
const g: EconomicGateConfig = { enabled: true, expectedFillFraction: "0.5", adverseSelectionBps: "1", exitFeeBps: "1", uncertaintyBps: "1", minNetEdgeUsd: "0.001", inferenceBudgetUsd: "0.001" };
const c: EngineConfig = { ...defaultConfig, strategy: "recorded", initialCashUsd: "1000", maxPositionMon: "20", orderSizeMon: "1", maxLossUsd: "10", maxDrawdownPct: 10, maxSpreadBps: 1000, orderTtlBlocks: 30, economicGate: g, quotePolicy: { minRestBlocks: 5, minRepriceBps: "5", minReplacementImprovementUsd: "0.001" } };
function f(block: number, overrides: Partial<Frame> = {}): Frame { return { kind: "frame", block, ts: block * 300, bids: [["99", "10"]], asks: [["101", "10"]], trades: [], decision: { action: "buy", confidence: 0.9, latencyMs: 0, costUsd: "0" }, ...overrides }; }

test("gate subtracts fill-weighted costs and unfilled placement/cancel costs exactly", () => {
  const x = economicEstimate(h, f(1), "buy", "99", "2", g);
  expect(x.expectedCaptureUsd).toBe("1");
  expect(x.expectedFeesUsd).toBe("0.0099");
  expect(x.gasBudgetUsd).toBe("0.00003");
  expect(x.expectedNetEdgeUsd).toBe("0.96907");
  expect(x.accepted).toBe(true);
  expect(economicEstimate(h, f(1), "sell", "101", "2", g).expectedCaptureUsd).toBe("1");
});
test("high costs block entry without booking hypothetical charges; AI incurred still charged", () => {
  const e = new Engine(h, { ...c, economicGate: { ...g, inferenceBudgetUsd: "10" } });
  e.step(f(1, { decision: { action: "buy", confidence: 1, latencyMs: 0, costUsd: "0.02" } }));
  expect(e.pending).toBeNull(); expect(e.report().economicGate.blocked).toBe(1);
  expect(e.report().netPnlUsd).toBe("-0.02"); expect(e.report().costs.gasUsd).toBe("0");
});
test("fill assumptions are explicit and model confidence cannot bypass the gate", () => {
  const e = new Engine(h, { ...c, economicGate: { ...g, expectedFillFraction: "0.000001" } });
  e.step(f(1, { decision: { action: "buy", confidence: 1, latencyMs: 0, costUsd: "0" } }));
  expect(e.report().attempts).toBe(0);
  expect(() => new Engine(h, { ...c, economicGate: { ...g, expectedFillFraction: "1.1" } })).toThrow("expectedFillFraction");
  expect(() => new Engine(h, { ...c, economicGate: { ...g, enabled: "true" } as any })).toThrow("boolean");
});
test("minimum rest preserves queue while TTL cancellation takes precedence", () => {
  const e = new Engine(h, { ...c, quoteInsideTicks: 0, orderTtlBlocks: 6 });
  e.step(f(1)); e.step(f(2));
  e.step(f(3, { bids: [["99.01", "10"]] }));
  expect(e.active!.price).toBe("99"); expect(e.active!.queueAhead).toBe("10"); expect(e.pending).toBeNull();
  for (let n = 4; n <= 8; n++) e.step(f(n));
  expect(e.pending!.side).toBeNull(); expect(e.report().quotePolicy.minimumRest).toBe(1);
});
test("small reprices are suppressed after minimum rest", () => {
  const e = new Engine(h, { ...c, quotePolicy: { ...c.quotePolicy!, minRestBlocks: 0 } });
  e.step(f(1)); e.step(f(2)); e.step(f(3, { bids: [["99.01", "10"]] }));
  expect(e.pending).toBeNull(); expect(e.report().quotePolicy.smallPriceMove).toBe(1);
});
test("replacement requires incremental economic improvement, not only entry profitability", () => {
  const e = new Engine(h, { ...c, quotePolicy: { ...c.quotePolicy!, minRestBlocks: 0, minRepriceBps: "0" } });
  e.step(f(1)); e.step(f(2)); e.step(f(3, { bids: [["99.2", "10"]], asks: [["101.2", "10"]] }));
  expect(e.pending).toBeNull(); expect(e.report().quotePolicy.insufficientImprovement).toBe(1);
});
test("adverse quotes cancel immediately despite minimum rest", () => {
  const e = new Engine(h, c); e.step(f(1)); e.step(f(2));
  e.step(f(3, { bids: [["98.99", "10"]], asks: [["99.02", "10"]] }));
  expect(e.pending!.side).toBeNull(); expect(e.report().quotePolicy.minimumRest).toBe(0);
});
test("risk halt and explicit hold override quote retention", () => {
  const e = new Engine(h, { ...c, initialMon: "1", maxLossUsd: "0.1" }); e.step(f(1)); e.step(f(2));
  e.step(f(3, { bids: [["98", "10"]], asks: [["100", "10"]] }));
  expect(e.halted).toBe("maximum loss"); expect(e.pending!.side).toBeNull();
  const hold = new Engine(h, c); hold.step(f(1)); hold.step(f(2)); hold.step(f(3, { decision: { action: "hold", confidence: 1, latencyMs: 0, costUsd: "0" } }));
  expect(hold.pending!.side).toBeNull();
});
test("markouts are signed and notional weighted for partial buy/sell fills; fees included once", () => {
  const q = new FillQualityTracker(); q.add(f(1), "buy", "99", "2", "10"); q.add(f(1), "sell", "101", "1", "10");
  q.observe(f(2, { ts: 1300, bids: [["100", "10"]], asks: [["102", "10"]] }));
  const r = q.report(); expect(r.horizons[0]!.measured).toBe(2); expect(r.horizons[0]!.grossUsd).toBe("4");
  expect(r.horizons[0]!.afterMakerFeeUsd).toBe("3.701");
  expect(r.horizons[1]!.censored).toBe(2); expect(r.horizons[1]!.notionalWeightedBps).toBeNull();
  expect(r.fills[0]!.markouts[0]!.observedAfterMs).toBe(1000);
});
test("late markouts are flagged; block time takes precedence over backfill observation speed", () => {
  const q = new FillQualityTracker(); q.add(f(1, { marketTs: 10000 }), "buy", "99", "1", "0");
  q.observe(f(2, { marketTs: 13000 }));
  expect(q.report().horizons[0]!.late).toBe(1); expect(q.report().horizons[0]!.measured).toBe(0);
  q.observe(f(3, { marketTs: 15000 }));
  expect(q.report().horizons[1]!.measured).toBe(1); expect(q.report().fills[0]!.clock).toBe("block");
});
test("future markouts cannot mutate earlier reports or gate decisions", () => {
  const e = new Engine(h, c); e.step(f(1)); e.step(f(2));
  e.step(f(3, { trades: [{ id: "fill", side: "sell", price: "99", size: "1" }] }));
  const old = e.report(), oldSerialized = JSON.stringify(old.fillQuality);
  const audit = structuredClone(old.economicGate.recentDecisions);
  e.step(f(4, { ts: 1900, bids: [["100", "10"]], asks: [["102", "10"]] }));
  expect(JSON.stringify(old.fillQuality)).toBe(oldSerialized);
  expect(e.report().economicGate.recentDecisions.slice(0, audit.length)).toEqual(audit);
  expect(e.report().fillQuality.horizons[0]!.measured).toBe(1);
});
test("mixed or backward market timestamps fail before state mutation", () => {
  const e = new Engine(h, c); e.step(f(1, { marketTs: 1000 }));
  expect(() => e.step(f(2))).toThrow("coverage");
  expect(() => e.step(f(2, { marketTs: 999 }))).toThrow("decrease");
  expect(e.report().frames).toBe(1);
});
test("pending inference cannot keep an adverse quote resting", () => {
  const e = new Engine(h, c); e.step(f(1)); e.step(f(2));
  e.step(f(3, { bids: [["98.98", "10"]], asks: [["99.03", "10"]], decision: { action: "hold", confidence: 0, latencyMs: 0, costUsd: "0", status: "pending" } }));
  expect(e.pending!.side).toBeNull();
});
