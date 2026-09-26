# Primary populations and verified custom outcomes

Research's **Analysis & report** fields select the primary task population before
collection: all frozen tasks, held-out tasks, development tasks, or explicit task
IDs. Enter an explicit set with commas or newlines. The applied preview lists
every included and excluded task and its reason. Invalid text remains editable
and survives draft save/remount; unapplied changes prevent freezing.

The fields generate these portable declarations:

```json
"primaryPopulation": { "kind": "split", "split": "held-out" }
```

```json
"primaryPopulation": { "kind": "task-set", "taskIds": ["case-a", "case-c"] }
```

`"all"` selects the complete frozen task roster. Older ordinary plans that omit
the field retain their all-task meaning. Explicit null, unknown selector kinds,
unsupported fields, duplicate/unknown IDs and an empty selected task population
refuse freezing. Judge audits retain the supported `"reference-eligible"`
population: unresolved reference cases stay in the complete disposition ledger
and remain outside the reference-eligible primary rate. Split/task-set selectors
are currently ordinary-study capabilities; they do not silently change audit
reference eligibility.

The selector resolves in frozen task order, independently of responses, grades
or collection status. New split/set projects include the resolved
`project.primaryPopulation` and `analysis/population.json`. Export and standalone
verification require the exact generated artifact and manifest membership. A
rewritten file hash cannot turn a false roster into a valid population artifact.

## One population for every primary computation

The complete task × condition × replicate schedule still runs. Population
selection chooses the primary analysis, not which calls are collected. The
analysis artifact records `primaryIncluded` and `primaryExclusionReason` for
every trial and carries the full population ledger. A future allocation/execution
selector must be an explicit separate contract; it cannot be inferred from an
analysis field.

Condition groups retain all-trial disposition, score and both rate denominators.
Each group also contains `primary` counts and `primaryRate`. The primary rate and
all planned contrasts use the same selected rows and frozen scheduled/completed
denominator. Family bootstrap samples only families represented in that primary
population. Related task families still cannot cross development and held-out
splits; excluded tasks do not supply independent units to the primary interval.

Research and the exported report place **Primary analysis** beside the complete
trial disposition. `primary-population.csv` lists inclusion reasons and
`primary-rates.csv` lists selected counts, rates and excluded scheduled counts.
Every attempted/pending/failed trial remains in the general results and resource
accounting. Analysis artifact version 3 distinguishes this explicit primary
population structure from earlier analysis output.

A synthetic control makes the distinction observable: one condition answers
nine development tasks correctly and fails the held-out task; another does the
reverse. Pooled rates are 90% versus 10%. With the held-out population, primary
rates are 0% versus 100% and the first-minus-second contrast is −1. The full
20-trial ledger is retained. A selected task with no collected answer remains
in the scheduled primary denominator; completed-only rates remain unavailable
when that denominator is empty.

Analysis-plan fields, contrasts and uncertainty objects are closed schemas.
Unsupported declarations such as `primarySplit`, an unimplemented weighting
method or a misspelled estimator refuse rather than freezing as ignored text.
The supported primary contrasts are still rate differences with the declared
family-bootstrap option; a population field does not add arbitrary estimands,
assignment plans, weights or scientific outcome types.
Typed endpoints declared beside the binary criterion, their estimators and the
cluster bootstrap are described in
[typed endpoints and estimators](research-benchmark-endpoints.md).

## Reverify the complete deterministic custom result

A custom Node grader returns finite JSON containing boolean `passed` and finite
`score`. Optional `classification` must be nonempty text of at most 128 characters;
object-valued categories cannot collapse distinct outcomes into the same table key.
All additional deterministic fields, including `classification`, nested
metrics, arrays and explicit nulls, are part of that result. Missing values and
added fields are meaningful changes. The host reserves `grade.process` for its
original execution receipt; a grader cannot overwrite it.

The shared journal verifier and report generator compare the entire retained
result against the original process stdout when a receipt exists. Malformed or
unsuccessful receipts and changed scientific fields refuse. The runner checks
new custom results before marking an attempt completed, including direct API
callbacks. Rejected JSON results and the collected response stay retained;
non-JSON caller values are rejected and cannot be serialized as JSON evidence.
The CLI additionally
reruns the pinned grader in the existing bounded owned child host and compares
its complete deterministic output before accepting stored outcomes for status,
analysis, reference sealing or resume. The fresh process's logs are separate
execution evidence and do not overwrite the original receipt. Invalid initial
grading results retain their raw output/process evidence and halt without
redrawing a collected response.

Browser checks establish retained-evidence consistency; they do not execute a
Node grader or authenticate execution. A coherent fabricated result and matching
stdout cannot establish that a module actually ran. The fresh CLI recheck can
reject a coherent stored result that the pinned grader does not reproduce.
Research, analysis JSON and `custom-grade-evidence.csv` show the actual number
of completed grades with and without an original process receipt. A removed
receipt reduces that evidence count; it cannot preserve a claim of retained host
output. The journal format cannot authenticate whether a missing receipt was
removed or never produced.

Direct API grades without a process receipt remain supported as explicitly
limited caller-supplied evidence; their whole JSON is still validated, and the
CLI rechecks their complete result. No personal approval is inferred.

Custom grading should derive deterministic outcomes from retained observations.
Taking a new live-state measurement during regrading would change the scientific
input; a reusable environment template must collect and bind those observations
separately. Typed units, observation windows, environment ownership/reset,
assignment/dependence and qualified template defaults remain broader work in
[the experiment-template assessment](research-experiment-template-gaps.md).
