# Registered requirement qualification

The **Qualification** panel binds a requirement plan to the same composition
used by Research authoring, task freeze and portable execution. A checklist
occurrence identifies provenance. A registered witness additionally declares
the input, observable hand checks, required activation and a plausible wrong
reading that the observation must distinguish.

The plan is optional for existing projects. Adding it does not certify the
full study or bypass personal bundle and information-packet reviews. A
frozen plan is a registration of these exact declarations, not a personal
approval or an external preregistration receipt.

```json
{
  "version": 1,
  "shrink": {"sequencePath": ["bars"], "maxEvaluations": 48},
  "targets": [{
    "id": "entry-quantity",
    "taskId": "four-roles",
    "requirementId": "root/buy_process#op-shares",
    "rationale": "The entry process must buy four whole shares.",
    "activation": [{"kind": "counter", "name": "actions", "minimum": 1}],
    "probes": [{
      "id": "delayed-partial-roundtrip",
      "input": {},
      "assertions": [{"path": ["orders", 0, "quantity"], "equals": 4}]
    }],
    "wrongReadings": [{
      "id": "buy-two",
      "root": {},
      "rationale": "Buying two shares violates this process."
    }]
  }]
}
```

Replace both empty objects with complete task input and a typed root from
the current library. The example is a schema guide, not runnable study data.
The synthetic fixture in
`tools/test/fixtures/research-benchmark-requirements.mjs` contains five
complete controls: entry equality, entry quantity, holding age, private exit
quantity and RACE acquisition. Both RACE alternatives remain explicit drafts.

Each target binds its task, optional `readingId`, exact requirement occurrence,
bundle/dependency hashes, prompt and semantic hashes. Information tasks must
name an admissible reading. The private latent baseline cannot silently become
their oracle. Every wrong reading preserves topology, roles, child ownership
and all other local semantics. Semantically duplicate wrong readings refuse
compilation. Template child order may change only at the targeted template.
Execution appendices remain listed as unregistered; they need their own
apparatus qualification instead of an invented local atom mutation.

Probe assertions use literal arrays of own-property keys or indices. A
missing value differs from an explicit null. Paths do not evaluate code.
Every probe declares at least one observable hand check. LEAN expected
observations are independently derived for each compiled probe and wrong
reading; they do not replace these investigator declarations.

## Execution and evidence

Export the project and run `node cli.mjs qualify`. The standalone verifier
regenerates `requirements/registry.json` from the frozen specification and
refuses a changed or omitted registry even if its file manifest is rewritten.
All 41 runtime files remain pinned. The paired engine must retain its 64-pin
verification capacity.

For LEAN, qualification executes JavaScript and a separate Python process for
each reference and wrong reading. It compares their complete interpretations,
including private reference state, before using observations or activation.
These diagnostics are trusted-reference checks. Candidate reports and printed
state cannot supply activation or native grading truth.

Operational atom counters are `evaluated`, `ready`, `true` and `actions`.
Template gate/reset counters use prefixes such as `gate-true` and
`reset-true`. Transition names are explicit controller events such as
`race-acquired` and `sequence-advanced`. The legacy synchronous interpreter
only records activated transition names; its set membership supplies a value
of one, never an invented count of repeated evaluations.

A target qualifies only when every reference agrees with Python and its
hand checks, at least one probe meets every activation constraint, and every
registered wrong reading is distinguished on an activated probe. Wrong-reading
interpreter failures and disagreement remain failed evidence. An empty wrong
registry, an inactive requirement or an observationally equivalent wrong
reading remains incomplete. A visible observation difference alone does not
establish activation. Unregistered occurrences remain listed in every report.

The CLI writes the full `results/qualification.json`, plus JSON, HTML,
Markdown and CSV tables under `results/qualification/`. A failed, incomplete
or unavailable requirement qualification returns a nonzero exit status after
retaining its result. Cancellation stops the owned Python process before the
CLI exits. These local results do not execute a model or LEAN container.

The exported `qualifyRequirements` function is generic: callers supply two
interpreters that return an observation, activation and optional complete
interpretation. Custom domains need their own source-bound independent
interpreters; the stock CLI reports them unavailable. Supplying two callbacks
is not proof of algorithmic independence. The stock LEAN consumer uses its
separate pinned JavaScript and Python implementations.

## Diagnostic shrinking and native controls

Optional shrinking deletes contiguous chunks and individual elements from the
declared sequence. It keeps a shorter input only if both interpreters still
agree, the same requirement activates and the registered wrong reading still
has an observable difference. Original probes and the complete attempt ledger
remain unchanged. Known invalid inputs fail the witness predicate. Execution
errors remain unknown and cannot prove deletion minimality.

`oneMinimal` means no single retained element can be deleted while preserving
that predicate. It is not a global minimum, a semantic simplification, or a
replacement registered test. Exhausting the explicit evaluation budget leaves
minimality unproven and qualification incomplete. Minimized inputs are
diagnostics; their original hand assertions are not silently reinterpreted.

`tools/test/fixtures/qualify-research-benchmark-requirements.mjs` exports the
five synthetic controls, independently qualifies them, then runs the registered
reference and wrong-reading programs three times each in the pinned native
image. It compares actual retained orders/events with each reading's qualified
observation and checks that the actual wrong program fails against the baseline.
It deduplicates identical programs and inputs with explicit witness bindings.
Minimized inputs receive separate single native probes; they are not counted
as three-run native qualification. Source, project, case, raw native and artifact
hash evidence is retained. No provider calls or counted collection occur.

