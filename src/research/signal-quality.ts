import { dec } from "./ledger";
import { frameTime } from "./patient";
import type { Frame, Side } from "./types";

const horizons = [5000, 30000];
interface Sample {
  block: number; ts: number; side: Side; mid: string;
  outcomes: { horizonMs: number; observedAfterMs: number; status: "measured" | "late"; signedMoveBps: string }[];
}
/** Outcome observer only. A fixed global 30s spacing avoids per-block pseudo-samples. */
export class SignalQualityTracker {
  private lastSample: number | null = null;
  private samples: Sample[] = [];
  private pending: Sample[] = [];
  private mid(f: Frame) { return dec(f.bids[0]![0]).add(f.asks[0]![0]).div(2); }
  add(f: Frame, side: Side) {
    const ts = frameTime(f);
    if (this.lastSample !== null && ts - this.lastSample < 30000) return;
    const sample: Sample = { block: f.block, ts, side, mid: this.mid(f).toString(), outcomes: [] };
    this.samples.push(sample); this.pending.push(sample); this.lastSample = ts;
  }
  observe(f: Frame) {
    const now = frameTime(f), mid = this.mid(f);
    for (const sample of this.pending) {
      const elapsed = now - sample.ts;
      for (const horizonMs of horizons) {
        if (elapsed < horizonMs || sample.outcomes.some((x) => x.horizonMs === horizonMs)) continue;
        sample.outcomes.push({ horizonMs, observedAfterMs: elapsed, status: elapsed - horizonMs <= 1000 ? "measured" : "late",
          signedMoveBps: mid.div(sample.mid).sub(1).mul(sample.side === "buy" ? 10000 : -10000).toString() });
      }
    }
    this.pending = this.pending.filter((s) => s.outcomes.length < horizons.length);
  }
  report() {
    return {
      methodology: "Eligibility signals before cost/risk checks, sampled at least 30 seconds apart. Signed future midpoint moves at 5s and 30s; over 1s late excluded and missing horizons censored. These are correlated market observations, not independent trades, fill-conditioned forecasts or profit. Outcomes never enter strategy inputs or economic estimates.",
      samples: this.samples.map((s) => ({ ...s, outcomes: s.outcomes.map((x) => ({ ...x })) })),
      horizons: horizons.map((horizonMs) => {
        let total = dec(0), measured = 0, late = 0, positive = 0, negative = 0, flat = 0;
        for (const sample of this.samples) {
          const x = sample.outcomes.find((x) => x.horizonMs === horizonMs);
          if (!x) continue;
          if (x.status === "late") { late++; continue; }
          measured++; const move = dec(x.signedMoveBps); total = total.add(move);
          if (move.gt(0)) positive++; else if (move.lt(0)) negative++; else flat++;
        }
        return { horizonMs, measured, late, censored: this.samples.length - measured - late, positive, negative, flat, averageSignedBps: measured ? total.div(measured).toString() : null };
      }),
    };
  }
}
