// One deterministic report generator for Research and the standalone CLI.
import { canonical, invariant, sha256 } from './prompts.mjs'
import { modernSchema } from './study-schema.mjs'
import { analysisArtifact, summaryCsv, tableCsv } from './analysis.mjs'
import { validateJournal, verifyResourceJournal } from './runner.mjs'
import { requirementReportFiles, verifyQualificationJournal } from './requirements.mjs'
import { TEMPLATE, methodReference, referenceText, templateCitation, verifyProject } from './study.mjs'
import { collectionRequest } from './workflow.mjs'
import { metricAggregate, priceTableIdentity } from './observations.mjs'

const html = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
const md = value => String(value ?? '').replace(/[\\`*_{}\[\]()#+.!|<>]/g, '\\$&').replace(/[\r\n]+/g, ' ')
const percent = value => value === null ? 'Not measured' : `${(value * 100).toFixed(1)}%`
const number = value => value === null ? 'Not measured' : Number(value.toFixed(4)).toString()
// Render-time notes on a bootstrap interval, computed from the interval record and
// the size of its multiplicity family so summary.json is unchanged: the per-interval
// level after the multiplicity rule, where each endpoint sits among the sorted draws,
// the clusters resampled, and whether the interval is degenerate.
const DEGENERATE_NOTE = 'Degenerate: every resample gave the same value, so this interval carries no information about uncertainty and is not a confidence interval.'
// Cameron, Gelbach and Miller (2008): cluster-robust inference is unreliable with few clusters.
// A whole-cluster resample over G clusters draws from G raised to the G equally likely sequences,
// which form only C(2G-1, G) distinct multisets: 2 clusters give 3, 3 give 10, 4 give 35, 5 give 126.
// Below this many the percentile endpoints are fixed by that discreteness rather than by coverage,
// so the span is reported as a range and is not called a confidence interval at any level.
const COVERAGE_MINIMUM_CLUSTERS = 5
const RANGE_LABEL = 'resampling range (too few clusters for coverage)'
const rangeNote = clusters => 'That span is a ' + RANGE_LABEL + ': ' + counted(clusters, 'cluster') + ' resampled, fewer than the '
  + COVERAGE_MINIMUM_CLUSTERS + ' this report requires before a percentile span is read at its nominal level.'
function intervalNote(row, family) {
  const interval = row.interval
  if (!interval) return ''
  const alpha = (1 - interval.confidence) / (interval.multiplicity === 'bonferroni' ? Math.max(1, family) : 1)
  const position = (interval.resamples - 1) * (alpha / 2), clusters = row.families ?? row.clusters
  const level = interval.multiplicity === 'bonferroni'
    ? 'per-interval level ' + number(1 - alpha) + ' (Bonferroni over ' + family + ' planned interval' + (family === 1 ? '' : 's') + ')'
    : 'level ' + number(interval.confidence)
  // Below the coverage minimum the span is named a range rather than an interval, and its level is
  // stated as nominal rather than dropped, so the reader still sees what the multiplicity rule applied.
  const head = clusters < COVERAGE_MINIMUM_CLUSTERS
    ? 'Resampling range (too few clusters for coverage): ' + counted(clusters, 'cluster') + ' resampled, fewer than '
      + COVERAGE_MINIMUM_CLUSTERS + ', so the nominal ' + level + ' is not attained'
    : level.charAt(0).toUpperCase() + level.slice(1) + '; ' + counted(clusters, 'cluster') + ' resampled'
  const notes = [head + '; endpoints read at position ' + number(position) + ' from each end of ' + interval.resamples + ' sorted draws.']
  if (interval.low === interval.high) notes.push(DEGENERATE_NOTE)
  else if (position < 10) notes.push('Fewer than ten draws lie beyond each endpoint, so the endpoints rest on the most extreme resamples; read with caution.')
  return notes.join(' ')
}
const counted = (value, singular) => value + ' ' + singular + (value === 1 ? '' : 's')
// A printed proportion carries its interval wherever the frozen plan declared a level: the
// Wilson (1927) score interval, recommended over Wald by Brown, Cai and DasGupta (2001). It is
// an interval for one proportion under independent trials, so where the design has clusters or
// replicates it understates the spread; the methods text says so beside it.
const rateWithInterval = (rate, interval) => percent(rate) + (interval
  ? ' (' + percent(interval.confidence) + ' Wilson ' + percent(interval.low) + ' to ' + percent(interval.high) + ')' : '')
const table = (headers, rows, label) => '<div class="table-wrap" tabindex="0" role="region" aria-label="' + html(label.replaceAll('-', ' ') + ' table') + '"><table><thead><tr>' + headers.map(header => '<th scope="col">' + html(header) + '</th>').join('') + '</tr></thead><tbody>' + rows.map(row => '<tr>' + row.map((value, index) => index ? '<td>' + html(value) + '</td>' : '<th scope="row">' + html(value) + '</th>').join('') + '</tr>').join('') + '</tbody></table></div>'
const markdownTable = (headers, rows) => [headers, headers.map(() => '---'), ...rows].map(row => '| ' + row.map(md).join(' | ') + ' |').join('\n')

// Venue-format prose: front matter, abstract, design, the composition layers
// beside their compiled prompt, the collection envelope, protocol, run
// walkthrough, per-trial evidence, integrity and the reproducibility
// checklist. These live here rather than in their own runtime file because a
// new entry in RUNTIME_FILES changes project.runtimeFiles, and with it every
// frozen version-2 project identity.
const PREVIEW_LIMIT = 4000
const SOURCE_MAP_PREVIEW_ROWS = 60
const NOT_DECLARED = 'Not declared'
// A classification is a short token. A reader of this report must not have to guess whether a
// failed attempt sent the wrong shape, sent nothing runnable, or ran and crashed, so each grader
// class carries its meaning beside it. An unlisted class is printed without a meaning rather than
// guessed at.
export const CLASSIFICATION_MEANINGS = Object.freeze({
  'correct': 'The observed result matched the expected result.',
  'incorrect': 'The observed result did not match the expected result.',
  'trace-mismatch': 'The program ran and the engine returned a result that did not match the expected one.',
  'format-violation': 'The reply carried a program in the wrong shape: prose around it, or more than one code block. It was refused before the engine, so nothing ran and no program was tested.',
  'no-program': 'The reply carried no program to run. It was refused before the engine, so nothing ran.',
  'execution-error': 'The engine exited with an error. The program may have failed part-way, or the interpreter may have rejected it before running a line.',
  'execution-timeout': 'The program ran in the engine and was stopped at the time limit.',
  'invalid-engine-result': 'The program ran and the engine produced a result this protocol could not read.',
})

// A verbatim block must survive text that itself contains backticks.
function fenceFor(text) {
  let longest = 0
  for (const match of String(text ?? '').matchAll(/`+/g)) longest = Math.max(longest, match[0].length)
  return '`'.repeat(Math.max(3, longest + 1))
}
function preview(text, limit = PREVIEW_LIMIT) {
  const value = String(text ?? '')
  return value.length <= limit ? { text: value, truncated: false, length: value.length } : { text: value.slice(0, limit), truncated: true, length: value.length }
}
// The first position at which two canonical traces differ, so a reader is not
// asked to diff two long JSON arrays by eye.
function firstDivergence(expected, observed) {
  if (!Array.isArray(expected) || !Array.isArray(observed)) return canonical(expected ?? null) === canonical(observed ?? null) ? null : { index: null, reason: 'One side is not a trace array.', expected: expected ?? null, observed: observed ?? null }
  for (let index = 0; index < Math.max(expected.length, observed.length); index++) {
    if (index >= expected.length) return { index, reason: 'The observed trace has an extra entry.', expected: null, observed: observed[index] }
    if (index >= observed.length) return { index, reason: 'The observed trace ends early.', expected: expected[index], observed: null }
    if (canonical(expected[index]) !== canonical(observed[index])) return { index, reason: 'Entries differ.', expected: expected[index], observed: observed[index] }
  }
  return null
}

const PURPOSE_BANNER = {
  'apparatus-development': 'Apparatus development. Every computation below exercises the measurement apparatus itself. It is development evidence, not a model result, and it qualifies nothing.',
  'recorded-diagnostic': 'Recorded diagnostic. Saved responses were replayed through the frozen grader. No new provider collection took place.',
  experiment: 'Experiment. Responses were collected under the frozen protocol declared below.',
  legacy: 'Legacy record. Retained evidence from an earlier apparatus generation, shown with its original execution purpose.',
}
// One plain-language sentence per table, keyed by the table id report.mjs
// assigns and printed immediately before the table. Ids completed at render
// time share the sentence of their prefix; an unknown id prints none.
const TABLE_NOTES = {
  'front-matter': 'Identity of this study and of the exact files this report was generated from.',
  'statistical-methods': 'The estimators, interval procedure, multiplicity rule and exclusion rule the frozen plan fixed, each with its primary reference.',
  'replicate-dispersion': 'The primary rate computed within each replicate index per condition, with its mean, sample standard deviation and range across replicates.',
  'citation-record': 'How to cite this frozen study and the template that generated it; the same values are written as CITATION.cff and CITATION.bib.',
  'design-declarations': 'The frozen analysis decisions: cohort, population, denominator, uncertainty and multiplicity.',
  'planned-contrasts': 'The comparisons fixed before collection; each is reported whatever its outcome.',
  'condition-collection': 'How each condition obtained its responses: provider, declared model, adapter and target, never a credential.',
  'condition-tool-policy': 'For each condition: the tools it declared, what its finished attempts reported applying, how many reported, and the basis they gave.',
  'protocol-apparatus': 'The frozen schedule, attempt limits, timeouts and grading rule every trial followed.',
  'manifest-summary': 'What the export manifest binds, and whether its runtime and input digests agree with the frozen project.',
  'qualification-receipts': 'Each qualification receipt recorded in the attempt journal before collection, with its retained report.',
  'qualification-checks': 'Each apparatus check in the pre-collection qualification receipt, with the interpreter agreement recomputed from the receipt itself.',
  'native-verification': 'What the native verification receipt claims about this run, separating what this report verified from what the receipt declares.',
  'native-apparatus': 'How native grading ran: the pinned engine image, the execution timeout and the container that ran each program.',
  'run-walkthrough': 'Every journal event in order, so one trial can be followed from start to settlement.',
  'runtime-file-digests': 'The SHA-256 of every runtime file the frozen project pins.',
  'reproduction-commands': 'The exact commands that recheck, rerun and re-derive this study from the exported project.',
  'reproducibility-checklist': 'Customary reproducibility questions, each answered only from frozen fields.',
  'attribution-generated': 'Code newly generated in this repository, with the basis the provenance registry records.',
  'execution-scope': 'What kind of evidence this run is, and whether experimental collection was admitted.',
  'reference-execution-scope': 'The evidence class of each reference source, kept attached to its original observations.',
  'custom-grade-evidence': 'Whether each custom grade carries the original grader process receipt.',
  'template-qualification': 'Each full template qualification receipt retained before collection.',
  'template-preparation': 'Every template preparation attempt, with its budget charge and outcome.',
  'resource-preparation': 'Every resource preparation intent and its terminal record, with deadlines, reservations and charges.',
  'resource-effects': 'For each trial, whether the task succeeded and which collateral resources it touched.',
  'resource-observed-prefixes': 'What was observed before a trial stopped, bounded to the observed prefix of its actions.',
  'selected-input-preparation': 'Each selected-input preparation, with its measured duration and budget charge.',
  'selected-input-gates': 'Each accepted selected-input qualification and how much of the composition it covered.',
  conditions: 'Every frozen condition: which provider and model was requested, and how the response was obtained.',
  'workflow-design': 'The frozen prompt workflows: purpose, stages, budgets and which conditions use each.',
  'workflow-stages': 'Every executed workflow stage per attempt, with its status and host time.',
  'workflow-stage-usage': 'Usage metrics reported for each workflow stage, one metric per row.',
  'workflow-stage-cost': 'Reported cost for each workflow stage, kept in its own currency.',
  tasks: 'Every frozen task with its family, split, factors and the size of its composition tree.',
  'audit-source-task-key': 'Maps the short labels of audited source tasks to their full identifiers.',
  'audit-cases': 'Every audit case with its reference verdict and the source occurrences it covers.',
  'audit-source-trials': 'Every source trial behind the audit, and whether it became an audit case.',
  'corpus-coverage-rules': 'The frozen coverage rules the corpus selection had to meet.',
  'corpus-features': 'How composition features were classified from the node bundles of each candidate.',
  'corpus-cell-exclusions': 'Each coverage cell and how many constructed assignments were excluded before selection.',
  'corpus-compositions': 'The composition size and features of each selected task.',
  'corpus-selection': 'How many constructed candidates were selected, and how many were excluded.',
  'corpus-coverage': 'For each coverage level, how many candidates were eligible and how many were selected.',
  'corpus-candidates': 'Every constructed candidate and the reason it was selected or excluded.',
  'information-contexts': 'Which information packet each task received under each condition.',
  'information-design': 'For each task, what was withheld and which readings count as admissible.',
  'primary-population': 'Which tasks entered the primary analysis, and the frozen reason for each exclusion.',
  'primary-rates': 'The headline result: how many trials met the criterion in each condition, over the frozen denominator.',
  'endpoints-intervals': 'Each typed endpoint estimate with its resampled interval.',
  'endpoints-contrasts': 'Differences between conditions on each typed endpoint.',
  'endpoints-replicates': 'Each typed endpoint estimated separately for every condition and replicate.',
  'endpoints-records': 'The value of every typed endpoint for every trial, including unavailable and invalid values.',
  'design-arms': 'Results grouped by the frozen design arms rather than by condition.',
  'design-units': 'Every draw unit of the grouped design, with its members and its outcome.',
  'design-phases': 'Each design phase, its draws, and any decision it had to wait for.',
  'design-arm-contrasts': 'Differences between design arms, with intervals where they are estimable.',
  'design-endpoint-arms': 'Each typed endpoint estimated for every design arm.',
  'design-endpoint-arm-contrasts': 'Differences between design arms on each typed endpoint.',
  rates: 'Scheduled and completed trials per condition beside the number meeting the criterion, so unmeasured trials stay visible in the denominator.',
  dispositions: 'Why each scheduled trial ended as it did, separating transport failures from graded outcomes.',
  'judge-detection': 'How often the judge agreed with reference rejections, and how often it did not.',
  'judge-confusion': 'Every reference verdict against every judge verdict, with abstentions kept distinct.',
  contrasts: 'Each planned contrast with its difference and interval; an absent interval carries its reason.',
  'observation-coverage': 'For how many attempts identity, generation and timing were observed.',
  'attempt-outcomes': 'How every attempt ended, counted per condition.',
  'collection-controls': 'The collection controls and the identity and completion policies each condition declared.',
  'returned-identities': 'The model identity each attempt reported, compared with the one requested.',
  'resource-usage': 'Reported usage metrics per condition, with known subtotals kept apart from full totals.',
  'collection-cost': 'Reported or estimated collection cost per condition, each in its own currency.',
  'estimated-cost-by-condition': 'Estimated API cost per condition at the list prices frozen into this project, never a reported charge.',
  'estimated-cost-by-model': 'Estimated API cost per billing model at the list prices frozen into this project; two conditions on one model combine here.',
  'host-attempt-time': 'Host-measured attempt time per condition, including recovered attempts.',
  'host-phases': 'Host time per phase of an attempt, inclusive and exclusive of its child phases.',
  'resource-attempts': 'Every attempt with its timing, disposition and what was retained from it.',
  'resource-measurements': 'Every per-attempt measurement, one metric per row.',
  'timing-spans': 'Every timed span of every attempt, with its parent span and phase.',
  conventions: 'How often each response convention appeared, per task and condition.',
  strata: 'The same rates split by each declared dimension, to show where a difference comes from.',
  identities: 'The SHA-256 of the project, journal and summary this report derives from.',
}
const TABLE_NOTE_PREFIXES = [
  ['composition-', 'The composition tree of this task: every layer with its bundle, parameters, digest and review status.'],
  ['source-map-', 'Which layer produced each character range of the compiled prompt above.'],
  ['trial-', 'What happened on this attempt: task, condition, timing and, for a failure, its phase and reason.'],
  ['identity-', 'What the adapter reported about the model it ran and its usage, verbatim, beside the declared model; output, request and process records are in response.json.'],
  ['grade-', 'How this attempt was graded, including the engine image and exit code when it was graded natively.'],
  ['attribution-', 'Where this code came from, exactly as the provenance registry classifies it.'],
  ['endpoint-conditions-', 'This typed endpoint per condition, with unavailable and invalid values counted separately.'],
  ['endpoint-strata-', 'This typed endpoint split by each declared dimension.'],
]
// Native LEAN admission is not part of this version: a native run is apparatus-development
// evidence until admission ships, and a study graded by native LEAN says so in its limitations.
export const NATIVE_ADMISSION_LIMITATION = 'Native LEAN admission is not part of this version. Until it ships, a native LEAN run is apparatus-development evidence, not an admitted experimental result.'
export function nativeAdmissionLimitation(spec) {
  return spec?.protocol?.grading?.kind === 'lean-python' ? [NATIVE_ADMISSION_LIMITATION] : []
}

export function tableNote(id) {
  if (Object.hasOwn(TABLE_NOTES, id)) return TABLE_NOTES[id]
  return TABLE_NOTE_PREFIXES.find(([prefix]) => id.startsWith(prefix) && id.length > prefix.length)?.[1] ?? null
}

// A registry or ATTRIBUTIONS.md sentence claiming no third-party code is used.
// It may be printed only when the registry itself lists no reused or adapted code.
const BLANKET_NO_REUSE = /no third[- ]party (source )?code|nothing (from another project )?is (reused|copied)|no (third[- ]party |upstream )?source (code )?is copied/i
const REUSE_KINDS = ['reused', 'adapted'], REFERENCE_KINDS = ['reference', 'reviewed', 'reviewed-reference']
function attributionClass(entry) {
  const kind = entry?.codeProvenance?.kind
  if (REUSE_KINDS.includes(kind)) return 'reuse'
  if (REFERENCE_KINDS.includes(kind)) return 'reference'
  if (kind === 'generated') return entry.codeProvenance.basis === 'api' ? 'api' : 'generated'
  return 'unrecognised'
}
function bundleReview(compiled) {
  const records = new Map((compiled.bundles || []).map(bundle => [bundle.id, bundle]))
  return id => {
    const bundle = records.get(id)
    if (!bundle) return 'Not in the frozen bundle list'
    if (!bundle.approved) return 'Unreviewed'
    return bundle.review?.reviewer ? 'Approved by ' + bundle.review.reviewer + ' on ' + bundle.review.at : 'Approved; reviewer not retained'
  }
}
function exemplarTasks(project) {
  if (project.tasks.length <= 8) return project.tasks
  const seen = new Set(), chosen = []
  for (const task of project.tasks) {
    const family = task.familyId || task.id
    if (seen.has(family)) continue
    seen.add(family); chosen.push(task)
  }
  return chosen
}
function journalTime(events) {
  for (let index = events.length - 1; index >= 0; index--) if (typeof events[index]?.at === 'string') return events[index].at
  return NOT_DECLARED
}
function runtimeVersions(events) {
  const seen = new Set()
  for (const event of events) if (event.type === 'started' && event.runtime) seen.add(canonical(event.runtime))
  return seen.size ? [...seen].sort().join(' ; ') : NOT_DECLARED
}
function adapterTarget(condition) {
  const adapter = condition.adapter
  if (adapter.kind === 'replay') return 'Saved responses; no provider call'
  if (adapter.kind === 'command') return [adapter.command, ...(adapter.args || [])].join(' ')
  if (adapter.kind === 'http') return adapter.url
  if (adapter.kind === 'module') return adapter.file
  return NOT_DECLARED
}

