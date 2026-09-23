# Build a portable benchmark in Research

**Prompt design** follows **Snippets → Composition → Nesting → Variance → Build task set**. Composition keeps its snippet-built arrangements, task inputs, routing fields, rules and rows. Arrangements that reuse other compositions appear in Nesting. Nesting retains its composition picker and member builder, with the structure and assembled prompt below. Search the saved members, follow named compositions through the return path, or edit their connections. Both pages share the same saved structures; moving their display does not change prompts or task data.

**Build task set** prepares current tasks, the retained pool from an earlier selection, or all eligible constructions from advanced composition fields. Select saved omission studies to generate their variants into this pool. Counts distinguish current tasks, eligible task/input pairs, distinct eligible prompt wordings, selected tasks and exclusions. Canonical duplicates count once and retain their alias records. The pool supports 4,096 candidates; select 1–512 tasks for a benchmark. Advanced construction enumerates the whole eligible pool before sampling.

Choose a census, simple random sample, equal allocation, proportional allocation, custom weights, or exact group counts. Up to three grouping dimensions define joint strata: omission status, omission arm, declared omission ranges, family, split, depth, or declared factors. The interactive table compares available, requested and selected counts; click a group to read its prompts. Stratified allocations use largest-remainder rounding with canonical group-order ties, then seeded Fisher–Yates draws without replacement. Infeasible quotas are refused without redistribution. These methods follow the [simple random and stratified sampling distinctions described by Statistics Canada](https://www150.statcan.gc.ca/n1/edu/power-pouvoir/ch13/prob/5214899-eng.htm).

Record a selection rationale and generate. The full pool, seed, selected IDs, family identities, splits and exclusion ledger remain in the frozen recipe and are reproduced by the exported runtime. The ledger carries inclusion probabilities and inverse-probability weights conditional on the recorded pool and integer allocation. Selection weights do not automatically change existing analyses. This chart describes authored prompt variants, not outcome variance or independent sampling units. Draft settings survive project switches, export/import and Undo.

Loading LeanBench activates and saves Files & data, Benchmark builder, Run board, Assigned sessions, Results and Report library. **Resource action** remains available but initially disabled in the anchored **Modules** dropdown. It has its own area and is no longer a step in Prompt design. Protocol, Qualification, Accounting, and Run & review retain their existing responsibilities.

New nesting selects named compositions from any family and supports multiple ordered members. Together, sequence, every matching condition, first matching condition, and custom instructions are explicit authoring choices. Conditions are wording inside the assembled prompt, separate from the field rules that select task rows. Save as composition retains references for further nesting; Add this composition as a task appends one task without replacing existing ones. New nesting wrappers preserve old generated task wording until regeneration. Unfinished nesting forms travel in draft exports and stay within their project.

**Variance** can be used before or after assembly. Start with a snippet, saved composition, or existing task; select a snippet occurrence, intermediate composition, or the full nest. Highlight exact text or choose the whole section, name the omission, and choose one appearance or all identical uses in that prompt. Generate one variant per selected section or combine the omissions, with an optional original control. The comparison marks removed text and shows the resulting wording.

**Save reusable variants** puts snippet variants in Snippets and composition/task variants in Nesting. Originals remain available. Choose variant and original members freely when assembling further compositions and nests; a composition-level omission changes only the occurrences selected at that level. **Add previewed variants as tasks** adds new versions and reuses identical existing tasks, including the original control. Each generation records a comparison factor across all its arms, including reused controls. Existing-task sources retain their inputs and reference results; other sources reuse an identical original task’s reference when available, or need those fields completed in Composition. Omissions preserve semantics and source text, record exact ranges in the compiled representation, and travel through export and the standalone runner. A changed source or parameter context refuses a stale omission instead of guessing its new position. Study drafts, selections and unfinished text are project-local and included in draft exports.

Open **Research → Prompt design → Benchmark builder**. The existing experiment grid, run board, evidence, findings, library and layout controls remain available. A benchmark draft belongs to the selected Research project; **Save draft** saves its composition and unapplied editor text to your account. Draft JSON import/export also works independently of account storage.

The shared **Project: [draft name]** dropdown at the top opens local draft files, loads bundled examples such as LeanBench, and inspects exported projects. It stays available across Research pages, including Protocol. Loading controls live here instead of inside Prompt design. **Account projects and storage** in the same dropdown selects the account location for saved work; its label is separate from the active benchmark draft. The **Modules** dropdown controls the visible tools.

New projects start with an empty snippet library and no tasks or conditions. Create snippets, import a library or draft explicitly, or choose a starter. **Load example snippets** adds the LeanBench examples only to the current draft. **New empty draft** clears the current draft with **Undo replacement** available; it does not overwrite the saved version until **Save draft** is pressed. The last task and unused snippet can be removed. Empty drafts can be saved and exported, but a runnable benchmark still needs a complete validated design. Switching projects restores only that project's draft and pending edits. **All projects** is an overview; choose a project or **Unfiled** to edit.

## Compose nested prompts

A library bundle is either an atom or a template. Atoms supply reusable wording, parameters and semantics. Templates have named, typed slots that accept atoms or other templates. **Wrap in template** adds another level around any compatible branch; expand a branch to edit its children. Task JSON can describe larger structures. The compiler checks required slots, roles, identifiers, parameters, cycles and a 4,096-component resource budget.

Generic templates can use any named roles. Their text uses `{{parameter}}` and `{{slot:child}}`. Substitution runs once: inserted user text is never reinterpreted as another template instruction. Explicit slot order controls execution semantics even after JSON is sorted or exported.

In the composition tree, changing a **Bundle** keeps existing children whose slot names and roles match. For example, changing a two-child ALL operator to a two-child SEQUENCE retains both complete nested branches and their local values. The new operator's own parameters start from its declared defaults; inspect them and derive or declare the changed task's expected result. New child slots start unfilled and must be completed before freezing.

A change that would remove a child or change its role refuses without replacing the source. To make that replacement deliberately, choose **Replace whole branch with defaults** under **Next bundle change**, then select the new bundle. This choice applies to the next edit and resets afterward. Inspect every generated child. **Undo replacement** restores the preceding task and raw editor text. A deliberate tree edit still invalidates old frozen results, occurrence/control bindings and task reviews; it creates no approval or new qualification.

New drafts use the version 2 execution contract and default to experiments with required controls. An optional [grouped assignment design](research-benchmark-design.md) can declare arms, draw units and phases over the frozen schedule. See [Fields, generated controls and experiment admission](research-execution-readiness.md) for the ordinary requirement fields, supported designs, explicit apparatus-development mode and legacy evidence boundary.

Apply each edited group before freezing. The preview shows the exact frozen prompt after **Freeze project**, with a requirements checklist and source fingerprints. Changing the draft invalidates the freeze. Editing an already reviewed bundle invalidates its review.

Bundles can declare `parameterSchema` with scalar types, integer bounds and enumerated domains. The compiler rejects missing, out-of-domain and undeclared per-node parameters before rendering. Declared semantic `dependencies` must exist and form an acyclic graph. A review binds each dependency transitively; reviewing a changed primitive alone does not renew the dependent bundle's review. New authoring reviews live in `specification.reviews` and the exported `reviews.json`, separately from semantic content. Old self-contained bundle reviews remain readable; dependency-bearing bundles need a current dependency-root review.

Exported `source-maps/` link checklist requirement IDs to exact prompt ranges, including repeated slot occurrences. Offsets are UTF-16 code units into the frozen prompt. These prose maps do not establish per-requirement code/test coverage; that evidence must be supplied and qualified separately.

## Generate an experiment from fields

Enable **Resource action** in Modules and open its area, or load the **Resource action plan** starter. Supply cases, initial resources, visibility, write permissions and requested changes. **Generate experiment from fields** builds the public prompts, private fixtures, reference plans, controls and observation contract in the selected benchmark draft. Undo restores the preceding draft. Pending field edits must be applied before freezing; they survive draft saves and page remounts.

Each returned plan executes against a fresh bounded resource map. The platform observes task success and both temporary and final collateral changes. Every run qualifies the generated apparatus before collecting a new response. See [Resource experiment fields and execution](research-benchmark-resource-template.md) for the supported profile, measurements, limits and evidence. This template produces runnable apparatus from investigator fields; its recorded starter controls are qualification evidence, not a model evaluation.

## Generate a mechanical corpus

Joint factor quotas and compiled depth, node-count and bundle-group coverage are described in [Frozen joint corpus coverage](research-benchmark-coverage.md). These use the same recipe compiler and retain missing Cartesian cells; structural presence does not establish behavioral activation.

In **Corpus recipe**, choose **Start recipe from selected task**. A recipe retains the base task, family and study split. Add named axes with explicit choices, then **Generate corpus**. Axes can replace a typed node, set a parameter or variable, replace input or expected data, wrap a branch repeatedly in a template, declare an information treatment, or withhold an atomic requirement. Paths are arrays of slot names from the root; `[]` names the root. Edits apply in declared axis order.

For example, after starting a recipe from the LEAN starter, replace the family's `axes` with this pair. It varies the quantity and nesting of the same strategy without rewriting its four roles:

```json
[
  { "id": "quantity", "choices": [
    { "id": "one", "edits": [{ "kind": "parameter", "path": ["strategy", "buy_process"], "name": "quantity", "value": 1 }] },
    { "id": "three", "edits": [{ "kind": "parameter", "path": ["strategy", "buy_process"], "name": "quantity", "value": 3 }] }
  ] },
  { "id": "nesting", "choices": [
    { "id": "flat", "edits": [] },
    { "id": "gated", "edits": [{ "kind": "wrap", "path": ["strategy"], "bundleId": "state-gate", "slot": "child", "repeat": 2, "params": { "symbol": "SPY", "threshold": 9900 } }] }
  ] }
]
```

Use actual template IDs, slots and parameter schemas from the current library. A failed construction is retained with its reason. The shared task compiler checks candidate eligibility before sampling; structurally different aliases of the same canonical task are excluded before selection. Generic expected answers remain investigator declarations. LEAN expected traces are generated from the semantic interpreter and still need independent qualification.

Family `constraints` exclude matching assignments, for example `{ "id": "excluded-pair", "when": { "quantity": ["three"], "nesting": ["gated"] }, "reason": "Explain the compatibility exclusion." }`. Every referenced axis and choice must exist. Unknown recipe fields refuse validation, so misspelled constraints cannot silently disappear.

The selection policy is `all`, `seeded`, or `balanced`, with a limit of 1–512 tasks and a frozen 32-bit seed. Balanced selection greedily prioritizes unmet coverage, with seeded ties; it is not a proof that no other feasible selection exists. Coverage rules such as `{ "dimension": "axis:quantity", "minimum": 1 }` apply to every declared level, including wholly excluded levels. Family coverage uses `dimension: "family"`. The recipe is bounded at 4,096 candidate assignments. Pairwise/operator-activation coverage is not inferred from these marginal quotas.

The coverage and exclusion ledger records all candidate identities, compiler failures, compatibility exclusions, duplicate aliases, unselected candidates and selected tasks. A recipe cannot freeze with unmet coverage or a manually altered task list. Regenerate after editing the recipe, or explicitly detach it for manual authoring; detachment retains recipe history and task origins. Generation clears saved responses because they belonged to the previous task identities. The export includes `corpus/recipe.json` and `corpus/manifest.json`.

## Study omitted information and conventions

For ordinary local alternatives, choose **Prepare information fields** in **Compose tasks**. The platform enumerates the selected task's atom occurrences and original reading sources. Choose the atoms to withhold, supply a family and treatment rationale, then explicitly add readings from the baseline or an original reading. Fill each reading ID and rationale. Select an exact occurrence and parameter to override; the compiler copies the full source root and changes only that local value. Other nested branches, source variables and advanced metadata remain intact. Selecting a source copies its applied values, including when another field row contains unpublished edits.

Choose an expected-answer policy after adding an override. **Declare the expected answer** accepts literal text for exact grading or a JSON value for JSON/native observation grading. **Derive with the existing LEAN interpreter** explicitly derives the supported semantic or operational observation; it does not qualify that result or execute LEAN. **Keep the unchanged source answer** refuses a changed root. Optional labels and convention assignments retain explicit presence or absence. Generic answers are investigator declarations, never inferred from a parameter name.

Choose **Build information treatment from fields** to generate the existing information recipe and validate it through the shared task compiler. Every retained reading must agree on the compiled task fragment; pool exclusions remain in the canonical selection ledger. Field construction creates no review or execution evidence. Prepare the resulting complete review packet separately and record your own review. **Undo replacement** restores the preceding specification and field text. Saved drafts, draft export/import and account/project navigation retain each draft's own pending or invalid field text; unresolved fields block preparation or Freeze. Importing another study or choosing a starter clears the prior study's private fields, with Undo available.

The field roster binds the exact applied specification, including task, existing readings, catalog, source pins and condition/workflow context. **Prepare information fields** inspects retained fields without replacing them. If the source changed, **Replace fields from applied task** explicitly creates a fresh roster; the previous draft remains available through Undo. These fields support local scalar parameter edits. Arbitrary structural alternatives, variable edits and disclosure corpus generation remain in the advanced recipe. Attached corpus, audit and resource designs use their own authoring mechanisms and cannot be silently detached here.

In **Compose tasks**, choose **Add information treatment**. The draft begins with the selected task as one candidate reading. Declare the rationale, withheld atom paths, response format and reading candidates. Each reading needs an `id`, `root` and rationale. Generic readings also need expected answers; LEAN readings derive their traces mechanically. Readings use the same frozen input. Optional `variables` override task variables; optional `conventions` assign named finite scalar values for later distribution tables.

Only atom occurrences can be withheld. For example, `root/strategy/buy_process` withholds that requirement while retaining the four-role structure, other disclosed requirements, execution contract and private provenance. The checklist marks disclosure, and exact prompt maps preserve zero-width occurrences. A template or execution constitution cannot be hidden as a whole.

**Filter candidate pool by visible prompt** compiles every reading and retains those with exactly the same visible prompt. Its packet records every retained and rejected candidate. **Require all declared readings to agree** instead refuses the task if any declared reading changes visible content. Both modes are explicitly finite `declared-set` analyses. They do not establish that the set includes every defensible interpretation.

After applying the treatment, choose **Prepare current review packet**, inspect its prompt, candidates, semantic trees, expected observations, convention assignments, grader settings, environment and source hashes, then record your own review. Modern version-2 packets also include `collectionContext`: every condition's requested model and typed settings, declared collection controls, adapter kind and workflow assignment, plus the complete workflow plan. This binding applies even without accounting. Changing any of these bindings invalidates the task review. Requiring bundle reviews also requires current information-task reviews. The application never supplies investigator approval. Source inspection remains in Prompt library, and exported packets and records are in `information/` and `task-reviews.json`.

Reading consistency compares the compiled task text. A workflow can omit that text, add instructions, project earlier outputs, route between stages and select a terminal result. Inspect those declarations when reviewing the information treatment. The compiler does not infer their natural-language meaning or revise the readings. One task-level reading set applies across all conditions; declare a design that makes that shared set appropriate. The packet binds the full workflow plan, including stages that an actual response might not reach. Dynamic outputs are not known at Freeze; actual stage requests remain in the execution journal. Requested context does not establish provider adherence or independently describe opaque adapter internals. Ordinary requests include declared collection controls only when accounting is enabled; `ordinaryCollectionIncluded` records that rule. Workflow requests use the stage's explicit projection and instructions.

The information recipe remains version 1. Newly compiled schema-2 projects always use packet version 2; there is no option to reuse a weaker binding. Historical schema-1 packets retain their exact original bytes and are labeled as legacy task reviews. Existing frozen schema-2 artifacts with packet version 1 remain unchanged and must be verified with their archived pinned runtime. To use the current runtime, retain that original artifact, open its specification as a new draft, prepare the complete context packet, review it and freeze a new project. Old review hashes are never converted into collection-context approval. The builder distinguishes the applied packet from pending field edits and refreshes review status when those edits are applied.

For explicit response behavior, choose **JSON answer, clarification or refusal**. Systems return exactly one of:

```json
{ "kind": "answer", "answer": "the requested result or program" }
```

```json
{ "kind": "clarification", "message": "Which missing requirement should apply?" }
```

```json
{ "kind": "refusal", "message": "The system's stated reason." }
```

These are measured dispositions. Malformed envelopes, execution failures and answers outside the declared set remain separate. Raw mode makes no attempt to infer a clarification or refusal from arbitrary prose. For LEAN execution grading, the `answer` contains Python source. The synchronous profile compares a native filled-order array; the operational profile compares its normalized observation object, including orders, events, lots, positions, fees and equity. Journal validation, reports and resume retain the profile and recompute agreement with every declared reading. Matching the private baseline alone is insufficient when it is outside that set. Recognizing an observation format is separate from verifying its retained native source artifacts and does not grant experimental admission.

Observable distributions count an answer once, even when it matches multiple readings. A convention value is resolved only if every matching reading assigns the same value. Otherwise its mass remains unresolved; it is never divided equally or attributed to the hidden baseline. Full and withheld variants can be generated together with the recipe's `withhold` edit. Related variants stay in one family and split, including when no analysis plan is declared.

## Audit a judge against retained observations

In the source study, freeze the protocol, run its candidates and retain the evidence. **Judge audit → Export this run as a reference** seals its frozen project, entire attempt journal, runtime source and pinned inputs. For native LEAN evidence or custom graders, run `node cli.mjs reference --output RESULTS_DIRECTORY` in the exported source project. The CLI rechecks custom grades and captures native candidate code, execution configuration and process records, plus the result/order artifacts used by every completed native trace. The original result directory still retains auxiliary files and failed-attempt artifacts. The reference is `RESULTS_DIRECTORY/reference-bundle.json`.

Reference verification checks the project, schedule, journal, file inventory and every pinned byte. Text retains its original UTF-8 bytes, including a BOM; binary inputs use explicit base64. Native traces are reconstructed from retained engine results and orders, then compared with the saved grade and frozen expected observations. This verifies reproducible bindings; it does not authenticate who executed or reviewed imported evidence. Custom source scores retain their recorded-grader basis. Reference bundles are limited to 64 MiB; recursively auditing another judge audit is not supported.

**Import reference bundle** creates a new audit draft. Its plan editor excludes the immutable source bundle. Declare rationale, provenance, selection, criterion and request projection, then **Generate audit cases**. Selection uses all unique candidates or a seeded sample of 1–512 cases. Only the first completed source response per trial can supply a candidate. The full source ledger retains duplicates, sample exclusions, unmeasured trials and collected responses that lacked a completed source grade. Identical judge inputs cannot cross source families/splits or carry conflicting reference labels. Generation clears recorded judge responses; manual case edits cannot freeze unless they reproduce the plan exactly.

The available criteria have different evidentiary scopes:

| Criterion | Reference label |
| --- | --- |
| `frozen-grader` | Accept or reject according to the source's exact frozen observation criterion, including any declared finite interpretation set. |
| `admissible-witness` | Accept when a declared reading supports the response; otherwise retain an unresolved reference with a null score. |
| `declared-determinacy` | Undetermined when multiple declared admissible readings have different observable consequences; finite agreement leaves the reference unresolved. |

Write a criterion statement that matches the selected scope. An outside-set result alone does not justify universal incorrectness, and finite agreement does not establish uniqueness.

For an external benchmark, set `provenance.kind` to `external-benchmark`, supply its title/version, pinned `sourcePaths`, and `acquisition: {method, location, at}`. Acquisition is a declared record, not an automatic download receipt. Every source task must name a pinned input in `provenance.originalPromptPath`; include that path in the audit source list. The projection must use `original-prompt-file`. Original wording and semantic reconstruction remain separate in the case packet. A URL alone is insufficient. Generic source studies and generated controls use their respective provenance kinds.

Configure the judge, budgets and analysis in Protocol and Analysis, then **Prepare current review packets**. Inspect each case, exact judge prompt, original/reconstructed task, candidate, reference observations, source files, criterion, protocol, analysis and runtime hashes. Record your own review of each case and the instruction bundle. Changes invalidate the corresponding review. External benchmark audits require current personal reviews; no investigator approval is supplied by the apparatus.

Judges return an object such as `{"verdict":"accept","reason":"Optional explanation"}`. Verdicts are `accept`, `reject`, `undetermined` or `abstain`. Malformed verdicts, abstentions and collection failures stay separate. Judge requests contain only the declared prompt projection, candidate, optional frozen input, model settings and trial identity. Reference grades, reading sets and private audit labels are not added to requests. As with other local adapters, filesystem access requires separate isolation if the judge program must not read its working directory.

The audit uses the existing runner and attempt journal. Built-in judge grading is identical in the browser and CLI. Unresolved references retain null scores regardless of the judge verdict; reference eligibility is fixed before collection. The required `analysisPlan.primaryPopulation` is `reference-eligible`. Reports preserve all scheduled/completed counts alongside eligible denominators, detection and disagreement counts, and the complete confusion table. Exports include `audit/reference-bundle.json`, the selection manifest, case packets and review records; reports add `audit.json` and source/case keys. `qualify` rechecks these bindings without claiming a new native execution or a real judge evaluation.

## Use any system

The Protocol tab declares systems, model/provider versions and settings, inputs, dependency/environment pins, schedule seed, replicates, attempts and time budgets. General benchmarks support the adapters below. A generated experiment template can restrict them; the resource action-plan profile accepts replay or an HTTPS public request only.

- `replay`: stored responses keyed by task ID, useful for apparatus controls.
- `command`: a literal executable and argument array, without a shell.
- `http`: an HTTPS endpoint accepting the same JSON contract.
- `module`: an attached `.mjs` file exporting `run(request, {signal})`.

A request includes the frozen prompt, input, model settings, trial identity and attempt number. Return one JSON object with an `output` field and optional `usage`. Expected answers are omitted from system requests. Local command/module code is trusted apparatus and can read its working directory; use a containerized command when it needs isolation.

Attach custom modules, graders, text data and lock files under **Project files**. The builder records their digests in the frozen input manifest. External inputs may instead have acquisition instructions and a SHA-256 digest; verification refuses missing or changed bytes. Credentials are environment-variable names in adapter configuration, with values supplied locally at execution.

Exact text, exact JSON, judge-audit verdicts, custom module grading, and LEAN Python execution grading are supported. A custom grader exports `grade(project, task, output)` and returns `{passed, score}`. Custom modules run in owned child processes so a blocked event loop cannot defeat the runner's attempt timeout.

## Account for every attempt

Selected-input qualification records a durable preparation intent and measured completion or failure before collection. Its time charges include interpreter settlement and persist across resumes. Legacy missing timing and reserved orphan-recovery charges remain distinct. See [Preparation budgets and interrupted qualification](research-benchmark-preparation.md).

Optional **Prompt workflow** plans specify staged collection, output-dependent branches, exact parent context projections, tools and budgets. Each condition explicitly names its workflow and whether it is treatment or orchestration. The shared runner retains every stage before selecting a terminal answer for the ordinary grader. See [Frozen prompt workflows](research-benchmark-workflows.md) for authoring, adapter evidence, interruption policy and complete per-stage accounting.

Open **Accounting → Start accounting plan**, check its mappings and policies, then apply it before freezing. The portable `observations.mjs` implements the contract, journal validation and analysis used by both Research and the standalone runner. Projects without a frozen plan retain their raw responses and legacy durations; no normalized identity, usage or cost is inferred.

The default envelope is:

```json
{
  "output": "The requested answer",
  "identity": { "provider": "fixture", "id": "example-v1", "version": "1", "surface": "local-command" },
  "completion": { "status": "complete", "reason": "Synthetic completed response" },
  "usage": { "inputTokens": 12, "outputTokens": 0, "toolCalls": 0,
    "generationMs": 2.5, "cost": { "amount": "0.0001", "currency": "USD" } }
}
```

These numbers are synthetic examples, not prices or usage claims. Every field is optional at collection. Counts must be nonnegative safe integers; a missing or invalid count stays unavailable or invalid, while explicit zero remains zero. Tokens (`inputTokens`, `outputTokens`, `totalTokens`, `cachedInputTokens`, `reasoningTokens`) and `toolCalls` are independent reported fields; totals are not inferred from other counts. `generationMs` is explicitly reported generation time, distinct from host latency. Raw provider envelopes and command/HTTP bytes remain evidence.

Mappings are property-path arrays or explicit null. `overrides` can specify partial mappings, identity/completion policies or a cost-estimation convention for a named condition. Requested provider/model/version/surface/fingerprint and settings stay separate from returned identity. Under the default `identity.policy: "record"`, differences remain observations. `require-match` admits only exact matches on the explicitly declared `identity.fields`; each required field needs a requested value. Missing or different required identity stops collection and preserves the response without a replacement attempt.

Completion status accepts only `complete` or `incomplete`. The default completion policy records either without changing grading. `completion.policy: "require-complete"` stops before grading an explicitly incomplete or unverified response. Arbitrary vendor finish-reason strings and returned output alone do not establish completion. Transport failures, response extraction errors, admission failures, grader failures, native code failures, cancellations and recovery remain distinct. Extraction and admission failures cannot redraw a response on resume.

Optional `condition.collection` declares `comparisonUnit` (`model`, `system` or `apparatus`), `instructions` (`system` and `developer` text or null), `tools` (an array), and text descriptions of `contextConstruction` and `sessionIsolation`. These frozen controls are forwarded in the request's `collection` object. Their enforcement is not inferred from the declaration. The exact conditions and accounting policy enter information/audit task review packets when accounting is enabled.

Cost requires both an exact nonnegative decimal amount and a currency. Missing subscription or provider cost never becomes zero. `costEstimate: null` leaves estimates unavailable. A declared estimate needs a currency, rationale and pinned `sourcePaths`. Choose `kind: "per-started-attempt"` with an `amount` for an explicit allocation, or `kind: "unit-prices"` with `terms` containing `id`, count fields to `add` and `subtract`, `amount`, and a positive integer `per`. For example, an uncached-input term explicitly subtracts `cachedInputTokens` from `inputTokens`; the apparatus does not guess whether a vendor's input count includes cached tokens. Missing quantities leave the estimate unavailable. Unit-price terms round half-up to 18 decimal places. Reported charges use exact decimal sums and stay separate from estimates. Each currency and metadata origin retains its own totals; no currency conversion occurs. These observations cover collection responses, not a complete experiment's grader or infrastructure charges.

All started attempts enter accounting, including retries, failures, cancellations, interrupted runs and an open journal tail. Scores still use the first completed response. `adapter.mode: "envelope"` lets replay fixtures retain the full envelope instead of treating it as the answer; it requires a plan. That metadata describes the recorded response and never establishes a new provider call or charge. Replay host timing measures the current local replay.

Host measurements use a nested monotonic interval tree in integer microseconds. The attempt interval starts before its durable start write and ends after settlement. It excludes terminal journal writing, between-attempt work, project preparation, later verification and offline time. Phase records distinguish collection/transport, extraction, response persistence, grading, program extraction, native preparation/execution/observation, cleanup and settlement. Native execution includes container/engine startup. Inclusive parent intervals contain their children; exclusive durations partition measured attempt time without counting it twice. Interrupted/open attempts have no invented duration; recovery's reserved timeout remains a separate budget charge. Cancellation can truncate active phases, with subsequent owned cleanup measured in settlement when observed.

Exports include `observations/plan.json` and resolved `observations/contracts.json`, rechecked against the frozen specification. Reports add `observations.json` and complete tables of requested controls, returned identities, every attempt/measurement, cost coverage and timing spans. Known subtotals carry observation counts. Full totals remain null whenever an attempt lacks the measurement. The report never substitutes scoring denominators for accounting coverage. Pending accounting edits survive draft saves and account/project switches and must be applied before freezing.

## Lean Bench

Select the **Lean Bench** starter. Each strategy has four independently reusable roles: buy reason, buy process, sell reason and sell process. Strategies can fill parallel, sequence, race, state gate, event gate and reset templates recursively. The draft equity constitution specifies integer cents, whole shares, private lots, shared cash, declared sibling order, timing and reset behavior. Its supported target is deterministic US equity minute backtests. New domains or alternative trading semantics can use the generic builder and attached execution modules.

The catalog and shared apparatus are drafts. Review the wording, operational packet, source and tests, then record your own review for each used bundle. The application never supplies your approval. The constitution review binds all portable runtime files; any source change invalidates that review.

The shared freeze function compares every declared LEAN answer trace with the semantic interpreter. This invariant applies to the Research page and programmatic/CLI use alike; qualification still compares the separate Python implementation and actual engine artifacts.

The execution modules are included in the source review and every exported runtime. `execution.mjs` and the independently implemented `execution_reference.py` admit typed intentions, reserve cash or private inventory, bind native tickets to immutable private lots, and reconcile broker receipts. Inventory and cash change only on fills. Cancellation requests retain their reservations until acknowledged; partial fills retain their actual inventory after cancellation. Receipt identities, event order, exact integer arithmetic, fees, asset multipliers and declared resource limits are checked. A single ordered journal can be replayed independently.

The generated version-one reference uses that ledger and dispatches intentions before any settlement. Its LEAN callbacks supply actual fills; the JavaScript/Python interpretation modes explicitly simulate the frozen full-fill model. Version one still requires synchronous full fills at the declared close. The separate `execution_lean.py` adapter and `execution-lean.mjs` native-artifact verifier support explicitly reported delayed and partial market fills with cancellation. They require integer quantities/cents and explicit fee currencies, including zero-fee fill receipts. These reusable execution capabilities do not select asynchronous RACE ownership, gate expiry, option lifecycle or other new study semantics. Those choices require their own versioned contracts and review.

The starter's recorded trace checks composition and scoring. For bounded development of generated strategy code, explicitly select **Test unfinished apparatus** in the qualification cohort, choose **LEAN Python in pinned engine**, declare an immutable Docker digest in `environment.leanImage`, and give each attempt enough time for generation and engine startup (for example, 120 seconds). The frozen grading configuration includes a separate engine execution timeout. Native scientific collection remains blocked until its source/image/data/observer/control admission mechanism and original gates are satisfied; selecting this grader cannot grant admission. System responses contain `FrozenBenchmark(QCAlgorithm)` Python source or one Python code block. The exact prompt supplies bar data, cash, strategy paths and native order-tag requirements.

The exported runner builds deterministic minute files from those frozen bars, reads market metadata from the pinned image, and runs each candidate in a disposable container with network access disabled and resource limits. Only candidate code, input data, configuration and its result directory are mounted. It retains Python, configuration, engine logs, native result/order artifacts, actual traces and container ownership records. Scoring compares native filled order events, quantities, timestamps, prices, symbols and private strategy tags. Printed trace claims are not used as grades. An execution timeout is a measured code failure; provider or apparatus failures remain separate failed attempts.

## Export, run and inspect

**Export runnable ZIP** contains the frozen specification, exact prompts/checklists, schedule, source, attachments, manifest and dependency-free Node runner. Extract it to a fresh directory. Node 22 or later is required. Independent Lean interpretation also needs Python 3.10 or later. LEAN code grading needs local Docker, Python and the declared image already pulled by digest.

```sh
node cli.mjs verify
node cli.mjs qualify
node cli.mjs run
node cli.mjs status
node cli.mjs analyze
```

`qualify` compares each Lean task and every retained reading with the JavaScript and Python implementations. Each reading's generated program includes its pinned Python helper and inputs. Qualification records its precise scope; it is not a model result or an engine-run receipt. For custom graders, supply independent qualification fixtures.

The browser's **Run recorded responses** uses the same runner and built-in text/JSON/judge grading. External runs use the exported CLI. Import `results/evidence.json` into the builder to view that run. The import verifies its project binding and journal; built-in text/JSON/judge grades are recomputed from retained responses.

After **Freeze project**, the page shows what the frozen project will send and grade: the frozen schedule (trial, task, condition, replicate), every condition as frozen (provider, declared model, surface, adapter kind and target, the names of the environment variables it may read, its settings and workflow), the protocol and native grading contract (attempts, timeouts, seed, grading kind, the pinned engine image digest, the engine execution timeout and the pinned `lean-grade.mjs` digest whose container flags the exported report lists) and the pinned runtime file digests. Saved replay responses and credential values are never shown there. After a recorded-response run or an evidence import, a run journal shows the frozen project digest, the execution purpose and evidence class, the journal's event and trial counts, when the first attempt started and when the last one ended (its start plus its elapsed time, because finished events carry no clock time), the runtime the journal recorded, the readiness contract the attempts were admitted under, and the trial dispositions by condition. Importing native evidence adds the verification receipt's status, every checked attempt and the limitations the receipt states. Everything in these views is read from the frozen project, the journal, the summary or the receipt; an absent field prints "Not declared" or "Unavailable".

To use the existing run board, choose a saved Research project, extract the ZIP on the run computer, and supply its absolute directory and Node command. The service pins runtime files before launch and stores output in its per-run artifact directory. Its one-hour limit allows a benchmark budget up to 59 minutes 30 seconds. Its environment policy does not forward credentials; use the standalone CLI for such conditions or longer runs.

`attempts.jsonl` is the durable raw record. Starts are flushed before dispatch; system responses are flushed under `responses/` before grading. Incorrect completed answers are not retried, and completed trials are skipped on resume. A grader failure stops collection and preserves its response; recovery cannot redraw that answer. Ctrl+C cancels active work. After a crash, inspect the journal and owned processes, then use `run --recover`; incomplete writes and live locks refuse recovery. Interrupted attempts consume their attempt and reserved timeout budget. A new `--output DIRECTORY` creates an independent rerun.

`summary.json` and `results.csv` derive from retained attempts. They report scheduled, completed, failed, interrupted and pending trials separately. All frozen tasks stay in the denominator reports. This apparatus does not approve a study, establish external model determinism, or replace personal semantic review.

## Analysis and research reports

Use **Analysis & report** to declare the cohort, primary population, primary denominator, rationale, planned comparisons and uncertainty before freezing. The population fields select all tasks, a study split, or an explicit task set; the applied ledger shows inclusion before freeze. Primary rates and contrasts use that selection while full disposition/resource tables retain every trial. See [primary populations and custom outcome verification](research-benchmark-populations.md). Typed count, rate, duration, proportion and event-time endpoints with their estimators and cluster bootstrap are described in [typed endpoints and estimators](research-benchmark-endpoints.md). Starter data is labeled qualification. Legacy, pilot, exploratory and confirmatory cohorts are explicit alternatives; choosing a label is not a registration or review receipt. Without a structured plan the report displays descriptive rates and leaves the primary endpoint undeclared.

The report package is written for a reader who has to judge the work and reproduce it, so it shows the study rather than only its numbers. `report.html` and `report.md` open with front matter, an abstract, the research question and design, and three method sections; then the results tables and the disposition figure; then a run walkthrough, the per-trial evidence, integrity and reproduction, limitations, and a reproducibility checklist. The method sections print, for each exemplar task, the composition tree with every node's bundle, version, parameters, digest and review status, the **complete compiled prompt verbatim**, and the character ranges that map each span of that prompt back to the node that produced it. Runtime appendices are shown as their own labelled blocks. Each condition shows the canonical request envelope, rebuilt by the same `collectionRequest` the runner calls; adapters name their credential environment variable and never its value.

Per-trial evidence carries the **verbatim model response**, the extraction result, the grade fields, and for native grading the expected and observed traces with the first divergence named. Blocks inside the report are capped at 4,000 characters and say so; the complete copies under `trials/<trialId>-<attempt>/` and `paper/` are never truncated. `execution-manifest.json` lists every one of those files.

The attribution section is rendered only from the `provenance.json` registry beside the project, and `ATTRIBUTIONS.md` is kept verbatim at `paper/ATTRIBUTIONS.md` and checked against the registry, never trusted over it. Four classes stay apart exactly as the registry classifies them: reused or adapted code, the only class that shows authors, source, revision, retained notices and adaptations; APIs the generated code is written against; newly generated code; and references that were reviewed or followed but contribute no code. A reviewed reference is never shown as copied source. The sentence that no reused or adapted code is recorded appears only when the registry lists none, and a blanket no-third-party-code claim beside a reused entry is named as contradicted. Without a registry the section says `Not declared`.

Every table in the report, results and prose sections alike, is introduced by one plain-language sentence saying what it shows, printed just before it; tables whose preview is only a link to their complete CSV keep the sentence too. The protocol section lists each qualification receipt the attempt journal holds, with a link to its retained report under `qualification-receipts/`. When there is none it says exactly why: a project that freezes no selected-input policy (`requirements.selectedInput`) journals no receipt, and `node cli.mjs qualify` writes `results/qualification.json` outside the journal, which the report does not read. For LEAN grading, each native grade records the container arguments the grader ran, with host paths and the container name as placeholders; `verify-native` rebuilds and checks that record, and the report prints container arguments and mounts only from those records, naming a run whose grades carry none. The integrity section summarises the export manifest: its digest, the files it binds and whether every runtime and pinned-input digest agrees with the frozen project, with the manifest kept at `paper/manifest.json`. `node cli.mjs analyze` supplies the `manifest.json` beside the project, and *Export research report* supplies the manifest of the export the page would write, so both render the same summary.

Two receipts written beside the journal are rendered only when they bind. `node cli.mjs qualify` writes `results/qualification.json`; `node cli.mjs verify-native` writes `results/native-verification.json`. `node cli.mjs analyze` reads both, passes them to the generator as the `qualification` and `nativeVerification` options, and embeds each in `results/evidence.json` together with the SHA-256 of its canonical bytes (`qualificationSha256`, `nativeVerificationSha256`); the Research page's **Import run evidence** keeps a receipt only when it names the frozen project (and, for native verification, hashes exactly the imported journal) and its recorded digest matches, drops any other by name in the status line, and passes the kept receipts to **Export research report** so the page and the CLI print the same bytes. The report prints each receipt under its digest and retains it at `paper/qualification.json` and `paper/native-verification.json`: item 6 gains a **Pre-collection qualification receipt** subsection after the journaled-receipt table (verified project and runtime binding, recorded environment, a per-check table whose interpreter-agreement column is recomputed from the receipt's own JavaScript and Python results, the receipt scope verbatim), and item 10 gains a **Native verification receipt** subsection that separates what the report verified (project, journal, attempt coverage, each reconstructed grade against the journal grade) from what the receipt declares (file digests, evidence status, limitations, scope). Without a receipt each subsection says `Not declared` and names the command that writes one; a receipt that does not bind is refused, never rendered.

