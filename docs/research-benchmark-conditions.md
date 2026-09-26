# Conditions and requested model settings

In Research → Benchmark builder → Protocol, **Prepare condition fields from current setup** opens a field view of the current condition roster, workflow assignments and accounting. Preparation leaves the applied experiment and current results intact. It does not contact an endpoint. Existing Conditions, Workflow and Accounting JSON remain the advanced editing path.

For two external model conditions:

1. Enter a new condition ID, choose **HTTPS frozen-request endpoint**, and add the condition. Fill its endpoint, requested provider and model ID. Optional identity fields have explicit inclusion controls.
2. Include model settings and add each key with its type and value. Numeric `0`, boolean `false`, null and the string `0` remain different values. Array and object settings use JSON only for that value. Blank or unfinished numbers remain errors until completed.
3. Fill system/developer instructions, or explicitly choose null. Inspect the displayed model comparison, empty tool list and requested context boundaries. An assigned existing workflow supplies its actual stage instructions and projections.
4. Select **Use required external experiment checks** and inspect the identity/completion policies and response paths. These compare reported provider/model identity and require a reported complete generation. They do not invent a reported identity or interpret arbitrary provider finish reasons.
5. Add another condition, or explicitly duplicate configuration under a new ID and edit its requested model/settings. Duplication clears the duplicate's recorded outputs; it leaves the original condition unchanged.
6. Inspect **Preview generated setup**, including any proposed accounting plan and condition-specific overrides. Then select **Apply condition setup**. The complete condition roster, assignments and accounting are validated together. Freeze afterward to inspect the independent qualification and other execution requirements.

The HTTPS endpoint must accept the exported canonical frozen-request JSON and return a JSON object containing `output`. A provider's native chat endpoint may use a different protocol. The form does not translate a vendor API, authenticate model settings, send a test request or establish actual session isolation. Credentials are referenced only by environment-variable name; the values belong in the run environment.

Requested identity/settings and returned reports remain separate. Editing one condition's checks writes deliberate overrides for that condition. Shared accounting policies, sibling overrides, usage/cost mappings and estimates remain intact. An explicit first-plan setup shows its proposed mappings in the preview. Missing usage or cost stays unavailable; recorded envelope metadata describes saved responses.

Recorded conditions offer omitted output mode, explicit output mode and envelope mode. Supply your own task response maps. Existing workflows additionally need envelope mode and an explicit task/stage map. Initializing an empty map supplies no stage response; dispatch still fails until the required fixtures exist. Removing a workflow also requires explicit removal of its obsolete stage map. See [workflow setup](research-benchmark-workflows.md) for the shared stage contract.

Existing condition IDs are read-only in the ordinary form. Renaming requires coordinated expert edits to their references. Removal names blocking planned comparisons or last workflow assignments. The form retains advanced collectors and unsupported imported model/tool declarations exactly; use expert JSON for those configurations. It never upgrades their schema, purpose or execution capability.

Unfinished field text is saved with the draft and retained through export/import. Changing the source setup after preparation makes the field draft stale. Prepare again explicitly to replace it from the current JSON; the previous draft is available through Undo. Failed Apply preserves its starting applied state and raw text. Successful Apply invalidates prior frozen results through the normal edit path. Undo restores the preceding draft and its pending text, without claiming to restore measured evidence from before edits.

After the first Freeze and runnable export, you can return to unchanged condition fields and edit the next configuration. The builder carries pristine fields across its initial runtime source binding. Changes to already declared source pins, study or review content, and expert editor text still require explicit preparation. Apply any pending field edits before freezing again.

These fields author an experiment configuration. They do not write a paper, supply scientific approvals, qualify an answer key or establish provider/native execution evidence.