function paperSections(context, kit) {
  const { project, events, artifact, summary, execution, plan, taskLabels, provenance, provenanceSha256, attributions, attributionsSha256, manifest, manifestSha256, notices, qualification, qualificationSha256, nativeVerification, nativeVerificationSha256, archiveIntegrity = null, runtimeIntegrity = null, citation, pricing = null } = context
  const { html, md, table, markdownTable, counted, percent } = kit
  const files = {}
  const front = { sections: [], markdown: [], blocks: [] }, middle = { sections: [], markdown: [], blocks: [] }
  const integrity = { sections: [], markdown: [], blocks: [] }, limits = { sections: [], markdown: [], blocks: [] }, checklist = { sections: [], markdown: [], blocks: [] }, attribution = { sections: [], markdown: [], blocks: [] }
  const citationRecord = { sections: [], markdown: [], blocks: [] }, references = { sections: [], markdown: [], blocks: [] }
  // Bracketed citations. Every key must exist in the method-reference registry;
  // the References section lists exactly the entries cited, in first-use order.
  const cited = []
  const refLabel = entry => entry.authors[0].family + (entry.authors.length === 2 ? ' & ' + entry.authors[1].family : entry.authors.length > 2 ? ' et al.' : '') + ' ' + entry.year
  const refTo = (...ids) => '[' + ids.map(id => { const entry = methodReference(id); if (!cited.includes(id)) cited.push(id); return refLabel(entry) }).join('; ') + ']'
  const atRaw = target => ({
    heading: (title, level = 2) => { target.sections.push('<h' + level + '>' + html(title) + '</h' + level + '>'); target.markdown.push('#'.repeat(level) + ' ' + md(title)) },
    paragraph: value => { target.sections.push('<p>' + html(value) + '</p>'); target.markdown.push(md(value)) },
    table: (id, headers, rows) => {
      const note = tableNote(id)
      if (note) { target.sections.push('<p class="table-intro">' + html(note) + '</p>'); target.markdown.push(md(note)) }
      target.sections.push(table(headers, rows, id)); target.markdown.push(markdownTable(headers, rows))
    },
    verbatim: (title, text, note) => {
      const shown = preview(text), fence = fenceFor(shown.text)
      target.sections.push('<h4>' + html(title) + '</h4><pre><code>' + html(shown.text) + '</code></pre>')
      target.markdown.push('#### ' + md(title) + '\n\n' + fence + '\n' + shown.text + '\n' + fence)
      const caption = shown.truncated ? 'Showing the first ' + shown.text.length + ' of ' + shown.length + ' characters (truncated; full text in ' + note + ').'
        : note ? 'Full text also retained in ' + note + '.' : null
      if (caption) { target.sections.push('<p class="table-note">' + html(caption) + '</p>'); target.markdown.push(md(caption)) }
    },
    link: (label, href) => { target.sections.push('<p><a href="' + href + '">' + html(label) + '</a></p>'); target.markdown.push('[' + md(label) + '](' + href + ')') },
    list: values => { target.sections.push('<ul>' + values.map(value => '<li>' + html(value) + '</li>').join('') + '</ul>'); target.markdown.push(values.map(value => '- ' + md(value)).join('\n')) },
  })
  // Same calls, additionally recorded as data. The report keeps rendering from
  // atRaw; the Research page renders these blocks itself, so the page and the
  // report cannot describe the same run differently.
  const at = target => {
    const base = atRaw(target)
    return {
      heading: (title, level = 2) => { target.blocks.push({ kind: 'heading', title, level }); base.heading(title, level) },
      paragraph: value => { target.blocks.push({ kind: 'paragraph', text: value }); base.paragraph(value) },
      table: (id, headers, rows) => { target.blocks.push({ kind: 'table', id, headers, rows }); base.table(id, headers, rows) },
      verbatim: (title, text, note) => { target.blocks.push({ kind: 'verbatim', title, text, note: note ?? null, preview: preview(text) }); base.verbatim(title, text, note) },
      link: (label, href) => { target.blocks.push({ kind: 'link', label, href }); base.link(label, href) },
      list: values => { target.blocks.push({ kind: 'list', values }); base.list(values) },
      group: (kind, key) => { target.blocks.push({ kind: 'group', group: kind, key }) },
    }
  }
  const head = at(front), mid = at(middle), integ = at(integrity), lim = at(limits), check = at(checklist), cite = at(attribution), credit = at(citationRecord), biblio = at(references)
  const trials = new Map(project.schedule.map(row => [row.id, row]))
  const tasks = new Map(project.tasks.map(row => [row.id, row]))
  const conditions = new Map(project.spec.conditions.map(row => [row.id, row]))
  const protocol = project.spec.protocol

  // 1. Front matter.
  head.heading('Front matter')
  head.paragraph(PURPOSE_BANNER[execution.purpose] || 'Execution purpose ' + execution.purpose + '.')
  const compilerVersions = [...new Set(project.tasks.map(task => task.compiled.compilerVersion))].sort()
  head.table('front-matter', ['Field', 'Value'], [
    ['Title', project.spec.name],
    ['Study identifier', project.spec.id],
    ['Study version', project.spec.version || NOT_DECLARED],
    ['Domain', project.spec.domain || NOT_DECLARED],
    ['Template', TEMPLATE.title + ' ' + TEMPLATE.version + ' (' + TEMPLATE.id + ')'],
    ['Template runtime identity', citation.identity ? 'sha256:' + citation.identity : NOT_DECLARED],
    ['Generator', TEMPLATE.generator.name + ' ' + TEMPLATE.generator.version],
    ['Execution purpose', execution.purpose],
    ['Evidence class', execution.evidenceClass],
    ['Experimental collection', execution.experimentalCollection],
    ['Frozen project SHA-256', project.sha256],
    ['Attempt journal SHA-256', artifact.journalSha256],
    ['Canonical summary SHA-256', artifact.summarySha256],
    ['Report generated for journal time', journalTime(events)],
    ['Prompt compiler version', compilerVersions.join(', ') || NOT_DECLARED],
    ['Price table', pricing ? 'frozen ' + pricing.table.frozenAsOf + ', ' + counted(pricing.table.models.length, 'model') + ', identity sha256:' + pricing.identity : NOT_DECLARED],
    ['Generated with', project.spec.generator ? project.spec.generator.name + ' ' + project.spec.generator.version : NOT_DECLARED],
    ['Runtime versions', runtimeVersions(events)],
  ])
  head.paragraph('The generation time above is the last timestamp in the attempt journal, not the clock of the machine that rendered this report, so the same project and journal always produce the same bytes.')
  head.paragraph(execution.scope + ' ' + execution.computationScope)

  // 2. Abstract.
  head.heading('Abstract')
  const completedDenominator = plan?.primaryDenominator === 'completed'
  // The headline is the declared primary population under the frozen denominator,
  // and its k/n uses the same eligible denominator as its percentage.
  const headline = summary.groups.map(group => {
    const cell = group.primary || group, denominator = completedDenominator ? cell.eligibleCompleted : cell.eligibleScheduled
    return group.condition + ' ' + cell.passed + '/' + denominator + ' (' + percent(completedDenominator ? cell.passRate : cell.scheduledPassRate) + ')'
  }).join('; ')
  const interval = summary.contrasts.find(contrast => contrast.interval)
  const recorded = project.spec.conditions.every(condition => condition.adapter.kind === 'replay')
  const evidenceSentence = summary.audit ? 'This is judge-audit evidence measured against reference verdicts fixed before judging.'
    : recorded ? 'This is a recorded-response apparatus check, not a model result.'
      : execution.purpose === 'apparatus-development' ? 'This is apparatus-development evidence that includes newly collected responses; it is development evidence, not a qualified model result.'
        : execution.purpose === 'recorded-diagnostic' ? 'This is a recorded diagnostic; no response in it is admitted as a new model result.'
          : 'This is a collected study result under the frozen protocol.'
  head.paragraph(project.spec.name + ' is a ' + (project.spec.domain || 'generic') + ' benchmark of ' + counted(project.tasks.length, 'task') + ' evaluated under '
    + counted(project.spec.conditions.length, 'condition') + ' with ' + counted(protocol.replicates, 'replicate') + ' per cell, giving '
    + counted(summary.scheduled, 'scheduled trial') + ', of which ' + summary.completed + ' completed. The primary endpoint is '
    + summary.criterion.label.toLowerCase() + ' over the ' + (plan ? plan.primaryDenominator : 'scheduled and completed') + ' denominator. '
    + (headline ? 'Headline: ' + headline + '. ' : '')
    + (interval ? 'Planned contrast ' + interval.id + ' differs by ' + number(interval.difference) + ' (interval ' + number(interval.interval.low) + ' to ' + number(interval.interval.high) + '), first minus second, a ' + interval.interval.confidence + ' ' + interval.interval.kind + ' interval under multiplicity ' + interval.interval.multiplicity + '; ' + counted(summary.contrasts.length, 'planned contrast') + ' in the contrasts table. '
      + (interval.interval.low === interval.interval.high ? DEGENERATE_NOTE + ' '
      : (interval.families ?? 0) < COVERAGE_MINIMUM_CLUSTERS ? rangeNote(interval.families ?? 0) + ' ' : '')
      : plan?.uncertainty ? 'No planned contrast produced an estimable interval. ' : 'No uncertainty procedure was declared, so no interval is reported. ')
    + evidenceSentence)

  // 3. Research question and design.
  head.heading('Research question and design')
  head.verbatim('Frozen study decisions (verbatim)', project.spec.decisions || NOT_DECLARED, null)
  if (plan?.rationale) head.verbatim('Analysis-plan rationale (verbatim)', plan.rationale, null)
  else head.paragraph('No analysis plan was frozen, so no rationale, primary endpoint or confirmatory status is declared.')
  head.table('design-declarations', ['Field', 'Value'], [
    ['Cohort', plan?.cohort || NOT_DECLARED],
    ['Population', summary.primaryPopulation ? summary.primaryPopulation.label : NOT_DECLARED],
    ['Primary denominator', plan?.primaryDenominator || NOT_DECLARED],
    ['Uncertainty procedure', plan?.uncertainty ? plan.uncertainty.kind + ' (' + plan.uncertainty.iterations + ' resamples, seed ' + plan.uncertainty.seed + ', confidence ' + plan.uncertainty.confidence + ')' : NOT_DECLARED],
    ['Multiplicity', plan?.multiplicity || NOT_DECLARED],
    ['Criterion', summary.criterion.label + ': ' + summary.criterion.definition],
  ])
  const planned = plan?.contrasts || []
  head.paragraph(planned.length ? 'The planned contrasts are the hypotheses of this study. Each was declared before collection and is reported whatever its outcome.'
    : 'No contrast was planned, so this report makes no comparative claim between conditions.')
  if (planned.length) head.table('planned-contrasts', ['Contrast', 'First', 'Second'], planned.map(contrast => [contrast.id, contrast.first, contrast.second]))

  const methodFrom = front.blocks.length
  // 4. Method: task construction, and the layers each prompt is built from.
  head.heading('Method: task construction and composition layers')
  const chosen = exemplarTasks(project)
  head.paragraph(chosen.length === project.tasks.length
    ? 'Every frozen task is listed below with its composition tree and its complete compiled prompt.'
    : 'One exemplar task per family is listed below with its composition tree and complete compiled prompt; all ' + project.tasks.length + ' tasks appear in the task table with their prompt digests.')
  head.paragraph('A composition node is one bundle placed in one slot. The compiled prompt is the concatenation of the disclosed node prose in tree order, followed by any runtime appendix. The character ranges below map every span of that text back to the node that produced it, so no wording in the prompt is unattributed.')
  for (const task of chosen) {
    head.group('task', task.id)
    const compiled = task.compiled, ir = compiled.composition, review = bundleReview(compiled)
    const visibility = new Map((compiled.checklist || []).map(row => [row.path, row]))
    const label = taskLabels.get(task.id) || task.id
    head.heading(label + ' — ' + task.id + (task.familyId ? ' (family ' + task.familyId + ')' : ''), 3)
    head.table('composition-' + task.id, ['Node path', 'Kind', 'Role', 'Slot', 'Bundle', 'Version', 'Parameters', 'Disclosed', 'Bundle SHA-256', 'Review'],
      ir.nodes.map(node => {
        const depth = node.path === 'root' ? 0 : node.path.split('/').length - 1
        return ['· '.repeat(depth) + node.path, node.kind, node.role, node.slot ?? '', node.bundle.id, node.bundle.version,
          canonical(node.parameters), visibility.get(node.path)?.disclosure || (node.disclosed ? 'yes' : 'withheld'), node.bundle.sha256, review(node.bundle.id)]
      }))
    head.verbatim('Compiled prompt for ' + task.id + ' (verbatim)', compiled.text, 'paper/prompts/' + task.id + '.txt')
    files['paper/prompts/' + task.id + '.txt'] = compiled.text + '\n'
    files['paper/composition/' + task.id + '.json'] = JSON.stringify(ir, null, 2) + '\n'
    files['paper/source-maps/' + task.id + '.json'] = JSON.stringify({ unit: compiled.sourceMapUnit, promptSha256: compiled.promptSha256, ranges: compiled.sourceMap }, null, 2) + '\n'
    const ranges = compiled.sourceMap.slice(0, SOURCE_MAP_PREVIEW_ROWS)
      .map(range => [String(range.start), String(range.end), range.path, range.bundleId ?? 'runtime appendix', range.requirementId])
    head.paragraph('Layer map for ' + task.id + ', in ' + (compiled.sourceMapUnit || 'UTF-16 code units') + '. Prompt SHA-256 ' + compiled.promptSha256 + '.')
    head.table('source-map-' + task.id, ['Start', 'End', 'Node path', 'Bundle', 'Requirement'], ranges)
    if (compiled.sourceMap.length > ranges.length) head.link('Showing ' + ranges.length + ' of ' + compiled.sourceMap.length + ' ranges. Full layer map: paper/source-maps/' + task.id + '.json.', 'paper/source-maps/' + task.id + '.json')
    for (const appendix of ir.appendices || []) {
      head.paragraph('Runtime appendix ' + appendix.id + ' is appended to the prompt above from ' + appendix.source + '. Its SHA-256 is ' + (appendix.sha256 || NOT_DECLARED) + '. It is an execution contract, not authored task wording.')
      head.verbatim('Runtime appendix ' + appendix.id + ' (verbatim)', appendix.text, 'paper/appendices/' + task.id + '-' + appendix.id + '.txt')
      files['paper/appendices/' + task.id + '-' + appendix.id + '.txt'] = appendix.text + '\n'
    }
  }

  // 5. Method: conditions and what was actually sent.
  head.heading('Method: conditions and collection')
  head.table('condition-collection', ['Condition', 'Label', 'Provider', 'Declared model', 'Surface', 'Adapter', 'Target', 'Credential variable', 'Settings'],
    project.spec.conditions.map(condition => [condition.id, condition.label || '', condition.model?.provider || NOT_DECLARED, condition.model?.id || NOT_DECLARED,
      condition.model?.surface || NOT_DECLARED, condition.adapter.kind, adapterTarget(condition), condition.adapter.credentialEnv || 'none',
      canonical(condition.model?.settings || {})]))
  head.paragraph('The credential column names the environment variable a condition reads, never its value. A credential travels in the transport header and is not part of the request envelope below, so no envelope in this report can carry one.')
  let retainedEnvelopes = 0, rebuiltEnvelopes = 0
  for (const condition of project.spec.conditions) {
    const trial = project.schedule.find(row => row.conditionId === condition.id)
    if (!trial) { head.paragraph('Condition ' + condition.id + ' has no scheduled trial, so no request envelope is shown.'); continue }
    const task = tasks.get(trial.taskId)
    // Prefer the envelope the runner actually sent, kept in the journal at dispatch. Evidence
    // recorded before envelopes were retained still gets the rebuild, labelled as one.
    const retained = events.find(row => row.type === 'started' && row.trialId === trial.id && row.attempt === 1 && row.request)?.request
    if (retained) retainedEnvelopes++; else rebuiltEnvelopes++
    const request = retained || collectionRequest(project, condition, task, { id: trial.id, taskId: trial.taskId, conditionId: trial.conditionId, replicate: trial.replicate }, 1)
    const text = JSON.stringify(JSON.parse(canonical(request)), null, 2)
    head.verbatim((retained ? 'Request envelope retained at dispatch for ' : 'Request envelope for ') + condition.id + ', exemplar trial ' + trial.id + ' attempt 1', text, 'paper/requests/' + condition.id + '.json')
    files['paper/requests/' + condition.id + '.json'] = text + '\n'
  }
  if (retainedEnvelopes && !rebuiltEnvelopes)
    head.paragraph('Each envelope above is the exact object the runner built and handed to the adapter, retained in the attempt journal at the moment it was sent. It is what was sent, not a later rendering of what should have been.')
  else if (retainedEnvelopes)
    head.paragraph('Envelopes marked retained at dispatch are the exact objects the runner sent, kept in the attempt journal at that moment. The rest belong to attempts recorded before envelopes were retained and are rebuilt from the frozen project by collectionRequest, the same function the runner calls before dispatch, so those are a faithful reconstruction of what was sent and not a second recording of it.')
  else
    head.paragraph('Each envelope above is rebuilt from the frozen project by collectionRequest, the same function the runner calls before dispatch. The journal retains the response, not a separate copy of the request, so this is a faithful reconstruction of what was sent and not a second recording of it.')
  // Item 5 asks what was applied, not only what was declared. Where a condition declares
  // collection controls, say what its attempts reported, so a reader cannot mistake a claim
  // for a receipt. A study that declares nothing gains no section and no file.
  const declaringTools = project.spec.conditions.filter(condition => Array.isArray(condition.collection?.tools))
  if (declaringTools.length) {
    const conditionOf = new Map(project.schedule.map(row => [row.id, row.conditionId]))
    head.heading('Declared tool policy and what the attempts applied', 3)
    head.table('condition-tool-policy', ['Condition', 'Declared', 'Applied', 'Attempts', 'Basis'],
      declaringTools.map(condition => {
        const seen = events.filter(row => row.type === 'finished' && conditionOf.get(row.trialId) === condition.id)
          .map(row => row.observations?.reported?.toolPolicy).filter(Boolean)
        const tally = new Map()
        for (const row of seen) tally.set(row.applied, (tally.get(row.applied) || 0) + 1)
        const bases = [...new Set(seen.map(row => row.basis))]
        return [condition.id, condition.collection.tools.length ? condition.collection.tools.join(', ') : 'none',
          seen.length ? [...tally].map(([applied, count]) => applied + ' x' + count).join('; ') : NOT_DECLARED,
          String(seen.length), bases.length ? bases.join(', ') : NOT_DECLARED]
      }))
    head.paragraph('A declaration is not a receipt. Declared is what the condition asked for; applied is what each attempt\u2019s adapter reported it did, counted over that condition\u2019s attempts. An attempt that reported nothing is recorded as unreported, which is not the same as no tools, and a recorded replay dispatched no request at all.')
  }

  const methodTo = front.blocks.length
  // 6. Method: protocol and apparatus.
  head.heading('Method: protocol and apparatus')
  head.table('protocol-apparatus', ['Field', 'Value'], [
    ['Schedule', project.tasks.length + ' tasks × ' + project.spec.conditions.length + ' conditions × ' + protocol.replicates + ' replicates = ' + summary.scheduled + ' trials'],
    ['Order', 'Frozen schedule order; the runner retains the first completed attempt and never redraws on grade'],
    ['Seed', protocol.seed ?? NOT_DECLARED],
    ['Attempts per trial', protocol.maxAttemptsPerTrial],
    ['Attempts overall', protocol.maxTotalAttempts],
    ['Attempt timeout ms', protocol.timeoutMs],
    ['Study duration budget ms', protocol.maxDurationMs],
    ['Grading', protocol.grading.kind],
    ['Criterion', summary.criterion.definition],
  ])
  if (protocol.grading.kind === 'lean-python') {
    head.paragraph('Native grading runs each returned program in an owned, disposable container and grades the engine order artifacts. Printed trace claims in model output are ignored.')
    // Container arguments come only from the grade records this run wrote. An attempt
    // reached the engine when its grade carries an execution record.
    const engineGrades = events.filter(event => event.type === 'finished' && event.grade && Object.hasOwn(event.grade, 'execution'))
    const recordedContainers = engineGrades.filter(event => event.grade.container), variants = new Set(recordedContainers.map(event => canonical(event.grade.container)))
    const container = variants.size === 1 ? recordedContainers[0].grade.container : null
    const mounts = container ? container.arguments.filter((arg, index, args) => args[index - 1] === '--mount').map(value => {
      const target = value.split(',').find(part => part.startsWith('target='))?.slice(7) || value
      return target + (value.split(',').includes('readonly') ? ' (read-only)' : ' (writable)')
    }) : []
    const notRecorded = engineGrades.length === 0 ? 'Not recorded: no attempt in this journal reached the engine'
      : 'Not recorded: none of the ' + engineGrades.length + ' native grade records in this journal carries its container arguments'
    head.table('native-apparatus', ['Field', 'Value'], [
      ['Pinned engine image', project.spec.environment?.leanImage || NOT_DECLARED],
      ['Execution timeout ms', protocol.grading.executionTimeoutMs ?? NOT_DECLARED],
      ['Container arguments', recordedContainers.length === 0 ? notRecorded : container ? container.engine + ' ' + container.arguments.join(' ') + ' (recorded in ' + recordedContainers.length + ' of ' + engineGrades.length + ' native grade records)'
        : variants.size + ' different argument lists are recorded; each attempt\u2019s grade.json carries its own'],
      ['Mounts', recordedContainers.length === 0 ? notRecorded : container ? mounts.join('; ') || 'None recorded' : 'See each attempt\u2019s grade.json'],
      ['Data generation (runtime behaviour, not a per-run record)', 'deterministic equity minute files generated from the frozen task input; market-hours and symbol-properties copied from the pinned image'],
    ])
  }
  const qualifications = events.filter(event => event.type === 'qualification'), gate = project.requirements?.selectedInput
  const rejectedQualifications = events.filter(event => event.type === 'qualification-failed').length
  const receiptReport = event => 'qualification-receipts/' + event.seq + '/qualification/report.html'
  if (qualifications.length) {
    head.paragraph(counted(qualifications.length, 'qualification receipt') + ' recorded in the attempt journal before collection. Each checks the exact selected inputs by independent JavaScript and Python interpretation; agreement is reproducible evidence, not a third-party execution attestation.')
    head.table('qualification-receipts', ['Journal sequence', 'Recorded at', 'Preparation sequence', 'Registered occurrences', 'Composition occurrences', 'Retained report'], qualifications.map(event => {
      const selected = event.record?.requirements?.selectedInput
      return [event.seq, event.at, event.preparationSeq ?? 'Legacy receipt (unpaired)', selected?.registeredStatus ?? NOT_DECLARED, selected?.compositionStatus ?? NOT_DECLARED, gate ? receiptReport(event) : NOT_DECLARED]
    }))
    if (gate) for (const event of qualifications) head.link('Qualification report for journal sequence ' + event.seq, receiptReport(event))
  } else if (gate) head.paragraph('This project freezes the selected-input qualification policy ' + gate.policy + ', but this attempt journal holds no accepted qualification receipt'
    + (rejectedQualifications ? ' (' + counted(rejectedQualifications, 'rejected or interrupted qualification') + ' recorded)' : '') + '.')
  else head.paragraph('No journaled qualification receipt appears in this report because this project freezes no selected-input qualification policy (requirements.selectedInput is absent), so the runner records none in the attempt journal. The standalone node cli.mjs qualify command writes its interpreter agreement record to results/qualification.json, outside the attempt journal; this report neither reads nor verifies that file by itself. When node cli.mjs analyze or the Research page supplies it beside the journal, it is bound to this frozen project and shown under Pre-collection qualification receipt below.')

  // 6b. The standalone pre-collection qualification receipt. `node cli.mjs
  // qualify` writes results/qualification.json beside the journal; it is not a
  // journal event, so it reaches this report only as a receipt bound to this
  // project by boundReceipts, never by inference from the journal.
  head.heading('Pre-collection qualification receipt', 3)
  if (qualification === null) {
    head.paragraph(NOT_DECLARED + '. No qualification receipt (results/qualification.json, written by node cli.mjs qualify) was supplied with this journal, so this report shows no independent-interpreter agreement for the frozen apparatus. Run node cli.mjs qualify in the exported project and then node cli.mjs analyze, or import run evidence that carries the receipt.')
  } else {
    const checks = Array.isArray(qualification.checks) ? qualification.checks : [], environment = qualification.environment || {}
    const runtimeCount = Object.keys(project.spec.runtimeSources || {}).length
    head.paragraph('Receipt SHA-256 ' + qualificationSha256 + ' (' + qualification.format + ' version ' + qualification.version + '), retained verbatim at paper/qualification.json. Verified while producing this report: the receipt names this frozen project and pins the same ' + runtimeCount + ' runtime file digests. Declared by the receipt and not re-executed here: the ' + counted(checks.length, 'check') + ' below and the environment that ran them.')
    head.paragraph('Recorded environment: Node ' + (environment.node ?? NOT_DECLARED) + ' on ' + (environment.platform ?? NOT_DECLARED) + ' ' + (environment.architecture ?? NOT_DECLARED) + '; Python command ' + (environment.python ?? NOT_DECLARED) + '.')
    const present = value => value !== undefined && value !== null && value !== ''
    head.table('qualification-checks', ['Check', 'Kind', 'Passed', 'Interpreter agreement (recomputed from the receipt)', 'Detail'], checks.map(check => {
      const label = [check.fixtureId, check.taskId, check.variantId].filter(present).join(' / ') || NOT_DECLARED
      const passed = check.passed === true ? 'yes' : check.passed === false ? 'no' : 'not applicable'
      const details = []
      let agreement = 'not applicable'
      if (check.javascript !== undefined && check.python !== undefined) {
        const independent = check.python !== null && typeof check.python === 'object' && 'result' in check.python ? check.python.result : check.python
        agreement = canonical(check.javascript ?? null) === canonical(independent ?? null) ? 'JavaScript and Python agree' : 'JavaScript and Python DISAGREE'
        // qualify.mjs checks the declared expectation against the independent
        // (Python) interpretation, so that is the comparison repeated here.
        const observed = independent?.observation ?? independent?.trace
        if (Array.isArray(check.javascript?.trace)) details.push(check.javascript.trace.length + (check.javascript.trace.length === 1 ? ' trace entry' : ' trace entries'))
        if (check.expected !== undefined) details.push(canonical(check.expected ?? null) === canonical(observed ?? null) ? 'expected observation matched' : 'expected observation NOT matched')
      } else if (check.reference !== undefined && check.independent !== undefined) {
        agreement = canonical(check.reference ?? null) === canonical(check.independent ?? null) ? 'reference and independent modules agree' : 'reference and independent modules DISAGREE'
      } else if (check.grade !== null && typeof check.grade === 'object') {
        agreement = check.grade.passed === true ? 'declared answer passes its own grading rule' : 'declared answer does not pass its own grading rule'
      }
      if (typeof check.reason === 'string' && check.reason) details.push(check.reason)
      return [label, check.kind ?? NOT_DECLARED, passed, agreement, details.join('; ')]
    }))
    if (qualification.requirements !== null && typeof qualification.requirements === 'object') {
      const requirements = qualification.requirements
      head.paragraph('Requirement qualification recorded in the receipt: status ' + (requirements.status ?? NOT_DECLARED) + '; ' + (Array.isArray(requirements.targets) ? requirements.targets.length : 0) + ' targets; ' + (Array.isArray(requirements.unregistered) ? requirements.unregistered.length : 0) + ' unregistered requirement occurrences.')
    }
    if (Array.isArray(qualification.moduleExecutions) && qualification.moduleExecutions.length) head.paragraph(counted(qualification.moduleExecutions.length, 'interpreter module execution') + ' recorded in the receipt with their process records.')
    head.paragraph('Receipt scope, verbatim: ' + (typeof qualification.scope === 'string' ? qualification.scope : NOT_DECLARED))
    files['paper/qualification.json'] = JSON.stringify(JSON.parse(canonical(qualification)), null, 2) + '\n'
  }

  // 6b. Statistical methods: what the frozen plan fixed, with the primary reference
  // of each procedure; pre-registration by freeze; dispersion; contamination controls.
  head.heading('Statistical methods')
  const clusterUnit = plan?.uncertainty ? (plan.uncertainty.kind === 'family-bootstrap' || plan.uncertainty.clusterBy === 'familyId' ? 'task family (familyId)' : 'cluster of task factor ' + plan.uncertainty.clusterBy.factor) : null
  const excludedScheduled = summary.primaryPopulation ? summary.primaryPopulation.excludedScheduled : 0
  head.table('statistical-methods', ['Element', 'Frozen choice', 'Reference'], [
    ['Primary criterion', summary.criterion.label + ': ' + summary.criterion.definition, ''],
    ['Primary denominator', plan ? plan.primaryDenominator + ' trials in the primary population' : NOT_DECLARED + ' (both descriptive rates are shown)', ''],
    ['Primary population and exclusions', summary.primaryPopulation ? summary.primaryPopulation.label + '; ' + counted(excludedScheduled, 'scheduled trial') + ' excluded by the frozen rule in the primary-population table, none by outcome' : NOT_DECLARED, ''],
    ['Repeated trials', counted(protocol.replicates, 'replicate') + ' of every task under every condition; the first completed attempt of a trial is retained and never redrawn on its grade', ''],
    ['Schedule order', 'Fisher-Yates shuffle of the crossed schedule seeded with protocol.seed ' + (protocol.seed ?? NOT_DECLARED) + ' (mulberry32 generator)', refTo('durstenfeld-1964', 'mulberry32')],
    ['Interval procedure', plan?.uncertainty ? 'Paired percentile bootstrap over whole clusters: each of the ' + plan.uncertainty.iterations + ' resamples draws ' + clusterUnit + ' units with replacement, keeps every unit\u2019s rows together in both conditions, recomputes the statistic, and takes the ' + plan.uncertainty.confidence + ' interval from the sorted draws; seed ' + plan.uncertainty.seed      + '. A span over fewer than ' + COVERAGE_MINIMUM_CLUSTERS + ' clusters is reported as a ' + RANGE_LABEL + ' rather than at its nominal level.'
      + ' The threshold of ' + COVERAGE_MINIMUM_CLUSTERS + ' is this template\u2019s own rule, not a value taken from the literature: a whole-cluster resample over G clusters forms only C(2G-1, G) distinct multisets, which is 3 at 2 clusters, 10 at 3, 35 at 4 and 126 at 5, so below '
      + COVERAGE_MINIMUM_CLUSTERS + ' the percentile endpoints are fixed by that discreteness rather than by coverage.'
      + ' The cited work establishes that cluster-robust inference is unreliable with few clusters; it does not prescribe this threshold' : 'None declared; tables report descriptive counts and rates without intervals', plan?.uncertainty ? refTo('efron-1979', 'efron-tibshirani-1993', 'field-welsh-2007', 'davison-hinkley-1997', 'cameron-2008') : ''],
    ['Percentile definition', plan?.uncertainty ? 'Sample quantile by linear interpolation at position (n\u22121)p over the sorted resample statistics (definition 7)' : NOT_DECLARED, plan?.uncertainty ? refTo('hyndman-fan-1996') : ''],
    ['Proportion intervals', plan?.uncertainty
      ? 'Every printed rate carries a Wilson score interval at the declared ' + plan.uncertainty.confidence + ' level, chosen over the Wald interval because it cannot leave the unit range and its coverage does not collapse at an all-pass or all-fail condition. It is an interval for one proportion under independent trials: where tasks share a family, or a cell is repeated, the trials are not independent and this interval is narrower than the design warrants, so read it beside the clustered contrast intervals'
      : NOT_DECLARED + '; no uncertainty procedure was declared, so rates are printed without intervals', plan?.uncertainty ? refTo('wilson-1927', 'brown-cai-dasgupta-2001') : ''],
    ['Multiplicity', plan ? (plan.multiplicity === 'bonferroni' ? 'Bonferroni: each interval level is divided by the number of planned intervals in its family' : 'none-descriptive: every interval is reported at its own level and the contrasts are descriptive') : NOT_DECLARED, plan?.multiplicity === 'bonferroni' ? refTo('dunn-1961') : ''],
    ['Typed endpoints', summary.endpoints ? summary.endpoints.declared.map(endpoint => endpoint.id + ' (' + endpoint.kind + ')').join(', ') + '; estimators as stated in the typed-endpoint section' : 'None declared', ''],
  ])
  head.paragraph('Pre-registration by freeze. ' + (plan ? 'The analysis plan (cohort, primary population, denominator, planned contrasts, uncertainty procedure and multiplicity' + (summary.endpoints ? ', typed endpoints' : '') + ') is part of the frozen project, whose SHA-256 ' + project.sha256 + ' is the registration identifier. Every started attempt in the journal binds to that identity' + (modernSchema(project) ? ' through its readiness digest' : '') + ', and this report is regenerated from the project and the journal, so the plan cannot have changed after collection without changing the identifier above. This fixes the analysis before the data exist and makes deviations detectable; it is not a time-stamped entry with an independent custodian.' : 'No analysis plan was frozen, so nothing was pre-registered; every rate in this report is descriptive.') + ' ' + refTo('nosek-2018'))
  if (plan?.uncertainty) head.paragraph('Dependence between trials of one ' + clusterUnit + ' is handled by resampling whole units, the same dependence that clustered standard errors address in language-model evaluations; the unit count is printed beside every interval. ' + refTo('miller-2024'))
  head.paragraph(protocol.replicates > 1
    ? 'Dispersion across the ' + protocol.replicates + ' replicates of every cell is reported per condition in the replicate-dispersion table (mean, sample standard deviation and range of the replicate-level primary rates). It describes repeated runs of one frozen schedule under one apparatus, not run-to-run variance of a re-frozen study, and it is descriptive: no test is applied to it. ' + refTo('dodge-2019', 'reimers-gurevych-2017', 'bouthillier-2021')
    : 'protocol.replicates is 1, so this journal holds one run of each cell and no dispersion across repeated runs can be reported; reporting results over repeated runs is the accepted practice this template supports through replicates. ' + refTo('dodge-2019', 'bouthillier-2021'))
  const heldOut = project.tasks.filter(task => task.split === 'held-out').length, withheld = project.tasks.filter(task => task.information).length
  const isolating = project.spec.conditions.filter(condition => typeof condition.collection?.sessionIsolation === 'string').length
  const startedAt = events.filter(event => event.type === 'started' && typeof event.at === 'string').map(event => event.at).sort()
  head.paragraph('Contamination and leakage controls. This template cannot observe whether any task text was in a provider\u2019s training data; it records what a contamination audit needs. Every compiled prompt carries its SHA-256 (task table and per-task listing above), ' + heldOut + ' of ' + counted(project.tasks.length, 'task') + ' are declared held-out and ' + (project.tasks.length - heldOut) + ' development, ' + counted(withheld, 'task') + ' withhold information from the prompt by design, ' + isolating + ' of ' + counted(project.spec.conditions.length, 'condition') + ' declare session isolation, and collection ran between ' + (startedAt[0] || NOT_DECLARED) + ' and ' + (startedAt.at(-1) || NOT_DECLARED) + ' by journal timestamps. Whether held-out tasks were kept unseen before collection is the investigator\u2019s declaration, not a measurement. ' + refTo('sainz-2023', 'jacovi-2023'))

  const runFrom = middle.blocks.length
  // 8. Run walkthrough.
  mid.heading('Run walkthrough')
  mid.paragraph('Every journal event in order, so a reader can follow one trial from qualification through response, grading and settlement without opening the raw journal.')
  mid.table('run-walkthrough', ['Seq', 'At', 'Event', 'Trial', 'Attempt', 'Phase', 'Status', 'Elapsed ms', 'Evidence'], events.map(event => {
    const finished = event.type === 'finished'
    return [String(event.seq), event.at || '', event.type, event.trialId || '', event.attempt === undefined ? '' : String(event.attempt),
      finished ? event.phase || 'complete' : '', event.status || '',
      finished && event.elapsedMs !== null && event.elapsedMs !== undefined ? String(event.elapsedMs) : '',
      finished ? 'trials/' + event.trialId + '-' + event.attempt + '/' : '']
  }))

  // 9. Per-trial evidence.
  mid.heading('Per-trial evidence')
  mid.paragraph('Each attempt below shows what was sent, what came back verbatim, and how it was graded. Blocks in this report are capped at ' + PREVIEW_LIMIT + ' characters; the complete copies under trials/ are never truncated.')
  const started = new Map()
  for (const event of events) if (event.type === 'started') started.set(event.trialId + ':' + event.attempt, event)
  for (const event of events) {
    if (event.type !== 'finished') continue
    const begin = started.get(event.trialId + ':' + event.attempt), directory = 'trials/' + event.trialId + '-' + event.attempt + '/'
    mid.group('attempt', event.trialId + '-' + event.attempt)
    const trial = trials.get(event.trialId), task = trial ? tasks.get(trial.taskId) : null
    const condition = trial ? conditions.get(trial.conditionId) : null
    mid.heading(event.trialId + ' attempt ' + event.attempt + ' — ' + event.status, 3)
    mid.table('trial-' + event.trialId + '-' + event.attempt, ['Field', 'Value'], [
      ['Task', trial?.taskId || NOT_DECLARED],
      ['Condition', trial?.conditionId || NOT_DECLARED],
      ['Replicate', trial?.replicate ?? NOT_DECLARED],
      ['Started at', begin?.at || NOT_DECLARED],
      ['Prompt SHA-256', begin?.promptSha256 || task?.compiled.promptSha256 || NOT_DECLARED],
      ['Status', event.status],
      ['Failure phase', event.status === 'completed' ? '' : event.phase || NOT_DECLARED],
      ['Reason', event.reason || ''],
      ['Elapsed ms', event.elapsedMs ?? 'Unavailable'],
    ])
    if (task) {
      files[directory + 'prompt.txt'] = task.compiled.text + '\n'
      mid.link('Prompt sent for this attempt, identical to the compiled prompt for ' + task.id, directory + 'prompt.txt')
      if (task.input !== undefined && task.input !== null) {
        const input = JSON.stringify(JSON.parse(canonical(task.input)), null, 2)
        files[directory + 'input.json'] = input + '\n'
        mid.verbatim('Task input', input, directory + 'input.json')
      }
      if (condition && trial) files[directory + 'request.json'] = JSON.stringify(JSON.parse(canonical(collectionRequest(project, condition, task,
        { id: trial.id, taskId: trial.taskId, conditionId: trial.conditionId, replicate: trial.replicate }, event.attempt))), null, 2) + '\n'
    }
    if (event.response === undefined) mid.paragraph('No response was retained for this attempt.')
    else {
      files[directory + 'response.json'] = JSON.stringify(JSON.parse(canonical(event.response)), null, 2) + '\n'
      const output = event.response?.output
      const outputText = typeof output === 'string' ? output : output === undefined ? null : JSON.stringify(JSON.parse(canonical(output)), null, 2)
      if (outputText === null) mid.paragraph('The retained response envelope carries no output field; the complete envelope is in ' + directory + 'response.json.')
      else {
        files[directory + 'response.txt'] = outputText + '\n'
        mid.verbatim('Model response, verbatim', outputText, directory + 'response.txt')
        mid.paragraph('Extraction: the output field was read from the retained envelope as ' + (typeof output === 'string' ? 'text' : 'JSON') + '.')
      }
    }
    if (event.response !== null && typeof event.response === 'object') {
      // What the adapter itself reported, copied verbatim from the retained envelope,
      // beside what the frozen condition declared. Nothing is normalized or inferred.
      const envelope = event.response, declared = condition?.model || {}
      const shown = value => { const text = preview(canonical(value)); return text.truncated ? text.text + ' (truncated; full value in ' + directory + 'response.json)' : text.text }
      const reportedRows = (key, label) => {
        const value = envelope[key]
        if (value === null || value === undefined) return [[label + ' (reported by the adapter)', NOT_DECLARED]]
        if (typeof value !== 'object' || Array.isArray(value)) return [[key + ' (reported by the adapter)', shown(value)]]
        const fields = Object.keys(value).sort()
        return fields.length ? fields.map(field => [key + '.' + field + ' (reported by the adapter)', value[field] === null ? NOT_DECLARED : shown(value[field])]) : [[label + ' (reported by the adapter)', NOT_DECLARED]]
      }
      const other = Object.keys(envelope).filter(key => !['output', 'process', 'request', 'usage', 'identity'].includes(key)).sort()
      mid.table('identity-' + event.trialId + '-' + event.attempt, ['Field', 'Value'], [
        ['Declared provider', declared.provider || NOT_DECLARED],
        ['Declared model', declared.id || NOT_DECLARED],
        ['Declared surface', declared.surface || NOT_DECLARED],
        ...reportedRows('usage', 'Usage'),
        ...reportedRows('identity', 'Identity'),
        ...other.flatMap(key => reportedRows(key, key)),
      ])
    }
    if (event.gradingEvidence !== undefined) {
      const evidence = JSON.stringify(JSON.parse(canonical(event.gradingEvidence)), null, 2)
      files[directory + 'grading-evidence.json'] = evidence + '\n'
      mid.verbatim('Retained grading evidence for the failure', evidence, directory + 'grading-evidence.json')
    }
    const grade = event.grade
    if (!grade) mid.paragraph('This attempt produced no grade.')
    else {
      files[directory + 'grade.json'] = JSON.stringify(JSON.parse(canonical(grade)), null, 2) + '\n'
      mid.table('grade-' + event.trialId + '-' + event.attempt, ['Field', 'Value'], [
        ['Passed', String(grade.passed)],
        ['Score', grade.score === undefined ? NOT_DECLARED : String(grade.score)],
        ['Classification', grade.classification || NOT_DECLARED],
        ['What that classification means', CLASSIFICATION_MEANINGS[grade.classification] || ''],
        ['Reason', grade.reason || ''],
        ['Engine image', grade.image || ''],
        ['Candidate SHA-256', grade.candidateSha256 || ''],
        ['Engine exit code', grade.execution?.exitCode === undefined ? '' : String(grade.execution.exitCode)],
        ...(grade.container ? [['Container arguments', grade.container.engine + ' ' + grade.container.arguments.join(' ')]] : []),
      ])
      if (grade.execution?.stderr) {
        files[directory + 'engine-stderr.txt'] = grade.execution.stderr
        mid.verbatim('Engine error output', grade.execution.stderr, directory + 'engine-stderr.txt')
      }
      if (grade.trace !== undefined && task?.expected !== undefined && task.expected !== null) {
        const expected = JSON.stringify(JSON.parse(canonical(task.expected)), null, 2), observed = JSON.stringify(JSON.parse(canonical(grade.trace)), null, 2)
        files[directory + 'expected-trace.json'] = expected + '\n'
        files[directory + 'native-trace.json'] = observed + '\n'
        mid.verbatim('Expected trace', expected, directory + 'expected-trace.json')
        mid.verbatim('Observed native trace', observed, directory + 'native-trace.json')
        const divergence = firstDivergence(task.expected, grade.trace)
        mid.paragraph(divergence === null ? 'The observed native trace matches the expected trace entry for entry.'
          : 'First divergence at entry ' + (divergence.index === null ? 'unknown' : divergence.index) + ': ' + divergence.reason
            + ' Expected ' + canonical(divergence.expected ?? null) + '; observed ' + canonical(divergence.observed ?? null) + '.')
      }
    }
    mid.link('Complete retained evidence for this attempt', directory)
  }

  const runTo = middle.blocks.length
  // 10. Integrity and reproduction.
  integ.heading('Integrity and reproduction')
  const runtimeSources = project.spec.runtimeSources || {}
  const runtimeRows = Object.keys(runtimeSources).sort().map(file => [file, runtimeSources[file]])
  const generator = project.spec.generator
  integ.paragraph(generator
    ? 'Generated with ' + generator.name + ' ' + generator.version + '. The frozen project records that at freeze time, inside the bytes its SHA-256 covers, so the generator of record travels with the project and is not read from the machine that rendered this report. A later release re-rendering this project reprints this same line.'
    : 'This project records no generator, so the application release that froze it is not named. Projects frozen before the generator was recorded carry no such field, and are verified without one.')
  integ.paragraph(runtimeRows.length
    ? 'Every runtime file below is pinned by digest in the frozen project. These digests identify the runtime the project was frozen with, which is not the same thing as the generator that rendered this file; the generator is named above. The standalone verify command checks the pinned files against them.'
    : 'This project pins no runtime source digests.')
  if (runtimeRows.length) integ.table('runtime-file-digests', ['Runtime file', 'SHA-256'], runtimeRows)
  // The runtime the running build actually has, against what the frozen project pins. The caller
  // supplies the running digests: the exported CLI hashes its own files. Absent means unchecked,
  // and an unchecked runtime is not reported as a matching one.
  if (runtimeIntegrity) {
    const pinned = Object.keys(runtimeSources).sort()
    const differing = pinned.filter(file => runtimeIntegrity[file] !== runtimeSources[file])
    integ.paragraph(differing.length
      ? 'Runtime integrity: the running build\'s runtime differs from the frozen project\'s pinned runtime in '
        + counted(differing.length, 'file') + ': '
        + differing.map(file => file + ' ' + runtimeSources[file] + ' -> ' + (runtimeIntegrity[file] || 'absent')).join('; ')
        + '. The digests printed above are the frozen project\'s; the exported CLI reproduces this report with the pinned bytes.'
      : 'Runtime integrity: the running build\'s runtime matches the frozen project\'s pinned runtime ('
        + counted(pinned.length, 'file') + ').')
  }
  // The export manifest, when one is supplied: the CLI passes the manifest.json beside
  // the project, the Research page the manifest of the export it would write.
  integ.heading('Export manifest', 3)
  const manifestDocument = (() => { try { return manifest === null ? null : JSON.parse(manifest) } catch { return undefined } })()
  const manifestFiles = manifestDocument?.format === 'research-benchmark-files' && manifestDocument.version === 1 && manifestDocument.files
    && typeof manifestDocument.files === 'object' && !Array.isArray(manifestDocument.files) ? manifestDocument.files : null
  if (manifest === null) integ.paragraph('No export manifest was supplied with this rendering, so no manifest digest summary is shown. node cli.mjs analyze supplies the manifest.json beside the exported project; the Research page supplies the manifest of the export it would write.')
  else if (!manifestFiles) integ.paragraph('The supplied manifest is not a research-benchmark-files version 1 manifest, so nothing from it is shown.')
  else if (manifestDocument.projectSha256 !== project.sha256) integ.paragraph('The supplied manifest belongs to project ' + manifestDocument.projectSha256 + ', not to this frozen project, so nothing from it is shown.')
  else {
    const runtimeFiles = Object.keys(runtimeSources).sort(), inputs = project.spec.inputs || []
    const runtimeAgree = runtimeFiles.filter(file => manifestFiles[file] === runtimeSources[file]), inputAgree = inputs.filter(input => manifestFiles[input.path] === input.sha256)
    const disagreeing = [...runtimeFiles.filter(file => !runtimeAgree.includes(file)), ...inputs.filter(input => !inputAgree.includes(input)).map(input => input.path)]
    const pinned = new Set([...runtimeFiles, ...inputs.map(input => input.path)])
    integ.table('manifest-summary', ['Field', 'Value'], [
      ['Manifest SHA-256', manifestSha256],
      ['Project SHA-256 it binds', manifestDocument.projectSha256],
      ['Files bound', Object.keys(manifestFiles).length],
      ['Runtime file digests that agree with the frozen project', runtimeAgree.length + ' of ' + runtimeFiles.length],
      ['Pinned input digests that agree with the frozen project', inputAgree.length + ' of ' + inputs.length],
      ['Other bound files, generated from the frozen project', Object.keys(manifestFiles).filter(file => !pinned.has(file)).length],
      ['Complete manifest', 'paper/manifest.json'],
    ])
    integ.paragraph(disagreeing.length ? 'The manifest disagrees with the frozen project: ' + disagreeing.join('; ') + '. Those files do not match what the project pins.'
      : 'Every runtime and pinned input digest in the manifest agrees with the frozen project. The other bound files are generated from it; this report does not regenerate them to compare their bytes.')
    files['paper/manifest.json'] = manifest
  }
  integ.table('reproduction-commands', ['Step', 'Command'], [
    ['Check the frozen project against its digests', 'node cli.mjs verify'],
    ['Rerun the pre-collection qualification', 'node cli.mjs qualify'],
    ['Collect or resume the study', 'node cli.mjs run'],
    ['Derive this report from the retained journal', 'node cli.mjs analyze'],
    ['Recheck native grades against the engine', 'node cli.mjs verify-native'],
  ])
  if (archiveIntegrity) integ.paragraph('Verified by archive integrity only: ' + archiveIntegrity.files
    + ' files each matched the digest recorded for it in the archive manifest, and the frozen project matches its own recorded digest. The frozen project was NOT rebuilt and compared here, because the runtime reading this archive is not the runtime that froze it'
    + (archiveIntegrity.runtimeDiffering.length ? ' and differs at ' + archiveIntegrity.runtimeDiffering.join(', ') : '')
    + '; rebuilding it here changes ' + archiveIntegrity.rebuildDiffering.join(', ')
    + '. Current-build collection admission was not re-derived for the same reason; the attempt journal is still bound to this exact project by its readiness digest and execution purpose, which is checked as always. This report was rendered by this build\'s generator, not the generator pinned in the archive, so its bytes are not comparable with a report the pinned generator produced. Independently verified here: the qualification journal, the resource journal, and the attempt journal against the frozen schedule. Every table here derives from that journal. Declared but not verified here: the provider identity behind any collected response, durations an adapter reported about itself, and any external asset acquired outside this project.')
  else integ.paragraph('Independently verified while producing this report: the frozen project against its own digest, the qualification journal, the resource journal, and the attempt journal against the frozen schedule. Every table here derives from that journal. Declared but not verified here: the provider identity behind any collected response, durations an adapter reported about itself, and any external asset acquired outside this project.')
  integ.paragraph('Evidence class: ' + execution.evidenceClass + '. ' + (PURPOSE_BANNER[execution.purpose] || ''))

  // 10b. The native verification receipt. `node cli.mjs verify-native` writes
  // results/native-verification.json; boundReceipts admitted it only because it
  // names this project and hashes exactly this journal. Each row says whether
  // this report verified the claim itself or only repeats what the receipt
  // declares; no retained artifact byte is re-read here.
  integ.heading('Native verification receipt', 3)
  if (nativeVerification === null) {
    integ.paragraph(NOT_DECLARED + '. No native verification receipt (results/native-verification.json, written by node cli.mjs verify-native) was supplied with this journal, so the retained native artifacts behind any lean-python grade are attested here by the journal alone.')
  } else {
    const completions = events.filter(event => event.type === 'finished' && event.status === 'completed')
    const attempts = nativeVerification.attempts
    const covered = attempts.filter(row => completions.some(event => event.trialId === row.trialId && event.attempt === row.attempt)).length
    const rows = [
      ['Receipt names this frozen project', 'Verified here', 'projectSha256 ' + nativeVerification.projectSha256],
      ['Receipt hashes exactly this attempt journal', 'Verified here', 'journalSha256 ' + nativeVerification.journalSha256],
      ['Retained file digests', 'Declared by the receipt', 'filesSha256 ' + (nativeVerification.filesSha256 ?? NOT_DECLARED) + '; retained bytes were not re-read for this report'],
      ['Completed attempts covered', covered === completions.length && attempts.length === completions.length ? 'Verified here' : 'Partial', attempts.length + ' receipt ' + (attempts.length === 1 ? 'attempt' : 'attempts') + ' for ' + completions.length + ' completed ' + (completions.length === 1 ? 'attempt' : 'attempts') + ' in the journal'],
      ['Evidence status', 'Declared by the receipt', String(nativeVerification.evidenceStatus ?? NOT_DECLARED)],
    ]
    for (const row of attempts) {
      const event = completions.find(item => item.trialId === row.trialId && item.attempt === row.attempt), reconstructed = row.reconstructedGrade || {}
      const same = !!event && !!event.grade && reconstructed.classification === event.grade.classification && reconstructed.passed === event.grade.passed
      rows.push(['Attempt ' + row.trialId + '-' + row.attempt + ' reconstructed grade', !event ? 'Not in this journal' : same ? 'Verified here' : 'DISAGREES with the journal',
        'reconstructed ' + (reconstructed.classification ?? NOT_DECLARED) + (reconstructed.passed === undefined ? '' : ' (passed ' + reconstructed.passed + ')')
        + (event ? '; journal ' + (event.grade?.classification ?? NOT_DECLARED) + ' (passed ' + (event.grade?.passed ?? NOT_DECLARED) + ')' : '')
        + '; disposition ' + (row.disposition ?? NOT_DECLARED) + '; ' + (row.evidenceStatus ?? NOT_DECLARED) + '; candidate SHA-256 ' + (row.candidateSha256 ?? NOT_DECLARED)])
    }
    integ.paragraph('Receipt SHA-256 ' + nativeVerificationSha256 + ' (' + nativeVerification.format + ' version ' + nativeVerification.version + '), retained verbatim at paper/native-verification.json.')
    integ.table('native-verification', ['Claim', 'Status', 'Basis'], rows)
    if (Array.isArray(nativeVerification.limitations) && nativeVerification.limitations.length) { integ.paragraph('Limitations declared by the receipt, verbatim:'); integ.list(nativeVerification.limitations.map(String)) }
    integ.paragraph('Receipt scope, verbatim: ' + (typeof nativeVerification.scope === 'string' ? nativeVerification.scope : NOT_DECLARED))
    files['paper/native-verification.json'] = JSON.stringify(JSON.parse(canonical(nativeVerification)), null, 2) + '\n'
  }
  if (notices.length) {
    integ.paragraph('Notices supplied by whoever rendered this report. They are not part of the frozen project or the attempt journal, and nothing in them was verified here.')
    integ.list(notices)
  }

  // 11. Limitations and threats to validity.
  lim.heading('Limitations and threats to validity')
  const unreviewed = new Set()
  for (const task of project.tasks) for (const bundle of task.compiled.bundles || []) if (!bundle.approved) unreviewed.add(bundle.id)
  lim.paragraph('These threats apply to this report in addition to the frozen limitations listed under Scope above; they are not repeated from that list.')
  lim.list([
    'Evidence class ' + execution.evidenceClass + ': this report establishes no more than that class permits.',
    protocol.replicates > 1 ? 'The replicate-dispersion table measures repeated runs of this one frozen schedule; it does not measure the variance of re-freezing the study or of other task samples.'
      : 'These are the trials this journal retains. One run does not measure run-to-run variance.',
    'Provider responses are not guaranteed deterministic; the same prompt may return different text on another day.',
    'The task sample is fixed by the frozen project. Intervals resample declared clusters and correct nothing about how the tasks were selected or how many there are; another task sample can rank conditions differently. ' + refTo('dehghani-2021'),
    ...(plan?.uncertainty ? ['Percentile bootstrap intervals are first-order accurate and can under-cover with few clusters or a skewed statistic; the cluster count, the per-interval level and the endpoint positions are printed beside every interval, and a degenerate interval is named as one. ' + refTo('diciccio-efron-1996', 'cameron-2008')] : []),
    'Grades measure the declared criterion on the frozen inputs. Whether that criterion captures the ability the study names is a claim of the investigator, not of the template.',
    'Whether any task text was present in a provider\u2019s training data is not observable here; the contamination paragraph under Statistical methods lists what is recorded.',
    ...nativeAdmissionLimitation(project.spec),
    unreviewed.size ? 'Catalog bundles used by these tasks are unreviewed: ' + [...unreviewed].sort().join(', ') + '. Their wording has not been acknowledged by a person.'
      : 'Every catalog bundle used by these tasks carries a review record.'])

  // 12. Reproducibility checklist.
  check.heading('Reproducibility checklist')
  check.paragraph('The rows follow the reproducibility checklist practice of the NeurIPS reproducibility program; each answer is read from frozen fields, never from the outcome. ' + refTo('pineau-2021'))
  const inputs = project.spec.inputs || []
  const licensed = inputs.filter(input => input.license)
  const externalAssets = inputs.length > 0 || Boolean(project.spec.environment?.leanImage)
  check.table('reproducibility-checklist', ['Item', 'Answer', 'Field that answers it'], [
    ['Code available', 'Yes', 'The runnable project carries cli.mjs and every runtime file, pinned in spec.runtimeSources'],
    ['Data and inputs pinned by hash', inputs.length ? 'Yes' : 'Not applicable',
      inputs.length ? 'spec.inputs digests, ' + counted(inputs.length, 'declared input') : 'spec.inputs is empty: this study declares no external input file'],
    ['Seeds declared', protocol.seed === undefined || protocol.seed === null ? 'No' : 'Yes',
      'spec.protocol.seed = ' + (protocol.seed ?? NOT_DECLARED) + (plan?.uncertainty ? '; analysisPlan.uncertainty.seed = ' + plan.uncertainty.seed : '')],
    ['Compute and environment declared', project.spec.environment ? 'Yes' : 'No',
      project.spec.environment ? canonical({ node: project.spec.environment.node ?? null, python: project.spec.environment.python ?? null, leanImage: project.spec.environment.leanImage || null }) : 'spec.environment is absent'],
    ['Error bars or intervals declared', plan?.uncertainty ? 'Yes' : 'No',
      plan?.uncertainty ? 'analysisPlan.uncertainty.kind = ' + plan.uncertainty.kind : 'analysisPlan.uncertainty is null; only descriptive counts are reported'],
    ['Licenses of external assets', externalAssets ? (inputs.length && licensed.length === inputs.length ? 'Yes' : 'No') : 'Not applicable',
      externalAssets ? (licensed.length ? licensed.length + ' of ' + inputs.length + ' inputs declare a license' : 'No license field is declared on the external assets this study uses') : 'This study uses no external asset'],
    ['Credentials never in the artifact', 'Yes', 'Adapters name a credential environment variable only; no value enters the project, the journal or this report'],
    ['Analysis plan fixed before collection', plan ? 'Yes' : 'No', plan ? 'analysisPlan is inside the frozen project ' + project.sha256 : 'analysisPlan is absent; nothing was pre-registered'],
    ['Repeated trials for dispersion', protocol.replicates > 1 ? 'Yes' : 'No', 'spec.protocol.replicates = ' + protocol.replicates],
    ['Statistical methods referenced', 'Yes', 'Statistical methods table and References section; every citation comes from the method-reference registry'],
    ['Template version cited', 'Yes', TEMPLATE.id + ' ' + TEMPLATE.version + ' generated by ' + TEMPLATE.generator.name + ' ' + TEMPLATE.generator.version + (citation.identity ? ', runtime identity sha256:' + citation.identity : ', no runtime identity (unpinned runtime)') + '; CITATION.cff and CITATION.bib under paper/'],
  ])

  // 13. Attribution and reused code. Every value is copied from the supplied
  // registry; no citation, licence or revision is composed here. Four classes
  // stay apart: copied or adapted code (the only class that carries authors,
  // source, revision, notices and adaptations), an API the generated code
  // calls, code newly generated here, and references that were reviewed or
  // followed but contribute no code. A class is read from the registry and is
  // never upgraded; an unrecognised classification is shown as unrecognised.
  cite.heading('Attribution and reused code')
  const entries = provenance?.format === 'research-benchmark-provenance' && provenance.version === 1 && Array.isArray(provenance.entries) ? provenance.entries : null
  const reusedCount = (entries || []).filter(entry => attributionClass(entry) === 'reuse').length
  const plural = (count, one, many) => count + ' ' + (count === 1 ? one : many)
  if (!provenance) cite.paragraph('Not declared. No provenance registry (provenance.json) was supplied with this project, so this report states nothing about reused, adapted or upstream code.')
  else if (!entries) cite.paragraph('A provenance document was supplied but it is not a research-benchmark-provenance version 1 registry, so nothing from it is shown. Inspect it directly.')
  else {
    const classed = { reuse: [], api: [], generated: [], reference: [], unrecognised: [] }
    for (const entry of entries) classed[attributionClass(entry)].push(entry)
    const references = [...entries.flatMap(entry => (entry.references || []).map(reference => ({ entry, reference }))), ...classed.reference.map(entry => ({ entry, reference: null }))]
    cite.paragraph('Registry SHA-256 ' + provenanceSha256 + ', ' + plural(entries.length, 'entry', 'entries') + ': ' + reusedCount + ' reused or adapted, '
      + plural(classed.api.length, 'API dependency', 'API dependencies') + ', ' + classed.generated.length + ' newly generated, '
      + plural(references.length, 'consulted reference', 'consulted references') + (classed.unrecognised.length ? ', ' + classed.unrecognised.length + ' unrecognised' : '') + '.')
    if (provenance.scope) {
      if (reusedCount && BLANKET_NO_REUSE.test(provenance.scope)) cite.paragraph('The registry scope sentence claims that no third-party code is reused, but the registry lists ' + plural(reusedCount, 'reused or adapted entry', 'reused or adapted entries') + '. The entries below are authoritative; the scope sentence is not repeated.')
      else cite.paragraph(provenance.scope)
    }
    if (!reusedCount && !classed.unrecognised.length) cite.paragraph('The registry records no reused or adapted code: each entry is newly generated here, written against an API, or a reference that contributes no code.')

    cite.heading('Reused or adapted code', 3)
    if (!reusedCount) cite.paragraph('None recorded.')
    for (const entry of classed.reuse) {
      const code = entry.codeProvenance, upstream = entry.upstream || {}, revision = upstream.revision
      cite.heading(entry.title || entry.id, 4)
      cite.table('attribution-' + entry.id, ['Field', 'Value'], [
        ['Classification', code.kind],
        ['Applies to', (entry.appliesTo || []).join('; ') || NOT_DECLARED],
        ['What was ' + code.kind, code.statement || NOT_DECLARED],
        ['Original authors', upstream.authors || NOT_DECLARED],
        ['Upstream project', upstream.project || NOT_DECLARED],
        ['Source', [upstream.repositoryUrl, upstream.filePath].filter(Boolean).join(' ') || NOT_DECLARED],
        ['Licence', upstream.license || NOT_DECLARED],
        ['Retained notice', upstream.licenseNote || NOT_DECLARED],
        ['Revision', revision ? [revision.kind, revision.value].filter(Boolean).join(' ') || NOT_DECLARED : NOT_DECLARED],
        ['Revision labels and note', [revision?.labels ? canonical(revision.labels) : '', revision?.note || ''].filter(Boolean).join(' ')],
        ['Upstream SHA-256', code.upstreamSha256 || NOT_DECLARED],
        ['Fetched', code.fetchedAt || NOT_DECLARED],
      ])
      if (code.kind === 'adapted') cite.list((code.adaptations || []).length ? code.adaptations.map(line => 'Adaptation: ' + line) : ['Adaptations: ' + NOT_DECLARED])
    }

    cite.heading('API dependencies', 3)
    cite.paragraph(classed.api.length ? 'The generated code calls these APIs. It copies no code from them, so authors, retained notices and source revisions are not attribution for these entries and are not shown.' : 'None recorded.')
    for (const entry of classed.api) {
      const upstream = entry.upstream, revision = upstream?.revision
      cite.heading(entry.title || entry.id, 4)
      cite.table('attribution-' + entry.id, ['Field', 'Value'], [
        ['Classification', 'API dependency (generated code written against it)'],
        ['Applies to', (entry.appliesTo || []).join('; ') || NOT_DECLARED],
        ['Statement', entry.codeProvenance.statement || NOT_DECLARED],
        ['API provider', upstream?.project || NOT_DECLARED],
        ['API reference', upstream?.repositoryUrl || NOT_DECLARED],
        ['Runs against (pinned runtime, not a copied-source revision)', revision ? [revision.kind, revision.value].filter(Boolean).join(' ') + (revision.note ? '. ' + revision.note : '') : NOT_DECLARED],
      ])
    }

    cite.heading('Newly generated code', 3)
    if (!classed.generated.length) cite.paragraph('None recorded.')
    else cite.table('attribution-generated', ['Entry', 'Applies to', 'Basis', 'Statement'],
      classed.generated.map(entry => [entry.title || entry.id, (entry.appliesTo || []).join('; '), entry.codeProvenance.basis || NOT_DECLARED, entry.codeProvenance.statement || NOT_DECLARED]))

    cite.heading('References consulted (contribute no code)', 3)
    cite.paragraph(references.length ? 'Specifications, papers and upstream files that were reviewed or followed. None of them contributed code, so none carries authors, notices or a copied-source digest here.' : 'None recorded.')
    const revisionText = revision => typeof revision === 'string' ? revision : [revision?.kind, revision?.value].filter(Boolean).join(' ')
    for (const { entry, reference } of references) {
      if (reference) cite.paragraph('Reference (' + (reference.kind || NOT_DECLARED) + ', contributes no code) for ' + (entry.title || entry.id) + ': ' + (reference.citation || reference.title || NOT_DECLARED)
        + (reference.url ? ' <' + reference.url + '>' : '') + (reference.revision ? '; reviewed at ' + revisionText(reference.revision) : '')
        + (reference.license ? '; licence as recorded: ' + reference.license : '') + (reference.note ? (/[.!?]$/.test(reference.citation || reference.title || '') && !reference.url && !reference.revision && !reference.license ? ' ' : '. ') + reference.note : ''))
      else {
        const upstream = entry.upstream
        cite.paragraph('Reference (' + entry.codeProvenance.kind + ', contributes no code): ' + (entry.title || entry.id) + '. ' + (entry.codeProvenance.statement || '')
          + (upstream?.repositoryUrl ? ' <' + [upstream.repositoryUrl, upstream.filePath].filter(Boolean).join(' ') + '>' : '')
          + (upstream?.revision ? '; reviewed at ' + revisionText(upstream.revision) : '') + (upstream?.license ? '; licence as recorded: ' + upstream.license : ''))
      }
    }

    if (classed.unrecognised.length) {
      cite.heading('Unrecognised classifications', 3)
      cite.paragraph('These entries carry a classification this report does not recognise. They are listed by name only and are not treated as reused, adapted or generated code.')
      cite.list(classed.unrecognised.map(entry => (entry.title || entry.id || NOT_DECLARED) + ': codeProvenance.kind ' + canonical(entry.codeProvenance?.kind ?? null)))
    }
    files['paper/provenance.json'] = JSON.stringify(provenance, null, 2) + '\n'
  }
  if (attributions !== null) {
    files['paper/ATTRIBUTIONS.md'] = attributions
    const missing = (entries || []).map(entry => entry.title).filter(title => title && !attributions.includes(title))
    cite.paragraph('ATTRIBUTIONS.md supplied with the project is retained verbatim at paper/ATTRIBUTIONS.md (SHA-256 ' + attributionsSha256 + '). Citations above come from the registry, not from this file.'
      + (!entries ? '' : missing.length ? ' It does not name ' + plural(missing.length, 'registry entry', 'registry entries') + ': ' + missing.join('; ') + '.' : ' It names every registry entry.'))
    if (reusedCount && BLANKET_NO_REUSE.test(attributions)) cite.paragraph('ATTRIBUTIONS.md claims that no third-party code is reused, but the registry lists ' + plural(reusedCount, 'reused or adapted entry', 'reused or adapted entries') + '. The registry contradicts that claim.')
  }

  // 14. Cite this study and its template. Every value comes from the frozen
  // project and the template constants; the same bytes are CITATION.cff and
  // CITATION.bib in the runnable export.
  credit.heading('Cite this study and its template')
  credit.paragraph('The citable artifact is the generic template that produced this study, ' + TEMPLATE.title + ' version ' + TEMPLATE.version + ', identified together with the exact runtime bytes that froze this project' + (citation.identity ? ' (template runtime identity sha256:' + citation.identity + ')' : ' (this project pins no runtime sources, so no runtime identity is claimed)') + '. The study itself is cited by its frozen project digest. Both records are written as CITATION.cff and CITATION.bib in every export and under paper/ here. ' + refTo('smith-2016', 'druskat-2021'))
  credit.table('citation-record', ['Field', 'Value'], [
    ['Template', TEMPLATE.title],
    ['Template version', TEMPLATE.version],
    ['Template identifier', TEMPLATE.id],
    ['Template runtime identity', citation.identity ? 'sha256:' + citation.identity : NOT_DECLARED],
    ['Template specification', TEMPLATE.specification],
    ['Template publisher', TEMPLATE.publisher],
    ['Template author', TEMPLATE.author],
    ['Template licence', TEMPLATE.license + ', covering ' + TEMPLATE.licenseCovers],
    // No DOI is registered. This row says so and gives the citation form, rather than
    // reading "Not declared", which a reviewer could mistake for an oversight.
    ['Template DOI', 'None registered; cite ' + TEMPLATE.citeAs],
    ['Generator', TEMPLATE.generator.name + ' ' + TEMPLATE.generator.version],
    ['Pinned runtime files changed in template ' + TEMPLATE.version, TEMPLATE.changes.pinnedFiles.join(', ')],
    ['Study title', citation.title],
    ['Study authors', citation.authors.map(person => person.name + (person.affiliation ? ' (' + person.affiliation + ')' : '') + (person.orcid ? ', ORCID ' + person.orcid : '')).join('; ')],
    ['Study identifier', 'sha256:' + project.sha256],
    ['Declared DOI', project.spec.citation?.doi || NOT_DECLARED],
    ['Declared URL', project.spec.citation?.url || NOT_DECLARED],
  ])
  credit.paragraph('Template change record. Version ' + TEMPLATE.version + ' of the template changed these pinned runtime files: ' + TEMPLATE.changes.pinnedFiles.join(', ') + '. ' + TEMPLATE.changes.summary + ' A project frozen with an earlier runtime pins different digests for exactly these files and keeps that runtime; the integrity section above lists the digests this project pinned.')
  // The template's own author, licence and citation form, in the same words the citation
  // files carry. The rows above are the TEMPLATE's record; the Study rows are the study's
  // own declared citation, and a study that declares none keeps saying so.
  credit.paragraph(citation.credit + ' Those are the template\u2019s values, not the study\u2019s: the Study rows above carry whatever the frozen project declared in its own citation fields, and stay Not declared when it declared none.')
  credit.verbatim('CITATION.cff', citation.cff, 'paper/CITATION.cff')
  credit.verbatim('CITATION.bib', citation.bibtex, 'paper/CITATION.bib')
  files['paper/CITATION.cff'] = citation.cff
  files['paper/CITATION.bib'] = citation.bibtex

  // 15. References: exactly the registry entries cited above, in first-use order.
  biblio.heading('References')
  biblio.paragraph('Every reference below was cited in this report by its registry key. The method-reference registry in study.mjs is the only source of citation text, and each entry states whether its identifier was re-resolved online when it was recorded. Entries are listed in order of first citation.')
  biblio.list(cited.map(id => { const entry = methodReference(id); return '[' + refLabel(entry) + '] ' + referenceText(entry) + (entry.doi && entry.url ? ' ' + entry.url : '') + ' Verification: ' + entry.verification }))
  if (pricing) {
    biblio.heading('Price table sources')
    biblio.paragraph('The estimated API costs in this report were priced at list prices frozen on ' + pricing.table.frozenAsOf + ', price table identity sha256:' + pricing.identity + '. Each row names the provider, the official page the rate was read from, the date it was read, and the line it was read from, so a reader can check any rate against its source. ' + (pricing.table.note || ''))
    biblio.table('price-table-sources', ['Billing model', 'Provider', 'Service tier', 'Official pricing page', 'Retrieved', 'Quoted line'],
      pricing.table.models.map(model => [model.billingModelId, model.provider, model.serviceTier, model.source.url, model.source.retrievedAt, model.source.quote]))
    if (Array.isArray(pricing.table.excludes) && pricing.table.excludes.length) biblio.list(pricing.table.excludes)
  }
  files['paper/references.json'] = JSON.stringify(cited.map(id => methodReference(id)), null, 2) + '\n'

  return { front, middle, integrity, limits, checklist, attribution, citation: citationRecord, references, files,
    page: { method: front.blocks.slice(methodFrom, methodTo), run: middle.blocks.slice(runFrom, runTo) } }
}

