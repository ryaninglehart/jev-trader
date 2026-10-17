import { dec } from "./ledger";
import type { Frame, Side } from "./types";

const horizons = [1000, 5000, 30000] as const;
type Markout = { horizonMs: number; observedAfterMs: number; status: "measured" | "late"; mid: string; grossUsd: string; afterMakerFeeUsd: string; bps: string; midMoveBps: string };
export interface FillQuality {
  id: number; block: number; ts: number; clock: "block" | "observation"; side: Side;
  price: string; size: string; fillMid: string; makerFeeUsd: string; markouts: Markout[];
}

/** Diagnostics only: future midpoints never enter strategy inputs or gate calibration. */
export class FillQualityTracker {
  readonly fills: FillQuality[] = [];
  private pending: FillQuality[] = [];
  add(f: Frame, side: Side, price: string, size: string, makerFeeBps: string) {
    const fill: FillQuality = { id: this.fills.length + 1, block: f.block, ts: f.marketTs ?? f.ts,
      clock: f.marketTs === undefined ? "observation" : "block", side, price, size,
      fillMid: dec(f.bids[0]![0]).add(f.asks[0]![0]).div(2).toString(),
      makerFeeUsd: dec(size).mul(price).mul(makerFeeBps).div(10_000).toString(), markouts: [] };
    this.fills.push(fill); this.pending.push(fill);
  }
  observe(f: Frame) {
    const mid = dec(f.bids[0]![0]).add(f.asks[0]![0]).div(2);
    for (const fill of this.pending) {
      const now = fill.clock === "block" ? f.marketTs : f.ts;
      if (now === undefined) continue;
      const elapsed = now - fill.ts;
      for (const horizonMs of horizons) {
        if (elapsed < horizonMs || fill.markouts.some((x) => x.horizonMs === horizonMs)) continue;
        const sign = fill.side === "buy" ? 1 : -1;
        const gross = mid.sub(fill.price).mul(sign).mul(fill.size);
        fill.markouts.push({ horizonMs, observedAfterMs: elapsed, status: elapsed - horizonMs <= 1000 ? "measured" : "late", mid: mid.toString(),
          grossUsd: gross.toString(), afterMakerFeeUsd: gross.sub(fill.makerFeeUsd).toString(),
          bps: mid.sub(fill.price).mul(sign).div(fill.price).mul(10_000).toString(),
          midMoveBps: mid.sub(fill.fillMid).mul(sign).div(fill.fillMid).mul(10_000).toString() });
      }
    }
    this.pending = this.pending.filter((x) => x.markouts.length < horizons.length);
  }
  report() {
    return {
      methodology: "Signed fill-to-future-mid markouts at first snapshot at/after 1, 5 and 30 seconds. Positive favors the maker. More than 1s late is excluded from aggregates. End-of-window observations are censored, never zero-filled. After-maker-fee markouts exclude gas, inference and liquidation. Block timestamps have 1s resolution; legacy data uses collector observation time.",
      horizons: horizons.map((horizonMs) => {
        let gross = dec(0), net = dec(0), notional = dec(0), qty = dec(0), move = dec(0), measured = 0, late = 0;
        for (const fill of this.fills) {
          const m = fill.markouts.find((x) => x.horizonMs === horizonMs);
          if (!m) continue;
          if (m.status === "late") { late++; continue; }
          measured++; gross = gross.add(m.grossUsd); net = net.add(m.afterMakerFeeUsd);
          notional = notional.add(dec(fill.size).mul(fill.price)); qty = qty.add(fill.size);
          move = move.add(dec(m.midMoveBps).mul(fill.size));
        }
        return { horizonMs, measured, late, censored: this.fills.length - measured - late, quantityMon: qty.toString(), grossUsd: gross.toString(), afterMakerFeeUsd: net.toString(),
          notionalWeightedBps: notional.gt(0) ? gross.div(notional).mul(10_000).toString() : null,
          quantityWeightedMidMoveBps: qty.gt(0) ? move.div(qty).toString() : null };
      }),
      fills: this.fills.map((x) => ({ ...x, markouts: x.markouts.map((m) => ({ ...m })) })),
    };
  }
}
