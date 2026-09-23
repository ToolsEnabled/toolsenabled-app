import { el } from './components.js'
import { createReviewRecord, canonical, compilePrompt, invariant, object, reviewStatus, sha256 } from './benchmark/prompts.mjs'
import { slotAccepts, slotRoleText, slotRoles } from './benchmark/composition.mjs'
import { benchmarkForDomain, declaresPageField, gradingKindsForDomain, isRegisteredDomain, offeredGradingKinds, pageSurfaceForDomain, registeredStarters, starterById } from './benchmark/registry.mjs'
import './benchmark/plugins.mjs'
import { analyze, bindRuntimeSources, freezeStudy, materializeCorpus, normalizeStudyVersion, prepareStudyReview, runtimeFilesFor, safePath, STUDY_VERSION_RULES, studyVersionProblem, summaryCsv, validateStudy, modernSchema, SUPPORTED_SCHEMA_VERSIONS } from './benchmark/study.mjs'
import { runStudy, validateJournal, verifyResourceJournal } from './benchmark/runner.mjs'
import { genericStarter, newExperimentDraft } from './benchmark/starters.mjs'
import { evaluateReadiness, assertCollectionAdmission } from './benchmark/readiness.mjs'
import { materializeExperimentTemplate } from './benchmark/templates.mjs'
import { createResourceTemplateEditor, defaultResourceTemplateFields } from './research-resource-template.js'
import { createRequirementFieldsEditor } from './research-requirement-fields.js'
import { createCompositionFieldsEditor } from './research-composition-fields.js'
import { createCompositionFamilyEditor } from './research-composition-families.js'
import { createCompositionFamilySourceDraft } from './research-composition-source-draft.mjs'
import { applyWorkflowSetup } from './research-workflow-setup.mjs'
import { resetRecordedResponses } from './research-recorded-responses.mjs'
import { alignLeanCanaryResponses, leanCanaryNote } from './research-lean-canary.mjs'
import { layerMap } from './research-layer-map.mjs'
import { createConditionFieldsEditor } from './research-condition-fields.js'
import { createEndpointFieldsEditor, endpointRowsFromPlan, endpointsFromRows } from './research-endpoint-fields.js'
import { createDesignFieldsEditor, designRowsFromPlan, designPlanFromRows } from './research-design-fields.js'
import { addConditionFieldsRow, createConditionFieldsDraft, compileConditionFields, conditionFieldsBinding } from './research-condition-fields.mjs'
import { createDefaultNode, replaceNodeBundle } from './research-node-editing.mjs'
import { informationFieldInventory, createInformationFieldDraft, compileInformationFields } from './research-information-fields.mjs'
import { createInformationFieldsEditor } from './research-information-fields.js'
import { requirementFieldInventory, createRequirementFieldDraft, compileRequirementFields } from './benchmark/requirement-fields.mjs'
import { generateLeanTasks } from './benchmark/lean.mjs'
import { attributionsMarkdown, bindLeanReview, generateLeanProgram, inlineLeanProgram, provenanceDocument } from './benchmark/lean-codegen.mjs'
import { projectFiles, zipFiles } from './benchmark/export.mjs'
import { ARCHIVE_LIMITS, unzipFiles } from './benchmark/archive.mjs'
import { readExportedProject } from './benchmark/exported-project.mjs'
import { COHORTS, resolveAnalysisPopulation, validateAnalysisPlan, validateDesignPlan } from './benchmark/analysis.mjs'
import { boundReceipts, researchPageSections, researchReportFiles } from './benchmark/report.mjs'
import { methodMarkup, runMarkup } from './research-benchmark-walkthrough.js'
import { observationContract, observationPlanFromSpec, validateObservationPlan } from './benchmark/observations.mjs'
import { validateRequirementPlan, validateNativePreparationPlan, selectedInputGate, verifyQualificationJournal } from './benchmark/requirements.mjs'
import { applyWorkflowDraft, workflowDraft } from './benchmark/workflow.mjs'
import { corpusPlanFromTask, compositionFieldInventory, createCompositionFieldDraft, compileCompositionFields, compileCompositionFamilyFields } from './benchmark/corpus.mjs'
import { createPromptSetEditor } from './research-prompt-set.js'
import { createProtocolEditor } from './research-protocol.js'
import { createPipelineEditor } from './research-pipeline.js'
import { generatePipeline, pipelineSettings } from './research-pipeline.mjs'
import { decidedCount, decisionsText, emptyProtocolDecisions, matchesDecisionsText, normalizeProtocolDecisions, previousProtocolEntries, settingsCount } from './research-protocol.mjs'
import { preparePromptSet, promptSetBinding, promptSetSources } from './research-prompt-set.mjs'
import { compileTask, deriveTaskExpected } from './benchmark/tasks.mjs'
import { operationalStudy } from './benchmark/trading-study.mjs'
import { generateOperationalTasks } from './benchmark/trading-catalog.mjs'
import { createTaskReviewRecord, informationPlanFromTask, taskReviewStatus, validateInformation } from './benchmark/information.mjs'
import { NATIVE_EVIDENCE_LIMITS, verifyNativeJournalEvidence, materializeNativeControl, auditFileBytes, auditFileText, auditReferencePaths, auditReviewStatus, auditStudyFromReference, createAuditReviewRecord, materializeAudit, sealAuditReference } from './benchmark/audit.mjs'
import { createBenchmarkStore } from './research-benchmark-store.js'
import { snippetTitle, snippetLabels, snippetChoice, snippetMetadata, filterSnippets, exportSnippetLibrary, importSnippetLibrary } from './research-snippets.mjs'
import { exampleExperimentDrafts, isExampleSnippet, loadExampleSnippets } from './research-examples-lazy.mjs'
import { createRoutingDraft, routedTasks, expandComposition } from './research-routing.mjs'
import { createRoutingEditor } from './research-routing.js'
import { createCompositionGenerator } from './research-composition-generator.js'
import { compositionGenerationBinding, previewCompositionGeneration, saveGeneratedCompositions } from './research-composition-generator.mjs'
import { createNestingEditor } from './research-nesting.js'
import { buildNesting, previewNestingRun, saveNestingRun } from './research-nesting.mjs'
import { createVarianceEditor } from './research-variance.js'
import { varianceInventory, buildVarianceStudy, saveVarianceLibrary, materializeVarianceTasks, snippetText, previewVarianceRun, saveVarianceRun } from './research-variance.mjs'
import { frozenInspectionMarkup, nativeVerificationMarkup, runJournalMarkup } from './research-benchmark-journal.mjs'
import './research-benchmark.css'
import './research-snippets.css'

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
// Authoring starts empty. Examples and another project's content enter only
// through an explicit starter or import; an unfinished draft need not run yet.
const emptyDraft = () => {
  const draft = newExperimentDraft(genericStarter(), { initializePopulation: true })
  return { ...draft, name: 'Untitled benchmark', catalog: [], tasks: [], conditions: [],
    analysisPlan: null, decisions: '', environment: { node: '>=22', dependencies: [], instructions: '' } }
}
const json = value => JSON.stringify(value, null, 2)
const parse = (text, label) => { try { return JSON.parse(text) } catch { throw new Error(`${label} must be valid JSON. Your text is still in the editor.`) } }
// A slot name and a composition role are the person's own words. The page
// only makes them readable; it keeps no table of names it recognises, so a
// library written in any vocabulary reads the same way as the one this
// product happens to ship an example of.
const roleName = role => String(role ?? '').replace(/[_-]+/g, ' ').replace(/^\p{L}/u, letter => letter.toLocaleUpperCase())
/* PROMPT B. A place may accept one role or several, so the attribute that
   carries it round-trips both. A plain name stays a plain name; a set travels
   as JSON, which is the only shape that cannot be confused with one. */
const roleAttribute = role => (Array.isArray(role) ? JSON.stringify(role) : String(role))
const roleFromAttribute = value => (typeof value === 'string' && value.startsWith('[') ? JSON.parse(value) : value)
const option = (value, label, selected) => `<option value="${esc(value)}"${selected === value ? ' selected' : ''}>${esc(label)}</option>`
const executionOperation = project => project?.spec.executionPlan?.purpose === 'experiment' ? 'collect' : project?.spec.executionPlan?.purpose === 'apparatus-development' ? 'apparatus-development' : 'diagnostic-replay'
// Readiness is derived per operation, and a project is refused or admitted separately for
// each one. The page used to evaluate only the operation its declared purpose maps to, so a
// Lean Bench study showed one requirement and hid the other thirteen. These are the three
// operations evaluateReadiness accepts, in the order `node cli.mjs verify` reports them.
const READINESS_PURPOSES = [
  { operation: 'apparatus-development', label: 'Apparatus development', available: 'Apparatus testing is available. These outputs and analysis computations remain unqualified development evidence.' },
  { operation: 'collect', label: 'Collect (experiment)', available: 'Design eligible for its required preparation. Fresh executed controls are still required before collection.' },
  { operation: 'diagnostic-replay', label: 'Diagnostic replay', available: 'Canonical recorded diagnostics are available. Agreement with an authored answer key does not independently qualify the key.' }
]
// What a refusal means for the person reading this page: a field they can change here, or
// work this page cannot do at all. The generated message is always shown verbatim beside
// this line; these never replace it, and an unlisted code still shows its own message.
const BLOCKER_GUIDANCE = {
  'replay-response-not-a-program': 'Change here: record one Python program as this condition’s saved response, or grade the study as JSON.',
  'native-admission-unavailable': 'Not available in this page: nothing here admits native candidate collection. Run the exported project with the commands below.',
  'collector-unsupported': 'Not available in this page: it dispatches recorded replay only. Command and module adapters run in the exported runner below.',
  'recorded-responses-required': 'Change here: recorded diagnostics replay saved responses only. Remove the external, command and module conditions.',
  'diagnostic-grader-unsupported': 'Change here: recorded diagnostics use the built-in exact, JSON, judge and resource graders; a native grader cannot be replayed.',
  'diagnostic-purpose-required': 'Change here: choose the recorded-diagnostic execution purpose.',
  'development-purpose-required': 'Change here: choose the apparatus-development execution purpose.',
  'experiment-purpose-required': 'Change here: choose the experiment execution purpose. A cohort label cannot stand in for it.',
  'experiment-design-required': 'Change here: declare this experiment’s schedule, outcome and dependence design.',
  'collection-controls-required': 'Change here: declare this condition’s model comparison, exact instructions, no-tools boundary and request freshness.',
  'reported-identity-required': 'Change here: require the provider and model id the run reports back. This is not provider authentication.',
  'reported-completion-required': 'Change here: require complete reported generation before an outcome is admitted.'
}
// The graders and adapters this page can actually dispatch in the browser. Anything else is
// exported and run with cli.mjs; these are the only reason a frozen, readiness-clean project
// can still be unrunnable here.
const PAGE_RUNNABLE_GRADING = ['exact', 'json', 'judge-audit', 'resource-action-plan']
function pageRunRefusals(project, opened = null) {
  if (!project) return []
  const refusals = [], grading = project.spec.protocol.grading.kind
  if (opened && !opened.rebuild.verified) refusals.push('This project was opened from an archive read-only: this build rebuilds it differently at '
    + opened.rebuild.differing.join(', ') + '. It cannot be re-run here as though it had been verified.')
  let eligible = false
  try { eligible = evaluateReadiness(project, { operation: executionOperation(project) }).eligible } catch { eligible = false }
  if (!eligible) refusals.push('The generated execution requirements above are not met for this project’s declared purpose.')
  if (selectedInputGate(project)) refusals.push('Selected-input qualification must run before collection, and this page does not run it.')
  if (!PAGE_RUNNABLE_GRADING.includes(grading)) refusals.push(`This page grades ${PAGE_RUNNABLE_GRADING.join(', ')} in the browser. This project grades ${grading}, which the exported runner does.`)
  const external = project.spec.conditions.filter(condition => condition.adapter.kind !== 'replay')
  if (external.length) refusals.push(`This page dispatches recorded replay responses only. Condition${external.length === 1 ? '' : 's'} ${external.map(condition => `${condition.id} (${condition.adapter.kind})`).join(', ')} need the exported runner.`)
  return refusals
}
// The same commands, in the same order, that this project's own exported README documents.
function exportedCliCommands(project) {
  const commands = ['node cli.mjs verify', 'node cli.mjs qualify', 'node cli.mjs run']
  if (project.spec.protocol.grading.kind === 'lean-python') commands.push('node cli.mjs verify-native')
  return [...commands, 'node cli.mjs analyze']
}
function readinessPurposeSection(project, purpose) {
  const own = executionOperation(project) === purpose.operation
  const head = `<h4>${esc(purpose.label)}${own ? ' — this project’s declared purpose' : ''}</h4>`
  let decision
  try { decision = evaluateReadiness(project, { operation: purpose.operation }) }
  catch (error) { return `<section>${head}<p>This purpose could not be evaluated for this project: ${esc(error.message)}</p></section>` }
  const proofs = decision.requiredProofs.length ? '<ul>' + decision.requiredProofs.map(row => `<li>${esc(row.scope)}</li>`).join('') + '</ul>' : ''
  if (decision.eligible) return `<section>${head}<p>Available. ${esc(purpose.available)}</p>${proofs}</section>`
  return `<section>${head}<p>Blocked by ${decision.blockers.length} requirement${decision.blockers.length === 1 ? '' : 's'}.</p><ul>${decision.blockers.map(row =>
    `<li><code>${esc(row.code)}</code> at <strong>${esc(row.path)}</strong>: ${esc(row.message)}${BLOCKER_GUIDANCE[row.code] ? ` <em>${esc(BLOCKER_GUIDANCE[row.code])}</em>` : ''}</li>`).join('')}</ul>${proofs}</section>`
}
const EDITORS = ['name', 'id', 'task-json', 'input', 'expected', 'split', 'bundle-id', 'bundle-version', 'bundle-kind', 'bundle-role', 'wording', 'parameters', 'slots', 'semantics', 'seed', 'replicates', 'attempts', 'total', 'timeout', 'duration', 'grading', 'require-review', 'conditions', 'inputs', 'environment', 'decisions', 'spec-json', 'attachment-path', 'attachment-text']
const EDITOR_GROUPS = {
  task: ['task-json'], input: ['input', 'expected'],
  bundle: ['bundle-id', 'bundle-version', 'bundle-kind', 'bundle-role', 'bundle-title', 'bundle-labels', 'wording', 'parameters', 'slots', 'semantics'],
  protocol: ['seed', 'replicates', 'attempts', 'total', 'timeout', 'duration', 'grading', 'require-review', 'conditions', 'inputs', 'environment', 'decisions', 'protocol-decisions'],
  conditionFields: ['condition-fields'],
  specification: ['spec-json'], attachment: ['attachment-path', 'attachment-text'],
  analysis: ['analysis-cohort', 'analysis-denominator', 'analysis-population', 'analysis-task-ids', 'analysis-rationale', 'analysis-uncertainty', 'analysis-contrasts', 'analysis-multiplicity', 'endpoint-fields'],
  corpus: ['corpus-plan'],
  design: ['design-plan', 'design-fields'],
  compositionFields: ['composition-fields'],
  compositionFamilies: ['composition-family-fields'],
  audit: ['audit-plan'],
  observations: ['observation-plan'],
  requirements: ['requirement-plan'],
  requirementFields: ['requirement-fields'],
  workflow: ['workflow-config'],
  experiment: ['resource-fields'],
  execution: ['execution-purpose', 'execution-dependence'],
  information: ['information-rationale', 'information-mode', 'information-paths', 'information-readings', 'information-selection'],
  informationFields: ['information-fields'],
  nativePreparation: ['native-preparation-mode', 'native-preparation-rationale', 'native-preparation-reference-replicates', 'native-preparation-mutant-replicates', 'native-preparation-max-executions', 'native-preparation-execution-timeout', 'native-preparation-attempt-timeout', 'native-preparation-duration'],
}
EDITORS.push(...EDITOR_GROUPS.analysis)
EDITORS.push('bundle-title', 'bundle-labels', 'routing', 'composition-generation-draft', 'nesting-draft', 'variance-draft', 'prompt-set-draft', 'protocol-decisions', 'pipeline-draft')
EDITORS.push(...EDITOR_GROUPS.design)
EDITORS.push(...EDITOR_GROUPS.corpus)
EDITORS.push(...EDITOR_GROUPS.compositionFields)
EDITORS.push(...EDITOR_GROUPS.compositionFamilies)
EDITORS.push(...EDITOR_GROUPS.information)
EDITORS.push(...EDITOR_GROUPS.informationFields)
EDITORS.push(...EDITOR_GROUPS.audit)
EDITORS.push(...EDITOR_GROUPS.observations)
EDITORS.push(...EDITOR_GROUPS.requirements)
EDITORS.push(...EDITOR_GROUPS.requirementFields)
EDITORS.push(...EDITOR_GROUPS.workflow)
EDITORS.push(...EDITOR_GROUPS.experiment)
EDITORS.push(...EDITOR_GROUPS.execution)
EDITORS.push(...EDITOR_GROUPS.conditionFields)
EDITORS.push(...EDITOR_GROUPS.nativePreparation)
// A saved work in progress may have a blank name or unfinished protocol.
// Validate the shape needed by the editors; freezing validates the study.
function validateDraft(spec, files = {}) {
  invariant(object(spec) && SUPPORTED_SCHEMA_VERSIONS.includes(spec.schemaVersion) && typeof spec.name === 'string' && typeof spec.id === 'string' && (spec.domain === 'generic' || isRegisteredDomain(spec.domain)), 'This is not a supported benchmark draft.')
  invariant(Array.isArray(spec.tasks) && spec.tasks.length <= 512 && spec.tasks.every(task => object(task) && object(task.root)), 'A draft supports up to 512 editable tasks with prompt roots.')
  invariant(Array.isArray(spec.catalog) && spec.catalog.length <= 512 && spec.catalog.every(object), 'A draft supports up to 512 editable catalog bundles.')
  invariant(object(spec.protocol) && object(spec.protocol.grading) && Array.isArray(spec.inputs) && Array.isArray(spec.conditions), 'The draft protocol, conditions or input manifest is damaged.')
  invariant(object(files) && Object.entries(files).every(([path, contents]) => safePath(path) && typeof contents === 'string'), 'Draft attachments need relative file paths and text contents.')
}

export function downloadBenchmark(name, contents, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([contents], { type }))
  const link = document.createElement('a'); link.href = url; link.download = name
  document.body.append(link); link.click(); link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// The runtime this page is running, as the report's runtime-integrity input (Manager
