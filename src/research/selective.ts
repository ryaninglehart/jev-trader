import { Engine } from "./engine";
import { dec } from "./ledger";
import { frameTime, patientIntent } from "./patient";
import type { DatasetHeader, EngineConfig, Frame } from "./types";
import { invariant, validateConfig } from "./validation";

// A separate, uncalibrated research hypothesis; never used by the frozen study.
export const SELECTIVE_VERSION = "selective-entry-v1";
export const selectivePolicy = Object.freeze({ flowWindowMs: 30_000, minPrints: 3, queueCoverage: "2", persistenceMs: 3_000, entryCooldownMs: 900_000 });

export class SelectiveCandidate {
  readonly engine: Engine;
  private history: Frame[] = [];
  private readySince: number | null = null;
  private lastEntryAt: number | null = null;
  private counts: Record<string, number> = {};
  private latest: { queueAheadMon: string; eligibleOpposingVolumeMon: string; coverage: string; prints: number } | null = null;
  readonly config: EngineConfig;
  constructor(readonly header: DatasetHeader, config: EngineConfig) {
    this.config = structuredClone(config);
    validateConfig(config);
    invariant(config.strategy === "patient" && config.patient, "candidate requires patient baseline");
    invariant(config.initialCashUsd === "100" && config.initialMon === "0" && config.orderSizeMon === "200" && config.maxPositionMon === "400" && config.maxLossUsd === "1" && config.maxDrawdownPct === 1, "candidate requires unchanged strict risk limits");
    invariant(config.quoteInsideTicks === 0 && config.economicGate?.enabled && dec(config.queueFactor).gte(1), "candidate requires touch quotes, conservative queue and enabled economic gate");
    const g = config.economicGate!;
    invariant(dec(g.expectedFillFraction).lte("0.1") && dec(g.adverseSelectionBps).gte("5") && dec(g.exitFeeBps).gte("5") && dec(g.uncertaintyBps).gte("2") && dec(g.minNetEdgeUsd).gte("0.0005") && dec(g.inferenceBudgetUsd).gte("0.00002"), "candidate cannot weaken the existing economic gate");
    invariant(!header.inference && !header.terminalInferenceLiability, "use a market-only dataset without inference liabilities");
    // Recorded decisions reuse the shared causal execution/risk engine. No model,
    // API key, execution adapter or inference charge is involved.
    this.engine = new Engine(header, { ...structuredClone(config), strategy: "recorded" });
  }
  step(frame: Frame) {
    const decision: NonNullable<Frame["decision"]> = { action: "hold", confidence: 1, latencyMs: 0, costUsd: "0" };
    const observation = { ...frame, decision };
    this.engine.validate(observation); // fail before changing strategy state
    const now = frameTime(frame);
    const signal = patientIntent(frame, this.history, this.engine.ledger?.mon.toString() ?? this.config.initialMon, this.config);
    let reason: string = signal.signal!.reason;
    // Retain the same eligible resting quote instead of repeatedly moving to the
    // touch. Engine still applies TTL, economic retention and sticky risk stops.
    if (this.engine.pending?.side && signal.action === this.engine.pending.side) {
      decision.status = "pending"; reason = "transaction_pending";
    } else if (this.engine.active && signal.action === this.engine.active.side) {
      decision.status = "pending";
      reason = "retain_original_quote";
    } else if (signal.action === "sell") {
      // New entry filters must not delay a funded risk-reducing sell signal.
      decision.action = "sell";
    } else if (signal.action === "buy") {
      this.readySince ??= now;
      const price = frame.bids[0]![0];
      const queue = dec(frame.bids[0]![1]).mul(this.config.queueFactor);
      let volume = dec(0), prints = 0;
      for (const f of [...this.history, frame]) {
        if (frameTime(f) <= now - selectivePolicy.flowWindowMs) continue;
        for (const t of f.trades) if (t.side === "sell" && dec(t.price).lte(price)) { volume = volume.add(t.size); prints++; }
      }
      const coverage = volume.div(queue.add(this.config.orderSizeMon));
      this.latest = { queueAheadMon: queue.toString(), eligibleOpposingVolumeMon: volume.toString(), coverage: coverage.toString(), prints };
      if (this.engine.pending) reason = "transaction_pending";
      else if (this.engine.active) reason = "existing_order";
      else if (this.lastEntryAt !== null && now - this.lastEntryAt < selectivePolicy.entryCooldownMs) reason = "entry_cooldown";
      else if (now - this.readySince < selectivePolicy.persistenceMs) reason = "signal_persistence";
      else if (prints < selectivePolicy.minPrints || coverage.lt(selectivePolicy.queueCoverage)) reason = "insufficient_queue_flow";
      else { decision.action = "buy"; reason = "entry_eligible"; }
    }
    if (signal.action !== "buy") this.readySince = null;
    this.counts[reason] = (this.counts[reason] ?? 0) + 1;
    const before = this.engine.executions.length;
    this.engine.step(observation);
    if (this.engine.executions.slice(before).some((e) => e.type === "submitted" && e.side === "buy")) this.lastEntryAt = now;
    this.history.push(frame);
    const cutoff = now - Math.max(this.config.patient!.lookbackMs, selectivePolicy.flowWindowMs);
    while (this.history.length > 2 && frameTime(this.history[1]!) <= cutoff) this.history.shift();
    if (this.history.length > 5000) this.history.shift();
  }
  report() {
    const r = this.engine.report();
    return { ...r, candidateVersion: SELECTIVE_VERSION, candidatePolicy: selectivePolicy, filterCounts: { ...this.counts }, latestQueueEvidence: this.latest,
      gasPerFilledOrderUsd: r.filledOrders ? dec(r.costs.gasUsd).add(r.costs.gasReserveUsd).div(r.filledOrders).toString() : null,
      evidence: "Retrospective research only. Queue coverage and persistence are fixed uncalibrated filters, not fill probabilities. Historical prints cannot fill a new order. Higher fill rate and profitability require independent forward validation. Zero orders is not evidence of improved fill rate. No automatic promotion or live execution." };
  }
}
