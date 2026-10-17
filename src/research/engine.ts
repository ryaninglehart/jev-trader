import { makerFee } from "./execution-costs";
import { dec, Ledger } from "./ledger";
import { decide } from "./strategy";
import type { DatasetHeader, EngineConfig, Execution, Frame, Order, Pending, Side, SignalDiagnostics } from "./types";
import { frameTime } from "./patient";
import { invariant, validateConfig, validateFrame, validateHeader } from "./validation";
import { economicEstimate, type GateDecision } from "./economics";
import { FillQualityTracker } from "./fill-quality";
import { liquidationEstimate } from "./liquidation";
import { SignalQualityTracker } from "./signal-quality";

export const midOf = (f: Frame) => dec(f.bids[0]![0]).add(f.asks[0]![0]).div(2).toString();
// Bump when execution/accounting semantics change; older journals must use their original engine.
export const ENGINE_VERSION = "edgefoundry-v5";

/**
 * One deterministic engine for replay and paper trading. Each block:
 * 1. old orders consume this block's prints; 2. pending transactions settle;
 * 3. risk/strategy see the observation and submit intent for a later block.
 * Thus new quotes never fill on the prints that prompted them.
 */
export class Engine {
  ledger: Ledger | null = null;
  active: Order | null = null;
  pending: Pending | null = null;
  halted: string | null = null;
  readonly executions: Execution[] = [];
  private previous?: Frame;
  private mids: string[];
  private tradeIds = new Set<string>();
  private requestIds = new Set<string>();
  private peakEquity = dec(0);
  private maxDrawdown = dec(0);
  private attempts = 0;
  private placed = 0;
  private rejected = 0;
  private fills = 0;
  private filledOrders = new Set<number>();
  private frames = 0;
  private firstBlock = 0;
  private intentCount = 0;
  private lastEquity = dec(0);
  readonly fillQuality = new FillQualityTracker();
  readonly signalQuality = new SignalQualityTracker();
  private gateAudit: GateDecision[] = [];
  private gateCounts = { evaluated: 0, accepted: 0, blocked: 0, retained: 0 };
  private quoteCounts = { unchanged: 0, minimumRest: 0, smallPriceMove: 0, insufficientImprovement: 0, economicRetention: 0, cancellations: 0 };
  private signalHistory: Frame[] = [];
  private signalCounts: Record<string, number> = {};
  private recentSignals: (SignalDiagnostics & { block: number; action: string })[] = [];
  private touchQuotes = 0;
  private touchQuotesClearing = 0;
  private bestTouchNet: string | null = null;
  private breakEvenCaptureSum = dec(0);

  constructor(readonly header: DatasetHeader, readonly config: EngineConfig, warmupMids: string[] = []) {
    validateHeader(header); validateConfig(config);
    this.mids = warmupMids.slice(-100);
    for (const mid of this.mids) invariant(dec(mid).isFinite() && dec(mid).gt(0), "invalid warmup mid");
  }

  /** Check before persisting; invalid inputs never partially mutate accounting. */
  validate(frame: Frame) {
    validateFrame(frame, this.previous);
    if (this.header.dataKind === "recorded") invariant(frame.blockHash && frame.parentHash, "recorded frames require canonical block hashes");
    for (const level of [...frame.bids, ...frame.asks]) invariant(dec(level[0]).mod(this.header.tickSize).eq(0), "book price is not tick aligned");
    for (const t of frame.trades) invariant(!this.tradeIds.has(t.id), "trade id replayed across blocks");
    if (this.config.strategy === "recorded") invariant(frame.decision, "recorded strategy needs a decision on every frame");
    if (frame.decision?.requestId) invariant(!this.requestIds.has(frame.decision.requestId), "inference request charged twice");
    if (frame.decision?.requestId) invariant(!this.header.terminalInferenceLiability?.requestIds.includes(frame.decision.requestId), "terminal inference cost already charged on a frame");
  }

