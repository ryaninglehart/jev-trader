import { createHash } from "node:crypto";
import { experimental_evaluate } from "ai";
import { createTypeSafeAi, type TypeSafeAiProviderSettings } from "@ai-sdk/typesafe-ai";
import { dec } from "./ledger";
import { midOf } from "./engine";
import { invariant } from "./validation";
import type { DatasetHeader, EngineConfig, Frame, JevSettings } from "./types";

export const JEV_QUESTIONS = {
  direction: {
    type: "choice",
    instructions: {
      question: "Choose buy, sell or hold for this spot MON-USDC paper portfolio over horizonBlocks.",
      goal: "Preserve capital and seek net returns after spread, adverse selection, maker fees, gas and inference cost. Buy posts a bid, sell posts an ask using owned MON only. Hold when the signal or expected net edge is insufficient. The engine independently enforces size, funds, risk limits, confidence and deadlines. No order is required every block.",
      timing: "You see a finalized end-of-block snapshot and only earlier observations. Your response becomes available on a later observed block; it cannot fill on this observation. Orders are post-only, delayed and can be rejected. Fills occur only when opposing takers hit a resting quote; price direction alone does not guarantee profit.",
    },
    criteria: {
      buy: "Prefer acquiring MON below the touch, only if allowed.buy and the expected return after costs is favorable.",
      sell: "Prefer selling owned MON above the touch, only if allowed.sell and the expected return after costs is favorable.",
      hold: "No new quote: weak or conflicting signal, unfavorable costs, unavailable funds or insufficient evidence of positive edge.",
    },
  },
} as const;
export const JEV_PROMPT_HASH = createHash("sha256").update(JSON.stringify(JEV_QUESTIONS)).digest("hex");

export function validateJevSettings(s: JevSettings) {
  invariant(s && typeof s.modelId === "string" && /^jev-[a-zA-Z0-9._-]+$/.test(s.modelId), "explicit Jev modelId required");
  const fields = ["modelId", "horizonBlocks", "timeoutMs", "maxSignalAgeBlocks", "requestEveryBlocks", "maxRequests", "maxEstimatedSpendUsd", "unknownCostReserveUsd", "inputUsdPerMTok", "outputUsdPerMTok"];
  invariant(Object.keys(s).every((k) => fields.includes(k)), "unknown Jev setting; credentials belong in environment variables, not recorded configuration");
  for (const k of ["horizonBlocks", "timeoutMs", "requestEveryBlocks", "maxRequests"] as const) invariant(Number.isSafeInteger(s[k]) && s[k] >= 1, `invalid Jev ${k}`);
  invariant(s.timeoutMs <= 30_000 && s.horizonBlocks <= 1000 && s.maxRequests <= 100_000, "Jev request bounds exceeded");
  invariant(Number.isSafeInteger(s.maxSignalAgeBlocks) && s.maxSignalAgeBlocks >= 0, "invalid maxSignalAgeBlocks");
  for (const k of ["maxEstimatedSpendUsd", "unknownCostReserveUsd", "inputUsdPerMTok", "outputUsdPerMTok"] as const) invariant(typeof s[k] === "string" && /^\d+(\.\d+)?$/.test(s[k]) && dec(s[k]).gte(0), `invalid Jev ${k}`);
  invariant(dec(s.unknownCostReserveUsd).gt(0) && dec(s.maxEstimatedSpendUsd).gte(s.unknownCostReserveUsd), "Jev budget must cover a positive unknown-cost reserve");
}

export interface JevAnswer {
  action: "buy" | "sell" | "hold";
  confidence: number;
  modelId: string;
  inputTokens?: number;
  outputTokens?: number;
}
export type JevEvaluator = (state: ReturnType<typeof buildJevState>, signal: AbortSignal) => Promise<JevAnswer>;
export type JevTransport = NonNullable<TypeSafeAiProviderSettings["fetch"]>;

