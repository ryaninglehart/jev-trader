# Patient Swing v1 — isolated offline backtest

This research engine lives in src/swing, outside both frozen cloud runtimes and
outside the Selective Entry runtime digest's src/research tree. No running branch,
original engine, protocol, data journal or existing portfolio is changed. There
is no live execution adapter, cloud workflow, wallet import or trading key.

Fixed rules: completed UTC five-minute candles; close above its 60-minute prior
close; preceding 15-minute pullback (prior candle below four candles earlier);
current close above prior close; positive signed taker flow and at least 200 MON
volume in the completed candle. A full two-hour label is required for training.
The first partial candle is discarded. No future candle informs a decision.

First 60% of the fixed recorded window is training. Matching signal samples are
at least two hours apart, and their full two-hour labels and next-block execution
observations must finish strictly before the split. No refitting in the later
40%. Require at least 20 samples. A mean-minus-two-standard-errors price-move
estimate and Wilson z=2 lower execution score are heuristics, not guaranteed
confidence coverage or independently validated probabilities. Below the evidence
threshold both credited directional edge and success score are zero. Training
labels measure midpoint changes, not strategy P&L. No threshold search is run.
Stress execution scores are separately fitted with half displayed depth.

Portfolio: $100, zero MON initially; 200 MON full-size orders; one position at a
time; 400 MON potential cap; $1 cumulative loss stop; 1% peak drawdown stop; no
leverage or reset. Additional planned per-trade loss budget $0.10 includes a 1%
price stop, fees, buffers and three full gas budgets. At most two actual entry
attempts per rolling 24 hours, including failed attempts. Cannot enter in the
final two hours of the evaluation window. Policy is fixed in swingPolicy.

The original 2–100 bps spread window is retained.

Entry gate credits only the qualified lower directional forecast and execution
score, then charges worst allowed entry/estimated exit prices, both fee floors,
three full gas transactions, 5 bps adverse selection, 2 bps uncertainty, $0.00002
inference buffer and $0.0005 minimum net edge. No inference API is called. Fees
are the greater of 5 bps per side and observed taker fees. No rebates are credited.
Balances are assumed already available for paper execution; real funding/token
approval costs and a live adapter are outside this model and must be accounted
for before any future real execution.

A submitted entry settles no earlier than the next block. Recorded ask depth must
fully cover 200 MON within the decision price limit (+10 bps); otherwise the
attempt fails and pays full gas. No partial entry or queue fill is invented.
This simulates bounded fill-or-kill semantics and does not assert actual exchange
execution. Exit triggers: 1% trade stop, trend reversal, two-hour holding limit or
portfolio halt. Initial exit is delayed by one block. Failed exits retry at most
once per completed candle. Safety/time/reversal exits consume available recorded
bid depth without a price floor; missing depth or a changed minimum size remains
unresolved. Stops cannot guarantee exact loss ceilings during delay or illiquidity.

All money uses Decimal. The shared Ledger, fee/gas helpers, input validation and
forward-only FillQualityTracker are reused; the distinct FOK engine is used for
all offline swing replays. Risk uses executable exit value net of fees/gas and
pending gas liabilities. Reports distinguish marked value, net after estimated
exit, actual settled fees/gas, pending instructions and unresolved exposure.

Reproduce with Bun and no environment-file loading:

```sh
bun --no-env-file scripts/backtest-swing.ts \
  --state data/cloud-migration/verification-selective-20261016-2142.sqlite \
  --out ../../outputs/edgefoundry-patient-swing-v1-backtest.json
```

Only a read-only verified input copy is opened. Hash/parent/block continuity,
unique trade IDs and input validation are checked. Source and input digests,
chronological boundaries, policy, training examples, cost assumptions and both
scenarios are reported. Previously viewed data remains retrospective even when
the chronological split is clean. Synthetic tests verify execution but are never
published as historical returns. No automatic promotion or forward activation.