  step(frame: Frame) {
    this.validate(frame);
    const mid = midOf(frame);
    if (!this.ledger) {
      this.ledger = new Ledger(this.config.initialCashUsd, this.config.initialMon, mid);
      this.peakEquity = this.ledger.initialEquity;
      this.firstBlock = frame.block;
    }
    this.previous = frame;
    for (const t of frame.trades) this.tradeIds.add(t.id);
    if (frame.decision?.requestId) this.requestIds.add(frame.decision.requestId);
    this.frames++;
    this.fillResting(frame);
    this.settle(frame);
    this.fillQuality.observe(frame);
    this.signalQuality.observe(frame);
    if (this.config.economicGate?.enabled) {
      const g = this.config.economicGate;
      // Diagnose whether current touch quotes could clear the cost gate before
      // signals or spot balances are considered. This never submits an order.
      for (const side of ["buy", "sell"] as const) {
        const px = (side === "buy" ? frame.bids : frame.asks)[0]![0];
        const estimate = economicEstimate(this.header, frame, side, px, this.config.orderSizeMon, g);
        this.touchQuotes++;
        if (estimate.accepted) this.touchQuotesClearing++;
        if (this.bestTouchNet === null || dec(estimate.expectedNetEdgeUsd).gt(this.bestTouchNet)) this.bestTouchNet = estimate.expectedNetEdgeUsd;
        const hurdles = dec(estimate.expectedCaptureUsd).sub(estimate.expectedNetEdgeUsd).add(g.minNetEdgeUsd);
        this.breakEvenCaptureSum = this.breakEvenCaptureSum.add(hurdles.div(dec(this.config.orderSizeMon).mul(g.expectedFillFraction).mul(mid)).mul(10_000));
      }
    }
    this.mids.push(mid);
    if (this.mids.length > 100) this.mids.shift();
    const intent = decide(frame, this.mids, this.ledger.mon.toString(), this.config, this.signalHistory);
    if (this.config.strategy === "patient") {
      this.signalHistory.push(frame);
      const before = frameTime(frame) - this.config.patient!.lookbackMs;
      while (this.signalHistory.length > 2 && frameTime(this.signalHistory[1]!) <= before) this.signalHistory.shift();
      // A frozen market clock cannot grow memory without bound; it also cannot warm up.
      if (this.signalHistory.length > 5000) this.signalHistory.shift();
    }
    if (intent.signal) {
      if (intent.signal.reason === "ready" && intent.action !== "hold") this.signalQuality.add(frame, intent.action);
      this.signalCounts[intent.signal.reason] = (this.signalCounts[intent.signal.reason] ?? 0) + 1;
      this.recentSignals.push({ ...intent.signal, block: frame.block, action: intent.action });
      if (this.recentSignals.length > 50) this.recentSignals.shift();
    }
    this.intentCount++;
    if (this.config.strategy === "recorded") this.ledger.ai(frame.decision?.costUsd ?? this.header.costs.aiCostPerDecisionUsd);
    this.updateRisk(frame, mid);

    if (this.pending) return;
    const spread = dec(frame.asks[0]![0]).sub(frame.bids[0]![0]).div(mid).mul(10_000).toNumber();
    let side: Side | null = intent.action === "hold" ? null : intent.action;
    if (intent.latencyMs > this.config.decisionDeadlineMs) {
      this.event({ block: frame.block, type: "late", reason: "decision deadline exceeded" });
      side = null;
    }
    if (this.halted || intent.confidence < this.config.minConfidence || spread < this.config.minSpreadBps || spread > this.config.maxSpreadBps) side = null;
    const expired = this.active && frame.block - this.active.placedBlock >= this.config.orderTtlBlocks;
    // An in-flight inference is not a fresh hold/cancel instruction. Keep the existing
    // quote only until its TTL; risk stops still cancel it.
    if (this.config.strategy === "recorded" && frame.decision?.status === "pending" && !this.halted && !expired && spread >= this.config.minSpreadBps && spread <= this.config.maxSpreadBps) {
      const o = this.active, g = this.config.economicGate;
      const noncrossing = !o || (o.side === "buy" ? dec(o.price).lt(frame.asks[0]![0]) : dec(o.price).gt(frame.bids[0]![0]));
      if (noncrossing && (!o || !g?.enabled || economicEstimate(this.header, frame, o.side, o.price, o.remaining, g, true).accepted)) return;
    }
    if (expired) side = null; // cancellation is a charged, delayed transaction
    const price = side ? this.quotePrice(side, frame) : null;
    const gate = this.config.economicGate?.enabled ? this.config.economicGate : undefined;
    const old = this.active;
    const retention = side && old?.side === side && gate ? economicEstimate(this.header, frame, side, old.price, old.remaining, gate, true) : null;
    const safeToKeep = side && old?.side === side && (side === "buy" ? dec(old.price).lt(frame.asks[0]![0]) : dec(old.price).gt(frame.bids[0]![0])) && (!retention || retention.accepted);
    if (safeToKeep && old!.price === price) { this.quoteCounts.unchanged++; return; }
    const estimate = side && gate ? economicEstimate(this.header, frame, side, price!, this.config.orderSizeMon, gate) : null;
    if (side && this.config.quotePolicy && safeToKeep) {
      const q = this.config.quotePolicy;
      const changeBps = dec(price!).sub(old!.price).abs().div(old!.price).mul(10_000);
      let reason: "minimumRest" | "smallPriceMove" | "insufficientImprovement" | null = null;
      if (frame.block - old!.placedBlock < q.minRestBlocks) reason = "minimumRest";
      else if (changeBps.lt(q.minRepriceBps)) reason = "smallPriceMove";
      else if (estimate && retention && dec(estimate.expectedNetEdgeUsd).sub(retention.expectedNetEdgeUsd).lt(q.minReplacementImprovementUsd)) reason = "insufficientImprovement";
      if (reason) {
        this.quoteCounts[reason]++;
        if (estimate) this.auditGate({ ...estimate, block: frame.block, side, price: price!, outcome: "retained", reason });
        return;
      }
    }
    if (side && estimate) {
      const keep = !estimate.accepted && safeToKeep;
      this.auditGate({ ...estimate, block: frame.block, side, price: price!, outcome: estimate.accepted ? "accepted" : keep ? "retained" : "blocked", reason: estimate.accepted ? "estimated edge covers costs and buffers" : "estimated edge below costs and buffers" });
      if (keep) { this.quoteCounts.economicRetention++; return; }
      if (!estimate.accepted) side = null;
    }
    if (side && !this.canSubmit(side, price!, mid)) side = null;
    if (!side && !this.active) return;
    if (!side) this.quoteCounts.cancellations++;
    const delay = frame.decision?.availableBlock === frame.block
      ? this.config.latencyBlocks // inference already elapsed before this frame; do not count it twice
      : Math.max(this.config.latencyBlocks, Math.ceil(intent.latencyMs / this.header.blockMs));
    this.pending = { applyBlock: frame.block + delay, side, price: side ? price : null, size: side ? this.config.orderSizeMon : "0", cancelOrderBlock: this.active?.placedBlock ?? null };
    this.attempts++;
    this.event({ block: frame.block, type: "submitted", ...(side ? { side, price: price! } : {}), reason: side ? "quote" : "cancel" });
  }

