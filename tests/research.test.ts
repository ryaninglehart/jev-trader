import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Ledger, dec } from "../src/research/ledger";
import { Engine } from "../src/research/engine";
import { PaperSession } from "../src/research/session";
import { loadDataset } from "../src/research/dataset";
import { evaluate, replay } from "../src/research/evaluate";
import { defaultConfig, type DatasetHeader, type EngineConfig, type Frame } from "../src/research/types";

const header: DatasetHeader = {
  kind: "dataset", version: 1, dataKind: "synthetic", source: "unit test", market: "test", chainId: 0,
  blockMs: 300, tickSize: "1",
  costs: { makerFeeBps: "10", gasLimit: 350000, gasPriceWei: "102000000000", aiCostPerDecisionUsd: "0.01" },
};
const config: EngineConfig = {
  ...defaultConfig, strategy: "recorded", initialCashUsd: "10000", orderSizeMon: "1", maxPositionMon: "10",
  maxLossUsd: "1000", maxDrawdownPct: 100, minSpreadBps: 0, maxSpreadBps: 1000,
};
function frame(block: number, options: Partial<Frame> = {}): Frame {
  return { kind: "frame", block, ts: block * 300, bids: [["100", "10"], ["99", "20"]], asks: [["102", "10"], ["103", "20"]], trades: [], decision: { action: "buy", confidence: 0.9, latencyMs: 0, costUsd: "0" }, ...options };
}
const print = (id: string, price: string, size: string) => ({ id, side: "sell" as const, price, size });

describe("cost and equity accounting", () => {
  test("partial close reconciles cash, basis, fees, gas and AI exactly", () => {
    const l = new Ledger("100", "0", "0.02");
    l.fill("buy", "200", "0.02", "10");
    l.fill("sell", "100", "0.021", "10");
    l.gas(350000, "102000000000", "0.02");
    l.ai("0.01");
    expect(l.mon.toString()).toBe("100");
    expect(l.costBasis.toString()).toBe("2");
    expect(l.realizedUsd.toString()).toBe("0.1");
    expect(l.makerFeesUsd.toString()).toBe("0.0061");
    expect(l.gasMon.toString()).toBe("0.0357");
    expect(l.gasUsd.toString()).toBe("0.000714");
    expect(l.net("0.021").toString()).toBe("0.183186");
    expect(l.gross("0.021").toString()).toBe("0.2");
    expect(l.gross("0.021").sub(l.costs()).eq(l.net("0.021"))).toBe(true);
  });
  test("historical gas cost is not repriced at the newest MON price", () => {
    const l = new Ledger("100", "0", "1");
    l.gas(350000, "102000000000", "1"); l.gas(350000, "102000000000", "2");
    expect(l.gasUsd.toString()).toBe("0.1071");
    expect(l.net("3").toString()).toBe("-0.1071");
  });
  test("initial holdings, rebates and fractional quantities reconcile", () => {
    const l = new Ledger("10", "0.3", "2");
    l.fill("sell", "0.1", "3", "-1");
    expect(l.mon.toString()).toBe("0.2");
    expect(l.net("3").toString()).toBe("0.30003");
    expect(l.gross("3").toString()).toBe("0.3");
  });
  test("spot balances cannot become a synthetic short", () => {
    const l = new Ledger("1", "0", "1");
    expect(() => l.fill("sell", "1", "1", "0")).toThrow("inventory");
    expect(() => l.fill("buy", "1", "1", "1")).toThrow("cash");
  });
});