The package is deterministic: the same frozen project and attempt journal always produce identical bytes. The generation time shown in the front matter is the **last timestamp in the attempt journal**, never the clock of the machine rendering the report, which is what lets the Research page's *Export research report* and `node cli.mjs analyze` agree byte for byte. Fields the frozen project does not carry print `Not declared` rather than a guess.

`report.mjs` is a pinned runtime file, so changing it changes the `runtimeSources` digest and therefore the identity of newly frozen projects; a project frozen before the change keeps its own archived generator and its original bytes. Adding a *new* runtime file would also change `project.runtimeFiles`, and with it every version-2 project identity, which is why these sections live inside `report.mjs` rather than in a module of their own.

Every condition reports responses meeting its frozen criterion over scheduled trials and over completed trials separately. Information studies label their criterion **Admissible**, meaning agreement with at least one declared reading on the frozen inputs. Other studies use **Passed**. Neither label proves universal correctness. Collection failures retain null scores and a transport-error disposition. A retained response that cannot be graded remains an apparatus error. Replicates have distinct trial identities; retries retain their original trial and selected-attempt identity. Task `factors` produce stratified tables. A task may declare `familyId`; a declared family cannot span development and held-out splits.

An optional paired family bootstrap resamples whole families with identical multiplicities in both conditions, preserving dependence among their variants and replicates. Supply an explicit family for every task; choose iterations, seed, confidence and multiplicity treatment prospectively. A single family or an empty sampled denominator produces an explanation instead of an interval. Intervals rely on independent sampled families and do not correct biased task selection.

