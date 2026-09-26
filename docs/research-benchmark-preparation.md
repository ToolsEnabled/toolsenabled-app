# Selected-input preparation and cumulative budgets

For a frozen `require-registered` or `require-composition` selected-input policy,
the Research runtime qualifies the exact selected inputs before collecting new
candidate responses. Separate probes, independent interpreter agreement,
activation and wrong-reading discrimination remain scientific requirements.
Preparation accounting records the work needed to establish that proof; it
does not replace any of those checks.

The same lifecycle applies to the portable runner, standalone CLI and retained
journal/report validation. A resumed invocation must obtain a fresh valid proof
before new collection. A completed study performs no additional preparation or
candidate collection.

## Durable intent and paired completion

Before calling the qualifier, `attempts.jsonl` records `qualification-started`.
It binds the frozen project and journal sequence and includes:

- `timeoutMs`: the smaller of the frozen selected-input timeout and the remaining
  active study budget at preparation start.
- `settlementMs: 5000`: the bounded cleanup allowance after cancellation or
  timeout while the host joins the actual qualification promise.
- `reservedMs`: `timeoutMs + settlementMs`, retained for conservative recovery
  accounting when measured duration is unavailable.

The qualifier receives `{ signal, preparationSeq }`. A successful `qualification`
or `qualification-failed` terminal must name that start through `preparationSeq`.
Only a paired, independently verified success can admit a later trial. A failed
intent write starts no qualifier. If terminal persistence fails, the intent and
lock remain available for inspection.

For settled work, `elapsedMs` measures preparation through qualifier settlement
and `budgetChargeMs` equals that measurement. This includes the qualifier's
execution, verification and completion of its evidence writes. Terminal journal
writing, later report generation and offline gaps are outside this measurement.
The report does not present it as total study wall-clock time.

Successful, failed, cancelled and timed-out preparation charges accumulate with
retained attempt charges across invocations. A valid proof may consume all the
remaining budget: the proof stays retained, but no candidate starts. Journal
validation rejects a later preparation or trial that contradicts exhausted
retained charges. Wall-clock changes do not reset the monotonic preparation
measurement.

## Raw CLI evidence and cancellation

The CLI records each invocation's preflight evidence under
`results/preflight/<preparationSeq>-<id>/`. `started.json` binds the preparation
sequence, project, requirement registry, runtime sources and policy.
`qualification.json` remains the complete raw proof, including interpreter
requests and process receipts. `failure.json` binds its preparation sequence and
retains available partial qualification and process diagnostics. The directory
identity links a raw proof to the durable preparation start without modifying
the scientific proof object.

Cancellation asks the independent qualifier to stop and joins its actual
promise. The CLI keeps its lock until that work settles. If the promise remains
unresolved after the five-second cleanup allowance, the runner returns an
unresolved-work error and preserves the open intent and lock. The CLI does not
turn this bounded failure into an indefinite second wait. Late diagnostic files
may still arrive under the original preflight directory; they do not add a
successful journal result or authorize collection.

`node cli.mjs run --recover` can close an orphan intent for accounting with
`status: "interrupted"`, `elapsedMs: null`, and the complete `reservedMs` charge.
This is a reservation, not a reconstructed measurement. Interpreter termination
remains unconfirmed, so the journal permanently refuses further collection and
the run lock stays retained. The original owner process disappearing does not
prove detached interpreter children stopped. Inspect and stop owned work before
repairing the apparatus; creating a new project identity is not termination
evidence.

## Evidence and preparation limits

The current source-pinned runtime enforces the following limits for modern
selected-input preparation journals:

| Bound | Scope |
| --- | --- |
| `maxTotalAttempts + 1` | Preparation starts across all resumed invocations, including starts that never collect a candidate |
| 4 MiB | One canonical full successful qualification event, in UTF-8 bytes |
| 16 MiB | Cumulative canonical modern journal bytes |
| 32 MiB | Serialized event rows, including their formatting allowance |

The limits describe those representations. They are not a guarantee about total
output-directory size, separately retained raw preflight files, report artifacts
or the complete `evidence.json` with its summary. Research separately rejects an
imported evidence file larger than 32 MiB. Pretty serialization can be much larger
than canonical JSON; a count bound alone is not an evidence-size bound.

When a valid full proof cannot fit the admitted event/journal budget, the runner
retains a bounded failed-preparation diagnostic with the rejected event's byte
count and SHA-256. The raw CLI preflight proof remains available, and no candidate
is dispatched. Failure to retain even the terminal diagnostic leaves the intent
open and preserves the lock.

Fresh interpreter receipts are retained in full within these limits. Valid
interpreters can vary logs or serialization while agreeing on deterministic
observations; the runtime does not replace a new raw execution receipt with a
reference to an older proof.

## Legacy evidence and explicit diagnostics

Older successful qualification records lack a paired preparation start and time
charge. Their independently checkable proofs and historical outcomes remain
available for read-only analysis. Reports show missing preparation duration and
charge as unavailable, with known subtotals when only some values are present.
Missing time is never assigned zero.

A completed legacy study can be inspected or resumed without doing new work.
An unfinished legacy journal cannot begin fresh preparation when its cumulative
budget is unknown. Do not add guessed timing to an old proof to bypass that gate.

`node cli.mjs qualify` remains a separate, explicitly requested diagnostic
apparatus check. It writes `results/qualification.json` and qualification reports
and retains available failure diagnostics. It does not enter the `run`
preparation ledger, reset that ledger's budget, or supply a substitute for the
fresh paired qualification required by `run`.

These records establish reproducible source and evidence consistency. They do
not authenticate an external execution, clear native validation or release
gates, approve private or personal investigator decisions, or authorize counted
study collection. Generic interpreter modules retain their declared local
execution permissions; this accounting contract does not add a sandbox.

See [the runner lifecycle](../src/benchmark/runner.mjs),
[preparation ledger and proof checks](../src/benchmark/requirements.mjs),
[CLI persistence](../src/benchmark/cli.mjs), and
[standalone regressions](../tools/test/research-benchmark-preparation-portable.test.mjs).
