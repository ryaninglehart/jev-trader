import { dec } from "./ledger";
import type { EngineConfig, Frame, Intent, SignalDiagnostics } from "./types";

export const frameTime = (f: Frame) => f.marketTs ?? f.ts;
const mid = (f: Frame) => dec(f.bids[0]![0]).add(f.asks[0]![0]).div(2);

/** A fixed, uncalibrated hypothesis. Confidence=1 means eligible, not probability. */
export function patientIntent(frame: Frame, history: readonly Frame[], inventory: string, c: EngineConfig): Intent {
  const p = c.patient!;
  const now = frameTime(frame);
  const hold = (signal: SignalDiagnostics): Intent => ({ action: "hold", confidence: 1, latencyMs: 0, aiCostUsd: "0", signal });
  // Reference points must exist at/before the horizons; current/future points cannot
  // shorten warmup. Engine supplies only earlier, validated observations.
  const older = history.filter((f) => frameTime(f) <= now && f.block < frame.block);
  const longRef = older.findLast((f) => frameTime(f) <= now - p.lookbackMs);
  const shortRef = older.findLast((f) => frameTime(f) <= now - p.shortLookbackMs);
  if (!longRef || !shortRef) return hold({ reason: "warmup" });
  if (frame.bids.length < p.depthLevels || frame.asks.length < p.depthLevels) return hold({ reason: "insufficient_depth" });
  const trend = mid(frame).div(mid(longRef)).sub(1).mul(10_000);
  const shortTrend = mid(frame).div(mid(shortRef)).sub(1).mul(10_000);
  const trailing = [...older.filter((f) => frameTime(f) > now - p.lookbackMs), frame];
  let buy = dec(0), sell = dec(0);
  for (const f of trailing) for (const t of f.trades) {
    if (t.side === "buy") buy = buy.add(t.size); else sell = sell.add(t.size);
  }
  const volume = buy.add(sell), flow = volume.gt(0) ? buy.sub(sell).div(volume) : dec(0);
  const bidDepth = frame.bids.slice(0, p.depthLevels).reduce((sum, l) => sum.add(l[1]), dec(0));
  const askDepth = frame.asks.slice(0, p.depthLevels).reduce((sum, l) => sum.add(l[1]), dec(0));
  const book = bidDepth.sub(askDepth).div(bidDepth.add(askDepth));
  const signal = { trendBps: trend.toString(), shortTrendBps: shortTrend.toString(), flowVolumeMon: volume.toString(), flowImbalance: flow.toString(), bookImbalance: book.toString() };
  if (volume.lt(p.minFlowVolumeMon)) return hold({ ...signal, reason: "thin_flow" });
  if (trend.abs().gt(p.maxTrendBps) || shortTrend.abs().gt(p.maxShortMoveBps)) return hold({ ...signal, reason: "fast_market" });
  const buyBook = p.bookPolicy === "veto_opposition" ? book.gt(dec(p.minBookImbalance).neg()) : book.gte(p.minBookImbalance);
  const sellBook = p.bookPolicy === "veto_opposition" ? book.lt(p.minBookImbalance) : book.lte(dec(p.minBookImbalance).neg());
  const bullish = trend.gte(p.minTrendBps) && shortTrend.gt(0) && flow.gte(p.minFlowImbalance) && buyBook;
  const bearish = trend.lte(dec(p.minTrendBps).neg()) && shortTrend.lt(0) && flow.lte(dec(p.minFlowImbalance).neg()) && sellBook;
  if (!bullish && !bearish) return hold({ ...signal, reason: "conflicting_signals" });
  if ((bearish && dec(inventory).lt(c.orderSizeMon)) || (bullish && dec(inventory).add(c.orderSizeMon).gt(c.maxPositionMon))) return hold({ ...signal, reason: "spot_balance" });
  return { action: bullish ? "buy" : "sell", confidence: 1, latencyMs: 0, aiCostUsd: "0", signal: { ...signal, reason: "ready" } };
}
