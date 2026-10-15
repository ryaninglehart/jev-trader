import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dec } from "./ledger";
import { validateFrame, validateHeader, invariant } from "./validation";
import type { DatasetHeader, Frame } from "./types";

export function loadDataset(path: string) {
  return parseDataset(readFileSync(path, "utf8"), path);
}

export function parseDataset(bytes: string, path = "dataset") {
  const rows = bytes.trim().split("\n").map((line, i) => {
    try { return JSON.parse(line); } catch { throw new Error(`${path}: invalid JSON on line ${i + 1}`); }
  });
  const header = rows.shift() as DatasetHeader;
  validateHeader(header);
  const frames = rows as Frame[];
  invariant(frames.length >= 1, "dataset contains no frames");
  const ids = new Set<string>();
  for (let i = 0; i < frames.length; i++) {
    validateFrame(frames[i]!, frames[i - 1]);
    if (header.dataKind === "recorded") invariant(frames[i]!.blockHash && frames[i]!.parentHash, "recorded frames require canonical block hashes");
    for (const level of [...frames[i]!.bids, ...frames[i]!.asks]) invariant(dec(level[0]).mod(header.tickSize).eq(0), "book price is not tick aligned");
    for (const trade of frames[i]!.trades) {
      invariant(!ids.has(trade.id), `duplicate trade id ${trade.id}`);
      ids.add(trade.id);
    }
  }
  return { header, frames, sha256: createHash("sha256").update(bytes).digest("hex") };
}
