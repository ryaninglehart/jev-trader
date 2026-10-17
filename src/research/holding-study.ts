import { dec, Ledger } from "./ledger";
import { Engine, midOf } from "./engine";
import { patientIntent, frameTime } from "./patient";
import { makerFee, exitFee, transactionCost, sellDepth } from "./execution-costs";
import { economicEstimate } from "./economics";
import { invariant } from "./validation";
import type { DatasetHeader, EngineConfig, Frame } from "./types";

export const STUDY_VERSION = "holding-study-v1";
export const STUDY_PROTOCOL = {
  durationMs: 72 * 60 * 60 * 1000, horizonsMs: [300_000, 900_000, 3_600_000],
  scenarios: [{ id: "queue-1", queue: "1", gas: 1 }, { id: "queue-2-gas-2", queue: "2", gas: 2 }],
  sampleSpacingMs: 300_000, maxBytes: 3_000_000_000,
  selection: "Six fixed research portfolios, no parameter selection or automatic promotion. Main portfolio retains its economic gate. Research portfolios explore buy signals before the gate, with the same capital, position/loss/drawdown limits, no overlapping entries within a portfolio, and explicit liquidation costs. Their results are not trade authorization.",
};
type Entry = { price: string; size: string; remaining: string; submitted: number; included?: number; queue: string; cancelAt?: number };

