// The generic benchmark template as a citable artifact, pinned-runtime surfaces: a versioned
// identity, the method-reference registry, the report's citation record, generated statistical
// methods, replicate dispersion, interval notes, and the statistics corrections from root's
// 2026-09-11 stats audit (F1 design-arm Bonferroni family, F2 primary-population headline,
// F7 rounded abstract). The export-side half is research-benchmark-template-citation-export.
// Worker 19, WS1.
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { approveBundle } from '../../src/benchmark/prompts.mjs'
import { genericStarter, newExperimentDraft } from '../../src/benchmark/starters.mjs'
import { bindRuntimeSources, freezeStudy, RUNTIME_FILES, TEMPLATE, METHOD_REFERENCES, methodReference, methodReferencesFor, templateIdentity, templateCitation, templateCitationFiles } from '../../src/benchmark/study.mjs'
import { DESIGN_PLAN_VERSION } from '../../src/benchmark/analysis.mjs'
import { runStudy } from '../../src/benchmark/runner.mjs'
import { researchReportFiles } from '../../src/benchmark/report.mjs'
import { projectFiles } from '../../src/benchmark/export.mjs'
import { runProject } from '../../src/benchmark/cli.mjs'
import { pageReportOptions } from './fixtures/research-page-report-options.mjs'