  private quotePrice(side: Side, f: Frame) {
    const tick = dec(this.header.tickSize), bid = dec(f.bids[0]![0]), ask = dec(f.asks[0]![0]);
    const step = tick.mul(this.config.quoteInsideTicks);
    let px = side === "buy" ? bid.add(step).div(tick).floor().mul(tick) : ask.sub(step).div(tick).ceil().mul(tick);
    if (side === "buy" && px.gte(ask)) px = bid.div(tick).floor().mul(tick);
    if (side === "sell" && px.lte(bid)) px = ask.div(tick).ceil().mul(tick);
    return px.toString();
  }

  private canSubmit(side: Side, price: string, mid: string) {
    const l = this.ledger!, size = dec(this.config.orderSizeMon);
    const gasReserve = dec(this.header.costs.gasLimit).mul(this.previous!.gasPriceWei ?? this.header.costs.gasPriceWei).div("1e18").mul(mid).mul(2);
    // The old quote can fill before its replacement; reserve for BOTH in that case.
    const restingBuy = this.active?.side === "buy" ? dec(this.active.remaining) : dec(0);
    const restingSell = this.active?.side === "sell" ? dec(this.active.remaining) : dec(0);
    const feeMultiplier = dec(1).add(dec(makerFee(this.header, this.previous!)).div(10_000));
    if (side === "buy") {
      const need = size.mul(price).add(restingBuy.mul(this.active?.price ?? 0)).mul(feeMultiplier).add(gasReserve);
      return l.mon.add(restingBuy).add(size).lte(this.config.maxPositionMon) && l.cash.gte(need);
    }
    return l.mon.gte(restingSell.add(size)) && l.cash.gte(gasReserve);
  }