function dispositionFigure(summary) {
  const width = 960, rowHeight = 68, height = 118 + summary.groups.length * rowHeight
  const categories = [[summary.criterion.label, '#11694d'], ['Completed other', '#b14733'], ...(summary.audit ? [['Unscored reference', '#b38938']] : []), ['Unmeasured', '#65758b']]
  const bars = summary.groups.map((group, index) => {
    const values = [group.passed, group.eligibleCompleted - group.passed, ...(summary.audit ? [group.unscored] : []), group.scheduled - group.measured]
    let offset = 240
    const y = 62 + index * rowHeight, label = group.condition.length > 23 ? group.condition.slice(0, 22) + '…' : group.condition
    return '<text x="12" y="' + (y + 22) + '"><title>' + html(group.condition) + '</title>' + html(label) + '</text>' + values.map((value, i) => {
      const w = group.scheduled ? value / group.scheduled * 580 : 0, x = offset; offset += w
      return w ? '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="32" fill="' + categories[i][1] + '"><title>' + html(group.condition) + ': ' + html(categories[i][0]) + ', ' + value + ' of ' + group.scheduled + ' scheduled trials</title></rect>' : ''
    }).join('') + '<text x="834" y="' + (y + 22) + '">n = ' + group.scheduled + '</text>'
  }).join('')
  return '<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title desc" viewBox="0 0 ' + width + ' ' + height + '"><title id="title">Disposition of scheduled trials: ' + html(summary.execution.purpose) + '</title><desc id="desc">' + html(summary.execution.computationScope) + ' Every scheduled trial is included. Responses meeting the frozen criterion, other completed responses and unmeasured trials are separate. Detailed dispositions appear in the report table.</desc><rect width="100%" height="100%" fill="white"/><g font-family="system-ui, sans-serif" font-size="15" fill="#233247">' + categories.map(([name, color], i) => '<rect x="' + (12 + i * (summary.audit ? 235 : 300)) + '" y="12" width="16" height="16" fill="' + color + '"/><text x="' + (36 + i * (summary.audit ? 235 : 300)) + '" y="26">' + html(name) + '</text>').join('') + bars + '<text x="12" y="' + (height - 12) + '" font-size="12">' + html(summary.execution.computationScope) + '</text></g></svg>\n'
}