const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(new URL('../../src/benchmark/' + file, import.meta.url), 'utf8')])))
const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))
const REVIEWER = 'TEMPLATE CITATION FIXTURE MARKER ONLY'
const unescapeMarkdown = text => text.replace(/\\([\\`*_{}\[\]()#+.!|<>])/g, '$1')
const unescapeHtml = text => text.replace(/&(amp|lt|gt|quot|#39);/g, match => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[match])
const both = files => [unescapeMarkdown(files['report.md']), unescapeHtml(files['report.html'])]
const section = (text, from, to) => { const start = text.indexOf(from); const end = to ? text.indexOf(to, start + from.length) : -1; return start < 0 ? '' : text.slice(start, end < 0 ? undefined : end) }

// Three replay conditions a > b > c over eight arithmetic tasks in four families, so
// contrasts and whole-family bootstrap intervals are estimable. Task i passes under a
// condition when i is below that condition's pass count.
function draft({ tasks = 8, families = 4, passes = { a: 6, b: 4, c: 2 }, split = () => 'development', population = 'all',
  contrasts = [{ id: 'ab', first: 'a', second: 'b' }, { id: 'ac', first: 'a', second: 'c' }], multiplicity = 'bonferroni',
  uncertainty = { kind: 'family-bootstrap', seed: 20260911, iterations: 200, confidence: 0.9 }, replicates = 1, design = null, citation = undefined } = {}) {
  const spec = genericStarter(), template = spec.tasks[0]
  spec.tasks = Array.from({ length: tasks }, (_, i) => ({ ...structuredClone(template), id: 'task-' + (i + 1), familyId: 'fam-' + (i % families + 1), split: split(i),
    root: { use: 'context', slots: { task: { use: 'task', params: { a: i + 1, b: 10 } } } }, expected: String(i + 11) }))
  spec.conditions = Object.entries(passes).map(([id, count]) => ({ ...structuredClone(spec.conditions[0]), id, label: 'Condition ' + id,
    adapter: { kind: 'replay', responses: Object.fromEntries(spec.tasks.map((task, i) => [task.id, i < count ? task.expected : 'wrong'])) } }))
  spec.protocol.replicates = replicates; spec.protocol.maxTotalAttempts = 1000
  spec.analysisPlan = { ...spec.analysisPlan, primaryPopulation: population, contrasts, multiplicity, uncertainty }
  if (design) spec.designPlan = { version: DESIGN_PLAN_VERSION, rationale: 'Single-condition arms for the multiplicity check.', ...design }
  if (citation !== undefined) spec.citation = citation
  return spec
}
async function frozen(spec, { purpose = 'recorded-diagnostic' } = {}) {
  let study = newExperimentDraft(spec, { purpose })
  study = await bindRuntimeSources(study, sources)
  study.catalog = await Promise.all(study.catalog.map(bundle => approveBundle(bundle, REVIEWER, '2026-09-10T00:00:00.000Z', { catalog: study.catalog })))
  return freezeStudy(study)
}
const run = async spec => { const project = await frozen(spec); const result = await runStudy(project); return { project, ...result } }
const report = (project, events, options) => researchReportFiles(project, events, options)

test('the template names itself, its generator release and a runtime identity derived from the pinned sources', async () => {
  assert.equal(TEMPLATE.id, 'research-benchmark-template')
  assert.match(TEMPLATE.version, /^\d+\.\d+\.\d+$/, 'the template version is semantic and separate from the application version')
  assert.equal(TEMPLATE.generator.name, 'ToolsEnabled')
  assert.equal(TEMPLATE.generator.version, packageJson.version, 'the generator version printed into every citation equals package.json')
  assert.notEqual(TEMPLATE.version, packageJson.version, 'the template is not versioned by the application release')
  const project = await frozen(draft())
  const identity = await templateIdentity(project)
  assert.match(identity, /^[0-9a-f]{64}$/)
  assert.equal(await templateIdentity(project), identity, 'the identity is a function of the frozen project')
  const other = { ...project.spec, runtimeSources: { ...project.spec.runtimeSources, 'report.mjs': 'd'.repeat(64) } }
  assert.notEqual(await templateIdentity(other), identity, 'different runtime bytes never share an identity')
  assert.equal(await templateIdentity({ ...project.spec, runtimeSources: undefined }), null, 'an unpinned project has no runtime identity, and none is guessed')
})

test('method references follow the frozen plan, every entry is verified, and the unverifiable Bonferroni (1936) is not in the registry', async () => {
  const descriptive = await frozen(draft({ contrasts: [], multiplicity: 'none-descriptive', uncertainty: null }))
  assert.deepEqual(methodReferencesFor(descriptive).map(entry => entry.id), ['durstenfeld-1964', 'mulberry32'], 'a descriptive study cites only the schedule randomisation')
  const ids = methodReferencesFor(await frozen(draft())).map(entry => entry.id)
  for (const id of ['efron-1979', 'efron-tibshirani-1993', 'field-welsh-2007', 'davison-hinkley-1997', 'hyndman-fan-1996', 'dunn-1961']) assert.ok(ids.includes(id), 'an interval plan with Bonferroni cites ' + id)
  assert.ok(!ids.includes('bonferroni-1936'))
  assert.throws(() => methodReference('bonferroni-1936'), /No method reference/)
  for (const entry of METHOD_REFERENCES) {
    assert.ok(entry.verification.length > 20, entry.id + ' states how it was verified')
    assert.ok(entry.authors.length >= 1 && entry.year >= 1900 && entry.title && entry.container, entry.id + ' is a complete reference')
    assert.ok(entry.doi || entry.url || entry.isbn, entry.id + ' carries a resolvable identifier')
    assert.ok(!/Teoria statistica/.test(entry.title), 'the unverifiable 1936 paper is not registered')
  }
})

test('the optional citation field is validated, printed verbatim, and prints Not declared when absent', async () => {
  const citation = { authors: [{ name: 'Fixture Author', affiliation: 'Fixture Institute', orcid: '0000-0002-1825-0097' }, { name: 'Fixture Group' }],
    title: 'Fixture study title', year: 2026, doi: '10.5555/fixture.1', url: 'https://example.invalid/fixture', note: 'Fixture citation note.' }
  const { project, events } = await run(draft({ citation }))
  const record = await templateCitation(project)
  assert.deepEqual(record.authors, citation.authors)
  for (const value of ['Fixture Author', 'Fixture Institute', 'https://orcid.org/0000-0002-1825-0097', 'Fixture Group', 'doi: "10.5555/fixture.1"', 'Fixture citation note.']) assert.ok(record.cff.includes(value), 'CITATION.cff carries ' + value)
  assert.ok(record.bibtex.includes('{Fixture Author} and {Fixture Group}') && record.bibtex.includes('doi = {10.5555/fixture.1}'), 'BibTeX carries the declared authors and DOI')
  for (const text of both(await report(project, events))) {
    const cite = section(text, 'Cite this study and its template', 'References')
    assert.ok(cite.includes('Fixture Author (Fixture Institute), ORCID 0000-0002-1825-0097; Fixture Group'), 'the citation record lists the declared authors')
    assert.ok(cite.includes('10.5555/fixture.1'), 'the declared DOI is printed')
  }
  const bare = await run(draft())
  for (const text of both(await report(bare.project, bare.events))) assert.ok(text.includes('Not declared (this frozen project has no citation.authors field)'), 'no author is invented')
  await assert.rejects(frozen(draft({ citation: { authors: [{ name: 'X', orcid: 'not-an-orcid' }] } })), /ORCID/)
  await assert.rejects(frozen(draft({ citation: { authors: [{ name: 'X' }], doi: 'https://doi.org/10.5555/x' } })), /DOI/)
  await assert.rejects(frozen(draft({ citation: { authors: [], title: 'No one' } })), /1-64/)
})

test('the statistical methods section cites from the registry only, and the References section lists exactly the cited entries in first-use order', async () => {
  const { project, events } = await run(draft())
  const files = await report(project, events)
  const cited = JSON.parse(files['paper/references.json']).map(entry => entry.id)
  assert.ok(cited.length >= 8, 'an interval study cites at least eight references')
  for (const id of cited) assert.equal(methodReference(id).id, id, 'every cited key is registered')
  assert.ok(cited.includes('dunn-1961') && !cited.includes('bonferroni-1936'))
  for (const text of both(files)) {
    for (const heading of ['Statistical methods', 'Pre-registration by freeze', 'Contamination and leakage controls', 'Limitations and threats to validity', 'Cite this study and its template', 'References'])
      assert.ok(text.includes(heading), 'the report has ' + heading)
    const methods = section(text, 'Statistical methods', 'Run walkthrough')
    for (const value of ['whole clusters', String(project.spec.analysisPlan.uncertainty.iterations), 'definition 7', 'Bonferroni', 'registration identifier', project.sha256, 'held-out'])
      assert.ok(methods.includes(value), 'the methods section states ' + value)
    const references = section(text, 'References')
    const labels = [...text.slice(0, text.indexOf('References')).matchAll(/\[([A-Z][^\]\[]+? \d{4}(?:; [A-Z][^\]\[]+? \d{4})*)\]/g)].flatMap(match => match[1].split('; '))
    assert.ok(labels.length >= 8, 'the body carries bracketed citations')
    for (const label of labels) assert.ok(references.includes('[' + label + ']'), 'the References section resolves ' + label)
    assert.equal((references.match(/Verification: /g) || []).length, cited.length, 'each listed reference states its verification, and only cited entries are listed')
    assert.ok(references.indexOf('Durstenfeld') < references.indexOf('Efron'), 'entries are listed in order of first citation')
  }
})

test('replicate dispersion is reported per condition when replicates are at least 2, and its absence is stated otherwise', async () => {
  const two = await run(draft({ replicates: 2 }))
  const files = await report(two.project, two.events)
  const csv = files['tables/replicate-dispersion.csv']
  assert.ok(csv, 'the dispersion table is retained as CSV')
  assert.ok(csv.split('\n')[0].includes('SD (sample)') && csv.split('\n')[0].includes('Replicate rates'))
  assert.equal(csv.trim().split('\n').length - 1, two.project.spec.conditions.length, 'one row per condition')
  for (const text of both(files)) assert.ok(text.includes('Replicate dispersion') && text.includes('n − 1'), 'the dispersion section is described')
  const one = await run(draft())
  const single = await report(one.project, one.events)
  assert.equal(single['tables/replicate-dispersion.csv'], undefined)
  for (const text of both(single)) assert.ok(text.includes('protocol.replicates is 1'), 'a single run states that no dispersion can be reported')
})

test('interval notes print the per-interval level, endpoint positions and clusters, and name a degenerate interval', async () => {
  const { project, events, summary } = await run(draft({ passes: { a: 8, b: 8, c: 2 } }))
  const files = await report(project, events)
  const table = files['tables/contrasts.csv']
  assert.ok(table.split('\n')[0].includes('Interval note'))
  // This fixture resamples four clusters, below the coverage minimum, so the span is named a
  // resampling range and its level is stated as nominal. The level after the multiplicity rule
  // is still printed, which is what this assertion exists to check.
  assert.ok(table.includes('so the nominal per-interval level 0.95 (Bonferroni over 2 planned intervals) is not attained'), 'the level after the multiplicity rule is printed: ' + table)
  assert.ok(table.includes('Resampling range (too few clusters for coverage): 4 clusters resampled, fewer than 5'), 'a span over too few clusters is named a range: ' + table)
  assert.ok(table.includes('sorted draws') && table.includes('clusters resampled'))
  const ab = summary.contrasts.find(contrast => contrast.id === 'ab')
  assert.ok(ab.interval && ab.interval.low === ab.interval.high, 'the fixture really does produce a zero-width interval for two all-pass conditions')
  assert.ok(table.includes('Degenerate: every resample gave the same value'), 'a zero-width interval is named as degenerate rather than presented as a confidence interval')
  for (const text of both(files)) {
    const abstract = section(text, 'Abstract', 'Research question and design')
    const sentence = abstract.match(/Planned contrast (\w+) differs by ([^ ]+) \(interval ([^ ]+) to ([^)]+)\)/)
    assert.ok(sentence, 'the abstract states a planned contrast with its interval')
    for (const value of sentence.slice(2)) assert.ok(!/\.\d{5,}/.test(value), 'unrounded double in the abstract: ' + value)
    assert.ok(abstract.includes('percentile bootstrap interval under multiplicity bonferroni') && abstract.includes('2 planned contrasts'), 'the abstract states the level, kind, multiplicity and the contrast count')
  }
})

test('design-arm contrasts under Bonferroni divide alpha by the number of arm contrasts, not the condition-contrast count (stats audit F1)', async () => {
  // Attributed to root-sub-stats (sub/stats, 2026-09-11): arms holding one condition each must
  // reproduce the planned condition-contrast intervals when both families hold the same three
  // comparisons under multiplicity bonferroni.
  const shape = { tasks: 16, families: 16, passes: { a: 12, b: 8, c: 4 } }, pairs = [['a', 'b'], ['a', 'c'], ['b', 'c']]
  const arms = await run(draft({ ...shape, contrasts: [], design: { arms: ['a', 'b', 'c'].map(id => ({ id: 'arm-' + id, conditionIds: [id] })), contrasts: pairs.map(([x, y]) => ({ id: x + y, first: 'arm-' + x, second: 'arm-' + y })) } }))
  const conditions = await run(draft({ ...shape, contrasts: pairs.map(([x, y]) => ({ id: x + y, first: x, second: y })) }))
  assert.equal(arms.summary.design.contrasts.length, 3)
  for (const [index, row] of arms.summary.design.contrasts.entries()) {
    const reference = conditions.summary.contrasts[index]
    assert.equal(row.difference, reference.difference)
    assert.equal(row.interval.multiplicity, 'bonferroni')
    assert.deepEqual([row.interval.low, row.interval.high], [reference.interval.low, reference.interval.high], row.id + ': a three-contrast Bonferroni family must use alpha/3, as the condition contrasts do')
  }
  const files = await report(arms.project, arms.events)
  assert.ok(files['tables/design-arm-contrasts.csv'].includes('Bonferroni over 3 planned intervals'), 'the arm-contrast note states the family of three')
})

test('the abstract headline reports the declared primary population with its own eligible denominator (stats audit F2)', async () => {
  const { project, events, summary } = await run(draft({ split: i => i % 4 < 2 ? 'development' : 'held-out', population: { kind: 'split', split: 'held-out' } }))
  const md = unescapeMarkdown((await report(project, events))['report.md'])
  const headline = md.match(/Headline: (.*?)\. /)[1]
  const expected = summary.groups.map(group => group.condition + ' ' + group.primary.passed + '/' + group.primary.eligibleScheduled + ' (' + (group.primaryRate * 100).toFixed(1) + '%)').join('; ')
  assert.equal(headline, expected)
  assert.ok(summary.groups.every(group => group.primary.eligibleScheduled < group.scheduled), 'the fixture really does exclude development tasks from the primary population')
})
