const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const n = (v) => Number(v ?? 0);
const money = (v, digits = 4) => `${n(v) < 0 ? "−" : ""}$${Math.abs(n(v)).toFixed(digits)}`;
const number = (v, digits = 0) => n(v).toLocaleString(undefined, { maximumFractionDigits: digits });
const pct = (v) => `${n(v).toFixed(2)}%`;
const row = (label, value, extra = "") => `<div class="split-stat ${extra}"><span>${esc(label)}</span><b>${esc(value)}</b></div>`;
let bundle, current, strategy = "momentum", selectedDecision;
const colors = { edge: "#d7f68e", churn: "#b39de8", baseline: "#d6a18a", hold: "#637265" };

function validateReport(r) {
  if (r?.schema !== "edgefoundry-comparison-v1" || r.liveTradingEnabled !== false || !r.dataset || !Array.isArray(r.variants)) throw new Error("Please import an EdgeFoundry comparison report with live trading disabled.");
  if (!["recorded", "synthetic"].includes(r.dataset.dataKind) || !Number.isFinite(r.dataset.durationSeconds) || !Number.isSafeInteger(r.dataset.frames) || !Number.isFinite(Date.parse(r.dataset.firstObservedAt)) || !Number.isFinite(Date.parse(r.dataset.lastObservedAt))) throw new Error("Invalid dataset information.");
  for (const id of ["momentum-baseline", "momentum-churn", "momentum-edge", "maker-baseline", "maker-churn", "maker-edge", "hold", ...(r.variants.some((v) => v.id === "patient-edge") ? ["patient-edge"] : []), ...(r.variants.some((v) => v.id === "patient-v1") ? ["patient-v1"] : [])]) {
    const v = r.variants.find((x) => x.id === id);
    if (!v || r.variants.filter((x) => x.id === id).length !== 1 || v.liveTradingEnabled !== false || !v.costs || !v.economicGate || !v.quotePolicy || !v.fillQuality || !v.risk || !v.config || !Array.isArray(v.curve) || !Array.isArray(v.economicGate.recentDecisions) || !Array.isArray(v.fillQuality.fills) || !Array.isArray(v.fillQuality.horizons) || v.fillQuality.horizons.length !== 3) throw new Error(`Incomplete variant: ${id}`);
    for (const val of [v.netPnlUsd, v.costs.totalUsd, v.attempts, v.fills, v.maxDrawdownPct, v.risk.potentialInventoryMon]) if (!Number.isFinite(Number(val))) throw new Error("Invalid financial amount in report.");
    for (const point of v.curve) if (!Number.isFinite(Number(point.netPnlUsd)) || !Number.isFinite(point.ts)) throw new Error("Invalid performance series.");
  }
  return r;
}
function acceptData(data) {
  const candidate = data.schema === "edgefoundry-dashboard-v1" ? data : { schema: "edgefoundry-dashboard-v1", runs: [{ label: "Imported recording", report: data }] };
  if (!Array.isArray(candidate.runs) || !candidate.runs.length || candidate.runs.length > 20) throw new Error("Report must contain 1–20 recordings.");
  candidate.runs.forEach((run) => validateReport(run.report));
  if (candidate.multiday && (candidate.multiday.schema !== "edgefoundry-multiday-v1" || candidate.multiday.liveTradingEnabled !== false || !Array.isArray(candidate.multiday.arms))) throw new Error("Invalid multi-day study.");
  if (candidate.selective && (candidate.selective.schema !== "edgefoundry-selective-cloud-v1" || candidate.selective.liveTradingEnabled !== false || candidate.selective.study?.schema !== "edgefoundry-selective-forward-v1" || candidate.selective.study.liveTradingEnabled !== false || !Array.isArray(candidate.selective.study.arms))) throw new Error("Invalid separate paper comparison.");
  bundle = candidate;
  renderMultiDay(candidate.multiday);
  renderSelective(candidate.selective);
  $("runSelect").innerHTML = candidate.runs.map((run, i) => `<option value="${i}">${esc(run.label || `Recording ${i + 1}`)}</option>`).join("");
  $("runSelect").value = String(candidate.runs.length - 1);
  $("downloadButton").disabled = false; $("workspace").hidden = false; $("empty").hidden = true;
  if (candidate.runs.at(-1).report.variants.some((v) => v.id === "patient-edge")) $("strategySelect").value = "patient";
  render();
}
function variants() {
  if (strategy === "patient") return [
    { ...current.variants.find((v) => v.id === "momentum-baseline"), label: "Original momentum", stage: "baseline" },
    { ...current.variants.find((v) => v.id === "momentum-edge"), label: "Previous EdgeFoundry", stage: "churn" },
    { ...current.variants.find((v) => v.id === "patient-edge"), label: "Patient candidate", stage: "edge" },
  ];
  return ["baseline", "churn", "edge"].map((stage) => current.variants.find((v) => v.id === `${strategy}-${stage}`));
}
function render() {
  current = bundle.runs[n($("runSelect").value)].report;
  const hasPatient = current.variants.some((v) => v.id === "patient-edge");
  $("strategySelect").querySelector('option[value="patient"]').disabled = !hasPatient;
  if (!hasPatient && $("strategySelect").value === "patient") $("strategySelect").value = "momentum";
  strategy = $("strategySelect").value;
  const [base, churn, edge] = variants();
  const hold = current.variants.find((x) => x.id === "hold");
  const d = current.dataset;
  $("dataBadge").textContent = `${d.dataKind === "recorded" ? "REAL MARKET DATA" : "SYNTHETIC FIXTURE"} · ${number(d.frames)} BLOCKS · ${(d.durationSeconds / 60).toFixed(1)} MIN · ${(current.evaluationRole ?? "replay").toUpperCase()}`;
  $("netValue").textContent = money(edge.netPnlUsd); $("netValue").className = n(edge.netPnlUsd) < 0 ? "negative" : "";
  $("netNote").textContent = `${money(edge.initialEquityUsd, 0)} starting capital · marked to mid`;
  const savings = n(base.costs.totalUsd) - n(edge.costs.totalUsd);
  $("savedValue").textContent = money(savings); $("savedValue").className = savings < 0 ? "negative" : "";
  $("attemptValue").textContent = number(edge.attempts); $("attemptNote").textContent = `${number(base.attempts)} with original cadence`;
  $("fillValue").textContent = number(edge.fills); $("fillNote").textContent = `${number(d.tradePrints)} observed market trades`;
  $("savedNote").textContent = `Compared with ${base.label.toLowerCase()}`;
  $("edgeLegend").innerHTML = `<i class="edge-color"></i>${esc(edge.label)}`;
  $("churnLegend").innerHTML = `<i class="churn-color"></i>${esc(churn.label)}`;
  $("baseLegend").innerHTML = `<i class="baseline-color"></i>${esc(base.label)}`;
  for (const v of [base, churn, edge]) $("qualitySelect").querySelector(`option[value="${v.stage}"]`).textContent = v.label;
  renderChart([base, churn, edge, hold]);
  const g = edge.economicGate;
  $("gateHeadline").innerHTML = `<strong>${g.accepted === 0 ? "No trades cleared." : `${number(g.accepted)} cleared`}</strong><p>${g.accepted === 0 ? "No new quotes cleared the modeled cost hurdle." : "Quotes cleared the estimated economic hurdle."}</p>`;
  $("gateHeadline").querySelector("strong").style.fontSize = g.accepted === 0 ? "25px" : "35px";
  $("gateBar").style.width = `${g.evaluated ? 100 * g.blocked / g.evaluated : 0}%`;
  $("gateAccepted").textContent = number(g.accepted); $("gateBlocked").textContent = number(g.blocked); $("gateRetained").textContent = number(g.retained);
  $("comparisonRows").innerHTML = [edge, churn, base, ...(strategy === "patient" && current.variants.some((v) => v.id === "patient-v1") ? [current.variants.find((v) => v.id === "patient-v1")] : []), hold].map((v) => `<tr class="${v.stage === "edge" ? "featured" : ""}"><td><span class="row-dot" style="background:${colors[v.stage] || colors.hold}"></span>${esc(v.label)}</td><td class="${n(v.netPnlUsd) < 0 ? "negative" : ""}">${money(v.netPnlUsd)}</td><td>${money(v.costs.totalUsd)}</td><td>${number(v.attempts)}</td><td>${number(v.fills)}</td><td>${pct(v.maxDrawdownPct)}</td></tr>`).join("");
  const q = churn.quotePolicy;
  $("comparisonNote").textContent = `Fewer replacements kept ${number(q.minimumRest + q.smallPriceMove + q.insufficientImprovement)} quotes through small changes. Original expiry: ${base.config.orderTtlBlocks} blocks; updated expiry: ${churn.config.orderTtlBlocks} blocks. A flat result is not evidence of a profitable strategy.`;
  if (strategy === "patient") $("comparisonNote").textContent = `Patient v2 adds 30s/5s trend and actual taker-flow checks; materially opposing depth vetoes entry. It joins the best price. Archived v1 required positive depth confirmation. Previous EdgeFoundry uses the original momentum signal plus cost gate. All risk, size and gate settings are preserved. ${current.evaluationRole === "development" ? "This development recording informed the book-policy revision; it is not an untouched test." : current.evaluationRole === "heldout" ? "Configurations were frozen before this recording’s strategy outcomes were evaluated; every attempted variant is retained." : "Fixed-setting replay; do not assume previously inspected data is an untouched test."}`;
  selectedDecision = undefined; renderDecisions(); renderQuality(); renderRisk(edge); renderSignals(edge);
  $("footerStatus").textContent = `${d.dataKind === "recorded" ? "Recorded market data" : "Synthetic fixture"} · Read-only snapshot`;
}
function renderChart(list) {
  const width = 760, height = 218, left = 65, right = 16, top = 20, bottom = 30;
  const values = list.flatMap((v) => v.curve.map((p) => n(p.netPnlUsd)));
  let lo = Math.min(0, ...values), hi = Math.max(0, ...values);
  const spread = Math.max(0.02, hi - lo); lo -= spread * 0.13; hi += spread * 0.13;
  const first = Math.min(...list.flatMap((v) => v.curve.map((p) => p.ts)));
  const last = Math.max(...list.flatMap((v) => v.curve.map((p) => p.ts)));
  const x = (ts) => left + (ts - first) / Math.max(1, last - first) * (width - left - right);
  const y = (value) => top + (hi - value) / (hi - lo) * (height - top - bottom);
  let svg = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"><title>Net paper result in dollars over the selected recording</title>`;
  for (let i = 0; i <= 4; i++) { const v = lo + (hi - lo) * i / 4; svg += `<line x1="${left}" y1="${y(v)}" x2="${width - right}" y2="${y(v)}" stroke="#2b352d" stroke-dasharray="3 5"/><text x="${left - 10}" y="${y(v) + 4}" text-anchor="end">${money(v, hi - lo < 0.1 ? 3 : 2)}</text>`; }
  // Render cash first so a flat EdgeFoundry line remains visible.
  for (const v of [...list].sort((a, b) => a.stage === "hold" ? -1 : b.stage === "hold" ? 1 : 0)) {
    const points = v.curve.map((p) => `${x(p.ts).toFixed(2)},${y(n(p.netPnlUsd)).toFixed(2)}`).join(" ");
    svg += `<polyline points="${points}" fill="none" stroke="${colors[v.stage] || colors.hold}" stroke-width="${v.stage === "edge" ? 2.4 : 1.5}" ${v.stage === "hold" ? 'stroke-dasharray="3 6"' : ""}/>`;
  }
  for (let i = 0; i <= 4; i++) { const ts = first + (last - first) * i / 4; svg += `<text x="${x(ts)}" y="${height - 6}" text-anchor="${i === 0 ? "start" : i === 4 ? "end" : "middle"}">${esc(new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}</text>`; }
  $("chart").innerHTML = svg + "</svg>";
}
function renderDecisions() {
  const edge = variants()[2], audit = edge.economicGate.recentDecisions;
  const filter = $("decisionFilter").value;
  const matches = audit.map((d, i) => ({ ...d, i })).reverse().filter((d) => filter === "all" || d.outcome === filter).slice(0, 12);
  if (!matches.some((d) => d.i === selectedDecision)) selectedDecision = matches[0]?.i;
  $("decisionRows").innerHTML = matches.length ? matches.map((d) => `<tr class="${d.i === selectedDecision ? "selected-decision" : ""}"><td>${number(d.block)}<span class="row-meta">${esc(d.side.toUpperCase())} @ ${number(d.price, 6)}</span></td><td class="${n(d.expectedNetEdgeUsd) < 0 ? "negative" : ""}">${money(d.expectedNetEdgeUsd, 5)}</td><td><span class="outcome ${esc(d.outcome)}">${esc(d.outcome.toUpperCase())}</span></td><td><button class="inspect" data-decision="${d.i}" aria-label="Inspect decision at block ${number(d.block)}">↗</button></td></tr>`).join("") : '<tr><td colspan="4" class="empty-row">No matching decisions in this report.</td></tr>';
  $("decisionRows").querySelectorAll("[data-decision]").forEach((b) => b.addEventListener("click", () => { selectedDecision = n(b.dataset.decision); renderDecisions(); }));
  const d = audit[selectedDecision];
  $("decisionBlock").textContent = d ? `#${d.block}` : "";
  $("decisionBreakdown").innerHTML = d ? row("Expected spread capture", money(d.expectedCaptureUsd, 5)) + row("Entry + exit fees", "−" + money(d.expectedFeesUsd, 5)) + row("Adverse price reserve", "−" + money(d.adverseSelectionReserveUsd, 5)) + row("Uncertainty reserve", "−" + money(d.uncertaintyReserveUsd, 5)) + row("Gas budget", "−" + money(d.gasBudgetUsd, 5)) + row("Inference allocation", "−" + money(d.inferenceBudgetUsd, 5)) + row("Estimated net edge", money(d.expectedNetEdgeUsd, 5), "total") + row("Required minimum", money(d.requiredNetEdgeUsd, 5)) + `<p class="note">${esc(d.reason)}. These are estimates used to make a decision; actual simulated costs are recorded separately.</p>` : '<p class="estimate-empty">Select a cost-gate decision to inspect its assumptions.</p>';
}
function renderQuality() {
  const stage = $("qualitySelect").value, v = variants().find((x) => x.stage === stage), quality = v.fillQuality;
  $("qualityMessage").innerHTML = v.fills ? `${number(v.fills)} simulated fill events in ${esc(v.label)}. Times use ${esc(current.dataset.clock)}.` : `No fills in ${esc(v.label)}; markouts are unavailable. ${stage === "edge" ? '<button id="viewBaselineFills">Inspect original cadence</button>' : "Choose another configuration to inspect its fills."}`;
  $("viewBaselineFills")?.addEventListener("click", () => { $("qualitySelect").value = "baseline"; renderQuality(); });
  $("markoutCards").innerHTML = quality.horizons.map((h) => `<div class="markout-card"><div>AFTER ${h.horizonMs / 1000} SECOND${h.horizonMs === 1000 ? "" : "S"}</div><strong class="${n(h.notionalWeightedBps) < 0 ? "negative" : ""}">${h.notionalWeightedBps === null ? "—" : n(h.notionalWeightedBps).toFixed(2) + " bps"}</strong><small>${number(h.measured)} measured · ${number(h.censored)} censored · ${number(h.late)} late</small></div>`).join("");
  $("fillRows").innerHTML = quality.fills.length ? quality.fills.slice(-30).reverse().map((fill) => `<tr><td>${number(fill.block)}<span class="row-meta">${esc(fill.side.toUpperCase())} · ${esc(fill.clock)} time</span></td><td>${number(fill.size, 4)} MON</td><td>${money(fill.price, 6)}</td>${[1000, 5000, 30000].map((h) => { const m = fill.markouts.find((x) => x.horizonMs === h); return `<td>${!m ? "Censored" : m.status === "late" ? "Late" : `<span class="${n(m.bps) < 0 ? "negative" : "positive"}">${n(m.bps).toFixed(2)} bps</span><span class="row-meta">at ${(m.observedAfterMs / 1000).toFixed(1)}s</span>`}</td>`; }).join("")}</tr>`).join("") : '<tr><td colspan="6" class="empty-row">No simulated fills to measure.</td></tr>';
}
function renderSignals(edge) {
  const diagnostics = edge.strategyDiagnostics;
  const reasons = { warmup: "Waiting for history", insufficient_depth: "Insufficient order-book depth", thin_flow: "Too little traded volume", fast_market: "Price moving too fast", conflicting_signals: "Price, flow or depth check failed", spot_balance: "Spot inventory constraint", ready: "Signals agreed" };
  $("signalChecks").innerHTML = diagnostics && Object.keys(diagnostics.counts).length ? Object.entries(reasons).map(([key, label]) => row(label, number(diagnostics.counts[key] ?? 0) + " frames")).join("") + '<p class="note">These are sequential eligibility reasons, not independent scores or calibrated probabilities. A ready signal still must pass economic and risk checks.</p>' : '<p class="estimate-empty">Select the Patient candidate in a newer recording to inspect its signal checks.</p>';
  if (edge.signalQuality?.samples.length) $("signalChecks").innerHTML += edge.signalQuality.horizons.map((h) => row(`${h.horizonMs / 1000}s signed price move after signal`, h.averageSignedBps === null ? "Not measured" : `${n(h.averageSignedBps).toFixed(2)} bps · ${h.measured} samples`)).join("") + '<p class="note">Signals are sampled at least 30 seconds apart. These price moves are not fills or profits, and do not feed the trading rules.</p>';
  const t = edge.economicGate.touchEconomics;
  $("touchEconomics").innerHTML = t ? row("Best-price quotes checked", number(t.quotesChecked)) + row("Quotes clearing costs and buffers", number(t.quotesClearing)) + row("Best estimated net edge", t.bestEstimatedNetEdgeUsd === null ? "—" : money(t.bestEstimatedNetEdgeUsd, 5)) + row("Average required capture", t.averageRequiredCaptureBps === null ? "—" : n(t.averageRequiredCaptureBps).toFixed(2) + " bps to midpoint") : '<p class="estimate-empty">Cost-feasibility diagnostics are available in newer reports.</p>';
}
function renderRisk(edge) {
  const r = edge.risk, g = edge.config.economicGate, q = edge.config.quotePolicy;
  $("riskState").textContent = edge.halted ? "HALTED" : "WITHIN LIMITS";
  const bar = (label, text, value) => `<div class="risk-line"><div class="risk-label"><span>${esc(label)}</span><b>${esc(text)}</b></div><div class="risk-track"><span style="width:${Math.max(0, Math.min(100, n(value)))}%"></span></div></div>`;
  $("riskBars").innerHTML = bar("Session loss", `${money(Math.max(0, -n(edge.netPnlUsd)))} / ${money(r.maxLossUsd, 2)}`, r.lossBudgetUsedPct) + bar("Maximum drawdown", `${pct(edge.maxDrawdownPct)} / ${pct(r.maxDrawdownPct)}`, n(edge.maxDrawdownPct) / n(r.maxDrawdownPct) * 100) + bar("Potential inventory", `${number(r.potentialInventoryMon, 2)} / ${number(r.maxPositionMon)} MON`, n(r.potentialInventoryMon) / n(r.maxPositionMon) * 100) + row("Current inventory", `${number(edge.inventoryMon, 4)} MON`) + row("Cash balance", money(edge.cashUsd)) + (edge.halted ? row("Halt reason", edge.halted) : "");
  $("assumptions").innerHTML = row("Assumed fill fraction", g ? pct(n(g.expectedFillFraction) * 100) + " · uncalibrated" : "Disabled") + row("Adverse price / uncertainty buffer", g ? `${g.adverseSelectionBps} / ${g.uncertaintyBps} bps` : "—") + row("Maker / exit fee assumptions", `${edge.assumptions.makerFeeBps} / ${g?.exitFeeBps ?? "—"} bps`) + row("Minimum estimated profit", money(g?.minNetEdgeUsd)) + row("Rest before ordinary repricing", `${q?.minRestBlocks ?? 0} blocks`) + row("Minimum price change", `${q?.minRepriceBps ?? 0} bps`) + row("Quote expiry", `${edge.config.orderTtlBlocks} blocks`) + row("Inference provider", "Jev not connected") + row("Position leverage", "None · funded spot only");
  if (edge.liquidationEstimate) {
    const estimate = edge.liquidationEstimate;
    $("riskBars").innerHTML += row("Net after estimated exit", estimate.netAfterExitUsd === null ? "Insufficient recorded depth" : money(estimate.netAfterExitUsd));
  }
  if (edge.config.patient) $("assumptions").innerHTML += row("Book policy", edge.config.patient.bookPolicy === "veto_opposition" ? "Veto opposing depth" : "Require confirming depth") + row("Long / short signal windows", `${edge.config.patient.lookbackMs / 1000}s / ${edge.config.patient.shortLookbackMs / 1000}s`) + row("Minimum trailing traded volume", `${edge.config.patient.minFlowVolumeMon} MON`);
  $("provenance").innerHTML = `<p>${esc(current.methodology)}</p><p>${esc(current.jev)}</p><p><b>Recording:</b> ${esc(new Date(current.dataset.firstObservedAt).toLocaleString())} – ${esc(new Date(current.dataset.lastObservedAt).toLocaleString())}. ${number(current.dataset.frames)} blocks, ${number(current.dataset.tradePrints)} taker prints. Market move ${pct(current.dataset.marketReturnPct)}.</p><p><b>Source:</b> ${esc(current.dataset.source)}<br><b>Market:</b> <code>${esc(current.dataset.market)}</code><br><b>Dataset SHA-256:</b> <code>${esc(current.dataset.sha256)}</code><br><b>Engine:</b> ${esc(edge.engineVersion)}</p><p>This is a saved research snapshot. Import another comparison report to update it. All money here is simulated; this interface has no trading controls.</p>`;
}
$("runSelect").addEventListener("change", render);
$("strategySelect").addEventListener("change", render);
$("qualitySelect").addEventListener("change", renderQuality);
$("decisionFilter").addEventListener("change", renderDecisions);
$("importButton").addEventListener("click", () => $("fileInput").click());
$("fileInput").addEventListener("change", async () => {
  const file = $("fileInput").files[0]; if (!file) return;
  try { if (file.size > 30_000_000) throw new Error("Please use a report smaller than 30 MB."); acceptData(JSON.parse(await file.text())); $("notice").textContent = "Report loaded locally. Nothing was uploaded."; }
  catch (e) { $("notice").textContent = `Could not load report: ${e.message}`; }
  finally { $("fileInput").value = ""; }
});
$("downloadButton").addEventListener("click", () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" }));
  const a = document.createElement("a"); a.href = url; a.download = "edgefoundry-research.json"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
document.querySelectorAll("nav a").forEach((a) => a.addEventListener("click", () => { document.querySelectorAll("nav a").forEach((x) => x.classList.remove("selected")); a.classList.add("selected"); }));
try { const response = await fetch("./report.json", { cache: "no-store" }); if (!response.ok) throw new Error("No saved report is available."); acceptData(await response.json()); }
catch (e) { $("empty").hidden = false; $("notice").textContent = `${e.message} Use Import report to open a comparison.`; }

function renderMultiDay(study) {
  $("multiday").hidden = !study; if (!study) return;
  const hours = n(study.elapsedMarketHours), target = study.protocol.durationMs / 3600000;
  const updated = new Date(study.updatedAt), age = Math.max(0, (Date.now() - updated.getTime()) / 60000);
  const lagSeconds = study.feedLagSeconds, lagKnown = typeof lagSeconds === "number" && Number.isFinite(lagSeconds);
  const inCloud = study.executionHost === "github-actions";
  const catchingUp = study.runStatus === "running" && lagKnown && lagSeconds > 120;
  $("studyStatus").textContent = study.runStatus === "completed" ? "COMPLETED" : study.runStatus === "failed" ? "NEEDS ATTENTION" : study.runStatus === "development-replay" ? "DEVELOPMENT REPLAY" : study.runStatus === "interrupted" ? "PAUSED" : study.runStatus === "retrying" ? "RETRYING DATA FEED" : catchingUp ? "CATCHING UP AT LAST SNAPSHOT" : "IN PROGRESS AT LAST SNAPSHOT";
  $("studyTiming").textContent = `${hours.toFixed(2)} of ${target} market hours observed · ${number(study.frames)} consecutive blocks · ${number(study.tradePrints)} trade prints. Market data through ${new Date(study.marketThrough).toLocaleString()}. Snapshot ${updated.toLocaleString()}.`;
  const p = study.primary;
  $("studyMetrics").innerHTML = row("Main portfolio · net after estimated exit", p.liquidationEstimate.netAfterExitUsd === null ? "Unresolved" : money(p.liquidationEstimate.netAfterExitUsd)) + row("Main orders / fills", `${number(p.attempts)} / ${number(p.fills)}`) + row("Risk controls", "$1 loss · 1% drawdown · 400 MON cap") + row("Scheduled market window end", new Date(study.scheduledEndAt).toLocaleString()) + row("Data delay when snapshot was saved", lagKnown ? lagSeconds >= 120 ? `${number(lagSeconds / 60, 1)} minutes` : `${number(lagSeconds, 1)} seconds` : "Not applicable");
  $("studyRows").innerHTML = study.arms.map(a => `<tr><td>${a.horizonMinutes} min<span class="row-meta">${a.scenario.gas === 1 ? "Full displayed queue · standard gas" : "Double queue · double gas"}</span></td><td>${a.netAfterEstimatedExitUsd === null ? "Unresolved exit" : money(a.netAfterEstimatedExitUsd)}<span class="row-meta">All attempts and costs included</span></td><td>${number(a.completedOrders)} / ${a.anyFillRate === null ? "Awaiting outcomes" : pct(a.anyFillRate * 100)}<span class="row-meta">Quantity filled: ${a.completedOrderFillFraction === null ? "—" : pct(a.completedOrderFillFraction * 100)}</span></td><td>${number(a.roundTrips)}<span class="row-meta">${number(a.wins)} positive · ${number(a.losses)} negative</span></td><td>${number(a.inventoryMon, 4)} MON<span class="row-meta">${esc(a.halted || (a.unresolvedInventory ? "Position open" : a.pendingOrder ? "Entry pending" : "Waiting for signal"))}</span></td></tr>`).join("");
  const cost = study.costs;
  $("studyCosts").innerHTML = row("Observed transaction budget range", `${money(cost.transactionBudgetUsd.min, 5)} – ${money(cost.transactionBudgetUsd.max, 5)}`) + row("Public fee snapshots", number(cost.feeObservations)) + row("Latest observed maker / taker fee", cost.latestMarketCosts ? `${cost.latestMarketCosts.makerFeeBps} / ${cost.latestMarketCosts.takerFeeBps} bps` : "No fee observations in this recording") + row("Exit fee floor", `${p.config.economicGate.exitFeeBps} bps`);
  $("studyConclusion").textContent = `${study.conclusion} ${inCloud ? "Collection runs on free GitHub-hosted runners with encrypted recovery checkpoints and can continue while the Mac sleeps. " : ""}${study.lastError ? "Collector issue: " + study.lastError + ". " : ""}${catchingUp ? "The collector was backfilling delayed market data at this snapshot. The original window and consecutive-block requirement remain in force. " + (inCloud ? "" : "Keep the Mac awake and online for collection. ") : ""}${age > 10 ? "This hosted snapshot is older than 10 minutes; it does not confirm the collector is still running. " : ""}Updated periodically, not a live connection to the collector.`;
  $("studyProvenance").textContent = `${cost.methodology} Journal digest: ${study.journalDigest || "offline replay"}. Frozen source: ${study.identity?.sourceDigest || "unavailable"}.`;
}

function renderSelective(data) {
  $("selective").hidden = !data; if (!data) return;
  const s = data.study;
  $("selectiveStatus").textContent = s.runStatus === "completed" ? "WINDOW COMPLETE AT SNAPSHOT" : s.runStatus === "waiting_for_start" ? "WAITING FOR FIRST WINDOW DATA" : "IN PROGRESS AT SNAPSHOT";
  $("selectiveTiming").textContent = `Fixed window: ${new Date(s.startAt).toLocaleString()} – ${new Date(s.endAt).toLocaleString()}. ${s.marketThrough ? "Market observations through " + new Date(s.marketThrough).toLocaleString() + "." : "No comparison-window observations processed yet."}`;
  $("selectiveMetrics").innerHTML = row("Each portfolio starts with", "$100 · zero MON") + row("Unchanged limits", "$1 loss · 1% drawdown · 400 MON cap") + row("Economic gate / live trading", "Enabled / disabled") + row("Compared portfolios", "2 strategies × 2 cost scenarios");
  $("selectiveRows").innerHTML = s.arms.length ? s.arms.map(a => `<tr><td>${a.id.startsWith("selective") ? "Selective Entry v1" : "Patient v2"}<span class="row-meta">${a.id.endsWith("2") ? "Double queue · double gas" : "Full displayed queue · standard gas"}</span></td><td>${a.liquidationEstimate.netAfterExitUsd === null ? "Unresolved exit" : money(a.liquidationEstimate.netAfterExitUsd)}<span class="row-meta">All attempts and exit reserves included</span></td><td>${money(a.costs.totalUsd)} / ${number(a.attempts)}<span class="row-meta">Gas + reserves: ${money(n(a.costs.gasUsd) + n(a.costs.gasReserveUsd))}</span></td><td>${number(a.filledOrders)} / ${number(a.placed)}<span class="row-meta">${a.placed ? pct(a.orderFillRate * 100) : "No orders · fill rate unavailable"}</span></td><td>${pct(a.maxDrawdownPct)}<span class="row-meta">${number(a.risk.potentialInventoryMon, 4)} potential MON · ${esc(a.halted || "No risk halt")}</span></td></tr>`).join("") : '<tr><td colspan="5">Awaiting the first saved observations after the comparison cutoff. No performance result yet.</td></tr>';
  const c = s.arms.find(a => a.id === "selective-queue-1-gas-1");
  $("selectiveFilters").textContent = c ? `Selective Entry filters: ${number(c.filterCounts.insufficient_queue_flow)} queue-flow holds · ${number(c.filterCounts.signal_persistence)} persistence holds · ${number(c.filterCounts.entry_cooldown)} cooldown holds. Gas per filled order including terminal gas reserves: ${c.gasPerFilledOrderUsd === null ? "unavailable — no filled orders" : money(c.gasPerFilledOrderUsd)}. No profitable edge is established by these early observations.` : "The candidate's queue, persistence and cooldown counters will appear with its first market observations.";
  $("selectiveFreshness").textContent = `Cloud report saved ${new Date(data.updatedAt).toLocaleString()}. This is a published snapshot, not a live connection. Input delivery normally trails the original collector by about 15 minutes; dashboard publication adds further delay. Source checkpoint ${data.sourceSequence}; comparison checkpoint ${data.checkpointSequence ?? "pending"}.`;
  $("selectiveEvidence").textContent = `${s.methodology} Frozen comparison source: ${s.codeDigest}.`;
}