These controls exercise the mechanism and five declared requirements. The
full approved catalog, complete requirement/operator coverage, options,
T1–T4 qualification, personal reviews and authorized collection still need
their respective evidence. Final integration and LIVE/next-start promotion
remain with the existing promoter.

## Qualification on the selected task inputs

A probe can activate a requirement while the selected task never exercises it.
For example, an entry-boundary probe crosses the threshold but the actual
selected bars stay at equality. Independent interpreters can agree on an empty
order observation in both cases. Probe qualification alone therefore does not
establish meaningful activation on the selected input.

Add this declaration to the requirement plan before reviewing and freezing:

```json
"selectedInput": {
  "policy": "require-composition",
  "rationale": "Every selected composition occurrence must activate and distinguish its registered wrong readings.",
  "timeoutMs": 120000
}
```

The shared compiler binds the exact input and expected-observation hashes for
each registered task, explicit admissible reading and requirement occurrence.
Both interpreters execute the selected input and every registered wrong reading.
All activation rules must pass, and every wrong reading must produce an
independently agreed observable difference. A wrong reading that cannot compile
on that input remains unavailable; its construction error never counts as
behavioral rejection. Separate hand probes and their diagnostic shrinking remain
required. The selected input is never replaced by a smaller witness. Required
gates reconstruct each shrink candidate from its original sequence, verify the
retained raw counterpart comparison and candidate digest, and derive deletion
minimality from independently checked single-element deletions. Contradictory
lengths, indices, budgets, input bytes or minimality flags refuse verification.

| Policy | Collection requirement |
| --- | --- |
| `report` | Diagnose selected inputs without enforcing a collection gate. |
| `require-registered` | Every registered occurrence passes its probe and selected-input checks. Unregistered composition remains explicitly reported. |
| `require-composition` | The registered gate passes and covers every composition occurrence across every selected task and admissible reading. |

Runtime contract appendices remain separately unassessed apparatus obligations.
They are not composition nodes, and successful composition coverage does not
close native or personal review gates. All three policies retain scope and
coverage counts. The timeout is an integer from 100 through 3,600,000 ms. The
registry's existing 512-case construction limit includes selected-input cases;
shrinking applies only to the separate probe witnesses.

For either required policy, `node cli.mjs run` executes fresh qualification
before dispatching any new adapter attempt in that invocation. It records an
internally validated `qualification` event durably before `started`. The proof
binds project, registry, runtime sources, task/reading/requirement identities,
input hashes and raw independently agreed interpretations. Verification
recomputes assertions, activation and observable differences. A reported status
flag is insufficient. Failure, cancellation, a deadline or failed journal write
prevents collection. The qualification deadline also respects the remaining
overall active-run budget; attempt timing remains separate. Across resumed invocations,
prior attempt durations remain charged, but qualification preparation time is
currently charged only within its invocation. A cumulative preparation-time
ledger remains a broader experiment-budget obligation.

Each preflight has its own directory under `results/preflight/`, with source
bindings, completed qualification reports or failure diagnostics. On interruption,
partial completed whole-task checks and generic process receipts are retained;
this is not a complete proof of every partially executed requirement check.
The CLI waits for owned interpreter shutdown before releasing its run lock.
Standalone `qualify` errors retain available partial records under
`results/qualification-failures/`. Neither command turns these diagnostic records
into a successful gate.

A resume with pending eligible work qualifies again before its next dispatch.
Completed trials remain complete; a completed resume adds no gate or adapter
calls. Journal verification refuses an attempt that lacks the required prior
proof. Research disables direct browser replay for gated projects and directs
execution through the portable CLI or connected run service. Imported evidence
reconstructs the same report, including linked receipt HTML and all raw proof
under `qualification-receipts/<journal-sequence>/`.

## Portable generic interpreter modules

The same gate supports generic domains through two explicit interpreter modules:

```json
"interpreters": {
  "reference": "interpreters/direct.mjs",
  "independent": "interpreters/steps.mjs",
  "rationale": "Explain their independent designs and hand-checked domain."
}
```

Pin both files in `spec.inputs` and attach their text through Protocol before
export. The manifest must retain both files and their frozen hashes. The files
must have distinct paths and source bytes. This is a necessary binding check,
not proof of scientific independence. LEAN retains its built-in JavaScript and
Python implementations; custom modules cannot replace that counterpart.

Each file exports `interpret(task, target, options)`, returning
`{ observation, activation: { counters, transitions } }`. `task` contains `id`,
`root`, `variables`, `input`, and `compiled.semantic`/`compiled.composition`.
`target` is null for the whole-task expected-observation check or an object
containing only `requirement` for an occurrence check. The request excludes
expected answers, probe assertions, wrong-reading identities and candidate
responses. Missing activation is unavailable, not an assumed zero or a pass.

Each call runs in an owned Node child process with the overall deadline, a
60-second per-call ceiling and bounded output. Cancellation kills the owned
process group. The receipt records source binding, exact request, stdout,
stderr and exit status. Proof validation matches each result against its raw
process output and source-bound request. These modules have normal local file
access, as custom adapters do; the process boundary is not a filesystem sandbox.
Pin and declare supporting dependencies. Equivalent or jointly incorrect modules
can agree, so hand checks, independent design review and domain/native controls
remain necessary. Retained receipts establish internal consistency and
reproducible bindings, not authenticated third-party execution.

The synthetic `research-benchmark-generic-activation.mjs` fixture supplies direct
addition and bounded repeated signed unit steps, with a declared input offset,
hand-checked probe and wrong first operand. The operational activation fixture
covers all four roles and the private Strategy asset on a two-asset market input.
Both are apparatus controls; neither selects the owner's personal study atoms.
