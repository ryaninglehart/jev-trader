import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { dec } from "./ledger";
import { JEV_PROMPT_HASH, validateJevSettings, type JevAnswer, type JevEvaluator, type buildJevState } from "./jev";
import { invariant } from "./validation";
import type { DatasetHeader, Frame, JevSettings } from "./types";

interface Start { kind: "start"; id: string; sourceBlock: number; sourceHash?: string; startedAt: number; stateHash: string }
interface Finish {
  kind: "finish"; id: string; status: "ok" | "error" | "timeout" | "recovered";
  latencyMs: number; costUsd: string; costBasis: "token_estimate" | "unknown_reserve";
  answer?: JevAnswer; failure?: "auth" | "provider" | "timeout" | "recovered";
}

function validateCompletion(f: Finish, settings: JevSettings, starts: Map<string, Start>, finishes: Map<string, Finish>) {
  invariant(f.kind === "finish" && starts.has(f.id) && !finishes.has(f.id), "invalid inference completion");
  invariant(["ok", "error", "timeout", "recovered"].includes(f.status) && Number.isFinite(f.latencyMs) && f.latencyMs >= 0, "invalid inference status/timing");
  invariant(typeof f.costUsd === "string" && /^\d+(\.\d+)?$/.test(f.costUsd) && dec(f.costUsd).isFinite(), "invalid inference cost");
  invariant(f.costBasis === "unknown_reserve" || f.costBasis === "token_estimate", "invalid inference cost basis");
  if (f.costBasis === "unknown_reserve") invariant(dec(f.costUsd).eq(settings.unknownCostReserveUsd), "unknown cost reserve differs from configured reserve");
  if (f.status === "ok") {
    const a = f.answer;
    invariant(a && ["buy", "sell", "hold"].includes(a.action) && Number.isFinite(a.confidence) && a.confidence >= 0 && a.confidence <= 1 && typeof a.modelId === "string", "invalid persisted Jev answer");
    for (const n of [a.inputTokens, a.outputTokens]) if (n !== undefined) invariant(Number.isSafeInteger(n) && n >= 0, "invalid persisted token usage");
    if (f.costBasis === "token_estimate") {
      invariant(a.inputTokens !== undefined && (a.outputTokens !== undefined || dec(settings.outputUsdPerMTok).eq(0)), "missing usage for estimated cost");
      invariant(dec(f.costUsd).eq(dec(a.inputTokens).mul(settings.inputUsdPerMTok).add(dec(a.outputTokens ?? 0).mul(settings.outputUsdPerMTok)).div(1_000_000)), "persisted cost differs from token usage");
    }
  } else invariant(f.costBasis === "unknown_reserve", "failed request must reserve unknown cost");
}

/** Single-flight inference with a durable request ledger; no market or wallet write APIs. */
export class JevRunner {
  private starts = new Map<string, Start>();
  private finishes = new Map<string, Finish>();
  private fd = -1;
  private running: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private closed = false;
  private stopping = false;
  private journalFailure = false;
  private authFailed = false;

  constructor(readonly path: string, readonly settings: JevSettings, readonly evaluate: JevEvaluator, binding: string, consumedIds: ReadonlySet<string>) {
    validateJevSettings(settings);
    mkdirSync(dirname(path), { recursive: true });
    const lock = openSync(path + ".lock", "wx", 0o600); closeSync(lock);
    try {
      const identity = { kind: "jev-inference", version: 1, settings, promptHash: JEV_PROMPT_HASH, binding };
      if (existsSync(path)) {
        const bytes = readFileSync(path, "utf8");
        invariant(bytes.endsWith("\n"), "incomplete inference ledger; preserve and repair a copy before restart");
        const lines = bytes.trimEnd().split("\n").map((l) => JSON.parse(l));
        invariant(JSON.stringify(lines.shift()) === JSON.stringify(identity), "inference ledger identity changed");
        for (const e of lines as (Start | Finish)[]) {
          if (e.kind === "start") {
            invariant(typeof e.id === "string" && e.id.length > 0 && !this.starts.has(e.id) && Number.isSafeInteger(e.sourceBlock) && e.sourceBlock >= 1 && Number.isSafeInteger(e.startedAt) && e.startedAt >= 1 && /^[0-9a-f]{64}$/.test(e.stateHash), "invalid/duplicate inference start");
            this.starts.set(e.id, e);
          } else { this.validateFinish(e); this.finishes.set(e.id, e); }
        }
        this.fd = openSync(path, "a", 0o600);
      } else { this.fd = openSync(path, "wx", 0o600); this.append(identity); }
      for (const id of consumedIds) invariant(this.finishes.has(id), "paper decision missing from inference ledger");
      for (const s of this.starts.values()) if (!this.finishes.has(s.id)) this.finish({ kind: "finish", id: s.id, status: "recovered", latencyMs: settings.timeoutMs, costUsd: settings.unknownCostReserveUsd, costBasis: "unknown_reserve", failure: "recovered" });
      this.authFailed = [...this.finishes.values()].some((f) => f.failure === "auth");
    } catch (e) { this.release(); throw e; }
  }