/** Independent counterfactual portfolio; never emits an order to any venue. */
export class HoldingArm {
  ledger: Ledger | null = null;
  entry: Entry | null = null;
  halted: string | null = null;
  private exitAt: number | null = null;
  private orphanCancelAt: number | null = null;
  private firstFillAt: number | null = null;
  private peak = dec(0);
  private drawdown = dec(0);
  private lastSample = -Infinity;
  private cycleStart = dec(0);
  private cycleFilled = dec(0);
  private completed = 0;
  private wins = 0;
  private losses = 0;
  private roundTripNet = dec(0);
  private roundTripNetSquared = dec(0);
  private recent: { block: number; netUsd: string; filledMon: string; reason: string }[] = [];
  private stats = { signals: 0, gateEligible: 0, attempts: 0, placed: 0, rejected: 0, fills: 0, fullyFilled: 0, cancellations: 0, exits: 0, incompleteExits: 0, completedOrders: 0, ordersWithFill: 0 };
  private filledQty = dec(0);
  private placedQty = dec(0);
  private completedQty = dec(0);
  private completedFilledQty = dec(0);
  private fees = dec(0);
  private exitReason = "horizon";
  constructor(readonly h: DatasetHeader, readonly c: EngineConfig, readonly horizonMs: number, readonly scenario: { id: string; queue: string; gas: number }) {}
  private gas(f: Frame) { this.ledger!.gas(this.h.costs.gasLimit * this.scenario.gas, f.gasPriceWei ?? this.h.costs.gasPriceWei, midOf(f)); }
  private equity(f: Frame) {
    const l = this.ledger!, d = sellDepth(f, l.mon.toString());
    if (!d.complete) return null;
    const exit = l.mon.gt(0) ? transactionCost(this.h, f, this.scenario.gas) : dec(0);
    const reserve = transactionCost(this.h, f, this.scenario.gas).mul((this.entry ? this.entry.included === undefined ? 2 : 1 : 0) + (this.orphanCancelAt !== null ? 1 : 0));
    return l.cash.add(d.proceeds).sub(d.proceeds.mul(exitFee(this.h, f, this.c)).div(10_000)).sub(exit).sub(reserve);
  }
  private completeOrder() {
    const e = this.entry!;
    if (e.cancelAt !== undefined) this.orphanCancelAt = e.cancelAt;
    this.stats.completedOrders++; this.completedQty = this.completedQty.add(e.size);
    const filled = dec(e.size).sub(e.remaining); this.completedFilledQty = this.completedFilledQty.add(filled);
    if (filled.gt(0)) this.stats.ordersWithFill++;
    this.entry = null;
  }
  private finishCycle(f: Frame, reason: string) {
    if (this.cycleFilled.eq(0)) return;
    const pnl = this.ledger!.cash.sub(this.cycleStart);
    this.completed++; if (pnl.gt(0)) this.wins++; else if (pnl.lt(0)) this.losses++;
    this.roundTripNet = this.roundTripNet.add(pnl); this.roundTripNetSquared = this.roundTripNetSquared.add(pnl.pow(2));
    this.recent.push({ block: f.block, netUsd: pnl.toString(), filledMon: this.cycleFilled.toString(), reason });
    if (this.recent.length > 30) this.recent.shift();
    this.cycleFilled = dec(0); this.firstFillAt = null;
  }
  step(f: Frame, buySignal: boolean) {
    if (!this.ledger) { this.ledger = new Ledger(this.c.initialCashUsd, "0", midOf(f)); this.peak = this.ledger.initialEquity; }
    const l = this.ledger, now = frameTime(f);
    // Resting fills precede cancellation inclusion. Neither decision nor inclusion prints can fill an entry.
    if (this.entry?.included !== undefined && f.block > this.entry.included) {
      const e = this.entry;
      for (const t of f.trades) {
        if (t.side !== "sell" || dec(t.price).gt(e.price)) continue;
        if (dec(t.price).lt(e.price)) e.queue = "0";
        const volume = dec(t.size), ahead = dec(e.queue), used = volume.lt(ahead) ? volume : ahead;
        e.queue = ahead.sub(used).toString();
        const available = volume.sub(used), qty = available.lt(e.remaining) ? available : dec(e.remaining);
        if (qty.lte(0)) continue;
        l.fill("buy", qty.toString(), e.price, makerFee(this.h, f)); this.fees = l.makerFeesUsd;
        e.remaining = dec(e.remaining).sub(qty).toString(); this.filledQty = this.filledQty.add(qty); this.cycleFilled = this.cycleFilled.add(qty); this.stats.fills++;
        this.firstFillAt ??= now;
        if (dec(e.remaining).eq(0)) { this.stats.fullyFilled++; this.completeOrder(); break; }
      }
    }
    if (this.entry && this.entry.included === undefined && f.block >= this.entry.submitted + this.c.latencyBlocks) {
      const e = this.entry; this.gas(f);
      const required = dec(e.size).mul(e.price).mul(dec(1).add(dec(makerFee(this.h, f)).div(10000))).add(transactionCost(this.h, f, this.scenario.gas).mul(2));
      if (dec(e.price).gte(f.asks[0]![0]) || dec(e.price).lt(f.bids.at(-1)![0]) || l.cash.lt(required) || l.mon.add(e.size).gt(this.c.maxPositionMon)) { this.stats.rejected++; this.entry = null; }
      else { e.included = f.block; e.queue = dec(f.bids.find(([p]) => dec(p).eq(e.price))?.[1] ?? "0").mul(this.scenario.queue).toString(); this.stats.placed++; this.placedQty = this.placedQty.add(e.size); }
    }
    if (this.entry?.cancelAt !== undefined && f.block >= this.entry.cancelAt) { this.gas(f); this.stats.cancellations++; this.entry.cancelAt = undefined; this.completeOrder(); }
    if (this.orphanCancelAt !== null && f.block >= this.orphanCancelAt) { this.gas(f); this.stats.cancellations++; this.orphanCancelAt = null; }
    if (this.exitAt !== null && f.block >= this.exitAt && !this.entry) {
      const d = sellDepth(f, l.mon.toString());
      // Conservatively do not invent executable dust exits below the observed minimum.
      if (d.complete && l.mon.gte(f.marketCosts?.minSizeMon ?? this.c.orderSizeMon)) {
        this.gas(f); l.fill("sell", l.mon.toString(), d.proceeds.div(l.mon).toString(), exitFee(this.h, f, this.c));
        this.fees = l.makerFeesUsd; this.stats.exits++; this.exitAt = null; this.finishCycle(f, this.exitReason);
      } else { this.stats.incompleteExits++; this.exitAt = f.block + this.c.latencyBlocks; }
    }
    const equity = this.equity(f);
    if (equity === null) this.halted ??= "insufficient exit depth";
    else {
      if (equity.gt(this.peak)) this.peak = equity;
      const dd = this.peak.sub(equity).div(this.peak).mul(100);
      if (dd.gt(this.drawdown)) this.drawdown = dd;
      if (equity.sub(l.initialEquity).lte(dec(this.c.maxLossUsd).neg())) this.halted ??= "maximum loss";
      if (dd.gte(this.c.maxDrawdownPct)) this.halted ??= "maximum drawdown";
      if (l.cash.lt(0)) this.halted ??= "cost reserve exhausted";
    }
    if (this.entry?.included !== undefined && this.entry.cancelAt === undefined && (this.halted || f.block - this.entry.included >= this.c.orderTtlBlocks)) this.entry.cancelAt = f.block + this.c.latencyBlocks;
    if (l.mon.gt(0) && this.exitAt === null && (this.halted || (this.firstFillAt !== null && now - this.firstFillAt >= this.horizonMs))) {
      this.exitReason = this.halted ?? "horizon"; this.exitAt = f.block + this.c.latencyBlocks;
      if (this.entry?.included !== undefined) this.entry.cancelAt ??= f.block + this.c.latencyBlocks;
    }
    if (buySignal) this.stats.signals++;
    if (!buySignal || this.halted || this.entry || this.orphanCancelAt !== null || l.mon.gt(0) || this.exitAt !== null || now - this.lastSample < STUDY_PROTOCOL.sampleSpacingMs) return;
    const mid = dec(midOf(f)), spread = dec(f.asks[0]![0]).sub(f.bids[0]![0]).div(mid).mul(10000);
    if (spread.lt(this.c.minSpreadBps) || spread.gt(this.c.maxSpreadBps)) return;
    const price = f.bids[0]![0], gas = transactionCost(this.h, f, this.scenario.gas).mul(3);
    const required = dec(this.c.orderSizeMon).mul(price).mul(dec(1).add(dec(makerFee(this.h, f)).div(10000))).add(gas);
    if (l.cash.lt(required) || dec(this.c.orderSizeMon).gt(this.c.maxPositionMon) || dec(this.c.orderSizeMon).lt(f.marketCosts?.minSizeMon ?? "0")) return;
    this.lastSample = now; this.cycleStart = l.cash; this.cycleFilled = dec(0);
    if (economicEstimate(this.h, f, "buy", price, this.c.orderSizeMon, this.c.economicGate!).accepted) this.stats.gateEligible++;
    this.entry = { price, size: this.c.orderSizeMon, remaining: this.c.orderSizeMon, submitted: f.block, queue: "0" }; this.stats.attempts++;
  }
  report(f: Frame) {
    const l = this.ledger!, eq = this.equity(f);
    return { id: `${this.horizonMs / 60000}m-${this.scenario.id}`, horizonMinutes: this.horizonMs / 60000, scenario: this.scenario,
      diagnosticOnly: true, liveTradingEnabled: false, netAfterEstimatedExitUsd: l.mon.gt(0) && l.mon.lt(f.marketCosts?.minSizeMon ?? this.c.orderSizeMon) ? null : eq?.sub(l.initialEquity).toString() ?? null,
      settledNetPnlUsd: l.net(midOf(f)).toString(), cashUsd: l.cash.toString(), inventoryMon: l.mon.toString(),
      potentialInventoryMon: l.mon.add(this.entry?.remaining ?? "0").toString(), halted: this.halted, maxDrawdownPct: this.drawdown.toString(),
      gasUsd: l.gasUsd.toString(), feesUsd: this.fees.toString(), ...this.stats,
      submittedQuantityMon: this.placedQty.toString(), filledQuantityMon: this.filledQty.toString(),
      completedOrderFillFraction: this.completedQty.gt(0) ? this.completedFilledQty.div(this.completedQty).toString() : null,
      anyFillRate: this.stats.completedOrders ? this.stats.ordersWithFill / this.stats.completedOrders : null,
      pendingOrder: this.entry !== null, unresolvedInventory: l.mon.gt(0),
      roundTrips: this.completed, wins: this.wins, losses: this.losses,
      meanRoundTripNetUsd: this.completed ? this.roundTripNet.div(this.completed).toString() : null,
      roundTripNetSumUsd: this.roundTripNet.toString(), recentRoundTrips: this.recent,
    };
  }
}

