# Generic templates guide (G9)

How an investigator completes a study design using only the Research page's
generic fields — no study-specific runtime code. This guide names every point
where the walkthrough currently stops on a registered gap. It updates
reports/007-GENERIC-TEMPLATES-GUIDE-DRAFT.md (a lane document, outside this repository) (a lane document, outside this
repository) to the fields that exist on this tree; see
`docs/research-generic-benchmark-requirements.md` for the full ledger each
step below is drawn from.

## 1. One study, only fields

An investigator fills the builder's labeled fields, or edits the specification
JSON directly, and never writes study-specific runtime code: nested prompt
compositions, task families, conditions, endpoints and the assignment design
are all data. `tools/test/fixtures/research-benchmark-generic-activation.mjs`
is a fully generic pair of pinned interpreter modules used across the test
suite for exactly this reason — no domain-specific grader is required to
exercise the templates end to end for interpreted answers.

## 2. Nesting

Compositions recurse to arbitrary depth through typed slots (role, schema,
cycle and budget refusals are explicit, not silent). Proven to depth 8 / 257
nodes and a 1,000-level chain by `tools/test/research-benchmark-composition.test.mjs`;
the occurrence fields and their generated checklist are proven by
`tools/test/research-benchmark-composition-fields.test.mjs`.

## 3. Arms, draws and phases

The `designPlan` block groups conditions into **arms**, groups tasks into
**draw units** with a fixed member count, and orders **phases**, without
changing how any one trial runs. A path segment made only of digits, or
containing a literal dot, keeps its exact type and content through the
builder's fields and the advanced JSON editor. This is the G5 gap, delivered
on this branch: `docs/research-benchmark-design.md`,
`tools/test/research-benchmark-design.test.mjs`. The stop point beyond design
and analysis: draw members are not dispatched to concurrent agents by this
runtime (Gap G3/G4), so a Study B collection still needs Codex-owned runtime
work.

## 4. Endpoints

`analysisPlan.endpoints` declares a typed outcome beyond the binary pass: a
count, a rate with its own exposure path, a duration, a proportion, or an
event time with a censoring cap. Every path into the retained attempt record
has two exact text forms — dotted (`grade.conflicts`) when every segment is a
plain name or a nonnegative-integer index, or a JSON array
(`["grade","a.b"]`) when a segment contains a literal dot or is made only of
digits — so an existing plan never has a segment split, retyped or rewritten
by the form. This is the G6 gap, delivered on this branch:
`docs/research-benchmark-endpoints.md`,
`tools/test/research-benchmark-endpoint-fields.test.mjs`,
`tools/test/research-benchmark-endpoints.test.mjs`. Reading the report
tables: `endpoint-conditions-<id>.csv`, `endpoint-strata-<id>.csv`,
`endpoints-contrasts.csv`, `endpoints-intervals.csv`, `endpoints-records.csv`,
and the exchangeability-diagnostic table by replicate index (which also
answers Study B's cross-draw independence check, B8).

## 5. Reproducing the page from the export

The exported project's own CLI entry point runs `verify`, `run` and `analyze`
against the identical pinned sources and produces byte-identical report
tables to the page, on the same retained evidence. This parity is proven for
typed endpoints specifically (GUI apply → freeze → run → export →
`cli.mjs analyze` → compare) by `tools/test/research-benchmark-endpoints.test.mjs`
and by the browser driver `tools/test/fixtures/run-research-endpoint-fields.mjs`,
which compares every endpoint table and the endpoints sidecar JSON file byte for
byte between the page and the CLI.

## 6. What the templates refuse and why

- An unfinished field value (for example a censoring cap of `12e`, or an
  empty attempt-record path) refuses at **Apply**, names the row, and leaves
  every row — including the unfinished text — on screen and out of the
  applied plan. Proven by `tools/test/research-benchmark-endpoint-fields.test.mjs`.
- A malformed JSON-array path (`[]`, an empty string segment, a negative or
  non-integer numeric segment, invalid JSON syntax) refuses and names the
  row rather than silently coercing it. Same test file.
- A design plan with an unfinished members count or a phase without draws
  refuses the same way and leaves the fields on screen, proven by
  `tools/test/research-benchmark-design.test.mjs`.
- Freezing under an `experiment` execution purpose refuses any primary
  endpoint other than the binary pass itself, because the admitted
  experiment design declares the binary pass the primary outcome
  (`docs/research-benchmark-endpoints.md`).
- What this guide does **not** claim: executable-program grading (Gap G2),
  environment fixtures and concurrent agent dispatch (Gap G3/G4), qualification
  gates for executed controls (Gap G7) and machine-checked stop rules
  (Gap G8) are not delivered by this stage. See
  `docs/research-generic-benchmark-requirements.md` §5 for the owner-standard
  statement.
