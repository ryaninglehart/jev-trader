import { dec } from "./ledger";
import type { DatasetHeader, EngineConfig, Frame } from "./types";

/** Snapshot-only estimate. Never submits an exit or fabricates unrecorded depth. */
export function liquidationEstimate(h: DatasetHeader, f: Frame, c: EngineConfig, cash: string, inventory: string, initialEquity: string, existingProvisions: string) {
  const mid = dec(f.bids[0]![0]).add(f.asks[0]![0]).div(2);
  let remaining = dec(inventory), proceeds = dec(0);
  for (const [px, size] of f.bids) {
    const take = remaining.lt(size) ? remaining : dec(size);
    proceeds = proceeds.add(take.mul(px)); remaining = remaining.sub(take);
    if (remaining.eq(0)) break;
  }
  const declared = dec(c.economicGate?.exitFeeBps ?? "0");
  const maker = dec(h.costs.makerFeeBps);
  const feeBps = declared.gte(maker) ? declared : maker;
  const fee = proceeds.mul(feeBps.gt(0) ? feeBps : 0).div(10_000);
  const gas = dec(inventory).gt(0) ? dec(h.costs.gasLimit).mul(f.gasPriceWei ?? h.costs.gasPriceWei).div("1e18").mul(mid) : dec(0);
  const equity = remaining.eq(0) ? dec(cash).add(proceeds).sub(fee).sub(gas).sub(existingProvisions) : null;
  return {
    completeDepth: remaining.eq(0), coveredMon: dec(inventory).sub(remaining).toString(), uncoveredMon: remaining.toString(),
    proceedsBeforeFeesUsd: proceeds.toString(), exitFeeAssumptionBps: feeBps.toString(), exitFeeReserveUsd: fee.toString(), exitGasReserveUsd: gas.toString(),
    equityAfterExitUsd: equity?.toString() ?? null, netAfterExitUsd: equity?.sub(initialEquity).toString() ?? null,
    methodology: "Estimated sale into recorded bid depth, with the greater of declared exit fee and nonnegative maker-fee assumption, one full exit transaction and existing report provisions. Null when depth is insufficient. No actual liquidation; future liquidity, order races and impact beyond recorded depth remain unknown. Risk stops still use marked-to-mid equity.",
  };
}
