import { Engine } from "./engine";
import { SelectiveCandidate, SELECTIVE_VERSION, selectivePolicy } from "./selective";
import { dec } from "./ledger";
import { frameTime } from "./patient";
import type { DatasetHeader, EngineConfig, Frame } from "./types";
import { invariant } from "./validation";

export interface SelectivePlan { startAt: string; endAt: string; codeDigest: string; releaseId: number; namespace: string }
/** Fresh, independent matched portfolios. Never reads/writes the original portfolio state. */
export class SelectiveStudy {
  readonly arms: { id: string; candidate: SelectiveCandidate | null; engine: Engine; gas: number }[];
  private previous?: Frame;
  private first?: Frame;
  private last?: Frame;
  private halts = new Map<string, string>();
  private complete = false;
  constructor(readonly header: DatasetHeader, readonly config: EngineConfig, readonly plan: SelectivePlan) {
    invariant(Number.isFinite(Date.parse(plan.startAt)) && Date.parse(plan.endAt) > Date.parse(plan.startAt), "invalid paired window");
    this.arms = [1, 2].flatMap(stress => {
      const c = { ...structuredClone(config), queueFactor: String(stress) };
      const h = { ...structuredClone(header), costs: { ...header.costs, gasPriceWei: dec(header.costs.gasPriceWei).mul(stress).toFixed() } };
      const candidate = new SelectiveCandidate(h, c);
      return [{ id: `patient-queue-${stress}-gas-${stress}`, candidate: null, engine: new Engine(h, c), gas: stress },
        { id: `selective-queue-${stress}-gas-${stress}`, candidate, engine: candidate.engine, gas: stress }];
    });
  }
  step(frame: Frame) {
    const time = frameTime(frame), start = Date.parse(this.plan.startAt), end = Date.parse(this.plan.endAt);
    if (time < start) { this.previous = frame; return; }
    invariant(this.previous || this.first, "comparison requires canonical boundary predecessor");
    if (time > end) { this.complete = true; return; }
    if (!this.first) {
      invariant(frameTime(this.previous!) < start && frame.block === this.previous!.block + 1 && frame.parentHash === this.previous!.blockHash, "comparison start boundary missing");
      this.first = frame;
    }
    for (const arm of this.arms) {
      const f = { ...frame, ...(frame.gasPriceWei ? { gasPriceWei: dec(frame.gasPriceWei).mul(arm.gas).toFixed() } : {}) };
      if (arm.candidate) arm.candidate.step(f); else arm.engine.step(f);
      const e = arm.engine, l = e.ledger!;
      invariant(l.cash.gte(0) && l.mon.gte(0) && l.mon.add(e.active?.side === "buy" ? e.active.remaining : 0).add(e.pending?.side === "buy" ? e.pending.size : 0).lte("400"), "paired spot/position history failure");
      if (this.halts.has(arm.id)) invariant(e.halted === this.halts.get(arm.id), "paired risk halt reset");
      if (e.halted) this.halts.set(arm.id, e.halted);
    }
    this.last = frame; this.previous = frame;
    if (time === end) this.complete = true;
  }
  report() {
    return { schema: "edgefoundry-selective-forward-v1", liveTradingEnabled: false, candidateVersion: SELECTIVE_VERSION, policy: selectivePolicy,
      startAt: this.plan.startAt, endAt: this.plan.endAt, codeDigest: this.plan.codeDigest,
      runStatus: this.complete ? "completed" : this.last ? "running" : "waiting_for_start",
      firstBlock: this.first?.block ?? null, lastBlock: this.last?.block ?? null, marketThrough: this.last ? new Date(frameTime(this.last)).toISOString() : null,
      arms: this.last ? this.arms.map(a => {
        const r = a.candidate ? a.candidate.report() : a.engine.report();
        invariant(dec(r.initialEquityUsd).add(r.netPnlUsd).eq(r.equityUsd), "paired net reconciliation failure");
        return { id: a.id, ...r, evidence: "Prospectively frozen rules evaluated on newly collected canonical observations delivered by the original collector's encrypted checkpoints. Simulated queue fills and costs; no live orders. Shared observations and correlated outcomes are not independent evidence of an edge." };
      }) : [],
      riskHistoryVerified: true,
      methodology: "Separate matched forward paper portfolios, each starting with $100 and zero MON at this test's cutoff. Patient-v2 is restarted for a fair same-window baseline; it is not the original 72-hour portfolio. Both retain the economic gate and strict limits. Queue-2/gas-2 doubles queue and all gas prices. Input delivery normally lags by one checkpoint (~15 minutes). No automatic promotion." };
  }
}
