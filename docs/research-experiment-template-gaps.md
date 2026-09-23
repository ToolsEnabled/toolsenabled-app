# Experiment templates: gaps in rigorous defaults

This is an implementation assessment, not a paper-writing feature. The intended
workflow is: the investigator fills scientifically meaningful fields; a qualified
template generates the experiment source, control cases, allocation, execution
machinery and analysis. The exported experiment must enforce those contracts
without depending on the Research renderer. Expert JSON and source inspection
remain available, but cannot substitute for the generator doing the work.

The current page and portable runtime have substantial reusable components:
recursive task composition, frozen source/input bindings, explicit alternative
readings, corpus selection, workflow stages, accounting, requirement witnesses,
selected-input gates, durable attempt recovery, native LEAN observation and
reproducible result artifacts. They do **not yet make every generic experiment
rigorous by default**. The version 2 readiness contract enforces the implemented
designs and exposes unsupported capabilities. This assessment distinguishes those
current guarantees from the broader experiment designs still to be implemented.

## Implemented contracts and their scope

The primary-population field now generates a resolved frozen roster used by
headline rates and contrasts. Unsupported analysis fields reject. Complete
custom-grade JSON is checked against retained raw output in the shared journal
verifier, and the CLI reruns the pinned grader before accepting stored results.
Meaningful controls exercise the rank reversal and altered outcome categories.
See [the implemented contracts](research-benchmark-populations.md).

The follow-up adversarial review also found fresh direct API callbacks could
mark a grade completed before its receipt was checked, and object-valued
classification fields could collapse distinct outcomes into one report key.
New results now pass the shared verifier before completion; classification is
bounded nonempty text. Receipt availability is counted explicitly in Research
and reports. Removing a receipt cannot retain a stronger evidence-availability
claim, although these portable records do not authenticate their origin.

The **Resource action plan** starter now implements a bounded non-trading
experiment template. Its case, family, split, instruction, resource, goal,
visibility, permission, action-budget and primary-criterion fields generate the
prompts, public inputs, private packets, reference plans and control plans.
Unapplied fields block freezing; invalid text survives draft saves and remounts.
Regeneration checks the derived artifacts against the recipe and refuses
incompatible authored comparisons. The investigator does not have to author a
custom executor, observer or answer key for this supported design.

The generated contract requires source-bound qualification before new candidate
collection. It executes fixed controls with independently specified expectations
and controls for the actual generated cases. A generated control plan alone is
not a qualification receipt. Successful preparation checks task success and no
collateral change for every reference plan, and retains applicability reasons
when an additional case control cannot fit the resource universe or action
budget. Preparation failures dispatch no candidate request.

After the response is durably retained, trusted host code initializes a fresh
finite resource map and applies its declarative plan. Intent and independent
state observations surround each permitted atomic action. A separate array-based
verifier reconstructs transitions and all reported effect fields from the raw
plan and fixture, without calling the mutable executor. Imported evidence must
match those semantics and its source, packet and event bindings. Incomplete
prefixes remain distinct from complete endpoints and cannot become zero effects.

This lifecycle also persists preparation time across invocations, bounds
preparation receipts and evidence volume, and forbids automatic retries after
uncertain resource effects. The supported primary endpoint is a named binary
criterion with an explicit population and scheduled-trial denominator. Resource
sets and counts remain descriptive secondary outcomes. See the
[resource template contract and workflow](research-benchmark-resource-template.md).

These are enforced guarantees for one template. The generic task path permits
investigator-authored answer keys in explicitly scoped diagnostics or apparatus
development. A new version 2 experiment additionally requires distinct pinned
interpreters, complete selected-input composition controls and fresh executed
preparation; an authored key alone cannot admit collection. Other environment,
assignment and outcome designs still need qualified generated contracts. The
resource implementation does not establish that every existing experiment type
has those guarantees, or satisfy any outstanding native or release gate.

Implementation boundaries are explicit in the
[template compiler](../src/benchmark/templates.mjs),
[executor and independent verifier](../src/benchmark/resource-effects.mjs),
[runner lifecycle](../src/benchmark/runner.mjs) and
[resource analysis](../src/benchmark/analysis.mjs). The
[experiment field editor](../src/research-resource-template.js) supplies the
typed authoring surface used by Research.

## Retained counterexamples and current disposition

The independent Astra / Max reviews executed only small synthetic saved-response
or local module controls. No providers, personal study or external experiments
were used. Reproductions and exact source bindings are retained in the activation
stage's `review-reproductions/` evidence directory.

