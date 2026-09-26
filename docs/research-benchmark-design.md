# Grouped assignment design

The optional `designPlan` block of a version 2 specification is a grouped
assignment ledger. It annotates the frozen crossed schedule (every task with
every condition, repeated `protocol.replicates` times) with **arms**, **draw
units**, member indices and ordered **phases**, and declares planned **arm
contrasts**. It is representation and analysis grouping only: a design plan
never changes how a trial runs, its budgets, its admission or its grading. A
frozen project without the field keeps its exact schedule, analysis and report
bytes.

## Declaration

```json
"designPlan": {
  "version": 1,
  "rationale": "Why these arms, draws and phases answer the study question.",
  "arms": [
    { "id": "sequential", "conditionIds": ["seq"], "label": "One task at a time" },
    { "id": "isolation", "conditionIds": ["iso"] }
  ],
  "unit": { "kind": "draw", "groupBy": "factor:site", "members": 2 },
  "phases": [
    { "id": "pilot", "draws": 2, "factorLevels": { "site": ["s1", "s2"] } },
    { "id": "main", "draws": 3, "requiresRecordedDecision": "pilot" }
  ],
  "contrasts": [ { "id": "isolation-vs-sequential", "first": "isolation", "second": "sequential" } ]
}
```

| Field | Meaning and rule |
| --- | --- |
| `arms` | Groups of condition identifiers. Every condition belongs to exactly one arm; an arm identifier cannot also be a condition identifier. Omitted arms make each condition its own arm. At most 32. |
| `unit` | The assignment unit. `kind` is `draw`; `groupBy` names a task factor (`factor:<id>`); `members` is the exact number of tasks that share each level of that factor. A draw is those tasks under one condition and one replicate. At most 8 members. |
| `phases` | Ordered replicate ranges. `draws` per phase must sum to `protocol.replicates`. `factorLevels` restricts the phase to tasks whose factors take the listed levels; trials outside them are **not scheduled** and their identities are retained. `requiresRecordedDecision` names an earlier phase whose stop-rule decision must exist; this runtime records `not-evaluated` until a separate stop-rule evaluation exists and does not gate the phase. At most 16. |
| `contrasts` | Planned arm contrasts (`first` minus `second`), each naming two different declared arms. At most 64. |

Unknown fields refuse validation. The plan is validated with the study, in the
builder's **Grouped assignment design** field (Protocol panel) and at freeze.

## Builder fields

Research → Benchmark builder → **Analysis & report → Grouped assignment design**
holds labeled fields: a switch that declares the design, the rationale, arms
(identifier, label and one tick box per condition), the draw unit (a switch,
the task factor that groups a draw, members per draw), phases (identifier,
draws, the earlier phase whose recorded decision is required, and one
comma-separated level list per task factor -- a level containing a comma, a
leading or trailing space, or a literal quote is shown and typed back in
JSON-quoted, for example "a,b"; blank means every level) and
planned arm contrasts (identifier, first arm, second arm), each with Add and
Remove controls. **Apply design fields** converts the rows to the contract; an
unfinished value (a members count of `x`, a phase without draws) refuses with
the row named and leaves every field on screen and the applied design
unchanged. Unapplied field text survives **Save draft** and a remount. The
**Advanced design plan (JSON)** editor beneath the fields applies the same
contract from raw JSON.

## Frozen schedule

Each schedule row gains `armId`, `unitId` (`<condition>/<canonical factor level>/<replicate>`,
or `<condition>/<task>/<replicate>` without a unit), `unitGroup`, `memberIndex`
(task order within its group, 1-based) and `phase` when phases are declared.
Draws are shuffled as whole units with the protocol seed, so the members of a
draw stay adjacent in the frozen order. The export retains `design/plan.json`
with the resolved arms, unit, phases, contrasts, unit count, scheduled count and
every excluded trial identity; `node cli.mjs verify` refuses a changed artifact.

## Analysis and report

`analyze` adds `summary.design` and the report adds a **Grouped assignment
design** section with `design.json`:

- `arms`: the existing pass-based measures per arm (scheduled, completed,
  passed, primary rates over the primary population).
- `units`: one row per draw with its members, completed members, whether every
  member passed, `wallMs` (the longest member attempt) and `agentMs` (the sum);
  both are available only when every member completed.
- `phases`: measures per phase and the recorded decision state.
- `contrasts`: arm contrasts with the same paired cluster or family percentile
  bootstrap as condition contrasts when an uncertainty procedure is declared.
- Strata gain the `arm` and `phase` dimensions.

Typed endpoints (see [typed endpoints](research-benchmark-endpoints.md)) can read
the draw through the attempt record's `unit` root: `members`, `completedMembers`,
`allPassed`, `wallMs`, `agentMs` (null without a design plan). A rate endpoint
with exposure `["unit", "wallMs"]` therefore measures events per draw wall time,
and one with exposure `["elapsedMs"]` measures events per member attempt time.
When endpoints and arms are both declared, `endpoints.arms` and
`endpoints.armContrasts` estimate each endpoint per arm and per arm contrast.

## Limits

- Arms, draws and phases describe the frozen design; they establish no
  independence between members of a draw or between draws of a site.
- Draw wall and agent times are arithmetic over the retained member attempt
  observations (the longest and the summed member times); they measure no
  concurrency, processor use or agent behaviour, and concurrent execution of the
  members of a draw is not implied by the ledger.
- A phase decision is recorded only by a stop-rule evaluation; none exists in
  this runtime version, so `requiresRecordedDecision` reports `not-evaluated`.
- The 10,000-trial schedule bound applies after phase exclusions.