  private settle(f: Frame) {
    const p = this.pending;
    if (!p || p.applyBlock > f.block) return;
    this.pending = null;
    const l = this.ledger!;
    l.gas(this.header.costs.gasLimit, f.gasPriceWei ?? this.header.costs.gasPriceWei, midOf(f));
    // Atomic cancel+place: a failed post-only placement leaves the old order intact.
    const crossing = p.side === "buy" ? dec(p.price!).gte(f.asks[0]![0]) : p.side === "sell" && dec(p.price!).lte(f.bids[0]![0]);
    const fee = dec(1).add(dec(makerFee(this.header, this.previous!)).div(10_000));
    const funds = !p.side || (p.side === "buy" ? l.cash.gte(dec(p.size).mul(p.price!).mul(fee)) && l.mon.add(p.size).lte(this.config.maxPositionMon) : l.mon.gte(p.size));
    const cancelRace = p.cancelOrderBlock !== null && this.active?.placedBlock !== p.cancelOrderBlock;
    if (crossing || !funds || cancelRace) {
      this.rejected++;
      this.event({ block: f.block, type: "rejected", reason: crossing ? "post-only would cross" : cancelRace ? "cancel target already filled" : "funds or cap changed before inclusion" });
      return;
    }
    const levels = p.side === "buy" ? f.bids : f.asks;
    // Orders behind the supplied depth cannot be simulated safely.
    const worst = levels.at(-1)![0];
    if (p.side && (p.side === "buy" ? dec(p.price!).lt(worst) : dec(p.price!).gt(worst))) {
      this.rejected++;
      this.event({ block: f.block, type: "rejected", reason: "quote outside recorded depth" });
      return;
    }
    if (this.active) this.event({ block: f.block, type: "canceled", side: this.active.side });
    this.active = null;
    if (!p.side) return;
    const depth = levels.find(([px]) => dec(px).eq(p.price!))?.[1] ?? "0";
    this.active = { side: p.side, price: p.price!, remaining: p.size, queueAhead: dec(depth).mul(this.config.queueFactor).toString(), placedBlock: f.block };
    this.placed++;
    this.event({ block: f.block, type: "placed", side: p.side, price: p.price!, size: p.size });
  }

