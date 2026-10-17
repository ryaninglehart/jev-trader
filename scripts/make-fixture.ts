import { mkdirSync, writeFileSync } from "node:fs";
import { dec } from "../src/research/ledger";
import type { DatasetHeader, Frame } from "../src/research/types";

const header: DatasetHeader = {
  kind: "dataset", version: 1, dataKind: "synthetic", source: "Deterministic artificial sawtooth market for software verification only",
  market: "SYNTHETIC MON-USDC", chainId: 0, blockMs: 300, tickSize: "0.000001",
  costs: { makerFeeBps: "1", gasLimit: 350000, gasPriceWei: "102000000000", aiCostPerDecisionUsd: "0.00002" },
};
const frames: Frame[] = [];
for (let i = 0; i < 240; i++) {
  const phase = i % 40;
  const ticks = phase < 20 ? phase : 40 - phase;
  const bid = dec("0.02").add(dec(ticks).mul("0.000003"));
  const ask = bid.add("0.000012");
  frames.push({
    kind: "frame", block: i + 1, ts: 1_800_000_000_000 + i * 300,
    bids: [[bid.toFixed(), "500"], [bid.sub("0.000001").toFixed(), "800"]],
    asks: [[ask.toFixed(), "500"], [ask.add("0.000001").toFixed(), "800"]],
    trades: i === 0 ? [] : [{ id: `synthetic-${i}`, side: phase < 20 ? "buy" : "sell", price: phase < 20 ? ask.toFixed() : bid.toFixed(), size: "400" }],
    gasPriceWei: "102000000000",
  });
}
mkdirSync("fixtures", { recursive: true });
writeFileSync("fixtures/synthetic.jsonl", [header, ...frames].map((x) => JSON.stringify(x)).join("\n") + "\n");
console.log("Wrote synthetic software-verification fixture (not market history)");