// Receipts that travel beside the journal. `node cli.mjs qualify` writes
// results/qualification.json and `node cli.mjs verify-native` writes
// results/native-verification.json; the Research page receives both inside an
// imported evidence file. Neither is trusted by name: a qualification receipt
// is admitted only when it names this frozen project and pins the same runtime
// digests; a native verification receipt only when it names this project and
// hashes exactly this attempt journal. An admitted receipt is identified by the
// SHA-256 of its canonical bytes, which the page and the CLI therefore print
// identically. One that does not bind is refused here, never rendered as
// "Not declared" and never repaired.
const receiptObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
export async function boundReceipts(project, events, { qualification = null, nativeVerification = null } = {}) {
  const bound = { qualification: null, qualificationSha256: null, nativeVerification: null, nativeVerificationSha256: null }
  if (qualification !== null) {
    invariant(receiptObject(qualification) && qualification.format === 'research-benchmark-qualification' && qualification.version === 1, 'The qualification receipt is not a version 1 research-benchmark-qualification record.')
    invariant(qualification.projectSha256 === project.sha256, 'The qualification receipt belongs to a different frozen project.')
    invariant(canonical(qualification.runtimeSources ?? null) === canonical(project.spec?.runtimeSources ?? null), 'The qualification receipt pins a different runtime than this frozen project.')
    bound.qualification = structuredClone(qualification); bound.qualificationSha256 = await sha256(canonical(bound.qualification))
  }
  if (nativeVerification !== null) {
    invariant(receiptObject(nativeVerification) && nativeVerification.format === 'benchmark-native-journal-verification' && nativeVerification.version === 1, 'The native verification receipt is not a version 1 benchmark-native-journal-verification record.')
    invariant(nativeVerification.projectSha256 === project.sha256, 'The native verification receipt belongs to a different frozen project.')
    invariant(Array.isArray(nativeVerification.attempts), 'The native verification receipt lists no attempts.')
    invariant(nativeVerification.journalSha256 === await sha256(canonical(events)), 'The native verification receipt was computed over a different attempt journal than the one rendered here.')
    bound.nativeVerification = structuredClone(nativeVerification); bound.nativeVerificationSha256 = await sha256(canonical(bound.nativeVerification))
  }
  return bound
}

