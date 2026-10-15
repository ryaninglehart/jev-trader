import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { Engine, ENGINE_VERSION } from "./engine";
import { invariant } from "./validation";
import type { DatasetHeader, EngineConfig, Frame } from "./types";

/**
 * Durable paper state is the input journal itself. Recovery deterministically replays it,
 * restoring inventory, orders, pending transactions, paid costs and risk halts together.
 * A lock prevents concurrent writers. An incomplete last write fails closed.
 */
export class PaperSession {
  readonly engine: Engine;
  lastFrame: Frame | undefined;
  readonly frames: Frame[] = [];
  private fd = -1;
  private lock: string;
  private closed = false;

  constructor(readonly path: string, header: DatasetHeader, config: EngineConfig) {
    this.lock = path + ".lock";
    mkdirSync(dirname(path), { recursive: true });
    const lockFd = openSync(this.lock, "wx", 0o600);
    writeSync(lockFd, `${process.pid}\n`); closeSync(lockFd);
    try {
      this.engine = new Engine(header, config);
      const identity = { kind: "paper-session", version: 1, engineVersion: ENGINE_VERSION, header, config };
      if (existsSync(path)) {
        const bytes = readFileSync(path, "utf8");
        invariant(bytes.endsWith("\n"), "incomplete journal; preserve it and recover to the last complete newline in a COPY");
        const rows = bytes.trimEnd().split("\n").map((l) => JSON.parse(l));
        invariant(JSON.stringify(rows.shift()) === JSON.stringify(identity), "session configuration changed; use a new session path");
        for (const frame of rows as Frame[]) { this.engine.step(frame); this.lastFrame = frame; this.frames.push(frame); }
        this.fd = openSync(path, "a", 0o600);
      } else {
        this.fd = openSync(path, "wx", 0o600);
        this.append(identity);
      }
    } catch (e) { this.close(); throw e; }
  }

  step(frame: Frame) {
    invariant(!this.closed, "session is closed");
    this.engine.validate(frame);
    try {
      this.append(frame); // fsync BEFORE applying; a crash after this line is recovered by replay
      this.engine.step(frame); this.lastFrame = frame; this.frames.push(frame);
    }
    catch (e) { this.close(); throw e; }
  }

  private append(value: unknown) {
    const buffer = Buffer.from(JSON.stringify(value) + "\n");
    let offset = 0;
    while (offset < buffer.length) offset += writeSync(this.fd, buffer, offset, buffer.length - offset);
    fsyncSync(this.fd);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.fd >= 0) closeSync(this.fd);
    unlinkSync(this.lock);
  }
}