  private fillResting(f: Frame) {
    for (const t of f.trades) {
      const o = this.active;
      if (!o) break;
      if (o.side === t.side) continue;
      const through = o.side === "buy" ? dec(t.price).lt(o.price) : dec(t.price).gt(o.price);
      if (!through && !dec(t.price).eq(o.price)) continue;
      let available = dec(t.size);
      if (through) o.queueAhead = "0";
      const ahead = dec(o.queueAhead), used = dec(available).lt(ahead) ? available : ahead;
      o.queueAhead = ahead.sub(used).toString();
      available = available.sub(used);
      if (available.lte(0)) continue;
      const qty = available.lt(o.remaining) ? available : dec(o.remaining);
      this.ledger!.fill(o.side, qty.toString(), o.price, makerFee(this.header, f));
      this.fills++;
      this.fillQuality.add(f, o.side, o.price, qty.toString(), makerFee(this.header, f));
      this.filledOrders.add(o.placedBlock);
      this.event({ block: f.block, type: "fill", side: o.side, price: o.price, size: qty.toString() });
      o.remaining = dec(o.remaining).sub(qty).toString();
      if (dec(o.remaining).eq(0)) this.active = null;
    }
  }

  private updateRisk(f: Frame, mid: string) {
    const l = this.ledger!, equity = l.equity(mid);
    this.lastEquity = equity;
    if (equity.gt(this.peakEquity)) this.peakEquity = equity;
    const drawdown = this.peakEquity.sub(equity).div(this.peakEquity).mul(100);
    if (drawdown.gt(this.maxDrawdown)) this.maxDrawdown = drawdown;
    const reason = l.net(mid).lte(dec(this.config.maxLossUsd).neg()) ? "maximum loss" : drawdown.gte(this.config.maxDrawdownPct) ? "maximum drawdown" : l.cash.lt(0) ? "cost reserve exhausted" : null;
    if (!this.halted && reason) {
      this.halted = reason;
      this.event({ block: f.block, type: "halted", reason });
    }
  }

  private event(e: Execution) { this.executions.push(e); }
  private auditGate(e: GateDecision) {
    this.gateCounts.evaluated++; this.gateCounts[e.outcome]++;
    this.gateAudit.push(e);
    if (this.gateAudit.length > 200) this.gateAudit.shift();
  }

