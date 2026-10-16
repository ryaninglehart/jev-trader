import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { invariant } from "./validation";
import type { Frame } from "./types";

/** Atomic disk-backed input journal: replay never loads the complete recording into RAM. */
export class StudyStore {
  readonly db!: Database;
  private lock: string;
  private digest = "";
  private lastBlock = 0;
  constructor(readonly path: string, readonly identity: unknown) {
    mkdirSync(dirname(path), { recursive: true }); this.lock = path + ".lock";
    if (existsSync(this.lock)) {
      const pid = Number(readFileSync(this.lock, "utf8").trim());
      invariant(Number.isSafeInteger(pid) && pid > 0, "invalid study lock; inspect manually");
      try { process.kill(pid, 0); throw new Error("study writer is already running"); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; }
      unlinkSync(this.lock); // Only reclaim a demonstrably dead local writer.
    }
    const fd = openSync(this.lock, "wx", 0o600); writeSync(fd, String(process.pid)); closeSync(fd);
    try {
      this.db = new Database(path, { create: true });
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS frames (block INTEGER PRIMARY KEY, body TEXT NOT NULL, digest TEXT NOT NULL)");
      const value = JSON.stringify(identity), old = this.db.query("SELECT value FROM metadata WHERE key='identity'").get() as { value: string } | null;
      if (old) invariant(old.value === value, "study configuration/source changed; use the frozen original code or a new study");
      else this.db.query("INSERT INTO metadata VALUES ('identity', ?)").run(value);
    } catch (e) { this.db!?.close(); unlinkSync(this.lock); throw e; }
  }
  *replay(): Generator<Frame> {
    this.digest = ""; this.lastBlock = 0;
    for (const row of this.db.query("SELECT block, body, digest FROM frames ORDER BY block").iterate() as Iterable<{ block: number; body: string; digest: string }>) {
      const digest = createHash("sha256").update(this.digest + row.body).digest("hex");
      invariant(row.digest === digest && (!this.lastBlock || row.block === this.lastBlock + 1), "study journal integrity mismatch");
      const f = JSON.parse(row.body) as Frame; invariant(f.block === row.block, "study row block mismatch");
      this.digest = digest; this.lastBlock = row.block; yield f;
    }
  }
  append(f: Frame) {
    invariant(!this.lastBlock || f.block === this.lastBlock + 1, "study append must be consecutive");
    const body = JSON.stringify(f), digest = createHash("sha256").update(this.digest + body).digest("hex");
    this.db.query("INSERT INTO frames VALUES (?, ?, ?)").run(f.block, body, digest);
    this.digest = digest; this.lastBlock = f.block;
  }
  get sha256() { return this.digest; }
  close() { this.db.close(); unlinkSync(this.lock); }
}
