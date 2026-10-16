# EdgeFoundry

A reproducible trading research foundation derived from [jarrodwatts/jev-trader](https://github.com/jarrodwatts/jev-trader), upstream commit `d6254bf`.

**Live trading is disabled.** This version adds backtesting, cost accounting and durable paper sessions. It does not establish a profitable strategy or implement a production live exchange adapter. Do not fund it for trading.

## What changed

- One deterministic engine powers historical replay and paper trading.
- Decimal accounting includes quote-asset maker fees/rebates, gas for placements/cancellations/reverts, AI charges even on held or late decisions, and end-of-window gas provisions.
- Quotes activate after a configurable delay. Existing orders consume the current block's prints before cancellation settles; new quotes cannot fill on those prints. Exact-touch fills wait behind displayed queue depth.
- Post-only crossing, cancellation/fill races, partial fills, spot balances, pending exposure, inventory caps, quote TTL, loss stops and drawdown stops are modeled.
- A chronological development/test split selects a momentum confidence threshold using development results only. Reports include hold/maker baselines and doubled gas/latency/queue sensitivity checks.
- Paper sessions persist inputs before applying them and rebuild their complete state on restart. Concurrent writers, configuration changes, broken block continuity, duplicate trade logs and truncated journals fail closed.
- The recorder reads finalized block-pinned books, block hashes and trade logs. It never signs or submits trades.

## EdgeFoundry: economic gate and dashboard

The recommended research profile is `edgefoundry.example.json`. It starts with $100 simulated cash, a $1 session loss stop, 1% maximum drawdown, 400 MON potential-position cap, and no borrowing. These are paper-research defaults, not a calibrated investment mandate. Execution delay means a stop is not a guaranteed loss ceiling.

```sh
bun run paper --config edgefoundry.example.json --state data/edgefoundry.jsonl --blocks 1500 --out data/edgefoundry-paper.json
bun run paper:export --state data/edgefoundry.jsonl --out data/edgefoundry-market.jsonl
bun run edgefoundry:compare --input data/edgefoundry-market.jsonl --out data/edgefoundry-comparison.json
bun run dashboard --report data/edgefoundry-comparison.json
```

Open the printed local address. The read-only dashboard shows performance curves, costs, baseline comparisons, gate decisions with their arithmetic, 1/5/30-second fill markouts, and risk/assumption panels. Import a comparison JSON to inspect it locally in the browser; download preserves the report. The hosted private version is a saved snapshot, not a continuously running bot. Neither UI has trading routes or live-enablement controls.

The **economic gate** discounts current-mid spread capture by an explicit assumed filled-quantity fraction (10%), then subtracts entry/exit fees, adverse-selection and uncertainty reserves, three full transaction budgets (placement, cancellation, eventual exit), and an inference allocation. A partial fill can require a full exit transaction; gas is never scaled down by filled quantity. A quote must clear the configured minimum net edge. These are conservative, uncalibrated assumptions; no model confidence is interpreted as a fill probability or future return. The expected costs are filters and are not added to actual ledger costs.

The **quote policy** retains safe same-side quotes through a minimum rest period or small price changes, preserving queue position. With the gate enabled, replacement also needs enough incremental expected value to cover new costs. Hold/low-confidence/deadline/risk/spread/expiry conditions still request cancellation, and adverse or crossing old prices cannot be retained just to save gas. Pending Jev inference cannot override those checks. The profile extends expiry from 5 to 30 blocks; the comparison labels that change explicitly.

The **fill diagnostics** measure signed fill-price-to-future-mid returns at 1, 5 and 30 seconds. Positive favors the maker. Each partial fill is tracked; aggregates weight by filled notional. Missing end-of-window horizons are censored, and snapshots more than 1 second late are excluded from aggregates. New recordings use canonical block timestamps (1-second resolution); older recordings fall back to collector observation time. Markouts never feed future information back into trading decisions.

`edgefoundry:compare` runs fixed original-cadence, reduced-replacement, full-gate and cash-hold variants on identical inputs and capital/risk limits. It includes doubled gas/latency/queue and 5-bps fee scenarios. It does not select parameters. `research.example.json` remains available for legacy baseline reproduction; opt-in settings preserve those experiments. Jev remains an optional inference adapter and still requires a TypeSafe API key.

## Patient strategy research

`edgefoundry.patient.example.json` adds a selective, uncalibrated hypothesis: 30-second and 5-second price trends must agree with actual signed taker volume; materially opposing top-three-level depth vetoes a quote. Neutral depth is allowed. Thin flow, fast moves, missing depth and spot-balance constraints hold. It joins the best price rather than paying one tick to improve it. It preserves the recommended profile's cash, order size, loss/drawdown/position limits and all economic-gate settings.

The archived `edgefoundry.patient-v1.example.json` required positive depth confirmation. Development data showed balanced depth often blocked every signal; v1 remains reproducible and included in comparisons. No forecast return or model probability is credited to either candidate's economic gate.

```sh
bun run edgefoundry:compare --input data/edgefoundry-market.jsonl --candidate edgefoundry.patient.example.json --reference edgefoundry.patient-v1.example.json --role heldout --out data/patient-comparison.json
bun run dashboard --report data/patient-comparison.json
```

Use `--role development` for data used to refine rules, `heldout` only for outcomes not consulted during rule selection, and the default `replay` for general fixed-setting replays. The role is a study declaration, not an automatic independence guarantee. The report retains every supplied variant; it performs no automated selection.

New diagnostics distinguish signal rejection from cost infeasibility, measure spaced signals' subsequent price moves, and estimate remaining inventory's proceeds through recorded bid depth after exit reserves. Signal outcomes are diagnostic only; no future labels enter decisions. Hypothetical signal returns are not fills or profit. [The research protocol](docs/STRATEGY_RESEARCH.md) explains the limits.

## Quick start: offline verification

Requires Bun 1.4.3 or later. No wallet or API key is needed.

```sh
bun install --frozen-lockfile
bun run typecheck
bun test tests
bun run backtest --input fixtures/synthetic.jsonl --out data/example-backtest.json
bun run paper:replay --input fixtures/synthetic.jsonl --state data/example-paper.jsonl --out data/example-paper-report.json
# Repeat the same replay command: saved frames are verified and never applied twice.
```

`fixtures/synthetic.jsonl` is artificial software-test data. Its returns are not market evidence. Regenerate it with `bun run fixture`.

## Record a market and paper trade

```sh
cp .env.example .env
# Keep DRY_RUN=true. Configure RPC_URL and READ_RPC_URL if needed.
# Review the cost and risk assumptions in research.example.json first.
bun run paper --config research.example.json --state data/mon-paper.jsonl --blocks 1000 --out data/mon-paper-report.json
bun run paper:export --state data/mon-paper.jsonl --out data/mon-market.jsonl
bun run backtest --input data/mon-market.jsonl --config research.example.json --out data/mon-backtest.json
```

The example's `makerFeeBps: "0"`, gas limit and AI price are **assumptions**, not verified current exchange pricing. The collector records each block's base fee plus the configured priority fee; gas limit, maker fees and execution delays remain simulation inputs. Existing dataset headers control backtest costs; the config file supplies strategy/risk settings. Edit the dataset header deliberately to run a different fee scenario.

Only finalized blocks are used. On restart the collector backfills every missing block and checks parent hashes, rather than skipping to the latest price. This is suitable for research; it does not measure a live low-latency strategy. Historical book reads must be supported by the RPC. Missing finalized support, missing historical state, incomplete logs or a stalled feed stop the process. There is no fallback to unfinalized snapshots.

`Ctrl-C` stops between observations and releases the journal lock. After a process crash, first verify that no writer is running, then remove the stale `<state>.lock` and rerun with the same configuration. A partial last line is rejected: preserve the original and recover only the complete newline-terminated prefix into a new file. Never edit financial state to force a restart.

## Strategies and AI

- `momentum`: transparent momentum/book/flow heuristic with a confidence threshold. These scores are not calibrated probabilities.
- `maker`: inventory-directed one-sided quoting baseline.
- `hold`: retain the initial portfolio without orders.
- `recorded`: replay previously recorded causal model decisions, including their latency and actual USD charge (or the header's per-decision assumption if no charge is supplied).

The collector can call Jev through the installed TypeSafe AI SDK. Put `TYPESAFE_AI_API_KEY` in a local `.env` file (never in JSON configuration or Git), keep `DRY_RUN=true`, and run:

```sh
bun run paper --config research.jev.example.json --state data/jev-paper.jsonl --blocks 3000 --out data/jev-paper-report.json
bun run paper:export --state data/jev-paper.jsonl --out data/jev-market.jsonl
bun run paper:compare --input data/jev-market.jsonl --config research.jev.example.json --out data/jev-comparison.json
```

**No credential means no Jev run.** This path fails before market I/O or state creation if the key is missing; it never substitutes the upstream mock. The transport has offline SDK contract tests, but an authenticated service run still requires a real key.

At most one inference runs at a time. Market recording continues while it is pending. Replies are recorded on their actual availability frame, with source block, request ID, returned model ID, latency and usage. A stale response holds; an error or timeout also holds. Pending inference preserves an existing quote only until its TTL or a risk/data check requires cancellation. Catch-up history does not trigger fresh live model calls.

The example sets a 750 ms decision deadline, 2.5 s hard request timeout, three-block signal age limit, 5,000-request limit and $1 **estimated** spend limit. These are experimental settings, not measured optimal values. The input/output prices are explicit assumptions; token usage times configured prices is a cost estimate, not a verified invoice. Missing usage, errors, timeouts and abandoned requests reserve $0.001 each. No external provider bill is guaranteed to stay below this local estimate limit.

API starts and completions are persisted in `<state>.jev.jsonl`, alongside the paper journal. Restore both files together. A started request without a completion is conservatively charged on recovery and never automatically resent. Paper reports include inference costs not yet applied to a market frame. Exported datasets retain those final costs as a terminal liability; replay does not drop them. The offline hold/maker/momentum baselines do not pay for Jev calls they did not make.

Use `paper:compare` for a full-period, fixed-parameter comparison. Use `backtest` for the separate development/test selection workflow. Never tune settings against the same period and then call it an untouched test.

The original UI is retained under `web/` and `bun run demo` for reference. It uses the upstream demo simulator, not the research engine or its reports. Live execution is also blocked there. Use the research reports to assess this fork's costs and performance.

## Reading results

`netPnlUsd = grossPnlUsd - costs.totalUsd`. Net P&L includes maker fees, historical gas conversion, AI charges and estimated gas reserves for unresolved inclusion and terminal cancellation. `settledNetPnlUsd` excludes those final provisions. Cash plus inventory marked to mid, less reserves, reconciles to initial equity plus net P&L. Maker fees may be negative for a configured rebate.

Open inventory is **marked to mid, not liquidated**. Exit fees, price impact and proceeds from liquidating it are not simulated. `maxDrawdownPct` includes the terminal reserve adjustment. Never compare an unliquidated report directly with fully liquidated real account returns.

The initial MON position is funded capital valued at the first observed mid. Simulated gas is purchased at each inclusion block's MON mid and charged against USD cash; this is an explicit reporting convention, not a representation of a real gas-wallet balance. No borrowing or short selling is modeled.

Reports preserve dataset provenance, assumptions, selected settings, unresolved orders and risk halt reasons. The execution engine is now `edgefoundry-v4`; older journals must be exported with their original version and replayed as datasets into a new session. They cannot be silently resumed under changed execution semantics. Backtest output also includes a SHA-256 of the input file. The held-out test period must not be reused for strategy tuning. Collect new data for another evaluation.

See [the research specification](SPEC.md) and [accounting and execution details](docs/METHODOLOGY.md) for limits and the live-enablement work still required.
