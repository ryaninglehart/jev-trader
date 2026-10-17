/** Infrastructure readiness only; never changes market inputs or trading rules. */
export function collectorReportReady(report: { processId?: unknown; updatedAt?: unknown }, pid: number, startedAt: number, now: number): boolean {
  const updated = typeof report.updatedAt === "string" ? Date.parse(report.updatedAt) : NaN;
  if (report.processId === pid && Number.isFinite(updated) && updated >= startedAt) return true;
  if (now - startedAt >= 15 * 60000) throw new Error("collector startup exceeded 15 minutes without its own current report; preserve checkpoints and investigate");
  return false;
}
