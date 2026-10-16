# Research fork specification

## Objective

Build a reproducible paper-trading and replay foundation on MON-USDC that can measure strategy returns after explicit execution costs, recover state after a process restart, and decline to trade when risk or data checks fail.

The original promotional requirements to place an order every block and show a flickering dashboard are superseded by this research objective.

## Implemented boundary

Paper execution only. Shared deterministic state machine, precise decimal accounting, finalized block recording, causal replay, chronological parameter selection, baselines, cost sensitivity, risk controls, durable input journal and automated checks.

Do not interpret synthetic fixtures, the upstream mock model or the original dashboard as demonstrated trading performance. The collector has a paper-only online Jev adapter with bounded asynchronous inference, causal availability frames, a durable request ledger, usage estimates and unknown-cost provisions. Authenticated Jev service validation remains dependent on an API key; offline SDK contract tests do not establish model performance.

## Acceptance criteria

1. Identical inputs and settings yield identical reports.
2. New quotes cannot fill on observations that caused them.
3. Every simulated included transaction is charged, including cancellations and reverts.
4. Gross P&L minus all costs and provisions equals net P&L; adjusted equity equals funded equity plus net P&L.
5. Startup restores inventory, order state, costs and risk halts from the same journal, without double-counting frames.
6. Broken block continuity, duplicate logs, invalid amounts, changed configuration and incomplete journal writes stop processing.
7. Parameter selection cannot read the held-out test suffix.
8. Normal entry points cannot submit live orders or perform startup funding.

## Required before a funded live pilot

- An independently reviewed exchange adapter that discovers existing orders and balances on startup, reconciles fills/receipts idempotently, and maintains a durable transaction outbox with nonce recovery.
- Contract-verified maker fees/rebates and settlement currencies, actual gas receipts and inference bills, deposit/withdrawal reconciliation and gas-wallet inventory accounting.
- Measurement of order submission latency, fills, queue behavior, post-only rejection and partial-fill/cancel races against real exchange events.
- Emergency cancellation and process-independent monitoring; a loss limit must account for outstanding, already submitted transactions.
- Service-validated online inference, verified inference invoices and calibrated/validated decision thresholds. The paper adapter records requested/returned model IDs, prompt hash and usage; a mutable `jev-latest` alias is not an immutable model-version guarantee.
- Fresh recorded data, multiple untouched forward test periods and performance comparisons after costs. A positive test alone does not establish an edge.
- Separate explicit user authorization for live enablement and any funded trading.

## Exclusions in this iteration

Live order submission, shorting/leverage, optimal execution, an exact exchange matching-engine emulator, terminal inventory liquidation, automatic strategy deployment, a new dashboard, and claims about profitability.