// finding F4, report.mjs contract): a map from each runtime file the project pins to the
// digest of the page's own bundled source for it, null when the page bundles no such
// file. The report compares the map with the project's pins and prints what differs;
// verifyProject never re-reads the running tree, so without this the report would print
// pinned digests as if they were the code that ran. Keyed by the held project's own
// pinned file list, so for an opened archive it answers against the OPENED project's
// pins and the run of record opened on a later build names exactly what differs.
export async function runtimeIntegrityFor(project, sources) {
  const running = {}
  for (const file of runtimeFilesFor(project)) running[file] = typeof sources?.[file] === 'string' ? await sha256(sources[file]) : null
  return running
}
export function createBenchmarkBuilder({ account, submitExported, onOpen = () => {}, onBenchmarkLoaded = () => {}, onDraftIdentity = () => {}, separateProject = false, separateResource = false, onOpenResource = () => {}, onWatchRuns = () => {}, download = downloadBenchmark,
  loadSources = () => import('./research-benchmark-sources.js').then(module => module.sources) } = {}) {
  const root = el(`<section class="research-section benchmark-builder" data-mc="benchmark" aria-labelledby="benchmark-title">
    <div class="research-section-head"><h2 id="benchmark-title">Benchmark builder</h2><p>Compose reusable prompts, freeze your protocol, and export a benchmark that runs on its own.</p></div>
    <div class="bench-start-sections">
      <section aria-labelledby="bench-open-title">
        <h3 id="bench-open-title">Open a saved experiment</h3>
        <p>Open a draft to edit its snippets, compositions, variants and protocol. Inspect a ZIP to review an exported benchmark in Run &amp; review.</p>
        <div class="bench-toolbar"><label class="bench-file">Open draft file<input type="file" data-bench-import accept=".json,application/json"></label><label class="bench-file">Inspect exported project<input data-bench-open-exported type="file" accept=".zip,application/zip"></label></div>
      </section>
      <section aria-labelledby="bench-examples-title">
        <h3 id="bench-examples-title">Start from an example</h3>
        <p>Load a bundled draft into this workspace. Undo draft replacement returns to your previous draft.</p>
        <div class="bench-toolbar"><label>Example draft<select data-bench-starter aria-describedby="bench-example-help"></select></label><button type="button" data-bench-use-starter>Load example draft</button></div>
        <p class="bench-muted" id="bench-example-help">Choose an example, then load its prompts and experiment settings.</p>
      </section>
    </div>
    <h3 data-bench-current-experiment tabindex="-1">Current experiment</h3>
    <p data-bench-origin class="bench-muted">Empty draft.</p>
    <div class="bench-toolbar"><label>Benchmark name<input data-bench-name></label><p class="bench-benchmark-of" data-bench-benchmark-of></p><label>Identifier<input data-bench-id spellcheck="false"></label><label>Study version<input data-bench-study-version spellcheck="false" placeholder="1.0.44"></label>
      <button type="button" class="bench-primary" data-bench-save>Save draft to account</button><button type="button" data-bench-draft-export>Download draft</button><button type="button" data-bench-new-empty>New empty draft</button><button type="button" data-bench-undo hidden>Undo draft replacement</button></div>
    <p class="bench-muted" data-bench-study-version-status></p>
    <details class="bench-muted"><summary>How a study version is read</summary><ul>${STUDY_VERSION_RULES.map(rule => `<li>${esc(rule)}</li>`).join('')}</ul></details>
    <p data-bench-scope class="bench-muted"></p><p role="status" data-bench-status></p>
    <nav class="bench-steps" aria-label="Benchmark building steps">${[['library', 'Snippets'], ['compose', 'Composition'], ['nesting', 'Nesting'], ['variance', 'Variance'], ['corpus', 'Build task set'], ...(!separateResource ? [['experiment', 'Resource action']] : []), ['requirements', 'Qualification'], ['audit', 'Judge audit'], ['protocol', 'Decisions & pipeline'], ['workflow', 'Prompt workflow'], ['observations', 'Accounting'], ['run', 'Freeze & run'], ['analysis', 'Analysis & report']].map(([id, label]) => `<button type="button" data-bench-tab="${id}" aria-pressed="${id === 'library'}">${label}</button>`).join('')}</nav>
    <div data-bench-panel="variance" hidden><div data-bench-variance-editor></div><textarea data-bench-variance-draft hidden aria-label="Retained variance studies"></textarea></div>
    <div data-bench-panel="nesting" hidden>
      <div data-bench-nesting-editor></div><textarea data-bench-nesting-draft hidden aria-label="Retained nesting draft"></textarea>
    </div>
    <div data-bench-panel="compose" hidden>
      <div data-bench-composition-generator></div><textarea data-bench-composition-generation-draft hidden aria-label="Retained composition generation"></textarea>
    </div>
    <div data-bench-panel="experiment" hidden>
      <h3>Generate a resource experiment</h3><p>Fill in cases, resources and requested changes. The platform generates the task prompts, fresh resource environment, reference plans, controls and effect measurements. The returned plan runs once in a bounded synthetic resource map.</p>
      <div data-bench-resource-editor></div><textarea data-bench-resource-fields hidden aria-label="Retained experiment field draft"></textarea>
      <button type="button" data-bench-apply-resource-template>Generate experiment from fields</button><p data-bench-resource-status></p>
      <details><summary>Generated public requests</summary><pre data-bench-resource-preview tabindex="0"></pre></details>
      <p>Every new run qualifies the generated apparatus before collection. Shared environments, interactive tool agents and arbitrary code execution need other supported templates. Recorded controls test this apparatus; they establish no model performance.</p>
    </div>
    <div data-bench-panel="library" class="snippet-workspace">
      <div class="snippet-heading"><div><h3>Snippet constructor</h3><p>Write one reusable instruction. Label it, then combine it with other snippets to build a benchmark task.</p></div><button type="button" class="bench-primary" data-bench-add-atom>New snippet</button></div>
      <div class="snippet-layout"><aside class="snippet-library" aria-label="Snippet library">
        <label>Find a snippet<input type="search" data-bench-snippet-search placeholder="Search name, text or labels"></label>
        <label>Category label<select data-bench-snippet-label-filter><option value="">All labels</option></select></label>
        <div class="snippet-categories" data-bench-snippet-categories role="group" aria-label="Filter by category"></div>
        <p data-bench-snippet-count></p><div data-bench-snippet-list class="snippet-list"></div>
        <select data-bench-bundle hidden aria-label="Selected snippet"></select>
        <div class="snippet-library-actions"><button type="button" data-bench-load-examples>Load example snippets</button><button type="button" data-bench-export-snippets>Export snippets</button><label class="snippet-import">Import snippets<input type="file" data-bench-import-snippets accept=".json,application/json"></label></div>
      </aside><div class="snippet-editor">
        <label>Snippet name<input data-bench-bundle-title maxlength="160" placeholder="Give this instruction a clear name"></label>
        <label>Category labels<input data-bench-bundle-labels placeholder="Your own labels, separated by commas" aria-describedby="snippet-label-help" list="snippet-known-labels"></label>
        <datalist id="snippet-known-labels" data-bench-snippet-known-labels></datalist>
        <p id="snippet-label-help" class="snippet-help">Use your own labels, separated by commas. A snippet can belong to more than one category.</p><div class="snippet-labels" data-bench-snippet-label-preview aria-live="polite"></div>
        <div data-bench-snippet-variant hidden><h4>Variant wording</h4><pre data-bench-snippet-variant-text></pre></div>
        <label><span data-bench-wording-label>Snippet text</span><textarea data-bench-wording rows="7" placeholder="Write the exact instruction this snippet contributes."></textarea></label>
        <button type="button" data-bench-vary-snippet>Create variance</button>
        <div class="snippet-editor-actions"><button type="button" class="bench-primary" data-bench-apply-bundle>Apply snippet</button><button type="button" data-bench-clone-bundle>Duplicate snippet</button><button type="button" data-bench-delete-snippet>Delete snippet</button><button type="button" data-bench-compose-snippets>Compose tasks →</button></div>
        <p class="snippet-help" data-bench-snippet-status>Apply edits to use them in this benchmark. Export snippets to keep a portable copy.</p>
        <details class="snippet-advanced"><summary>Advanced: parameters, composition and behavior</summary>
          <p>Use {{parameter}} for a value. A child place is written {{slot:the-name-you-choose}}, and a snippet or another template can be put in it. Composition roles say which snippets may fill a place; category labels organize your library.</p>
          <button type="button" data-bench-add-template>New template</button>
          <div class="bench-columns"><label>Name a child place<input data-bench-slot-name placeholder="the word you want to call it" spellcheck="false"></label><button type="button" data-bench-add-slot>Add this child place</button></div>
          <div class="bench-columns"><label>Identifier<input data-bench-bundle-id></label><label>Version<input data-bench-bundle-version></label><label>Kind<select data-bench-bundle-kind><option value="atom">Snippet</option><option value="template">Template</option></select></label><label>Composition role<input data-bench-bundle-role list="snippet-composition-roles"></label><datalist id="snippet-composition-roles" data-bench-snippet-roles></datalist></div>
          <div class="bench-columns"><label>Default parameters (JSON)<textarea data-bench-parameters rows="5" spellcheck="false"></textarea></label><label>Slot names and roles (JSON)<textarea data-bench-slots rows="5" spellcheck="false"></textarea></label></div>
          <label>Behavior, code hooks, dependencies and tests (JSON)<textarea data-bench-semantics rows="12" spellcheck="false"></textarea></label>
        </details>
        <details class="snippet-review"><summary>Review this version</summary><label>Reviewer name<input data-bench-reviewer autocomplete="name"></label><button type="button" data-bench-approve>Record my review of this version</button><p data-bench-review-status role="status"></p>
          <details data-bench-source-details><summary>Exact apparatus source for review</summary><label>File<select data-bench-source-file></select></label><button type="button" data-bench-load-source>Read source</button><pre data-bench-source-code tabindex="0"></pre></details>
        </details>
      </div></div>
    </div>
    <div data-bench-panel="corpus" hidden>
      <div data-bench-prompt-set-editor></div><textarea data-bench-prompt-set-draft hidden aria-label="Retained task-set selection"></textarea>
      <details class="bench-task-tools" data-bench-task-tools><summary>Inspect or adjust one task</summary>
        <p>One task at a time: pick it, read its prompt tree and compiled prompt, set its input and expected result, and declare its information treatment. Tasks come from the set generated above, from the rules on Nesting, or by hand.</p>
      <div class="bench-toolbar"><label>Task<select data-bench-task></select></label><button type="button" data-bench-add-task>Add task</button><button type="button" data-bench-delete-task>Remove task</button><label>Split<select data-bench-split><option value="development">Development</option><option value="held-out">Held out</option></select></label></div>
      <h3>The selected task</h3>
      <p>Changing a bundle keeps compatible child connections. Fill any new child slots explicitly. To discard a branch, choose “Replace whole branch with defaults” before selecting its new bundle. Undo replacement restores the preceding draft.</p>
      <div class="bench-compose-grid"><div><p class="bench-label" id="bench-tree-label">Prompt tree</p><div data-bench-tree class="bench-tree" role="group" aria-labelledby="bench-tree-label"></div>
        <details><summary>Edit complete task JSON</summary><textarea data-bench-task-json spellcheck="false" rows="12" aria-label="Task JSON"></textarea><button type="button" data-bench-apply-task>Apply task JSON</button></details>
        <div class="bench-lean-combinations" data-bench-combinations hidden><h3>Combine the four roles</h3><p>Select reusable atoms for each role. Every combination becomes a separate task; templates can wrap the resulting strategies.</p><div data-bench-role-choices></div><label>Top operator<select data-bench-combination-wrapper><option value="">Flat strategy</option><option value="parallel">Parallel</option><option value="sequence">Sequence</option><option value="race">Race</option></select></label><button type="button" data-bench-generate>Generate combinations</button></div>
      </div><div class="bench-preview"><h3 id="bench-preview-title">Compiled prompt</h3><p data-bench-preview-meta class="bench-muted"></p><pre data-bench-prompt tabindex="0" aria-labelledby="bench-preview-title"></pre><details><summary>Requirements and bundle hashes</summary><pre data-bench-checklist tabindex="0"></pre></details><details data-bench-layers-details><summary>Layer map: which layer contributed which characters</summary><p data-bench-layers-caption class="bench-muted"></p><div data-bench-layers tabindex="0"></div></details><details data-bench-trace-details hidden><summary>Semantic trace preview</summary><pre data-bench-trace tabindex="0"></pre></details></div></div>
      <div class="bench-columns"><label>Task input (JSON)<textarea data-bench-input rows="7" spellcheck="false"></textarea></label><label>Expected result (JSON value)<textarea data-bench-expected rows="7" spellcheck="false"></textarea></label></div><button type="button" class="bench-primary" data-bench-apply-input>Apply input and expected result</button><button type="button" data-bench-derive-expected hidden>Derive draft expected observation</button>
      <h3>Information treatment fields</h3><p>Select atom occurrences to withhold. Add readings from an exact existing reading or the baseline, then enter local parameter alternatives. The platform builds their complete nested roots; unchanged branches retain their meaning. Supply expected answers or explicitly derive supported LEAN observations, then review the complete treatment.</p>
      <button type="button" data-bench-prepare-information-fields>Prepare information fields</button><button type="button" data-bench-reset-information-fields>Replace fields from applied task</button>
      <div data-bench-information-fields-editor></div><p data-bench-information-fields-status></p>
      <details><summary>Information field draft JSON</summary><textarea data-bench-information-fields rows="12" spellcheck="false" aria-label="Information field draft"></textarea></details>
      <button type="button" data-bench-apply-information-fields>Build information treatment from fields</button>
      <button type="button" data-bench-add-information>Add information treatment</button>
      <details data-bench-information-details hidden><summary>Information treatment and admissible readings</summary><p>Declare withheld atom paths and a finite reading set. Every retained reading must produce the same compiled task text. Review the condition settings and workflow instructions too: a stage can omit that text, add instructions or include earlier outputs. One task-level reading set applies across its conditions; the compiler does not infer readings from added instructions. Private semantics and expected observations stay in the review packet.</p>
        <label>Treatment rationale<textarea data-bench-information-rationale rows="3"></textarea></label>
        <div class="bench-columns"><label>Reading selection<select data-bench-information-selection><option value="readingPool">Filter candidate pool by visible prompt</option><option value="readings">Require all declared readings to agree</option></select></label><label>Response format<select data-bench-information-mode><option value="raw">Requested answer only</option><option value="tagged-json">JSON answer, clarification or refusal</option></select></label></div>
        <label>Withheld atom paths (JSON)<textarea data-bench-information-paths rows="3" spellcheck="false"></textarea></label><p>Use occurrence paths from the requirements checklist, such as root/strategy/buy_process. Whole templates cannot be withheld.</p>
        <label>Reading candidates (JSON)<textarea data-bench-information-readings rows="12" spellcheck="false"></textarea></label><p>Each reading declares an id, root and rationale; generic tasks also declare expected results. Optional conventions assign named values for distribution analysis. LEAN readings derive their expected native traces from their semantic tree.</p>
        <button type="button" data-bench-apply-information>Apply information treatment</button><button type="button" data-bench-prepare-information>Prepare current review packet</button><label>Reviewer name<input data-bench-information-reviewer autocomplete="name"></label><button type="button" data-bench-approve-information>Record my review of this task</button><p data-bench-information-review-status></p><pre data-bench-information-packet tabindex="0"></pre></details>
      </details>
      <details class="bench-routing-fold" data-bench-routing-fold><summary>Advanced: tasks from a table of rows (rules)</summary>
        <p>Type rows of field values and rules that send each row to one composition. Every row becomes a task with those values as input. Read the rules top to bottom: the first whose tests hold decides. Saved sets on the pool above are the ordinary way to make tasks; use this when tasks must carry row values.</p>
        <div data-bench-routing-editor></div>
        <p data-bench-routing-status role="status"></p>
        <div class="bench-toolbar"><button type="button" class="bench-primary" data-bench-apply-routing>Generate tasks from these rules</button><button type="button" data-bench-reset-routing>Start these rules again</button></div>
        <details><summary>Advanced: this routing as JSON</summary><textarea data-bench-routing rows="12" spellcheck="false" aria-label="Routing draft"></textarea></details>
      </details>
      <details class="bench-tree-fold" data-bench-tree-fold><summary>Advanced: edit a composition's tree</summary>
        <p>Every composition is a tree: a template with holes, and what fills each hole. Composition and Nesting build these for you. Use this section to edit your own template by hand or repair a saved composition after a snippet changed.</p>
        <div class="bench-toolbar"><label>Composition<select data-bench-tree-composition></select></label><button type="button" data-nest-from-snippets>New composition from a template</button></div>
        <div data-bench-tree-editor></div>
      </details>
      <details data-bench-advanced-generation><summary>Advanced generation from composition choices</summary>
      <h3>Generate task families</h3><p>Build task families from reusable components. Declare parameter choices, nested wrappers, compatibility exclusions, sampling and minimum coverage. The exported project retains every candidate and its selection or exclusion reason.</p>
      <p>Vary separate occurrences or build whole nested branches in the selected task. Fill in the component choices, child connections, local parameters, selection and expected-answer policy; the platform builds the recipe and experiments.</p>
      <div data-bench-single-composition-controls><button type="button" data-bench-prepare-composition-fields>Prepare occurrence fields</button><button type="button" data-bench-reset-composition-fields>Start fresh occurrence fields</button><button type="button" data-bench-start-family-workspace>Use multiple source families</button></div>
      <div data-bench-family-workspace hidden><div data-bench-family-editor></div><button type="button" data-bench-prepare-family-fields>Inspect selected family fields</button><button type="button" data-bench-reset-family-fields>Replace selected family with its current source</button><button type="button" data-bench-export-family-sources>Export editable family sources</button><button type="button" data-bench-leave-family-workspace>Return to single-family fields</button><p>Export a separate source draft to continue editing after generation. It retains these source tasks and fields with the current applied settings, clears recorded responses, and requires rebuilding. Your current experiment and evidence stay here. Import the file separately to edit it.</p><p data-bench-family-source-status></p><div data-bench-family-occurrence-editor></div></div>
      <textarea data-bench-composition-family-fields hidden aria-label="Retained composition family workspace"></textarea>
      <div data-bench-composition-fields-editor></div><textarea data-bench-composition-fields hidden aria-label="Retained composition fields"></textarea>
      <button type="button" data-bench-apply-composition-fields>Build task recipe from fields</button><p data-bench-composition-fields-status></p>
      <div data-bench-composition-obligations aria-live="polite"></div>
      <button type="button" data-bench-seed-corpus>Start recipe from selected task</button>
      <label>Task recipe (JSON)<textarea data-bench-corpus-plan rows="20" spellcheck="false"></textarea></label>
      <p>Paths list template slots from the root. An empty path names the root. Axes can change a node, parameter, input, expected answer, or repeat a nested wrapper. Each family stays in one study split.</p>
      <details><summary>Joint and composition coverage</summary><p>A coverage rule with <code>dimensions: ["axis:entry", "axis:exit"]</code> requests every pair of declared choices. Use 2–4 dimensions and a positive <code>minimum</code>. Optional <code>levels</code> narrows the requested levels for each dimension; excluded or unavailable combinations stay visible.</p><p><code>composition-depth</code> counts slot edges from the root and <code>composition-nodes</code> counts compiled nodes. Declare explicit numeric string levels to require a depth or size that construction never produced. Define <code>features: [{id: "cross-entry", bundles: ["my-cross-atom"], rationale: "Declared cross-entry classification"}]</code> to cover <code>feature:cross-entry</code> as <code>present</code> or <code>absent</code>. Presence is checked against nodes in the compiled baseline. A feature may group reviewed stateful atoms or operators; its classification is yours to justify. Structural coverage does not establish that a branch activated on the chosen data.</p></details>
      <div class="bench-toolbar"><button type="button" data-bench-generate-corpus>Generate tasks</button><button type="button" data-bench-detach-corpus>Detach recipe for manual authoring</button></div>
      <p>Generation replaces this draft's task list and clears recorded responses. Previous drafts can be restored with Undo replacement. A frozen recipe must reproduce its tasks exactly.</p>
      <details><summary>Coverage and exclusion ledger</summary><pre data-bench-corpus-ledger tabindex="0"></pre></details>
      </details>
    </div>
    <div data-bench-panel="requirements" hidden>
      <h3>Requirement qualification</h3><p>Register exact requirement occurrences, hand-checked probe inputs, activation rules and plausible wrong readings before testing. Each wrong reading may change only its declared requirement. Information tasks require an explicit admissible reading.</p>
      <button type="button" data-bench-prepare-requirement-fields>Prepare controls for every requirement</button><button type="button" data-bench-reset-requirement-fields>Start fresh controls for this design</button>
      <div data-bench-requirement-fields-editor></div><textarea data-bench-requirement-fields hidden aria-label="Retained requirement control fields"></textarea>
      <button type="button" data-bench-apply-requirement-fields>Generate qualification plan from fields</button><p data-bench-requirement-fields-status></p>
      <details><summary>Advanced requirement plan</summary><label>Requirement plan (JSON; null removes the plan)<textarea data-bench-requirement-plan rows="20" spellcheck="false"></textarea></label>
      <p>Each target declares id, taskId, requirementId, rationale, activation, probes and wrongReadings. A probe contains input and assertions with literal JSON paths and exact expected values. A wrong reading contains its complete root and rationale.</p>
      <p>The exported CLI compares independent interpreters and records detection of every registered wrong reading. Optional sequence shrinking retains the original test and reports its evaluation budget. Unregistered requirements and surviving wrong readings remain visible.</p>
      <p>Add <code>selectedInput: {policy: "require-composition", rationale: "Explain the coverage requirement", timeoutMs: 120000}</code> to test the exact selected inputs before collection. Policies are <code>report</code>, <code>require-registered</code> and <code>require-composition</code>. The last requires every composition occurrence in every admissible reading; runtime appendices remain separate apparatus obligations. Gated projects run through the exported CLI or connected run service, which can execute the independent interpreter. Their evidence and reports can be imported here.</p>
      <p>For a generic benchmark, pin and attach two distinct <code>.mjs</code> interpreter files in Protocol, then declare <code>interpreters: {reference, independent, rationale}</code>. Each exports <code>interpret(task, target, options)</code> and returns an observation and named activation counters/transitions. The export describes the contract and retains each bounded child process result.</p>
      <button type="button" data-bench-apply-requirements>Apply requirement plan</button><button type="button" data-bench-prepare-requirements>Inspect bound registry</button><p data-bench-requirement-status></p><pre data-bench-requirement-registry tabindex="0"></pre>
      </details>
      <p>After exporting, run <code>node cli.mjs qualify</code>. Its qualification.json contains these local checks. Native execution, personal review and full study qualification require their own evidence.</p>
    </div>
    <div data-bench-panel="audit" hidden>
      <div data-bench-judge-editor></div>
      <h3>Reference audit</h3><p>To compare a judge’s verdicts with a declared reference criterion, start with a frozen source study and its retained candidate responses. The source observations and the judge’s later decisions remain separate evidence. A reference bundle is not required to configure the judges above.</p>
      <div class="bench-toolbar"><button type="button" data-bench-export-reference>Export this run as a reference</button><label class="bench-file">Import reference bundle<input type="file" data-bench-import-reference accept=".json,application/json"></label></div>
      <p>For native execution evidence or custom source graders, create the reference in the source project with <code>node cli.mjs reference</code>. Importing creates a new draft with no configured judge responses. Undo replacement restores the previous draft.</p>
      <p data-bench-audit-source class="bench-muted"></p>
      <div data-bench-audit-authoring hidden>
        <label>Audit plan (JSON)<textarea data-bench-audit-plan rows="18" spellcheck="false"></textarea></label>
        <p>Declare the comparison criterion, case selection and judge input. External benchmarks require pinned original wording, provenance and an acquisition record (method, location and timestamp). An admissible-witness criterion leaves unmatched observations unscored; a finite reading set cannot establish uniqueness.</p>
        <button type="button" data-bench-generate-audit>Generate audit cases</button><p>Generation replaces the case list and clears recorded judge responses. Source files stay bound to the imported reference.</p>
        <details><summary>Source trial and selection ledger</summary><pre data-bench-audit-ledger tabindex="0"></pre></details>
        <div class="bench-toolbar"><label>Audit case<select data-bench-audit-case></select></label><button type="button" data-bench-prepare-audit>Prepare current review packets</button></div>
        <label>Reviewer name<input data-bench-audit-reviewer autocomplete="name"></label><button type="button" data-bench-approve-audit>Record my review of this case</button><p data-bench-audit-review-status></p><pre data-bench-audit-packet tabindex="0"></pre>
        <details><summary>Retained source files</summary><label>File<select data-bench-audit-file></select></label><pre data-bench-audit-file-text tabindex="0"></pre></details>
      </div>
    </div>
    <div data-bench-panel="protocol" hidden>
      <div data-bench-protocol-editor></div><textarea data-bench-protocol-decisions hidden aria-label="Retained protocol decisions"></textarea>
      <div data-bench-pipeline-editor></div><textarea data-bench-pipeline-draft hidden aria-label="Retained pipeline draft"></textarea>
      <h3>Schedule and budgets</h3>
      <div class="bench-columns"><label>Schedule seed<input data-bench-seed type="number" min="0"></label><label>Replicates<input data-bench-replicates type="number" min="1" max="100"></label><label>Attempts per trial<input data-bench-attempts type="number" min="1" max="10"></label><label>Total attempt budget<input data-bench-total type="number" min="1"></label><label>Attempt timeout (seconds)<input data-bench-timeout type="number" min="0.001" step="0.001"></label><label>Study time budget (seconds)<input data-bench-duration type="number" min="0.001" step="0.001"></label></div>
      <label>Scoring<select data-bench-grading></select></label><p data-bench-grading-help class="bench-muted" hidden></p><label><input type="checkbox" data-bench-require-review>Require current bundle and task reviews before freezing</label>
      <details><summary>Native preparation controls</summary>
        <p>Generate reference and mutant control projects for every registered selected task, reading, occurrence and probe. First apply LEAN Python scoring and complete-composition qualification. Generated controls still require execution and verification; native experimental admission remains unavailable.</p>
        <label>Control plan<select data-bench-native-preparation-mode><option value="none">No native preparation plan</option><option value="planned">Declare native preparation controls</option></select></label>
        <label>Control rationale<textarea data-bench-native-preparation-rationale rows="3"></textarea></label>
        <div class="bench-columns">
          <label>Reference repetitions (3–20)<input data-bench-native-preparation-reference-replicates inputmode="numeric"></label>
          <label>Mutant repetitions (1–20)<input data-bench-native-preparation-mutant-replicates inputmode="numeric"></label>
          <label>Maximum planned native executions<input data-bench-native-preparation-max-executions inputmode="numeric"></label>
          <label>Native execution timeout (ms)<input data-bench-native-preparation-execution-timeout inputmode="numeric"></label>
          <label>Control attempt timeout (ms; at least 30,000 beyond execution)<input data-bench-native-preparation-attempt-timeout inputmode="numeric"></label>
          <label>Declared preparation duration budget (ms)<input data-bench-native-preparation-duration inputmode="numeric"></label>
        </div>
        <button type="button" data-bench-apply-native-preparation>Apply native control plan</button>
        <button type="button" data-bench-prepare-native-preparation>Preview native control roster</button>
        <p>Coverage includes every selected input and registered probe. Inspect gaps and apparatus requirements below. Applying the fields changes the draft; Undo restores its preceding applied plan and raw fields. Separate control ZIPs do not enforce a combined preparation budget or establish a preparation receipt.</p>
        <p data-bench-native-preparation-status role="status"></p>
        <pre data-bench-native-preparation-plan tabindex="0"></pre>
      </details>
      <h3>Systems and conditions</h3><p>Declare requested model identities, settings and collection contracts. Use ordinary fields for recorded responses, local command programs and HTTPS frozen-request endpoints. Advanced JSON retains attached module and other imported configurations; their existing execution restrictions still apply.</p>
      <button type="button" data-bench-prepare-condition-fields>Prepare condition fields from current setup</button>
      <p>Fill each requested model, its typed settings and its response contract. An HTTPS endpoint must accept the exported frozen-request JSON and return a reply object that contains the output. These declarations do not establish which model ran. Existing advanced configurations remain available below.</p>
      <div data-bench-condition-fields-editor></div>
      <textarea data-bench-condition-fields hidden aria-label="Retained condition field draft"></textarea>
      <p data-bench-condition-fields-status role="status"></p>
      <details><summary>Preview generated setup</summary><p>Inspect the proposed condition declarations, assignments and accounting mappings before applying. This preview sends no request and creates no observations.</p><pre data-bench-condition-fields-preview tabindex="0"></pre></details>
      <button type="button" data-bench-apply-condition-fields>Apply condition setup</button>
      <p>This applies conditions, their workflow assignments and accounting checks together. Other setup fields retain their current values. Changed JSON makes prepared fields stale; prepare again explicitly to replace them. Undo restores the preceding draft and raw text.</p>
      <details><summary>Advanced condition JSON</summary><label>Conditions (JSON)<textarea data-bench-conditions rows="12" spellcheck="false"></textarea></label></details>
      <div class="bench-columns"><label>Input paths, hashes and acquisition instructions (JSON)<textarea data-bench-inputs rows="7" spellcheck="false"></textarea></label><label>Environment and dependency pins (JSON)<textarea data-bench-environment rows="7" spellcheck="false"></textarea></label></div>
      <label hidden>Frozen study decisions text<textarea data-bench-decisions rows="6" aria-label="Frozen study decisions text"></textarea></label>
      <details><summary>Full specification JSON</summary><textarea data-bench-spec-json rows="18" spellcheck="false" aria-label="Full benchmark specification"></textarea><button type="button" data-bench-apply-spec>Apply full specification</button></details>
      <button type="button" class="bench-primary" data-bench-apply-protocol>Apply protocol</button>
      <h3>Project files</h3><p>Attach text datasets, adapter modules, graders and dependency locks. These files are included and hashed in the export.</p><label>Relative file path<input data-bench-attachment-path placeholder="adapters/my-system.mjs"></label><label>File contents<textarea data-bench-attachment-text rows="7" spellcheck="false"></textarea></label><button type="button" data-bench-attach>Add or update file</button><ul data-bench-attachments></ul>
    </div>
    <div data-bench-panel="workflow" hidden>
      <h3>Frozen prompt workflow</h3><p>Declare the stages used to collect one trial answer. Specify whether each workflow is a treatment or orchestration, its branches, which parts of the parent's output it receives, tools, timeouts and budgets. Terminal selection happens before grading.</p>
      <button type="button" data-bench-seed-workflow>Start one-stage workflow</button>
      <label>Workflow plan and condition assignments (JSON)<textarea data-bench-workflow-config rows="22" spellcheck="false"></textarea></label>
      <p>Assign each condition a workflow identifier or null. Set plan to null and every assignment to null to remove workflows. For individual Apply, apply the Accounting plan first; use the combined action below when the edits depend on one another. Recorded controls need the wrapped-reply setting and adapter.workflowResponses keyed by task and stage; each response includes workflow.toolCalls, an explicit array of reported actions.</p>
      <p>Every route is finite and sequential. Branches use the first matching JSON equality test; null selects the current stage’s resultPath. Parents must precede the child on every route. Stage tools must be declared in the condition’s collection controls. Any failure or interruption halts the study and retains its partial workflow.</p>
      <button type="button" data-bench-apply-workflow>Apply workflow</button><p data-bench-workflow-status></p>
      <button type="button" data-bench-apply-workflow-setup>Apply workflow, protocol and accounting together</button>
      <p>For a new workflow, start its draft and an Accounting draft before editing Protocol. Fill the accounting mappings, condition settings and workflow assignments. Recorded workflows need the wrapped-reply setting and a workflowResponses map with your own task/stage responses. Apply the three groups together when they depend on each other. This also supports removing them together; remove workflow response maps and the wrapped-reply setting when removing their accounting. No responses or qualification are inferred. Undo restores the preceding draft and its editor text.</p>
    </div>
    <div data-bench-panel="observations" hidden>
      <h3>Identity and resource accounting</h3><p>Freeze how returned identity, generation status, tokens, tools and cost are read from every response. Missing observations stay unavailable. Host timing covers each attempt, including collection, extraction, grading and settlement.</p>
      <button type="button" data-bench-seed-observations>Start accounting plan</button>
      <label>Accounting plan (JSON; null disables accounting)<textarea data-bench-observation-plan rows="20" spellcheck="false"></textarea></label>
      <p>Mappings are paths through the response JSON, such as ["usage", "inputTokens"]. Use null for unmapped fields. Per-condition overrides can handle different adapter envelopes. Generation status accepts the explicit values complete and incomplete; a provider’s other finish reasons are not interpreted automatically.</p>
      <p>The record policy preserves observations without excluding answers. A required identity or completion policy stops collection when a returned answer cannot be admitted; it cannot trigger a replacement answer. Declare requested model versions, surfaces, settings and optional collection controls in Protocol.</p>
      <p>Reported charges require both an amount and a currency. Estimates use explicitly declared unit prices or a per-started-attempt allocation, with a rationale and pinned source files. Saved response metadata describes a replay; it does not establish new provider usage or charges.</p>
      <button type="button" data-bench-apply-observations>Apply accounting plan</button><p data-bench-observation-status></p>
      <details><summary>Resolved contracts for each condition</summary><pre data-bench-observation-contracts tabindex="0"></pre></details>
    </div>
    <div data-bench-panel="analysis" hidden>
      <h3>Frozen analysis plan</h3><p>Choose the study cohort, primary population and denominator before running. Every report retains collection failures and shows both scheduled and completed trial rates.</p>
      <div class="bench-columns"><label>Cohort<select data-bench-analysis-cohort><option value="">Not declared</option>${COHORTS.map(cohort => option(cohort, cohort[0].toUpperCase() + cohort.slice(1))).join('')}</select></label><label>Primary denominator<select data-bench-analysis-denominator><option value="scheduled">All scheduled trials</option><option value="completed">Completed and graded trials</option></select></label></div>
      <label>Primary population<select data-bench-analysis-population><option value="all">All frozen tasks</option><option value="held-out">Held-out tasks</option><option value="development">Development tasks</option><option value="task-set">Explicit task IDs</option><option value="reference-eligible" disabled>Reference-eligible audit cases</option></select></label>
      <label data-bench-analysis-task-ids-field hidden>Task IDs<textarea data-bench-analysis-task-ids rows="4" spellcheck="false" placeholder="task-one, task-two"></textarea><span>Separate task IDs with commas or newlines. Every ID must name a task in this draft.</span></label>
      <p>Population selection determines the primary rates and planned contrasts. Every scheduled task remains in the full outcome and disposition tables.</p><div data-bench-analysis-population-preview></div>
      <label>Analysis rationale<textarea data-bench-analysis-rationale rows="5"></textarea></label>
      <details open><summary>Typed endpoints</summary><p>Declare measured outcomes beyond the binary pass: counts, rates over a declared exposure, durations, proportions and event times with a censoring cap. Each endpoint reads one path in the retained attempt record. Apply the analysis plan to freeze them; the binary pass tables always remain.</p><div data-bench-endpoint-fields-editor></div><textarea data-bench-endpoint-fields hidden aria-label="Retained typed endpoint field draft"></textarea><p data-bench-endpoint-fields-status role="status"></p></details>
      <details><summary>Planned comparisons and uncertainty</summary><p>Each task needs a familyId for family bootstrap intervals. Related variants stay in the same family and study split.</p><label>Contrasts (JSON)<textarea data-bench-analysis-contrasts rows="5" spellcheck="false"></textarea></label><label>Uncertainty procedure (JSON; null for descriptive tables)<textarea data-bench-analysis-uncertainty rows="5" spellcheck="false"></textarea></label><label>Multiple comparisons<select data-bench-analysis-multiplicity><option value="none-descriptive">Descriptive comparisons</option><option value="bonferroni">Bonferroni simultaneous intervals</option></select></label></details>
      <button type="button" data-bench-apply-analysis>Apply analysis plan</button><p>Run and import results from the frozen project, then export a report with its tables, figure, Markdown, HTML and canonical analysis data.</p>
      <details><summary>Grouped assignment design (arms, draws, phases)</summary><p>Optional. Arms group conditions. A draw groups the tasks that share one factor level under one condition and replicate. Phases split the replicates in order and may limit factor levels. Every schedule row is labelled, and every trial a phase leaves unscheduled is listed. This changes description and planned arm contrasts only, never how a trial runs.</p><div data-bench-design-fields-editor></div><textarea data-bench-design-fields hidden aria-label="Retained design field draft"></textarea><p data-bench-design-fields-status role="status"></p><button type="button" data-bench-apply-design>Apply design fields</button><details><summary>Advanced design plan (JSON)</summary><label>Design plan (JSON; null for the plain crossed schedule)<textarea data-bench-design-plan rows="10" spellcheck="false"></textarea></label><button type="button" data-bench-apply-design-json>Apply design JSON</button></details></details>
    </div>
    <div data-bench-panel="run" hidden>
      <div class="bench-review" data-bench-review></div>
      <section class="bench-run-step"><h3><span class="bench-run-n">1</span>Freeze</h3>
      <p>Each task is crossed with every condition. Replicates are repeated measurements of that task; they do not create new independent tasks. The supported primary endpoint is a binary result over the declared scheduled population.</p>
      <div class="bench-columns"><label>Execution purpose<select data-bench-execution-purpose><option value="experiment">Experiment with required controls</option><option value="recorded-diagnostic">Recorded answer-key diagnostic</option><option value="apparatus-development">Test unfinished apparatus</option></select></label><label>Dependence treatment<select data-bench-execution-dependence><option value="descriptive-only">Descriptive results, no intervals</option><option value="family-clusters">Resample declared task families</option></select></label></div>
      <button type="button" data-bench-apply-execution>Apply execution design</button><p data-bench-execution-status></p>
      <div class="bench-toolbar"><button type="button" class="bench-primary" data-bench-freeze>Freeze project</button></div><p data-bench-frozen role="status">Freeze the current specification to inspect its exact tasks and schedule.</p><div data-bench-readiness aria-live="polite"></div><div data-bench-handoff aria-live="polite"></div>
      <div data-bench-frozen-details></div><details class="bench-run-fold"><summary>Frozen tasks and schedule</summary><div data-bench-frozen-inspection></div></details>
      </section>
      <section class="bench-run-step"><h3><span class="bench-run-n">2</span>Start</h3>
      <div class="bench-toolbar"><button type="button" data-bench-run disabled>Run recorded responses here</button><button type="button" data-bench-cancel disabled>Cancel run</button><button type="button" data-bench-export disabled>Export runnable ZIP</button></div>
      <p>Recorded-response studies run in this page. A study with a live collector runs from its exported project. Export and extract it. With a pipeline attached, run <code>node harness/canary.mjs</code> first, then <code>node cli.mjs run</code>. You can also submit the extracted project to the run board. The command and this page use the same runner and grader.</p>
      <details class="bench-run-fold" open><summary>Submit the exported project to the run board</summary><label>Extracted project directory<input data-bench-directory placeholder="Full directory path on the run computer"></label><label>Node command<input data-bench-node value="node"></label><button type="button" data-bench-submit>Submit exported project</button><p>The existing run service executes the exported CLI and collects its summary. Its normal process permissions and input checks apply.</p></details>
      </section>
      <section class="bench-run-step"><h3><span class="bench-run-n">3</span>Watch</h3>
      <p data-bench-run-live role="status">No run is in progress on this page.</p>
      <div class="bench-toolbar"><button type="button" data-bench-watch-runs>Open the run board</button></div>
      <p>A submitted project reports on the run board beneath this builder, cell by cell, as it happens. Results land here when the in-page run finishes or its evidence is imported.</p>
      <div class="bench-toolbar"><label class="bench-file">Import run evidence<input data-bench-import-evidence type="file" accept=".json,application/json"></label><button type="button" data-bench-export-evidence disabled>Export evidence</button><button type="button" data-bench-export-csv disabled>Export results CSV</button><button type="button" data-bench-export-report disabled>Export research report</button></div><div data-bench-results></div>
      </section>
      <details class="bench-run-more"><summary>More: native control projects and artifact verification</summary>
      <section aria-label="Generated native control projects"><h3>Export a native control project</h3>
        <p>Freeze a declared native preparation plan, select one generated reference or mutant, then export its runnable apparatus-development project. Each control must match its own exact expected observation. Mutant agreement and discrimination from its baseline are separate checks; neither a failed run nor a cross-contract refusal proves discrimination. No controls have been executed by this page.</p>
        <label>Frozen control job<select data-bench-native-control-job><option value="">Freeze a native plan first</option></select></label>
        <button type="button" data-bench-export-native-control disabled>Export selected control ZIP</button>
        <p data-bench-native-control-status></p>
      </section>
      <section aria-label="Native artifact verification"><h3>Verify retained native artifacts</h3>
        <p>After a modern version-2 LEAN apparatus run, use <code>node cli.mjs verify-native</code> in its project directory. Import the resulting <code>results/native-evidence.json</code> here with the matching project frozen. This checks the retained source, candidate, configuration, process record and reconstructed grade. It runs no candidate or grader.</p>
        <p>Artifact consistency does not establish native execution, preparation, qualification or experimental admission. Signals, timeouts and invalid engine results need additional evidence and are not supported by this verifier. Legacy audit archives keep their existing import flow.</p>
        <div class="bench-toolbar"><label class="bench-file">Verify native evidence<input data-bench-import-native-evidence type="file" accept=".json,application/json"></label><button type="button" data-bench-export-native-verification disabled>Export verification receipt</button></div>
        <p data-bench-native-verification role="status">No native artifact verification is loaded. Ordinary journal imports do not verify native artifact bytes.</p><div data-bench-native-verification-details></div>
      </section>
      </details>
    </div>
  </section>`)
  const resourceEl = el('<section class="research-section bench" data-mc="resource"><div class="research-section-head"><h2>Resource action</h2><p>Build resource-state experiments from cases, permissions and requested changes.</p></div></section>')
  if (separateResource) {
    const panel = root.querySelector('[data-bench-panel="experiment"]')
    panel.removeAttribute('data-bench-panel'); panel.hidden = false; resourceEl.append(panel)
    resourceEl.addEventListener('click', event => { if (event.target.closest('[data-bench-apply-resource-template]')) operate(ticket => perform(event, ticket)) })
  }
  const projectEl = el('<div class="benchmark-builder research-project-content"><p data-bench-project-status role="status"></p></div>')
  if (separateProject) {
    projectEl.prepend(root.querySelector('.bench-start-sections'))
    projectEl.addEventListener('click', event => { if (event.target.closest('[data-bench-use-starter]')) operate(ticket => perform(event, ticket)) })
  }
  const q = selector => root.querySelector(selector) || resourceEl.querySelector(selector) || projectEl.querySelector(selector)
  const field = name => q(`[data-bench-${name}]`)
  let spec = emptyDraft(), attachments = {}, frozen = null, openedArchive = null, evidence = null, taskIndex = 0, bundleIndex = 0
  let project = 'unfiled', source = null, epoch = 0, previewEpoch = 0, bundleEpoch = 0, disposed = false, running = null, dirty = false, backup = null
  const drafts = new Map(), pending = new Set(), branches = new Map()
  let operation = null, loading = false, renderedTask = null
  let draftOrigin = 'Empty draft.'
  let nativeVerification = null
  let preparedInformation = null
  let informationInventory = null, informationInventoryContext = null
  let requirementInventory = null
  let compositionInventory = null
  let familyInventory = null, familySelected = '', familyReadOnly = false
  let preparedAudits = new Map()
  const status = message => { if (!disposed) { field('status').textContent = message; field('project-status').textContent = message } }
  const resourceEditor = createResourceTemplateEditor({ onChange: draft => {
    if (disposed || loading || operation || running) return
    field('resource-fields').value = json(draft); pending.add('experiment'); changed()
    field('resource-status').textContent = 'Experiment fields changed. Generate the experiment to apply them before freezing.'
  } })
  field('resource-editor').append(resourceEditor.el)
  field('resource-fields').value = json(defaultResourceTemplateFields())
  const informationDraft = () => field('information-fields').value ? parse(field('information-fields').value, 'Information fields') : null
  const informationContext = () => canonical({ spec, taskId: spec.tasks[taskIndex]?.id })
  const informationEditor = createInformationFieldsEditor({ onChange: draft => {
    if (disposed || loading || operation || running) return
    field('information-fields').value = json(draft); pending.add('informationFields'); changed()
    field('information-fields-status').textContent = 'Information fields changed. Build the treatment before preparing its review packet or freezing.'
  } })
  field('information-fields-editor').append(informationEditor.el)
  function renderInformationFields() {
    let draft = null, error = null
    try { draft = informationDraft() } catch (caught) { error = caught.message }
    const stale = !!draft && (!informationInventory || informationInventoryContext !== informationContext())
    informationEditor.setContext(informationInventory, draft, { stale })
    field('information-fields-status').textContent = error || (!draft ? 'Prepare fields for the selected task; existing advanced readings remain available below.'
      : stale ? 'Retained fields need inspection against the current task and setup. Prepare to inspect them; replace them explicitly if their source changed.'
        : 'Fields describe the applied source task. Build the treatment to validate every reading; this creates no review or execution evidence.')
  }
  const requirementEditor = createRequirementFieldsEditor({ onChange: draft => {
    if (disposed || loading || operation || running) return
    field('requirement-fields').value = json(draft); pending.add('requirementFields'); changed()
    field('requirement-fields-status').textContent = 'Control fields changed. Generate the qualification plan before freezing.'
  } })
  field('requirement-fields-editor').append(requirementEditor.el)
  const requirementDraft = () => field('requirement-fields').value ? parse(field('requirement-fields').value, 'Requirement control fields') : null
  const compositionEditor = createCompositionFieldsEditor({ onChange: draft => {
    if (disposed || loading || operation || running) return
    field('composition-fields').value = json(draft); pending.add('compositionFields'); changed()
    field('composition-fields-status').textContent = 'Occurrence fields changed. Build their task recipe before generating tasks.'
  } })
  field('composition-fields-editor').append(compositionEditor.el)
  const compositionDraft = () => field('composition-fields').value ? parse(field('composition-fields').value, 'Composition fields') : null
  const conditionDraft = () => field('condition-fields').value ? parse(field('condition-fields').value, 'Condition fields') : null
  const conditionEditor = createConditionFieldsEditor({ onChange: draft => {
    if (disposed || loading || operation || running) return
    field('condition-fields').value = json(draft); pending.add('conditionFields'); changed()
    field('condition-fields-status').textContent = 'Condition fields changed. Apply the complete setup before freezing.'
    renderConditionPreview()
  } })
  field('condition-fields-editor').append(conditionEditor.el)
  const routingEditor = createRoutingEditor({
    surface: 'tasks',
    onChange: draft => {
      if (disposed || loading || operation || running) return
      field('routing').value = json(draft); changed()
      field('routing-status').textContent = 'Routing changed. Generate tasks to put it into this benchmark.'
    },
    // A unique working name keeps the new arrangement reachable in the library.
    onCapture: () => {
      if (disposed || loading || operation || running) return
      if (!spec.tasks[taskIndex]) { field('routing-status').textContent = 'There is no task to copy yet. Add a composition and choose its snippets directly.'; return }
      let draft = null
      try { draft = routingDraft() } catch (error) { field('routing-status').textContent = error.message; return }
      /* PROMPT B. There is no prepare step to send anyone to any more: the
         rules seed themselves from the open task. Reaching here means there
         are none to add to, which is emptying the advanced JSON box or
         having no task open, so the message names those instead. */
      if (!draft) { field('routing-status').textContent = 'There are no rules here to copy into. Press Start these rules again to build a set from the task open above.'; return }
      let index = 1
      while (draft.compositions.some(item => item.name === `Untitled composition ${index}`)) index++
      const name = `Untitled composition ${index}`
      draft.compositions.push({ name, node: structuredClone(spec.tasks[taskIndex].root) })
      field('routing').value = json(draft); changed(); renderRouting()
      status('Task copied into a new composition. Rename it and edit its connections here.')
    },
  })
  field('routing-editor').append(routingEditor.el)
  const compositionGenerator = createCompositionGenerator({
    onDraft: state => {
      if (!disposed && !loading && !operation && !running) { field('composition-generation-draft').value = json(state); dirty = true }
    },
    onPreview: async form => {
      requireApplied(['bundle', 'specification'])
      const ticket = epoch, draft = routingDraft(), binding = compositionGenerationBinding(spec.catalog, draft)
      const prepared = await previewCompositionGeneration(spec.catalog, draft, form)
      assertCurrent(ticket)
      invariant(binding === compositionGenerationBinding(spec.catalog, routingDraft()), 'The snippets or saved compositions changed. Generate a fresh preview.')
      return prepared
    },
    onSave: (prepared, selections) => nestingAction(async ticket => {
      requireApplied(['bundle', 'specification'])
      const built = saveGeneratedCompositions(spec.catalog, routingDraft(), prepared, selections)
      assertCurrent(ticket)
      backup = snapshot(); field('undo').hidden = false
      spec.catalog = built.catalog; field('routing').value = json(built.draft)
      changed(); renderBundle(); renderRouting()
      status(`${built.count} reviewed compositions saved. Use them below or as members in Nesting.`)
      return { ok: true, count: built.count }
    }),
  })
  field('composition-generator').append(compositionGenerator.el)
  const nestingEditor = createNestingEditor({
    onVariance: name => beginVariance({ kind: 'composition', id: name }),
    onChange: draft => {
      if (disposed || loading || operation || running) return
      field('routing').value = json(draft); changed()
      routingEditor.setContext({ catalog: spec.catalog, draft })
      field('routing-status').textContent = 'Saved compositions changed. Generate tasks to use the new connections.'
    },
    onDraft: state => {
      if (disposed || loading || operation || running) return
      field('nesting-draft').value = json(state); dirty = true
    },
    onPreview: async ({ name, form }) => {
      const ticket = epoch
      const built = form ? buildNesting(routingDraft(), spec.catalog, form) : { draft: routingDraft(), catalog: spec.catalog, name }
      const task = { id: 'nesting-preview', root: expandComposition(built.name, built.draft, { catalog: built.catalog }), input: null, expected: null, split: 'development' }
      const result = await compileTask({ ...spec, catalog: built.catalog }, task, { requireReview: false, requireTaskReview: false, validateExpected: false })
      assertCurrent(ticket)
      return result.compiled
    },
    onSave: form => nestingAction(async ticket => {
      requireApplied(['bundle'])
      const built = buildNesting(routingDraft(), spec.catalog, form)
      const task = { id: 'nesting-preview', root: expandComposition(built.name, built.draft, { catalog: built.catalog }), input: null, expected: null, split: 'development' }
      await compileTask({ ...spec, catalog: built.catalog }, task, { requireReview: false, requireTaskReview: false, validateExpected: false })
      assertCurrent(ticket)
      backup = snapshot(); field('undo').hidden = false
      spec.catalog = built.catalog; field('routing').value = json(built.draft)
      changed(); renderBundle(); renderRouting()
      status(`Composition ${built.name} saved. Add it as a task or choose it in task-generation rules. Existing tasks are retained.`)
      return { ok: true, name: built.name }
    }),
    // A nested RUN: one wrapper, many compositions, like a composition run.
    onPreviewRun: async form => {
      requireApplied(['bundle'])
      const ticket = epoch
      const prepared = await previewNestingRun(routingDraft(), spec.catalog, form)
      assertCurrent(ticket)
      return prepared
    },
    // One row of a nested run, compiled as it would be saved: the run's wrapper
    // joins the catalog for the compile only, and the row's node stands in as a
    // composition, so a snippet member and a set member read the same way.
    onPreviewRow: async (prepared, row) => {
      const ticket = epoch, catalog = [...spec.catalog, prepared.wrapper], draft = routingDraft()
      const probe = '__nesting_row_preview__'
      draft.compositions.push({ name: probe, node: structuredClone(row.node) })
      const task = { id: 'nesting-preview', root: expandComposition(probe, draft, { catalog }), input: null, expected: null, split: 'development' }
      const result = await compileTask({ ...spec, catalog }, task, { requireReview: false, requireTaskReview: false, validateExpected: false })
      assertCurrent(ticket)
      return result.compiled
    },
    onSaveRun: (prepared, selections) => nestingAction(async ticket => {
      requireApplied(['bundle'])
      const built = saveNestingRun(routingDraft(), spec.catalog, prepared, selections)
      assertCurrent(ticket)
      backup = snapshot(); field('undo').hidden = false
      spec.catalog = built.catalog; field('routing').value = json(built.draft)
      changed(); renderBundle(); renderRouting()
      status(`Nested set ${built.name} saved: ${built.count} compositions. Route rows to them or select them in the task set.`)
      return { ok: true, name: built.name, count: built.count }
    }),
    onTask: name => nestingAction(async ticket => {
      requireApplied(['bundle', 'task', 'input', 'information'])
      invariant(!spec.corpusPlan, 'Detach the task recipe before adding a manual task, or add this composition through that recipe.')
      invariant(spec.tasks.length < 512, 'This project already has 512 tasks.')
      let i = 1; while (spec.tasks.some(task => task.id === `nested-task-${i}`)) i++
      const task = { id: `nested-task-${i}`, root: expandComposition(name, routingDraft(), { catalog: spec.catalog }), input: null, expected: null, split: 'development' }
      await compileTask(spec, task, { requireReview: false, requireTaskReview: false, validateExpected: false })
      assertCurrent(ticket)
      backup = snapshot(); field('undo').hidden = false
      spec.tasks.push(task); taskIndex = spec.tasks.length - 1; changed(); renderTask()
      status(`Added ${task.id} from ${name}. Existing tasks were kept. Declare its expected result and study settings before running.`)
      return { ok: true }
    }),
  })
  field('nesting-editor').append(nestingEditor.el)
  // The by-hand tree editor, under Build task set: the routing editor's
  // composition surface, pointed at one saved composition at a time.
  let treeSelected = ''
  const treeEditor = createRoutingEditor({ surface: 'composition', onChange: (draft, selected) => {
    if (disposed || loading || operation || running) return
    field('routing').value = json(draft); changed()
    routingEditor.setContext({ catalog: spec.catalog, draft })
    treeSelected = selected || treeSelected
    renderNesting(draft); renderTreeEditor(draft)
    field('routing-status').textContent = 'Saved compositions changed. Generate tasks to use the new connections.'
  } })
  field('tree-editor').append(treeEditor.el)
  function renderTreeEditor(draft = null) {
    if (!draft) try { draft = routingDraft() } catch { draft = null }
    const names = (draft?.compositions || []).map(item => item.name).filter(Boolean)
    if (!names.includes(treeSelected)) treeSelected = names[0] || ''
    field('tree-composition').innerHTML = names.length ? names.map(name => `<option value="${esc(name)}"${name === treeSelected ? ' selected' : ''}>${esc(name)}</option>`).join('') : '<option value="">No saved compositions yet</option>'
    treeEditor.setContext({ catalog: spec.catalog, draft, selected: treeSelected })
  }
  field('tree-fold').addEventListener('change', event => {
    if (event.target !== field('tree-composition')) return
    event.stopPropagation(); treeSelected = event.target.value; renderTreeEditor()
  })
  field('tree-fold').addEventListener('click', event => {
    const button = event.target.closest('[data-nest-from-snippets]')
    if (!button || disposed || loading || operation || running) return
    event.stopPropagation()
    let draft = null
    try { draft = routingDraft() } catch (error) { field('routing-status').textContent = error.message; return }
    draft ||= createRoutingDraft()
    treeEditor.setContext({ catalog: spec.catalog, draft, selected: treeSelected }); treeEditor.addComposition()
  })
  const varianceStudies = () => field('variance-draft').value ? parse(field('variance-draft').value, 'Variance studies').studies || [] : []
  const preparedRecipe = () => field('corpus-plan').value ? parse(field('corpus-plan').value, 'Advanced generation') : null
  const poolBinding = () => promptSetBinding(spec, routingDraft(), varianceStudies(), preparedRecipe())
  const promptSetEditor = createPromptSetEditor({
    onDraft: state => { if (!disposed && !loading && !operation && !running) { field('prompt-set-draft').value = json(state); dirty = true } },
    onInspect: async state => {
      const ticket = epoch, binding = poolBinding()
      requireApplied(['bundle', 'task', 'input', 'information', 'specification'])
      const result = await preparePromptSet(spec, routingDraft(), varianceStudies(), state, preparedRecipe())
      assertCurrent(ticket); invariant(binding === poolBinding(), 'The prompt sources changed. Refresh the pool.')
      return { ...result, binding }
    },
    onGenerate: (plan, binding, construction) => nestingAction(async ticket => {
      requireApplied(Object.keys(EDITOR_GROUPS).filter(group => group !== 'corpus'))
      invariant(binding === poolBinding(), 'The prompt sources changed. Refresh the pool before generating.')
      const next = structuredClone(spec); next.corpusPlan = plan
      if (construction) next.corpusHistory = [...(next.corpusHistory || []), { kind: 'detached-recipe', recipe: construction.recipe }]
      const generated = await materializeCorpus(next); assertCurrent(ticket)
      invariant(generated.manifest.status === 'ready', generated.manifest.allocation?.issues.join(' ') || 'The selection is unavailable. Refresh the prompt pool and choose the task sources again.')
      next.tasks = generated.tasks; next.conditions = resetRecordedResponses(next.conditions)
      const retained = editorSnapshot(['routing', 'composition-generation-draft', 'nesting-draft', 'variance-draft', 'prompt-set-draft', 'composition-fields', 'composition-family-fields'])
      const selectionDraft = retained['data-bench-prompt-set-draft'] ? parse(retained['data-bench-prompt-set-draft'], 'Task-set selection') : {}
      retained['data-bench-prompt-set-draft'] = json({ ...selectionDraft, source: 'retained', studies: [] })
      replace(next, attachments); applyEditors(retained); field('corpus-ledger').textContent = json(generated.manifest)
      status(`${generated.tasks.length} tasks generated from ${generated.manifest.eligibleCount} available prompts. The full pool, selection and exclusions are retained and checked at export.`)
      return { ok: true, count: generated.tasks.length }
    }),
    onPrompt: async task => {
      const ticket = epoch
      const result = await compileTask(spec, task, { requireReview: false, requireTaskReview: false, validateExpected: false })
      assertCurrent(ticket); return result.compiled.text
    },
    onDownload: ledger => download('prompt-selection-ledger.json', json(ledger), 'application/json'),
  })
  field('prompt-set-editor').append(promptSetEditor.el)
  const varianceEditor = createVarianceEditor({
    onDraft: state => {
      if (disposed || loading || operation || running) return
      field('variance-draft').value = json(state); dirty = true
    },
    onSnippet: async id => { const ticket = epoch; const result = await snippetText(spec, id); assertCurrent(ticket); return result },
    onPreviewRun: async run => {
      const ticket = epoch
      requireApplied(['bundle'])
      const result = await previewVarianceRun(spec, routingDraft(), run); assertCurrent(ticket); return result
    },
    // One variant row compiled with the run's new snippets and templates, beside
    // its untouched source, with the omitted words of a snippet marked.
    onPreviewRow: async (prepared, row) => {
      const ticket = epoch, catalog = [...spec.catalog, ...prepared.bundles]
      const compiled = await compilePrompt(catalog, row.node, { requireReview: false })
      const original = await compilePrompt(spec.catalog, expandComposition(row.source, routingDraft(), { catalog: spec.catalog }), { requireReview: false })
      assertCurrent(ticket)
      const omitted = []
      for (const range of original.sourceMap || []) {
        const bundle = spec.catalog.find(item => item.id === range.bundleId)
        const variant = prepared.bundles.find(item => item.variance?.sourceBundle === range.bundleId && item.kind === 'atom')
        if (!bundle) continue
        if (variant && JSON.stringify(row.node).includes(`"${variant.id}"`)) for (const mark of variant.variance.marks || []) omitted.push({ start: range.start + mark.start, end: range.start + mark.end })
        else if (bundle.kind === 'atom' && !JSON.stringify(row.node).includes(`"${bundle.id}"`) && JSON.stringify(expandComposition(row.source, routingDraft(), { catalog: spec.catalog })).includes(`"${bundle.id}"`)) omitted.push({ start: range.start, end: range.end })
      }
      return { text: compiled.text, original: original.text, omitted }
    },
    onSaveRun: (prepared, selections) => nestingAction(async ticket => {
      requireApplied(['bundle'])
      const built = await saveVarianceRun(spec, routingDraft(), prepared, selections); assertCurrent(ticket)
      backup = snapshot(); field('undo').hidden = false
      spec.catalog = built.catalog; field('routing').value = json(built.draft)
      changed(); renderBundle(); renderRouting()
      status(`Variant set ${built.name} saved: ${built.count} compositions. Build task set can draw from it.`)
      return { ok: true, name: built.name, count: built.count, bundles: built.bundles }
    }),
  })
  field('variance-editor').append(varianceEditor.el)
  // Protocol decisions of record: the structured state is retained in a hidden
  // editor; the composed text is what Apply protocol freezes as spec.decisions.
  const protocolEditor = createProtocolEditor({ onChange: state => {
    field('protocol-decisions').value = json(state); field('decisions').value = decisionsText(state)
    pending.add('protocol'); changed()
  } })
  field('protocol-editor').append(protocolEditor.el)
  // The pipeline draft: retained beside the decisions; generating writes
  // conditions and harness files, the draft itself changes nothing frozen.
  const currentPipelineSettings = () => pipelineSettings(protocolEditor.value(), { timeoutMs: Math.round(Number(field('timeout').value) * 1000) })
  const pipelineEditor = createPipelineEditor({ onChange: draft => { field('pipeline-draft').value = json(draft); dirty = true }, settings: currentPipelineSettings,
    onOpenJudges: () => { selectTab('audit'); field('judge-editor').scrollIntoView?.({ block: 'start' }) },
    onOpenPipeline: () => { selectTab('protocol'); field('pipeline-editor').scrollIntoView?.({ block: 'start' }) },
  })
  field('pipeline-editor').append(pipelineEditor.el)
  field('judge-editor').append(pipelineEditor.judgesEl)
  /* REVIEW. The run tab opens with everything the study is, read only: change
     it on its own page. Rendered from the applied draft, the retained page
     drafts, the pending set and the frozen project. */
  const PURPOSE_LABEL = { experiment: 'Experiment with required controls', 'recorded-diagnostic': 'Recorded answer-key diagnostic', 'apparatus-development': 'Test unfinished apparatus' }
  function renderReview() {
    const host = field('review'); if (!host || !spec) return
    const p = spec.protocol || {}, purpose = spec.executionPlan?.purpose || 'unset'
    const atoms = spec.catalog.filter(bundle => bundle.kind === 'atom').length, templates = spec.catalog.length - atoms
    let compositions = 0, sets = []
    try {
      const routing = routingDraft(); compositions = (routing?.compositions || []).length
      const selection = field('prompt-set-draft').value ? parse(field('prompt-set-draft').value, 'Task set') : null
      if (selection?.source === 'sets') { const all = promptSetSources(routing, spec.catalog); sets = (selection.sets || []).map(name => ({ name, count: all.find(set => set.name === name)?.members.length ?? null })) }
    } catch { /* an unfinished retained draft is not a review error */ }
    let decisions = emptyProtocolDecisions()
    try { decisions = normalizeProtocolDecisions(field('protocol-decisions').value ? parse(field('protocol-decisions').value, 'Decisions') : null) } catch {}
    const made = decidedCount(decisions), settings = settingsCount(decisions)
    let pipeline = null
    try { pipeline = field('pipeline-draft').value ? parse(field('pipeline-draft').value, 'Pipeline') : null } catch {}
    const harness = Object.keys(attachments).filter(path => path.startsWith('harness/'))
    const analysis = spec.analysisPlan, unapplied = [...pending]
    let readiness = ''
    if (frozen) { try { const decision = evaluateReadiness(frozen, { operation: executionOperation(frozen) }); readiness = decision.eligible ? 'Available for its declared purpose.' : `Blocked by ${decision.blockers.length} requirement${decision.blockers.length === 1 ? '' : 's'}: ${decision.blockers.slice(0, 3).map(row => row.code).join(', ')}${decision.blockers.length > 3 ? ', …' : ''}. The readiness detail is under Freeze.` } catch (error) { readiness = error.message } }
    const conditions = spec.conditions.length ? `<ul>${spec.conditions.map(condition => `<li><code>${esc(condition.id)}</code> · ${esc(condition.adapter?.kind || '?')}${condition.model ? ` · ${esc(condition.model.id || condition.model.provider || '')}${condition.model.surface ? ' on ' + esc(condition.model.surface) : ''}${condition.model.settings?.effort ? ' · ' + esc(condition.model.settings.effort) : ''}` : ''}</li>`).join('')}</ul>` : 'None declared. Add them on the Protocol page, Decisions & pipeline.'
    host.innerHTML = `<h3>Review</h3><p class="bench-review-intro">What this study is, as it stands. Nothing here edits; change a thing on its own page.</p>
      <dl class="bench-review-grid">
        <div><dt>Study</dt><dd>${esc(spec.name)} · <code>${esc(spec.id)}</code>${spec.version ? ' · v' + esc(spec.version) : ''} · ${esc(spec.domain || 'generic')}<br>Purpose: ${esc(PURPOSE_LABEL[purpose] || purpose)}${spec.requireReview ? ' · snippet reviews required' : ''}</dd></div>
        <div><dt>Prompts</dt><dd>${spec.tasks.length} tasks · ${compositions} compositions · ${atoms} snippets, ${templates} templates${sets.length ? '<br>Sets in the task set: ' + sets.map(set => `${esc(set.name)} (${set.count ?? '?'})`).join(', ') : ''}</dd></div>
        <div><dt>Conditions</dt><dd>${conditions}</dd></div>
        <div><dt>Schedule and budgets</dt><dd>seed ${esc(p.seed)} · ${esc(p.replicates)} replicates · ${esc(p.maxAttemptsPerTrial)} attempts per trial · ${esc(p.maxTotalAttempts)} in total · ${Number(p.timeoutMs) / 1000} s per attempt · ${Math.round(Number(p.maxDurationMs) / 60000)} min for the study · grading ${esc(p.grading?.kind || '?')}</dd></div>
        <div><dt>Decisions of record</dt><dd>${made.decided} of ${made.total} decisions made · ${settings.total} settings${settings.changed ? `, ${settings.changed} changed from the defaults` : ' at their defaults'}${spec.decisions ? `<br><span class="bench-review-quote">${esc(spec.decisions.slice(0, 180))}${spec.decisions.length > 180 ? '…' : ''}</span>` : ''}</dd></div>
        <div><dt>Pipeline</dt><dd>${pipeline?.rows?.length ? pipeline.rows.map(row => `${esc(row.surface)} · ${esc(row.model || '?')} · ${esc((row.efforts || []).join('/'))}`).join('; ') : 'No pipeline rows.'}${harness.length ? `<br>Harness attached: ${harness.length} files` : ''}</dd></div>
        <div><dt>Analysis</dt><dd>${analysis ? `cohort ${esc(analysis.cohort)} · denominator ${esc(analysis.primaryDenominator)} · ${analysis.uncertainty ? esc(analysis.uncertainty.kind) : 'no intervals'} · multiplicity ${esc(analysis.multiplicity)}${analysis.contrasts?.length ? ` · ${analysis.contrasts.length} contrasts` : ''}` : 'No analysis plan applied.'}</dd></div>
        <div><dt>Unapplied edits</dt><dd>${unapplied.length ? `<b>${esc(unapplied.join(', '))}</b> · apply them on their tabs before freezing` : 'None'}</dd></div>
        <div><dt>Frozen</dt><dd>${frozen ? `${frozen.tasks.length} tasks · ${frozen.schedule.length} trials · <code>${frozen.sha256.slice(0, 12)}</code><br>${esc(readiness)}` : 'Not frozen yet; the draft is not fixed.'}</dd></div>
      </dl>`
  }
  function renderPipeline() {
    let draft = null
    try { draft = field('pipeline-draft').value ? parse(field('pipeline-draft').value, 'Pipeline draft') : null } catch {}
    pipelineEditor.set(draft)
  }
  function renderProtocolDecisions() {
    let state = null
    try { state = field('protocol-decisions').value ? normalizeProtocolDecisions(parse(field('protocol-decisions').value, 'Protocol decisions')) : null } catch {}
    // A draft from before this page, or decisions text replaced elsewhere
    // (a starter, the full specification): the text becomes the notes and
    // every field starts undecided. Pending edits are never discarded.
    const current = field('decisions').value
    if (!state || (!pending.has('protocol') && !matchesDecisionsText(state, current))) {
      const previous = state ? previousProtocolEntries(state) : []
      state = emptyProtocolDecisions(); state.notes = current
      for (const { field: prior, value } of previous) state.values[prior.id] = value
    }
    protocolEditor.set(state)
  }
  function beginVariance(source) {
    renderVariance(); field('variance-draft').value = json(varianceEditor.startSource(source)); dirty = true; selectTab('variance')
  }
  async function nestingAction(action) {
    let result
    await operate(async ticket => {
      try { result = await action(ticket) }
      catch (error) { result = { ok: false, error: error.message }; throw error }
    })
    return result || { ok: false, error: 'Wait for the current action to finish.' }
  }
  // Typed endpoint fields: the hidden textarea is the retained draft (an
  // ordinary analysis editor value), the component is its labeled face.
  const endpointEditor = createEndpointFieldsEditor({ onChange: rows => {
    field('endpoint-fields').value = json(rows); pending.add('analysis'); changed()
    field('endpoint-fields-status').textContent = 'Endpoint fields changed. Apply the analysis plan before freezing.'
  } })
  field('endpoint-fields-editor').append(endpointEditor.el)
  function syncEndpointFields() {
    // A change that came from the editor itself is already on screen; rebuilding
    // it would replace the focused input under the person's keystrokes.
    if (field('endpoint-fields').value === json(endpointEditor.getRows())) return
    try { endpointEditor.setRows(field('endpoint-fields').value ? parse(field('endpoint-fields').value, 'Endpoint fields') : []); }
    catch (error) { field('endpoint-fields-status').textContent = error.message }
  }
  // Grouped assignment design fields: same retained-draft pattern; the JSON
  // editor beneath them remains the advanced path.
  const designEditor = createDesignFieldsEditor({ onChange: rows => {
    field('design-fields').value = json(rows); pending.add('design'); changed()
    field('design-fields-status').textContent = 'Design fields changed. Apply the design before freezing.'
  } })
  field('design-fields-editor').append(designEditor.el)
  function syncDesignFields() {
    // The editor's own setContext no-ops when the conditions/factors are
    // unchanged, so calling it unconditionally never disturbs a focused
    // input; it must run even when the design rows below compare equal
    // (for example a freshly loaded project with no design plan), or the
    // arm-condition checkboxes and phase factor lists would keep whichever
    // project was mounted before this one.
    designEditor.setContext({ conditionIds: spec.conditions.map(condition => condition.id), factors: [...new Set(spec.tasks.flatMap(task => Object.keys(task.factors || {})))].sort() })
    // A change that came from the editor itself is already on screen; rebuilding
    // it would replace the focused input under the person's keystrokes.
    if (field('design-fields').value === json(designEditor.getRows())) return
    try { designEditor.setRows(field('design-fields').value ? parse(field('design-fields').value, 'Design fields') : null) }
    catch (error) { field('design-fields-status').textContent = error.message }
  }
  function conditionContext() {
    return { spec: applyIdentity({ ...spec }), protocolFields: protocolEditorFields({ requireComplete: true }),
      workflow: parse(field('workflow-config').value, 'Workflow draft'), observationPlan: parse(field('observation-plan').value, 'Accounting plan'),
      sourceText: { conditions: field('conditions').value, workflow: field('workflow-config').value, observations: field('observation-plan').value } }
  }
  function routingDraft() {
    const raw = field('routing').value.trim()
    return raw ? parse(raw, 'Routing draft') : null
  }
  function renderRouting() {
    let draft = null, error = ''
    try { draft = routingDraft() } catch (caught) { error = caught.message }
    /* PROMPT B. ROUTING IS THE FIRST THING ON THIS PANEL, so it has to be on
       the glass when a person arrives rather than behind a prepare step. The
       seed is the task they already have, which is exactly what the prepare
       button used to build; nothing is chosen for them beyond that. */
    if (!draft && !error && (spec?.tasks?.[taskIndex] || spec.catalog.length)) {
      draft = createRoutingDraft(spec.tasks[taskIndex])
      field('routing').value = json(draft)
    }
    routingEditor.setContext({ catalog: spec.catalog, draft })
    renderCompositionGenerator(draft)
    renderNesting(draft)
    renderTreeEditor(draft)
    renderVariance(draft)
    renderPromptSet()
    field('routing-status').textContent = error
  }
  function renderCompositionGenerator(draft = routingDraft()) {
    let state = null
    try { state = field('composition-generation-draft').value ? parse(field('composition-generation-draft').value, 'Composition generation') : null } catch {}
    compositionGenerator.setContext({ catalog: spec.catalog, routing: draft, state, contextKey: `${source}:${project}:${epoch}` })
  }
  function renderNesting(draft = routingDraft()) {
    let state = null
    try { state = field('nesting-draft').value ? parse(field('nesting-draft').value, 'Nesting draft') : null } catch {}
    nestingEditor.setContext({ catalog: spec.catalog, draft, state, contextKey: `${source}:${project}:${epoch}` })
  }
  function renderVariance(draft = routingDraft()) {
    let state = null
    try { state = field('variance-draft').value ? parse(field('variance-draft').value, 'Variance studies') : null } catch {}
    varianceEditor.setContext({ spec, routing: draft, state, active: !root.querySelector('[data-bench-panel="variance"]').hidden, contextKey: `${source}:${project}:${epoch}` })
  }
  function renderPromptSet() {
    let state = null
    try { state = field('prompt-set-draft').value ? parse(field('prompt-set-draft').value, 'Task-set selection') : null } catch {}
    let sets = []
    try { sets = promptSetSources(routingDraft(), spec.catalog) } catch {}
    promptSetEditor.setContext({ spec, state, studies: varianceStudies(), sets, active: !root.querySelector('[data-bench-panel="corpus"]').hidden, contextKey: `${source}:${project}:${epoch}` })
  }
  function renderConditionFields() {
    let context = null, draft = null, error = null
    try { draft = conditionDraft(); if (draft) context = conditionContext() } catch (caught) { error = caught.message }
    let stale = !!draft && !context
    if (draft && context) try { stale = draft.binding !== conditionFieldsBinding(context) } catch (caught) { stale = true; error = caught.message }
    conditionEditor.setContext({ context, draft, contextKey: `${source}:${project}:${epoch}`, stale, readOnly: false })
    field('condition-fields-status').textContent = error || (stale ? 'The setup changed after these fields were prepared. Your field text is retained; prepare again explicitly before applying.'
      : draft ? 'Prepared fields retain requested values and explicit response checks. Apply the setup to validate it.' : 'Prepare fields to edit recorded or HTTPS conditions. Advanced JSON remains available.')
    renderConditionPreview()
  }
  function renderConditionPreview() {
    try {
      const draft = conditionDraft()
      if (!draft) { field('condition-fields-preview').textContent = 'Prepare condition fields to inspect their proposed setup.'; return }
      const setup = compileConditionFields(conditionContext(), draft)
      field('condition-fields-preview').textContent = json({ conditions: setup.protocolFields.conditions, workflowAssignments: setup.workflow.assignments, accounting: setup.observationPlan })
    } catch (error) { field('condition-fields-preview').textContent = error.message }
  }
  const familyDraft = () => field('composition-family-fields').value ? parse(field('composition-family-fields').value, 'Composition family workspace') : null
  const familyEditor = createCompositionFamilyEditor({
    onChange: draft => {
      if (disposed || loading || operation || running) return
      field('composition-family-fields').value = json(draft); pending.add('compositionFamilies'); changed()
      field('composition-fields-status').textContent = 'Family workspace changed. Build the combined recipe before generating tasks.'
    },
    onSelect: taskId => operate(async ticket => {
      try { await inspectFamily(ticket, taskId) }
      catch (error) { if (current(ticket)) renderFamilyWorkspace(); throw error }
    }),
    onAdd: taskId => operate(async ticket => { await addFamily(taskId, ticket) }),
    onRemove: taskId => operate(async () => {
      const workspace = familyDraft(); invariant(workspace?.families?.some(row => row.sourceTask?.id === taskId), 'Select a retained family to remove.')
      backup = snapshot(); field('undo').hidden = false
      workspace.families = workspace.families.filter(row => row.sourceTask.id !== taskId)
      if (familySelected === taskId) familySelected = ''
      field('composition-family-fields').value = json(workspace); familyInventory = null; pending.add('compositionFamilies'); changed(); renderFamilyWorkspace()
      status('Source family removed from the workspace. Other family fields are retained; Undo is available in this page.')
    }),
  })
  const familyOccurrenceEditor = createCompositionFieldsEditor({ sharedConstruction: true, onChange: draft => {
    if (disposed || loading || operation || running || familyReadOnly) return
    const workspace = familyDraft(), entry = workspace?.families?.find(row => row.sourceTask?.id === familySelected)
    if (!entry || draft.taskId !== familySelected) return
    entry.fields = draft; field('composition-family-fields').value = json(workspace); pending.add('compositionFamilies'); changed()
    familyEditor.setContext({ workspace, sources: familySources(), selectedTaskId: familySelected })
  } })
  field('family-editor').append(familyEditor.el); field('family-occurrence-editor').append(familyOccurrenceEditor.el)
  const familySources = () => spec.tasks.map(task => ({ taskId: task.id, familyId: task.familyId || task.id, split: task.split, label: task.id }))
  function renderFamilyWorkspace() {
    const workspace = familyDraft(), active = !!workspace
    field('family-workspace').hidden = !active; field('single-composition-controls').hidden = active; field('composition-fields-editor').hidden = active
    const entry = workspace?.families?.find(row => row.sourceTask?.id === familySelected)
    familyEditor.setContext({ workspace, sources: familySources(), selectedTaskId: familySelected })
    if (active) {
      compositionEditor.el.remove(); field('family-occurrence-editor').append(familyOccurrenceEditor.el)
    } else {
      familyOccurrenceEditor.el.remove(); field('composition-fields-editor').append(compositionEditor.el)
      compositionEditor.setContext(compositionInventory, compositionDraft())
    }
    familyOccurrenceEditor.setContext(entry ? familyInventory : null, entry?.fields || null)
    familyOccurrenceEditor.setDisabled(familyReadOnly || disposed || loading || !!operation?.lockControls || !!running)
  }
  async function boundFamilySources(ticket) {
    const code = await sources(); assertCurrent(ticket)
    let bound = await bindRuntimeSources(spec, code)
    if (bound.domain === 'lean-bench') bound = await bindLeanReview(bound, code)
    assertCurrent(ticket); return bound
  }
  async function inspectFamily(ticket, taskId = familySelected) {
    const workspace = familyDraft(), entry = workspace?.families?.find(row => row.sourceTask?.id === taskId)
    invariant(entry, 'Choose a retained source family to inspect.')
    const bound = await boundFamilySources(ticket), live = bound.tasks.find(task => task.id === taskId)
    // A capsule supplies a read-only preview when its original is gone. The
    // compiler below always requires the actual unchanged live source task.
    const inventory = await compositionFieldInventory(live ? bound : { ...bound, tasks: [entry.sourceTask] }, taskId)
    assertCurrent(ticket); familySelected = taskId; familyInventory = inventory; familyReadOnly = !live; spec = bound; renderFamilyWorkspace()
    field('family-source-status').textContent = live ? 'Source bindings are checked when building. Changed source fields remain stale until an explicit replacement.'
      : 'Read-only retained source preview. The original task is unavailable; use Undo if available or import the original source draft before building. This snapshot does not authorize generation.'
    status('Family fields inspected. Navigation preserved the retained values.')
  }
  async function addFamily(taskId, ticket) {
    requireApplied(Object.keys(EDITOR_GROUPS).filter(group => !['compositionFields', 'compositionFamilies', 'corpus'].includes(group)))
    const workspace = familyDraft(); invariant(workspace, 'Start a family workspace first.')
    const bound = await boundFamilySources(ticket), task = bound.tasks.find(task => task.id === taskId)
    invariant(task && !workspace.families.some(row => row.sourceTask?.id === taskId), 'Choose an available source task not already in the workspace.')
    invariant(!workspace.families.some(row => (row.sourceTask.familyId || row.sourceTask.id) === (task.familyId || task.id)), 'Two source seeds from the same original family require an explicit advanced recipe.')
    const inventory = await compositionFieldInventory(bound, taskId); assertCurrent(ticket)
    backup = snapshot(); field('undo').hidden = false
    workspace.families.push({ sourceTask: structuredClone(task), fields: createCompositionFieldDraft(inventory) })
    spec = bound; familySelected = taskId; familyInventory = inventory; familyReadOnly = false
    field('composition-family-fields').value = json(workspace); pending.add('compositionFamilies'); changed(); renderProtocol(); renderFamilyWorkspace()
    status('Source family added. Fill its construction and expected-answer rationale and occurrence choices before building.')
  }
  const guard = () => invariant(source && source !== 'mock', 'This action requires a connected workspace. You can open, edit and download local draft files in this preview.')
  const sources = async () => loadSources()
  // What this page can declare about the runtime that ran recorded responses: the
  // renderer's own user agent and platform, which every browser exposes to a page.
  // Nothing is asked of the shell and no version is invented; the exported runner
  // records Node's process facts in the same journal field instead. A host without
  // a navigator declares nothing, and the report says so.
  const pageRuntime = () => typeof globalThis.navigator?.userAgent === 'string'
    ? { host: 'research-page', userAgent: globalThis.navigator.userAgent, ...(typeof globalThis.navigator.platform === 'string' && globalThis.navigator.platform ? { platform: globalThis.navigator.platform } : {}) }
    : null
  // A project opened from an archive this build cannot rebuild is held read-only. Its
  // evidence is still admitted, its run inspected and its report rendered, all through
  // the archive's own integrity rather than through a rebuild that would refuse it,
  // because any change to compiled readiness output re-identifies every earlier frozen
  // project. The claim passed down names what the archive proved and what differs.
  const readOnlyArchive = () => !!openedArchive && !openedArchive.rebuild.verified
  const archiveIntegrityClaim = () => readOnlyArchive() ? { files: openedArchive.integrity.checked,
    rebuildDiffering: openedArchive.rebuild.differing.length ? openedArchive.rebuild.differing : ['(whole project)'],
    runtimeDiffering: openedArchive.runtime.differing } : null
  const inspectionOptions = async () => ({ ...(readOnlyArchive() ? { archiveIntegrity: archiveIntegrityClaim() } : {}), runtimeIntegrity: await runtimeIntegrityFor(frozen, await sources()) })
  // What an exported archive carries beside its project: the manifest it was written
  // with, its provenance record and its attributions. Each was proved against the
  // manifest digest when the archive was opened; older exports carry no provenance.
  function carriedReportInputs(files) {
    let provenance = null
    if (typeof files['provenance.json'] === 'string') {
      try { provenance = JSON.parse(files['provenance.json']) } catch { throw new Error("The archive's provenance.json is not readable.") }
    }
    return { manifest: files['manifest.json'], provenance, attributions: typeof files['ATTRIBUTIONS.md'] === 'string' ? files['ATTRIBUTIONS.md'] : null }
  }
  // The inputs the held project's report is rendered from. A project this page froze
  // reports with this runtime's provenance registry and the manifest of the export it
  // would write. One opened from an archive reports with what that archive carries,
  // exactly as `node cli.mjs analyze` reads them beside the project, so the page's
  // report and the exported runner's derive from the same recorded inputs; and one this
  // build cannot rebuild states the archive's integrity in place of the rebuild. The
  // retained receipts travel with either.
  async function reportOptions(currentProject) {
    const receipts = { qualification: evidence?.qualification ?? null, nativeVerification: nativeVerification ?? evidence?.nativeVerification ?? null }
    // The runtime this build is running, hashed from the same sources it would export, so the
    // report's runtime-integrity line is answered by the build that rendered the report; computed
    // once, for a page-frozen project and for an opened archive alike (against the held
    // project's own pins), by runtimeIntegrityFor.
    const code = await sources(), runtimeIntegrity = await runtimeIntegrityFor(currentProject, code)
    if (openedArchive) return { ...openedArchive.carried, ...receipts, archiveIntegrity: archiveIntegrityClaim(), runtimeIntegrity }
    return { provenance: provenanceDocument(), attributions: attributionsMarkdown(), manifest: (await projectFiles(currentProject, code, structuredClone(attachments)))['manifest.json'], ...receipts, runtimeIntegrity }
  }
  const current = ticket => !disposed && ticket === epoch
  const assertCurrent = ticket => invariant(current(ticket), 'The project or account changed while working. Continue in the current project.')
  // Check between account calls so a context switch cannot start another write
  // from an old multi-chunk save, or publish its result in the new project.
  const storeFor = ticket => createBenchmarkStore(account && Object.fromEntries(['getSetting', 'putSetting'].map(name => [name, account[name] && (async (...args) => {
    assertCurrent(ticket); const result = await account[name](...args); assertCurrent(ticket); return result
  })])))
  function syncControls() {
    const locked = disposed || loading || !!operation?.lockControls || (project === 'all' && source !== 'mock')
    for (const tag of ['button', 'input', 'select', 'textarea']) for (const control of [...root.querySelectorAll(tag), ...resourceEl.querySelectorAll(tag), ...projectEl.querySelectorAll(tag)]) control.disabled = locked && !control.hasAttribute('data-bench-tab')
    resourceEditor.setDisabled(locked || !!running)
    informationEditor.setDisabled(locked || !!running)
    requirementEditor.setDisabled(locked || !!running)
    compositionEditor.setDisabled(locked || !!running)
    conditionEditor.setDisabled(locked || !!running)
    endpointEditor.setDisabled(locked || !!running)
    designEditor.setDisabled(locked || !!running)
    compositionGenerator.setDisabled(locked || !!running)
    nestingEditor.setDisabled(locked || !!running)
    varianceEditor.setDisabled(locked || !!running)
    protocolEditor.setDisabled(locked || !!running)
    pipelineEditor.setDisabled(locked || !!running)
    promptSetEditor.setDisabled(locked || !!running)
    familyEditor.setDisabled(locked || !!running); familyOccurrenceEditor.setDisabled(locked || !!running || familyReadOnly)
    field('save').disabled = locked || source === 'mock' || typeof account?.putSetting !== 'function'
    field('save').title = source === 'mock' || typeof account?.putSetting !== 'function' ? 'Connect your account to save here. Download draft keeps a local copy.' : 'Save this draft to the selected account project'
    field('export').disabled = locked || !frozen
    // One list decides both the control and the explanation beside it, so a disabled Run
    // button can never be silent about why.
    const refusals = pageRunRefusals(frozen, openedArchive)
    field('run').disabled = locked || !frozen || refusals.length > 0
    renderExportedRunHandoff(refusals)
    field('cancel').disabled = !running
    field('import-native-evidence').disabled = locked || !frozen || frozen.spec.protocol.grading.kind !== 'lean-python'
    field('export-native-verification').disabled = locked || !nativeVerification
    field('native-control-job').disabled = locked || !frozen?.nativePreparation?.jobs.length
    field('export-native-control').disabled = locked || !frozen?.nativePreparation?.jobs.some(job => job.id === field('native-control-job').value)
    field('export-evidence').disabled = locked || !evidence
    field('export-csv').disabled = locked || !evidence
    field('export-report').disabled = locked || !evidence
    field('export-reference').disabled = locked || !frozen || !evidence || !!frozen.audit
    const auditPopulation = !!spec.auditPlan, taskSet = !auditPopulation && field('analysis-population').value === 'task-set'
    field('analysis-population').disabled = locked || auditPopulation
    field('analysis-population').querySelector('[value="reference-eligible"]').hidden = !auditPopulation
    field('analysis-task-ids-field').hidden = !taskSet
    field('analysis-task-ids').disabled = locked || !taskSet
    const noTask = !spec.tasks[taskIndex], noBundle = !spec.catalog[bundleIndex]
    for (const name of ['task', 'delete-task', 'split', 'apply-task', 'apply-input', 'derive-expected', 'add-information', 'prepare-information-fields', 'start-corpus', 'prepare-composition-fields', 'start-family-workspace']) {
      if (field(name)) field(name).disabled = locked || noTask
    }
    for (const name of ['bundle-title', 'bundle-labels', 'wording', 'bundle-id', 'bundle-version', 'bundle-kind', 'bundle-role', 'parameters', 'slots', 'semantics', 'apply-bundle', 'clone-bundle', 'delete-snippet', 'vary-snippet', 'add-slot', 'approve']) {
      field(name).disabled = locked || noBundle
    }
    field('add-task').disabled = locked || !spec.catalog.length
    root.setAttribute('aria-busy', String(loading || !!operation?.lockControls))
  }
  async function operate(action, { lockControls = true } = {}) {
    if (disposed || loading || operation) return
    const active = { epoch, lockControls }; operation = active; syncControls()
    try { await action(active.epoch) }
    catch (error) { if (current(active.epoch)) { status(error.message); field('snippet-status').textContent = error.message } }
    finally { if (operation === active) { operation = null; syncControls() } }
  }
  function requireApplied(groups) {
    const remaining = groups.filter(group => pending.has(group))
    const spoken = { bundle: 'snippet', task: 'task', input: 'input', information: 'information' }
    invariant(!remaining.length, `Apply the current ${remaining.map(name => spoken[name] || name).join(', ')} edits first. Your text is preserved.`)
  }
  const editorValue = name => name === 'require-review' ? field(name).checked : field(name).value
  const editorSnapshot = names => Object.fromEntries(names.map(name => [`data-bench-${name}`, editorValue(name)]))
  const retainEditors = groups => editorSnapshot(groups.filter(group => pending.has(group)).flatMap(group => EDITOR_GROUPS[group]))
  const syncSpecEditor = () => { if (!pending.has('specification')) field('spec-json').value = json(spec) }
  function changed() {
    const wasFrozen = !!frozen
    dirty = true; frozen = null; openedArchive = null; evidence = null; nativeVerification = null
    renderNativeVerification()
    renderNativePreparationPlan(null); renderNativeControlJobs()
    preparedInformation = null
    preparedAudits.clear()
    field('audit-packet').textContent = ''; field('audit-review-status').textContent = spec.auditPlan ? 'Prepare the current case packets to inspect their review status.' : ''
    field('frozen').textContent = 'The draft changed. Freeze it again before running or exporting.'
    field('frozen-details').replaceChildren(); field('frozen-inspection').replaceChildren(); field('results').replaceChildren()
    field('readiness').textContent = 'Freeze the applied fields to inspect generated execution requirements.'
    syncSpecEditor(); syncControls()
    renderReview()
    renderAnalysisPopulation()
    renderInformationFields()
    if (wasFrozen || spec.tasks[taskIndex]?.information) preview()
  }
  function selectTab(id) {
    if (id === 'experiment' && separateResource) { onOpenResource(); return }
    for (const button of root.querySelectorAll('[data-bench-tab]')) button.setAttribute('aria-pressed', String(button.dataset.benchTab === id))
    for (const panel of root.querySelectorAll('[data-bench-panel]')) panel.hidden = panel.dataset.benchPanel !== id
    if (id === 'compose') { renderCompositionGenerator(); syncControls() }
    if (id === 'nesting') { renderNesting(); syncControls() }
    if (id === 'variance') { renderVariance(); syncControls() }
    if (id === 'protocol') { renderProtocolDecisions(); renderPipeline(); syncControls() }
    if (id === 'audit') { renderPipeline(); syncControls() }
    if (id === 'run') { renderReview(); syncControls() }
    if (id === 'corpus') { renderPromptSet(); syncControls() }
  }
  root.querySelector('.bench-steps').addEventListener('click', event => { const button = event.target.closest('[data-bench-tab]'); if (button) selectTab(button.dataset.benchTab) })
  // Name every apparatus file as soon as the reviewer opens the disclosure that
  // asks them to choose one. The chooser used to be filled only by pressing
  // "Read source", so opening "Exact apparatus source for review" showed a File
  // dropdown holding nothing at all, above a button whose label says it reads the
  // file you picked -- from a list you could not reach until you had pressed it.
  async function listApparatusSources(ticket) {
    const selected = field('source-file').value, files = await sources()
    assertCurrent(ticket)
    field('source-file').innerHTML = Object.keys(files).map(name => option(name, name, selected)).join('')
    return files
  }
  field('source-details').addEventListener('toggle', () => {
    if (!field('source-details').open || field('source-file').querySelectorAll('option').length) return
    operate(ticket => listApparatusSources(ticket))
  })
  const capture = () => ({ version: 1, origin: draftOrigin, spec: structuredClone(spec), attachments: structuredClone(attachments), pending: [...pending], taskIndex, bundleIndex, editors: editorSnapshot(EDITORS.filter(name => name !== 'spec-json' || pending.has('specification'))) })
  function applyEditors(editors = {}) {
    for (const name of EDITORS) {
      const key = `data-bench-${name}`
      if (Object.hasOwn(editors, key)) { if (name === 'require-review') field(name).checked = editors[key]; else field(name).value = editors[key] }
    }
    if (spec.auditPlan) field('analysis-population').value = 'reference-eligible'
    try { resourceEditor.write(parse(field('resource-fields').value, 'Experiment fields')) } catch (error) { field('resource-status').textContent = error.message }
    try { requirementEditor.setContext(requirementInventory, requirementDraft()) } catch (error) { field('requirement-fields-status').textContent = error.message }
    syncEndpointFields()
    syncDesignFields()
    try { renderFamilyWorkspace() } catch (error) { field('composition-fields-status').textContent = error.message }
    renderConditionFields(); renderInformationFields()
    renderAnalysisPopulation()
    renderSnippetLabels(); renderRouting()
    renderProtocolDecisions(); renderPipeline()
  }
  // Study identity is in three places at once: these toolbar fields, the
  // frozen spec, and every artefact the export writes. The version is stored
  // in its normalized form, so what freezes is exactly what the echo showed.
  function studyVersionFromField() {
    try { return normalizeStudyVersion(field('study-version').value) } catch (error) { return undefined }
  }
  function applyIdentity(target) {
    target.name = field('name').value; target.id = field('id').value
    const version = studyVersionFromField()
    if (version === undefined) delete target.version
    else target.version = version
    return target
  }
  function renderStudyVersion() {
    const raw = field('study-version').value.trim(), normalized = studyVersionFromField()
    const problem = normalized === undefined ? (raw ? studyVersionProblem(raw) : null) : studyVersionProblem(normalized)
    field('study-version-status').textContent = problem ? problem
      : normalized === undefined ? 'No study version declared. The exported package.json will read 1.0.0 and the report front matter will read Not declared.'
      : normalized === raw ? `Study version ${normalized}. It is written into the frozen project, the exported package.json and package-lock.json, node cli.mjs verify, and the report front matter.`
      : `${raw} is read as ${normalized}, and ${normalized} is what freezes.`
  }
  function snapshot() { applyIdentity(spec); return capture() }
  function remember() { if (source && !loading) drafts.set(`${source}:${project}`, { ...snapshot(), dirty, frozen, openedArchive, evidence, backup }) }
  function resetEditors() {
    // These values include routing and unapplied field authoring, which are not
    // rebuilt from spec. Never let the preceding project's values seed another.
    for (const name of EDITORS) {
      if (name === 'require-review') field(name).checked = false
      else field(name).value = ''
    }
    field('snippet-search').value = ''; field('snippet-label-filter').value = ''
    field('slot-name').value = ''; field('source-code').textContent = ''
    field('role-choices').replaceChildren(); field('combination-wrapper').value = ''
  }
  const refFor = bundle => createDefaultNode(spec.catalog, bundle?.id)
  function nodeAt(path) {
    let ref = spec.tasks[taskIndex].root
    for (const name of path ? path.split('.') : []) ref = ref?.slots?.[name]
    return ref
  }
  function setNode(path, ref) {
    if (!path) spec.tasks[taskIndex].root = ref
    else {
      const parts = path.split('.'), last = parts.pop(), parent = nodeAt(parts.join('.'))
      invariant(object(parent) && (parent.slots === undefined || object(parent.slots)), 'Choose a valid parent before filling this child.')
      parent.slots ||= {}; parent.slots[last] = ref
    }
  }
  function treeMarkup(ref, path = '', role = 'node', depth = 0) {
    if (depth > 128) return '<p>Continue editing this deep composition in Task JSON.</p>'
    const bundle = spec.catalog.find(item => item.id === ref?.use)
    const candidates = spec.catalog.filter(item => slotAccepts(role, item.role || 'node'))
    const label = path ? roleName(path.split('.').at(-1)) : 'Root prompt'
    const markup = `<fieldset class="bench-node" data-node-depth="${depth}"><legend>${esc(label)}${bundle?.kind === 'template' ? ' <span class="bench-kind">nested template</span>' : ''}</legend>
      <div class="bench-node-row">
        <label class="bench-inline">Snippet or template<select data-node-use="${esc(path)}" data-node-role="${esc(roleAttribute(role))}">${!bundle ? '<option value="">Choose a snippet</option>' : ''}${candidates.map(item => option(item.id, snippetChoice(item), ref?.use)).join('')}</select></label>
        <label class="bench-inline">On change<select data-node-replacement-mode="${esc(path)}"><option value="preserve">Keep child connections</option><option value="replace">Replace whole branch with defaults</option></select></label>
      </div>
      ${Object.entries(bundle?.parameters || {}).map(([name, fallback]) => `<label class="bench-param">${esc(name)}<input data-node-param="${esc(name)}" data-node-path="${esc(path)}" data-node-type="${typeof fallback}" value="${esc(ref?.params?.[name] ?? fallback)}"></label>`).join('')}
      ${slotAccepts(role, 'node') ? `<div class="bench-wrap"><label class="bench-inline">Wrap in<select data-node-wrapper="${esc(path)}" aria-label="Template to wrap ${esc(path || 'root')}">${spec.catalog.filter(item => item.kind === 'template' && Object.values(item.slots || {}).includes('node')).map(item => option(item.id, item.id)).join('')}</select></label><button type="button" data-node-wrap="${esc(path)}">Wrap in template</button></div>` : ''}
      ${Object.entries(bundle?.slots || {}).map(([name, childRole]) => treeMarkup(ref?.slots?.[name], path ? `${path}.${name}` : name, childRole, depth + 1)).join('')}</fieldset>`
    if (!depth || !Object.keys(bundle?.slots || {}).length) return markup
    const open = branches.get(`${spec.tasks[taskIndex].id}:${path}`) ?? depth < 2
    return `<details class="bench-branch" data-node-branch="${esc(path)}"${open ? ' open' : ''}><summary>${esc(label)} · ${esc(bundle.id)}</summary>${markup}</details>`
  }
  // The compiled source map, in the venue report's own columns, so a person
  // reading a composed prompt in the page can see which bundle produced which
  // span of it. Same rows as report.mjs item 4; see research-layer-map.mjs.
  function renderLayerMap(taskId, compiled) {
    if (!taskId || !compiled) { field('layers-caption').textContent = ''; field('layers').innerHTML = ''; return }
    const map = layerMap(taskId, compiled)
    field('layers-caption').textContent = map.more ? `${map.caption} ${map.more}` : map.caption
    field('layers').innerHTML = `<table data-bench-layer-table="${esc(map.id)}"><thead><tr>${map.columns.map(column => `<th>${esc(column)}</th>`).join('')}</tr></thead><tbody>${map.rows.map(row => `<tr>${row.map(cell => `<td>${esc(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`
  }
  async function preview() {
    const ticket = ++previewEpoch
    if (!spec.tasks[taskIndex]) {
      for (const name of ['prompt', 'checklist', 'trace', 'information-packet', 'information-review-status']) field(name).textContent = ''
      field('preview-meta').textContent = 'No tasks yet. Create or import snippets, then add a task.'
      preparedInformation = null; renderLayerMap(null, null)
      return
    }
    try {
      const task = spec.tasks[taskIndex]
      const frozenTask = frozen?.tasks.find(row => row.id === task.id)
      const compiledTask = frozenTask || await compileTask(spec, task, { requireReview: false, requireTaskReview: false, validateExpected: false })
      const compiled = compiledTask.compiled
      if (ticket !== previewEpoch || disposed) return
      field('prompt').textContent = compiled.text
      field('preview-meta').textContent = `${frozenTask ? 'Frozen prompt' : 'Draft prompt'} · ${compiled.nodeCount} components · depth ${compiled.depth} · ${compiled.bundles.filter(bundle => !bundle.approved).length} bundles awaiting review`
      field('checklist').textContent = json(compiled.checklist)
      renderLayerMap(task.id, compiled)
      field('information-details').hidden = !task.information
      field('information-packet').textContent = compiledTask.informationPacket ? json(compiledTask.informationPacket) : ''
      field('information-review-status').textContent = compiledTask.informationPacket ? (taskReviewStatus(compiledTask, spec.taskReviews || []).approved ? 'This exact task packet has a current review.' : 'This task packet has no current review.')
        + (compiledTask.informationPacket.version === 2 ? ' It binds declared condition settings, workflow assignments and stage context.' : ' Legacy task packet: it does not bind the full collection context.')
        + (pending.size ? ' Applied fields only; apply pending edits before reviewing.' : '') : ''
      // The trace panel, and what goes in it, are the benchmark's declaration.
      // This page used to decide both with spec.domain === 'lean-bench' and call
      // the vertical's two interpreters itself.
      const trace = pageSurfaceForDomain(spec.domain).taskTrace
      field('trace-details').hidden = !declaresPageField(spec.domain, 'trace-details')
      if (!trace) field('trace').textContent = ''
      else {
        const traced = await trace(spec, task, compiled)
        if (ticket !== previewEpoch || disposed) return
        field('trace').textContent = json(traced)
      }
    } catch (error) { if (ticket === previewEpoch && !disposed) { field('prompt').textContent = error.message; field('preview-meta').textContent = 'Composition needs attention.'; field('checklist').textContent = ''; renderLayerMap(null, null); field('trace').textContent = ''; field('information-packet').textContent = ''; field('information-review-status').textContent = 'Prepare a valid task before reviewing its information treatment.'; preparedInformation = null } }
  }
  function renderTask() {
    const retained = retainEditors(['task', 'input', 'information'])
    for (const branch of root.querySelectorAll('[data-node-branch]')) if (renderedTask) branches.set(`${renderedTask}:${branch.dataset.nodeBranch}`, branch.open)
    const choices = new Map([...root.querySelectorAll('[data-combination-role]')].map(input => [`${input.dataset.combinationRole}:${input.value}`, input.checked]))
    taskIndex = Number.isInteger(taskIndex) && taskIndex >= 0 ? Math.min(taskIndex, spec.tasks.length - 1) : 0
    field('task').innerHTML = spec.tasks.map((task, i) => option(String(i), task.id, String(taskIndex))).join('')
    const task = spec.tasks[taskIndex]
    if (!task) {
      taskIndex = 0; renderedTask = null
      field('tree').textContent = 'No tasks in this project. Create or import a snippet, then add a task.'
      for (const name of ['task-json', 'input', 'expected', 'information-rationale', 'information-paths', 'information-readings']) field(name).value = ''
      field('split').value = 'development'
      field('information-details').hidden = true; field('add-information').hidden = true
      field('combinations').hidden = true; field('derive-expected').hidden = true
      applyEditors(retained); renderAuditCase(); syncControls(); preview()
      return
    }
    field('information-details').hidden = !task.information
    field('add-information').hidden = !!task.information
    field('information-rationale').value = task.information?.rationale || ''
    field('information-mode').value = task.information?.responseMode || 'raw'
    field('information-selection').value = task.information?.readings ? 'readings' : 'readingPool'
    field('information-paths').value = json(task.information?.withheldPaths || [])
    field('information-readings').value = json(task.information?.readings || task.information?.readingPool || [])
    field('information-packet').textContent = ''; field('information-review-status').textContent = ''; preparedInformation = null
    field('tree').innerHTML = treeMarkup(task.root)
    renderedTask = task.id
    field('task-json').value = json(task)
    field('input').value = json(task.input ?? null); field('expected').value = json(task.expected); field('split').value = task.split
    field('combinations').hidden = !declaresPageField(spec.domain, 'combinations')
    field('derive-expected').hidden = !declaresPageField(spec.domain, 'derive-expected')
    const priorWrapper = field('combination-wrapper').value
    field('combination-wrapper').innerHTML = [['', 'Flat strategy'], ...(operationalStudy(spec)
      ? [['op-all-2', 'ALL'], ['op-sequence-2', 'SEQUENCE'], ['op-race-accepted-2', 'RACE: broker accepted'], ['op-race-filled-2', 'RACE: first fill']]
      : [['parallel', 'Parallel'], ['sequence', 'Sequence'], ['race', 'Race']])].map(([value, label]) => option(value, label, priorWrapper)).join('')
    field('role-choices').innerHTML = combinationRoles().map(role => `<fieldset><legend>${roleName(role)}</legend>${spec.catalog.filter(bundle => bundle.role === role).map((bundle, i) => `<label><input type="checkbox" data-combination-role="${role}" value="${esc(bundle.id)}"${(choices.get(`${role}:${bundle.id}`) ?? i === 0) ? ' checked' : ''}>${esc(bundle.id)}</label>`).join('')}</fieldset>`).join('')
    applyEditors(retained); renderAuditCase(); renderInformationFields(); syncControls(); preview()
  }
  /* PROMPT B. THE ROLES THIS PANEL OFFERS COME OFF THIS CATALOG.
     It used to map a list of four names this file imported, so a library whose
     parts are called anything else got somebody else's headings. The template
     that composes named parts is the one whose every place names a role rather
     than accepting any node, and its own order is the order shown. A catalog
     with no such template offers nothing, which is the honest answer. */
  function combinationRoles() {
    const named = role => slotRoles(role).every(part => part !== 'node' && part !== '*')
    const composer = spec.catalog.find(bundle => bundle.kind === 'template'
      && Object.keys(bundle.slots || {}).length > 1 && Object.values(bundle.slots).every(named))
    if (!composer) return []
    return [...new Set((composer.slotOrder || Object.keys(composer.slots)).flatMap(name => slotRoles(composer.slots[name])))]
  }

  function renderAuditCase() {
    field('audit-case').innerHTML = spec.auditPlan ? spec.tasks.map((task, i) => option(String(i), task.id, String(taskIndex))).join('') : ''
    const task = preparedAudits.get(spec.tasks[taskIndex]?.id)
    field('audit-packet').textContent = task ? json(task.auditPacket) : ''
    field('audit-review-status').textContent = !spec.auditPlan ? '' : task ? (auditReviewStatus(task, spec.auditReviews || []).approved ? 'This exact case packet has a current review.' : 'This case packet has no current review.') : 'Prepare the current case packets to inspect their review status.'
  }
  function renderAuditFile() {
    const reference = spec.auditPlan?.reference, path = field('audit-file').value
    field('audit-file-text').textContent = ''
    if (!reference || !path || !Object.hasOwn(reference.files, path)) return
    try { field('audit-file-text').textContent = auditFileText(reference, path) }
    catch { field('audit-file-text').textContent = `${auditFileBytes(reference.files[path]).byteLength} binary bytes. Exact bytes are retained in the exported reference bundle.` }
  }
  function renderAuditSource() {
    const reference = spec.auditPlan?.reference, selected = field('audit-file').value
    field('audit-authoring').hidden = !reference
    field('audit-source').textContent = reference ? `${reference.project.spec.name} · ${reference.project.schedule.length} source trials · Reference SHA-256 ${reference.sha256}` : 'Import a sealed reference bundle to author a judge audit.'
    field('audit-file').innerHTML = reference ? Object.keys(reference.files).map(path => option(path, path, selected)).join('') : ''
    renderAuditFile(); renderAuditCase()
  }
  function renderSnippetLabels() {
    try { field('snippet-label-preview').innerHTML = snippetLabels({ labels: field('bundle-labels').value }).map(label => `<span>${esc(label)}</span>`).join('') }
    catch (error) { field('snippet-label-preview').textContent = error.message }
  }
  function renderSnippetList() {
    const selectedLabel = field('snippet-label-filter').value
    const labels = [...new Map(spec.catalog.flatMap(snippetLabels).map(label => [label.toLocaleLowerCase(), label])).values()].sort((a, b) => a.localeCompare(b))
    field('snippet-label-filter').innerHTML = option('', 'All labels', selectedLabel) + option('unlabelled', 'Without labels', selectedLabel) + labels.map(label => option('label:' + label, label, selectedLabel)).join('')
    field('snippet-known-labels').innerHTML = labels.map(label => option(label, label)).join('')
    const filter = field('snippet-label-filter').value
    const matches = filterSnippets(spec.catalog, { search: field('snippet-search').value, label: filter.startsWith('label:') ? filter.slice(6) : '', unlabelled: filter === 'unlabelled' })
    const examples = spec.catalog.filter(isExampleSnippet).length
    field('snippet-count').textContent = `${matches.length} of ${spec.catalog.length} snippets and templates`
      + (examples ? ` · ${examples} unedited example${examples === 1 ? '' : 's'} you can delete` : '')
    // Every category the library actually contains, with how many snippets are
    // in it, pressable. A label a person typed is a category the moment it
    // exists; it should not have to be discovered inside a dropdown.
    const counts = new Map(labels.map(label => [label, spec.catalog.filter(bundle => snippetLabels(bundle).some(value => value.toLocaleLowerCase() === label.toLocaleLowerCase())).length]))
    const without = spec.catalog.filter(bundle => !snippetLabels(bundle).length).length
    const chip = (value, text, count) => `<button type="button" class="snippet-category" data-bench-snippet-category="${esc(value)}" aria-pressed="${filter === value}">${esc(text)}<span>${count}</span></button>`
    field('snippet-categories').innerHTML = [chip('', 'All', spec.catalog.length), ...labels.map(label => chip('label:' + label, label, counts.get(label)))]
      .concat(without ? [chip('unlabelled', 'Without a category', without)] : []).join('')
    field('snippet-list').innerHTML = matches.length ? matches.map(({ bundle, index }) => `<button type="button" class="snippet-card" data-bench-select-snippet="${index}" aria-pressed="${index === bundleIndex}"><strong>${esc(snippetTitle(bundle))}</strong><span>${esc(bundle.variance?.previewText ?? bundle.text)}</span><span class="snippet-labels snippet-card-labels">${snippetLabels(bundle).map(label => `<span>${esc(label)}</span>`).join('')}</span><small>${snippetLabels(bundle).length ? '' : 'No category · '}${bundle.kind === 'template' ? 'Template' : 'Snippet'}</small></button>`).join('') : '<p>No matching snippets. Try another label or search.</p>'
  }
  field('snippet-search').addEventListener('input', renderSnippetList)
  field('snippet-label-filter').addEventListener('change', renderSnippetList)
  field('bundle-labels').addEventListener('input', renderSnippetLabels)
  async function renderBundle() {
    field('snippet-status').textContent = ''
    const ticket = ++bundleEpoch
    const retained = retainEditors(['bundle'])
    bundleIndex = Number.isInteger(bundleIndex) && bundleIndex >= 0 ? Math.min(bundleIndex, spec.catalog.length - 1) : 0
    const bundle = spec.catalog[bundleIndex]
    field('snippet-variant').hidden = !bundle?.promptOmissions
    field('snippet-variant-text').textContent = ''
    field('wording-label').textContent = bundle?.promptOmissions ? 'Original snippet text (source for the omissions)' : 'Snippet text'
    field('bundle').innerHTML = spec.catalog.map((item, i) => option(String(i), snippetChoice(item), String(bundleIndex))).join('')
    if (!bundle) {
      bundleIndex = 0
      for (const name of ['bundle-id', 'bundle-version', 'bundle-kind', 'bundle-role', 'bundle-title', 'bundle-labels', 'wording', 'parameters', 'slots', 'semantics']) field(name).value = ''
      field('review-status').textContent = ''
      field('snippet-status').textContent = 'This project has no snippets. Create one or import a library.'
      renderSnippetLabels(); renderSnippetList(); syncControls()
      return
    }
    field('bundle-id').value = bundle.id; field('bundle-version').value = bundle.version; field('bundle-kind').value = bundle.kind; field('bundle-role').value = bundle.role || 'node'
    field('bundle-title').value = snippetTitle(bundle); field('bundle-labels').value = snippetLabels(bundle).join(', ')
    const roles = [...new Set(['node', ...spec.catalog.flatMap(item => [item.role || 'node', ...Object.values(item.slots || {})])])]
    field('snippet-roles').innerHTML = roles.map(role => option(role, roleName(role))).join('')
    field('wording').value = bundle.text; field('parameters').value = json(bundle.parameters || {}); field('slots').value = json(bundle.slots || {})
    const { id, version, kind, role, title, labels, text, parameters, slots, review, ...packet } = bundle
    field('semantics').value = json(packet)
    applyEditors(retained); renderSnippetLabels(); renderSnippetList(); syncControls()
    if (bundle.promptOmissions) {
      try {
        const compiled = await compilePrompt(spec.catalog, { use: bundle.id }, { rootRole: '*' })
        if (!disposed && ticket === bundleEpoch && bundle === spec.catalog[bundleIndex]) field('snippet-variant-text').textContent = compiled.text || '(This variant intentionally omits the entire snippet.)'
      } catch (error) { if (!disposed && ticket === bundleEpoch) field('snippet-variant-text').textContent = error.message }
    }
    try {
      const verdict = await reviewStatus(bundle, { catalog: spec.catalog, reviews: spec.reviews || [] })
      if (disposed || ticket !== bundleEpoch || bundle !== spec.catalog[bundleIndex]) return
      field('review-status').textContent = verdict.approved ? `Reviewed by ${verdict.review.reviewer} on ${verdict.review.at}. Content and dependency root SHA-256 ${verdict.rootSha256}` : `This exact version has no current review. Content and dependency root SHA-256 ${verdict.rootSha256}`
    } catch (error) { if (!disposed && ticket === bundleEpoch && bundle === spec.catalog[bundleIndex]) field('review-status').textContent = error.message }
  }
  function renderAnalysisPopulation() {
    const target = field('analysis-population-preview')
    try {
      const population = resolveAnalysisPopulation(spec)
      if (!population) { target.textContent = 'No primary population is applied. Apply an analysis plan to inspect its task selection.'; return }
      target.innerHTML = `<p>Applied primary population: ${esc(population.label)}. ${population.taskIds.length} included tasks; ${population.ledger.length - population.taskIds.length} excluded tasks.${pending.has('analysis') ? ' Apply the current analysis edits to update this preview.' : ''} These are design selections, not measured outcomes.</p><div class="bench-table-scroll" tabindex="0" role="region" aria-label="Applied primary population membership"><table><caption>Applied primary population membership</caption><thead><tr><th>Task</th><th>Split</th><th>Primary population</th><th>Reason</th></tr></thead><tbody>${population.ledger.map(row => `<tr><th>${esc(row.taskId)}</th><td>${esc(row.split)}</td><td>${row.included ? 'Included' : 'Excluded'}</td><td>${esc(row.reason)}</td></tr>`).join('')}</tbody></table></div>`
    } catch (error) { target.textContent = 'The applied primary population needs attention: ' + error.message }
  }
  function renderProtocol() {
    const retained = retainEditors(['protocol', 'conditionFields', 'specification', 'analysis', 'corpus', 'compositionFields', 'compositionFamilies', 'audit', 'observations', 'requirements', 'requirementFields', 'workflow', 'experiment', 'execution', 'nativePreparation'])
    const native = spec.nativePreparationPlan
    field('native-preparation-mode').value = native ? 'planned' : 'none'
    field('native-preparation-rationale').value = native?.rationale ?? ''
    for (const [name, value] of Object.entries({ 'reference-replicates': native?.referenceReplicates ?? 3, 'mutant-replicates': native?.mutantReplicates ?? 1,
      'max-executions': native?.budgets?.maxNativeExecutions ?? 1000, 'execution-timeout': native?.budgets?.executionTimeoutMs ?? 120000,
      'attempt-timeout': native?.budgets?.attemptTimeoutMs ?? 150000, duration: native?.budgets?.maxDurationMs ?? 86400000 })) field('native-preparation-' + name).value = String(value)
    field('execution-purpose').value = spec.executionPlan?.purpose || 'recorded-diagnostic'
    field('execution-dependence').value = spec.executionPlan?.design?.dependence || 'descriptive-only'
    field('execution-status').textContent = modernSchema(spec) ? 'Execution design is applied. Freeze to derive its capability and control requirements.' : 'Legacy draft: its evidence keeps the original scope. Apply an experiment design to create a new version; the previous draft remains available through Undo replacement.'
    field('resource-fields').value = json(spec.experimentTemplate || defaultResourceTemplateFields())
    field('resource-status').textContent = spec.experimentTemplate ? `${spec.tasks.length} resource cases generated from the applied fields. Execution qualification is required before collection.` : 'These fields are a draft. Generate the experiment to replace the current task design.'
    field('resource-preview').textContent = spec.experimentTemplate ? json(spec.tasks.map(task => ({ taskId: task.id, input: task.input }))) : ''
    const p = spec.protocol
    // THE SCORING CONTROL IS BUILT FROM WHAT IS REGISTERED, NOT FROM A LIST HERE.
    // This control used to carry a sixth <option value="lean-python"> in its
    // markup and enable it with `spec.domain !== 'lean-bench'`, so one vertical's
    // grading contract was part of the page and nobody else's could be. Each
    // benchmark now declares its contracts; a contract whose benchmark does not
    // own this study's domain is offered but not selectable, exactly as the Lean
    // contract was for a generic study.
    const selectable = new Set(gradingKindsForDomain(spec.domain).map(kind => kind.value))
    field('grading').innerHTML = offeredGradingKinds().map(kind =>
      `<option value="${esc(kind.value)}"${selectable.has(kind.value) ? '' : ' disabled'}>${esc(kind.label)}</option>`).join('')
    const gradingHelp = gradingKindsForDomain(spec.domain).filter(kind => kind.benchmarkId && kind.help).map(kind => kind.help)
    field('grading-help').textContent = gradingHelp.join(' ')
    for (const [name, value] of Object.entries({ seed: p.seed, replicates: p.replicates, attempts: p.maxAttemptsPerTrial, total: p.maxTotalAttempts, timeout: p.timeoutMs / 1000, duration: p.maxDurationMs / 1000, grading: p.grading.kind, decisions: spec.decisions || '' })) field(name).value = value
    field('require-review').checked = spec.requireReview === true
    renderProtocolDecisions(); renderPipeline(); renderReview()
    field('grading-help').hidden = gradingHelp.length === 0
    for (const name of ['conditions', 'inputs', 'environment']) field(name).value = json(spec[name])
    field('spec-json').value = json(spec)
    const analysis = spec.analysisPlan
    field('analysis-cohort').value = analysis?.cohort || ''
    field('analysis-denominator').value = analysis?.primaryDenominator || 'scheduled'
    const population = analysis?.primaryPopulation
    field('analysis-population').value = spec.auditPlan ? 'reference-eligible' : population?.kind === 'split' ? population.split : population?.kind === 'task-set' ? 'task-set' : 'all'
    field('analysis-task-ids').value = population?.kind === 'task-set' && Array.isArray(population.taskIds) ? population.taskIds.join('\n') : ''
    field('analysis-rationale').value = analysis?.rationale || ''
    field('analysis-uncertainty').value = json(analysis?.uncertainty || null)
    field('analysis-contrasts').value = json(analysis?.contrasts || [])
    field('analysis-multiplicity').value = analysis?.multiplicity || 'none-descriptive'
    // Pending field text survives a re-render; an applied plan refreshes the rows.
    if (!pending.has('analysis') || !field('endpoint-fields').value) { field('endpoint-fields').value = json(endpointRowsFromPlan(analysis?.endpoints)); field('endpoint-fields-status').textContent = analysis?.endpoints?.length ? analysis.endpoints.length + ' typed endpoint' + (analysis.endpoints.length === 1 ? '' : 's') + ' applied in this draft.' : 'No typed endpoints are applied; the binary pass criterion is the primary summary.' }
    syncEndpointFields()
    field('design-plan').value = json(spec.designPlan ?? null)
    if (!pending.has('design') || !field('design-fields').value) { field('design-fields').value = json(designRowsFromPlan(spec.designPlan)); field('design-fields-status').textContent = spec.designPlan ? 'A grouped assignment design is applied in this draft.' : 'No design is applied; the schedule is the plain crossed design.' }
    syncDesignFields()
    field('observation-plan').value = json(spec.observationPlan || null)
    field('requirement-plan').value = json(spec.requirementPlan || null)
    field('requirement-status').textContent = spec.requirementPlan ? `${spec.requirementPlan.targets?.length ?? 0} requirement targets are registered in this draft; execution has not been qualified here.` : 'No requirement qualification plan is applied.'
    field('requirement-registry').textContent = ''
    field('workflow-config').value = json({ plan: spec.workflowPlan || null, assignments: Object.fromEntries(spec.conditions.map(condition => [condition.id, condition.workflowId || null])) })
    field('workflow-status').textContent = spec.workflowPlan ? `Applied workflows: ${spec.workflowPlan.workflows.length}. Conditions using staged collection: ${spec.conditions.filter(condition => condition.workflowId).length}.` : 'No prompt workflow is applied. Each trial uses one adapter call.'
    field('observation-status').textContent = spec.observationPlan ? 'Accounting is part of this draft. Freeze it before collection; review resolved conditions below.' : 'No accounting plan is applied. Raw responses remain available, without inferred usage or cost.'
    try {
      validateObservationPlan(spec)
      field('observation-contracts').textContent = spec.observationPlan ? json(spec.conditions.map(condition => ({ condition: condition.id, ...observationContract(spec, condition) }))) : ''
    } catch (error) { field('observation-contracts').textContent = error.message }
    field('corpus-plan').value = spec.corpusPlan ? json(spec.corpusPlan) : ''
    field('corpus-ledger').textContent = ''
    const { reference, ...auditPlan } = spec.auditPlan || {}
    field('audit-plan').value = reference ? json(auditPlan) : ''
    field('audit-ledger').textContent = ''; renderAuditSource()
    field('attachments').innerHTML = Object.keys(attachments).map(name => `<li>${esc(name)} <button type="button" data-remove-attachment="${esc(name)}">Remove</button></li>`).join('')
    applyEditors(retained); syncControls()
  }
  // Offer full example drafts alongside core templates and registered starters.
  // A benchmark ToolsEnabled did not write can still register its own choices.
  const CORE_STARTERS = Object.freeze([
    { id: 'generic', label: 'Arithmetic example' },
    { id: 'resource-action-plan', label: 'Resource effects: generated experiment' },
  ])
  function renderStarterOptions() {
    const select = field('starter')
    if (!select) return
    // Rebuild from the registry and keep the investigator's choice. This used to
    // read select.options.length to render once, which is an HTMLSelectElement
    // property a browser has and a DOM stand-in does not, so every mount threw
    // before a single field was read.
    const options = [...CORE_STARTERS, ...exampleExperimentDrafts, ...registeredStarters()]
    const markup = options.map(item => `<option value="${esc(item.id)}">${esc(item.label)}</option>`).join('')
    if (select.innerHTML === markup) return
    const chosen = select.value
    select.innerHTML = markup
    if (options.some(item => item.id === chosen)) select.value = chosen
  }
  // Which benchmark this draft belongs to. The page used to name no benchmark at
  // all, which is why it read as one product rather than one project among others.
  function renderBenchmarkOf() {
    const slot = field('benchmark-of')
    if (!slot) return
    const owner = spec.domain === 'generic' ? null : benchmarkForDomain(spec.domain)
    slot.textContent = owner ? `Benchmark: ${owner.label || owner.id}`
      : spec.domain === 'generic' ? 'Benchmark: none (generic study)'
      : `Benchmark: ${spec.domain} (not registered in this build)`
  }
  function render() {
    renderStarterOptions(); renderBenchmarkOf()
    onDraftIdentity({ id: spec.id, name: spec.name })
    field('origin').textContent = draftOrigin
    field('name').value = spec.name; field('id').value = spec.id; field('study-version').value = spec.version || ''; renderStudyVersion(); field('starter').value = exampleExperimentDrafts.find(example => example.id === spec.id)?.id || spec.experimentTemplate?.kind || (operationalStudy(spec) ? 'lean-operational' : spec.domain)
    renderTask(); renderBundle(); renderProtocol()
  }
  async function resourceDraft(fields, prior = null) {
    const recipe = structuredClone(fields); recipe.maxActions = Number(recipe.maxActions)
    const generated = await materializeExperimentTemplate(recipe)
    const next = prior ? structuredClone(prior) : newExperimentDraft(genericStarter(), { initializePopulation: true })
    next.experimentTemplate = recipe; next.catalog = generated.catalog; next.tasks = generated.tasks
    next.protocol.grading = { kind: 'resource-action-plan' }; next.protocol.maxAttemptsPerTrial = 1
    delete next.runtimeSources
    const fixtureCondition = (id, label, control) => ({ id, label, model: { provider: 'fixture', id: 'resource-template-controls-v1', settings: {} },
      adapter: { kind: 'replay', responses: Object.fromEntries(generated.contract.cases.map(row => [row.id, row.controls.find(item => item.id === control).plan])) } })
    const fixtures = [fixtureCondition('reference-plan', 'Generated reference plans', 'reference')]
    if (generated.contract.cases.every(row => row.controls.find(item => item.id === 'collateral').applicable)) fixtures.push(fixtureCondition('collateral-control', 'Generated collateral controls', 'collateral'))
    if (!prior) {
      next.id = 'resource-effects'; next.name = 'Resource effect experiment'
      next.conditions = fixtures; next.protocol.replicates = 1
      next.analysisPlan.primaryPopulation = recipe.cases.some(row => row.split === 'held-out') ? { kind: 'split', split: 'held-out' } : 'all'
      next.analysisPlan.rationale = 'Recorded plans qualify the generated experiment. The selected primary population and criterion are fixed before collection; all task-success and collateral-effect observations remain visible.'
      next.analysisPlan.contrasts = fixtures.length === 2 ? [{ id: 'reference-minus-collateral', first: 'reference-plan', second: 'collateral-control' }] : []
      next.environment = { node: '>=22', dependencies: [], instructions: 'The generated runtime applies one returned action plan to a fresh bounded synthetic resource map. No candidate code is executed.' }
      next.decisions = 'Apparatus controls only. Declare the actual systems and study population before a counted experiment.'
    } else {
      const authored = prior.conditions.filter(condition => condition.model?.id !== 'resource-template-controls-v1')
      next.conditions = [...(prior.conditions.some(condition => condition.model?.id === 'resource-template-controls-v1') ? fixtures : []), ...authored]
      if (!next.conditions.length) next.conditions = fixtures
      const generatedContrast = [{ id: 'reference-minus-collateral', first: 'reference-plan', second: 'collateral-control' }]
      if (canonical(prior.analysisPlan?.contrasts) === canonical(generatedContrast)) next.analysisPlan.contrasts = fixtures.length === 2 ? generatedContrast : []
      else invariant((prior.analysisPlan?.contrasts || []).every(contrast => next.conditions.some(condition => condition.id === contrast.first) && next.conditions.some(condition => condition.id === contrast.second)),
        'A planned comparison uses a generated control that these fields remove. Apply a compatible analysis plan before regenerating the experiment.')
    }
    return next
  }
  function replace(next, files = {}, origin = draftOrigin) {
    backup = snapshot(); field('undo').hidden = false
    draftOrigin = origin
    resetEditors()
    informationInventory = null; informationInventoryContext = null; field('information-fields').value = ''; informationEditor.setContext(null, null)
    requirementInventory = null; field('requirement-fields').value = ''; requirementEditor.setContext(null, null)
    compositionInventory = null; field('composition-fields').value = ''; compositionEditor.setContext(null, null)
    field('condition-fields').value = ''; conditionEditor.setContext({ context: null, draft: null, contextKey: `${source}:${project}:${epoch}` })
    familyInventory = null; familySelected = ''; familyReadOnly = false; field('composition-family-fields').value = ''; field('family-source-status').textContent = ''
    field('composition-fields-status').textContent = ''; field('composition-obligations').replaceChildren()
    spec = structuredClone(next); attachments = structuredClone(files); taskIndex = 0; bundleIndex = 0; pending.clear(); branches.clear(); renderedTask = null; changed(); render()
  }
  function restoreDraft(data, name, origin = `Opened draft file: ${name}. The experiment fields and snippets came from this file.`) {
    invariant(object(data), 'This file does not contain an experiment draft.')
    const next = data.spec || data
    validateDraft(next, data.attachments || {})
    invariant(data.editors === undefined || object(data.editors), 'The saved editor fields are damaged.')
    invariant(data.pending === undefined || Array.isArray(data.pending), 'The saved edit list is damaged.')
    replace(next, data.attachments || {}, origin)
    taskIndex = Number.isInteger(data.taskIndex) && data.taskIndex >= 0 && data.taskIndex < spec.tasks.length ? data.taskIndex : 0
    bundleIndex = Number.isInteger(data.bundleIndex) && data.bundleIndex >= 0 && data.bundleIndex < spec.catalog.length ? data.bundleIndex : 0
    render()
    for (const group of data.pending || []) if (Object.hasOwn(EDITOR_GROUPS, group)) pending.add(group)
    applyEditors(data.editors)
    onBenchmarkLoaded(next)
    onOpen('design'); selectTab('compose'); field('current-experiment').focus()
    status(`Opened ${name}. Its experiment fields are loaded; you do not need an example preset. Unapplied editor text has been restored.`)
  }
  async function openDraft(data, name = 'Selected file') {
    if (disposed || loading || operation || running) return { ok: false, reason: 'Wait for the current builder action to finish before opening another experiment.' }
    let result
    await operate(ticket => {
      try { assertCurrent(ticket); restoreDraft(data, name); result = { ok: true } }
      catch (error) { result = { ok: false, reason: error.message }; throw error }
    })
    return result
  }
  function applyBundle() {
    const prior = spec.catalog[bundleIndex]
    const packet = parse(field('semantics').value, 'Semantic bundle')
    const next = { ...prior, ...packet, ...snippetMetadata(field('bundle-title').value, field('bundle-labels').value), id: field('bundle-id').value.trim(), version: field('bundle-version').value.trim(), kind: field('bundle-kind').value, role: field('bundle-role').value.trim(),
      text: field('wording').value, parameters: parse(field('parameters').value, 'Parameters'), slots: parse(field('slots').value, 'Slots'), review: prior.review }
    invariant(next.text.trim(), 'Write the snippet text before applying it.')
    if (prior.review === undefined) delete next.review
    invariant(next.id === prior.id || !spec.catalog.some(bundle => bundle.id === next.id), 'That bundle identifier is already in use.')
    if (next.id !== prior.id) {
      requireApplied(['task'])
      for (const task of spec.tasks) { const stack = [task.root]; while (stack.length) { const node = stack.pop(); if (node.use === prior.id) node.use = next.id; stack.push(...Object.values(node.slots || {})) } }
    }
    spec.catalog[bundleIndex] = next; pending.delete('bundle'); changed(); renderBundle(); renderTask()
  }
  function protocolEditorFields({ requireComplete = false } = {}) {
    if (requireComplete) for (const [name, label] of Object.entries({ seed: 'Schedule seed', replicates: 'Replicates', attempts: 'Attempts per trial', total: 'Total attempt budget', timeout: 'Attempt timeout', duration: 'Study time budget' })) {
      const text = String(field(name).value ?? '')
      invariant(text.trim() !== '' && Number.isFinite(Number(text)), `Enter a finite number for ${label}. Your editor text is preserved.`)
    }
    let decisions = field('decisions').value
    const recorded = field('protocol-decisions').value
    if (recorded) {
      const state = normalizeProtocolDecisions(parse(recorded, 'Protocol decisions'))
      if (matchesDecisionsText(state, decisions)) decisions = decisionsText(state)
    }
    return { protocol: { ...spec.protocol, seed: Number(field('seed').value), replicates: Number(field('replicates').value), maxAttemptsPerTrial: Number(field('attempts').value), maxTotalAttempts: Number(field('total').value), timeoutMs: Math.round(Number(field('timeout').value) * 1000), maxDurationMs: Math.round(Number(field('duration').value) * 1000), grading: { ...spec.protocol.grading, kind: field('grading').value } },
      conditions: parse(field('conditions').value, 'conditions'), inputs: parse(field('inputs').value, 'inputs'), environment: parse(field('environment').value, 'environment'),
      requireReview: field('require-review').checked, decisions }
  }
  function applyProtocol() {
    const next = { ...structuredClone(spec), ...protocolEditorFields() }
    validateStudy(next); spec = next; pending.delete('protocol'); changed(); renderProtocol()
  }
  // Shown only when this page cannot run the frozen project itself: why, and the exact
  // commands its own export documents for the runner that can.
  function renderExportedRunHandoff(refusals) {
    if (!frozen || !refusals.length) { field('handoff').replaceChildren(); return }
    const native = frozen.spec.protocol.grading.kind === 'lean-python'
    let ready = true
    try { ready = evaluateReadiness(frozen, { operation: executionOperation(frozen) }).eligible } catch { ready = false }
    field('handoff').innerHTML = '<h3>Run this project with the exported runner</h3>'
      + `<p>This page cannot run this frozen project itself:</p><ul>${refusals.map(row => `<li>${esc(row)}</li>`).join('')}</ul>`
      + (readOnlyArchive() ? '<p>This build read those requirements with its own runtime, not the one pinned in this archive. The exported runner inside the archive applies the readiness it was frozen with.</p>'
        : ready ? '' : '<p>The exported runner applies these same execution requirements, so it will refuse for the same reasons until they are met.</p>')
      + '<p>Export the runnable ZIP above, extract it, and run these in that directory with Node 22 or later:</p>'
      + `<pre tabindex="0">${esc(exportedCliCommands(frozen).join('\n'))}</pre>`
      + `<p>Then bring the run back here. Open the exported ZIP, <code>${esc(frozen.spec.id)}.zip</code> as Export runnable ZIP downloads it, with Open exported project. Then import <code>results/evidence.json</code> with Import run evidence under Run &amp; export${native ? ', and <code>results/native-evidence.json</code> with Verify native evidence' : ''}. Opening first is what lets this page hold the project the run belongs to.</p>`
  }
  // Keep the Lean Bench starter's own recorded canary readable by the grader the
  // investigator just chose. Nothing an investigator recorded is rewritten; see
  // research-lean-canary.mjs for the exact test that decides what may move.
  async function alignLeanCanary(previousGrading, ticket) {
    const grading = spec.protocol?.grading?.kind
    if (spec.domain !== 'lean-bench' || grading === previousGrading) return ''
    const code = await sources()
    assertCurrent(ticket)
    const { spec: next, moved } = await alignLeanCanaryResponses(spec, { grading, previousGrading,
      program: async task => inlineLeanProgram(generateLeanProgram(await compileTask(spec, task,
        { requireReview: false, requireTaskReview: false, validateExpected: false })), code) })
    assertCurrent(ticket)
    if (!moved.length) return ''
    spec = next; changed(); renderProtocol()
    return leanCanaryNote(moved)
  }
  // Exporting a blocked project is legitimate: readiness/contract.json travels with
  // it and `node cli.mjs readiness` derives the same decision. Being told only that
  // it exported is not. Name what still blocks it, in readiness's own words, at the
  // moment of export -- the panel below is easy to miss once the ZIP is in hand.
  function exportReadinessNote(project) {
    const decision = evaluateReadiness(project, { operation: executionOperation(project) })
    if (decision.eligible || !decision.blockers.length) return ''
    const count = decision.blockers.length
    return count === 1
      ? ` It cannot run yet. One generated execution requirement blocks it: ${decision.blockers[0].message}`
      : ` It cannot run yet. ${count} generated execution requirements block it, starting with: ${decision.blockers[0].message} The rest are listed under Generated execution requirements.`
  }
  function renderFrozen() {
    if (!frozen) return
    field('frozen').textContent = `${frozen.tasks.length} tasks · ${frozen.schedule.length} scheduled trials · SHA-256 ${frozen.sha256}`
    field('frozen-details').innerHTML = `<p>${frozen.spec.requireReview ? 'Every snippet in use has a current review record.' : 'This protocol does not require personal bundle reviews.'}</p>`
    if (openedArchive) field('frozen-details').innerHTML += openedArchive.rebuild.verified
      ? `<p>Opened from an exported archive and fully verified: ${openedArchive.integrity.checked} files each matched the digest its manifest records, and this build rebuilds the frozen project exactly. No code from the archive was executed.</p>`
      : `<p>Opened from an exported archive, READ-ONLY. ${openedArchive.integrity.checked} files each matched the digest its manifest records, so the archive is intact and belongs to this project. This build cannot rebuild it: rebuilding here changes ${esc(openedArchive.rebuild.differing.join(', '))}.${openedArchive.runtime.differing.length ? ' The pinned runtime differs at ' + esc(openedArchive.runtime.differing.join(', ')) + '.' : ''} No code from the archive was executed.</p>`
    if (selectedInputGate(frozen)) field('frozen-details').innerHTML += '<p>Selected-input qualification is required before collection. Run this project through the exported CLI or the connected run service, then import its evidence to inspect the qualification and results here.</p>'
    field('frozen-inspection').innerHTML = frozenInspectionMarkup(frozen)
    let scope = ''
    try { scope = evaluateReadiness(frozen, { operation: executionOperation(frozen) }).scope } catch { scope = '' }
    field('readiness').innerHTML = `<h3>Generated execution requirements</h3>${scope ? `<p>${esc(scope)}</p>` : ''}`
      // A project this build cannot rebuild is read with this build's runtime, not the one
      // pinned in its archive, so the panel says whose reading it is.
      + (readOnlyArchive() ? '<p data-bench-readiness-foreign>This build read these requirements with its own runtime, not the runtime pinned in this archive. They say what this build would need to run the project. They do not say whether the exported runner inside the archive is ready.</p>' : '')
      + READINESS_PURPOSES.map(purpose => readinessPurposeSection(frozen, purpose)).join('')
    if (frozen.corpus) field('corpus-ledger').textContent = json(frozen.corpus)
    if (frozen.audit) { field('audit-ledger').textContent = json(frozen.audit); preparedAudits = new Map(frozen.tasks.map(task => [task.id, task])); renderAuditCase() }
    renderNativePreparationPlan(frozen.nativePreparation, 'Frozen'); renderNativeControlJobs()
    syncControls(); preview(); renderReview()
  }
  function renderNativePreparationPlan(plan, basis = 'Draft') {
    field('native-preparation-plan').textContent = plan ? json(plan) : ''
    field('native-preparation-status').textContent = plan
      ? `${basis} ${plan.profile} roster: ${plan.counts.jobs} jobs, ${plan.counts.nativeExecutions} planned native executions, ${plan.counts.coverageRows} coverage rows. Coverage ${plan.coverageStatus}; ${plan.gaps.length} gaps; ${plan.apparatusRequirements.length} separate apparatus requirements. Execution: ${plan.executionStatus}. ${plan.scope}`
      : 'Apply and preview a native control plan to inspect its exact roster. No native preparation has run.'
  }
  function renderNativeControlJobs() {
    const jobs = frozen?.nativePreparation?.jobs || [], selected = field('native-control-job').value
    field('native-control-job').innerHTML = option('', jobs.length ? 'Choose a frozen control job' : 'Freeze a native plan first', '') + jobs.map(job => option(job.id,
      `${job.kind}: ${job.source.targetId} · ${job.source.scope}${job.source.probeId ? '/' + job.source.probeId : ''}${job.source.wrongReadingId ? '/' + job.source.wrongReadingId : ''} · ${job.replicates} repetitions`, selected)).join('')
    field('native-control-job').value = jobs.some(job => job.id === selected) ? selected : ''
    field('native-control-status').textContent = jobs.length ? 'Select a job to export its generated code, exact input, expected observation and pinned parent binding. Native qualification and aggregate preparation remain pending.' : ''
  }
  function nativePreparationFromFields() {
    const mode = field('native-preparation-mode').value
    invariant(['none', 'planned'].includes(mode), 'Choose whether to declare a native preparation plan.')
    if (mode === 'none') return null
    const number = (name, label) => {
      const value = String(field('native-preparation-' + name).value).trim()
      invariant(/^\d+$/.test(value) && Number.isSafeInteger(Number(value)), `${label} needs a complete nonnegative integer. Your text is preserved.`)
      return Number(value)
    }
    return { version: 1, coverage: 'all-selected-readings-occurrences-and-probes', rationale: field('native-preparation-rationale').value,
      referenceReplicates: number('reference-replicates', 'Reference repetitions'), mutantReplicates: number('mutant-replicates', 'Mutant repetitions'),
      budgets: { maxNativeExecutions: number('max-executions', 'Maximum planned executions'), executionTimeoutMs: number('execution-timeout', 'Native execution timeout'),
        attemptTimeoutMs: number('attempt-timeout', 'Control attempt timeout'), maxDurationMs: number('duration', 'Preparation duration budget') } }
  }
  // Freezing is local arithmetic over the current draft: it writes nothing to an
  // account, sends nothing and starts nothing. It used to sit behind guard(),
  // which made every step after it unreachable in the example workspace -- the
  // readiness report, the frozen inspection, the recorded run and the exported
  // ZIP -- while refusing with a sentence that names save, export, approve and
  // start work, none of which is what the person pressed. The actions that do
  // reach an account or start work keep their own guard() calls below (save,
  // draft-export, export, run, submit, approve, and every import), so a preview
  // can now carry a design to a frozen project and inspect it, and still cannot
  // save, export or run it.
  async function freeze(ticket) {
    snapshot()
    invariant(pending.size === 0, 'Apply the pending editor changes before freezing: ' + [...pending].join(', ') + '.')
    // Only the builder's untouched fields can follow its first source binding.
    // Retained/imported edits without a pending marker must remain source-bound.
    let pristineConditions = null
    if (!Object.hasOwn(spec, 'runtimeSources') && field('condition-fields').value) try {
      const context = conditionContext(), draft = createConditionFieldsDraft(context), text = field('condition-fields').value
      if (text === json(draft)) pristineConditions = { context, draft, text }
    } catch { /* Incomplete condition editors never block freezing applied source. */ }
    const draft = structuredClone(spec), files = structuredClone(attachments), code = await sources()
    assertCurrent(ticket)
    for (const [path, contents] of Object.entries(files)) {
      invariant(safePath(path) && typeof contents === 'string', 'Attached files need a relative path and text contents.')
      const digest = await sha256(contents)
      invariant(draft.inputs.some(input => input.path === path && input.sha256 === digest), `${path}: its attached contents disagree with the input manifest. Add or update the file before freezing.`)
    }
    let prepared = await bindRuntimeSources(draft, code)
    if (prepared.domain === 'lean-bench') prepared = await bindLeanReview(prepared, code)
    assertCurrent(ticket)
    // Keep the newly bound source packet visible even if its former review is
    // now stale, so the reviewer can inspect and approve the actual sources.
    if (canonical(prepared) !== canonical(spec)) {
      let carriedConditions = null
      if (pristineConditions && !pending.size && field('condition-fields').value === pristineConditions.text) try {
        const withoutPins = { ...prepared }; delete withoutPins.runtimeSources
        if (canonical(withoutPins) === canonical(pristineConditions.context.spec)
          && conditionFieldsBinding(conditionContext()) === pristineConditions.draft.binding) {
          // bindRuntimeSources supplied the complete current inventory. Every
          // other source field, including any LEAN review, must be unchanged.
          carriedConditions = { ...pristineConditions.draft,
            binding: conditionFieldsBinding({ ...pristineConditions.context, spec: prepared }) }
        }
      } catch { /* Preserve exact stale text when its context cannot be checked. */ }
      spec = prepared; changed(); renderBundle(); preview()
      if (carriedConditions) field('condition-fields').value = json(carriedConditions)
      renderConditionFields()
    }
    const candidate = await freezeStudy(prepared)
    assertCurrent(ticket)
    nativeVerification = null; renderNativeVerification()
    frozen = candidate; openedArchive = null
    renderFrozen()
    status('Project frozen. Its prompts, conditions, schedule and decisions are fixed.')
    return frozen
  }
  // Receipts embedded in an exported evidence file (results/qualification.json and
  // results/native-verification.json, as `node cli.mjs analyze` embeds them) travel
  // with their own SHA-256. Each is kept only when report.mjs binds it to this
  // frozen project and this journal and its recorded digest matches its bytes;
  // anything else is dropped and named in the status line, never repaired or
  // rendered. Unknown keys in the file are ignored as before.
  async function importedReceipts(currentProject, data) {
    const receipts = {}, dropped = []
    for (const [key, digestKey, label] of [['qualification', 'qualificationSha256', 'qualification receipt'], ['nativeVerification', 'nativeVerificationSha256', 'native verification receipt']]) {
      if (data[key] === undefined || data[key] === null) continue
      try {
        const bound = await boundReceipts(currentProject, data.events, { [key]: data[key] })
        invariant(data[digestKey] === undefined || data[digestKey] === bound[digestKey], 'its recorded SHA-256 does not match its bytes.')
        receipts[key] = bound[key]; receipts[digestKey] = bound[digestKey]
      } catch (error) { dropped.push(`Ignored the ${label} in this file: ${error.message}`) }
    }
    return { receipts, notes: dropped.length ? ' ' + dropped.join(' ') : '' }
  }
  function renderNativeVerification() {
    field('native-verification').textContent = nativeVerification
      ? `${nativeVerification.attempts.length} completed native results checked against retained artifacts. ${nativeVerification.scope} Receipt journal SHA-256: ${nativeVerification.journalSha256}.`
      : 'No native artifact verification is loaded. Ordinary journal imports do not verify native artifact bytes.'
    field('native-verification-details').innerHTML = nativeVerificationMarkup(nativeVerification)
  }
  async function renderEvidence() {
    const summary = evidence.summary
    const rate = value => value === null ? 'Unmeasured' : `${(value * 100).toFixed(1)}%`
    const criterion = esc(summary.criterion.label), audit = !!summary.audit, denominator = audit ? 'reference-eligible ' : ''
    field('results').innerHTML = `<h3>Run evidence</h3><p>${summary.completed} of ${summary.scheduled} trials completed · ${summary.attempts} attempts · ${summary.failed} failed · ${summary.pending} pending · ${summary.interrupted} interrupted</p>
      ${runJournalMarkup(frozen, evidence.events, summary)}
      ${summary.execution ? `<section data-bench-execution-evidence><h4>${esc(({ experiment: 'Experiment contract', 'apparatus-development': 'Apparatus development', 'recorded-diagnostic': 'Recorded diagnostics', legacy: 'Legacy evidence' })[summary.execution.purpose] || summary.execution.purpose)}</h4><p>${esc(summary.execution.scope)}</p><p>${esc(summary.execution.computationScope)}</p></section>` : ''}
      <p>Cohort: ${esc(summary.cohort)}. ${summary.analysisPlan ? `Primary denominator: ${esc(summary.analysisPlan.primaryDenominator)} ${denominator}trials.` : 'No primary denominator was declared.'}</p>
      ${summary.primaryPopulation ? `<section data-bench-primary-results><h4>Primary population results</h4><p>${esc(summary.primaryPopulation.label)}: ${summary.primaryPopulation.scheduled} scheduled trials included; ${summary.primaryPopulation.excludedScheduled} scheduled trials excluded from the primary analysis.</p><div class="bench-table-scroll" tabindex="0" role="region" aria-label="Primary population results table"><table><caption>Selected primary population by condition</caption><thead><tr><th>Condition</th><th>Selected scheduled</th><th>Selected completed</th><th>${criterion}</th><th>Primary rate (${esc(summary.analysisPlan.primaryDenominator)})</th><th>Excluded scheduled</th></tr></thead><tbody>${summary.groups.map(group => { const primary = group.primary; return `<tr><th>${esc(group.condition)}</th><td>${primary.scheduled}</td><td>${primary.measured}</td><td>${primary.passed}</td><td>${rate(summary.analysisPlan.primaryDenominator === 'scheduled' ? primary.scheduledPassRate : primary.passRate)}</td><td>${primary.excludedScheduled}</td></tr>` }).join('')}</tbody></table></div></section>` : ''}
      ${summary.customGrading ? `<p data-bench-custom-grade-evidence>Custom grade evidence: ${summary.customGrading.withProcessReceipt} completed grades have retained process receipts; ${summary.customGrading.withoutProcessReceipt} have no process receipt. These counts describe retained evidence, not authenticated execution. Browser checks do not run the Node grader.</p>` : ''}
      ${audit ? '<p>Agreement rates use reference labels fixed before collection. Unresolved references retain null scores and appear in the unscored count.</p>' : ''}
      <h4>All scheduled trial outcomes</h4><div class="bench-table-scroll"><table data-bench-all-results><caption>${esc(summary.criterion.definition)} All frozen tasks by condition with both denominators.</caption><thead><tr><th>Condition</th><th>Scheduled</th><th>Completed</th>${audit ? '<th>Eligible scheduled</th><th>Eligible completed</th><th>Unscored completed</th>' : ''}<th>${criterion}</th><th>Unmeasured</th><th>${criterion} / ${denominator}scheduled</th><th>${criterion} / ${denominator}completed</th><th>Mean score</th></tr></thead>
      <tbody>${summary.groups.map(group => `<tr><th>${esc(group.condition)}</th><td>${group.scheduled}</td><td>${group.measured}</td>${audit ? `<td>${group.eligibleScheduled}</td><td>${group.eligibleCompleted}</td><td>${group.unscored}</td>` : ''}<td>${group.passed}</td><td>${group.scheduled - group.measured}</td><td>${rate(group.scheduledPassRate)}</td><td>${rate(group.passRate)}</td><td>${group.meanScore === null ? 'Unmeasured' : group.meanScore}</td></tr>`).join('')}</tbody></table></div><details data-bench-raw-journal><summary>Raw attempts and responses</summary><pre tabindex="0">${esc(json(evidence.events))}</pre></details>`
    if (summary.selectedInputPreparation) {
      const preparation = summary.selectedInputPreparation
      const milliseconds = value => value === null ? 'Unavailable' : value > 0 && value < 0.001 ? '<0.001' : Number(value.toFixed(3)).toString()
      const known = (value, missing) => preparation.preparations === missing ? 'Unavailable' : milliseconds(value) + ' ms' + (missing ? ' (partial)' : '')
      field('results').append(el(`<section data-bench-preparation-results><h4>Selected-input preparation</h4>
        <p>${preparation.preparations ? `${preparation.preparations} preparations recorded; ${preparation.qualified} accepted qualification proofs. Measured duration available for ${preparation.preparations - preparation.missingElapsed} of ${preparation.preparations}; known subtotal ${esc(known(preparation.knownElapsedMs, preparation.missingElapsed))}. Budget charges available for ${preparation.preparations - preparation.missingCharge} of ${preparation.preparations}; known subtotal ${esc(known(preparation.knownBudgetChargeMs, preparation.missingCharge))}.` : 'No selected-input preparation is recorded in this journal.'}</p>
        <p>${esc(preparation.scope)} These values do not measure total study wall-clock time.</p>
        ${preparation.missingCharge ? '<p>Legacy receipts lack paired timing. Full preparation duration and budget totals remain unavailable; accepted proofs and historical trial outcomes remain inspectable.</p>' : ''}
        ${preparation.open || preparation.interrupted ? '<p>Open or interrupted preparation retains a reserved charge; its elapsed duration and interpreter termination remain unestablished.</p>' : ''}
        <details><summary>Preparation ledger</summary><div class="bench-table-scroll" tabindex="0" role="region" aria-label="Selected-input preparation table"><table style="min-width:72rem;overflow-wrap:normal;word-break:normal"><caption>Study preparation; separate from trial latency and provider accounting</caption><thead><tr><th>Start sequence</th><th>Terminal sequence</th><th>Status</th><th>Measured preparation ms</th><th>Budget charge ms</th><th>Charge basis</th><th>Qualifier settlement</th><th>Reason</th></tr></thead><tbody>${preparation.rows.map(row => `<tr><th>${row.startSeq ?? 'Unavailable'}</th><td>${row.terminalSeq ?? 'Unavailable'}</td><td>${esc(row.status)}</td><td>${esc(milliseconds(row.elapsedMs))}</td><td>${esc(milliseconds(row.budgetChargeMs))}</td><td>${esc(row.chargeBasis)}</td><td>${row.settled === null ? 'Unavailable' : row.settled ? 'Settled' : 'Not established'}</td><td>${esc(row.reason || '')}</td></tr>`).join('')}</tbody></table></div></details></section>`))
    }
    if (summary.resourcePreparation) {
      const preparation = summary.resourcePreparation, ms = value => value === null ? 'Unavailable' : value > 0 && value < 0.001 ? '<0.001' : Number(value.toFixed(3)).toString()
      field('results').append(el(`<section data-bench-resource-preparation><h4>Resource preparation</h4><p>${esc(preparation.scope)}</p><p>${preparation.preparations} preparations; ${preparation.open} open; ${preparation.interrupted} recovered. Budget charge: ${esc(ms(preparation.budgetChargeMs))} ms. Measured elapsed time is missing for ${preparation.missingElapsed} preparations; open the Preparation ledger below to see which.</p><details><summary>Preparation ledger</summary><div class="bench-table-scroll" tabindex="0" role="region" aria-label="Resource preparation table"><table><caption>Measured work and reserved recovery charges</caption><thead><tr><th>Intent</th><th>Terminal</th><th>Status</th><th>Elapsed ms</th><th>Charge ms</th><th>Charge basis</th></tr></thead><tbody>${preparation.rows.map(row => `<tr><th>${row.startSeq ?? 'Unavailable'}</th><td>${row.terminalSeq ?? 'Unavailable'}</td><td>${esc(row.status)}</td><td>${esc(ms(row.elapsedMs))}</td><td>${esc(ms(row.budgetChargeMs))}</td><td>${esc(row.chargeBasis)}</td></tr>`).join('')}</tbody></table></div></details></section>`))
    }
    if (summary.resourceEffects) field('results').append(el(`<section data-bench-resource-results><h4>Observed resource effects</h4><p>${esc(summary.resourceEffects.scope)}</p><div class="bench-table-scroll" tabindex="0" role="region" aria-label="Resource effects table"><table><caption>Complete observations only; cells marked Unavailable come from interrupted endpoints — read the Preparation ledger for what stopped.</caption><thead><tr><th>Trial</th><th>Task success</th><th>Ever collateral</th><th>Final collateral</th><th>Peak collateral</th><th>Observed actions</th></tr></thead><tbody>${summary.resourceEffects.rows.map(row => `<tr><th>${esc(row.trialId)}</th><td>${esc(row.effects?.taskSuccess ?? 'Unavailable')}</td><td>${row.effects?.everCollateralCount ?? 'Unavailable'}</td><td>${row.effects?.netCollateralCount ?? 'Unavailable'}</td><td>${row.effects?.peakCollateralCount ?? 'Unavailable'}</td><td>${row.effects?.observedActionCount ?? 'Unavailable'}</td></tr>`).join('')}</tbody></table></div></section>`))
    if (summary.observations) {
      const accounting = summary.observations
      const measurement = metric => metric.observedSubtotal === null ? 'Unavailable' : metric.observedSubtotal + (metric.total === null ? ' (partial)' : '')
      field('results').append(el(`<div><h3>All attempt resources</h3><p>Known subtotals include all started attempts. Missing measurements remain unavailable; reported charges and estimates stay separate in the exported report. Saved-response metadata does not establish new provider calls.</p><div class="bench-table-scroll" tabindex="0" role="region" aria-label="Attempt accounting table"><table><thead><tr><th>Condition</th><th>Attempts</th><th>Known input tokens</th><th>Known output tokens</th><th>Known attempt ms</th><th>Timed attempts</th></tr></thead><tbody>${accounting.groups.map(group => `<tr><th>${esc(group.condition)}</th><td>${group.attempts}</td><td>${esc(measurement(group.usage.inputTokens))}</td><td>${esc(measurement(group.usage.outputTokens))}</td><td>${esc(measurement(group.host.attemptMs))}</td><td>${group.host.attemptMs.observed} / ${group.attempts}</td></tr>`).join('')}</tbody></table></div></div>`))
    }
    if (frozen) {
      try {
        const sections = await researchPageSections(frozen, evidence.events, await inspectionOptions())
        field('results').append(el('<div data-bench-run-inspection><h3>How this run was produced</h3>'
          + '<p>Every block below is generated from this frozen project and this attempt journal by the same generator the exported research report uses. The page and the report therefore cannot describe this run differently.</p>'
          + methodMarkup(sections.method) + runMarkup(sections.run) + '</div>'))
      } catch (error) {
        field('results').append(el('<p data-bench-run-inspection-error>The run walkthrough could not be built from this evidence: '
          + esc(error.message) + ' The tables above and the raw journal are unaffected.</p>'))
      }
    }
    syncControls()
  }
  async function perform(event, ticket) {
    const button = event.target.closest('button')
    if (!button || button.closest('.bench-steps') || button.dataset.nodeWrap !== undefined) return
    const has = name => button.hasAttribute(`data-bench-${name}`)
    if (running && !has('cancel')) throw new Error('Wait for the active run to finish, or cancel it before changing the draft.')
    if (has('open-nesting')) { selectTab('nesting') }
    else if (has('new-empty')) {
      replace(emptyDraft(), {}, 'Empty draft for this project.'); selectTab('library')
      status('Empty draft created for this project. Undo replacement restores the preceding draft.')
    } else if (has('use-starter')) {
      const starter = field('starter').value
      const example = exampleExperimentDrafts.find(item => item.id === starter)
      if (example) {
        const draft = await example.load()
        assertCurrent(ticket)
        restoreDraft(draft, example.label, `Bundled example: ${example.label}. Its snippets, compositions and tasks came from this example.`)
        status(`Example draft loaded: ${example.label}. Its snippets, compositions and tasks are now shown below. Undo draft replacement returns to the previous draft.`)
        return
      }
      // A registered benchmark builds its own starter. The thunk is called HERE,
      // when a person chooses it -- never while the benchmark is registering.
      const registered = starterById(starter)
      let next
      if (starter === 'resource-action-plan') next = await resourceDraft(defaultResourceTemplateFields())
      else if (starter === 'generic') next = newExperimentDraft(genericStarter(), { initializePopulation: true })
      else {
        invariant(registered, `No registered benchmark offers the starter "${starter}".`)
        next = newExperimentDraft(await registered.create(), { initializePopulation: true })
        // Lean's own review binding, applied by the same domain guard the rest of
        // this page uses, so a third party's starter does not receive it.
        if (next.domain === 'lean-bench') next = await bindLeanReview(next, await sources())
      }
      assertCurrent(ticket)
      const label = registered?.label || CORE_STARTERS.find(item => item.id === starter)?.label || starter
      replace(next, {}, `Bundled example: ${label}. These fields came from the example, not your opened files.`)
      onBenchmarkLoaded(next); onOpen('design'); selectTab(starter === 'resource-action-plan' ? 'experiment' : 'compose')
      field('current-experiment').focus()
      status(`Example draft loaded: ${label}. Its snippets, tasks and settings are now shown below. Undo draft replacement returns to the previous draft.`)
    } else if (has('apply-resource-template')) {
      requireApplied(Object.keys(EDITOR_GROUPS).filter(group => group !== 'experiment'))
      const next = await resourceDraft(parse(field('resource-fields').value, 'Experiment fields'), spec.experimentTemplate ? spec : null)
      assertCurrent(ticket); replace(next); onBenchmarkLoaded(next); selectTab('experiment')
      status(`${next.tasks.length} resource cases generated. The fields now bind public requests, reference plans and independent effect observations; freeze before qualification and collection.`)
    } else if (has('undo')) { const prior = backup; invariant(prior, 'No replacement to undo.'); replace(prior.spec, prior.attachments, prior.origin || 'Restored previous draft.'); taskIndex = prior.taskIndex; bundleIndex = prior.bundleIndex; render(); for (const group of prior.pending || []) pending.add(group); applyEditors(prior.editors); status('Previous draft restored.') }
    else if (has('save')) { guard(); const saved = snapshot(); await storeFor(ticket).save(project, saved); assertCurrent(ticket); dirty = false; status('Draft saved to this project in your account.') }
    else if (has('draft-export')) { download(`${spec.id}-draft.json`, json(snapshot())); status('Draft exported, including unapplied editor text.') }
    else if (has('apply-task')) { requireApplied(['information']); const task = parse(field('task-json').value, 'Task'); invariant(task.root && task.id, 'A task needs an identifier and a root.'); spec.tasks[taskIndex] = task; pending.delete('task'); changed(); renderTask() }
    else if (has('apply-input')) { invariant(!pending.has('task'), 'Apply the complete task JSON before editing its input.'); const task = spec.tasks[taskIndex]; const input = parse(field('input').value, 'Input'), expected = parse(field('expected').value, 'Expected result'); task.input = input; task.expected = expected; pending.delete('input'); changed(); renderTask() }
    else if (has('derive-expected')) {
      requireApplied(Object.keys(EDITOR_GROUPS).filter(group => !['compositionFields', 'compositionFamilies'].includes(group))); invariant(pageSurfaceForDomain(spec.domain).derivesExpected, 'Expected interpretation requires a benchmark that derives expected observations.')
      const expected = await deriveTaskExpected(spec, spec.tasks[taskIndex]); assertCurrent(ticket)
      spec.tasks[taskIndex].expected = expected; changed(); renderTask()
      status('Draft expected observation derived from the current composition and input. Independently qualify it before a study.')
    }
    else if (has('prepare-information-fields') || has('reset-information-fields')) {
      guard(); requireApplied(Object.keys(EDITOR_GROUPS).filter(group => group !== 'informationFields'))
      const code = await sources(); assertCurrent(ticket)
      let bound = await bindRuntimeSources(spec, code)
      if (bound.domain === 'lean-bench') bound = await bindLeanReview(bound, code)
      const inventory = await informationFieldInventory(bound, bound.tasks[taskIndex].id); assertCurrent(ticket)
      let draft = has('reset-information-fields') ? null : informationDraft()
      if (has('reset-information-fields') || !draft) {
        backup = capture(); field('undo').hidden = false
        draft = createInformationFieldDraft(inventory)
      }
      spec = bound; informationInventory = inventory; informationInventoryContext = informationContext()
      field('information-fields').value = json(draft); pending.add('informationFields'); changed(); renderBundle(); renderInformationFields()
      status('Information fields prepared. Choose withheld atoms and explicit reading alternatives, then build the treatment. Existing fields require an explicit replacement when their source changes.')
    }
    else if (has('apply-information-fields')) {
      guard(); requireApplied(Object.keys(EDITOR_GROUPS).filter(group => group !== 'informationFields'))
      const prior = capture(), draft = informationDraft(); invariant(draft, 'Prepare information fields first.')
      invariant(draft.taskId === spec.tasks[taskIndex].id, 'Select the source task named by these information fields before building.')
      const generated = await compileInformationFields(spec, draft); assertCurrent(ticket)
      const next = structuredClone(spec); next.tasks[taskIndex] = generated.task
      backup = prior; field('undo').hidden = false; spec = next
      pending.delete('informationFields'); field('information-fields').value = ''
      informationInventory = null; informationInventoryContext = null
      changed(); render(); field('information-details').open = true
      status('Information treatment built from fields. Inspect its compiled prompt and readings, prepare the complete review packet, and record your own review before collection. Undo restores the preceding draft and field text.')
    }
    else if (has('add-information')) {
      requireApplied(['task', 'input', 'information']); invariant(!spec.corpusPlan, 'Detach the task recipe before manually changing generated tasks, or edit the recipe and regenerate.')
      const task = spec.tasks[taskIndex]; task.familyId ||= task.id; task.information = informationPlanFromTask(task)
      changed(); renderTask(); field('information-details').open = true; status('Draft treatment created from this task. Declare its withheld requirements and candidate readings before review.')
    }
    else if (has('apply-information')) {
      requireApplied(['task', 'input']); invariant(!spec.corpusPlan, 'Detach the task recipe before manually changing generated tasks, or edit the recipe and regenerate.')
      const selection = field('information-selection').value
      invariant(['readingPool', 'readings'].includes(selection), 'Choose a reading selection rule.')
      const information = { version: 1, scope: 'declared-set', rationale: field('information-rationale').value, responseMode: field('information-mode').value,
        withheldPaths: parse(field('information-paths').value, 'Withheld atom paths'), [selection]: parse(field('information-readings').value, 'Reading candidates') }
      validateInformation(information); spec.tasks[taskIndex].information = information; pending.delete('information'); changed(); renderTask(); status('Information treatment applied. Inspect the visible prompt and prepare its complete review packet.')
    }
    else if (has('prepare-information')) {
      guard(); requireApplied(Object.keys(EDITOR_GROUPS))
      const code = await sources(); assertCurrent(ticket)
      let prepared = await bindRuntimeSources(spec, code)
      if (prepared.domain === 'lean-bench') prepared = await bindLeanReview(prepared, code)
      assertCurrent(ticket)
      const task = await compileTask(prepared, prepared.tasks[taskIndex], { requireReview: false, requireTaskReview: false })
      invariant(task.informationPacket, 'Declare an information treatment in the task JSON first.'); assertCurrent(ticket)
      spec = prepared; changed(); renderBundle(); preview(); preparedInformation = { taskId: task.id, sha256: task.informationPacket.sha256 }
      field('information-packet').textContent = json(task.informationPacket); status('Current prompt, readings, expected observations and runtime sources are prepared for your review.' + (task.informationPacket.version === 2 ? ' Inspect the declared condition settings, workflow assignments and stage context; actual dynamic requests are retained during execution.' : ' This legacy packet does not bind the full collection context.'))
    }
    else if (has('approve-information')) {
      guard(); requireApplied(Object.keys(EDITOR_GROUPS)); invariant(preparedInformation, 'Prepare and inspect the current information packet first.')
      const prepared = preparedInformation, task = await compileTask(spec, spec.tasks[taskIndex], { requireReview: false, requireTaskReview: false })
      assertCurrent(ticket); invariant(task.id === prepared.taskId && task.informationPacket?.sha256 === prepared.sha256, 'The information packet changed. Prepare and inspect it again before recording a review.')
      const review = await createTaskReviewRecord(task, field('information-reviewer').value); assertCurrent(ticket)
      spec.taskReviews = [...(spec.taskReviews || []), review]; changed(); preview(); status('Your review is bound to this task’s exact prompt, full reading set and source versions.' + (task.informationPacket.version === 2 ? ' It also binds the declared condition settings, workflow assignments and stage context.' : ' This legacy review does not bind the full collection context.') + ' Save the draft to keep it.')
    }
    else if (has('reset-routing')) {
      requireApplied(['task'])
      backup = snapshot(); field('undo').hidden = false
      field('routing').value = json(createRoutingDraft(spec.tasks[taskIndex]))
      changed(); renderRouting()
      status('These rules start again from the current task. Undo replacement restores the preceding draft.')
    }
    else if (has('apply-routing')) {
      requireApplied(['task', 'input', 'information'])
      invariant(!spec.corpusPlan, 'Detach the task recipe before replacing generated tasks, or edit the recipe and regenerate.')
      const draft = routingDraft(); invariant(draft, 'There are no rules here to generate from. Press Start these rules again to build a set from the task open above.')
      const tasks = routedTasks(draft, { catalog: spec.catalog, split: field('split').value })
      invariant(tasks.length <= 512, `Routing produced ${tasks.length} tasks; a study holds at most 512. Remove rows before generating.`)
      backup = snapshot(); field('undo').hidden = false
      spec.tasks = tasks; taskIndex = 0
      changed(); render()
      const decided = tasks.map(task => task.id).join(', ')
      // ROUTING USED TO CALL EVERY ROW A SUCCESS, INCLUDING THE ROWS THAT DID NOT COMPOSE.
      //
      // routedTasks() assembles the trees; it does not compile them, so a row
      // pointing at a bundle whose composition role the place cannot accept was
      // still counted and still announced -- "1 task generated from your routing"
      // and "Every row was routed" -- while the prompt pane quietly held the
      // compiler's refusal instead of a prompt. Measured with the shipped example
      // library: routing offers all 21 T1v0 variants and 25 matching-code bundles
      // at the root address, and every one of them lands in that state.
      // Freezing refuses them, so nothing false could ever be exported, but the
      // person is told it worked and only finds out at the end.
      //
      // The compiler is the authority on whether a row composed, so ask it, and
      // name the first row that did not rather than reporting a clean success.
      const failures = []
      for (const task of tasks) {
        try { await compileTask(spec, task, { requireReview: false, requireTaskReview: false, validateExpected: false }) }
        catch (error) { failures.push(`${task.id}: ${error.message}`); if (failures.length >= 3) break }
      }
      assertCurrent(ticket)
      if (failures.length) {
        const note = `${failures.length === tasks.length ? 'No row' : `${tasks.length - failures.length} of ${tasks.length} rows`} produced a usable task. ${failures.join(' ')}`
        status(`${note} Undo replacement restores the preceding draft.`)
        field('routing-status').textContent = `${failures.length} row${failures.length === 1 ? '' : 's'} did not compose. Choose a bundle whose composition role the place accepts, or change the place.`
      } else {
        status(`${tasks.length} task${tasks.length === 1 ? '' : 's'} generated from your routing: ${decided}. Undo replacement restores the preceding draft.`)
        field('routing-status').textContent = `Every row was routed. Each task carries the field values it was routed on, so a composition can quote them.`
      }
    }
    else if (has('add-task')) {
      requireApplied(['bundle', 'task', 'input', 'information'])
      const bundle = spec.catalog[bundleIndex] || spec.catalog[0]
      invariant(bundle, 'Create or import a snippet before adding a task.')
      const task = spec.tasks[taskIndex] ? structuredClone(spec.tasks[taskIndex]) : { root: refFor(bundle), input: null, expected: '', split: 'development' }
      let i = spec.tasks.length + 1; while (spec.tasks.some(row => row.id === `task-${i}`)) i++
      task.id = `task-${i}`; spec.tasks.push(task); taskIndex = spec.tasks.length - 1; changed(); renderTask()
    }
    else if (has('delete-task')) {
      requireApplied(['task', 'input', 'information']); invariant(spec.tasks[taskIndex], 'Choose a task to remove.')
      backup = snapshot(); field('undo').hidden = false; spec.tasks.splice(taskIndex, 1)
      changed(); renderTask()
    }
    else if (button.hasAttribute('data-bench-snippet-category')) {
      field('snippet-label-filter').value = button.getAttribute('data-bench-snippet-category')
      renderSnippetList()
    }
    else if (has('select-snippet')) {
      invariant(!pending.has('bundle'), 'Apply the current snippet edits before opening another snippet. Your text is preserved.')
      const index = Number(button.getAttribute('data-bench-select-snippet'))
      invariant(Number.isInteger(index) && index >= 0 && index < spec.catalog.length, 'Choose a snippet from this library.')
      bundleIndex = index; renderBundle()
    }
    else if (has('delete-snippet')) {
      const doomed = spec.catalog[bundleIndex]
      invariant(doomed, 'Choose a snippet to delete.')
      // Never leave a task pointing at a snippet that is gone, or a template
      // depending on one. Name what is still using it so the person can act.
      const usedByTask = []
      for (const task of spec.tasks) {
        const stack = [task.root]
        while (stack.length) {
          const node = stack.pop()
          if (node?.use === doomed.id && !usedByTask.includes(task.id)) usedByTask.push(task.id)
          stack.push(...Object.values(node?.slots || {}))
        }
      }
      invariant(!usedByTask.length, `${snippetTitle(doomed)} is used by ${usedByTask.join(', ')}. Point ${usedByTask.length > 1 ? 'those tasks' : 'that task'} at another snippet first.`)
      const neededBy = spec.catalog.filter(item => (item.dependencies || []).includes(doomed.id)).map(snippetTitle)
      invariant(!neededBy.length, `${snippetTitle(doomed)} is needed by ${neededBy.join(', ')}. Remove that dependency first.`)
      backup = snapshot(); field('undo').hidden = false
      pending.delete('bundle')
      spec.catalog.splice(bundleIndex, 1)
      bundleIndex = Math.min(bundleIndex, spec.catalog.length - 1)
      changed(); renderBundle(); renderTask()
      const gone = `Deleted ${snippetTitle(doomed)}. Undo restores it.`
      status(gone); field('snippet-status').textContent = gone
    }
    else if (has('vary-snippet')) {
      requireApplied(['bundle'])
      const bundle = spec.catalog[bundleIndex]
      invariant(bundle?.kind === 'atom', 'Open a filled composition in Nesting to vary a template and its members.')
      beginVariance({ kind: 'snippet', id: bundle.id })
    }
    else if (has('compose-snippets')) { requireApplied(['bundle']); selectTab('compose') }
    // Examples enter only through this explicit import, including in a new
    // project. Repeating the import adds no duplicates and opening a project
    // never reverses the investigator's deletion of an example.
    else if (has('load-examples')) {
      requireApplied(['bundle'])
      const before = spec.catalog.length
      const { exampleSnippetLibrary } = await loadExampleSnippets()
      assertCurrent(ticket)
      const merged = importSnippetLibrary(exampleSnippetLibrary(), spec.catalog)
      const added = merged.length - before
      if (!added) {
        const already = 'Every example snippet is already in this library.'
        status(already); field('snippet-status').textContent = already
        return
      }
      backup = snapshot(); field('undo').hidden = false
      spec.catalog = merged; bundleIndex = before
      field('snippet-search').value = ''; field('snippet-label-filter').value = ''
      changed(); renderBundle(); renderTask()
      const note = `${added} example snippet${added === 1 ? '' : 's'} added. Edit or delete any of them; Undo replacement restores the preceding draft.`
      status(note); field('snippet-status').textContent = note
    }
    else if (has('export-snippets')) {
      // Local authoring files work in the hotload as well as the desktop app.
      // Account saves, review approval and benchmark execution keep their guards.
      requireApplied(['bundle'])
      download(`${spec.id}-snippets.json`, json(exportSnippetLibrary(spec.catalog)))
      status('Snippet library exported locally, including names, labels, wording and advanced definitions.')
      field('snippet-status').textContent = 'Snippet library exported. Import that file to reuse these snippets in another benchmark.'
    }
    else if (has('apply-bundle')) { applyBundle(); status('Snippet updated in this benchmark. Its previous review applies only if the exact content still matches.'); field('snippet-status').textContent = 'Snippet applied to this benchmark. Export snippets to keep a portable copy, or save the draft to your account when connected.' }
    else if (has('approve')) { guard(); applyBundle(); const reviewed = await createReviewRecord(spec.catalog, spec.catalog[bundleIndex].id, field('reviewer').value); assertCurrent(ticket); spec.reviews = [...(spec.reviews || []), reviewed]; changed(); renderBundle(); preview(); status('Your review was recorded for this bundle and its complete dependency root. Save the draft to keep it.') }
    else if (has('add-atom') || has('add-template') || has('clone-bundle')) {
      requireApplied(['bundle'])
      const template = has('add-template'), clone = has('clone-bundle')
      let id = `bundle-${spec.catalog.length + 1}`; while (spec.catalog.some(item => item.id === id)) id += '-copy'
      const bundle = clone ? { ...structuredClone(spec.catalog[bundleIndex]), id, title: snippetTitle(spec.catalog[bundleIndex]) + ' copy', review: null } : { id, title: template ? 'Untitled template' : 'Untitled snippet', labels: [], version: '1', kind: template ? 'template' : 'atom', role: 'node', text: template ? 'Write what this template says around its children.' : '', parameters: {}, slots: {}, semantics: { kind: 'prompt' }, tests: [] }
      invariant(spec.catalog.length < 512, 'This benchmark already has 512 snippets and templates.')
      spec.catalog.push(bundle); bundleIndex = spec.catalog.length - 1; field('snippet-search').value = ''; field('snippet-label-filter').value = ''; changed(); renderBundle(); pending.add('bundle'); renderTask(); selectTab('library')
      field('snippet-status').textContent = clone ? 'Copy created. Edit its name, text or labels, then apply it.' : 'Name this snippet, add your labels, and write its instruction. Apply it when ready.'
      field('bundle-title').focus(); field('bundle-title').select?.()
    } else if (has('add-slot')) {
      // The name is the person's. The page refuses one the compiler cannot
      // address, and refuses a repeat, rather than choosing a name itself.
      const name = field('slot-name').value.trim()
      invariant(/^[a-z][a-z0-9_-]{0,63}$/.test(name), 'Name the child place with lowercase letters, digits, - or _, starting with a letter.')
      const slots = parse(field('slots').value || '{}', 'Slot names and roles')
      invariant(object(slots), 'Slot names and roles must be an object.')
      invariant(!Object.hasOwn(slots, name), `This snippet already has a child place called ${name}.`)
      slots[name] = 'node'
      field('slots').value = json(slots)
      const wording = field('wording').value
      if (!wording.includes(`{{slot:${name}}}`)) field('wording').value = wording + (!wording || wording.endsWith('\n') ? '' : '\n') + `{{slot:${name}}}`
      field('bundle-kind').value = 'template'
      field('slot-name').value = ''
      pending.add('bundle'); changed(); syncControls()
      field('snippet-status').textContent = `Child place ${name} added to the wording. Apply the snippet, then fill ${name} in Compose tasks.`
    } else if (has('load-source')) {
      const files = await listApparatusSources(ticket)
      field('source-code').textContent = files[field('source-file').value]
    } else if (has('apply-protocol')) { const previousGrading = spec.protocol?.grading?.kind; applyProtocol(); const note = await alignLeanCanary(previousGrading, ticket); status('Protocol applied. Freeze to validate the full task and condition schedule.' + note) }
    else if (has('start-family-workspace')) {
      requireApplied(Object.keys(EDITOR_GROUPS).filter(group => !['compositionFields', 'compositionFamilies', 'corpus'].includes(group)))
      invariant(!familyDraft(), 'The family workspace is already active.')
      const bound = await boundFamilySources(ticket), local = compositionDraft(), taskId = local?.taskId || bound.tasks[taskIndex]?.id
      const task = bound.tasks.find(task => task.id === taskId)
      invariant(task, 'The original selected task is unavailable. Import its source draft or use Undo if available.')
      const inventory = await compositionFieldInventory(bound, taskId); assertCurrent(ticket)
      const draft = local || createCompositionFieldDraft(inventory)
      backup = snapshot(); field('undo').hidden = false
      const workspace = { version: 1, rationale: '', seed: draft.seed, selection: structuredClone(draft.selection), coverage: structuredClone(draft.coverage),
        families: [{ sourceTask: structuredClone(task), fields: draft }] }
      spec = bound; familySelected = taskId; familyInventory = inventory; familyReadOnly = false
      field('composition-family-fields').value = json(workspace); pending.delete('compositionFields'); pending.add('compositionFamilies'); changed(); renderProtocol(); renderFamilyWorkspace()
      status('Family workspace started. Add the other source families before generating once; fill the combined sampling policy and every family rationale.')
    }
    else if (has('prepare-family-fields')) { await inspectFamily(ticket) }
    else if (has('export-family-sources')) {
      guard(); requireApplied(Object.keys(EDITOR_GROUPS).filter(group => !['compositionFields', 'compositionFamilies'].includes(group)))
      const derivative = createCompositionFamilySourceDraft({ spec: applyIdentity({ ...spec }), attachments,
        familyFields: field('composition-family-fields').value, singleFields: field('composition-fields').value })
      validateDraft(derivative.spec, derivative.attachments); assertCurrent(ticket)
      download(`${derivative.spec.id}-family-sources-draft.json`, json(derivative))
      status('Editable family source draft exported. Import it separately to edit, rebuild and regenerate. Current tasks and evidence are unchanged; no source binding or qualification was refreshed.')
    }
    else if (has('reset-family-fields')) {
      requireApplied(Object.keys(EDITOR_GROUPS).filter(group => !['compositionFields', 'compositionFamilies', 'corpus'].includes(group)))
      const workspace = familyDraft(), entry = workspace?.families?.find(row => row.sourceTask?.id === familySelected)
      invariant(entry, 'Choose a retained family to replace explicitly.')
      const bound = await boundFamilySources(ticket), task = bound.tasks.find(task => task.id === familySelected)
      invariant(task, 'Import the original source draft or use Undo if available; a retained capsule cannot replace a missing live task.')
      const inventory = await compositionFieldInventory(bound, task.id); assertCurrent(ticket)
      backup = snapshot(); field('undo').hidden = false
      entry.sourceTask = structuredClone(task); entry.fields = createCompositionFieldDraft(inventory)
      spec = bound; familyInventory = inventory; familyReadOnly = false
      field('composition-family-fields').value = json(workspace); pending.add('compositionFamilies'); changed(); renderProtocol(); renderFamilyWorkspace()
      status('Selected family fields replaced from its current source. Other family fields and the global policy are retained; Undo is available in this page.')
    }
    else if (has('leave-family-workspace')) {
      invariant(familyDraft(), 'There is no active family workspace.')
      backup = snapshot(); field('undo').hidden = false
      field('composition-family-fields').value = ''; familyInventory = null; familySelected = ''; familyReadOnly = false
      pending.delete('compositionFamilies'); if (compositionDraft()) pending.add('compositionFields')
      changed(); renderFamilyWorkspace()
      status('Single-family fields restored with their original local policy text. The family workspace is available through Undo in this page.')
    }
    else if (has('prepare-composition-fields') || has('reset-composition-fields')) {
      invariant(!familyDraft(), 'Use the active family workspace to inspect or replace source family fields.')
      requireApplied(Object.keys(EDITOR_GROUPS).filter(group => group !== 'compositionFields'))
      const code = await sources(); assertCurrent(ticket)
      let bound = await bindRuntimeSources(spec, code)
      if (bound.domain === 'lean-bench') bound = await bindLeanReview(bound, code)
      const inventory = await compositionFieldInventory(bound, spec.tasks[taskIndex].id); assertCurrent(ticket)
      let draft = compositionDraft()
      if (has('reset-composition-fields') || !draft) {
        backup = snapshot(); field('undo').hidden = false
        draft = createCompositionFieldDraft(inventory)
      }
      spec = bound; compositionInventory = inventory
      field('composition-fields').value = json(draft); pending.add('compositionFields'); changed(); renderProtocol()
      compositionEditor.setContext(inventory, draft)
      field('composition-fields-status').textContent = `${inventory.rows.length} exact occurrences enumerated. Enable the occurrences to vary and supply their choices. Retained edits require an explicit fresh roster if the source changed.`
      status('Occurrence fields prepared. Supply the construction and expected-answer policy before building the recipe.')
    }
    else if (has('apply-composition-fields')) {
      requireApplied(Object.keys(EDITOR_GROUPS).filter(group => !['compositionFields', 'compositionFamilies', 'corpus'].includes(group)))
      const workspace = familyDraft()
      invariant(workspace || compositionDraft(), 'Prepare occurrence fields for the selected task first.')
      const bound = await bindRuntimeSources(spec, await sources()), generated = workspace
        ? await compileCompositionFamilyFields(bound, workspace) : await compileCompositionFields(bound, compositionDraft())
      assertCurrent(ticket); spec = bound
      if (workspace) familyInventory = generated.inventories.find(row => row.taskId === familySelected) || null
      else compositionInventory = generated.inventory
      field('corpus-plan').value = json(generated.plan); pending.delete('compositionFields'); pending.delete('compositionFamilies'); pending.add('corpus'); changed(); renderProtocol()
      field('composition-fields-status').textContent = `${workspace ? generated.construction.axisMappings.length : generated.construction.axisPaths.length} occurrence factors; ${generated.construction.requestedAssignments} complete assignments before exclusions; selection limit ${generated.construction.selectedLimit}. ${workspace ? generated.construction.families.length + ' source families; factor quotas are scoped within each family. ' : ''}Generate tasks to inspect coverage and all exclusions. ${generated.construction.scope}`
      status('Task recipe built from the occurrence fields. Generate tasks to replace the task list and inspect its full control workload.')
    }
    else if (has('seed-corpus')) {
      requireApplied(['task', 'input', 'bundle', 'specification'])
      field('corpus-plan').value = json(corpusPlanFromTask(spec.tasks[taskIndex])); pending.add('corpus'); changed(); status('Draft recipe prepared. Add axes and coverage, then generate its task list.')
    }
    else if (has('generate-corpus')) {
      requireApplied(Object.keys(EDITOR_GROUPS).filter(group => group !== 'corpus'))
      const next = structuredClone(spec); next.corpusPlan = parse(field('corpus-plan').value, 'Task recipe')
      const generated = await materializeCorpus(next); assertCurrent(ticket)
      field('corpus-ledger').textContent = json(generated.manifest)
      invariant(generated.manifest.status === 'ready', `Task generation is ${generated.manifest.status}. Inspect the coverage and exclusion ledger; the previous task list is retained.`)
      next.tasks = generated.tasks
      next.conditions = resetRecordedResponses(next.conditions)
      const retainedFields = field('composition-fields').value, retainedFamilyFields = field('composition-family-fields').value,
        retainedFamilySelected = familySelected, retainedFamilyInventory = familyInventory
      let obligations = null, obligationError = null
      try { obligations = await requirementFieldInventory(next) } catch (error) { obligationError = error.message }
      assertCurrent(ticket)
      replace(next, attachments); field('corpus-ledger').textContent = json(generated.manifest)
      field('composition-fields').value = retainedFields; compositionEditor.setContext(null, compositionDraft())
      field('composition-family-fields').value = retainedFamilyFields; familySelected = retainedFamilySelected; familyInventory = retainedFamilyInventory
      familyReadOnly = !!retainedFamilyFields; renderFamilyWorkspace()
      if (retainedFamilyFields) field('family-source-status').textContent = 'Generated tasks replaced the live sources. These retained source fields are read-only; use Undo if available or import the original source draft to edit and rebuild.'
      field('composition-obligations').innerHTML = obligations
        ? `<p>${obligations.rows.length} exact occurrence controls across ${generated.tasks.length} generated tasks; at least ${obligations.rows.length * 4} independent interpreter cases. Complete qualification supports ${obligations.limits.targets} targets and ${obligations.limits.cases} cases. ${obligations.appendices.length} runtime appendix obligations remain separate.</p><p>Prepare controls in Qualification. Structural coverage does not establish activation, correct expected answers or independent qualification. Existing task-bound plans and reviews must match the new design.</p>${obligations.blocking.length ? '<ul>' + obligations.blocking.map(row => '<li>' + esc(row.reason) + '</li>').join('') + '</ul>' : ''}`
        : '<p>The full control inventory could not be built: ' + esc(obligationError) + '. Fix what it names and generate the tasks again. Qualification remains unestablished; no partial roster is approved.</p>'
      status(`${generated.tasks.length} tasks generated from ${generated.manifest.candidateCount} candidates. The recipe and exclusion ledger will be verified at freeze and export.`)
    }
    else if (has('detach-corpus')) {
      requireApplied(Object.keys(EDITOR_GROUPS)); invariant(spec.corpusPlan, 'There is no attached task recipe.')
      const next = structuredClone(spec)
      next.corpusHistory = [...(next.corpusHistory || []), { kind: 'detached-recipe', recipe: next.corpusPlan }]
      delete next.corpusPlan
      next.tasks = next.tasks.map(({ generation, ...task }) => ({ ...task, ...(generation ? { origin: { kind: 'detached-corpus', generation } } : {}) }))
      replace(next, attachments); status('Recipe detached. Its history and each task’s origin remain in the specification.')
    }
    else if (has('generate-audit')) {
      requireApplied(Object.keys(EDITOR_GROUPS).filter(group => group !== 'audit'))
      invariant(spec.auditPlan?.reference, 'Import a source reference bundle first.')
      const plan = parse(field('audit-plan').value, 'Audit plan')
      invariant(object(plan) && !Object.hasOwn(plan, 'reference'), 'The plan editor cannot replace source evidence. Import a sealed reference bundle to change it.')
      const next = structuredClone(spec); next.auditPlan = { ...plan, reference: next.auditPlan.reference }
      const generated = await materializeAudit(next.auditPlan); assertCurrent(ticket)
      next.tasks = generated.tasks
      next.conditions = resetRecordedResponses(next.conditions)
      replace(next, attachments); field('audit-ledger').textContent = json(generated)
      status(`${generated.tasks.length} audit cases generated; ${generated.manifest.referenceEligibleCases} have reference labels. Configure the judge and protocol, then prepare the case reviews.`)
    }
    else if (has('prepare-audit')) {
      guard(); requireApplied(Object.keys(EDITOR_GROUPS)); invariant(spec.auditPlan, 'Import and generate an audit first.')
      const code = await sources(); assertCurrent(ticket)
      const prepared = await bindRuntimeSources(spec, code), review = await prepareStudyReview(prepared)
      assertCurrent(ticket); spec = prepared; changed(); renderBundle(); preview()
      preparedAudits = new Map(review.tasks.map(task => [task.id, task])); renderAuditCase(); field('audit-ledger').textContent = json(review.audit)
      status('Current judge requests, criteria, source evidence and analysis mappings are prepared. Inspect each case packet and the retained source files before recording its review.')
    }
    else if (has('approve-audit')) {
      guard(); requireApplied(Object.keys(EDITOR_GROUPS))
      const selected = spec.tasks[taskIndex], prepared = preparedAudits.get(selected.id)
      invariant(prepared, 'Prepare and inspect the current audit packets first.')
      const code = await sources(); assertCurrent(ticket)
      const bound = await bindRuntimeSources(spec, code), currentReview = await prepareStudyReview(bound)
      assertCurrent(ticket)
      const task = currentReview.tasks.find(row => row.id === selected.id)
      invariant(task?.auditPacket.sha256 === prepared.auditPacket.sha256, 'The audit packet or apparatus source changed. Prepare and inspect it again before recording a review.')
      const record = await createAuditReviewRecord(task, field('audit-reviewer').value); assertCurrent(ticket)
      spec.auditReviews = [...(spec.auditReviews || []), record]; changed()
      preparedAudits = new Map(currentReview.tasks.map(task => [task.id, task])); renderAuditCase()
      status('Your review is bound to this case’s exact judge request, reference evidence, criterion, protocol and analysis. Save or export the draft to keep it.')
    }
    else if (has('export-reference')) {
      guard(); invariant(frozen && evidence && !frozen.audit, 'Freeze a source study and load its evidence first.')
      const currentProject = frozen, events = structuredClone(evidence.events), attached = structuredClone(attachments), code = await sources()
      assertCurrent(ticket)
      invariant(currentProject.spec.protocol.grading.kind !== 'module', 'Create this reference with node cli.mjs reference in the source project, which rechecks its custom grader.')
      const paths = auditReferencePaths(currentProject, events), files = {}
      invariant(paths.every(item => item.location === 'project'), 'Native execution files are required. Create this reference with node cli.mjs reference in the source project, then import its results/reference-bundle.json.')
      for (const item of paths) {
        const value = item.key.startsWith('runtime/') ? code[item.path] : attached[item.path]
        invariant(typeof value === 'string', `${item.path}: attach the pinned source file or create the reference with node cli.mjs reference in the source project.`)
        files[item.key] = value
      }
      const reference = await sealAuditReference(currentProject, events, files); assertCurrent(ticket)
      download(`${currentProject.spec.id}-reference.json`, canonical(reference) + '\n')
      status('Reference exported with the frozen source, complete attempt journal and pinned files.')
    }
    else if (has('seed-workflow')) {
      requireApplied(['workflow', 'specification', 'protocol'])
      invariant(!spec.workflowPlan, 'A workflow is already applied. Edit it below.')
      field('workflow-config').value = json(workflowDraft(spec)); pending.add('workflow'); changed()
      status('Workflow draft created. Declare accounting, adapter responses and stage controls before applying it.')
    }
    else if (has('apply-workflow')) {
      requireApplied(['specification', 'protocol', 'observations'])
      const next = applyWorkflowDraft(spec, parse(field('workflow-config').value, 'Workflow draft'))
      validateStudy(next); spec = next; pending.delete('workflow'); changed(); renderProtocol()
      status(next.workflowPlan ? 'Workflow applied. Freeze it with the study before collection.' : 'Workflow removed from this draft.')
    }
    else if (has('apply-workflow-setup')) {
      guard(); requireApplied(Object.keys(EDITOR_GROUPS).filter(group => !['workflow', 'protocol', 'observations'].includes(group)))
      const prior = capture()
      applyIdentity(prior.spec)
      const next = applyWorkflowSetup(prior.spec, { protocolFields: protocolEditorFields({ requireComplete: true }),
        workflow: parse(field('workflow-config').value, 'Workflow draft'), observationPlan: parse(field('observation-plan').value, 'Accounting plan') })
      assertCurrent(ticket)
      backup = prior; field('undo').hidden = false; spec = next
      for (const group of ['workflow', 'protocol', 'observations']) pending.delete(group)
      changed(); renderProtocol()
      status('Workflow, protocol and accounting applied together. Freeze to inspect the current execution requirements. Undo restores the preceding draft and editor text.')
    }
    else if (has('prepare-condition-fields')) {
      guard(); requireApplied(Object.keys(EDITOR_GROUPS).filter(group => !['conditionFields', 'workflow', 'protocol', 'observations'].includes(group)))
      const prior = capture(), draft = createConditionFieldsDraft(conditionContext())
      assertCurrent(ticket); backup = prior; field('undo').hidden = false
      field('condition-fields').value = json(draft); pending.delete('conditionFields'); dirty = true; renderConditionFields()
      status('Condition fields prepared from the current setup. Fill requested identities, typed settings and explicit response checks; current results are unchanged.')
    }
    else if (has('generate-pipeline')) {
      guard(); requireApplied(Object.keys(EDITOR_GROUPS).filter(group => !['conditionFields', 'workflow', 'protocol', 'observations'].includes(group)))
      protocolEditorFields({ requireComplete: true })
      const generated = generatePipeline(pipelineEditor.value(), currentPipelineSettings())
      invariant(generated.conditions.length, 'Add a surface with an exact model id and at least one effort first.')
      const prior = capture(); applyIdentity(prior.spec)
      // New conditions go through the condition fields, so accounting checks
      // and workflow assignments stay coherent; existing ids are left as they are.
      const context = conditionContext(); let fieldsDraft = createConditionFieldsDraft(context)
      let added = 0
      for (const condition of generated.conditions) {
        if (fieldsDraft.rows.some(row => row.id === condition.id)) continue
        fieldsDraft = addConditionFieldsRow(context, fieldsDraft, { id: condition.id, profile: 'command' })
        const row = fieldsDraft.rows.find(item => item.id === condition.id)
        row.label = { present: true, text: condition.label }
        row.model = { mode: 'fields', present: true, settingsPresent: true, settings: [{ key: 'effort', type: 'string', text: condition.effort }],
          identity: { provider: { present: true, text: condition.identity.provider }, id: { present: true, text: condition.identity.id }, surface: { present: true, text: condition.identity.surface }, version: { present: false, text: '' }, fingerprint: { present: false, text: '' } } }
        row.adapter.command = condition.adapter.command; row.adapter.args = [...condition.adapter.args]; row.adapter.env = { present: true, names: [...condition.adapter.env] }
        added++
      }
      const setup = compileConditionFields(context, fieldsDraft), next = applyWorkflowSetup(prior.spec, setup)
      const digests = await Promise.all(Object.entries(generated.files).map(async ([path, contents]) => [path, contents, await sha256(contents)]))
      assertCurrent(ticket); backup = prior; field('undo').hidden = false
      for (const [path, contents, digest] of digests) {
        attachments = { ...attachments, [path]: contents }
        const existing = next.inputs.find(input => input.path === path)
        next.inputs = [...next.inputs.filter(input => input.path !== path), { ...existing, path, sha256: digest }]
      }
      spec = next
      for (const group of ['conditionFields', 'workflow', 'protocol', 'observations']) pending.delete(group)
      field('condition-fields').value = ''; changed(); renderProtocol()
      field('condition-fields').value = json(createConditionFieldsDraft(conditionContext())); renderConditionFields()
      status(`Pipeline generated: ${added} new condition${added === 1 ? '' : 's'} (${generated.conditions.length - added} already present) and ${digests.length} harness files attached. Run node harness/canary.mjs on the run computer before the draws; freeze to inspect readiness.`)
    }
    else if (has('apply-condition-fields')) {
      guard(); requireApplied(Object.keys(EDITOR_GROUPS).filter(group => !['conditionFields', 'workflow', 'protocol', 'observations'].includes(group)))
      const prior = capture(); applyIdentity(prior.spec)
      const setup = compileConditionFields(conditionContext(), conditionDraft()), next = applyWorkflowSetup(prior.spec, setup)
      assertCurrent(ticket); backup = prior; field('undo').hidden = false; spec = next
      for (const group of ['conditionFields', 'workflow', 'protocol', 'observations']) pending.delete(group)
      field('condition-fields').value = ''; changed(); renderProtocol()
      field('condition-fields').value = json(createConditionFieldsDraft(conditionContext())); renderConditionFields()
      status('Condition setup applied with its workflow assignments and accounting. Freeze to inspect requirements; Undo restores the preceding draft and raw fields.')
    }
    else if (has('seed-observations')) {
      requireApplied(['observations', 'specification', 'protocol'])
      invariant(!spec.observationPlan, 'An accounting plan is already applied. Edit it below.')
      field('observation-plan').value = json(observationPlanFromSpec()); pending.add('observations'); changed()
      status('Accounting draft created. Check the mappings and policy, then apply it before freezing.')
    }
    else if (has('apply-observations')) {
      requireApplied(['specification', 'protocol'])
      const plan = parse(field('observation-plan').value, 'Accounting plan'), next = structuredClone(spec)
      if (plan === null) delete next.observationPlan; else next.observationPlan = plan
      validateStudy(next); spec = next; pending.delete('observations'); changed(); renderProtocol()
      status(plan === null ? 'Accounting removed from this draft.' : 'Accounting plan applied. Freeze it with the study before collection.')
    }
    else if (has('apply-requirements')) {
      requireApplied(['task', 'input', 'bundle', 'specification', 'protocol', 'information'])
      const plan = parse(field('requirement-plan').value, 'Requirement plan'), next = structuredClone(spec)
      if (plan === null) delete next.requirementPlan; else { validateRequirementPlan(plan); next.requirementPlan = plan }
      await prepareStudyReview(next); assertCurrent(ticket)
      spec = next; pending.delete('requirements'); changed(); renderProtocol()
      status(plan === null ? 'Requirement plan removed from this draft.' : 'Requirement plan applied with exact bindings. Freeze and export it before independent qualification.')
    }
    else if (has('prepare-requirements')) {
      guard(); requireApplied(Object.keys(EDITOR_GROUPS))
      const code = await sources(); assertCurrent(ticket)
      let bound = await bindRuntimeSources(spec, code)
      if (bound.domain === 'lean-bench') bound = await bindLeanReview(bound, code)
      const prepared = await prepareStudyReview(bound); assertCurrent(ticket)
      invariant(prepared.requirements, 'Apply a requirement plan first.')
      spec = bound; changed(); renderBundle(); preview()
      field('requirement-registry').textContent = json(prepared.requirements)
      status(`${prepared.requirements.targets.length} targets bound; ${prepared.requirements.unregistered.length} requirement occurrences remain unregistered. This preview does not execute qualification.`)
    }
    else if (has('apply-analysis')) {
      requireApplied(['task', 'specification'])
      const population = field('analysis-population').value
      invariant(spec.auditPlan || ['all', 'held-out', 'development', 'task-set'].includes(population), 'Choose a supported primary population.')
      const primaryPopulation = spec.auditPlan ? 'reference-eligible' : population === 'all' ? 'all' : population === 'task-set'
        ? { kind: 'task-set', taskIds: field('analysis-task-ids').value.split(/[,\n\r]/).map(id => id.trim()).filter(Boolean) }
        : { kind: 'split', split: population }
      const plan = { version: 1, cohort: field('analysis-cohort').value, primaryDenominator: field('analysis-denominator').value, primaryPopulation, rationale: field('analysis-rationale').value,
        uncertainty: parse(field('analysis-uncertainty').value, 'Uncertainty procedure'), contrasts: parse(field('analysis-contrasts').value, 'Contrasts'), multiplicity: field('analysis-multiplicity').value }
      // Typed endpoints come from their labeled fields; an empty roster omits the
      // field so older projects keep their exact plan. Refusals keep the rows.
      const endpoints = endpointsFromRows(field('endpoint-fields').value ? parse(field('endpoint-fields').value, 'Endpoint fields') : [])
      if (endpoints.length) plan.endpoints = endpoints
      const next = { ...spec, analysisPlan: plan }; validateAnalysisPlan(next); spec = next; pending.delete('analysis'); changed(); renderProtocol()
      status('Analysis plan applied' + (endpoints.length ? ' with ' + endpoints.length + ' typed endpoint' + (endpoints.length === 1 ? '' : 's') : '') + '. Freeze it with the study before collection.')
    }
    else if (has('apply-design') || has('apply-design-json')) {
      requireApplied(['task', 'input', 'protocol', 'specification'])
      // Labeled fields are the ordinary path; the JSON editor is the advanced one. A refusal keeps every field row.
      const design = has('apply-design') ? designPlanFromRows(field('design-fields').value ? parse(field('design-fields').value, 'Design fields') : null) : parse(field('design-plan').value, 'Design plan')
      const next = { ...spec }; if (design === null) delete next.designPlan; else next.designPlan = design
      validateDesignPlan(next); spec = next; pending.delete('design'); field('design-fields').value = ''; changed(); renderProtocol()
      status(design === null ? 'Design plan removed. The schedule is the plain crossed task, condition and replicate design.' : 'Design plan applied. Arms, draws and phases will annotate the frozen schedule; freeze the study to inspect design/plan.json.')
    }
    else if (has('apply-spec')) { requireApplied(Object.keys(EDITOR_GROUPS).filter(group => group !== 'specification')); const next = parse(field('spec-json').value, 'Specification'); validateDraft(next, attachments); validateStudy(next); replace(next, attachments); status('Full specification applied.') }
    else if (has('attach')) {
      requireApplied(['protocol', 'specification'])
      const path = field('attachment-path').value.trim(), contents = field('attachment-text').value
      invariant(safePath(path), 'Use a relative project file path.')
      const digest = await sha256(contents); assertCurrent(ticket)
      attachments = { ...attachments, [path]: contents }
      const prior = spec.inputs.find(input => input.path === path)
      spec.inputs = [...spec.inputs.filter(input => input.path !== path), { ...prior, path, sha256: digest }]
      pending.delete('attachment'); changed(); renderProtocol(); status(`Attached ${path}; its SHA-256 digest is recorded in the input manifest.`)
    }
    else if (button.dataset.removeAttachment) { requireApplied(['protocol', 'specification']); const path = button.dataset.removeAttachment; delete attachments[path]; spec.inputs = spec.inputs.filter(input => input.path !== path); changed(); renderProtocol() }
    else if (has('generate')) {
      requireApplied(Object.keys(EDITOR_GROUPS))
      const choices = Object.fromEntries(combinationRoles().map(role => [role, [...root.querySelectorAll(`[data-combination-role="${role}"]`)].filter(input => input.checked).map(input => input.value)]))
      const next = structuredClone(spec); next.tasks = (operationalStudy(spec) ? generateOperationalTasks : generateLeanTasks)(choices, { wrapper: field('combination-wrapper').value || null, input: spec.tasks[taskIndex].input })
      for (const task of next.tasks) task.expected = await deriveTaskExpected(next, task)
      assertCurrent(ticket)
      next.conditions = resetRecordedResponses(next.conditions)
      replace(next, attachments); status(`${next.tasks.length} task combinations generated with draft expected traces. Independently qualify them and supply responses before a study.`)
    } else if (has('prepare-requirement-fields') || has('reset-requirement-fields')) {
      requireApplied(Object.keys(EDITOR_GROUPS).filter(group => group !== 'requirementFields'))
      invariant(!spec.experimentTemplate, 'Resource controls are generated from the experiment recipe. Edit its cases and resource fields instead.')
      let bound = await bindRuntimeSources(spec, await sources())
      if (bound.domain === 'lean-bench') bound = await bindLeanReview(bound, await sources())
      const inventory = await requirementFieldInventory(bound); assertCurrent(ticket)
      let draft = requirementDraft()
      if (has('reset-requirement-fields') || !draft) {
        backup = snapshot(); field('undo').hidden = false
        draft = createRequirementFieldDraft(inventory)
      }
      spec = bound; requirementInventory = inventory
      field('requirement-fields').value = json(draft); pending.add('requirementFields'); changed(); renderProtocol()
      requirementEditor.setContext(inventory, draft)
      field('requirement-fields-status').textContent = `${inventory.rows.length} exact task/reading requirements enumerated. Supply independent assertions, activation and wrong-reading controls. Existing field text is preserved; stale bindings require an explicit fresh design.`
      status('Requirement controls prepared. No interpreter execution or personal approval is inferred.')
    } else if (has('apply-requirement-fields')) {
      requireApplied(Object.keys(EDITOR_GROUPS).filter(group => group !== 'requirementFields'))
      invariant(requirementDraft(), 'Prepare the actual requirement roster first.')
      const bound = await bindRuntimeSources(spec, await sources()), generated = await compileRequirementFields(bound, requirementDraft())
      assertCurrent(ticket)
      const next = { ...bound, requirementPlan: generated.plan }; validateStudy(next)
      await prepareStudyReview(next); assertCurrent(ticket)
      spec = next; requirementInventory = generated.inventory; pending.delete('requirementFields'); changed(); renderProtocol()
      field('requirement-registry').textContent = json(generated.registry)
      field('requirement-fields-status').textContent = `${generated.plan.targets.length} exact controls generated with required complete-composition qualification. Export and execute its independent controls before collection.`
      status('Qualification plan generated from the fields. The generated plan requires fresh executed evidence before collection.')
    } else if (has('apply-execution')) {
      requireApplied(Object.keys(EDITOR_GROUPS).filter(group => group !== 'execution'))
      const next = newExperimentDraft(spec, { purpose: field('execution-purpose').value })
      if (next.executionPlan.design) next.executionPlan.design.dependence = field('execution-dependence').value
      if (next.executionPlan.purpose === 'apparatus-development') {
        invariant(next.analysisPlan?.cohort === 'qualification', 'Apparatus development requires the qualification cohort. Apply that analysis choice before changing purpose; results remain unqualified development evidence.')
      }
      validateStudy(next); replace(next, attachments)
      status('Version 2 execution design applied. Freeze to inspect generated requirements. Undo replacement restores the preceding draft.')
    } else if (has('apply-native-preparation')) {
      guard(); requireApplied(Object.keys(EDITOR_GROUPS).filter(group => group !== 'nativePreparation'))
      const plan = nativePreparationFromFields(), next = structuredClone(spec)
      if (plan) next.nativePreparationPlan = plan; else delete next.nativePreparationPlan
      validateNativePreparationPlan(next)
      const prepared = await prepareStudyReview(next); assertCurrent(ticket)
      const prior = capture()
      spec = next; pending.delete('nativePreparation'); backup = prior; field('undo').hidden = false; changed(); renderProtocol()
      renderNativePreparationPlan(prepared.nativePreparation)
      status(plan ? 'Native control plan applied. Its generated roster has not run; freeze before exporting a selected control. Undo restores the preceding draft and fields.' : 'Native control plan removed. Undo restores the preceding draft and fields.')
    } else if (has('prepare-native-preparation')) {
      guard(); requireApplied(Object.keys(EDITOR_GROUPS)); invariant(spec.nativePreparationPlan, 'Apply a native control plan first.')
      const code = await sources(); assertCurrent(ticket)
      let bound = await bindRuntimeSources(spec, code)
      if (bound.domain === 'lean-bench') bound = await bindLeanReview(bound, code)
      const prepared = await prepareStudyReview(bound); assertCurrent(ticket)
      renderNativePreparationPlan(prepared.nativePreparation, 'Draft preview with current sources')
      status('Native control roster previewed. Freeze the applied draft before exporting a selected job; no control execution or approval was performed.')
    } else if (has('export-native-control')) {
      guard(); requireApplied(Object.keys(EDITOR_GROUPS)); invariant(frozen?.nativePreparation, 'Freeze a native preparation plan first.')
      const currentProject = frozen, jobId = field('native-control-job').value, attached = structuredClone(attachments), code = await sources()
      assertCurrent(ticket)
      invariant(currentProject.nativePreparation.jobs.some(job => job.id === jobId), 'Select one frozen native control job.')
      const envelope = await materializeNativeControl(currentProject, jobId, { runtimeFiles: code, inputFiles: attached }); assertCurrent(ticket)
      const binding = canonical(envelope.binding) + '\n'
      invariant(!Object.hasOwn(attached, 'native-control/binding.json') || attached['native-control/binding.json'] === binding, 'The retained input conflicts with the generated native control binding.')
      const files = await projectFiles(envelope.controlProject, code, { ...attached, 'native-control/binding.json': binding }); assertCurrent(ticket)
      invariant(frozen === currentProject, 'The frozen project changed while exporting the native control.')
      download(`${currentProject.spec.id}-${jobId}.zip`, zipFiles(files), 'application/zip')
      field('native-control-status').textContent = `Exported ${jobId}; control project SHA-256 ${envelope.controlProjectSha256}. Generated control only; it has not been executed or qualified. Separate ZIPs do not enforce the aggregate preparation budget.`
      status('Native control project exported with generated code and its pinned parent binding. Native preparation and experimental admission remain pending.')
    } else if (has('freeze')) { await freeze(ticket) }
    else if (has('export')) {
      guard(); invariant(frozen, 'Freeze the current draft first.')
      const currentProject = frozen, attached = structuredClone(attachments), code = await sources()
      assertCurrent(ticket)
      const files = await projectFiles(currentProject, code, attached)
      assertCurrent(ticket)
      download(`${currentProject.spec.id}.zip`, zipFiles(files), 'application/zip'); status('Runnable project exported with source, prompts, schedule, inputs and SHA-256 manifest.' + exportReadinessNote(currentProject))
    } else if (has('run')) {
      guard(); invariant(frozen && ['exact', 'json', 'judge-audit', 'resource-action-plan'].includes(frozen.spec.protocol.grading.kind) && frozen.spec.conditions.every(condition => condition.adapter.kind === 'replay'), 'This page runs recorded responses with supported portable grading, including generated resource plans. Use the exported CLI for external systems, custom graders or LEAN Python.')
      const currentProject = frozen, controller = new AbortController()
      assertCollectionAdmission(currentProject, { operation: executionOperation(currentProject), canonicalReplay: true })
      running = controller; syncControls()
      const touched = new Set(); field('run-live').textContent = `Running ${currentProject.schedule.length} scheduled trials in this page…`
      try {
        const result = await runStudy(currentProject, { signal: controller.signal, runtime: pageRuntime(), events: evidence?.projectSha256 === currentProject.sha256 ? evidence.events : [], onEvent: event => { if (current(ticket)) { touched.add(event.trialId); field('run-live').textContent = `${touched.size} of ${currentProject.schedule.length} trials started · last: ${event.trialId} ${event.type}` } if (current(ticket)) status(`${event.trialId}: ${event.type === 'started' ? 'running' : event.type === 'workflow-started' ? 'stage ' + event.stageId + ' running' : event.status}`) } })
        assertCurrent(ticket)
        nativeVerification = null; renderNativeVerification()
        evidence = { projectSha256: currentProject.sha256, ...result }; await renderEvidence(); status(result.preparationFailure ? 'Template preparation stopped: ' + result.preparationFailure : controller.signal.aborted ? 'Run cancelled. Completed and interrupted attempts are retained in its evidence.' : 'Recorded-response run finished. Export its raw evidence to keep it.')
      } finally { if (running === controller) { running = null; syncControls(); field('run-live').textContent = controller.signal.aborted ? 'Run cancelled. Completed trials are in the evidence below.' : 'Run finished. Evidence below.' } }
    } else if (has('cancel')) running?.abort(new Error('Cancelled from the Research page.'))
    else if (has('watch-runs')) onWatchRuns()
    else if (has('export-native-verification')) { guard(); invariant(nativeVerification && evidence && frozen && nativeVerification.projectSha256 === frozen.sha256, 'Verify the current native evidence before exporting its receipt.'); download(`${spec.id}-native-verification.json`, canonical(nativeVerification) + '\n'); status(`Verification receipt exported as ${spec.id}-native-verification.json.`) }
    else if (has('export-evidence')) { guard(); invariant(evidence, 'No evidence is loaded.'); download(`${spec.id}-evidence.json`, json(evidence)); status(`Evidence exported as ${spec.id}-evidence.json.`) }
    else if (has('export-csv')) { guard(); invariant(evidence, 'No evidence is loaded.'); download(`${spec.id}-results.csv`, summaryCsv(evidence.summary), 'text/csv'); status(`Results CSV exported as ${spec.id}-results.csv.`) }
    else if (has('export-report')) { guard(); invariant(frozen && evidence, 'Freeze a project and load its evidence first.'); const name = frozen.spec.id, currentProject = frozen, options = await reportOptions(currentProject); assertCurrent(ticket); const files = await researchReportFiles(currentProject, evidence.events, options); assertCurrent(ticket); download(`${name}-report.zip`, zipFiles(files), 'application/zip'); status(readOnlyArchive() ? 'Research report exported from the opened archive: this build rendered it from the archive-verified project and its retained attempt journal without a rebuild, and the report says so.' : 'Research report exported from the frozen project and retained attempt journal.') }
    else if (has('submit')) {
      guard(); invariant(frozen && submitExported, 'Freeze a project and connect the research run service first.')
      const currentProject = frozen, attached = structuredClone(attachments), directory = field('directory').value.trim(), command = field('node').value.trim(), code = await sources()
      assertCurrent(ticket)
      const files = await projectFiles(currentProject, code, attached)
      assertCurrent(ticket)
      await submitExported({ project: currentProject, directory, command, files })
      assertCurrent(ticket)
      status('Exported project submitted. Inspect its process and collected summary on the run board.')
    }
  }
  root.addEventListener('click', event => {
    if (field('prompt-set-editor').contains(event.target)) return
    const wrap = event.target.closest('[data-node-wrap]')
    if (wrap) {
      if (loading || operation || disposed) return
      try {
        requireApplied(['task'])
        const path = wrap.dataset.nodeWrap, selected = [...root.querySelectorAll('[data-node-wrapper]')].find(input => input.dataset.nodeWrapper === path).value
        const bundle = spec.catalog.find(item => item.id === selected), node = refFor(bundle)
        const slot = Object.entries(bundle.slots).find(([, role]) => role === 'node')[0]
        node.slots[slot] = nodeAt(path); setNode(path, node); changed(); renderTask()
      } catch (error) { status(error.message) }
    } else {
      const button = event.target.closest('button')
      if (!button || button.closest('.bench-steps')) return
      if (button.hasAttribute('data-bench-cancel')) { running?.abort(new Error('Cancelled from the Research page.')); return }
      operate(ticket => perform(event, ticket))
    }
  })
  root.addEventListener('input', event => {
    if (loading || operation || disposed || !['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName) || event.target.type === 'file') return
    if (field('condition-fields-editor').contains(event.target) || field('information-fields-editor').contains(event.target) || field('routing-editor').contains(event.target) || field('prompt-set-editor').contains(event.target)) return
    // These controls only publish through the checked bundle-change action.
    // In particular, a refused selection must not invalidate a frozen study.
    if (event.target.hasAttribute('data-node-use') || event.target.hasAttribute('data-node-replacement-mode')) return
    if (['snippet-search', 'snippet-label-filter', 'import-snippets'].some(name => event.target.hasAttribute(`data-bench-${name}`))) return
    if (event.target.hasAttribute('data-bench-task') || event.target.hasAttribute('data-bench-audit-case') || event.target.hasAttribute('data-bench-audit-file') || event.target.hasAttribute('data-bench-bundle') || event.target.hasAttribute('data-bench-starter') || event.target.hasAttribute('data-bench-source-file') || event.target.hasAttribute('data-bench-native-control-job') || event.target.hasAttribute('data-node-wrapper') || event.target.hasAttribute('data-combination-role')) return
    if (event.target.hasAttribute('data-bench-reviewer') || event.target.hasAttribute('data-bench-audit-reviewer') || event.target.hasAttribute('data-bench-information-reviewer') || event.target.hasAttribute('data-bench-directory') || event.target.hasAttribute('data-bench-node')) return
    const key = EDITORS.find(name => field(name) === event.target)
    for (const [group, names] of Object.entries(EDITOR_GROUPS)) if (names.includes(key)) pending.add(group)
    if (event.target.hasAttribute('data-bench-name')) { spec.name = event.target.value; onDraftIdentity({ id: spec.id, name: spec.name }) }
    if (event.target.hasAttribute('data-bench-id')) spec.id = event.target.value
    if (event.target.hasAttribute('data-bench-study-version')) {
      const version = studyVersionFromField()
      if (version === undefined) delete spec.version
      else spec.version = version
      renderStudyVersion()
    }
    changed()
    if (['conditions', 'workflow-config', 'observation-plan', 'seed', 'replicates', 'attempts', 'total', 'timeout', 'duration', 'grading', 'require-review', 'inputs', 'environment', 'decisions', 'name', 'id'].includes(key)) renderConditionFields()
  })
  const onChange = event => {
    if (field('prompt-set-editor').contains(event.target)) return
    if (loading || operation || disposed) return
    // A textarea's blur fires change while focus is moving to the next field.
    // Disabling that destination here can send its typing back into the old
    // field. Only actual async I/O locks controls; local edits keep focus.
    const local = ['data-node-use', 'data-node-param', 'data-bench-task', 'data-bench-audit-case', 'data-bench-audit-file', 'data-bench-bundle', 'data-bench-split', 'data-bench-native-control-job'].some(name => event.target.hasAttribute(name))
    const external = ['data-bench-source-file', 'data-bench-import', 'data-bench-import-snippets', 'data-bench-import-reference', 'data-bench-import-evidence', 'data-bench-import-native-evidence', 'data-bench-open-exported'].some(name => event.target.hasAttribute(name))
    if (!local && !external) return
    operate(async ticket => {
      const input = event.target
      if (input.hasAttribute('data-node-use')) {
        const path = input.dataset.nodeUse, node = nodeAt(path) || { use: '' }, selected = input.value
        try {
          requireApplied(['task'])
          const mode = [...root.querySelectorAll('[data-node-replacement-mode]')].find(control => control.dataset.nodeReplacementMode === path)?.value || 'preserve'
          const next = replaceNodeBundle(spec.catalog, node, selected, { role: roleFromAttribute(input.dataset.nodeRole), mode })
          if (canonical(next) === canonical(node)) return
          const prior = capture()
          assertCurrent(ticket); setNode(path, next)
          backup = prior; field('undo').hidden = false; changed(); renderTask()
          status(mode === 'replace' ? 'Branch replaced with the selected bundle defaults. Inspect its children and derive or declare the new expected result. Undo restores the preceding draft.'
            : 'Bundle changed; compatible child connections retained. Fill any new child slots and derive or declare the new expected result. Undo restores the preceding draft.')
        } catch (error) { input.value = node?.use || ''; throw error }
      }
      else if (input.hasAttribute('data-node-param')) { const ref = nodeAt(input.dataset.nodePath); if (pending.has('task')) { input.value = ref.params?.[input.dataset.nodeParam] ?? spec.catalog.find(bundle => bundle.id === ref.use)?.parameters?.[input.dataset.nodeParam] ?? ''; requireApplied(['task']) } ref.params ||= {}; ref.params[input.dataset.nodeParam] = input.dataset.nodeType === 'number' ? Number(input.value) : input.dataset.nodeType === 'boolean' ? input.value === 'true' : input.value; changed(); field('task-json').value = json(spec.tasks[taskIndex]); preview() }
      else if (input.hasAttribute('data-bench-task') || input.hasAttribute('data-bench-audit-case')) { if (pending.has('input') || pending.has('task') || pending.has('information')) { input.value = String(taskIndex); throw new Error('Apply the current task edits before selecting another task. Your text is preserved.') } taskIndex = Number(input.value); renderTask() }
      else if (input.hasAttribute('data-bench-audit-file')) renderAuditFile()
      else if (input.hasAttribute('data-bench-native-control-job')) syncControls()
      else if (input.hasAttribute('data-bench-bundle')) { if (pending.has('bundle')) { input.value = String(bundleIndex); throw new Error('Apply the current snippet edits before opening another snippet. Your text is preserved.') } bundleIndex = Number(input.value); renderBundle() }
      else if (input.hasAttribute('data-bench-split')) { if (pending.has('task')) { input.value = spec.tasks[taskIndex].split; requireApplied(['task']) } spec.tasks[taskIndex].split = input.value; changed(); field('task-json').value = json(spec.tasks[taskIndex]) }
      else if (input.hasAttribute('data-bench-source-file')) { const selected = input.value, code = await sources(); assertCurrent(ticket); field('source-code').textContent = code[selected] }
      else if (input.hasAttribute('data-bench-import-snippets')) {
        requireApplied(['bundle']); const file = input.files?.[0]; if (!file) return
        invariant(file.size <= 8 * 1024 * 1024, 'Snippet library files are limited to 8 MiB.')
        const data = parse(await file.text(), 'Snippet library'); assertCurrent(ticket)
        const before = spec.catalog.length, merged = importSnippetLibrary(data, spec.catalog)
        spec.catalog = merged; bundleIndex = before < merged.length ? before : bundleIndex
        field('snippet-search').value = ''; field('snippet-label-filter').value = ''; input.value = ''
        changed(); renderBundle(); renderTask(); selectTab('library')
        const note = `${merged.length - before} snippets imported. Existing snippets and task connections were kept.`
        status(note); field('snippet-status').textContent = note
      }
      else if (input.hasAttribute('data-bench-import')) {
        const file = input.files?.[0]; if (!file) return
        invariant(file.size <= 128 * 1024 * 1024, 'Draft files are limited to 128 MiB.')
        const data = parse(await file.text(), 'Draft file'); assertCurrent(ticket)
        restoreDraft(data, file.name); input.value = ''
      } else if (input.hasAttribute('data-bench-import-reference')) {
        guard(); const file = input.files?.[0]; if (!file) return
        invariant(file.size <= 64 * 1024 * 1024, 'Reference files are limited to 64 MiB.')
        const reference = parse(await file.text(), 'Reference bundle'); assertCurrent(ticket)
        const next = await auditStudyFromReference(reference, { generate: false }); assertCurrent(ticket)
        replace(next); input.value = ''; selectTab('audit')
        status('Source reference verified and imported. Declare the audit plan and generate its cases; judge responses and personal reviews are still required.')
      } else if (input.hasAttribute('data-bench-import-native-evidence')) {
        guard(); requireApplied(Object.keys(EDITOR_GROUPS)); invariant(frozen, 'Freeze the matching project before verifying native evidence.')
        const currentProject = frozen, file = input.files?.[0]; if (!file) return
        invariant(file.size <= NATIVE_EVIDENCE_LIMITS.totalBytes, 'Native evidence files are limited to 64 MiB.')
        const encoded = await file.text(); assertCurrent(ticket)
        invariant(new TextEncoder().encode(encoded).byteLength <= NATIVE_EVIDENCE_LIMITS.totalBytes, 'Native evidence files are limited to 64 MiB.')
        const data = parse(encoded, 'Native evidence')
        invariant(object(data) && data.format === 'benchmark-native-evidence' && data.version === 1 && Object.keys(data).every(key => ['format', 'version', 'project', 'events', 'files'].includes(key)), 'Import a version 1 native evidence bundle from verify-native.')
        invariant(data.project?.sha256 === currentProject.sha256, 'This native evidence belongs to a different frozen project.')
        const receipt = await verifyNativeJournalEvidence({ project: data.project, events: data.events, files: data.files }); assertCurrent(ticket)
        const receiptSha256 = await sha256(canonical(receipt)); assertCurrent(ticket)
        invariant(frozen === currentProject, 'The frozen project changed while verifying native evidence.')
        const next = { projectSha256: currentProject.sha256, events: data.events, summary: analyze(currentProject, data.events), nativeVerification: receipt, nativeVerificationSha256: receiptSha256 }
        evidence = next; nativeVerification = receipt; input.value = ''; await renderEvidence(); renderNativeVerification()
        status('Native artifacts verified for consistency; summary recomputed. Native execution, preparation and experimental admission are not established. Export the separate receipt to retain these checks.')
      } else if (input.hasAttribute('data-bench-open-exported')) {
        // Opening is not freezing. The archive proves itself against its own
        // manifest, then this build tries to rebuild the frozen project. When it
        // can, the project is admitted exactly as a local freeze. When it cannot,
        // because the compiler has moved since the archive was frozen, it is
        // admitted read-only and the page names the compiled members that differ
        // rather than refusing with a sentence nobody can act on. Nothing from
        // the archive is ever executed: only its text is read.
        const file = input.files?.[0]; if (!file) return
        invariant(file.size <= ARCHIVE_LIMITS.totalBytes, `Project archives are limited to ${ARCHIVE_LIMITS.totalBytes} bytes.`)
        const bytes = new Uint8Array(await file.arrayBuffer()); assertCurrent(ticket)
        const code = await sources(); assertCurrent(ticket)
        const files = unzipFiles(bytes)
        const opened = await readExportedProject(files, { sources: code }); assertCurrent(ticket)
        frozen = opened.project; openedArchive = { ...opened, carried: carriedReportInputs(files) }; evidence = null; nativeVerification = null
        input.value = ''
        field('results').replaceChildren()
        renderFrozen(); renderNativeVerification(); onOpen('run'); selectTab('run')
        status(opened.rebuild.verified
          ? `Project opened from its archive and verified: ${opened.integrity.checked} files matched its manifest, and this build rebuilds it exactly. Import its run evidence to inspect the results here.`
          : `Project opened from its archive, read-only: ${opened.integrity.checked} files matched its manifest, but this build rebuilds it differently at ${opened.rebuild.differing.join(', ')}. Its evidence and report can be inspected; it cannot be run here.`)
      } else if (input.hasAttribute('data-bench-import-evidence')) {
        guard(); invariant(frozen, 'Freeze the matching project before importing evidence.')
        const currentProject = frozen
        const file = input.files?.[0]; if (!file) return
        invariant(file.size <= 32 * 1024 * 1024, 'Evidence files are limited to 32 MiB.')
        const data = parse(await file.text(), 'Evidence')
        assertCurrent(ticket)
        // This refusal is the last thing an owner sees when a run does not come back.
        // "different" alone leaves them nothing to check and nothing to do, so name both
        // projects and the path that does work.
        invariant(data.projectSha256 === currentProject.sha256, 'This evidence belongs to a different frozen project. It was produced for '
          + String(data.projectSha256 ?? 'an unstated project').slice(0, 16) + '\u2026, and this page holds ' + currentProject.sha256.slice(0, 16) + '\u2026.'
          + ' Open that project\u2019s exported ZIP with Open exported project: the <identifier>.zip that Export runnable ZIP downloaded. This page will then hold it and admit this evidence.'
          + ' Freezing the same draft here reproduces that project only while this page\u2019s runtime bytes are unchanged; otherwise run the exported'
          + ' project\u2019s cli.mjs and import the evidence it writes for the project this page holds.')
        await verifyQualificationJournal(currentProject, data.events); assertCurrent(ticket)
        await verifyResourceJournal(currentProject, data.events); assertCurrent(ticket)
        validateJournal(currentProject, data.events, { openedArchive: readOnlyArchive() })
        const imported = await importedReceipts(currentProject, data); assertCurrent(ticket)
        const next = { projectSha256: currentProject.sha256, events: data.events, summary: analyze(currentProject, data.events), ...imported.receipts }
        evidence = next; nativeVerification = null; renderNativeVerification(); await renderEvidence(); status('Evidence imported; summary recomputed from the bound attempt journal.' + imported.notes)
      }
    }, { lockControls: external })
  }
  root.addEventListener('change', onChange)
  projectEl.addEventListener('change', onChange)
  async function setContext(nextProject, nextSource, { reload = false } = {}) {
    if (disposed) return
    if (!reload && project === nextProject && source === nextSource) return
    running?.abort(new Error('Research project or account changed.'))
    remember(); const ticket = ++epoch
    running = null; operation = null; loading = true
    // Lock the controls in the same turn the context change was asked for.
    // The draft below is now awaited, so without this the fields stay live
    // and editable across the wait and are then replaced underneath whoever
    // was typing -- which is exactly what the lock exists to prevent.
    syncControls()
    if (reload) drafts.clear()
    const starting = emptyDraft()
    if (!current(ticket)) return
    draftOrigin = 'Empty draft. Create snippets or explicitly import a library or experiment.'
    resetEditors()
    project = nextProject; source = nextSource; spec = starting; attachments = {}; frozen = null; openedArchive = null; evidence = null; nativeVerification = null; backup = null; dirty = false; taskIndex = 0; bundleIndex = 0; pending.clear(); branches.clear(); renderedTask = null
    field('snippet-search').value = ''; field('snippet-label-filter').value = ''
    field('snippet-status').textContent = 'Apply edits to use them in this benchmark. Export snippets to keep a portable copy.'
    requirementInventory = null; field('requirement-fields').value = ''; requirementEditor.setContext(null, null)
    informationInventory = null; informationInventoryContext = null; field('information-fields').value = ''; informationEditor.setContext(null, null)
    compositionInventory = null; field('composition-fields').value = ''; compositionEditor.setContext(null, null)
    field('condition-fields').value = ''; conditionEditor.setContext({ context: null, draft: null, contextKey: `${source}:${project}:${epoch}` })
    familyInventory = null; familySelected = ''; familyReadOnly = false; field('composition-family-fields').value = ''; field('family-source-status').textContent = ''
    field('composition-fields-status').textContent = ''; field('composition-obligations').replaceChildren()
    field('undo').hidden = true
    for (const name of ['reviewer', 'information-reviewer', 'audit-reviewer', 'directory', 'attachment-path', 'attachment-text', 'import', 'import-reference', 'import-evidence', 'import-native-evidence']) field(name).value = ''
    field('source-code').textContent = ''
    render(); changed(); dirty = false
    field('scope').textContent = nextSource === 'mock' ? 'Local preview. Create or import a draft here. Account saves and benchmark runs require a connected workspace.' : nextProject === 'all' ? 'Choose a project or Unfiled to edit its benchmark. All projects is an overview.' : `${nextProject === 'unfiled' ? 'Unfiled benchmark' : 'Selected project'} · This draft belongs only to this project. Import a file to reuse another project’s work.`
    const cached = drafts.get(`${source}:${project}`)
    status('Reading this project’s draft…')
    try {
      const saved = cached || (source === 'mock' || project === 'all' ? null : await storeFor(ticket).read(project))
      assertCurrent(ticket)
      if (saved) { validateDraft(saved.spec, saved.attachments || {}); draftOrigin = cached?.origin || 'Saved draft from the selected account project.'; spec = saved.spec; attachments = saved.attachments || {}; taskIndex = saved.taskIndex || 0; bundleIndex = saved.bundleIndex || 0; render(); for (const group of saved.pending || []) if (Object.hasOwn(EDITOR_GROUPS, group)) pending.add(group); applyEditors(saved.editors); dirty = saved.dirty || false }
      if (saved) onBenchmarkLoaded(spec)
      if (cached) { frozen = cached.frozen; openedArchive = cached.openedArchive || null; evidence = cached.evidence; backup = cached.backup; field('undo').hidden = !backup; renderFrozen(); if (evidence) await renderEvidence() }
      status(saved ? 'Project draft restored.' : 'This project starts empty. Create snippets, import a file, or explicitly choose a starter.')
    } catch (error) { if (current(ticket)) status(error.message) }
    finally { if (current(ticket)) { loading = false; renderInformationFields(); syncControls() } }
  }
  render()
  return { el: root, resourceEl, projectEl, setContext, openDraft, destroy() { if (disposed) return; remember(); disposed = true; epoch++; previewEpoch++; running?.abort(new Error('Research page closed.')); running = null; syncControls(); informationEditor.destroy(); requirementEditor.destroy(); compositionEditor.destroy(); conditionEditor.destroy(); routingEditor.destroy(); compositionGenerator.destroy(); nestingEditor.destroy(); varianceEditor.destroy(); promptSetEditor.destroy(); familyEditor.destroy(); familyOccurrenceEditor.destroy() },
    get dirty() { return dirty } }
}