```json
{
  "version": 1,
  "cohort": "qualification",
  "primaryDenominator": "scheduled",
  "rationale": "Explain the design, denominator and family definition here.",
  "contrasts": [{ "id": "first-second", "first": "first", "second": "second" }],
  "uncertainty": { "kind": "family-bootstrap", "seed": 872, "iterations": 2000, "confidence": 0.95 },
  "multiplicity": "none-descriptive"
}
```

Use `uncertainty: null` for descriptive tables. `multiplicity: "bonferroni"` adjusts the planned contrast intervals simultaneously. These procedures are available apparatus choices, not a selected analysis for the owner's study.

**Export research report** and `node cli.mjs analyze` use the same portable `analysis.mjs`, `conventions.mjs` and `report.mjs`. They generate `report.html`, `report.md`, `figures/disposition.svg`, `analysis.json`, `summary.json`, `conventions.json`, `results.csv` and complete CSV tables under `tables/`. The analysis artifact hashes the project, exact journal and derived summary. Corpus selection and coverage, information treatments, disposition counts, convention distributions and stratified results share that artifact. Long tables have explicit bounded previews; complete tables retain every row and zero count. Short task labels map to full frozen identities in the task table. Reports of replay conditions identify themselves as saved-response controls. Fixed retained evidence produces byte-identical GUI/CLI report files. The native runner also writes these files after each run.