/** Production transport is the SDK's fixed TypeSafe endpoint; injection is for offline contract tests. */
export function createJevEvaluator(s: JevSettings, options: { apiKey?: string; fetch?: JevTransport } = {}): JevEvaluator {
  validateJevSettings(s);
  const key = options.apiKey ?? process.env.TYPESAFE_AI_API_KEY?.trim();
  invariant(key, "Jev requires TYPESAFE_AI_API_KEY in the local environment. No mock fallback is permitted.");
  const model = createTypeSafeAi({ apiKey: key, fetch: options.fetch }).evaluationModel(s.modelId);
  return async (state, signal) => {
    const r = await experimental_evaluate({ model, state, questions: JEV_QUESTIONS, maxRetries: 0, abortSignal: signal });
    const a = r.answers.direction, p = a.probabilities;
    invariant(a.type === "choice" && ["buy", "sell", "hold"].includes(a.choice) && p, "invalid Jev answer");
    const values = [p.buy, p.sell, p.hold];
    invariant(values.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1), "invalid Jev probabilities");
    const sum = values.reduce((v, n) => v! + n!, 0)!;
    invariant(sum >= 0.98 - 1e-9 && sum <= 1.02 + 1e-9, "Jev probabilities do not sum to one");
    for (const n of [r.usage.inputTokens, r.usage.outputTokens]) if (n !== undefined) invariant(Number.isSafeInteger(n) && n >= 0, "invalid Jev token usage");
    return { action: a.choice as JevAnswer["action"], confidence: p[a.choice]! / sum, modelId: r.response.modelId, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens };
  };
}

/** No future frames or labels are accepted. The model's allowed flags are advisory; the engine is authoritative. */
export function buildJevState(frame: Frame, history: readonly Frame[], portfolio: { mon: string; cash: string; restingBuy: string; restingSell: string }, header: DatasetHeader, config: EngineConfig, s: JevSettings) {
  const past = history.slice(-s.horizonBlocks);
  invariant(past.every((f) => f.block < frame.block), "future/duplicate observation in inference history");
  const rows = [...past, frame], mid = midOf(frame);
  const returns = (n: number) => rows.length > n ? dec(mid).div(midOf(rows[rows.length - 1 - n]!)).sub(1).mul(10_000).toNumber() : 0;
  const bid = frame.bids.reduce((v, l) => v.add(l[1]), dec(0)), ask = frame.asks.reduce((v, l) => v.add(l[1]), dec(0));
  const prints = rows.flatMap((f) => f.trades);
  const buys = prints.filter((p) => p.side === "buy").reduce((v, p) => v.add(p.size), dec(0));
  const sells = prints.filter((p) => p.side === "sell").reduce((v, p) => v.add(p.size), dec(0));
  const size = dec(config.orderSizeMon);
  return {
    market: "MON-USDC", block: frame.block, horizonBlocks: s.horizonBlocks, blockMs: header.blockMs,
    mid, spreadBps: dec(frame.asks[0]![0]).sub(frame.bids[0]![0]).div(mid).mul(10_000).toString(),
    bookImbalance: bid.sub(ask).div(bid.add(ask)).toString(), book: { bids: frame.bids, asks: frame.asks },
    returnsBps: { last1: returns(1), last5: returns(5), last20: returns(20), last100: returns(100) },
    recentMids: rows.filter((_, i) => i % 5 === 0).map(midOf),
    trades: { count: prints.length, buyMon: buys.toString(), sellMon: sells.toString(), cvdMon: buys.sub(sells).toString() },
    recentTrades: prints.slice(-10), portfolio,
    allowed: { buy: dec(portfolio.mon).add(portfolio.restingBuy).add(size).lte(config.maxPositionMon) && dec(portfolio.cash).gte(size.add(portfolio.restingBuy).mul(frame.asks[0]![0])), sell: dec(portfolio.mon).gte(size.add(portfolio.restingSell)) },
    costs: header.costs,
  };
}
