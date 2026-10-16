import { makerFee } from "./execution-costs";
import { dec } from "./ledger";
import type { DatasetHeader, EconomicGateConfig, Frame, Side } from "./types";

/** Decision-time estimate only. Does not book hypothetical costs into the actual ledger. */
export function economicEstimate(h: DatasetHeader, f: Frame, side: Side, price: string, size: string, g: EconomicGateConfig, retaining = false) {
  const mid = dec(f.bids[0]![0]).add(f.asks[0]![0]).div(2);
  const sign = side === "buy" ? 1 : -1;
  const qty = dec(size).mul(g.expectedFillFraction);
  const notional = qty.mul(price);
  const capture = mid.sub(price).mul(sign).mul(qty);
  // A rebate is an assumption, but cannot create an otherwise uneconomic entry.
  const entryFeeBps = dec(makerFee(h, f)).gt(0) ? makerFee(h, f) : "0";
  const fees = notional.mul(dec(entryFeeBps).add(dec(g.exitFeeBps).gte(f.marketCosts?.takerFeeBps ?? "0") ? g.exitFeeBps : f.marketCosts!.takerFeeBps)).div(10_000);
  const adverse = qty.mul(mid).mul(g.adverseSelectionBps).div(10_000);
  const uncertainty = qty.mul(mid).mul(g.uncertaintyBps).div(10_000);
  const tx = dec(h.costs.gasLimit).mul(f.gasPriceWei ?? h.costs.gasPriceWei).div("1e18").mul(mid);
  // Reserve full placement, cancellation and exit transactions. A small partial
  // fill can still require a full exit transaction: do not scale gas by quantity.
  // Existing placement and inference costs are sunk when retaining an order.
  const gas = tx.mul(retaining ? 1 : 3);
  const ai = retaining ? dec(0) : dec(g.inferenceBudgetUsd).gt(f.decision?.costUsd ?? h.costs.aiCostPerDecisionUsd)
    ? dec(g.inferenceBudgetUsd) : dec(f.decision?.costUsd ?? h.costs.aiCostPerDecisionUsd);
  const net = capture.sub(fees).sub(adverse).sub(uncertainty).sub(gas).sub(ai);
  return {
    expectedCaptureUsd: capture.toString(), expectedFeesUsd: fees.toString(),
    adverseSelectionReserveUsd: adverse.toString(), uncertaintyReserveUsd: uncertainty.toString(),
    gasBudgetUsd: gas.toString(), inferenceBudgetUsd: ai.toString(), expectedNetEdgeUsd: net.toString(),
    requiredNetEdgeUsd: retaining ? "0" : g.minNetEdgeUsd,
    accepted: retaining ? net.gte(0) : net.gt(0) && net.gte(g.minNetEdgeUsd),
  };
}

export type GateDecision = ReturnType<typeof economicEstimate> & {
  block: number; side: Side; price: string; outcome: "accepted" | "blocked" | "retained";
  reason: string;
};
