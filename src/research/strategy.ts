import { dec } from "./ledger";
import type { EngineConfig, Frame, Intent } from "./types";

/** Only the current observation and earlier observations are passed to the strategy. */
export function decide(frame: Frame, mids: readonly string[], inventory: string, config: EngineConfig): Intent {
  const plain = (action: Intent["action"], confidence = 1): Intent => ({ action, confidence, latencyMs: 0, aiCostUsd: "0" });
  if (config.strategy === "hold") return plain("hold");
  if (config.strategy === "recorded") {
    if (!frame.decision) throw new Error(`recorded strategy requires a decision on block ${frame.block}`);
    return { ...frame.decision, aiCostUsd: frame.decision.costUsd ?? "0" };
  }
  if (config.strategy === "maker") {
    return plain(dec(inventory).gte(dec(config.maxPositionMon).div(2)) ? "sell" : "buy");
  }
  if (mids.length < 5) return plain("hold");
  const bidDepth = frame.bids.reduce((s, l) => s.add(l[1]), dec(0));
  const askDepth = frame.asks.reduce((s, l) => s.add(l[1]), dec(0));
  const imbalance = bidDepth.sub(askDepth).div(bidDepth.add(askDepth)).toNumber();
  const flow = frame.trades.reduce((s, t) => s + (t.side === "buy" ? 1 : -1) * Number(t.size), 0);
  const volume = frame.trades.reduce((s, t) => s + Number(t.size), 0);
  const momentum = dec(mids.at(-1)!).div(mids.at(-5)!).sub(1).mul(10_000).toNumber();
  const signal = momentum / 8 + imbalance * 1.5 + (volume ? flow / volume : 0);
  const buy = 1 / (1 + Math.exp(-signal));
  return plain(buy >= 0.5 ? "buy" : "sell", Math.max(buy, 1 - buy));
}