The CLI independently rechecks retained custom-module scores before status, analysis or resume. The pinned grader must reproduce its pass/score values from the saved answer; a mismatch refuses the operation while preserving the original journal and process evidence. Verification uses bounded child processes, and cancellation waits for the owned grader to stop.

## Developer validation

Run `node --test tools/test/research*.test.mjs` after staging the matching capability payload, then the production build and renderer checks. `tools/test/fixtures/run-research-benchmark.mjs` exercises the actual Research view in a browser using isolated account/service fixtures. `tools/test/fixtures/qualify-research-benchmark-lean.mjs` executes deterministic cases in an explicitly pinned LEAN Docker image and retains native artifacts. These controls use synthetic reviewer identities only.

`tools/test/fixtures/qualify-research-benchmark-information.mjs` builds a fresh standalone export and repeats two admissible programs and the outside-set hidden baseline three times in the pinned native engine. It also checks tagged clarification, refusal and malformed responses. It retains source pins, exact native trace identities, run evidence and reports.

`tools/test/fixtures/qualify-research-benchmark-audit.mjs` repeats that native source experiment, seals its reference, refuses changed order/configuration artifacts and runs fresh exported audits under each of the three criteria. Constant-verdict command controls exercise agreement, disagreement, abstention, malformed outputs, unresolved references and collection failures. It verifies private request keys are absent and completed cases cannot be redrawn. These are apparatus controls, not external judge performance measurements.

