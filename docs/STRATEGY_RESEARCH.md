# EdgeFoundry patient strategy protocol

The objective is profitability after costs within the existing spot, position, loss and drawdown controls. A strategy that holds cash has not demonstrated a profitable edge. New strategy logic cannot disable the economic gate, and the comparison rejects a candidate that changes the shared risk, size, timing, quote-policy or cost controls.

## Current hypotheses

Patient v1 requires agreement among 30-second trend, 5-second trend, signed taker flow and positive top-three-level depth imbalance. Patient v2 requires the same price/flow alignment and vetoes materially opposing depth, while allowing neutral depth. Both require at least 200 MON of actual trailing 30-second traded volume, cap long/short moves at 50/20 bps respectively, and join the best price. A bearish signal requires funded inventory sufficient for the order; bullish intent remains subject to the position cap. The confidence value 1 denotes rule eligibility, not a calibrated success probability.

The short window must be shorter than the long window. Reference snapshots come from at or before each horizon; time is canonical block time when supplied, otherwise collector time. Earlier blocks sharing one second still contribute flow. Current and earlier observations are the only strategy inputs. Thirty seconds of valid history is required after a reset; a midpoint-only warmup does not fabricate trade or depth history.

V1 was recorded before the fresh acquisition began. V2's neutral-depth revision used the earlier 3,000-block development recording, which showed top-level summed depth frequently balanced and blocked every v1 signal. V1 is archived, not erased. V2 was frozen before fresh recording outcomes were evaluated. Some fresh observations were collected while implementation/development work was in progress, so the experiment is a held-out causal replay, not a claim that v2 traded contemporaneously for the entire acquisition period.

These rules are uncalibrated hypotheses, not learned profitability estimates. Equity-market research motivates investigating depth imbalance but cannot establish a profitable MON-USDC strategy: [Gould and Bonart](https://arxiv.org/abs/1512.03492). Full order-flow imbalance includes limit-order and cancellation events; our signed taker-volume feature is narrower and must not be equated with that measure: [Cont, Kukanov and Stoikov](https://arxiv.org/abs/1011.6402).

## Longer study

Collect 6,000 consecutive finalized public market blocks, approximately 30 minutes. Record once in cash-hold mode and causally replay identical inputs through original momentum/maker cadence, reduced replacement, prior gate, patient v1/v2 and cash-hold variants. No outcome-based parameter search or winner selection is performed. Retain both patient variants, all configuration values, dataset hash and capture/recovery metadata. Earlier recordings are explicitly development/reference data.

A transient log failure gets at most three bounded read attempts. If still incomplete, stop without draining or appending an incomplete frame. Recovery preserves the journal, replays the same prefix and backfills every block. Never substitute missing logs with an empty trade list or skip to the current head. The isolated v3 cash recorder preserves compatibility with the journal begun before the v4 strategy was implemented; v4 evaluates the exported observations in new sessions.

This is a software/economic-feasibility study with a small sample, not a sufficient profitability validation. Independent later windows across multiple days and market conditions, with enough actual simulated fills, remain necessary. Repeatedly changing rules against the same test outcomes makes that data development data: [Bailey et al. on backtest overfitting](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2308659).

## Outcome diagnostics

Every frame's best bid and ask are checked against the unchanged gate before signal/balance filters. Reports show the maximum estimated net edge and average required one-sided quote-to-mid capture. This is not a full-spread threshold or a recommended risk increase. It exposes markets/configurations where no plausible touch quote covers the modeled costs, even with a favorable eligibility signal.

Eligible patient signals are sampled at least 30 seconds apart and their signed midpoint moves measured after 5 and 30 seconds. Samples remain correlated observations, not independent trades. Late observations are excluded and missing horizons censored. Signal outcome diagnostics do not feed model selection, live decisions or gate estimates. Fill-conditioned adverse selection must be assessed separately with actual simulated fills; prediction accuracy alone cannot establish an executable edge.

A separate snapshot exit estimate walks recorded bid depth for the entire held inventory, reserves the greater of the declared exit fee and nonnegative maker fee, one full exit transaction and existing pending/cancellation/AI provisions. Incomplete depth produces null equity rather than inventing liquidity. Future liquidity, real order races and impact beyond recorded depth remain unknown. The ledger and risk stops still use marked-to-mid equity; this estimate is an additional reporting lens, not an executed liquidation or a guaranteed stop price.

## Risk boundary

The recommended profiles retain $100 simulated starting cash, 200 MON order size, 400 MON potential position cap, $1 session-loss stop and 1% drawdown stop, with no borrowing. Stops request delayed cancellation and cannot guarantee an exact loss ceiling. Live order submission remains disabled. Jev is still optional and has not been called without a TypeSafe key. No external bill, wallet transaction or funded trade is part of this study.
