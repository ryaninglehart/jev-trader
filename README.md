# Jev Trader: research and paper-trading fork

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

The new market collector supports the deterministic strategies. It does not call Jev. To evaluate Jev, first obtain a dataset with decisions recorded after each observation, without future labels, and use `recorded` in the engine settings. Missing decisions fail validation. Training a model, proving its prediction quality and connecting an online AI inference adapter are separate work.

The original UI is retained under `web/` and `bun run demo` for reference. It uses the upstream demo simulator, not the research engine or its reports. Live execution is also blocked there. Use the research reports to assess this fork's costs and performance.

## Reading results

`netPnlUsd = grossPnlUsd - costs.totalUsd`. Net P&L includes maker fees, historical gas conversion, AI charges and estimated gas reserves for unresolved inclusion and terminal cancellation. `settledNetPnlUsd` excludes those final provisions. Cash plus inventory marked to mid, less reserves, reconciles to initial equity plus net P&L. Maker fees may be negative for a configured rebate.

Open inventory is **marked to mid, not liquidated**. Exit fees, price impact and proceeds from liquidating it are not simulated. `maxDrawdownPct` includes the terminal reserve adjustment. Never compare an unliquidated report directly with fully liquidated real account returns.

The initial MON position is funded capital valued at the first observed mid. Simulated gas is purchased at each inclusion block's MON mid and charged against USD cash; this is an explicit reporting convention, not a representation of a real gas-wallet balance. No borrowing or short selling is modeled.

Reports preserve dataset provenance, assumptions, selected settings, unresolved orders and risk halt reasons. Backtest output also includes a SHA-256 of the input file. The held-out test period must not be reused for strategy tuning. Collect new data for another evaluation.

See [the research specification](SPEC.md) and [accounting and execution details](docs/METHODOLOGY.md) for limits and the live-enablement work still required.
