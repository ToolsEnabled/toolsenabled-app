# Typed endpoints and estimators

The **Analysis & report** plan can declare typed endpoints beside the binary
pass criterion. An endpoint names one value in the retained attempt record, its
kind, its unit and the direction that counts as better. The analysis reads that
value by a literal path for every scheduled trial in the primary population,
computes a kind-specific estimator per condition and per stratum, and
regenerates every table from the frozen schedule and attempt journal. A project
whose plan has no `endpoints` field analyzes and reports exactly as before.

Declaring an endpoint does not qualify the grader or observer that produces its
value. The platform reads what was retained; it does not authenticate it, infer
a missing value, or coerce a value of the wrong type.

## Declaration

Add `endpoints` to `analysisPlan`, next to the existing contrasts and
uncertainty fields. The field is an array of one to thirty-two endpoints.

```json
"endpoints": [
  { "id": "conflicts", "kind": "count", "source": { "path": ["grade", "conflicts"] },
    "direction": "lower-better", "primary": false, "unit": "events",
    "rationale": "Conflicting edits counted by the frozen grader." },
  { "id": "completions", "kind": "rate", "source": { "path": ["grade", "completed"] },
    "exposure": { "path": ["elapsedMs"], "unit": "wall-ms" },
    "direction": "higher-better", "primary": false, "unit": "completions per ms",
    "rationale": "Completed items over the attempt's host wall-clock time." },
  { "id": "first-stall", "kind": "event-time", "source": { "path": ["grade", "firstStallMs"] },
    "cap": 60000, "direction": "lower-better", "primary": false, "unit": "ms",
    "rationale": "Time to the first stall; attempts that never stall are censored at the cap." }
]
```

| Field | Meaning |
| --- | --- |
| `id` | Distinct lowercase identifier. It names the report tables. |
| `kind` | `binary`, `count`, `rate`, `duration`, `proportion` or `event-time`. |
| `source.path` | Literal path into the attempt record: an array of property names and nonnegative array indexes, starting at one of the record fields below. |
| `exposure` | Rate endpoints only: `{ path, unit }` read from the same record, with unit `ms`, `agent-ms`, `wall-ms` or `count`. |
| `cap` | Event-time endpoints only: positive integer milliseconds. Values at or above the cap are censored. |
| `direction` | `higher-better` or `lower-better`. Reports state it; no ranking is inferred. |
| `primary` | Boolean. At most one endpoint is primary. |
| `unit` | Short unit label for tables. |
| `rationale` | Why this value is an endpoint of the design. |

Freezing refuses unknown fields, duplicate identifiers, a rate without an
exposure, a cap on any other kind, two primaries, and a source path that is not
an array of strings and nonnegative integers rooted at a record field. Under an
`experiment` execution purpose only the binary pass itself
(`kind: "binary"`, path `["passed"]`) may be primary, because the admitted
experiment design declares the binary pass primary outcome; other kinds are
analyzed as secondary endpoints there, or as primary under apparatus development
and recorded diagnostics.

## The attempt record

Every path is evaluated against this record, built once per scheduled trial by
`endpointRecord(project, trial, completedEvent, lastEvent)` in
`src/benchmark/analysis.mjs`:

```json
{
  "passed": true, "score": 1, "elapsedMs": 1234,
  "status": "completed", "attempts": 1,
  "grade": { "passed": true, "score": 1, "conflicts": 2 },
  "reported": { "usage": { "outputTokens": { "status": "observed", "value": 41 } } },
  "effects": null,
  "response": { "outputBytes": 17 }
}
```

`passed`, `score`, `elapsedMs` and `grade` come from the first completed
attempt; they are `null` when the trial has none. `status` and `attempts` are
the trial's disposition and started-attempt count from the results table.
`reported` is the completed attempt's observation record when an observation
plan is frozen, otherwise `null`. `effects` is `grade.resourceEffects` for
generated resource experiments, otherwise `null`. `response.outputBytes` is the
UTF-8 length of the completed output. A path that reaches nothing yields `null`;
null values are excluded from every estimator and counted as `unavailable`. A
present value of the wrong type is excluded and counted as `invalid`.

Custom Node graders can return additional finite JSON fields beside `passed` and
`score`; those fields are the natural place for endpoint values, and the CLI
rechecks the complete grade before analysis.

With a [grouped assignment design](research-benchmark-design.md), the record also carries a `unit` root (`members`, `completedMembers`, `allPassed`, `wallMs`, `agentMs`) describing the trial's draw; it is `null` otherwise.

## Builder fields

Research → Benchmark builder → **Analysis & report → Typed endpoints** holds one
labeled form per endpoint: identifier, kind, source path, the exposure path and
unit for a rate, the censoring cap for an event time, measurement unit,
direction, the primary choice and a rationale. A path is shown dotted (a
segment made only of digits addresses an array index) when that dotted text
reads back to the exact path, or otherwise as its JSON array form (for example
`["grade","a.b"]` or `["grade","0"]`) so no literal segment is ever rewritten;
typing text starting with `[` is read as that JSON array form. **Add endpoint**
and **Remove endpoint** manage the roster. Field text stays text until **Apply
analysis plan** converts it to
the frozen contract; an unfinished value (for example a cap of `12e`) refuses
with the row named and leaves every row, including the unfinished text, on
screen and out of the applied plan. Reapplying the plan from other analysis
fields keeps the declared endpoints, unapplied rows survive **Save draft** and a
remount, and removing every row omits the field so older plans keep their exact
shape. The full specification editor remains available for advanced edits.