  private append(record: unknown) {
    const b = Buffer.from(JSON.stringify(record) + "\n");
    for (let offset = 0; offset < b.length;) offset += writeSync(this.fd, b, offset, b.length - offset);
    fsyncSync(this.fd);
  }
  private validateFinish(f: Finish) { validateCompletion(f, this.settings, this.starts, this.finishes); }
  private finish(record: Finish) { this.validateFinish(record); this.append(record); this.finishes.set(record.id, record); }
  private ready(ids: ReadonlySet<string>) { return [...this.finishes.values()].find((f) => !ids.has(f.id)); }
  private health() { invariant(!this.closed && !this.journalFailure, "inference ledger is closed or could not persist a result"); }

  decision(frame: Frame, consumed: ReadonlySet<string>): NonNullable<Frame["decision"]> {
    this.health();
    const done = this.ready(consumed);
    if (!done) return { action: "hold", confidence: 0, latencyMs: 0, costUsd: "0", status: !this.running && !this.canSpend() ? "budget" : "pending", costBasis: "none" };
    const start = this.starts.get(done.id)!;
    invariant(start.sourceBlock < frame.block, "inference completion must be applied after its source observation");
    const stale = frame.block - start.sourceBlock > this.settings.maxSignalAgeBlocks;
    const ok = done.status === "ok" && !stale;
    return {
      action: ok ? done.answer!.action : "hold", confidence: ok ? done.answer!.confidence : 0,
      latencyMs: done.latencyMs, costUsd: done.costUsd, requestId: done.id,
      sourceBlock: start.sourceBlock, availableBlock: frame.block,
      status: done.status === "ok" ? stale ? "stale" : "ok" : done.status,
      costBasis: done.costBasis, modelId: done.answer?.modelId ?? this.settings.modelId,
      ...(done.answer?.inputTokens !== undefined ? { inputTokens: done.answer.inputTokens } : {}),
      ...(done.answer?.outputTokens !== undefined ? { outputTokens: done.answer.outputTokens } : {}),
    };
  }

  private canSpend() {
    const errors = [...this.finishes.values()].filter((f) => f.status !== "ok").length;
    return !this.authFailed && errors < 3 && this.starts.size < this.settings.maxRequests && dec(this.audit(new Set()).committedUsd).add(this.settings.unknownCostReserveUsd).lte(this.settings.maxEstimatedSpendUsd);
  }

  launch(frame: Frame, state: ReturnType<typeof buildJevState>, consumed: ReadonlySet<string>) {
    this.health();
    if (this.stopping || this.running || this.ready(consumed) || !this.canSpend()) return false;
    const previous = [...this.starts.values()].at(-1);
    if (previous && frame.block - previous.sourceBlock < this.settings.requestEveryBlocks) return false;
    const payload = JSON.stringify(state);
    invariant(payload.length <= 32_000, "inference state exceeds request size bound");
    const start: Start = { kind: "start", id: randomUUID(), sourceBlock: frame.block, sourceHash: frame.blockHash, startedAt: Date.now(), stateHash: createHash("sha256").update(payload).digest("hex") };
    this.append(start); this.starts.set(start.id, start);
    const controller = this.controller = new AbortController();
    let timedOut = false;
    this.running = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new Error("request timeout")); }, this.settings.timeoutMs); });
        const answer = await Promise.race([this.evaluate(state, controller.signal), timeout]);
        invariant(["buy", "sell", "hold"].includes(answer.action) && Number.isFinite(answer.confidence) && answer.confidence >= 0 && answer.confidence <= 1, "invalid evaluator result");
        for (const n of [answer.inputTokens, answer.outputTokens]) if (n !== undefined) invariant(Number.isSafeInteger(n) && n >= 0, "invalid evaluator usage");
        const known = answer.inputTokens !== undefined && (answer.outputTokens !== undefined || dec(this.settings.outputUsdPerMTok).eq(0));
        const cost = known ? dec(answer.inputTokens!).mul(this.settings.inputUsdPerMTok).add(dec(answer.outputTokens ?? 0).mul(this.settings.outputUsdPerMTok)).div(1_000_000).toFixed() : this.settings.unknownCostReserveUsd;
        this.finish({ kind: "finish", id: start.id, status: "ok", latencyMs: Math.max(0, Date.now() - start.startedAt), costUsd: cost, costBasis: known ? "token_estimate" : "unknown_reserve", answer });
      } catch (e) {
        const auth = typeof e === "object" && e !== null && "statusCode" in e && (e.statusCode === 401 || e.statusCode === 403);
        if (auth) this.authFailed = true;
        this.finish({ kind: "finish", id: start.id, status: timedOut || controller.signal.aborted ? "timeout" : "error", latencyMs: Math.max(0, Date.now() - start.startedAt), costUsd: this.settings.unknownCostReserveUsd, costBasis: "unknown_reserve", failure: auth ? "auth" : timedOut || controller.signal.aborted ? "timeout" : "provider" });
      } finally { if (timer) clearTimeout(timer); this.controller = null; }
    })().catch(() => { this.journalFailure = true; }).finally(() => { this.running = null; });
    return true;
  }

  async wait() { await this.running; this.health(); }
  audit(consumed: ReadonlySet<string>) {
    let committed = dec(0), unapplied = dec(0), unknown = dec(0);
    for (const s of this.starts.values()) {
      const f = this.finishes.get(s.id), cost = dec(f?.costUsd ?? this.settings.unknownCostReserveUsd);
      committed = committed.add(cost);
      if (!consumed.has(s.id)) unapplied = unapplied.add(cost);
      if (!f || f.costBasis === "unknown_reserve") unknown = unknown.add(cost);
    }
    return {
      provider: "typesafe-ai", requestedModel: this.settings.modelId, promptHash: JEV_PROMPT_HASH,
      requests: this.starts.size, completed: this.finishes.size, inFlight: this.starts.size - this.finishes.size,
      successful: [...this.finishes.values()].filter((f) => f.status === "ok").length,
      unknownCostRequests: [...this.starts.keys()].filter((id) => !this.finishes.has(id) || this.finishes.get(id)!.costBasis === "unknown_reserve").length,
      committedUsd: committed.toString(), unappliedUsd: unapplied.toString(), unknownReserveUsd: unknown.toString(),
      billing: "Token/rate estimates and explicit unknown-cost reserves, not verified provider invoices. The budget limits estimates; it is not a provider-enforced billing cap.",
    };
  }

  async close() {
    if (this.closed) return;
    this.stopping = true;
    this.controller?.abort();
    try { await this.running; invariant(!this.journalFailure, "inference result could not be persisted; inspect both ledgers before resuming"); } finally { this.release(); }
  }
  private release() { if (this.closed) return; this.closed = true; if (this.fd >= 0) closeSync(this.fd); unlinkSync(this.path + ".lock"); }
}