export class HoldingStudy {
  readonly primary: Engine;
  readonly arms: HoldingArm[];
  private history: Frame[] = [];
  first?: Frame;
  last?: Frame;
  frames = 0;
  prints = 0;
  feeObservations = 0;
  private lastFeeBlock = 0;
  private gasMin: string | null = null;
  private gasMax: string | null = null;
  private gasSum = dec(0);
  private days = new Map<string, { frames: number; prints: number }>();
  private dayCloses: { date: string; primaryNetUsd: string; arms: { id: string; cumulativeNetUsd: string | null }[] }[] = [];
  private dayClose(f: Frame) {
    return { date: new Date(frameTime(f)).toISOString().slice(0, 10), primaryNetUsd: this.primary.report().netPnlUsd,
      arms: this.arms.map((arm) => { const r = arm.report(f); return { id: r.id, cumulativeNetUsd: r.netAfterEstimatedExitUsd }; }) };
  }
  constructor(readonly header: DatasetHeader, readonly config: EngineConfig) {
    invariant(config.strategy === "patient" && config.economicGate?.enabled && config.initialMon === "0", "study requires patient gate and zero initial inventory");
    this.primary = new Engine(header, config);
    this.arms = STUDY_PROTOCOL.horizonsMs.flatMap((h) => STUDY_PROTOCOL.scenarios.map((s) => new HoldingArm(header, config, h, s)));
  }
  step(f: Frame) {
    if (this.last && new Date(frameTime(this.last)).getUTCDate() !== new Date(frameTime(f)).getUTCDate()) this.dayCloses.push(this.dayClose(this.last));
    this.primary.step(f);
    const signal = patientIntent(f, this.history, "0", this.config);
    for (const arm of this.arms) arm.step(f, signal.action === "buy");
    this.history.push(f);
    while (this.history.length > 2 && frameTime(this.history[1]!) <= frameTime(f) - this.config.patient!.lookbackMs) this.history.shift();
    if (this.history.length > 5000) this.history.shift();
    this.first ??= f; this.last = f; this.frames++; this.prints += f.trades.length;
    if (f.marketCosts && f.marketCosts.observedBlock !== this.lastFeeBlock) { this.feeObservations++; this.lastFeeBlock = f.marketCosts.observedBlock; }
    const gas = transactionCost(this.header, f).toString();
    if (this.gasMin === null || dec(gas).lt(this.gasMin)) this.gasMin = gas;
    if (this.gasMax === null || dec(gas).gt(this.gasMax)) this.gasMax = gas;
    this.gasSum = this.gasSum.add(gas);
    const day = new Date(frameTime(f)).toISOString().slice(0, 10), bucket = this.days.get(day) ?? { frames: 0, prints: 0 };
    bucket.frames++; bucket.prints += f.trades.length; this.days.set(day, bucket);
  }
  report() {
    invariant(this.first && this.last, "no study observations");
    const r = this.primary.report();
    // The raw journal retains all inputs. Keep published diagnostics compact.
    r.signalQuality.samples = r.signalQuality.samples.slice(-30); r.fillQuality.fills = r.fillQuality.fills.slice(-30);
    return { schema: "edgefoundry-multiday-v1", liveTradingEnabled: false, protocol: STUDY_PROTOCOL, studyVersion: STUDY_VERSION,
      firstBlock: this.first.block, lastBlock: this.last.block, frames: this.frames, tradePrints: this.prints,
      startedAt: new Date(frameTime(this.first)).toISOString(), marketThrough: new Date(frameTime(this.last)).toISOString(),
      elapsedMarketHours: (frameTime(this.last) - frameTime(this.first)) / 3600000,
      days: [...this.days].map(([date, counts]) => ({ date, ...counts })), dayCloses: [...this.dayCloses, this.dayClose(this.last)], primary: r, arms: this.arms.map((a) => a.report(this.last!)),
      costs: { feeObservations: this.feeObservations, latestMarketCosts: this.last.marketCosts ?? null,
        transactionBudgetUsd: { min: this.gasMin, max: this.gasMax, mean: this.gasSum.div(this.frames).toString() },
        methodology: "Public market fees sampled every 200 blocks; positive changes raise fee estimates. Declared fee floors remain. Full 350,000 gas limit times observed base fee plus a fixed 2 gwei priority budget; no gasUsed discount. Research exits consume bid depth, charge a taker-fee floor, and remain unresolved below observed minimum size or missing depth. Fill fractions are simulated queue outcomes, not calibrated exchange probabilities." },
      conclusion: "No strategy is promoted automatically. Inspect complete net results, unfilled-order costs, unresolved inventory, daily coverage and both stress scenarios. Correlated trades and six hypotheses require independent future validation even if one result is positive.",
    };
  }
}