describe("causal execution and risk", () => {
  test("new orders cannot fill in the decision or inclusion block", () => {
    const e = new Engine(header, config);
    e.step(frame(1, { trades: [print("1", "100", "10")] }));
    e.step(frame(2, { trades: [print("2", "100", "10")] }));
    expect(e.ledger!.mon.toString()).toBe("0");
    e.step(frame(3, { trades: [print("3", "101", "0.5")] }));
    expect(e.ledger!.mon.toString()).toBe("0.5");
    expect(e.active!.remaining).toBe("0.5");
  });
  test("queue-ahead volume is consumed before partial fills", () => {
    const e = new Engine(header, { ...config, quoteInsideTicks: 0, orderSizeMon: "3" });
    e.step(frame(1)); e.step(frame(2));
    e.step(frame(3, { trades: [print("3", "100", "6")] }));
    expect(e.ledger!.mon.toString()).toBe("0"); expect(e.active!.queueAhead).toBe("4");
    e.step(frame(4, { trades: [print("4", "100", "6")] }));
    expect(e.ledger!.mon.toString()).toBe("2"); expect(e.active!.remaining).toBe("1");
  });
  test("post-only reverts cost gas and leave the old order resting", () => {
    const e = new Engine(header, config);
    e.step(frame(1)); e.step(frame(2));
    e.step(frame(3, { bids: [["101", "10"]], asks: [["103", "10"]] }));
    e.step(frame(4, { bids: [["99", "10"]], asks: [["100", "10"]] }));
    expect(e.report().rejected).toBe(1);
    expect(e.active!.price).toBe("101");
    expect(e.ledger!.gasMon.toString()).toBe("0.0714");
  });
  test("unfilled orders and delayed cancellation both cost gas", () => {
    const e = new Engine(header, config);
    e.step(frame(1)); e.step(frame(2));
    e.step(frame(3, { decision: { action: "hold", confidence: 1, latencyMs: 0 } }));
    expect(e.active).not.toBeNull();
    e.step(frame(4, { decision: { action: "hold", confidence: 1, latencyMs: 0 } }));
    expect(e.active).toBeNull();
    expect(e.report().fills).toBe(0);
    expect(e.ledger!.gasMon.toString()).toBe("0.0714");
    expect(e.ledger!.aiUsd.toString()).toBe("0.02");
  });
  test("a full fill racing an atomic cancellation causes a charged revert", () => {
    const e = new Engine(header, config);
    e.step(frame(1)); e.step(frame(2));
    e.step(frame(3, { decision: { action: "hold", confidence: 1, latencyMs: 0, costUsd: "0" } }));
    e.step(frame(4, { trades: [print("race", "101", "1")], decision: { action: "hold", confidence: 1, latencyMs: 0, costUsd: "0" } }));
    expect(e.report().rejected).toBe(1);
    expect(e.ledger!.gasMon.toString()).toBe("0.0714");
    expect(e.ledger!.mon.toString()).toBe("1");
    expect(e.active).toBeNull();
    expect(e.executions.find((x) => x.type === "rejected")?.reason).toBe("cancel target already filled");
  });
  test("terminal cancellation is provisioned once, not twice", () => {
    const e = new Engine(header, config);
    e.step(frame(1)); e.step(frame(2));
    e.step(frame(3, { decision: { action: "hold", confidence: 1, latencyMs: 0, costUsd: "0" } }));
    expect(e.report().costs.gasReserveUsd).toBe("3.6057");
  });
  test("late or weak decisions do not submit; AI calls still cost money", () => {
    const e = new Engine(header, config);
    e.step(frame(1, { decision: { action: "buy", confidence: 0.99, latencyMs: 500, costUsd: "0.02" } }));
    e.step(frame(2, { decision: { action: "buy", confidence: 0.51, latencyMs: 0, costUsd: "0.03" } }));
    expect(e.report().attempts).toBe(0);
    expect(e.report().netPnlUsd).toBe("-0.05");
  });
  test("position cap covers old and replacement orders, without canceling an unchanged safe quote", () => {
    const e = new Engine(header, { ...config, maxPositionMon: "1" });
    e.step(frame(1)); e.step(frame(2));
    expect(e.pending).toBeNull(); expect(e.active!.price).toBe("101");
    e.step(frame(3, { bids: [["101", "10"]], asks: [["103", "10"]] }));
    expect(e.pending!.side).toBeNull();
    expect(e.report().inventoryMon).toBe("0");
  });
  test("loss halt is sticky and cancels outstanding exposure", () => {
    const e = new Engine(header, { ...config, initialMon: "1", maxLossUsd: "10" });
    e.step(frame(1)); e.step(frame(2));
    e.step(frame(3, { bids: [["90", "10"]], asks: [["92", "10"]] }));
    expect(e.halted).toBe("maximum loss"); expect(e.pending!.side).toBeNull();
    e.step(frame(4)); expect(e.halted).toBe("maximum loss"); expect(e.active).toBeNull();
  });
  test("outstanding terminal intent has a gas provision and report identity holds", () => {
    const e = new Engine(header, config); e.step(frame(1));
    const r = e.report();
    expect(r.costs.gasReserveUsd).toBe("7.2114");
    expect(dec(r.grossPnlUsd).sub(r.costs.totalUsd).toString()).toBe(r.netPnlUsd);
    expect(dec(r.initialEquityUsd).add(r.netPnlUsd).toString()).toBe(r.equityUsd);
  });
  test("future data cannot change earlier executions", () => {
    const a = new Engine(header, config), b = new Engine(header, config);
    for (const f of [frame(1), frame(2), frame(3)]) { a.step(f); b.step(structuredClone(f)); }
    const prefix = structuredClone(a.executions);
    b.step(frame(4, { bids: [["500", "1"]], asks: [["501", "1"]] }));
    expect(b.executions.slice(0, prefix.length)).toEqual(prefix);
  });
});

