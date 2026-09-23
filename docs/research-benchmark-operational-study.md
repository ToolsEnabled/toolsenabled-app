# Operational Research study profile

Research offers **Lean Bench: operational draft** alongside the original
synchronous v1 starter. The new profile sets `domain: "lean-bench"` and
`leanProfile: "operational-v1"`. It uses the same task compiler, review
records, corpus generator, information packets, runner, attempt journal,
audit machinery and report generator as other Research benchmarks.

The starter contains synthetic examples, not personally approved study
atoms. Its recorded observation qualifies local apparatus; it is not model
collection or native execution. The required review gate stays enabled.
Both RACE acquisition policies are explicitly named draft choices.

## Authoring and freezing

Strategies have four typed atomic roles. ALL, SEQUENCE and both RACE drafts
have two-, three- and four-child template bundles. State gates, event gates
and resets are template properties. Each Node port can hold a Strategy or
another Template. The tree editor chooses new strategies by their typed
roles, independently of their bundle identifier.

Apply input edits, then choose **Derive draft expected observation**. Review
the observation against independent truth before freezing. Changing input or
composition never silently replaces a stored expected result: freeze refuses
disagreement. The four-role combination tool and corpus recipes derive their
observations through the same compiler.

The `operational-contract-v1` dependency contains the literal lifecycle
contract. Its review binds all 40 portable source files. Every used bundle
and dependency needs its own current review. Changing bound source, wording
or semantics invalidates transitive reviews. Information treatments also need
review of the exact visible prompt and complete admissible-reading packet.
The compiler lowers the final composition, including its prompt appendices,
to `compiled.operational`; its `compositionSha256` binds that exact IR input.

The input declares:

```json
{
  "execution": {
    "version": 1,
    "cashCents": 150000,
    "currency": "USD",
    "assets": [{"id": "SPY", "multiplier": 1, "quantityStep": 1}],
    "limits": {"intents": 10000, "events": 100000, "bars": 100000},
    "exitWhileEntryPending": "wait-terminal",
    "resetHistory": "retain-observations"
  },
  "market": {
    "version": 1,
    "kind": "delayed-capped-equity",
    "delayBars": 1,
    "maxFillQuantity": 2
  },
  "bars": [{"time": 1704205860, "prices": {"SPY": 10000}}]
}
```

Bars are strictly increasing minute-aligned UTC seconds, with positive
integer-cent prices or explicit missing observations. The market fixture
supports whole-share USD equities with zero fees and slippage. For each
order, delay is measured in completed input bars, including bars where that
asset is absent. Once eligible, an order fills at most `maxFillQuantity`
shares per timestamp at its asset's observed close. Missing prices defer its
fill. Existing fills arrive before `on_data`. Cancellation-pending notices
occur when requested inside the callback. A later market-order submission
processes queued cancellation acknowledgments before its own Submitted event;
otherwise terminal cancellation acknowledgments follow the callback. Orders
cannot fill on their submission bar. Actual
native runs must qualify these assumptions for the pinned image.

## Candidate execution and observations

For `lean-python` grading, return a full `FrozenBenchmark(QCAlgorithm)`
program. The prompt specifies dates, subscriptions, UTC, cash, asynchronous
market orders, labels and the declared market fixture. The owned container
mount contains only submitted `candidate.py`, the public wrapper `main.py`,
the public `trading_broker.py`, data and result/config mounts. It does not
contain the private task IR, expected observation, admissible readings or
trusted reference program. These private files remain in the review/export
project outside the candidate mount.

Use an order tag containing this JSON array:

```json
["LB-OP-1", "root/child1", "private-lot-label", "entry", "unique-order-label"]
```

Each buy opens a new lot label for that strategy. Exits use the same label;
their reason is `exit`, `reset`, `gate-close` or `race-release`. Order labels
are unique across the candidate. Lot and order labels are opaque strings;
their spelling and numeric native IDs do not determine correctness. The
grader normalizes them by actual native order creation order and per-owner
entry ordinal. An independently handwritten candidate exercises this rule.

`trading-observations.mjs` reads every retained native order and event,
including unfilled entries and cancellation transitions. It verifies equity
asset/type/currency, timestamps, identity uniqueness, side, quantity, fees,
partial/full statuses and final order status. A private exit cannot sell
quantity not previously filled into that owner's lot. It derives cash,
positions and lots from actual fills, and checks native starting/ending
equity against that reconstruction. The result contains orders, receipt
chronology, private lots, cash from fills, positions from fills, total fees
and equity. Raw artifacts remain available for regrading and audit.

Internal cash reservations, controller generation/completion flags and other
unobservable private state are not accepted from candidate claims. Their
semantics are tested through observable native behavior such as cash
contention, entry suppression, reset liquidation and handoff timing. Printed
traces and reference/controller snapshots cannot establish a candidate grade.

A no-fill model scan preserves LEAN's current order status. Returning
`OrderStatus.NONE` would overwrite a pending order's status without a
retained lifecycle receipt in the qualified image. The grader continues to
require final order status and receipt history to agree; it does not excuse
that mismatch. See LEAN's
[backtesting brokerage status handling](https://github.com/QuantConnect/Lean/blob/master/Brokerages/Backtesting/BacktestingBrokerage.cs)
and [custom fill model interface](https://www.quantconnect.com/docs/v2/writing-algorithms/reality-modeling/trade-fills/key-concepts).
The [backtesting transaction handler](https://github.com/QuantConnect/Lean/blob/master/Engine/TransactionHandlers/BacktestingTransactionHandler.cs)
also processes pending requests while submitting a new order; qualification
includes cancellation interleaved with a later submission in the same bar.
The pinned native campaign, rather than the current upstream source, is the
evidence for this image's behavior.

## Independent and native qualification

`trading-market.mjs` simulates the explicit broker fixture around the
JavaScript controller. `trading_market.py` independently schedules fills and
constructs its own observable order/lot book around the Python controller.
`node cli.mjs qualify` compares both complete interpretations for every
frozen task and reading. It does not execute LEAN or count model responses.

An export contains `lean/<task>/operational-ir.json`,
`expected-observation.json`, `reference-interpretation.json`, bars, a public
candidate environment and a separately generated trusted reference. The
standalone verifier regenerates these files; changing a derived artifact
and its manifest hash cannot bypass verification. Hidden atom readings get
their own private IR/reference/expectation but identical public candidate
environments when their visible contracts agree.

The native fixture driver is
`tools/test/fixtures/qualify-research-benchmark-operational-study.mjs`. It
runs three fresh references per declared control, including nested
composition, independently handwritten labels, both RACE policies, cancellation
interleaved with a new submission, pending
end-of-data tickets, shared cash, gate/reset drains, missing prices and depth
eight. It also rejects an actual wrong-policy candidate and exercises native
grading through the exported CLI, durable journal, resume and reports. The
driver retains source, project, native artifacts and hashes. Test review
records explicitly identify synthetic apparatus fixtures.

The optional [requirement registry](research-benchmark-requirements.md)
binds registered wrong readings, hand-checked probes, independent activation
checks and bounded diagnostic shrinking to this same frozen project.
This integration does not complete the study's full atom catalog, coverage
of all requirements and wrong readings, options lifecycle, T1–T4 qualification,
personal approvals or counted collection.
It also does not provide a durable operational-controller checkpoint or
live-brokerage adapter. Final app/engine integration and LIVE/next-start
promotion remain with the existing promoter. The matching engine must
support the existing 64-pin Research verification contract; pins are not
trimmed to fit an older 32-file implementation.