| Retained counterexample | Scientific consequence | Current disposition |
| --- | --- | --- |
| A generic task asking for `2 + 3` can declare `999` as its expected answer and pass a saved `999` response without qualification. | The executable package can validate its own incorrect answer key. | Version 2 experimental collection now refuses an authored key alone: complete composition controls, distinct pinned interpreters and fresh preparation are required. Recorded diagnostics and development retain their weaker declared scope. Resource-template answers come from fixture goals and require executed controls. Neither source diversity nor agreement authenticates scientific independence. |
| `analysisPlan.primarySplit: "held-out"` was accepted but ignored. | A field appeared frozen while having no effect. | Fixed: unsupported analysis fields reject. Supported primary-population fields resolve into the frozen roster and analysis. |
| Pooled development and held-out tasks reversed a condition ranking: +0.8 overall versus −1 on held-out tasks. | The primary result answered the wrong generalization question. | Fixed for a declared primary population: groups and contrasts use its resolved roster; all-trial dispositions remain separate. Resource templates require that declaration. Legacy no-plan behavior remains available. |
| An altered custom-grade `classification` survived rechecking that compared only `passed` and `score`. | An unchecked field changed reported outcome categories. | Fixed: complete scientific grade output is rechecked; process-receipt availability is reported separately. This is consistency checking, not record-origin authentication. |
| Identical conditions sharing a mutating environment yielded 0.5 versus 0 from carryover alone. | Exposure order and persistent state confounded the comparison. | Resource trials now own fresh post-response state and observed closure. Arbitrary command/module environments do not inherit that guarantee and are refused by this template. Intentionally shared environments remain unsupported. |
| Successful qualification preparation was charged only to the current invocation. | Repeated invocations could exceed a cumulative preparation budget. | Resource preparation has durable cumulative charges and a count bound. Selected-input preparation now also records a durable intent and paired measured completion/failure through bounded settlement, enforces cumulative charges and bytes, and reserves orphan recovery time without allowing further collection. Legacy missing timing stays unavailable in read-only reports and cannot authorize continuation. |

The adversarial review also reproduced contradictory witness-shrink metadata
accepted as deletion-minimal. The selected-input implementation now reconstructs
the candidate sequence, verifies raw independent comparisons and digests, and
requires verified failed single-element deletions before accepting that claim.
The retained pre-fix reproduction remains diagnostic evidence.

The previously identified resource-preparation gap is also closed in the current
runner. Resource conformance writes a durable intent before work, pairs a terminal
receipt and measured charge, and requires explicit orphan recovery before further
preparation. Recovery charges the full reservation while retaining unknown elapsed
time. Resource controls own only a fresh in-memory map; selected-input interpreters
can leave owned processes requiring inspection and retain their stricter recovery
rules. These are distinct execution scopes with explicit cumulative accounting.
See [the current readiness and preparation contract](research-execution-readiness.md).

## Fields must generate and enforce the apparatus

The common contract must express the following areas. Resource v1 supplies one
concrete implementation; the remaining work is to make other supported designs
equally executable from fields, rather than delegate missing mechanics to an
open-ended custom adapter.

| Investigator fields | Resource v1 mechanism | Remaining reusable contract |
| --- | --- | --- |
| Scientific unit, population, split policy, endpoint and weighting | Case/family/split fields, resolved primary roster, one named binary criterion and scheduled denominator | Typed estimands and compatible weighting/missingness policies for other endpoint and sampling designs |
| Treatments, assignment unit, blocks/pairs, replicate unit and seeds | Existing condition/replicate schedule and optional paired family-bootstrap rate contrasts | Generated allocation ledgers and analysis for nested, crossed, shared-environment or sequential assignment units |
| Environment, initial fixture and reset boundary | Fresh bounded map per response; complete initial state and per-action snapshots; discarded state after closure | Qualified environment plugins with explicit reset, cleanup, ownership, observation timing and interference groups |
| Public inputs, private references and allowed capabilities | Visible-input projection; set/delete permissions independent of intended goals; recorded responses or HTTPS collection without tools | Enforced isolated execution surfaces for interactive/local candidates and proof of what each observer can see |
| Outcome definitions, units, direction, window and aggregation | Goal satisfaction, ever/final changed-resource sets and ever/net/peak collateral measures over observed atomic actions | Typed count, continuous, event-time, severity and exposure-denominator endpoints with compatible estimators |
| Positive/negative controls and activation requirements | Fixed semantic controls plus actual-case references and applicable no-op/collateral/repair controls, verified before collection | Capability-specific qualifications and a common readiness model that distinguishes design validity, executable host support and collection eligibility |
| Retry policy, uncertain effects, recovery and budget scope | One attempt, durable intent/effect/closure, retained partial prefixes, halted redraw and cumulative preparation charges | Reconciliation/reset rules before any supported repeated intervention; consistent budget contracts across template families |

A task family is currently the bootstrap cluster. That supports a specific paired
family design; it does not represent arbitrary environment/episode/deployment
hierarchies or crossed dependencies. Likewise, a sequential acyclic prompt
workflow is useful but is not a general concurrent experimental process. Add
finite, qualified assignment/process/analysis templates with explicit capability
requirements. Do not silently reinterpret unsupported designs as ordinary rows.

## What the non-trading template proves, and what it does not

