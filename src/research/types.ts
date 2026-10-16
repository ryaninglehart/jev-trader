export type Side = "buy" | "sell";
export type StrategyName = "hold" | "maker" | "momentum" | "recorded";
export type Level = [price: string, size: string];

/** Decimal strings preserve the input precision; timestamps are observation times in milliseconds. */
export interface Frame {
  kind: "frame";
  block: number;
  ts: number;
  blockHash?: string;
  parentHash?: string;
  bids: Level[];
  asks: Level[];
  trades: { id: string; side: Side; price: string; size: string }[];
  gasPriceWei?: string;
  /** A decision made AFTER this block's observation. Never use future labels here. */
  decision?: {
    action: Side | "hold"; confidence: number; latencyMs: number; costUsd?: string;
    requestId?: string; sourceBlock?: number; availableBlock?: number;
    status?: "ok" | "pending" | "stale" | "error" | "timeout" | "recovered" | "budget";
    costBasis?: "token_estimate" | "unknown_reserve" | "none";
    inputTokens?: number; outputTokens?: number; modelId?: string;
  };
}

export interface DatasetHeader {
  kind: "dataset";
  version: 1;
  dataKind: "synthetic" | "recorded";
  source: string;
  market: string;
  chainId: number;
  blockMs: number;
  tickSize: string;
  inference?: { provider: "typesafe-ai"; modelId: string; promptHash: string; settings: JevSettings };
  terminalInferenceLiability?: { block: number; usd: string; unknownReserveUsd: string; requestIds: string[] };
  costs: {
    /** Explicit assumptions, not a claim about current Kuru fees. Negative values represent rebates. */
    makerFeeBps: string;
    gasLimit: number;
    gasPriceWei: string;
    aiCostPerDecisionUsd: string;
  };
}

export interface JevSettings {
  modelId: string;
  horizonBlocks: number;
  timeoutMs: number;
  maxSignalAgeBlocks: number;
  requestEveryBlocks: number;
  maxRequests: number;
  maxEstimatedSpendUsd: string;
  unknownCostReserveUsd: string;
  inputUsdPerMTok: string;
  outputUsdPerMTok: string;
}

export interface EngineConfig {
  strategy: StrategyName;
  initialCashUsd: string;
  initialMon: string;
  orderSizeMon: string;
  maxPositionMon: string;
  maxLossUsd: string;
  maxDrawdownPct: number;
  minConfidence: number;
  minSpreadBps: number;
  maxSpreadBps: number;
  quoteInsideTicks: number;
  latencyBlocks: number;
  orderTtlBlocks: number;
  decisionDeadlineMs: number;
  /** Multiply observed queue depth by this factor. 1 is the conservative default. */
  queueFactor: string;
}

export const defaultConfig: EngineConfig = {
  strategy: "momentum", initialCashUsd: "100", initialMon: "0", orderSizeMon: "200",
  maxPositionMon: "1000", maxLossUsd: "10", maxDrawdownPct: 10,
  minConfidence: 0.6, minSpreadBps: 2, maxSpreadBps: 100,
  quoteInsideTicks: 1, latencyBlocks: 1, orderTtlBlocks: 5,
  decisionDeadlineMs: 200, queueFactor: "1",
};

export interface Intent { action: Side | "hold"; confidence: number; latencyMs: number; aiCostUsd: string }
export interface Order { side: Side; price: string; remaining: string; queueAhead: string; placedBlock: number }
export interface Pending { applyBlock: number; side: Side | null; price: string | null; size: string; cancelOrderBlock: number | null }

export interface Execution {
  block: number;
  type: "submitted" | "placed" | "rejected" | "canceled" | "fill" | "halted" | "late";
  side?: Side;
  price?: string;
  size?: string;
  reason?: string;
}
