# Composition and operational lifecycle modules

This source stage adds a normalized composition representation and a tested
operational consumer of the real four-role Strategy / recursive Template
grammar. Its fixtures are synthetic draft contracts. They are not Joshua's
atom/operator/runtime approvals or a counted study.

## One composition, independent consumers

`compilePrompt` lowers the typed catalog/AST into `compiled.composition`.
Declared port order is separate from prose occurrence order. Local semantic
rules cannot overwrite paths, children or namespaces. Parameters become
literal fragments: text resembling a slot cannot introduce another child.
Withheld atom text retains its private semantic requirement.

`composition.mjs` independently renders the complete prompt, including the
execution/response appendices, and produces semantic trees, checklists and
UTF-16 source ranges. Browser ZIPs include `composition/`, `prompts/`,
`checklists/` and `source-maps/` for every task and admissible reading.
Standalone verification regenerates these artifacts from the frozen project,
so rewriting a derived file and its manifest hash cannot silently change it.

## Operational contract

`lowerTradingIR(composition, config)` accepts four-role Strategies and
ALL/RACE/SEQUENCE Templates with two through four ordered Node slots. A slot
can contain either kind recursively. State/event gates and reset predicates
belong to their template scope. The typed representation freezes private
namespaces, contiguous descendant scopes, history dependencies, initial state,
requirement links and the explicit execution policy.

`createTradingRuntime(ir, {dispatch, cancel})` consumes completed bars and
broker receipts. Its uniform node status reports entry/exit readiness, ability
to initiate, active and pending descendants, round-trip completion and reset
phase. `requestReset(path, time)` addresses a subtree. The Python
`TradingRuntime` is a separate implementation using a tree and its independent
Python order book. It does not execute the JavaScript interpreter.

All money is integer cents. Assets declare cash multipliers and quantity
steps. Fixed-quantity buys declare a complete cash cap; budgeted buys declare
their allocation and fee allowance. Admission reserves resources. Actual
fills alone change cash and private inventory. Cancel requests preserve
reservations until terminal receipts. Exit orders address only a private lot.

The current draft choices are explicit:

| Boundary | Contract |
| --- | --- |
| RACE acquisition | Either `broker-accepted` or `first-fill`, declared per template. Internal admission is neither event. A late acceptance of a terminal ticket cannot acquire ownership. |
| Losing RACE inventory | Cancel open orders, await their terminal receipts, then liquidate owned inventory. Release waits for the entire scope to become flat and terminal. |
| Empty RACE entry | Release without claiming a completed round trip; retry only after that timestamp. |
| SEQUENCE | Advance after an actual flat, terminal round trip; dispatch the next child on a later bar. |
| Entry/exit overlap | Explicit `wait-terminal` or `owned-quantity`. Neither can complete while its entry ticket remains pending. |
| Same bar | At most one proposed action per strategy. Broker callbacks reconcile state; they do not recursively dispatch orders. |
| Gate closure | Explicit `block-entries` or `drain-and-reset`. Existing exits continue under an entry-only block. |
| Missing gate observation | Block entries without manufacturing a false predicate transition. A declared event-gate lifetime can still expire. |
| Event gate | Explicit level/rising trigger, lifetime, and rearming after false while closed or only after reset. |
| Subtree reset | Cancel, wait, liquidate, wait, then clear. Reactivation occurs after the clearing timestamp. Preserve the requesting reset-edge latch. |
| Reset history | Explicit `retain-observations` or `restart-subtree`. |
| Ancestors of a reset child | Invalidate completion; rewind an affected sequence branch. Preserve other children's states. Clearing the entire winning child releases RACE ownership. |

Node, path, prose, occurrence, bar, intent and event budgets are bounded.
Budget/contract errors refuse execution; callers must retain the failure and
broker evidence rather than retrying a failed controller as a new episode.
The current API is an in-memory evaluator; a durable controller checkpoint and
resume protocol is not supplied by this stage.

## Native qualification

`trading-lean.mjs` generates modular or self-contained Python source.
`trading_lean.py` checks actual UTC completed bars and passes real OrderEvents
through the execution bridge. Its present native adapter supports declared
USD equities with unit multipliers/steps. Generic ledger multipliers are not
an implementation of options selection, assignment, exercise or expiry.

`verifyNativeTradingReference` first verifies the complete private book
against retained LEAN orders/events, then replays the trusted reference's
callback chronology in the independent JavaScript controller. This is
reference qualification. A candidate's printed/controller snapshot is not a
native grading oracle.

Qualification tools use a pinned local image, synthetic minute data, no
network, owned disposable containers and no provider calls. The fill table
is authored independently of controller output. Each successful campaign
requires three nonempty identical fresh runs and records source, data,
native artifact and image hashes.

## Integration boundary and remaining work

The Research builder now exposes an explicit `operational-v1` draft profile
through authoring, task compilation, personal review gates, freezing, native
candidate grading, independent qualification and portable reports. The
original synchronous constitution remains a separate profile; an old frozen
study is not silently reinterpreted. See
[the operational study integration](research-benchmark-operational-study.md)
for the exact public broker fixture and native observation boundary.

The [requirement registry](research-benchmark-requirements.md) now provides
bound activation and wrong-reading checks with diagnostic sequence shrinking.
Remaining work includes the personally reviewed constitution and atom/operator
catalog, complete requirement and wrong-reading coverage beyond the five
synthetic controls, options semantics, complete T1–T4 qualification and actual
owner-approved collection. The synthetic starter and qualification controls
do not discharge those study gates.
LIVE/next-start activation belongs to the existing promotion owner.

Run-service capacity is now 64 source/input pins because the portable runtime
has 40 files before its project, manifest and attached modules are included.
Every file remains pinned and checked at both process boundaries. The
256 MiB total verification limit, literal path checks, account boundary,
no-link checks, content hashes and receipt verification remain enforced.
This app change must be integrated with the matching engine capacity change.