async function buildReportPackage(project, events, { provenance = null, attributions = null, manifest = null, notices = [], qualification = null, nativeVerification = null, archiveIntegrity = null, runtimeIntegrity = null } = {}) {
  // Capture before the first asynchronous check. Report entry points must not
  // accept a caller-edited answer key under an unchanged frozen project hash.
  project = structuredClone(project); events = structuredClone(events); provenance = provenance === null ? null : structuredClone(provenance)
  invariant(Array.isArray(notices) && notices.every(value => typeof value === 'string'), 'Report notices must be a list of sentences.')
  invariant(attributions === null || typeof attributions === 'string', 'ATTRIBUTIONS.md must be supplied as text.')
  invariant(manifest === null || typeof manifest === 'string', 'The export manifest must be supplied as text.')
  // A project frozen by this build is rebuilt and compared, as always. One opened
  // from an archive another build froze cannot be: any change to compiled
  // readiness output re-identifies every earlier frozen project, so the rebuild
  // would refuse every one of them. For that caller the archive's own integrity is
  // stated instead, the project must still match its own recorded digest so an
  // edited answer key is refused exactly as before, and the integrity section
  // below says plainly that no rebuild took place.
  if (archiveIntegrity === null) await verifyProject(project)
  else {
    invariant(typeof archiveIntegrity === 'object' && Number.isSafeInteger(archiveIntegrity.files) && archiveIntegrity.files > 0
      && Array.isArray(archiveIntegrity.rebuildDiffering) && archiveIntegrity.rebuildDiffering.length
      && archiveIntegrity.rebuildDiffering.every(value => typeof value === 'string')
      && Array.isArray(archiveIntegrity.runtimeDiffering) && archiveIntegrity.runtimeDiffering.every(value => typeof value === 'string'),
      'An archive integrity claim must name how many files it checked and which compiled fields this build rebuilds differently.')
    const { sha256: recorded, ...body } = project
    invariant(await sha256(canonical(body)) === recorded, "The project's recorded SHA-256 does not match its own contents.")
  }
  await verifyQualificationJournal(project, events)
  await verifyResourceJournal(project, events)
  validateJournal(project, events, { openedArchive: archiveIntegrity !== null })
  const receipts = await boundReceipts(project, events, { qualification, nativeVerification })
  const artifact = await analysisArtifact(project, events), summary = artifact.summary, plan = summary.analysisPlan
  invariant(summary.scheduled === project.schedule.length, 'Report denominator differs from the frozen schedule.')
  const fixture = project.spec.conditions.every(condition => condition.adapter.kind === 'replay')
  const execution = summary.execution, development = execution.purpose === 'apparatus-development'
  const recordedLabel = summary.audit ? 'Recorded-verdict judge audit' : 'Recorded-response apparatus report'
  const label = development ? 'Apparatus-development report' : execution.purpose === 'recorded-diagnostic' ? 'Recorded-diagnostic report'
    : execution.purpose === 'legacy' ? 'Legacy: ' + (fixture ? recordedLabel : summary.audit ? 'judge audit evidence' : 'retained study evidence')
      : 'Experiment: ' + (fixture ? recordedLabel : summary.audit ? 'judge audit report' : 'study report')
  const notice = execution.scope + ' ' + execution.computationScope + (fixture ? ' Frozen collection conditions use saved responses; these records establish no new provider collection.' : '')
  const files = {}, sections = [], markdown = []
  const taskLabels = new Map(project.tasks.map((task, index) => [task.id, 'T' + (index + 1)]))
  const sourceLabels = new Map((project.spec.auditPlan?.reference.project.tasks || []).flatMap((task, index) => [[task.id, 'S' + (index + 1)], [canonical(task.id), 'S' + (index + 1)]]))
  const heading = title => { sections.push('<h2>' + html(title) + '</h2>'); markdown.push('## ' + md(title)) }
  const paragraph = value => { sections.push('<p>' + html(value) + '</p>'); markdown.push(md(value)) }
  const addTable = (id, headers, rows, { previewRows = rows, linkOnly = false } = {}) => {
    const scopeHeaders = ['Execution purpose', 'Evidence class', 'Experimental collection', 'Reference execution purposes']
    const scopeValues = [execution.purpose, execution.evidenceClass, execution.experimentalCollection, canonical(execution.referenceAncestry.map(source => source.purpose))]
    files['tables/' + id + '.csv'] = tableCsv([...headers, ...scopeHeaders], rows.map(row => [...row, ...scopeValues]))
    // The complete frozen table is exported; long reports retain a readable preview.
    const visible = previewRows.slice(0, 40).map(row => row.map((value, column) => headers[column] === 'Task' ? taskLabels.get(value) || value
      : headers[column] === 'Source task' || (headers[column] === 'Value' && row[0] === 'source_task') ? sourceLabels.get(value) || value : value))
    const note = tableNote(id)
    if (note) { sections.push('<p class="table-intro">' + html(note) + '</p>'); markdown.push(md(note)) }
    if (!linkOnly) { sections.push(table(headers, visible, id)); markdown.push(markdownTable(headers, visible)) }
    const caption = (!linkOnly && rows.length > visible.length ? 'Showing ' + visible.length + ' of ' + rows.length + ' rows. ' : '') + 'Full table: tables/' + id + '.csv.'
    sections.push('<p class="table-note"><a href="tables/' + id + '.csv">' + html(caption) + '</a></p>')
    markdown.push('[' + md(caption) + '](tables/' + id + '.csv)')
  }
  const provenanceSha256 = provenance === null ? null : await sha256(canonical(provenance)), attributionsSha256 = attributions === null ? null : await sha256(attributions), manifestSha256 = manifest === null ? null : await sha256(manifest)
  const citation = await templateCitation(project)
  // The frozen table and its identity are resolved here, where a digest can be awaited,
  // and handed to the sections so page and exported CLI render the same bytes.
  const priceTable = project.spec.pricing || null
  const pricing = priceTable ? { table: priceTable, identity: await priceTableIdentity(priceTable) } : null
  const paper = paperSections({ project, events, artifact, summary, execution, plan, taskLabels, provenance, provenanceSha256, attributions, attributionsSha256, manifest, manifestSha256, notices: [...notices], ...receipts, archiveIntegrity, runtimeIntegrity, citation, pricing },
    { html, md, table, markdownTable, counted, percent })
  Object.assign(files, paper.files)
  sections.push(...paper.front.sections); markdown.push(...paper.front.markdown)
  heading('Execution scope')
  addTable('execution-scope', ['Purpose', 'Evidence class', 'Experimental collection', 'Computation scope'], [[execution.purpose, execution.evidenceClass, execution.experimentalCollection, execution.computationScope]])
  if (execution.referenceAncestry.length) {
    paragraph('Reference source purposes remain attached to their original observations. Creating an audit or changing the later judge study does not qualify or promote its source evidence.')
    addTable('reference-execution-scope', ['Source project SHA-256', 'Source purpose', 'Source evidence class', 'Source computation scope'], execution.referenceAncestry.map(source => [source.projectSha256, source.purpose, source.evidenceClass, source.computationScope]))
  }
  heading('Protocol')
  paragraph('The frozen schedule contains ' + counted(project.tasks.length, 'task') + ', ' + counted(project.spec.conditions.length, 'condition') + ', and ' + counted(project.spec.protocol.replicates, 'replicate') + ' per cell. The runner retains the first completed attempt; completed responses are not redrawn based on their grade. The frozen maximum is ' + counted(project.spec.protocol.maxAttemptsPerTrial, 'attempt') + ' per trial and ' + counted(project.spec.protocol.maxTotalAttempts, 'attempt') + ' overall. Transport and apparatus failures retain separate dispositions.')
  paragraph(summary.criterion.label + ': ' + summary.criterion.definition + ' ' + (plan ? 'Primary denominator: ' + plan.primaryDenominator + (summary.audit ? ' reference-eligible' : '') + ' trials. Scheduled and completed denominators are both retained.' : 'A primary denominator was not declared. Both descriptive rates are shown; no primary result is inferred.'))
  if (project.spec.protocol.grading.kind === 'module') paragraph('Custom outcome verification: retained deterministic grade fields are checked against the original process output when present. The standalone CLI also reexecutes the pinned grader before accepting stored outcomes. Browser report generation checks retained evidence consistency; it does not run the Node grader or authenticate a claimed execution. Direct API grades without a process receipt retain that limitation.')
  if (summary.customGrading) {
    paragraph('Custom grade evidence: ' + summary.customGrading.withProcessReceipt + ' completed grades have retained process receipts; ' + summary.customGrading.withoutProcessReceipt + ' have no process receipt. Receipt-free results supply no original host output for consistency checking. Availability describes the retained journal, not an authenticated origin.')
    addTable('custom-grade-evidence', ['Trial', 'Attempt', 'Original process receipt'], summary.customGrading.rows.map(row => [row.trialId, row.attempt, row.processReceipt]))
  }
  if (summary.resourceEffects) {
    heading('Experiment template qualification')
    const qualifications = events.filter(event => event.type === 'template-qualified')
    paragraph(qualifications.length + ' full source-bound template qualification receipts are retained. Each resumed invocation reruns conformance; identical results reference the retained proof through compact receipts. Fixed hand-computed controls and generated selected-case reference plans must agree with the independent state verifier before new trials begin. A control may intentionally fail the experiment criterion while successfully testing the apparatus.')
    addTable('template-qualification', ['Journal sequence', 'Recorded at', 'Fixed controls', 'Selected cases', 'Receipt SHA-256'], qualifications.map(event => [event.seq, event.at, event.record.controls.length, event.record.cases.length, event.record.sha256]))
    const preparations = events.filter(event => ['template-qualified', 'template-requalified', 'template-preparation-failed'].includes(event.type))
    const preparation = summary.resourcePreparation
    paragraph('Preparation time is charged across invocations. At most ' + (project.schedule.length + 1) + ' preparations and ' + project.experimentTemplate.limits.evidenceBytes + ' canonical journal bytes are admitted; failed or interrupted preparation cannot authorize a call. Modern conformance records durable intent before executing, with a source-bound ' + preparation.limits.timeoutMs + ' ms cap shortened to the remaining study budget.')
    paragraph(preparation.scope)
    paragraph(preparation.preparations + ' preparations are retained; ' + preparation.open + ' remain open, ' + preparation.interrupted + ' have recovered reservation charges, and ' + preparation.legacy + ' are legacy terminal-only receipts. Preparation budget charges total ' + preparation.budgetChargeMs + ' ms, including the full reservation for each open intent. Measured elapsed duration is unavailable for ' + preparation.missingElapsed + ' preparations; no duration is inferred for those rows.')
    addTable('template-preparation', ['Journal sequence', 'Recorded at', 'Kind', 'Cumulative-budget charge ms', 'Proof SHA-256', 'Reason'], preparations.map(event => [event.seq, event.at, event.type, event.budgetChargeMs, event.record?.sha256 || event.recordSha256 || '', event.reason || '']))
    addTable('resource-preparation', ['Intent sequence', 'Terminal sequence', 'Recorded at', 'Status', 'Legacy receipt', 'Deadline ms', 'Reservation ms', 'Measured elapsed ms', 'Budget charge ms', 'Charge basis', 'Reason'], preparation.rows.map(row => [row.startSeq ?? 'Unavailable', row.terminalSeq ?? 'Unavailable', row.at, row.status, row.legacy,
      row.timeoutMs ?? 'Unavailable', row.reservedMs ?? 'Unavailable', row.elapsedMs ?? 'Unavailable', row.budgetChargeMs, row.chargeBasis, row.reason || '']))
    files['resource-preparation.json'] = JSON.stringify(JSON.parse(canonical(preparation)), null, 2) + '\n'
    for (const event of qualifications) files['template-qualification/' + event.seq + '/record.json'] = JSON.stringify(JSON.parse(canonical(event.record)), null, 2) + '\n'
    heading('Observed resource effects')
    paragraph(summary.resourceEffects.scope)
    paragraph('The platform generates the initial fixture, public request, goal criterion and reference controls from the template fields. Each action is applied by trusted code and observed independently. Resource capabilities and requested task changes are separate. These records establish reproducible retained-state consistency, not authenticated execution or containment of arbitrary code.')
    paragraph('Effect counts include transient changes even when repaired before the final state. Rejected intentions remain separate from committed effects. Missing complete measurements stay unavailable; the full journal retains any observed prefix. Only the declared binary criterion supplies primary rate contrasts; effect magnitudes below are descriptive.')
    addTable('resource-effects', ['Trial', 'Condition', 'Status', 'Primary included', 'Task success', 'Ever collateral resources', 'Final collateral resources', 'Peak collateral resources', 'Observed actions', 'Rejected actions', 'Rejected plans', 'Retained effect events', 'Closure recorded'], summary.resourceEffects.rows.map(row => [row.trialId, row.conditionId, row.status, row.primaryIncluded,
      row.effects?.taskSuccess ?? 'Unavailable', row.effects?.everCollateralCount ?? 'Unavailable', row.effects?.netCollateralCount ?? 'Unavailable', row.effects?.peakCollateralCount ?? 'Unavailable', row.effects?.observedActionCount ?? 'Unavailable', row.rejectedActions, row.rejectedPlans, row.retainedEffectEvents, row.closureRecorded]))
    const prefixes = summary.resourceEffects.rows.filter(row => row.observedPrefix)
    if (prefixes.length) addTable('resource-observed-prefixes', ['Trial', 'Status', 'Observed actions in prefix', 'Ever collateral in prefix', 'Peak collateral in prefix', 'Observation scope'], prefixes.map(row => [row.trialId, row.status, row.observedPrefix.observedActionCount, row.observedPrefix.everCollateralCount, row.observedPrefix.peakCollateralCount, 'Observed prefix only; later effects and completed endpoint remain unavailable']))
    files['resource-effects.json'] = JSON.stringify(JSON.parse(canonical(summary.resourceEffects)), null, 2) + '\n'
  }
  if (summary.primaryPopulation) {
    const population = summary.primaryPopulation
    paragraph('Primary population: ' + population.label + '. ' + population.taskIds.length + ' of ' + project.tasks.length + ' frozen tasks and ' + population.scheduled + ' of ' + summary.scheduled + ' scheduled trials are included. ' + population.excludedScheduled + ' scheduled trials remain outside the primary analysis and inside the full disposition and resource records.')
  }
  const clusterFactor = plan?.uncertainty?.kind === 'cluster-bootstrap' && plan.uncertainty.clusterBy !== 'familyId' ? plan.uncertainty.clusterBy.factor : null
  paragraph(plan?.uncertainty ? 'Planned rate contrasts use paired whole-' + (clusterFactor === null ? 'family' : 'cluster') + ' percentile bootstrap resampling (' + plan.uncertainty.iterations + ' resamples; seed ' + plan.uncertainty.seed + '; confidence ' + plan.uncertainty.confidence + '; multiplicity: ' + plan.multiplicity + '). ' + (clusterFactor === null ? 'Replicates and variants within a family stay together.' : 'Rows sharing a value of factor ' + clusterFactor + ' stay together.') + ' Unestimable intervals remain absent with an explanation.' : 'No uncertainty procedure was declared. Tables report descriptive counts and rates.')
  if (project.requirements?.selectedInput) {
    const policy = project.requirements.selectedInput, records = events.filter(event => event.type === 'qualification')
    heading('Selected-input qualification')
    paragraph('Frozen policy: ' + policy.policy + '; precollection qualification budget ' + policy.timeoutMs + ' ms. ' + policy.rationale)
    paragraph('Qualification checks the exact selected inputs and declared admissible readings. Separately tested probes cannot substitute for activation or wrong-reading discrimination on those inputs. Runtime appendices, native validation and personal approvals remain separate obligations. Retained interpreter agreement is reproducible evidence, not an authenticated third-party execution attestation.')
    if (summary.selectedInputPreparation) {
      const preparation = summary.selectedInputPreparation
      const milliseconds = value => value > 0 && value < 0.001 ? '<0.001' : Number(value.toFixed(3)).toString()
      const known = (value, missing) => preparation.preparations === missing ? 'Unavailable' : milliseconds(value) + ' ms' + (missing ? ' (partial)' : '')
      paragraph(preparation.preparations ? 'Selected-input preparation: ' + preparation.preparations + ' recorded; ' + preparation.qualified + ' accepted qualification proofs. Measured duration is available for ' + (preparation.preparations - preparation.missingElapsed) + ' of ' + preparation.preparations + ', known subtotal ' + known(preparation.knownElapsedMs, preparation.missingElapsed) + '. Budget charges are available for ' + (preparation.preparations - preparation.missingCharge) + ' of ' + preparation.preparations + ', known subtotal ' + known(preparation.knownBudgetChargeMs, preparation.missingCharge) + '.'
        : 'No selected-input preparation is recorded in this journal.')
      paragraph(preparation.scope + ' These values do not measure total study wall-clock time. At most ' + preparation.maxPreparations + ' preparations are admitted by the current runtime.')
      if (preparation.missingCharge) paragraph('The cumulative preparation budget is unavailable for legacy receipts without paired timing. Their accepted proofs and historical trial outcomes remain inspectable; no missing duration is inferred.')
      if (preparation.open || preparation.interrupted) paragraph('Open or interrupted preparation retains its reserved budget charge. Measured duration and interpreter termination remain unestablished; the reservation is not evidence of observed elapsed time.')
      const preparationRows = preparation.rows.map(row => [row.startSeq ?? 'Unavailable', row.terminalSeq ?? 'Unavailable', row.at, row.status,
        row.elapsedMs ?? 'Unavailable', row.elapsedMs === null ? row.status === 'legacy-qualified' ? 'Legacy unavailable' : 'Unavailable' : 'Measured', row.budgetChargeMs ?? 'Unavailable', row.chargeBasis,
        row.settled === null ? 'Unavailable' : row.settled ? 'Settled' : 'Not established', row.reason || ''])
      addTable('selected-input-preparation', ['Start sequence', 'Terminal sequence', 'Recorded at', 'Status', 'Measured preparation ms', 'Measurement availability', 'Budget charge ms', 'Charge basis', 'Qualifier settlement', 'Reason'], preparationRows,
        { previewRows: preparationRows.map(row => row.map((value, column) => [4, 6].includes(column) && typeof value === 'number' ? milliseconds(value) : value)) })
    }
    if (!records.length) paragraph('No successful precollection qualification record is present in this journal.')
    addTable('selected-input-gates', ['Journal sequence', 'Recorded at', 'Registered occurrences', 'All composition occurrences', 'Qualified / total', 'Unregistered composition', 'Unassessed runtime appendices'], records.map(event => {
      const selected = event.record.requirements.selectedInput
      return [event.seq, event.at, selected.registeredStatus, selected.compositionStatus, selected.qualifiedOccurrences + ' / ' + selected.compositionOccurrences, selected.unregistered.length, selected.apparatusRequirements.length]
    }))
    for (const event of records) {
      const prefix = 'qualification-receipts/' + event.seq + '/'
      for (const [file, bytes] of Object.entries(requirementReportFiles(event.record))) files[prefix + file] = bytes
      files[prefix + 'record.json'] = JSON.stringify(JSON.parse(canonical(event.record)), null, 2) + '\n'
      const href = prefix + 'qualification/report.html', label = 'Inspect qualification before collection (journal sequence ' + event.seq + ')'
      sections.push('<p><a href="' + href + '">' + html(label) + '</a></p>'); markdown.push('[' + md(label) + '](' + href + ')')
    }
  }
  if (plan) paragraph(plan.rationale)
  addTable('conditions', ['Condition', 'Provider', 'Declared model', 'Declared surface', 'Adapter', 'Settings'], project.spec.conditions.map(condition => [condition.id, condition.model?.provider || 'Undeclared', condition.model?.id || 'Undeclared', condition.model?.surface || 'Undeclared', condition.adapter.kind, canonical(condition.model?.settings || {})]))
  if (summary.workflows) {
    heading('Frozen prompt workflows')
    paragraph(summary.workflows.contract.execution + '. ' + summary.workflows.contract.selection + '. ' + summary.workflows.contract.failure + '.')
    paragraph('Each stage request, response, tool log and mapped identity is retained in workflows.json. Only declared ancestor output projections enter a child request. The trading Strategy/Template grammar remains a separate compiler contract.')
    addTable('workflow-design', ['Workflow', 'Purpose', 'Conditions', 'Entry', 'Stages', 'Budgets', 'Rationale'], project.spec.workflowPlan.workflows.map(workflow => [workflow.id, workflow.purpose, project.spec.conditions.filter(condition => condition.workflowId === workflow.id).map(condition => condition.id).join(', '), workflow.entry, workflow.stages.length, canonical(workflow.budgets), workflow.rationale]))
    addTable('workflow-stages', ['Trial', 'Attempt', 'Stage', 'Step', 'Status', 'Selected for grade', 'Host ms', 'Reason'], summary.workflows.stages.map(stage => [stage.trialId, stage.attempt, stage.stageId, stage.step, stage.status, stage.selectedForGrade, stage.elapsedMs, stage.reason]))
    addTable('workflow-stage-usage', ['Trial', 'Attempt', 'Stage', 'Metric', 'Status', 'Value'], summary.workflows.stages.flatMap(stage => Object.entries(stage.observations?.usage || {}).map(([metric, value]) => [stage.trialId, stage.attempt, stage.stageId, metric, value.status, value.value])), { linkOnly: true })
    addTable('workflow-stage-cost', ['Trial', 'Attempt', 'Stage', 'Status', 'Amount', 'Currency'], summary.workflows.stages.map(stage => [stage.trialId, stage.attempt, stage.stageId, stage.observations?.reportedCost.status || 'unavailable', stage.observations?.reportedCost.amount, stage.observations?.reportedCost.currency]), { linkOnly: true })
    paragraph('Trial resource totals include every started workflow stage. Missing stage metadata prevents a full total; per-attempt allocation estimates are charged once. Per-stage costs retain multiple currencies without conversion. Tool logs are adapter reports; the allowlist check does not authenticate hidden external work.')
  }
  paragraph('Task labels T1 onward follow the frozen task order. The task table maps each label to its full identifier, family, split, factors and composition measurements.')
  addTable('tasks', ['Label', 'Task identifier', 'Family', 'Split', 'Factors', 'Tree depth', 'Components'], project.tasks.map(task => [taskLabels.get(task.id), task.id, task.familyId || '', task.split, canonical(task.factors || {}), task.compiled.depth, task.compiled.nodeCount]), { linkOnly: true })
  if (summary.audit) {
    const audit = summary.audit.manifest, reference = project.spec.auditPlan.reference.project
    heading('Audit source and criterion')
    paragraph(audit.provenance.title + ' · declared version ' + audit.provenance.version + '. Origin: ' + audit.provenance.kind + '. Reference cohort: ' + (reference.spec.analysisPlan?.cohort || 'undeclared') + '. Source observations are retained separately from the later judge verdicts.')
    if (audit.provenance.acquisition) paragraph('Declared source acquisition: ' + audit.provenance.acquisition.method + ' from ' + audit.provenance.acquisition.location + ' at ' + audit.provenance.acquisition.at + '. The pinned bytes establish the imported snapshot; origin remains a declared provenance record.')
    paragraph('Comparison scope: ' + audit.criterion.kind + '. ' + audit.criterion.statement)
    paragraph(project.spec.auditPlan.rationale)
    paragraph(audit.selectedCases + ' unique candidate cases were selected from ' + audit.sourceTrials + ' source trials using ' + audit.selection.kind + ' selection (seed ' + audit.selection.seed + '). The complete source journal is retained, including unmeasured trials and collected responses that lacked a completed source grade. Duplicate candidates and sampling exclusions have explicit ledger entries. ' + audit.referenceEligibleCases + ' selected cases have reference verdicts fixed before judging.')
    paragraph('The judge receives ' + (audit.projection.prompt === 'original-prompt-file' ? 'the pinned original prompt' : 'the source compiled prompt') + ', the retained candidate and ' + (audit.projection.includeInput ? 'the frozen task input' : 'no separate task input') + '. Private reference grades, source condition identities, interpretations and audit labels are excluded from the request. The review packet retains original wording and semantic reconstruction separately.')
    paragraph('Source labels S1 onward follow the frozen source task order; their complete identities and prompt hashes are retained in the source task key.')
    addTable('audit-source-task-key', ['Label', 'Source task identifier', 'Family', 'Split', 'Prompt SHA-256'], reference.tasks.map(task => [sourceLabels.get(task.id), task.id, task.familyId || '', task.split, task.compiled.promptSha256]), { linkOnly: true })
    addTable('audit-cases', ['Task', 'Source task', 'Reference verdict', 'Basis', 'Source occurrences'], project.tasks.map(task => [task.id, task.audit.sourceTaskId, task.audit.referenceVerdict || 'Unresolved', task.audit.referenceBasis, task.audit.origins.length]))
    addTable('audit-source-trials', ['Source trial', 'Source task', 'Attempt', 'Status', 'Response retained', 'Disposition', 'Audit case', 'Reference verdict'], audit.ledger.map(row => [row.sourceTrialId, row.sourceTaskId, row.sourceAttempt, row.sourceStatus, row.responseRetained, row.disposition, row.auditTaskId || '', row.expectedVerdict || 'Unresolved']), { linkOnly: true })
  }
  if (summary.corpus) {
    const corpus = summary.corpus.manifest
    heading('Corpus construction')
    paragraph(corpus.selectedCount + ' of ' + corpus.candidateCount + ' constructed candidate assignments were retained by the frozen ' + corpus.selection.kind + ' selection policy (seed ' + project.spec.corpusPlan.seed + '; limit ' + corpus.selection.limit + '). Coverage status: ' + corpus.status + '. Oracle: ' + corpus.oracle.kind + '. Expected observations are apparatus predictions, not independent engine qualification.')
    paragraph(project.spec.corpusPlan.rationale)
    if (corpus.coverageDefinition) {
      paragraph(corpus.coverageDefinition.levelUniverse + ' ' + corpus.coverageDefinition.compositionScope + ' ' + corpus.coverageDefinition.selectionGuarantee)
      addTable('corpus-coverage-rules', ['Dimensions', 'Requested levels', 'Minimum', 'Cells', 'Unclassified candidates', 'Outside requested levels'], corpus.coverageDefinition.rules.map(row => [row.dimensions.join(' × '), canonical(row.levels), row.minimum, row.cells, row.unclassifiedCandidates, row.outsideDeclaredLevels]))
      if (corpus.coverageDefinition.features.length) addTable('corpus-features', ['Feature', 'Any of these node bundles', 'Classification rationale'], corpus.coverageDefinition.features.map(row => [row.id, row.bundles.join(', '), row.rationale]))
      addTable('corpus-cell-exclusions', ['Dimensions', 'Levels', 'Constructed assignments', 'Exclusions before selection'], corpus.coverage.map(row => [row.dimension, row.value, row.candidates, canonical(row.excluded)]), { linkOnly: true })
      addTable('corpus-compositions', ['Task', 'Depth', 'Nodes', 'Node bundles', 'Features'], corpus.candidates.filter(row => row.composition).map(row => [row.taskId, row.composition.depth, row.composition.nodes, row.composition.bundles.join(', '), canonical(row.composition.features)]), { linkOnly: true })
    }
    const dispositions = [...new Set(corpus.candidates.map(row => row.disposition))].sort()
    addTable('corpus-selection', ['Disposition', 'Candidates'], dispositions.map(value => [value, corpus.candidates.filter(row => row.disposition === value).length]))
    addTable('corpus-coverage', ['Dimension', 'Level', 'Minimum', 'Eligible', 'Selected'], corpus.coverage.map(row => [row.dimension, row.value, row.minimum, row.available, row.selected]))
    addTable('corpus-candidates', ['Task', 'Family', 'Choices', 'Disposition', 'Reasons'], corpus.candidates.map(row => [row.taskId, row.familyId, canonical(row.choices), row.disposition, canonical(row.reasons)]), { linkOnly: true })
  }
  if (summary.informationTasks.length) {
    heading('Information treatments')
    paragraph('Every retained reading agrees on the exact compiled task text. Reading pools retain the selection ledger, including candidates excluded because disclosed wording differs. Workflow stages can omit that text, add instructions and project earlier outputs. The compiler does not infer readings from those instructions. One frozen task-level reading set is used across all conditions; agreement within that set does not establish its adequacy for every disclosure context. The private baseline is retained for provenance; admissibility is graded against the complete frozen reading set. Observable classes merge readings with identical expected observations on the declared inputs.')
    const information = project.tasks.filter(task => task.informationPacket)
    if (information.some(task => task.informationPacket.version === 2)) {
      paragraph('Version-2 information packets bind the declared condition settings, workflow assignments and complete workflow plan, including visibility, instructions, parent projections and result selection. These are declarations, not evidence of provider adherence or future outputs. Actual dynamic workflow requests are retained in the stage journal. Inspect the full private packets in the runnable project’s information/ directory alongside its workflow plan and retained requests.')
      addTable('information-contexts', ['Task', 'Condition', 'Requested model', 'Workflow', 'Packet SHA-256'], information.flatMap(task => (task.informationPacket.collectionContext?.conditions || []).map(condition => [task.id, condition.id, condition.model?.id || 'Undeclared', condition.workflowId || 'Ordinary request', task.informationPacket.sha256])))
    }
    if (information.some(task => task.informationPacket.version === 1)) paragraph('Legacy version-1 information packets retain their original task bindings. They do not bind the full collection context, and their reviews are not collection-context approval.')
    addTable('information-design', ['Task', 'Family', 'Withheld requirements', 'Candidate readings', 'Admissible readings', 'Observable classes'], summary.informationTasks.map(task => [task.taskId, task.familyId, task.withheldPaths.length, task.candidateReadings, task.admissibleReadings, task.observableClasses]))
  }
  if (summary.primaryPopulation) {
    heading(development ? 'Primary development computations' : 'Primary analysis')
    paragraph(execution.computationScope)
    paragraph('Population: ' + summary.primaryPopulation.label + '. The frozen ' + plan.primaryDenominator + ' denominator governs the primary rate and every planned contrast. Selection uses frozen task identities and splits; observed outcomes cannot change inclusion.')
    addTable('primary-population', ['Task', 'Split', 'Included', 'Exclusion reason'], summary.primaryPopulation.ledger.map(row => [row.taskId, row.split, row.included, row.reason || '']))
    addTable('primary-rates', ['Condition', 'Primary scheduled', 'Primary completed', 'Primary ' + summary.criterion.label.toLowerCase(), development ? 'Development primary rate' : 'Primary rate', 'Excluded scheduled'], summary.groups.map(group => [group.condition, group.primary.scheduled, group.primary.measured, group.primary.passed, rateWithInterval(group.primaryEndpoint ? group.primaryPassRate : group.primaryRate, group.primaryRateInterval), group.primary.excludedScheduled]))
  }
  if (summary.endpoints) {
    const typed = summary.endpoints, declared = new Map(typed.declared.map(endpoint => [endpoint.id, endpoint])), primary = typed.declared.find(endpoint => endpoint.primary) || null
    const estimate = (endpoint, value) => value === null ? 'Unavailable' : ['binary', 'proportion'].includes(endpoint.kind) ? percent(value) : number(value)
    const span = row => row.interval ? number(row.interval.low) + ' to ' + number(row.interval.high) : row.intervalReason
    const columns = endpoint => ({
      binary: [['n', row => row.n], ['k', row => row.k], ['k / n', row => percent(row.rate)], ['k / scheduled', row => percent(row.scheduledRate)]],
      proportion: [['n', row => row.n], ['k', row => row.k], ['k / n', row => percent(row.rate)], ['k / scheduled', row => percent(row.scheduledRate)]],
      count: [['n', row => row.n], ['Total', row => row.total], ['Mean', row => number(row.mean)]],
      rate: [['n', row => row.n], ['Zero exposure', row => row.zeroExposure], ['Numerator', row => row.numerator], ['Exposure (' + endpoint.exposure?.unit + ')', row => number(row.exposure)], ['Rate', row => number(row.rate)]],
      duration: [['n', row => row.n], ['Mean', row => number(row.mean)], ['Median', row => number(row.median)], ['Min', row => number(row.min)], ['Max', row => number(row.max)]],
      'event-time': [['n', row => row.n], ['Observed', row => row.observed], ['Censored', row => row.censored], ['Cap ms', row => row.cap], ['Median observed', row => number(row.medianObserved)]],
    })[endpoint.kind]
    heading(development ? 'Typed endpoint development computations' : 'Typed endpoints')
    paragraph(execution.computationScope)
    paragraph('Typed endpoints read literal frozen paths in the retained attempt record over the primary population (' + summary.primaryPopulation.label + '). Binary estimates follow the frozen ' + typed.denominator + ' denominator. Proportion estimates are the observed share k / n over trials with an available boolean value; k / scheduled is shown beside them and never replaces the estimate. Count, rate, duration and event-time estimates use observed values only, with scheduled, unavailable and invalid counts retained. ' + (primary ? 'Primary endpoint: ' + primary.id + ' (' + primary.kind + ', ' + primary.direction + ') replaces the binary pass criterion as the primary summary; the passed-based primary rates above remain descriptive.' : 'No typed endpoint is primary; the binary pass criterion remains the primary summary.') + ' Unavailable and invalid values are counted, never imputed.')
    for (const endpoint of typed.declared) {
      paragraph(endpoint.id + ': ' + endpoint.kind + ' in ' + endpoint.unit + ', ' + endpoint.direction + (endpoint.primary ? ', primary' : '') + '. Source path ' + endpoint.source.path.join('.') + (endpoint.exposure ? '; exposure path ' + endpoint.exposure.path.join('.') + ' in ' + endpoint.exposure.unit : '') + (endpoint.cap !== undefined ? '; censored at ' + endpoint.cap + ' ms' : '') + '. ' + endpoint.rationale)
      const cells = columns(endpoint)
      addTable('endpoint-conditions-' + endpoint.id, ['Condition', 'Scheduled', 'Unavailable', 'Invalid', ...cells.map(([header]) => header), 'Estimate'], typed.groups.filter(row => row.endpoint === endpoint.id).map(row => [row.condition, row.scheduled, row.unavailable, row.invalid, ...cells.map(([, cell]) => cell(row)), estimate(endpoint, row.estimate)]))
      addTable('endpoint-strata-' + endpoint.id, ['Dimension', 'Level', 'Condition', 'Scheduled', 'Unavailable', 'Invalid', ...cells.map(([header]) => header), 'Estimate'], typed.strata.filter(row => row.endpoint === endpoint.id).map(row => [row.dimension, canonical(row.value), row.condition, row.scheduled, row.unavailable, row.invalid, ...cells.map(([, cell]) => cell(row)), estimate(endpoint, row.estimate)]))
    }
    if (typed.uncertainty) {
      paragraph('Endpoint intervals resample whole ' + (typed.uncertainty.clusterBy === 'familyId' ? 'task families' : 'clusters of factor ' + typed.uncertainty.clusterBy.factor) + ' with replacement (' + typed.uncertainty.iterations + ' resamples; seed ' + typed.uncertainty.seed + '; confidence ' + typed.uncertainty.confidence + '; multiplicity: ' + typed.uncertainty.multiplicity + '). Clusters are assumed independent. Contrast intervals keep each cluster together in both conditions. Unestimable intervals remain absent with an explanation.')
      addTable('endpoints-intervals', ['Endpoint', 'Target', 'Estimate', development ? 'Development interval' : 'Interval', 'Clusters'], [
        ...typed.groups.map(row => [row.endpoint, row.condition, estimate(declared.get(row.endpoint), row.estimate), span(row), row.clusters]),
        ...typed.contrasts.map(row => [row.endpoint, row.id + ' (first − second)', number(row.difference), span(row), row.clusters])])
    }
    if (typed.contrasts.length) addTable('endpoints-contrasts', ['Endpoint', 'Contrast (first − second)', 'First', 'Second', 'Difference', development ? 'Development interval' : 'Interval', 'Clusters'], typed.contrasts.map(row => [row.endpoint, row.id, estimate(declared.get(row.endpoint), row.firstEstimate), estimate(declared.get(row.endpoint), row.secondEstimate), number(row.difference), span(row), row.clusters ?? '']))
    paragraph('Estimates by replicate index are descriptive exchangeability diagnostics over the primary population. They are not tests and do not establish independent draws.')
    addTable('endpoints-replicates', ['Endpoint', 'Condition', 'Replicate', 'n', 'Estimate'], typed.replicates.map(row => [row.endpoint, row.condition, row.replicate, row.n, estimate(declared.get(row.endpoint), row.estimate)]))
    addTable('endpoints-records', ['Trial', 'Task', 'Condition', 'Replicate', 'Primary included', 'Endpoint', 'Status', 'Value', 'Exposure'], typed.records.flatMap(row => Object.entries(row.values).map(([endpoint, observation]) => [row.trialId, row.taskId, row.conditionId, row.replicate, row.primaryIncluded, endpoint, observation.status, observation.value ?? '', observation.exposure ?? ''])), { linkOnly: true })
  }
  if (summary.design) {
    const design = summary.design, rate = row => plan ? (plan.primaryDenominator === 'scheduled' ? row.primary?.scheduledPassRate : row.primary?.passRate) : row.scheduledPassRate
    heading(development ? 'Grouped assignment design (development computations)' : 'Grouped assignment design')
    paragraph(execution.computationScope)
    paragraph('Arms group the frozen conditions; draw units group the tasks that share one factor level under one condition and replicate; phases partition replicates in declared order. These are frozen design declarations for description and planned arm contrasts. They do not change how any trial runs. Draw wall and agent times are arithmetic over the retained member attempt observations (the longest and the summed member times); they do not measure concurrency, processor use or agent behaviour.' + (design.excludedTrials.length ? ' ' + design.excludedTrials.length + ' trial identities outside a phase\'s factor levels were never scheduled and are listed in design/plan.json.' : ''))
    addTable('design-arms', ['Arm', 'Label', 'Conditions', 'Scheduled', 'Completed', summary.criterion.label, plan ? 'Primary rate' : 'Scheduled rate'], design.arms.map(row => [row.arm, row.label ?? '', row.conditions.join(' '), row.scheduled, row.measured, row.passed, percent(rate(row))]))
    if (design.units.length) addTable('design-units', ['Unit', 'Arm', 'Condition', 'Group', 'Replicate', 'Phase', 'Members', 'Completed', 'All passed', 'Wall ms', 'Agent ms'], design.units.map(row => [row.unitId, row.armId, row.conditionId, row.group, row.replicate, row.phase ?? '', row.members, row.completedMembers, row.allPassed, row.wallMs ?? 'Unavailable', row.agentMs ?? 'Unavailable']))
    if (design.phases.length) addTable('design-phases', ['Phase', 'Draws', 'Scheduled', 'Completed', summary.criterion.label, 'Requires decision from', 'Decision'], design.phases.map(row => [row.phase, row.draws, row.scheduled, row.measured, row.passed, row.requiresRecordedDecision ?? '', row.decision ?? '']))
    if (design.contrasts.length) addTable('design-arm-contrasts', ['Contrast', 'First arm', 'Second arm', 'First rate', 'Second rate', 'Difference', development ? 'Development interval' : 'Interval', 'Clusters', 'Interval note'], design.contrasts.map(row => [row.id, row.first, row.second, percent(row.firstRate), percent(row.secondRate), row.difference === null ? 'Unavailable' : number(row.difference), row.interval ? number(row.interval.low) + ' to ' + number(row.interval.high) : row.intervalReason, row.families, intervalNote(row, design.contrasts.length)]))
    if (summary.endpoints?.arms) {
      const declared = new Map(summary.endpoints.declared.map(endpoint => [endpoint.id, endpoint])), estimate = (endpoint, value) => value === null ? 'Unavailable' : ['binary', 'proportion'].includes(endpoint.kind) ? percent(value) : number(value)
      addTable('design-endpoint-arms', ['Endpoint', 'Arm', 'Scheduled', 'Unavailable', 'Invalid', 'Estimate', development ? 'Development interval' : 'Interval'], summary.endpoints.arms.map(row => [row.endpoint, row.arm, row.scheduled, row.unavailable, row.invalid, estimate(declared.get(row.endpoint), row.estimate), row.interval ? number(row.interval.low) + ' to ' + number(row.interval.high) : row.intervalReason]))
      if (summary.endpoints.armContrasts.length) addTable('design-endpoint-arm-contrasts', ['Endpoint', 'Contrast', 'First arm', 'Second arm', 'First', 'Second', 'Difference', development ? 'Development interval' : 'Interval'], summary.endpoints.armContrasts.map(row => [row.endpoint, row.id, row.first, row.second, estimate(declared.get(row.endpoint), row.firstEstimate), estimate(declared.get(row.endpoint), row.secondEstimate), row.difference === null ? 'Unavailable' : number(row.difference), row.interval ? number(row.interval.low) + ' to ' + number(row.interval.high) : row.intervalReason]))
    }
  }
  heading('Trial disposition')
  paragraph('These disposition tables and the figure include all frozen trials.' + (summary.primaryPopulation ? ' Primary analysis uses the separately declared population above.' : ' No primary population was declared.'))
  const accepted = summary.criterion.label
  if (summary.audit) addTable('rates', ['Condition', 'Scheduled', 'Completed', 'Eligible scheduled', 'Eligible completed', 'Agreements', 'Agreement / eligible scheduled', 'Agreement / eligible completed'], summary.groups.map(group => [group.condition, group.scheduled, group.measured, group.eligibleScheduled, group.eligibleCompleted, group.passed, rateWithInterval(group.scheduledPassRate, group.scheduledPassRateInterval), rateWithInterval(group.passRate, group.passRateInterval)]))
  else addTable('rates', ['Condition', 'Scheduled', 'Completed', accepted, 'Unmeasured', accepted + ' / scheduled', accepted + ' / completed'], summary.groups.map(group => [group.condition, group.scheduled, group.measured, group.passed, group.scheduled - group.measured, rateWithInterval(group.scheduledPassRate, group.scheduledPassRateInterval), rateWithInterval(group.passRate, group.passRateInterval)]))
  const figure = dispositionFigure(summary)
  sections.push(figure); markdown.push('![Disposition of scheduled trials](figures/disposition.svg)')
  addTable('dispositions', ['Condition', 'Disposition', 'Trials'], summary.groups.flatMap(group => Object.entries(group.dispositions).map(([kind, count]) => [group.condition, kind, count])))
  // Dispersion across replicates: the primary criterion computed within each
  // replicate index, from the retained rows, so summary.json is unchanged.
  heading('Replicate dispersion')
  if (project.spec.protocol.replicates > 1) {
    const eligible = row => row.referenceEligible !== false && (plan ? row.primaryIncluded : true)
    const counts = row => plan?.primaryDenominator === 'completed' ? row.status === 'completed' : true
    paragraph('The primary criterion computed within each replicate index for every condition' + (plan ? ' over the primary population and the frozen ' + plan.primaryDenominator + ' denominator' : ' over all scheduled trials') + '. The mean, the sample standard deviation (n \u2212 1 in the denominator) and the range are taken across replicate indices. This describes repeated runs of one frozen schedule under one apparatus; it is descriptive and no test is applied to it.')
    const dispersion = summary.groups.map(group => {
      const replicateRates = Array.from({ length: project.spec.protocol.replicates }, (_, index) => {
        const cell = summary.rows.filter(row => row.conditionId === group.condition && row.replicate === index + 1 && eligible(row) && counts(row))
        const passed = cell.filter(row => row.status === 'completed' && row.passed === true).length
        return cell.length ? passed / cell.length : null
      })
      const estimable = replicateRates.filter(value => value !== null), mean = estimable.length ? estimable.reduce((sum, value) => sum + value, 0) / estimable.length : null
      const deviation = estimable.length > 1 ? Math.sqrt(estimable.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (estimable.length - 1)) : null
      return [group.condition, project.spec.protocol.replicates, estimable.length, replicateRates.map(value => value === null ? 'Unavailable' : percent(value)).join('; '), percent(mean),
        deviation === null ? 'Not estimable' : number(deviation), estimable.length ? percent(Math.min(...estimable)) : 'Not measured', estimable.length ? percent(Math.max(...estimable)) : 'Not measured']
    })
    addTable('replicate-dispersion', ['Condition', 'Replicates', 'Estimable replicates', 'Replicate rates', 'Mean', 'SD (sample)', 'Min', 'Max'], dispersion)
  } else paragraph('protocol.replicates is 1: this journal holds one run of each cell, so no dispersion across repeated runs can be reported.')
  if (summary.audit) {
    heading('Judge decisions against the reference')
    paragraph('Detection and disagreement rates concern the selected reference-eligible cases under this exact criterion. Unresolved references have null scores. Judge abstentions, malformed verdicts and unmeasured trials remain distinct; they are never treated as observed accept or reject decisions.')
    addTable('judge-detection', ['Condition', 'Reference rejects detected', 'False accepts', 'False rejects', 'Detection / scheduled rejects', 'Detection / completed rejects'], summary.audit.groups.map(group => [group.condition, group.correctRejections, group.falseAcceptances, group.falseRejections, percent(group.rejectionDetectionScheduled), percent(group.rejectionDetectionCompleted)]))
    const rows = summary.audit.groups.flatMap(group => group.confusion.map(cell => [group.condition, cell.referenceVerdict || 'Unresolved reference', cell.judgeVerdict || 'Malformed verdict', cell.count]))
    addTable('judge-confusion', ['Condition', 'Reference verdict', 'Judge verdict', 'Completed cases'], rows, { previewRows: rows.filter(row => row[3] > 0) })
  }
  if (summary.contrasts.length) {
    heading(development ? 'Development rate and interval computations' : 'Planned rate contrasts')
    paragraph(execution.computationScope)
    addTable('contrasts', ['Contrast (first − second)', 'Difference', development ? 'Development interval' : 'Interval', 'Families', 'Interval note'], summary.contrasts.map(contrast => [contrast.id, number(contrast.difference), contrast.interval ? number(contrast.interval.low) + ' to ' + number(contrast.interval.high) : contrast.intervalReason, contrast.families, intervalNote(contrast, summary.contrasts.length)]))
  }
  heading('Attempt resources and identity')
  if (!summary.observations) paragraph('No observation mapping or accounting policy was frozen. Raw responses and legacy attempt durations remain in the journal; returned identity, provider generation time, tokens, tools and cost are not normalized or inferred.')
  else {
    const accounting = summary.observations, unavailable = value => value === null ? 'Unavailable' : value
    const countList = values => Object.entries(values).map(([name, count]) => count + ' ' + name).join('; ') || 'No attempts'
    paragraph(accounting.plan.rationale)
    paragraph(accounting.totals.attempts + ' attempts were started; ' + accounting.unattempted + ' scheduled trials remain unattempted. Resource tables include every attempt regardless of score. A known subtotal includes only available observations; a full total is unavailable if any started attempt lacks that measurement. Generation completion is an explicit adapter report, separate from output extraction and grading.')
    addTable('observation-coverage', ['Condition', 'Attempts', 'Identity comparison', 'Reported generation', 'Timed attempts'], accounting.groups.map(group => [group.condition, group.attempts, countList(group.identities), countList(group.generation), group.host.attemptMs.observed + ' / ' + group.attempts]))
    addTable('attempt-outcomes', ['Condition', 'Attempt disposition', 'Attempts'], accounting.groups.flatMap(group => Object.entries(group.outcomes).map(([kind, count]) => [group.condition, kind, count])))
    paragraph('Requested model settings, instructions, tools, context construction and session isolation are frozen declarations. Returned identity stays separate; missing values never inherit the requested model. Complete identity and control tables retain exact values and their mapped source paths.')
    addTable('collection-controls', ['Condition', 'Requested model', 'Collection controls', 'Identity policy', 'Completion policy', 'Mapping', 'Estimate convention'], accounting.contracts.map(contract => [contract.condition, canonical(contract.requested.model), canonical(contract.requested.collection), canonical(contract.identity), canonical(contract.completion), canonical(contract.mapping), canonical(contract.costEstimate)]), { linkOnly: true })
    addTable('returned-identities', ['Trial', 'Attempt', 'Condition', 'Field', 'Requested', 'Returned', 'Status', 'Comparison', 'Source path'], accounting.rows.flatMap(row => Object.entries(row.reported.identity).map(([field, value]) => [row.trialId, row.attempt, row.conditionId, field, value.requested, value.value, value.status, value.comparison, canonical(value.sourcePath)])), { linkOnly: true })
    if (summary.workflows) paragraph('Usage and reported charges count collection calls, including each started workflow stage. A partial workflow preserves known stage subtotals and leaves full totals unavailable when a started stage has no measurement. Declared cost estimates and host timing remain per attempt.')
    addTable('resource-usage', ['Condition', 'Reported metric', 'Known subtotal', summary.workflows ? 'Observed collection calls' : 'Observed attempts', 'Full total'], accounting.groups.flatMap(group => Object.entries(group.usage).map(([field, metric]) => [group.condition, field, unavailable(metric.observedSubtotal), metric.observed + ' / ' + metric.attempts, unavailable(metric.total)])))
    paragraph('Cost is limited to the mapped collection response. Reported charges and declared estimates are separate; subscription access does not imply zero cost. Recorded-response metadata describes the saved response, not a new provider call. Each currency and metadata origin retains its own subtotal. Grader and infrastructure charges, and a complete experiment cost, are unavailable.')
    addTable('collection-cost', ['Condition', 'Basis', 'Metadata origin', 'Currency', 'Known subtotal', summary.workflows ? 'Known costs / calls (charges) or attempts (estimates)' : 'Known costs / attempts', 'Full total'], accounting.groups.flatMap(group => ['reportedCost', 'estimatedCost'].flatMap(field => {
      const origins = group[field].byOrigin.length ? group[field].byOrigin : [{ origin: 'No attempts', byCurrency: [], observed: 0, attempts: 0 }]
      return origins.flatMap(origin => (origin.byCurrency.length ? origin.byCurrency : [{ currency: null, observedSubtotal: null, total: null }]).map(value => [group.condition, field === 'reportedCost' ? 'Reported charge' : 'Declared estimate', origin.origin, value.currency || 'Unavailable', unavailable(value.observedSubtotal), origin.observed + ' / ' + origin.attempts, unavailable(value.total)]))
    })))
    if (pricing) {
      heading('Estimated API cost at list prices')
      paragraph('Estimated at list API prices as of ' + pricing.table.frozenAsOf + '. Every figure here is an estimate computed from the price table frozen into this project, not a charge any provider reported; reported charges stay in the table above and are never replaced by one of these. A rate the frozen table does not state is never treated as zero: that attempt is left unavailable with its reason named, and any total containing it stays unavailable rather than reading as free.')
      const estimates = accounting.rows.map(row => ({ row, estimate: row.reported.estimatedCost }))
      const bucket = key => {
        const groups = new Map()
        for (const entry of estimates) {
          const name = key(entry)
          if (!groups.has(name)) groups.set(name, [])
          groups.get(name).push(entry.estimate)
        }
        return [...groups.entries()].sort((first, second) => first[0] < second[0] ? -1 : first[0] > second[0] ? 1 : 0)
      }
      const notEstimated = list => {
        const counts = new Map()
        for (const value of list) if (value.status !== 'estimated') counts.set(value.reason || 'not-estimated', (counts.get(value.reason || 'not-estimated') || 0) + 1)
        return [...counts.entries()].map(([reason, count]) => count + ' unavailable: ' + reason).join('; ') || 'None'
      }
      const costRows = entries => entries.map(([name, list]) => {
        const rolled = metricAggregate(list, list.length, { money: true })
        return [name, list.find(value => value.currency)?.currency || NOT_DECLARED, rolled.observed + ' / ' + rolled.attempts,
          rolled.observedSubtotal === null ? NOT_DECLARED : rolled.observedSubtotal,
          rolled.total === null ? NOT_DECLARED : rolled.total, notEstimated(list)]
      })
      const costHeader = first => [first, 'Currency', 'Estimated attempts', 'Known subtotal', 'Full total', 'Not estimated']
      addTable('estimated-cost-by-condition', costHeader('Condition'), costRows(bucket(entry => entry.row.conditionId)))
      addTable('estimated-cost-by-model', costHeader('Billing model'), costRows(bucket(entry => entry.estimate.billingModelId || entry.estimate.pricedModelId || NOT_DECLARED)))
      paragraph('Grouping by billing model is what the frozen rates apply to, so two conditions on one model combine here and a condition whose adapter reported a different model than it declared is separated out. The model priced for each attempt, and whether it was the reported or the declared identifier, is in the per-attempt measurements.')
    }
    paragraph('Host time uses nested monotonic intervals. Attempt time includes collection, extraction, persistence, grading and settlement. Inclusive phases contain their children and cannot be added together; exclusive durations partition the measured attempt time. Native execution includes container and engine startup. Provider generationMs is reported separately. Recovery budget charges are reserved time, not observed elapsed time.')
    addTable('host-attempt-time', ['Condition', 'Known attempt ms', 'Timed attempts', 'Full attempt ms', 'Recovered attempts', 'Recovery budget ms'], accounting.groups.map(group => [group.condition, unavailable(group.host.attemptMs.observedSubtotal), group.host.attemptMs.observed + ' / ' + group.attempts, unavailable(group.host.attemptMs.total), group.host.recoveredAttempts, group.host.recoveryBudgetChargeMs]))
    const phases = accounting.groups.flatMap(group => group.host.phases.map(phase => [group.condition, phase.kind, phase.spans, unavailable(phase.inclusiveSubtotalMs), unavailable(phase.exclusiveSubtotalMs), phase.truncated]))
    addTable('host-phases', ['Condition', 'Phase', 'Spans', 'Inclusive ms', 'Exclusive ms', 'Truncated spans'], phases, { previewRows: phases.filter(row => row[2] > 0) })
    addTable('resource-attempts', ['Trial', 'Task', 'Condition', 'Replicate', 'Attempt', 'Started at', 'Status', 'Disposition', 'Selected for score', 'Response retained', 'Output retained', 'Metadata origin', 'Reported generation', 'Generation reason', 'Attempt ms', 'Recovery budget ms'], accounting.rows.map(row => [row.trialId, row.taskId, row.conditionId, row.replicate, row.attempt, row.startedAt, row.status, row.disposition, row.selectedForScore, row.responseRetained, row.outputRetained, row.reported.metadataOrigin, canonical(row.reported.completion.status), canonical(row.reported.completion.reason), row.timing.totalMs, row.recoveryBudgetChargeMs]), { linkOnly: true })
    addTable('resource-measurements', ['Trial', 'Attempt', 'Condition', 'Metric', 'Measurement'], accounting.rows.flatMap(row => [...Object.entries(row.reported.usage), ['reportedCost', row.reported.reportedCost], ['estimatedCost', row.reported.estimatedCost]].map(([field, value]) => [row.trialId, row.attempt, row.conditionId, field, canonical(value)])), { linkOnly: true })
    addTable('timing-spans', ['Trial', 'Attempt', 'Condition', 'Span', 'Parent', 'Phase', 'Start us', 'End us', 'Status', 'Inclusive ms', 'Exclusive ms'], accounting.rows.flatMap(row => row.timing.phases.map(span => [row.trialId, row.attempt, row.conditionId, span.id, span.parentId, span.kind, span.startUs, span.endUs, span.status, span.inclusiveMs, span.exclusiveMs])), { linkOnly: true })
  }
  if (summary.conventions.distributions.length) {
    heading('Observations and conventions')
    paragraph('These descriptive distributions retain every scheduled trial. One observation may match several readings. A convention value is resolved only when all matching readings assign that value; otherwise it remains unresolved. The preview shows observed categories; the full table also retains every zero count. Observable identifiers and full reading membership are retained in conventions.json. No internal reasoning or exhaustive semantic interpretation is inferred.')
    const binLabel = bin => bin.kind === 'observable' ? bin.readings.join(' | ') : bin.kind === 'resolved' ? canonical(bin.value) : bin.kind === 'disposition' ? bin.disposition : 'unresolved'
    const rows = summary.conventions.distributions.flatMap(group => group.bins.map(bin => [group.taskId, group.condition, group.dimension, binLabel(bin), bin.count, bin.completedCount, percent(bin.scheduledRate), percent(bin.completedRate)]))
    addTable('conventions', ['Task', 'Condition', 'Dimension', 'Category', 'Trials', 'Completed trials', 'Share / scheduled', 'Share / completed'], rows, { previewRows: rows.filter(row => row[4] > 0) })
  }
  heading('Stratified results')
  const population = summary.audit ? 'eligible ' : ''
  addTable('strata', ['Dimension', 'Level', 'Condition', 'Scheduled', 'Completed', accepted, accepted + ' / ' + population + 'scheduled', accepted + ' / ' + population + 'completed'], summary.strata.map(row => [row.dimension, canonical(row.value), row.condition, row.scheduled, row.measured, row.passed, percent(row.scheduledPassRate), percent(row.passRate)]))
  sections.push(...paper.middle.sections); markdown.push(...paper.middle.markdown)
  heading('Reproduction')
  paragraph('Run node cli.mjs analyze with the exported project and retained attempts.jsonl. HTML, Markdown, SVG, CSV and JSON derive from the same frozen schedule and attempt journal. Complete tables accompany the report, including any rows omitted from its preview.')
  addTable('identities', ['Artifact', 'SHA-256'], [['Project', project.sha256], ['Attempt journal', artifact.journalSha256], ['Canonical summary', artifact.summarySha256], ...(summary.corpus ? [['Corpus manifest', summary.corpus.sha256]] : []), ...(summary.audit ? [['Audit manifest', summary.audit.sha256], ['Reference bundle', project.spec.auditPlan.reference.sha256], ['Source project', project.spec.auditPlan.reference.project.sha256]] : [])])
  sections.push(...paper.integrity.sections); markdown.push(...paper.integrity.markdown)
  heading('Scope')
  const limitations = [...summary.limitations, 'Behavioral grades concern the declared grader and frozen inputs; agreement on finite inputs does not prove unique semantics or universal correctness.']
  sections.push('<ul>' + limitations.map(value => '<li>' + html(value) + '</li>').join('') + '</ul>')
  markdown.push(limitations.map(value => '- ' + md(value)).join('\n'))
  sections.push(...paper.limits.sections); markdown.push(...paper.limits.markdown)
  sections.push(...paper.checklist.sections); markdown.push(...paper.checklist.markdown)
  sections.push(...paper.attribution.sections); markdown.push(...paper.attribution.markdown)
  sections.push(...paper.citation.sections); markdown.push(...paper.citation.markdown)
  sections.push(...paper.references.sections); markdown.push(...paper.references.markdown)
  const preparationStyle = summary.selectedInputPreparation ? '@media screen{[aria-label="selected input preparation table"] table{min-width:92rem}[aria-label="selected input preparation table"] th,[aria-label="selected input preparation table"] td{min-width:7rem;overflow-wrap:normal;word-break:normal}[aria-label="selected input preparation table"] td:nth-child(3){min-width:12rem}[aria-label="selected input preparation table"] td:last-child{min-width:18rem;overflow-wrap:anywhere}}' : ''
  const style = preparationStyle + "body{margin:0;background:#f3f5f6;color:#172737;font:16px/1.6 system-ui,sans-serif}main{overflow-wrap:anywhere;max-width:1050px;margin:36px auto;padding:44px;background:white;border:1px solid #dde3e8;border-radius:10px}h1{font-size:34px;line-height:1.2;margin:0 0 10px}h2{font-size:22px;margin-top:38px}p{max-width:84ch}.label{color:#41546a;font-weight:650}.notice{border-left:4px solid #41647b;background:#eef3f6;padding:14px 18px}.table-wrap{overflow:auto;margin:20px 0 6px}.table-note{font-size:13px;color:#41546a;margin:0 0 22px}a{color:#275b7b}table{border-collapse:collapse;width:100%;min-width:840px;font-size:14px}.table-wrap:focus-visible{outline:2px solid #41647b;outline-offset:3px}[aria-label^=\"workflow \"] th,[aria-label^=\"workflow \"] td{min-width:8rem}th,td{padding:12px;text-align:left;border-bottom:1px solid #d9e1e7;vertical-align:top;overflow-wrap:anywhere}th{overflow-wrap:normal;word-break:normal}thead{background:#f0f4f7}td{font-variant-numeric:tabular-nums}svg{width:100%;height:auto}li{margin:8px 0}@media(max-width:600px){main{margin:0;padding:22px;border:0;border-radius:0}h1{font-size:27px}th,td{padding:9px}}@media print{table{min-width:0}body{background:white}main{border:0;margin:0;padding:0}.table-wrap{overflow:visible}h2{break-after:avoid}tr,svg{break-inside:avoid}}"
  files['report.html'] = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src \'self\' data:; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'"><title>' + html(project.spec.name) + ' — ' + html(label) + '</title><style>' + style + '</style></head><body><main><p class="label">' + html(label) + '</p><h1>' + html(project.spec.name) + '</h1><p class="notice">' + html(notice) + '</p>' + sections.join('') + '</main></body></html>\n'
  files['report.md'] = ['# ' + md(project.spec.name), label, notice, ...markdown].join('\n\n') + '\n'
  files['analysis.json'] = JSON.stringify(artifact, null, 2) + '\n'
  files['execution.json'] = JSON.stringify(execution, null, 2) + '\n'
  files['summary.json'] = JSON.stringify(summary, null, 2) + '\n'
  files['conventions.json'] = JSON.stringify(summary.conventions, null, 2) + '\n'
  if (summary.audit) files['audit.json'] = JSON.stringify(summary.audit, null, 2) + '\n'
  if (summary.observations) files['observations.json'] = JSON.stringify(summary.observations, null, 2) + '\n'
  if (summary.workflows) files['workflows.json'] = JSON.stringify(summary.workflows, null, 2) + '\n'
  if (summary.endpoints) files['endpoints.json'] = JSON.stringify(summary.endpoints, null, 2) + '\n'
  if (summary.design) files['design.json'] = JSON.stringify(summary.design, null, 2) + '\n'
  files['results.csv'] = summaryCsv(summary)
  files['figures/disposition.svg'] = figure
  // Keep typed analytical sidecars and raw proof bytes intact. This manifest
  // applies the frozen execution scope to every accompanying report artifact.
  files['execution-manifest.json'] = JSON.stringify({ format: 'research-report-execution-scope', version: 1,
    projectSha256: project.sha256, execution, files: Object.keys(files).sort() }, null, 2) + '\n'
  return { files, page: paper.page }
}

// The report package. The Research page's Export research report button and
// `cli.mjs analyze` in every exported ZIP both ship exactly these bytes.
export async function researchReportFiles(project, events, options = {}) {
  return (await buildReportPackage(project, events, options)).files
}

// The method sections (task construction, composition layers, conditions and
// request envelopes) and the run sections (journal walkthrough, per-trial
// evidence) as neutral blocks, for the Research page to render in place.
// Same project, same journal and the same wording as the report above, so a
// reader who inspects the page sees what a reviewer of the report will see.
export async function researchPageSections(project, events, options = {}) {
  return (await buildReportPackage(project, events, options)).page
}