/** Include requests not yet applied to a market frame, including interrupted/abandoned requests. */
export function withInferenceCosts<T extends { netPnlUsd: string; settledNetPnlUsd: string; equityUsd: string; initialEquityUsd: string; peakEquityUsd: string; maxDrawdownPct: string; excessVsHoldUsd: string; costs: { aiUsd: string; totalUsd: string } }>(report: T, audit: ReturnType<JevRunner["audit"]>) {
  const extra = dec(audit.unappliedUsd), net = dec(report.netPnlUsd).sub(extra);
  const equity = dec(report.equityUsd).sub(extra), dd = dec(report.peakEquityUsd).sub(equity).div(report.peakEquityUsd).mul(100);
  return { ...report, netPnlUsd: net.toString(), equityUsd: equity.toString(), maxDrawdownPct: (dd.gt(report.maxDrawdownPct) ? dd : dec(report.maxDrawdownPct)).toString(), netReturnPct: net.div(report.initialEquityUsd).mul(100).toString(), excessVsHoldUsd: dec(report.excessVsHoldUsd).sub(extra).toString(), costs: { ...report.costs, aiUsd: dec(report.costs.aiUsd).add(extra).toString(), unappliedAiUsd: extra.toString(), totalUsd: dec(report.costs.totalUsd).add(extra).toString() }, inferenceAudit: audit };
}

/** Read-only export: include terminal requests without calling the provider or rewriting the ledger. */
export function readUnappliedInference(path: string, inference: NonNullable<DatasetHeader["inference"]>, consumed: ReadonlySet<string>) {
  const bytes = readFileSync(path, "utf8");
  invariant(bytes.endsWith("\n"), "incomplete inference ledger");
  const rows = bytes.trimEnd().split("\n").map((l) => JSON.parse(l));
  const identity = rows.shift();
  invariant(identity.kind === "jev-inference" && identity.version === 1 && identity.promptHash === inference.promptHash && JSON.stringify(identity.settings) === JSON.stringify(inference.settings), "export inference identity differs from paper session");
  validateJevSettings(inference.settings);
  const starts = new Map<string, Start>(), finishes = new Map<string, Finish>();
  for (const e of rows as (Start | Finish)[]) {
    if (e.kind === "start") {
      invariant(typeof e.id === "string" && e.id.length > 0 && !starts.has(e.id) && Number.isSafeInteger(e.sourceBlock) && e.sourceBlock >= 1 && Number.isSafeInteger(e.startedAt) && e.startedAt >= 1 && /^[0-9a-f]{64}$/.test(e.stateHash), "invalid inference start");
      starts.set(e.id, e);
    } else { validateCompletion(e, inference.settings, starts, finishes); finishes.set(e.id, e); }
  }
  for (const id of consumed) invariant(finishes.has(id), "paper decision missing from inference ledger");
  let usd = dec(0), unknown = dec(0);
  const requestIds: string[] = [];
  for (const id of starts.keys()) if (!consumed.has(id)) {
    requestIds.push(id);
    const f = finishes.get(id), cost = f?.costUsd ?? inference.settings.unknownCostReserveUsd;
    usd = usd.add(cost);
    if (!f || f.costBasis === "unknown_reserve") unknown = unknown.add(cost);
  }
  return { usd: usd.toString(), unknownReserveUsd: unknown.toString(), requestIds };
}
