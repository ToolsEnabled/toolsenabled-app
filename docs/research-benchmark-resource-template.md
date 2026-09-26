# Resource experiment fields and execution

The resource action-plan template generates executable experiment apparatus from investigator fields. It is a finite environment for studying whether a returned action plan achieves a task and what else it changes. The platform supplies the compiler, fresh state, action executor, controls, observer, journal and analysis. Investigators supply the task universe, intended changes, systems and study design.

## Enter and freeze the design

Choose **Resource action plan** in **Compose tasks**, then use **Experiment fields**. Each case has an identifier, task family, development or held-out split, instruction, initial resources and intended goals. A resource has an identifier, string value, visibility and write permission. A goal sets a value or deletes a resource. Goals must refer to visible, writable resources; other writable resources define observable collateral scope. A permitted action can therefore be outside the intended task.

Choose task success, no collateral effect, or task success without collateral effect as the binary primary criterion. Choose the maximum number of actions per returned plan. Apply with **Generate experiment from fields**. The compiler generates task prompts, public inputs, private packets, reference plans and control plans together. Manual changes to generated artifacts refuse verification unless they exactly reproduce the recipe. Private initial state and reference answers stay outside the public collection request.

The starter includes recorded reference and applicable collateral plans. These establish that the apparatus distinguishes known outcomes. Declare actual comparison conditions and the intended study population before interpreting runs as system evidence. The **Protocol**, **Accounting** and **Analysis & report** fields retain their existing roles. Primary analysis requires an explicit population and counts all scheduled trials in it; incomplete observations are not removed from that denominator. Related tasks cannot cross family splits. Effect counts are descriptive secondary observations, not a general continuous-outcome estimator.

Unapplied edits block freezing. Draft saves retain those edits. Regenerating fields updates generated controls; incompatible authored comparisons refuse with an explanation. Field generation and freezing establish a consistent design. Execution qualification is a separate mandatory step before collecting new responses.

## Execute and observe

Each trial collects one JSON action plan. The supported operations are `set` and `delete` on the fixed resource universe. The host retains the response before initializing a fresh in-memory map, records an intent before each mutation, and records the resulting state after it. Unknown resources, read-only mutations, invalid operations and malformed plans are explicitly rejected. A rejected plan does not become a successful empty plan.

The observer records task success, resources ever changed, final changed resources, resources ever changed outside the goals, final collateral changes and peak simultaneous collateral count. Changing an unrelated value and later repairing it still counts as an ever-observed collateral effect. A no-op write does not become a state change. Attempted rejected actions remain distinct from observed effects.

An independent replay checker reconstructs expected transitions and grades from the raw plan and initial fixture. It does not call the mutable executor or its action validator. Imported and retained journals must match this reconstruction, source and packet hashes, trial bindings, ordering and closure. These checks establish evidence consistency; they do not authenticate who produced an imported record.

Before the first new trial of every run invocation, the runtime executes fixed hand-expected controls and generated controls for the actual cases. The first successful invocation retains one full source-bound proof. Subsequent successful preparations rerun those controls and retain a compact receipt bound to the same proof, avoiding repeated large proof copies. A failed preparation dispatches no candidate request and records its reason and time charge.

Recorded responses run in Research or the exported CLI. External collection uses the declared HTTPS public request, with no tools, a complete-generation policy and matching reported identity. Reported identity is not provider authentication. Local command/module candidates, arbitrary code, interactive agents, external effects and shared or persistent environments require other supported execution contracts.

## Bounds and interrupted evidence

Recipes allow at most 32 cases, 32 resources per case and 32 actions per plan. Values are bounded at 256 UTF-8 bytes, fixtures at 16 KiB and instructions at 4,096 UTF-8 bytes. A conservative 16 MiB evidence estimate can impose tighter limits on a particular combination of cases, actions, conditions and replicates. Freeze refuses an oversized design. Collection also enforces response and cumulative journal byte limits, cumulative preparation and trial time, and at most one more preparation receipt than scheduled trials.

There is one attempt per trial. Completed resumes add no request or effect. Interrupted, cancelled or failed resource episodes halt the frozen study without redrawing the response. Partial observed prefixes remain available with incomplete endpoints unscored; they do not establish that no further unobserved effect occurred. A persistence failure retains recovery protection. The CLI refuses to recover an orphan by recollecting a response already present on disk.

## Portable outputs

The project includes `templates/recipe.json`, `templates/contract.json` and each case's packet, public input, reference plan and controls. The same pinned runtime serves the browser and standalone CLI. `verify` checks the project and generated artifacts; `run` performs mandatory preparation and collection; `status` and `analyze` verify retained evidence without rerunning effects. Export the run's raw evidence as well as its report.

Reports retain the complete journal, qualification proof, preparation time charges, resource-effect rows and any partial observation prefixes. Primary-population accounting remains separate from all-trial descriptive tables. HTML, Markdown, JSON and CSV outputs are generated by the shared report implementation and tested for exact GUI/CLI parity.

This template supports bounded resource-state experiments. It does not establish operating-system or service containment, interactive tool behavior, population representativeness, authenticated model identity, or an arbitrary paper's methodological adequacy. Further template types need their own generated execution, reset, observation and qualification contracts.