  report() {
    invariant(this.ledger && this.previous, "no frames to report");
    const l = this.ledger, mid = midOf(this.previous);
    // Do not make outstanding end-of-window intent look free. Provision its inclusion,
    // plus one terminal cancel if an order is or may become live. These are estimates.
    const reserveTxs = this.pending ? 1 + (this.pending.side ? 1 : 0) : this.active ? 1 : 0;
    const gasReserveUsd = dec(this.header.costs.gasLimit).mul(this.previous.gasPriceWei ?? this.header.costs.gasPriceWei).div("1e18").mul(mid).mul(reserveTxs);
    const terminalAi = dec(this.config.strategy === "recorded" && this.header.terminalInferenceLiability?.block === this.previous.block ? this.header.terminalInferenceLiability.usd : "0");
    const provisions = gasReserveUsd.add(terminalAi);
    const net = l.net(mid).sub(provisions), totalCosts = l.costs().add(provisions);
    const finalDrawdown = this.peakEquity.sub(l.equity(mid).sub(provisions)).div(this.peakEquity).mul(100);
    return {
      engineVersion: ENGINE_VERSION, dataKind: this.header.dataKind, source: this.header.source, strategy: this.config.strategy,
      inference: this.header.inference ?? null,
      firstBlock: this.firstBlock, lastBlock: this.previous.block, frames: this.frames,
      initialEquityUsd: l.initialEquity.toString(), peakEquityUsd: this.peakEquity.toString(), equityUsd: this.lastEquity.sub(provisions).toString(),
      netPnlUsd: net.toString(), settledNetPnlUsd: l.net(mid).toString(), grossPnlUsd: l.gross(mid).toString(),
      realizedBeforeCostsUsd: l.realizedUsd.toString(), unrealizedBeforeCostsUsd: l.mon.mul(mid).sub(l.costBasis).toString(),
      netReturnPct: net.div(l.initialEquity).mul(100).toString(),
      buyAndHoldPnlUsd: l.holdEquity(mid).sub(l.initialEquity).toString(),
      excessVsHoldUsd: l.equity(mid).sub(provisions).sub(l.holdEquity(mid)).toString(),
      costs: { makerFeesUsd: l.makerFeesUsd.toString(), gasMon: l.gasMon.toString(), gasUsd: l.gasUsd.toString(), aiUsd: l.aiUsd.add(terminalAi).toString(), unappliedAiUsd: terminalAi.toString(), gasReserveUsd: gasReserveUsd.toString(), totalUsd: totalCosts.toString() },
      maxDrawdownPct: (finalDrawdown.gt(this.maxDrawdown) ? finalDrawdown : this.maxDrawdown).toString(), turnoverUsd: l.turnoverUsd.toString(),
      decisions: this.intentCount, attempts: this.attempts, placed: this.placed, rejected: this.rejected,
      fills: this.fills, filledOrders: this.filledOrders.size,
      orderFillRate: this.placed ? this.filledOrders.size / this.placed : 0,
      inventoryMon: l.mon.toString(), cashUsd: l.cash.toString(),
      liquidationEstimate: liquidationEstimate(this.header, this.previous, this.config, l.cash.toString(), l.mon.toString(), l.initialEquity.toString(), provisions.toString()),
      halted: this.halted, active: this.active, pending: this.pending,
      liveTradingEnabled: false,
      strategyDiagnostics: { counts: { ...this.signalCounts }, recentSignals: this.recentSignals.map((x) => ({ ...x })), methodology: this.config.strategy === "patient" ? "Fixed, uncalibrated eligibility rules: trailing price trends, signed taker flow and top-book depth must agree. Thin/fast/conflicting markets hold. Eligibility is not a probability or forecast credited to the cost gate." : "Built-in baseline or recorded decisions; no patient signal filter." },
      economicGate: { enabled: this.config.economicGate?.enabled ?? false, ...this.gateCounts, assumptions: this.config.economicGate ?? null, recentDecisions: this.gateAudit.map((x) => ({ ...x })),
        touchEconomics: { quotesChecked: this.touchQuotes, quotesClearing: this.touchQuotesClearing, bestEstimatedNetEdgeUsd: this.bestTouchNet, averageRequiredCaptureBps: this.touchQuotes ? this.breakEvenCaptureSum.div(this.touchQuotes).toString() : null, methodology: "Both best bid and best ask, before signal and balance filters. Required capture is a one-sided limit-to-mid edge, not the full bid/ask spread. Gate assumptions remain uncalibrated." },
        methodology: "Current-mid spread capture with an explicit assumed fill fraction; no predicted directional alpha. Reserve full entry, cancellation and exit gas, fees, inference and adverse-selection/uncertainty buffers. Estimates are decision filters, not realized profit or calibrated probabilities. Retained quotes exclude sunk placement and inference costs." },
      quotePolicy: { ...this.quoteCounts, assumptions: this.config.quotePolicy ?? null },
      fillQuality: this.fillQuality.report(),
      signalQuality: this.signalQuality.report(),
      risk: { maxLossUsd: this.config.maxLossUsd, maxDrawdownPct: this.config.maxDrawdownPct, maxPositionMon: this.config.maxPositionMon,
        potentialInventoryMon: l.mon.add(this.active?.side === "buy" ? this.active.remaining : "0").add(this.pending?.side === "buy" ? this.pending.size : "0").toString(),
        lossBudgetUsedPct: net.lt(0) ? net.neg().div(this.config.maxLossUsd).mul(100).toString() : "0" },
      accounting: "Marked to mid; no terminal liquidation. Quote-currency maker fees. Gas purchased at inclusion mid. Net P&L includes estimated gas reserves for pending inclusion and terminal cancellation; settledNetPnlUsd excludes these provisions.",
      assumptions: this.header.costs, config: this.config,
    };
  }
}
