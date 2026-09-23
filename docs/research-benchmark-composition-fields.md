# Generate nested experiments from occurrence fields

The Research page builds a corpus from fields you fill in. Start with an actual
nested task in **Compose tasks**, then open **Corpus recipe → Prepare occurrence
fields**. Each path identifies one occurrence in that tree. Two occurrences of
the same bundle remain independently editable, including two Strategies beneath
different recursive Templates.

1. Supply a family identifier, split, construction rationale and seed. Related
   variants stay in one family and split; replicates remain repeated measurements.
2. Select an occurrence, enable its factor and name that factor. Add each desired
   choice, selecting a compatible bundle and entering its local parameter values.
   The initial roster enables no factors and expands no library automatically.
   **Keep child connections** varies that node while retaining its children.
   **Replace whole branch** lets you copy an existing branch or build a different
   tree. Select its bundle, fill its parameters, and explicitly fill every child
   by copying a source branch or building another nested branch. New child slots
   start **Not filled** and block recipe construction until you supply them.
3. Repeat for each independently varied occurrence. Parameters preserve numbers,
   booleans and strings: `0`, `false`, an empty string and the string `"7"` are
   distinct values. Required values must be supplied. Turning off **Include**
   omits the local override; bundle defaults and task variables may still apply.
   Changing a choice's bundle resets that choice's parameter
   fields to the replacement's declared values. Inspect them before proceeding.
4. Declare selection and coverage. **All** retains all eligible cases within the
   stated limit; **Seeded** samples deterministically; **Balanced** uses the
   existing greedy coverage rule. Marginal coverage requests every level of each
   factor. Pairwise coverage also requests every pair of levels across factors.
   A marginal quota can pass while a joint cell is empty. Inspect the full ledger.
5. Declare the expected-answer policy and its rationale. LEAN derives apparatus
   expectations through its existing semantic compiler. Generic fields require
   your explicit declaration that the base expected answer applies to every
   variant. If answers vary, author an advanced recipe with explicit expectations
   or a supported domain compiler. The platform cannot infer an arbitrary oracle.
6. Select **Build corpus recipe from fields**, inspect the recipe, then select
   **Generate corpus**. Generation replaces the task list and clears recorded
   responses. **Undo replacement** restores the prior draft. The export retains
   the exact recipe, generated cases and every candidate's selection or exclusion.
7. Inspect the complete control workload, then open **Qualification** and prepare
   controls for the generated design. Supply independent assertions, activation
   rules, local wrong readings and the applicable interpreter files. Generated
   structural coverage does not establish correct answers or exercised behavior.

Unfinished field values survive Save draft, Export draft and remounting the page.
Preparing again preserves that text. Changes to the source task, inputs, meanings
or runtime pins make its bindings stale. Use **Start fresh occurrence fields**
explicitly when adopting the changed source; Undo preserves the previous edits.
For LEAN input changes, derive the new draft expected observation before preparing
the new roster. That action preserves pending occurrence fields and invalidates
their old binding.

## Execution profiles

| Purpose | Fields and required evidence | What the result establishes |
| --- | --- | --- |
| Experiment with required controls | Explicit population, supported endpoint and dependence, complete source-bound controls, applicable reviews, bounded protocol and fresh executed qualification | Only the admitted experiment contract; native, provider and release gates remain separate |
| Recorded answer-key diagnostic | Actual saved responses with the owned supported grader and replay transport | Consistency of saved answers with their declared key; no independent oracle or fresh provider result |
| Test unfinished apparatus | Qualification cohort, explicit apparatus-development purpose, complete runtime pins and finite attempt/time budgets | Local command, module or grader behavior as unqualified development computations; scientific collection remains unadmitted |

After filling Protocol and Run & export, freeze the applied design. Read the
generated execution requirements. Export its runnable project and run
`node cli.mjs verify`, then the applicable qualification and run commands described
in that export. Import the matching evidence into Research to recompute its tables.
Changing the execution purpose cannot upgrade existing evidence into an experiment.

## Supported scope and limits

Local choices preserve the incoming role, node kind and exact child slot names and
roles. Whole-branch choices preserve the incoming role and fill the selected bundle's
complete child structure. A compatible Template may intentionally change child
evaluation order; inspect its wording, semantics and slot order. Local parent
replacements run before descendant edits. A whole-branch factor cannot overlap
another enabled descendant factor: include those alternatives explicitly inside
the branch or choose separate sibling factors.

Copies resolve the exact occurrence in the selected source task, including its
local values and children. Each generated copy has independent ownership and does
not follow another factor's edits. Building a branch resolves defaults and task
variables, then applies your local parameter overrides. Changing its bundle retains
children only where both slot name and required role match. Switching back to
**Keep child connections** is unavailable when it would discard authored children.
Construction follows canonical JSON bytes, even if a program constructed the source
using shared in-memory objects.

The recipe supports at most 4,096 candidate assignments before exclusions and 512
selected tasks. Coverage retains its existing rule/cell limits. Exceeding a limit
refuses the requested construction; levels are never silently truncated. Repeated
or semantically identical constructions remain visible as excluded aliases and
cannot manufacture independent tasks.
Each complete composition retains the existing 4,096-node, 2 MiB text and 8 MiB
path budgets and rendered occurrence limit. Copies count all expanded nodes.
No new depth limit is introduced. Invalid complete candidates retain their
construction exclusion and cannot satisfy the requested coverage.

