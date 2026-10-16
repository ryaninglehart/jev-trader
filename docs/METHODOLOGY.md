# Accounting, execution and evaluation

## Observation format

A JSONL dataset begins with a `kind: "dataset", version: 1` header. It names the data provenance, market, chain, block duration, tick size and cost assumptions. Each following frame contains consecutive block numbers, strictly increasing observation timestamps, sorted bid/ask depth, unique transaction-hash/log-index trade IDs, and optional per-block gas pricing. Recorded frames also require block and parent hashes.

All monetary and quantity inputs are ordinary decimal strings. Scientific notation, nonfinite values, crossed books and off-tick book prices are rejected. The upstream book reader and log decoder convert chain values to JavaScript numbers before the collector serializes them; precision lost in that upstream conversion cannot be recovered. The ledger itself uses 40-digit decimal arithmetic.

`trades.side` is the taker side. A taker sell may fill our bid; a taker buy may fill our ask. Logs are in canonical chain/log order. The recorder pins the book and base fee to a finalized block and fetches all logs through that block, then discards earlier warmup prints from the frame. Block hashes and parent continuity are checked across recovery.

The recorder uses the upstream book reader's top levels, including vault liquidity. It does not fabricate missing blocks or infer a book from OHLC candles. Finalized snapshots are slower than a trading feed, and endpoint correctness is trusted. Historical backfill is research replay, not contemporaneous trading.

## Block event order

For block N:

1. Validate the complete frame before journal mutation.
2. Let the previously resting order consume N's taker prints.
3. Settle any transaction submitted sufficiently many blocks earlier; charge its gas at N's mid. Reject a crossing post-only quote, changed funds/cap, or a cancel whose target already fully filled. Atomic reverts retain the old order if it still exists.
4. Observe the end-of-block book and prints, charge the recorded model decision, update equity/risk, then consider a new intent.
5. Hold, low confidence, deadline misses, out-of-range spread, TTL expiry or risk halt requests cancellation of an existing quote. Cancellation has the same configurable delay and gas charge as other transactions.

A quote submitted after block N with `latencyBlocks: 1` settles after block N+1's prints and can first fill on block N+2. This intentionally conservative ordering is shared by paper and replay. Intra-block matching is not reconstructed.

A quote at an existing level waits behind that level's displayed depth multiplied by `queueFactor`. Exact-price prints consume queue first. A print strictly through our quote removes queue ahead and fills at our resting limit price, capped by the print size and our remaining quantity. One print's volume cannot be reused for another fill. New liquidity appearing ahead, hidden orders, cancellations improving queue, AMM changes within a block and the bot's own effect on future market state are not simulated. This model can still misestimate fills; sensitivity tests are not a substitute for exchange validation.

At most one replacement transaction is pending. Pre-submit checks reserve inventory/cash for a possible old-order fill before its replacement, and for gas. Unchanged safe quotes stay on the book without cancellation or reposting. The state machine models spot holdings, not margin borrowing.

## Costs and funded equity

- Maker fee = fill quantity × resting price × configured basis points / 10,000. Fees settle in USD/USDC by assumption. Rebates are negative fees. Actual Kuru settlement must be verified before a live adapter uses this model.
- Gas MON = configured gas limit × inclusion gas price / 10^18. The fixed limit is a research assumption; rejected transactions also pay. Cancellation uses the same limit, intentionally simple. MON gas is purchased at the inclusion mid and deducted from simulated USD cash.
- The finalized collector records block base fee plus configured priority; imported datasets can supply their own per-block effective-price estimate. The dataset header is used when a frame omits pricing. Max-fee inclusion competition and dropped live transactions are not simulated.
- AI cost is charged on every `recorded` decision, even if held, late, low confidence, risk-blocked or another transaction is pending. `decision.costUsd` overrides the header assumption. Built-in deterministic strategies incur no AI bill.
- Historical gas USD is accumulated at each event's mid. It is never repriced from total MON at the newest mid.
- Gross P&L includes realized trading gains and remaining holdings marked to mid relative to funded initial equity. Net P&L subtracts fees, gas and AI. Cash and spot inventory reconcile independently.
- An unresolved pending transaction is provisioned one inclusion gas charge. A quote that remains or may be placed is provisioned one terminal cancellation. `costs.gasReserveUsd` is an estimate, not a settled expense. It is included in `costs.totalUsd` and `netPnlUsd`; `settledNetPnlUsd` excludes it. Unknown future gas spikes can exceed the reserve.
- Open holdings are not liquidated at the end. No terminal liquidation fee, market impact or executable exit price is claimed. USD is treated as USDC at par; depeg, funding, RPC infrastructure and tax costs are outside this ledger.

