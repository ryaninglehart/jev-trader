# Fixed three-day study

Purpose: investigate whether filled orders held for 5, 15 or 60 minutes can cover execution costs without relaxing capital or loss controls. This is exploratory evidence, not authorization for live trading or a profitable-strategy claim.

## Frozen protocol

- 72 hours of consecutive finalized MON-USDC market observations, starting with the first captured block. Restart/backfill does not extend the chosen window or reset risk. Missing data never becomes an invented empty block.
- Primary portfolio: unchanged patient v2 eligibility and economic gate, $100 cash, zero starting MON, 200 MON order, 400 MON potential-position cap, $1 cumulative loss stop, 1% peak drawdown stop, no borrowing. Live execution is disabled in code.
- Six independent diagnostic portfolios: three holding periods times two execution scenarios (1x displayed queue/1x gas and 2x displayed queue/2x gas). Each has the same capital and risk limits; their balances must not be combined. Eligibility uses only trailing information and actual taker flow. These portfolios investigate pre-gate signals; the main portfolio keeps its gate. No parameter search, winner selection, or automatic promotion occurs during this study.
- One outstanding entry/position per research portfolio, at least five minutes between attempts. Same 30-block entry TTL, with delayed cancellation; no replacement churn. Holding time begins at the first partial fill. The existing signal lookbacks remain 30s and 5s.
- Orders cannot fill on decision/inclusion prints. At inclusion, displayed queue consumes opposing volume before fills; prints through the limit clear queue, with remaining fill quantity capped by that print. Cancellation races still cost gas. New/hidden liquidity, the market impact of our orders, and exact AMM queue priority are not observable; the two scenarios do not bound every possible real fill outcome.
- After the holding period, submit a simulated exit for a later block, walk its observed bid depth and charge taker fees and full exit gas. No invented liquidity. Conservatively treat quantities below the observed minimum as unresolved instead of assuming a dust liquidation succeeds.
- Diagnostic loss/drawdown checks include depth-based exit estimates and pending gas provisions, which are stricter than the main engine's mid-based checks. Stops persist across days and restarts, cancel pending exposure, and request exits. Execution delays and missing liquidity mean stops are not guaranteed hard dollar ceilings.

## Cost and fill estimates

Fee/minimum-size observations come from `getMarketParams` at the recorded block, refreshed at most every 200 blocks. Nonnegative observed maker fees raise the ledger/gate over the declared maker assumption when necessary. Observed taker fees raise the declared 5 bps exit floor; falling fees do not weaken that floor. Gas is 350,000 units times each block's base fee plus a fixed 2 gwei priority budget, with 2x stress. The gas quantity remains an assumption for the proposed order operation.

[Monad documents](https://docs.monad.xyz/developer-essentials/gas-pricing) charging gas limit rather than gas used. Do not substitute receipt `gasUsed` to reduce cost. These are simulated trades, so there are no real bot execution receipts to calibrate against. Deterministic strategies incur no actual AI calls; Jev remains disconnected.

Report any-fill rates and filled-quantity fractions over completed orders, including unfilled cancellations. Pending orders are censored. Net portfolio results include unsuccessful entry costs; completed-round-trip averages alone omit those failed attempts and must not be used as total profitability. Unresolved inventory remains visible and cannot be counted as a successful completed exit. Daily closes are cumulative marks, not independent samples. The full journal can reproduce every estimate.

## Integrity, operations and interpretation

SQLite uses full synchronous WAL commits before applying observations. An input hash chain, contiguous block/parent checks, trade IDs, and an exact configuration/source identity protect replay. Recovery streams observations and restores all portfolios together. Only a demonstrably dead local PID lock is reclaimed. Do not reset/delete a journal on an error. Acquisition retries back off and stop after 20 consecutive failures. Storage is bounded at 3 GB. The collector runs locally and needs the computer awake and connected; unavailable archive history can prevent gap recovery.

Run a bounded online check and compare its complete replay first. Then copy the committed source into a frozen runtime without `.env`, run with `--no-env-file` and `DRY_RUN=true`, and preserve the runtime for the entire window. Hourly chat follow-ups inspect health, resume the same frozen study when needed, and update the owner-private dashboard approximately every six hours and at completion. Hosted reports show their snapshot time and do not certify that the local collector remains alive.

All six hypotheses and failed attempts remain in the report. Inspect profit after all costs, loss/drawdown compliance, sample size, unresolved positions, daily consistency and the stress scenario. The existing 30-minute recording is development data. Even a positive three-day result needs a separate untouched forward evaluation; correlated samples and six trials can produce a lucky apparent winner. Do not tune against this window or reduce risk/gate buffers to manufacture trades.