Qualification currently supports 128 exact occurrence targets and 512 interpreter
cases. The operational starter has 17 nodes. Two independently binary factors can
produce four trees: 68 occurrence targets and at least 272 interpreter cases. Three
binary factors can produce eight trees: 136 targets and at least 544 cases. The
latter exceeds the complete qualification capacity. The page reports every target
and the blocker; a generated corpus is not thereby admitted. Runtime appendices
remain separate obligations.

For a topology example, vary the operational starter's root with `op-all-2`,
`op-all-3` and `op-all-4`. Explicitly copy its original `child1` and recursive
`child2`, then fill each added child with a compatible Strategy or Template. Copying
the original five-node Strategy into the added slots gives complete trees with
17, 22 and 27 nodes: 66 exact controls and at least 264 interpreter cases, plus
three runtime appendices. Shared cash and evaluation order still govern execution;
the number of nodes does not imply that every intended order executes.

This interface builds one family from a selected source task. Advanced recipes
remain necessary for multiple families, constraints, changed
inputs/expectations, or reading-aware information treatments. Source-bound judge
audits and generated resource experiments retain their dedicated fields and recipes.
They cannot be detached from their evidence contracts by these occurrence controls.
The actual paper and scientific design still determine which supported apparatus
is appropriate; a paper title does not supply a missing environment or observer.

## Build one corpus from several source families

Prepare the original tasks first. Each source task retains its own input, variables
and expected answer. Keep related variants under the same family identity. This
workspace accepts one source seed per original family; more complex relationships
still need an explicit advanced recipe.

1. Prepare the first task's occurrence fields and select **Use multiple source
   families**. The existing unfinished choices are retained. Supply the combined
   construction rationale, seed, selection limit and coverage policy above them.
2. Choose another live source task under **Source task to add**, then select
   **Add source family**. Fill that family's construction rationale, split,
   expected-answer policy and occurrence choices. Repeat before generating.
3. Use **Family to inspect and edit** to return to any retained family. Navigation
   preserves its raw text. Each family can use local or whole-branch choices.
   The workspace owns sampling and coverage; archived single-family policy values
   do not govern this combined recipe.
4. Build the corpus recipe and inspect its family declarations and factor mapping.
   Then generate once. Coverage is checked separately within every family, even
   when local factor IDs or choice names match. Pairwise coverage concerns pairs
   within the same family. Inspect all selection and exclusion rows.
5. Review the complete control workload and the primary analysis population.
   A development family and a held-out family do not establish two independent
   families in a held-out-only analysis. Generated cases remain subject to the
   existing qualification, review and execution requirements.

For example, two families with choices `x` and `y` each need four family-specific
coverage cells. Selecting `x` only from the first family and `y` only from the
second leaves two cells unmet. A combined selection limit of two cannot satisfy
this design's marginal quotas. The recipe assigns separate factor identities and
exports the original local-to-recipe mapping in `corpus/field-authoring.json`.
This file records declared historical source bindings and expected-answer policies;
it is authoring provenance, not independent qualification of those declarations.
Manual recipe edits must keep its family, path and choice mappings consistent.

The candidate budget is the sum of the families' candidate counts. The selected
limit, coverage bounds and complete qualification capacity apply to the combined
corpus. Adding families does not reset a budget or multiply scientific evidence.
Identical semantic cases across families remain excluded aliases.

Generation replaces live source tasks with generated tasks. The workspace retains
its selected source tasks and fields, including across a cold draft import. The
compiler still refuses to build from missing or changed live sources.

To edit again, select **Export editable family sources**, then import the downloaded
`-family-sources-draft.json` file separately. Export leaves the current experiment,
evidence, saved draft and Undo unchanged. The new draft contains the exact retained
source tasks and raw family fields with the current applied catalog, input files
and settings. It is an editable derivative, not a complete historical project or
an evidence backup. Apply other pending editors before exporting; generated-task
editor buffers are excluded from the derivative so they cannot overwrite a source.

The file clears both ordinary and workflow recorded responses, retains old corpus
recipes as history, and marks the family fields pending. Inspect the fields, build
the recipe and generate again before Freeze. Old source bindings are preserved:
changed catalog, input or apparatus bytes still require an explicit field reset.
An archived task that was itself generated keeps that provenance while awaiting
the new generation. Applied analysis, workflow and requirement plans are retained;
resolve their stale task references explicitly. Export grants no fresh review,
qualification, population eligibility or execution admission.

**Undo replacement**, when available, can restore the preceding page draft after
Import. Undo is local to this page's in-memory history and does not survive a cold
restart. Save the separate source file when you need a portable editing path.

If a live source changes, **Replace selected family with its current source**
explicitly resets that family's fields; other families and the global policy are
retained. **Return to single-family fields** restores the archived local policy
text and has a page-local Undo. No mode switch silently replaces an unfinished
value or promotes a source capsule into current evidence.
