import { dec } from "./ledger";
import type { DatasetHeader, EngineConfig, Frame } from "./types";

// Observations can raise, never silently lower, the declared cost floors.
export const makerFee = (h: DatasetHeader, f: Frame) => f.marketCosts
  ? dec(h.costs.makerFeeBps).gte(f.marketCosts.makerFeeBps) ? h.costs.makerFeeBps : f.marketCosts.makerFeeBps
  : h.costs.makerFeeBps;
export const exitFee = (h: DatasetHeader, f: Frame, c: EngineConfig) =>
  ["0", c.economicGate?.exitFeeBps ?? "0", makerFee(h, f), f.marketCosts?.takerFeeBps ?? "0"]
    .reduce((a, b) => dec(a).gte(b) ? a : b);

/** Monad charges the transaction gas limit, not gasUsed. Keep the full budget. */
export const transactionCost = (h: DatasetHeader, f: Frame, multiplier = 1) => dec(h.costs.gasLimit)
  .mul(f.gasPriceWei ?? h.costs.gasPriceWei).div("1e18")
  .mul(dec(f.bids[0]![0]).add(f.asks[0]![0]).div(2)).mul(multiplier);

export function sellDepth(f: Frame, size: string) {
  let remaining = dec(size), proceeds = dec(0);
  for (const [price, available] of f.bids) {
    const take = remaining.lt(available) ? remaining : dec(available);
    proceeds = proceeds.add(take.mul(price)); remaining = remaining.sub(take);
    if (remaining.eq(0)) break;
  }
  return { complete: remaining.eq(0), proceeds, uncovered: remaining };
}
