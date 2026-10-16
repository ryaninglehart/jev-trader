import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HoldingArm, HoldingStudy } from "../src/research/holding-study";
import { StudyStore } from "../src/research/study-store";
import { makerFee, exitFee } from "../src/research/execution-costs";
import { economicEstimate } from "../src/research/economics";
import { validateFrame } from "../src/research/validation";
import { dec } from "../src/research/ledger";
import type { DatasetHeader, EngineConfig, Frame } from "../src/research/types";
import profile from "../edgefoundry.patient.example.json";
const h: DatasetHeader = { ...profile.dataset, dataKind: "synthetic", kind: "dataset", version: 1 };
const c = profile.engine as EngineConfig;
const scenario = { id: "queue-1", queue: "1", gas: 1 };
function f(block: number, size = "0", bid = "0.02"): Frame {
  return { kind: "frame", block, ts: block * 1000, marketTs: block * 1000,
    bids: [[bid, "100"], [dec(bid).sub("0.000001").toString(), "1000"], [dec(bid).sub("0.000002").toString(), "1000"]],
    asks: [[dec(bid).add("0.00002").toString(), "100"], [dec(bid).add("0.000021").toString(), "1000"], [dec(bid).add("0.000022").toString(), "1000"]],
    trades: size === "0" ? [] : [{ id: String(block), side: "sell", price: bid, size }],
    marketCosts: { observedBlock: block, makerFeeBps: "0", takerFeeBps: "0", minSizeMon: "200" } };
}
test("patient research cannot fill decision or inclusion prints, and consumes queue before partial fills", () => {
  const a = new HoldingArm(h, c, 300000, scenario);
  a.step(f(1, "10000"), true); a.step(f(2, "10000"), false);
  expect(a.ledger!.mon.toString()).toBe("0");
  a.step(f(3, "150"), false); expect(a.ledger!.mon.toString()).toBe("50");
  a.step(f(4, "100"), false); expect(a.ledger!.mon.toString()).toBe("150");
  a.step(f(5, "100"), false); expect(a.ledger!.mon.toString()).toBe("200");
  expect(a.report(f(5)).completedOrderFillFraction).toBe("1");
});
test("doubling queue consumes additional actual print volume", () => {
  const a = new HoldingArm(h, c, 300000, { id: "stress", queue: "2", gas: 2 });
  a.step(f(1), true); a.step(f(2), false); a.step(f(3, "150"), false);
  expect(a.ledger!.mon.toString()).toBe("0"); a.step(f(4, "100"), false);
  expect(a.ledger!.mon.toString()).toBe("50");
});
test("time exits wait for a later block, consume depth and charge both fees and gas", () => {
  const a = new HoldingArm(h, c, 1000, scenario);
  a.step(f(1), true); a.step(f(2), false); a.step(f(3, "300"), false); a.step(f(4), false);
  expect(a.ledger!.mon.toString()).toBe("200"); a.step(f(5), false);
  const r = a.report(f(5)); expect(r.roundTrips).toBe(1); expect(r.inventoryMon).toBe("0");
  expect(dec(r.feesUsd).gt(0)).toBe(true); expect(dec(r.gasUsd).gt(0)).toBe(true);
  expect(dec(r.settledNetPnlUsd).eq(dec(r.roundTripNetSumUsd))).toBe(true);
  expect(r.gateEligible).toBe(0); expect(r.diagnosticOnly).toBe(true);
});
test("partial inventory cannot fabricate a below-minimum exit", () => {
  const a = new HoldingArm(h, { ...c, orderTtlBlocks: 2 }, 1000, scenario);
  a.step(f(1), true); a.step(f(2), false); a.step(f(3, "150"), false);
  for (let i = 4; i <= 8; i++) a.step(f(i), false);
  const r = a.report(f(8)); expect(r.inventoryMon).toBe("50"); expect(r.exits).toBe(0);
  expect(r.netAfterEstimatedExitUsd).toBeNull(); expect(r.incompleteExits).toBeGreaterThan(0);
});
test("full fill racing an already submitted cancellation still pays cancellation gas", () => {
  const a = new HoldingArm(h, { ...c, orderTtlBlocks: 1 }, 300000, scenario);
  a.step(f(1), true); a.step(f(2), false); a.step(f(3), false);
  const before = a.ledger!.gasUsd; a.step(f(4, "300"), false);
  expect(a.ledger!.mon.toString()).toBe("200"); expect(a.ledger!.gasUsd.gt(before)).toBe(true);
  expect(a.report(f(4)).cancellations).toBe(1);
});
test("loss stops are sticky across time and prevent new research positions", () => {
  const a = new HoldingArm(h, c, 300000, scenario);
  a.step(f(1), true); a.step(f(2), false); a.step(f(3, "300"), false);
  a.step(f(4, "0", "0.01"), false); expect(a.halted).toBe("maximum loss");
  a.step(f(5, "0", "0.01"), false); const attempts = a.report(f(5)).attempts;
  const later = f(6); later.marketTs = later.ts = 1000000; a.step(later, true);
  expect(a.report(later).attempts).toBe(attempts); expect(a.report(later).inventoryMon).toBe("0");
});
test("research does not borrow, overlap entries or exceed position caps", () => {
  const a = new HoldingArm(h, c, 300000, scenario);
  for (let i = 1; i <= 100; i++) { a.step(f(i, "500"), true); expect(dec(a.report(f(i)).potentialInventoryMon).lte(c.maxPositionMon)).toBe(true); }
  expect(a.report(f(100)).attempts).toBe(1);
  const poor = new HoldingArm(h, { ...c, initialCashUsd: "1" }, 300000, scenario); poor.step(f(1), true);
  expect(poor.report(f(1)).attempts).toBe(0);
});
test("fees only rise above declared floors and stale/future observations fail closed", () => {
  const frame = f(1); frame.marketCosts!.makerFeeBps = "8"; frame.marketCosts!.takerFeeBps = "10";
  expect(makerFee(h, frame)).toBe("8"); expect(exitFee(h, frame, c)).toBe("10");
  const cheap = economicEstimate(h, f(1), "buy", "0.02", "200", c.economicGate!);
  const costly = economicEstimate(h, frame, "buy", "0.02", "200", c.economicGate!);
  expect(dec(costly.expectedFeesUsd).gt(cheap.expectedFeesUsd)).toBe(true);
  frame.marketCosts!.observedBlock = 2; expect(() => validateFrame(frame)).toThrow("stale/future");
  const stale = f(202); stale.marketCosts!.observedBlock = 1; expect(() => validateFrame(stale)).toThrow("stale/future");
});
test("disk journal recovers all portfolio state exactly, protects identity and rejects tampering", () => {
  const dir = mkdtempSync(join(tmpdir(), "edge-study-")), path = join(dir, "study.sqlite");
  try {
    const a = new HoldingStudy(h, c), store = new StudyStore(path, { fixed: true });
    expect(() => new StudyStore(path, { fixed: true })).toThrow("already running");
    for (let i = 1; i <= 80; i++) { const frame = f(i); store.append(frame); a.step(frame); }
    const hash = store.sha256; store.close();
    expect(() => new StudyStore(path, { fixed: false })).toThrow("configuration/source changed");
    const resumed = new StudyStore(path, { fixed: true }), b = new HoldingStudy(h, c);
    for (const frame of resumed.replay()) b.step(frame);
    expect(b.report()).toEqual(a.report()); expect(resumed.sha256).toBe(hash);
    expect(() => resumed.append(f(82))).toThrow("consecutive");
    resumed.db.query("UPDATE frames SET body=? WHERE block=1").run(JSON.stringify(f(1, "500")));
    expect(() => [...resumed.replay()]).toThrow("integrity mismatch"); resumed.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
