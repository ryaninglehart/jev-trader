import Decimal from "decimal.js";

// Accounting never accumulates binary floating point. Serialize all money and quantity as strings.
export const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });
export const dec = (value: Decimal.Value) => new D(value);

export class Ledger {
  cash: Decimal;
  mon: Decimal;
  costBasis: Decimal;
  realizedUsd = dec(0);
  makerFeesUsd = dec(0);
  gasMon = dec(0);
  gasUsd = dec(0);
  aiUsd = dec(0);
  turnoverUsd = dec(0);
  readonly initialEquity: Decimal;
  readonly initialCash: Decimal;
  readonly initialMon: Decimal;

  constructor(cash: string, mon: string, initialMid: string) {
    this.cash = this.initialCash = dec(cash);
    this.mon = this.initialMon = dec(mon);
    this.costBasis = this.mon.mul(initialMid);
    this.initialEquity = this.cash.add(this.costBasis);
  }

  /** Spot only: no borrowing or synthetic shorts. Fees settle in the quote asset. */
  fill(side: "buy" | "sell", size: string, price: string, makerFeeBps: string) {
    const qty = dec(size), px = dec(price), notional = qty.mul(px);
    const fee = notional.mul(makerFeeBps).div(10_000);
    if (side === "buy") {
      if (this.cash.lt(notional.add(fee))) throw new Error("insufficient cash for fill and fee");
      this.cash = this.cash.sub(notional).sub(fee);
      this.costBasis = this.costBasis.add(notional);
      this.mon = this.mon.add(qty);
    } else {
      if (this.mon.lt(qty)) throw new Error("insufficient spot inventory");
      const closedBasis = this.costBasis.mul(qty).div(this.mon);
      this.realizedUsd = this.realizedUsd.add(notional.sub(closedBasis));
      this.costBasis = this.costBasis.sub(closedBasis);
      this.mon = this.mon.sub(qty);
      this.cash = this.cash.add(notional).sub(fee);
    }
    this.makerFeesUsd = this.makerFeesUsd.add(fee);
    this.turnoverUsd = this.turnoverUsd.add(notional);
  }

  /** Paper assumption: gas is purchased at this event's MON mid, not revalued at the latest mid. */
  gas(limit: number, gasPriceWei: string, mid: string) {
    const mon = dec(limit).mul(gasPriceWei).div("1e18"), usd = mon.mul(mid);
    this.gasMon = this.gasMon.add(mon);
    this.gasUsd = this.gasUsd.add(usd);
    this.cash = this.cash.sub(usd);
  }

  ai(usd: string) { this.aiUsd = this.aiUsd.add(usd); this.cash = this.cash.sub(usd); }
  equity(mid: string) { return this.cash.add(this.mon.mul(mid)); }
  net(mid: string) { return this.equity(mid).sub(this.initialEquity); }
  costs() { return this.makerFeesUsd.add(this.gasUsd).add(this.aiUsd); }
  gross(mid: string) { return this.net(mid).add(this.costs()); }
  holdEquity(mid: string) { return this.initialCash.add(this.initialMon.mul(mid)); }
}