## Evaluation

The first 70% of observations (configurable from 50% to 90%) is the development segment. For momentum, confidence thresholds 0.55/0.60/0.65/0.70 are ranked by development net P&L after terminal gas provisions. No other parameter is optimized. The winner is evaluated once on the later test segment.

Test portfolio capital is reset at the boundary. Earlier prices warm up indicators; no development orders or positions carry into the test segment. Hold and inventory-directed maker baselines use the same capital, observation window and cost rules. Gas, latency and queue are each doubled independently as sensitivity scenarios. These are diagnostics, not confidence intervals.

This is a single chronological holdout, not a full rolling walk-forward optimizer. There is no randomized split, claimed Sharpe ratio from 300 ms samples, confidence interval or cross-market generalization. Repeated tuning against the same test segment invalidates its holdout interpretation. Synthetic output verifies software behavior only.

## Persistence and operational limits

Paper inputs are fsynced before their effects are applied. A restart replays the complete journal to restore positions, costs, pending state and sticky risk halts. Journals record the execution-engine version; changing semantics requires a version bump and a separate session, rather than restating earlier accounting silently. It is not a live transaction outbox and does not reconcile a real wallet or existing exchange orders. File locking prevents two local writers; a crash leaves a stale lock that requires verification and manual removal. A truncated write fails closed. Journals and reports may grow with the configured run size; long-running archival/compaction is not implemented.

The loss/drawdown stop prevents new quote intents, then requests cancellation. Already pending transactions cannot be undone and may settle after a stop. The collector stops on incomplete/stalled data. Paper execution has no real orders to cancel during an outage. A live system needs an independent cancellation/monitoring path and startup reconciliation before funded operation.

## Validation

Run `bun run typecheck`, `bun test tests` and the README's offline commands. The suite exercises exact accounting identities, partial fills and queue depletion, no same-observation fills, charged reverts, cancellation races, stale decisions, caps, loss halts, canonical continuity, restart equivalence, corrupted journals and held-out parameter selection.

A short read-only smoke run also verified that the configured public Monad endpoint served finalized block-pinned books, base fees and trade logs at development time. That is an integration check, not a historical performance study or a guarantee of endpoint availability.


## Online Jev availability and billing

`research.jev.example.json` enables the real TypeSafe evaluation transport with buy/sell/hold criteria. No key produces an error, not a mock. Offline tests inject only the transport response while exercising the actual installed SDK request and response schema; they are not calls to Jev's service.

The collector launches a request after journaling source frame N and keeps recording while the request is in flight. A reply becomes a decision on a later frame M, and its quote uses M's current book. `sourceBlock` is strictly earlier than `availableBlock`, which must equal the recording frame. Inference delay has already elapsed when the reply is available; only transaction latency is added afterward. Old or over-deadline responses cannot place a quote. Pending inference does not repeatedly cancel a still-valid quote, but TTL/risk/spread checks remain active. Catch-up frames do not initiate new inference calls.

Each request has a durable start record with state hash, model/prompt/settings identity and source block. Completion records capture action, probabilities' selected confidence, latency, returned model ID and token usage. API keys, authorization headers, raw provider errors and raw prompts/state are not stored in this ledger. There are no request retries. Authentication failure stops subsequent calls; three failures also stop further calls. Estimated spending and request count survive restarts.

Token-count times configured input/output rates is labeled `token_estimate`. It is not invoice reconciliation. Missing usage and failures use an explicit `unknown_reserve`; a timeout may still have been billed remotely. The rate assumptions and request reserve can underestimate a provider invoice. A local estimate limit cannot enforce the provider's billing cap. Requested and returned model IDs are recorded, but an opaque moving alias does not prove an immutable backend model revision.

On restart, an unfinished request becomes a conservative recovered hold with its reserved cost and is not resent. A frame may apply each request ID only once. Both the paper and inference ledgers are required for recovery. Locks must not be removed until their writers are verified stopped.

