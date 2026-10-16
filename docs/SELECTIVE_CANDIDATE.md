# Selective Entry v1 — separate paper research candidate

Status: separate cloud forward comparison prepared; never activated in the original study.
The original 72-hour cloud run, frozen runtime, checkpoint chain, six scenarios,
market window and dashboard results remain unchanged. This candidate imports no
collector, wallet, signer, Jev client, workflow or live execution adapter.

## Fixed hypothesis

Unsuccessful placements and cancellations can dominate small completed-trade gains.
Reduce entry frequency rather than assume cheaper gas or more generous fills.
Keep patient-v2 signal rules, original touch price, execution latency and 30-block
TTL. Add these uncalibrated entry requirements:

- Signal remains continuously bullish for at least 3 seconds of market time.
- In the trailing 30 seconds, at least 3 actual opposing taker prints occur at or
  below the prospective bid. Their combined volume must be at least twice the
  observed queue ahead (including the existing queue multiplier) plus order size.
  Precisely: volume / (queueAhead + size) >= 2. This is a historical activity
  filter, not a forecast that this volume will recur or a fill probability.
- Wait at least 15 minutes between actual submitted buy attempts, including
  rejected/unfilled attempts. Gate-rejected decisions do not consume this slot.
- Keep an eligible in-flight/resting quote at its original price. Do not chase the
  touch. TTL, invalid signals, economic retention failure and risk stops still
  cancel it. A cancellation can race a fill and still costs gas.
- Entry filters do not delay a funded patient sell signal. This candidate does
  not introduce new time-based exits or guarantee a particular holding period.

The implementation uses the existing recorded-decision engine interface for local
rule decisions, with zero model charges. Its internal `pending` decision marker
means retain an eligible original quote; no inference request is issued. Costs
still include the original inference budget buffer in the economic gate.

## Safety and accounting

Each independent portfolio has $100 initial cash, zero initial MON, 200 MON order
size, 400 MON potential-position cap, $1 cumulative loss stop and 1% peak drawdown
stop. No leverage or daily reset. Constructor guards reject relaxed limits,
disabled/less conservative gate assumptions, optimistic queue multipliers and
inference-liability datasets. There is no live-trading option.

The unchanged execution engine charges full inclusion gas for submissions,
cancellations and rejections, consumes recorded queue before fills, forbids new
quotes from filling decision/inclusion prints, provisions terminal transactions,
and reports estimated depth-based liquidation costs and unresolved inventory.
Stops are triggers; latency/races can overshoot them. Retaining quotes never
bypasses risk stops, economic retention, spread checks or TTL.

Reports include filter rejection counts, actual order fill rate, placed/filled
order counts, total costs, gas per filled order (null with no filled orders),
forward-only fill markouts, net after estimated exit and outstanding exposure.
Do not interpret a high fill rate without its denominators or adverse selection.

## Reproduce the initial retrospective check

Use Bun with environment-file loading disabled:

```sh
bun --no-env-file scripts/compare-selective.ts \
  --input ../../outputs/edgefoundry-long-market.jsonl \
  --config edgefoundry.patient.example.json \
  --out ../../outputs/edgefoundry-selective-v1-retrospective.json
```

This previously observed dataset covers 6,000 finalized blocks, approximately 30
minutes. Baseline and candidate both submitted zero orders, spent zero and made
zero. Candidate filter counts included 51 persistence holds and 46 queue-flow
holds. This is a compatibility/safety check, not evidence of improved fills,
profitability, an untouched holdout, or a completed forward test. No threshold
was selected by searching this replay's returns.

## Separate forward evaluation plan

Freeze this version/policy/config and source identity before a new test begins.
Use independent capital, journals, reports and labels; do not feed its decisions
or results into the original study. Preserve the existing study until its fixed
end and audit. A future collector must journal and replay candidate history,
persistence clock and cooldown exactly before resuming; this offline candidate
is not yet wired to a persistent forward collector.

Compare baseline and candidate over the same market window and assumptions,
including conservative queue and doubled-gas sensitivity. Primary outcome is
whole-portfolio net after all costs and estimated liquidation; track gas per
filled order, nonfilled attempts, fill fraction, rejection/cancellation rate,
5/15/60-minute forward markouts, inventory duration and risk history. Include
zero-trade/unfinished portfolios. Do not combine these outcomes with the running
six scenarios or automatically promote a winner. A handful of fills cannot
establish an edge; seek independent future observations across market conditions
before drawing profitability conclusions. Do not lower the gate to force trades.

## Authorized separate cloud comparison

The fixed prospective cutoff is October 16, 2026 at 21:15:00 UTC. Its end is
October 19 at 06:17:23 UTC (the original study end), not an additional 72 hours.
Each of four fresh independent portfolios starts with $100 and zero MON: patient
and Selective Entry, each under nominal and queue-2/gas-2 assumptions. No prior
original-study P&L, inventory, signals or risk budgets are imported. Warmup starts
at this new cutoff. Only future market timestamps enter its results.

The separate workflow is `.github/workflows/selective-paper.yml`, branch
`edgefoundry-selective-cloud`, concurrency group `edgefoundry-selective-v1-20261016`.
It runs on standard free Ubuntu runners in this public repo, one writer and
4.5-hour segments. It follows the authenticated original seed and consecutive
checkpoint chain read-only: no extra RPC collector, original workflow changes,
original journal writes, paid storage, trading keys or live adapters.

Its independent encrypted report ledger lives in unpublished draft release
415381683. Never publish this draft. Every own checkpoint links its previous
plaintext digest and anchors the original input block/digest/sequence. Each new
runner restores all original inputs into its own SQLite copy, replays all paired
portfolio state (including patient history, persistence, cooldowns, fills and
sticky halts), and compares the previous report exactly before continuing.
Deleting or skipping checkpoints, replacing journals and changing the frozen
`selective-cloud-plan.json`/runtime are forbidden. Failed jobs require inspection
before rerunning, with no prior comparison writer alive. Original run recovery
remains independent. Original study processes must never be cancelled or restarted
as part of comparison recovery.

Local checkpoint inspection uses only:
`python3 scripts/selective-cloud-local.py status --out ../../outputs/edgefoundry-selective-forward.json`
The helper holds existing infrastructure authentication in memory and reads the
owner-only existing checkpoint key. Never print credentials or upload them to
Sites. Market input delivery normally lags the original collector by about 15
minutes, and dashboard publication has additional delay. A running cloud job does
not prove current market coverage. Completion requires reaching the fixed end,
verifying final deterministic replay/net accounting/risk history, and preserving
both complete chains; no automatic promotion.