Resource v1 proves that a non-trading template can generate and enforce its own
apparatus from investigator fields. The supported universe is at most 32 cases,
32 string-valued resources per case and 32 actions per plan, subject to tighter
byte and evidence bounds. Resource identifiers are logical names, not filesystem
paths. The template has no resource graph, background process, remote service,
tool loop or persistent/shared state. It explicitly refuses unsupported adapter
and study combinations instead of treating them as ordinary resource trials.

Success and unintended effects must be distinct measures. For example, distinct
affected resources, repeated events, transient maximum scope and final repaired
state are different quantities. Templates must implement the selected definition
and retain its observation window and denominator. A field label alone is not a
measurement implementation. Resource v1 implements distinct ever-changed,
final-state and peak simultaneous collateral measures. A changed-then-restored
neighbor therefore has nonzero ever collateral and zero final collateral. A
same-value write is a permitted observed action but causes no observed state
change; a denied action is a rejected attempt, not an observed mutation.

The following design boundaries still matter when qualification passes:

* **Meaning of damage.** Collateral means a state change to a resource outside
  the goal-resource set. A harmful intermediate change to a goal resource is
  recorded in its state history and ever-changed set, but is not collateral.
  Resource weights, propagation, confidentiality loss, latency, monetary cost
  and severity need their own typed observers and units. Calling the existing
  count “damage” would silently choose an unsupported semantic interpretation.
* **Choice of success criterion.** A valid empty plan can pass “no collateral
  effect” while failing the task. That is the selected criterion's meaning;
  “task success without collateral effect” answers a different question. If a
  goal is already satisfied initially, a no-op control can also succeed. Control
  applicability and observed outcomes must be inspected, rather than assuming
  that every no-op is a negative control or every generated reference proves
  an informative treatment contrast.
* **Sequential intervention and interference.** The model returns one plan
  before the map exists. It receives no intermediate observations and cannot
  adapt its next action to state changes. Two agents acting on a shared service,
  an intervention whose effect appears later, or a reset that can fail require
  different generated lifecycle and observation contracts. A sequence of atomic
  plan actions is not evidence for those designs.
* **Inference and baselines.** A fresh map prevents this executor's carryover;
  it does not establish independent model randomness, representative task
  sampling or independent deployment environments. Repeated replay responses
  are not new sampled outcomes. The generated reference and collateral plans
  qualify measurement mechanics; they are not automatically appropriate system
  baselines or causal counterfactuals. Those choices need typed assignment and
  comparison contracts. Effect magnitudes currently support descriptive tables,
  not count/continuous-outcome inference.
* **Private information and evidence trust.** Hidden fixture values and reference
  plans are omitted from the public request; investigator exports still retain
  them. Ordinary local command/module candidates could access private files and
  are therefore unsupported. HTTPS collection declares a fresh request and
  checks reported identity/completion; it does not authenticate a provider's
  internal context, session isolation or identity. Source and journal checks
  establish reproducibility and consistency, not evidence authorship.

The exact paper called “Blast Radius” was not identified in the authorized
project sources. Resource-effect examples here are hypothetical capability tests,
not claims about that paper's methods. Its actual design must be mapped once the
reference is available. The platform should support it through reusable design,
environment and outcome modules, without hardcoding a paper title or trading
roles into the generic core.

The generic core should require a resolved population, declared assignment and
dependence units, typed endpoints, evidence provenance, budget/missingness rules
and derived readiness. Domain or environment plugins should supply field schemas,
deterministic compilation, owned execution/reset, independent observers and
source-bound conformance controls. A plugin is ready only when those capabilities
are actually present and qualified for the generated study. Resource v1 is one
such fixed profile, not yet a general capability-composition system.

## Implementation priority

1. Implemented: reject ignored analysis fields, resolve the primary population,
   and reverify complete scientific custom-grade output through the supported
   process/evidence paths. Keep the retained counterexamples as regression controls.
2. Implemented for resource v1: typed investigator fields, deterministic template
   compilation, generated controls, enforced precollection qualification, owned
   state, independent observations, complete/prefix verification and portable
   analysis. Preserve its narrow execution and inference claims.
3. Implemented for the supported version 2 profiles: common source-bound readiness,
   explicit population/design, complete interpreted-answer controls, distinct generic
   interpreters, fresh preparation and durable resource/selected-input accounting.
   Diagnostics, legacy evidence and apparatus development retain separate scope.
   Native candidate experiments still require an implemented native admission
   mechanism and the original source/image/data/observer/control gates. Existing
   native apparatus development is not that admission. See
   [current execution readiness](research-execution-readiness.md).
4. Add typed assignment, endpoint and process families with independent controls
   and consistent standalone/GUI execution. Qualify any real environment or
   interactive-agent plugin before exposing fields that promise its behavior.

Personal semantic choices and real external collection remain investigator
responsibilities. The platform should handle mechanics and enforce supported
contracts; it must not manufacture scientific approval or claim that an
unsupported experiment became rigorous because its files were hashed.