`research-benchmark-observations.test.mjs` checks missing/zero/invalid metadata, completion and identity policies, failed transports, extraction, exact decimal costs, currencies, replay origins, retries, recovery, monotonic clocks, command/HTTP/module boundaries and fresh CLI/report parity. Accounting remains a collection-attempt module; it does not execute a workflow graph or infer its future stage resources.

`tools/test/fixtures/qualify-research-benchmark-observations.mjs` creates a fresh standalone project with synthetic collection metadata and real pinned LEAN grading. It repeats faithful and altered-quantity native programs, checks a no-program control, compares all report bytes and cancels a separate CLI only after observing its owned container running. It checks truncated timing spans, retained output and complete owned-container removal. The browser journey also authors accounting, pins an allocation convention, runs recorded envelopes and compares every GUI/CLI report file.

These bounded checks do not qualify the complete original LEAN-Bench lifecycle, options domain, optional workflow graph, complete requirement activation/mutation matrix, or the owner's counted research protocol. The [requirement registry](research-benchmark-requirements.md) supplies exact bindings, independent activation and wrong-reading witnesses, diagnostic shrinking and portable qualification reports. Version 2 interpreted-answer experiments require complete selected-input composition/readings qualification before collection. The ordinary requirement fields generate this plan from exact occurrence rosters, activation rules, hand assertions and wrong readings. Legacy and explicitly scoped development projects retain their applicable frozen policy. Generic domains can attach two source-pinned interpreter modules; LEAN keeps its built-in JavaScript/Python counterpart. Account draft storage has a bounded size; export a portable draft when a source archive exceeds it. Draft imports support up to 128 MiB.
## Nested experiment fields

Use [occurrence fields](research-benchmark-composition-fields.md) to vary separate
nodes inside the selected recursive task, build its corpus recipe and inspect the
complete qualification workload. Whole-branch choices also let you explicitly add
children or recursively build a different topology. The guide includes first-use steps and execution
profiles for experiments, saved-answer diagnostics and unfinished apparatus tests.

## Verify retained native artifacts

[Native artifact verification](research-native-evidence-verification.md) describes the separate command and Research import for checking saved LEAN candidate, configuration, process and raw observation bytes. It preserves ordinary journal inspection and reports, and creates no experimental admission or qualification.
