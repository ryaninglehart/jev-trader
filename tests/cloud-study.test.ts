import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { seal, unseal, sha, scan, appendDelta, FROZEN_DIGEST } from "../scripts/cloud-study";

test("cloud checkpoints authenticate ciphertext and reject a wrong key or altered bytes", () => {
  const key = randomBytes(32), original = Buffer.from("private simulated study checkpoint");
  const encrypted = seal(original, key);
  expect(unseal(encrypted, key)).toEqual(original);
  expect(() => unseal(encrypted, randomBytes(32))).toThrow();
  const damaged = Buffer.from(encrypted); damaged[damaged.length - 1]! ^= 1;
  expect(() => unseal(damaged, key)).toThrow();
  expect(Buffer.from(encrypted).includes(original)).toBe(false);
});

function fixture() {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE frames(block INTEGER PRIMARY KEY,body TEXT NOT NULL,digest TEXT NOT NULL)");
  const identityValue = JSON.stringify({ sourceDigest: FROZEN_DIGEST, engineVersion: "edgefoundry-v5", studyVersion: "holding-study-v1", config: { strategy: "patient", initialCashUsd: "100", initialMon: "0", orderSizeMon: "200", maxPositionMon: "400", maxLossUsd: "1", maxDrawdownPct: 1, economicGate: { enabled: true } }, protocol: { durationMs: 259200000, horizonsMs: [300000, 900000, 3600000], scenarios: [{}, {}] } });
  db.query("INSERT INTO metadata VALUES ('identity',?)").run(identityValue);
  const start = Date.parse("2026-10-16T06:17:23.000Z");
  const body = JSON.stringify({ block: 10, ts: start + 1000, marketTs: start, blockHash: "hash10", parentHash: "hash9" });
  const digest = sha(body); db.query("INSERT INTO frames VALUES (?,?,?)").run(10, body, digest);
  const nextBody = JSON.stringify({ block: 11, ts: start + 2000, marketTs: start + 1000, blockHash: "hash11", parentHash: "hash10" });
  const nextDigest = sha(digest + nextBody);
  const part = { version: 1 as const, kind: "delta" as const, sequence: 1, identityValue, previousBlock: 10, previousDigest: digest, lastBlock: 11, lastDigest: nextDigest, report: {}, rows: [{ block: 11, body: nextBody, digest: nextDigest }], savedAt: new Date().toISOString() };
  return { db, part };
}

test("cloud handoff preserves exact input strings, block links and journal digests", () => {
  const { db, part } = fixture(); appendDelta(db, part, 0);
  expect(scan(db).count).toBe(2); expect(scan(db).lastDigest).toBe(part.lastDigest);
  expect((db.query("SELECT body FROM frames WHERE block=11").get() as any).body).toBe(part.rows[0]!.body);
  expect(() => appendDelta(db, part, 0)).toThrow(); db.close();
});

test("missing checkpoint sequences and corrupt deltas fail without replacing earlier journal rows", () => {
  const { db, part } = fixture();
  expect(() => appendDelta(db, { ...part, sequence: 2 }, 0)).toThrow();
  expect(() => appendDelta(db, { ...part, lastDigest: "corrupt" }, 0)).toThrow();
  expect(scan(db).count).toBe(1);
  expect(() => appendDelta(db, { ...part, rows: [{ ...part.rows[0]!, body: part.rows[0]!.body.replace("hash10", "wrong-parent") }] }, 0)).toThrow();
  expect(scan(db).lastBlock).toBe(10); db.close();
});