describe("data integrity and recovery", () => {
  test("rejects gaps, duplicate prints, crossed books and nonfinite inputs before mutation", () => {
    const e = new Engine(header, config); e.step(frame(1, { trades: [print("same", "100", "1")] }));
    expect(() => e.step(frame(3))).toThrow("block");
    expect(() => e.step(frame(2, { trades: [print("same", "100", "1")] }))).toThrow("replayed");
    expect(() => e.step(frame(2, { asks: [["99", "1"]] }))).toThrow("crossed");
    expect(() => e.step(frame(2, { gasPriceWei: "NaN" }))).toThrow("decimal");
    expect(e.report().frames).toBe(1);
  });
  test("rejects absent explicit costs and invalid risk settings", () => {
    expect(() => new Engine({ ...header, costs: undefined } as any, config)).toThrow("gasLimit");
    expect(() => new Engine(header, { ...config, latencyBlocks: 0 })).toThrow("latencyBlocks");
    expect(() => new Engine(header, { ...config, minConfidence: NaN })).toThrow("minConfidence");
  });
  test("recorded data requires canonical block identities and tick-aligned books", () => {
    const e = new Engine({ ...header, dataKind: "recorded" }, config);
    expect(() => e.step(frame(1))).toThrow("canonical block hashes");
    e.step(frame(1, { blockHash: "0x" + "11".repeat(32), parentHash: "0x" + "00".repeat(32) }));
    expect(() => e.step(frame(2, { blockHash: "0x" + "22".repeat(32), parentHash: "0x" + "00".repeat(32) }))).toThrow("continuity");
    const synthetic = new Engine(header, config);
    expect(() => synthetic.step(frame(1, { bids: [["100.1", "10"]] }))).toThrow("tick aligned");
  });
  test("restart restores costs, partial fills and pending cancellations exactly; rejects two writers", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-test-")), path = join(dir, "paper.jsonl");
    try {
      const uninterrupted = new Engine(header, config);
      const frames = [frame(1), frame(2), frame(3, { trades: [print("3", "101", "0.5")], decision: { action: "hold", confidence: 1, latencyMs: 0 } }), frame(4)];
      const first = new PaperSession(path, header, config);
      expect(() => new PaperSession(path, header, config)).toThrow();
      for (const f of frames.slice(0, 3)) first.step(f);
      first.close();
      const resumed = new PaperSession(path, header, config);
      resumed.step(frames[3]!);
      for (const f of frames) uninterrupted.step(f);
      expect(resumed.engine.report()).toEqual(uninterrupted.report());
      resumed.close();
      expect(() => new PaperSession(path, header, { ...config, minConfidence: 0.8 })).toThrow("configuration changed");
      expect(existsSync(path + ".lock")).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("a frame fsynced before a crash is recovered, but a truncated write fails closed", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-crash-")), path = join(dir, "paper.jsonl");
    try {
      const first = new PaperSession(path, header, config); first.step(frame(1)); first.close();
      appendFileSync(path, JSON.stringify(frame(2)) + "\n");
      const resumed = new PaperSession(path, header, config);
      expect(resumed.engine.report().frames).toBe(2); resumed.close();
      appendFileSync(path, '{"kind":');
      expect(() => new PaperSession(path, header, config)).toThrow("incomplete journal");
      expect(existsSync(path + ".lock")).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("dataset loader rejects duplicate log identity across blocks", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-input-")), path = join(dir, "bad.jsonl");
    try {
      writeFileSync(path, [header, frame(1, { trades: [print("x", "100", "1")] }), frame(2, { trades: [print("x", "100", "1")] })].map((x) => JSON.stringify(x)).join("\n"));
      expect(() => loadDataset(path)).toThrow("duplicate trade");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("evaluation", () => {
  test("replay is deterministic and the held-out suffix cannot affect parameter selection", () => {
    const { header: h, frames } = loadDataset("fixtures/synthetic.jsonl");
    expect(replay(h, frames, defaultConfig)).toEqual(replay(h, frames, defaultConfig));
    const first = evaluate(h, frames, defaultConfig);
    const changed = frames.map((f, i) => i < first.split.developmentFrames ? f : { ...f, trades: [] });
    expect(evaluate(h, changed, defaultConfig).selectedConfig).toEqual(first.selectedConfig);
    expect(first.test.firstBlock).toBe(first.split.testStartsAtBlock);
    expect(first.baselines.hold!.netPnlUsd).toBe("0");
    expect(first.warning).toContain("SYNTHETIC");
  });
  test("live execution is rejected before any RPC or wallet funding", async () => {
    const { Market } = await import("../src/market");
    let touchedRpc = false;
    const live = Object.create(Market.prototype) as InstanceType<typeof Market>;
    Object.defineProperties(live, {
      wallet: { value: {} },
      provider: { get() { touchedRpc = true; throw new Error("RPC accessed before live guard"); } },
      quotePrice: { value: () => 1 },
    });
    await expect(live.init()).rejects.toThrow("Live execution is disabled");
    await expect(live.send(1, "buy", 200, {} as any, [], false)).rejects.toThrow("Live order submission is disabled");
    expect(touchedRpc).toBe(false);
  }, 30_000);
});