On shutdown, the inference runner is aborted and drained within the hard timeout. Any cost not applied to a market frame is included in the final report, including drawdown and the equity/net-cost identity. Export locks both ledgers and carries these remaining costs into `terminalInferenceLiability` on the dataset's last block. Replay charges that liability only for the recorded-model strategy and only for a window ending at that block. A development prefix therefore does not receive a future terminal charge; deterministic baselines do not pay for model calls. Unknown-cost provisions remain visibly identified in the original request ledger.

`research-v2` changes asynchronous decision and accounting semantics. Older v1 journals are not resumed under v2. Export them using their original version and use the validated dataset for a new replay. Paper results remain assumptions about execution; no live wallet is reconciled or funded by this adapter.


## EdgeFoundry v3 economic filter and quote policy

For candidate size Q, assumed filled fraction f, limit P and current midpoint M, expected spread capture is `f × Q × (M−P)` for a bid and `f × Q × (P−M)` for an ask. It is not predicted directional alpha. Subtract assumed entry and exit fees on expected notional, adverse-selection and uncertainty buffers on expected midpoint notional, three full gas transactions (placement, possible cancellation, future exit), and the greater of configured inference allocation and supplied current decision/header AI cost. No maker rebate is credited by the gate. These estimates do not alter actual accounting.

Retaining a quote excludes sunk placement/inference costs but keeps a full future-exit gas budget and prospective fee/price buffers. Same-side replacement must clear both the absolute entry hurdle and configured incremental improvement over this retention estimate. A resting partial order uses its remaining size. Minimum resting time and price-change thresholds cannot protect a crossing/adverse price or override hard cancellation conditions. A candidate may clear the economic gate and still fail cash/inventory checks.

Fixed profile values are not calibrated from observed profitability. The profile's 10% expected quantity fraction is explicitly an assumption, not a model probability. No exit is actually executed by this filter; ledger equity remains marked to mid. The fee, exit-gas, adverse-selection and uncertainty allowances can still be inadequate in real markets.

Fill markouts run as a separate forward-only diagnostic observer. The first later snapshot at/after each target resolves the horizon; observations over 1,000 ms late are labeled late and excluded, while unresolved horizons remain censored. Each event records side, quantity, fill midpoint, actual horizon delay and maker fee. Signed fill-to-future-mid returns include spread capture; signed midpoint-to-future-mid changes isolate subsequent price movement. The after-maker-fee USD metric excludes gas, AI, unwind fees and impact. Partial fills are separate events and are weighted by notional in the bps summary. Diagnostic state is rebuilt deterministically from the input journal.

New frames may include `marketTs`, a canonical block timestamp in milliseconds. It must remain present throughout a dataset and never decrease; multiple blocks can share one second. `ts` remains the strictly increasing collector-observation timestamp for compatibility and provenance. Legacy data without `marketTs` retains observation-time diagnostics, explicitly labeled, which may be distorted by backfill speed.

The dashboard accepts only EdgeFoundry comparison reports, escapes imported text, has no signing or order routes, and binds its local server to loopback. Hosted publication contains static assets and explicitly selected simulated reports only. It has no credentials, wallet, collector, or execution process. Reports are snapshots; import a new report to update the view. Source is in `dashboard/`; the original `web/` demo remains separate.


## EdgeFoundry v4

V4 adds patient eligibility, independent signal-outcome diagnostics, touch-cost feasibility and depth-based exit estimates. It does not relax the gate or risk settings. Older journals remain tied to their original engine version; export observations and start a new v4 session. See [the strategy protocol](STRATEGY_RESEARCH.md) for the fixed hypotheses and evaluation roles.


## EdgeFoundry v5

V5 adds block-pinned public fee observations: positive maker/taker fees can raise cost accounting and gate reserves above declared floors. Missing observations in older datasets retain explicit assumptions. New observations must be no older than 200 blocks and cannot be from the future. The multi-day collector refuses changed tick/size precision or an order minimum above its fixed size. The journal engine version changes; v4 journals require their original engine, or export their observations for a new session.

The long-holding research uses a separate, explicitly diagnostic portfolio model. It pays failed-entry and cancellation costs, models partial fills and delayed depth-based exits, and retains unresolved below-minimum inventory. Primary portfolio behavior is still governed by its economic gate. See MULTIDAY_STUDY.md for the experiment protocol.
