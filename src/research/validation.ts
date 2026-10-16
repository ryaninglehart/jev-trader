import { dec } from "./ledger";
import type { DatasetHeader, EngineConfig, Frame } from "./types";

export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function amount(value: unknown, label: string, positive = false) {
  invariant(typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value), `${label} must be a decimal string`);
  const d = dec(value);
  invariant(d.isFinite() && (positive ? d.gt(0) : d.gte(0)), `${label} out of range`);
}
export function validateHeader(h: DatasetHeader) {
  invariant(h.kind === "dataset" && h.version === 1, "unsupported dataset version");
  invariant(h.dataKind === "recorded" || h.dataKind === "synthetic", "dataset must identify its provenance");
  invariant(typeof h.source === "string" && h.source.length > 0, "missing source");
  invariant(typeof h.market === "string" && h.market.length > 0 && Number.isSafeInteger(h.chainId) && h.chainId >= 0, "missing market/chain provenance");
  invariant(Number.isFinite(h.blockMs) && h.blockMs > 0, "invalid blockMs");
  amount(h.tickSize, "tickSize", true);
  invariant(h.costs && Number.isSafeInteger(h.costs.gasLimit) && h.costs.gasLimit > 0, "explicit positive gasLimit required");
  amount(h.costs.gasPriceWei, "gasPriceWei", true);
  amount(h.costs.aiCostPerDecisionUsd, "aiCostPerDecisionUsd");
  invariant(typeof h.costs.makerFeeBps === "string" && /^-?\d+(\.\d+)?$/.test(h.costs.makerFeeBps) && dec(h.costs.makerFeeBps).gte(-100) && dec(h.costs.makerFeeBps).lte(1000), "explicit makerFeeBps required (-100..1000)");
  if (h.terminalInferenceLiability) {
    const t = h.terminalInferenceLiability;
    invariant(Number.isSafeInteger(t.block) && t.block >= 1 && Array.isArray(t.requestIds) && t.requestIds.length > 0 && t.requestIds.every((id) => typeof id === "string" && id.length > 0) && new Set(t.requestIds).size === t.requestIds.length, "invalid terminal inference liability");
    amount(t.usd, "terminal inference cost"); amount(t.unknownReserveUsd, "terminal unknown reserve");
    invariant(dec(t.unknownReserveUsd).lte(t.usd), "unknown reserve exceeds terminal inference cost");
  }
}
export function validateConfig(c: EngineConfig) {
  invariant(["hold", "maker", "momentum", "recorded"].includes(c.strategy), "unknown strategy");
  for (const k of ["initialCashUsd", "initialMon", "queueFactor"] as const) amount(c[k], k);
  for (const k of ["orderSizeMon", "maxPositionMon", "maxLossUsd"] as const) amount(c[k], k, true);
  invariant(dec(c.initialCashUsd).gt(0), "initialCashUsd must cover fees and gas");
  invariant(dec(c.initialMon).lte(c.maxPositionMon) && dec(c.orderSizeMon).lte(c.maxPositionMon), "initial inventory/order exceeds position cap");
  for (const k of ["latencyBlocks", "orderTtlBlocks"] as const) invariant(Number.isSafeInteger(c[k]) && c[k] >= 1, `${k} must be >= 1`);
  invariant(Number.isSafeInteger(c.quoteInsideTicks) && c.quoteInsideTicks >= 0, "invalid quoteInsideTicks");
  invariant(Number.isFinite(c.minConfidence) && c.minConfidence >= 0.5 && c.minConfidence <= 1, "invalid minConfidence");
  invariant(Number.isFinite(c.minSpreadBps) && Number.isFinite(c.maxSpreadBps) && c.minSpreadBps >= 0 && c.maxSpreadBps >= c.minSpreadBps, "invalid spread limits");
  invariant(Number.isFinite(c.maxDrawdownPct) && c.maxDrawdownPct > 0 && c.maxDrawdownPct <= 100, "invalid maxDrawdownPct");
  invariant(Number.isFinite(c.decisionDeadlineMs) && c.decisionDeadlineMs > 0, "invalid decisionDeadlineMs");
}
export function validateFrame(f: Frame, previous?: Frame) {
  invariant(f.kind === "frame" && Number.isSafeInteger(f.block) && f.block >= 1, "invalid block");
  invariant(Number.isSafeInteger(f.ts) && f.ts > 0, "invalid timestamp");
  if (f.blockHash !== undefined || f.parentHash !== undefined) {
    invariant(typeof f.blockHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(f.blockHash) && typeof f.parentHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(f.parentHash), "invalid block hashes");
    if (previous?.blockHash) invariant(f.parentHash.toLowerCase() === previous.blockHash.toLowerCase(), "canonical block continuity changed");
  }
  if (previous) {
    invariant(f.block === previous.block + 1, "missing, duplicate or reordered block; stop and start a new recording");
    invariant(f.ts > previous.ts, "timestamps must increase");
  }
  for (const side of ["bids", "asks"] as const) {
    invariant(Array.isArray(f[side]) && f[side].length > 0, `empty ${side}`);
    let last: string | null = null;
    for (const level of f[side]) {
      invariant(Array.isArray(level) && level.length === 2, `invalid ${side} level`);
      const [px, qty] = level;
      amount(px, "price", true); amount(qty, "depth", true);
      if (last) invariant(side === "bids" ? dec(px).lt(last) : dec(px).gt(last), "book levels must be strictly sorted");
      last = px;
    }
  }
  invariant(dec(f.bids[0]![0]).lt(f.asks[0]![0]), "crossed/locked book");
  invariant(Array.isArray(f.trades), "trades array required, including when empty");
  const ids = new Set<string>();
  for (const t of f.trades) {
    invariant(typeof t.id === "string" && t.id.length > 0 && !ids.has(t.id), "duplicate/missing trade id");
    ids.add(t.id);
    invariant(t.side === "buy" || t.side === "sell", "invalid taker side");
    amount(t.price, "trade price", true); amount(t.size, "trade size", true);
  }
  if (f.gasPriceWei !== undefined) amount(f.gasPriceWei, "frame gasPriceWei", true);
  if (f.decision) {
    invariant(["hold", "buy", "sell"].includes(f.decision.action), "invalid decision");
    invariant(Number.isFinite(f.decision.confidence) && f.decision.confidence >= 0 && f.decision.confidence <= 1, "invalid confidence");
    invariant(Number.isFinite(f.decision.latencyMs) && f.decision.latencyMs >= 0, "invalid latency");
    if (f.decision.costUsd !== undefined) amount(f.decision.costUsd, "decision costUsd");
    const d = f.decision;
    if (d.requestId !== undefined) invariant(typeof d.requestId === "string" && d.requestId.length > 0, "invalid requestId");
    if (d.availableBlock !== undefined) {
      invariant(d.availableBlock === f.block && Number.isSafeInteger(d.sourceBlock) && d.sourceBlock! < f.block && d.sourceBlock! >= 1, "decision must be received after its source observation, on its recorded availability frame");
    }
    if (d.status !== undefined) invariant(["ok", "pending", "stale", "error", "timeout", "recovered", "budget"].includes(d.status), "invalid decision status");
    if (d.status && d.status !== "ok") invariant(d.action === "hold", "non-success decision must hold");
    for (const n of [d.inputTokens, d.outputTokens]) if (n !== undefined) invariant(Number.isSafeInteger(n) && n >= 0, "invalid token usage");
  }
}