## Estimators

Estimators are computed over the primary population, per condition and per
stratum (split and every task factor). `scheduled` counts the population's
scheduled trials in that cell, beside `unavailable` and `invalid`.

| Kind | Value | Estimator |
| --- | --- | --- |
| `binary`, `proportion` | boolean | `n` observed, `k` true, `rate = k / n`, `scheduledRate = k / scheduled`. A binary estimate follows the plan's `primaryDenominator`, exactly as the pass rate does; a proportion estimate is `k / n` with the scheduled rate beside it. |
| `count` | nonnegative integer | `n`, `total`, `mean = total / n`. |
| `rate` | nonnegative integer numerator with exposure | `n` trials with exposure above zero, pooled `numerator`, pooled `exposure`, `unit`, `rate = numerator / exposure`; `zeroExposure` trials are counted and contribute no rate. |
| `duration` | nonnegative finite milliseconds | `n`, `mean`, `median`, `min`, `max`. |
| `event-time` | nonnegative finite milliseconds | `n`, `observed`, `censored`, `cap`, `medianObserved`: the smallest time by which at least half of the trials had the event, with censored trials sorted after every observed time. It exists exactly when at least half of the trials are observed before the cap; otherwise it is `null`. |

Every row also carries `estimate`, the value that intervals, contrasts and the
replicate diagnostic refer to: the rate for binary and proportion, the mean for
count and duration, the pooled rate for rate, and the observed median for
event-time. Empty denominators give `null`, never zero.

Binary estimates follow the frozen `primaryDenominator` (`scheduled` divides
by every scheduled trial, `completed` by trials with an available value).
Proportion estimates are always the observed share `k / n` over trials with an
available boolean value; `k / scheduled` is reported beside them and never
replaces the estimate. Count, rate, duration and event-time estimates use
observed values only, with scheduled, unavailable and invalid counts retained.

## Primary endpoint

When an endpoint is primary, each condition's `primaryRate` becomes that
endpoint's estimate and `primaryEndpoint` records its identity, kind, unit and
direction. The pass-based value stays beside it as `primaryPassRate`, the
`primary` counts are unchanged, and the report's passed-based primary tables and
planned rate contrasts remain present as descriptive tables. The report states
the replacement in its typed-endpoint section.

## Intervals

`uncertainty` accepts the existing `family-bootstrap` or the new
`cluster-bootstrap`:

```json
"uncertainty": { "kind": "cluster-bootstrap", "clusterBy": { "factor": "site" },
  "seed": 872, "iterations": 2000, "confidence": 0.95 }
```

`clusterBy` is `"familyId"` or `{ "factor": "<task factor>" }`; the family or
factor must be declared on every primary-population task. Both procedures give
percentile intervals for each endpoint per condition and for each planned
contrast (the difference of the endpoint estimate, first minus second). Each
draw resamples whole clusters with replacement and recomputes the estimator from
their retained observations; contrast draws keep every cluster together in both
conditions. Bonferroni multiplicity divides the interval level by the number of
condition intervals or contrast intervals respectively. Fewer than two clusters,
or a resample without an estimable value, leaves the interval absent with a
stated reason. The seed fixes every interval; the same journal and plan always
produce the same numbers.

Under `cluster-bootstrap` the planned pass-rate contrasts resample the same
declared cluster. The experiment readiness contract still recognizes only the
family bootstrap for `family-clusters` designs, so a cluster bootstrap by factor
remains an analysis choice for development and diagnostic evidence until the
design contract registers it.

## Exchangeability diagnostic

For every condition and endpoint the report lists the estimate by replicate
index, one row per replicate with its `n`. It is descriptive only: a drift
across replicate index is worth inspecting, but the table is not a test and
does not establish independent draws.

## Report files

With endpoints declared the report gains a **Typed endpoints** section and,
under `tables/`, `endpoint-conditions-<id>.csv` and `endpoint-strata-<id>.csv`
for every endpoint, `endpoints-contrasts.csv` when contrasts are planned,
`endpoints-intervals.csv` when uncertainty is declared,
`endpoints-replicates.csv`, and the complete per-trial `endpoints-records.csv`
with each value's status. `endpoints.json` retains the whole typed analysis,
and `summary.json` carries it as `endpoints`. `node cli.mjs analyze` writes the
same files under `results/`. The analysis artifact version stays 3; the typed
block declares its own `version: 1`.

## Limits

* Values are read, not measured. A grader or observer that reports a wrong
  number produces a wrong endpoint; the platform checks type and availability
  only.
* Rates need a declared exposure; zero or missing exposure contributes nothing
  and is counted. The pooled rate is total events over total exposure, not a
  mean of per-trial rates.
* Event-time values are censored at the cap. The median is unavailable when
  fewer than half of the trials observed the event.
* Cluster bootstrap intervals assume independent clusters. Few clusters, task
  selection and finite test data limit inference, and no parametric test is
  offered.
* The replicate-index table is a diagnostic, not evidence of exchangeability.
