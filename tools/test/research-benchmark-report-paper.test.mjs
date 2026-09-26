// The venue-format report package: every numbered item of the acceptance
// specification, asserted by generating real reports from real journals.
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { approveBundle, canonical } from '../../src/benchmark/prompts.mjs'
import { leanStarter } from '../../src/benchmark/lean.mjs'
import { bindLeanReview } from '../../src/benchmark/lean-codegen.mjs'
import { genericStarter, newExperimentDraft } from '../../src/benchmark/starters.mjs'
import { bindRuntimeSources, freezeStudy, RUNTIME_FILES } from '../../src/benchmark/study.mjs'
import { runStudy } from '../../src/benchmark/runner.mjs'
import { researchReportFiles } from '../../src/benchmark/report.mjs'
import { pageReportOptions } from './fixtures/research-page-report-options.mjs'
import { projectFiles } from '../../src/benchmark/export.mjs'
import { runProject } from '../../src/benchmark/cli.mjs'

const sources = async () => Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file =>
  [file, await readFile(new URL('../../src/benchmark/' + file, import.meta.url), 'utf8')])))
const REVIEWER = 'REPORT PAPER FIXTURE MARKER ONLY'

async function leanCanary({ purpose = 'recorded-diagnostic', edit = () => {} } = {}) {
  const bytes = await sources()
  let spec = newExperimentDraft(leanStarter(), { purpose })
  edit(spec)
  spec = await bindRuntimeSources(spec, bytes)
  spec = await bindLeanReview(spec, bytes)
  spec.catalog = await Promise.all(spec.catalog.map(bundle => approveBundle(bundle, REVIEWER, '2026-09-10T00:00:00.000Z', { catalog: spec.catalog })))
  return freezeStudy(spec)
}
async function generic({ approve = true, edit = () => {} } = {}) {
  let spec = newExperimentDraft(genericStarter(), { purpose: 'recorded-diagnostic' })
  edit(spec)
  spec = await bindRuntimeSources(spec, await sources())
  if (approve) spec.catalog = await Promise.all(spec.catalog.map(bundle => approveBundle(bundle, REVIEWER, '2026-09-10T00:00:00.000Z', { catalog: spec.catalog })))
  return freezeStudy(spec)
}
const report = (project, events, options) => researchReportFiles(project, events, options)
// report.md escapes markdown punctuation and report.html escapes markup, so a
// search for a frozen value must undo that escaping rather than pin its spelling.
const unescapeMarkdown = text => text.replace(/\\([\\`*_{}\[\]()#+.!|<>])/g, '$1')
const unescapeHtml = text => text.replace(/&(amp|lt|gt|quot|#39);/g, match =>
  ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }[match]))
const both = files => [unescapeMarkdown(files['report.md']), unescapeHtml(files['report.html'])]

test('item 1: front matter carries identity, and its generation time is the journal, never the wall clock', async () => {
  const project = await leanCanary()
  const result = await runStudy(project)
  const files = await report(project, result.events)
  const lastAt = [...result.events].reverse().find(event => event.at).at
  for (const text of both(files)) {
    assert.ok(text.includes(project.sha256), 'front matter states the frozen project digest')
    assert.ok(text.includes(project.spec.id), 'front matter states the study identifier')
    assert.ok(text.includes(project.tasks[0].compiled.compilerVersion), 'front matter states the compiler version')
    assert.ok(text.includes(lastAt), 'the generation time is the last journal timestamp')
  }
  await new Promise(done => setTimeout(done, 1100))
  const again = await report(project, result.events)
  assert.deepEqual(Object.keys(again).sort(), Object.keys(files).sort())
  for (const name of Object.keys(files)) assert.equal(again[name], files[name], name + ' is not reproducible')
})

test('item 2: the abstract states the design and names the evidence class of a recorded run', async () => {
  const project = await leanCanary()
  const files = await report(project, (await runStudy(project)).events)
  for (const text of both(files)) {
    assert.ok(/1 task\b/.test(text), 'abstract counts the frozen tasks')
    assert.ok(/1 condition\b/.test(text), 'abstract counts the frozen conditions')
    assert.ok(/recorded-response apparatus check, not a model result/.test(text), 'a replay-only run is not presented as a model result')
  }
})

test('item 3: frozen decisions appear verbatim, and an absent analysis plan prints Not declared without inventing an interval', async () => {
  const withPlan = await leanCanary()
  const planned = await report(withPlan, (await runStudy(withPlan)).events)
  assert.ok(planned['report.md'].includes(withPlan.spec.decisions), 'the frozen decisions text is reproduced verbatim')
  const bare = await generic({ edit: spec => { delete spec.analysisPlan } })
  const files = await report(bare, (await runStudy(bare)).events)
  for (const text of both(files)) {
    assert.ok(text.includes('Not declared'), 'absent fields say so')
    assert.ok(/No uncertainty procedure was declared/.test(text), 'no interval is claimed without a declared procedure')
  }
})

test('item 4: the composition layers, the complete compiled prompt and its character ranges are all shown', async () => {
  const project = await leanCanary()
  const files = await report(project, (await runStudy(project)).events)
  const task = project.tasks[0], compiled = task.compiled
  for (const role of ['Buy reason', 'Buy process', 'Sell reason', 'Sell process']) {
    assert.ok(unescapeMarkdown(files['report.md']).includes(role), 'the compiled prompt shows the ' + role + ' atom')
    assert.ok(unescapeHtml(files['report.html']).includes(role), 'the HTML report shows the ' + role + ' atom')
  }
  for (const node of compiled.composition.nodes) {
    assert.ok(unescapeMarkdown(files['report.md']).includes(node.bundle.sha256), 'composition node ' + node.path + ' states its bundle digest')
    assert.ok(unescapeMarkdown(files['report.md']).includes(node.path), 'composition node ' + node.path + ' is listed')
  }
  // A long verbatim slice can only come from the prompt block itself: the role
  // atoms above also appear in the composition table, so they cannot gate this.
  const slice = compiled.text.slice(0, 300)
  assert.ok(slice.length === 300, 'the fixture prompt is long enough to slice')
  for (const text of both(files)) assert.ok(text.includes(slice), 'the complete compiled prompt is reproduced verbatim in the report')
  assert.ok(unescapeMarkdown(files['report.md']).includes(String(compiled.sourceMap[0].end)), 'the layer map states character ranges')
  assert.equal(files['paper/prompts/' + task.id + '.txt'], compiled.text + '\n', 'the retained prompt is the compiled text exactly')
  assert.deepEqual(JSON.parse(files['paper/source-maps/' + task.id + '.json']).ranges, compiled.sourceMap)
  assert.deepEqual(JSON.parse(files['paper/composition/' + task.id + '.json']), compiled.composition)
  for (const appendix of compiled.composition.appendices) {
    assert.equal(files['paper/appendices/' + task.id + '-' + appendix.id + '.txt'], appendix.text + '\n', 'a runtime appendix is retained verbatim')
    assert.ok(unescapeMarkdown(files['report.md']).includes(appendix.source), 'the appendix names the source that produced it')
  }
})

test('item 5: each condition shows the exact request envelope that carries the compiled prompt', async () => {
  const project = await leanCanary()
  const files = await report(project, (await runStudy(project)).events)
  const condition = project.spec.conditions[0]
  const envelope = JSON.parse(files['paper/requests/' + condition.id + '.json'])
  assert.equal(envelope.prompt, project.tasks[0].compiled.text, 'the envelope carries the compiled prompt that was sent')
  assert.equal(envelope.projectSha256, project.sha256)
  assert.deepEqual(envelope.input, project.tasks[0].input)
  for (const text of both(files)) {
    assert.ok(text.includes(condition.adapter.kind), 'the condition table names the adapter kind')
    assert.ok(/Saved responses; no provider call/.test(text), 'a replay condition is labelled as saved responses')
  }
})

test('item 5: a command condition shows its command and names its credential variable, never a value', async () => {
  const project = await generic({ edit: spec => {
    spec.conditions[0].adapter = { kind: 'command', command: '/usr/bin/true', args: ['--model', 'x'], credentialEnv: 'FIXTURE_API_KEY' }
  } })
  const files = await report(project, [])
  for (const text of both(files)) {
    assert.ok(text.includes('FIXTURE_API_KEY'), 'the credential variable is named')
    assert.ok(text.includes('/usr/bin/true'), 'the exact command is shown')
  }
})

test('item 6: the protocol section states the schedule, the attempt limits and the grading kind', async () => {
  const project = await leanCanary()
  const files = await report(project, (await runStudy(project)).events)
  const protocol = project.spec.protocol
  for (const text of both(files)) {
    assert.ok(text.includes(String(protocol.maxAttemptsPerTrial)), 'attempt limit is stated')
    assert.ok(text.includes(String(protocol.timeoutMs)), 'attempt timeout is stated')
    assert.ok(text.includes(protocol.grading.kind), 'the grading kind is stated')
  }
})

test('item 7: results tables are introduced in plain language', async () => {
  const project = await leanCanary()
  const files = await report(project, (await runStudy(project)).events)
  for (const text of both(files)) {
    assert.ok(/how many trials met the criterion/.test(text) || /unmeasured trials stay visible in the denominator/.test(text),
      'at least one results table carries a plain-language introduction')
  }
})

test('item 8: the walkthrough lists every journal event', async () => {
  const project = await leanCanary()
  const result = await runStudy(project)
  const files = await report(project, result.events)
  for (const event of result.events) assert.ok(unescapeMarkdown(files['report.md']).includes(event.type), 'the walkthrough names event type ' + event.type)
  const rows = files['report.md'].split('\n').filter(line => /^\| \d+ \|/.test(line))
  assert.ok(rows.length >= result.events.length, 'the walkthrough has a row for every journal event')
})

test('item 9: a completed attempt retains the verbatim response, its prompt and its grade', async () => {
  const project = await leanCanary()
  const result = await runStudy(project)
  const files = await report(project, result.events)
  const finished = result.events.find(event => event.type === 'finished')
  const directory = 'trials/' + finished.trialId + '-' + finished.attempt + '/'
  const output = finished.response.output
  const expected = typeof output === 'string' ? output : JSON.stringify(JSON.parse(canonical(output)), null, 2)
  assert.equal(files[directory + 'response.txt'], expected + '\n', 'the model response is retained verbatim')
  assert.equal(files[directory + 'prompt.txt'], project.tasks[0].compiled.text + '\n')
  assert.deepEqual(JSON.parse(files[directory + 'grade.json']), JSON.parse(canonical(finished.grade)))
  assert.deepEqual(JSON.parse(files[directory + 'response.json']), JSON.parse(canonical(finished.response)))
  assert.ok(unescapeMarkdown(files['report.md']).includes('10700'), 'the graded trace values are visible in the report itself')
})

test('item 9: a failed attempt names its phase and reason instead of producing a grade', async () => {
  // A recorded condition missing one task's response fails through the owned
  // replay transport, so this is a real failed attempt, not an injected one.
  const project = await generic({ edit: spec => { delete spec.conditions[0].adapter.responses['addition-b'] } })
  const result = await runStudy(project)
  const files = await report(project, result.events)
  const failed = result.events.filter(event => event.type === 'finished' && event.status === 'failed')
  assert.equal(failed.length, 1, 'the fixture really does produce one failed attempt')
  for (const text of both(files)) {
    assert.ok(text.includes(failed[0].reason), 'the failure reason is shown')
    assert.ok(text.includes(failed[0].phase), 'the failure phase is shown')
  }
  assert.ok(!files['trials/' + failed[0].trialId + '-' + failed[0].attempt + '/grade.json'], 'a failed attempt produces no grade file')
})

test('item 9: a long response is capped in the report and kept whole in the trial file', async () => {
  const long = 'x'.repeat(9000)
  const project = await generic({ edit: spec => { spec.conditions[0].adapter.responses['addition-a'] = long } })
  const result = await runStudy(project)
  const files = await report(project, result.events)
  const finished = result.events.find(event => event.type === 'finished' && event.response?.output === long)
  assert.ok(finished, 'the fixture really does retain the long response')
  const directory = 'trials/' + finished.trialId + '-' + finished.attempt + '/'
  assert.equal(files[directory + 'response.txt'], long + '\n', 'the retained copy is never truncated')
  assert.ok(files['report.md'].includes('truncated; full text in'), 'the report says it truncated and where the whole text is')
  assert.ok(!files['report.md'].includes(long), 'the report does not carry the whole 9000-character response')
})

test('item 10: integrity lists the pinned runtime digests and the exact reproduction commands', async () => {
  const project = await leanCanary()
  const files = await report(project, (await runStudy(project)).events)
  for (const text of both(files)) {
    assert.ok(text.includes(project.spec.runtimeSources['report.mjs']), 'the report generator digest is listed')
    for (const command of ['node cli.mjs verify', 'node cli.mjs analyze']) assert.ok(text.includes(command), 'names ' + command)
  }
})

test('item 11: an unreviewed bundle is named as unreviewed', async () => {
  const project = await generic({ approve: false })
  const files = await report(project, (await runStudy(project)).events)
  const unreviewed = [...new Set(project.tasks.flatMap(task => task.compiled.bundles.filter(bundle => !bundle.approved).map(bundle => bundle.id)))]
  assert.ok(unreviewed.length, 'the fixture really does carry an unreviewed bundle')
  for (const text of both(files)) {
    assert.ok(/unreviewed/i.test(text), 'the report says the catalog is unreviewed')
    for (const id of unreviewed) assert.ok(text.includes(id), 'the unreviewed bundle ' + id + ' is named')
  }
})

test('item 12: the checklist answers each row from the frozen fields', async () => {
  const project = await leanCanary()
  const files = await report(project, (await runStudy(project)).events)
  for (const text of both(files)) {
    assert.ok(/Credentials never in the artifact/.test(text), 'the checklist covers credentials')
    assert.ok(text.includes(String(project.spec.protocol.seed)), 'the checklist reports the declared seed')
    assert.ok(/Not applicable/.test(text), 'a row with nothing to answer says Not applicable rather than Yes')
  }
})

test('the package stays additive: every file the generator produced before is still produced and listed', async () => {
  const project = await leanCanary()
  const files = await report(project, (await runStudy(project)).events)
  for (const name of ['report.html', 'report.md', 'analysis.json', 'execution.json', 'summary.json', 'conventions.json',
    'results.csv', 'figures/disposition.svg', 'execution-manifest.json', 'tables/execution-scope.csv', 'tables/conditions.csv',
    'tables/tasks.csv', 'tables/rates.csv', 'tables/dispositions.csv', 'tables/strata.csv', 'tables/identities.csv']) {
    assert.ok(files[name], name + ' is still part of the package')
  }
  const manifest = JSON.parse(files['execution-manifest.json'])
  assert.deepEqual(manifest.files, Object.keys(files).filter(name => name !== 'execution-manifest.json').sort(), 'the manifest lists every new file too')
  assert.ok(manifest.files.some(name => name.startsWith('paper/')), 'the manifest lists the paper artifacts')
  assert.ok(manifest.files.some(name => name.startsWith('trials/')), 'the manifest lists the per-trial evidence')
})

test('report generation does not mutate the project or the journal it was given', async () => {
  const project = await leanCanary()
  const result = await runStudy(project)
  const before = canonical({ project, events: result.events })
  await report(project, result.events)
  assert.equal(canonical({ project, events: result.events }), before)
})

// A registry in the shape the export runtime writes to provenance.json, with one
// entry of every class. Every value is a marker, so a rendered string can only
// have come from the registry, and a string from the wrong class is detectable.
const registry = ({ reused = true } = {}) => ({
  format: 'research-benchmark-provenance', version: 1, scope: 'Marker scope sentence for the provenance registry.',
  entries: [
    { id: 'marker-api', title: 'Marker API entry', appliesTo: ['marker/main.py'],
      codeProvenance: { kind: 'generated', basis: 'api', statement: 'Marker statement: written against an API.', upstreamSha256: null },
      upstream: { project: 'Marker API Provider', authors: 'API-AUTHORS-MUST-NOT-APPEAR', repositoryUrl: 'https://example.invalid/api', license: 'Apache-2.0',
        licenseNote: 'API-NOTICE-MUST-NOT-APPEAR', revision: { kind: 'image-digest', value: 'sha256:' + 'c'.repeat(64), labels: { marker_version: '7' }, note: 'Marker runtime note.' } },
      references: [{ kind: 'reviewed-source', citation: 'Marker BasicTemplate.py', url: 'https://example.invalid/api/BasicTemplate.py', revision: 'master', license: 'Apache-2.0', note: 'Reviewed for API usage only.' }] },
    { id: 'marker-method', title: 'Marker method entry', appliesTo: ['analysis.mjs markerInterval'],
      codeProvenance: { kind: 'generated', basis: 'method', statement: 'Marker statement: implements a method.', upstreamSha256: null },
      upstream: null,
      references: [{ kind: 'paper', citation: 'Marker, A. (1999). A marker paper.', url: 'https://example.invalid/paper', note: 'Marker reference note.' }] },
    ...(reused ? [
      { id: 'marker-reused', title: 'Marker reused entry', appliesTo: ['vendor/reused.py'],
        codeProvenance: { kind: 'reused', statement: 'Marker statement: copied verbatim.', upstreamSha256: 'd'.repeat(64), fetchedAt: '2026-09-10' },
        upstream: { project: 'Marker Reused Project', authors: 'Reused Marker Authors', repositoryUrl: 'https://example.invalid/reused', filePath: 'src/reused.py',
          license: 'MIT', licenseNote: 'Reused marker notice text.', revision: { kind: 'commit', value: 'e'.repeat(40) } },
        references: [] },
      { id: 'marker-adapted', title: 'Marker adapted entry', appliesTo: ['vendor/adapted.py'],
        codeProvenance: { kind: 'adapted', statement: 'Marker statement: adapted.', upstreamSha256: 'f'.repeat(64), fetchedAt: '2026-09-10', adaptations: ['Marker adaptation one.', 'Marker adaptation two.'] },
        upstream: { project: 'Marker Adapted Project', authors: 'Adapted Marker Authors', repositoryUrl: 'https://example.invalid/adapted', filePath: 'lib/adapted.py',
          license: 'BSD-3-Clause', licenseNote: 'Adapted marker notice text.', revision: { kind: 'tag', value: 'v1.2.3' } },
        references: [] },
    ] : []),
  ],
})
const attribution = text => text.slice(text.indexOf('Attribution and reused code'))
const between = (text, from, to) => { const start = text.indexOf(from); const end = to ? text.indexOf(to, start + from.length) : -1; return start < 0 ? '' : text.slice(start, end < 0 ? undefined : end) }

test('item 13: without a provenance registry the attribution section says Not declared and claims nothing', async () => {
  const project = await leanCanary()
  const files = await report(project, (await runStudy(project)).events)
  for (const text of both(files)) {
    const section = attribution(text)
    assert.ok(section.length > 0 && /Not declared/.test(section), 'the absent registry is named')
    assert.ok(!/Upstream project|Reference \(/.test(section), 'no upstream or citation is composed without a registry')
  }
  assert.equal(files['paper/provenance.json'], undefined)
})

test('item 13: reused and adapted code alone carry authors, source, revision, notices and adaptations', async () => {
  const project = await leanCanary(), document = registry()
  const files = await report(project, (await runStudy(project)).events, { provenance: document })
  for (const text of both(files)) {
    const section = attribution(text), reuse = between(section, 'Reused or adapted code', 'API dependencies')
    for (const value of ['Reused Marker Authors', 'https://example.invalid/reused src/reused.py', 'Reused marker notice text.', 'commit ' + 'e'.repeat(40), 'd'.repeat(64), '2026-09-10',
      'Adapted Marker Authors', 'Adapted marker notice text.', 'tag v1.2.3', 'Marker adaptation one.', 'Marker adaptation two.'])
      assert.ok(reuse.includes(value), 'the reused/adapted class shows ' + value)
    assert.ok(!section.includes('API-AUTHORS-MUST-NOT-APPEAR') && !section.includes('API-NOTICE-MUST-NOT-APPEAR'), 'an API dependency carries no authors or notice')
    const api = between(section, 'API dependencies', 'Newly generated code')
    assert.ok(api.includes('Marker API Provider') && api.includes('sha256:' + 'c'.repeat(64)), 'the API provider and pinned runtime are shown as a dependency')
    assert.ok(!reuse.includes('Marker API entry') && !reuse.includes('Marker method entry'), 'generated entries never appear as reused')
    assert.ok(between(section, 'Newly generated code', 'References consulted').includes('Marker method entry'), 'method-based code is listed as newly generated')
  }
  assert.deepEqual(JSON.parse(files['paper/provenance.json']), document, 'the registry is retained beside the report')
  assert.ok(JSON.parse(files['execution-manifest.json']).files.includes('paper/provenance.json'))
})

test('item 13: a reviewed upstream file is listed as a reference contributing no code, never as copied source', async () => {
  const project = await leanCanary()
  const files = await report(project, (await runStudy(project)).events, { provenance: registry() })
  for (const text of both(files)) {
    const section = attribution(text), references = between(section, 'References consulted (contribute no code)')
    assert.ok(references.includes('Marker BasicTemplate.py') && references.includes('reviewed at master'), 'the reviewed file is a consulted reference')
    assert.ok(!between(section, 'Reused or adapted code', 'API dependencies').includes('BasicTemplate'), 'it is not upgraded to reused code')
    const cited = registry().entries.flatMap(entry => entry.references).length
    assert.equal(section.split('Reference (').length - 1, cited, 'exactly the registry references are cited, no more')
  }
})

test('item 13: the no-reuse sentence appears only when the registry lists no reused or adapted code', async () => {
  const project = await leanCanary(), events = (await runStudy(project)).events
  const without = await report(project, events, { provenance: registry({ reused: false }) })
  const withReuse = await report(project, events, { provenance: registry() })
  for (const text of both(without)) assert.ok(/The registry records no reused or adapted code/.test(attribution(text)))
  for (const text of both(withReuse)) assert.ok(!/records no reused or adapted code/.test(attribution(text)), 'no blanket claim beside reused code')
  const blanketScope = { ...registry(), scope: 'No third-party source code is copied into this project.' }
  for (const text of both(await report(project, events, { provenance: blanketScope }))) {
    const section = attribution(text)
    assert.ok(/scope sentence claims that no third-party code is reused/.test(section), 'a blanket scope beside reused code is named as contradicted')
    assert.ok(!section.includes('No third-party source code is copied into this project.'), 'the contradicted blanket sentence is not repeated')
  }
})

test('item 13: ATTRIBUTIONS.md is retained verbatim, checked against the registry, and never trusted over it', async () => {
  const project = await leanCanary(), events = (await runStudy(project)).events
  const text = '# Attribution and reused code\n\n**No third-party source code is copied into this project.**\n\n## Marker API entry\n## Marker method entry\n'
  const files = await report(project, events, { provenance: registry(), attributions: text })
  assert.equal(files['paper/ATTRIBUTIONS.md'], text, 'retained byte for byte')
  for (const rendered of both(files)) {
    const section = attribution(rendered)
    assert.ok(/does not name 2 registry entries: Marker reused entry; Marker adapted entry/.test(section), 'entries missing from ATTRIBUTIONS.md are named')
    assert.ok(/ATTRIBUTIONS\.md claims that no third-party code is reused/.test(section), 'its blanket claim is named as contradicted by the registry')
  }
  const clean = await report(project, events, { provenance: registry({ reused: false }), attributions: text })
  for (const rendered of both(clean)) assert.ok(!/ATTRIBUTIONS\.md claims/.test(attribution(rendered)), 'no contradiction when the registry lists no reuse')
  await assert.rejects(report(project, events, { attributions: 42 }), /supplied as text/)
})

test('item 13: an unrecognised classification is named and not treated as code of any class', async () => {
  const project = await leanCanary(), document = registry({ reused: false })
  document.entries.push({ id: 'marker-odd', title: 'Marker odd entry', appliesTo: ['x'], codeProvenance: { kind: 'vendored-maybe', statement: 's' }, upstream: null, references: [] })
  const files = await report(project, (await runStudy(project)).events, { provenance: document })
  for (const text of both(files)) {
    const section = attribution(text)
    assert.ok(between(section, 'Unrecognised classifications').includes('Marker odd entry'))
    assert.ok(!between(section, 'Reused or adapted code', 'Unrecognised classifications').includes('Marker odd entry'))
    assert.ok(!/records no reused or adapted code/.test(section), 'no no-reuse sentence while an entry is unclassified')
  }
})

test('item 13: a document that is not a version-1 registry is refused by name and shows nothing from it', async () => {
  const project = await leanCanary()
  const files = await report(project, (await runStudy(project)).events, { provenance: { ...registry(), version: 99 } })
  for (const text of both(files)) {
    const section = attribution(text)
    assert.ok(/not a research-benchmark-provenance version 1 registry/.test(section))
    assert.ok(!section.includes('Marker API entry'), 'no entry from the refused document is shown')
  }
})

test('item 10: notices supplied with a rendering are shown in integrity and labelled as unverified', async () => {
  const project = await leanCanary(), result = await runStudy(project)
  const files = await report(project, result.events, { notices: ['Marker notice: this run started without a slot grant.'] })
  for (const text of both(files)) {
    const integrity = text.slice(text.indexOf('Integrity and reproduction'), text.indexOf('Limitations and threats to validity'))
    assert.ok(integrity.includes('Marker notice: this run started without a slot grant.'))
    assert.ok(/not part of the frozen project or the attempt journal/.test(integrity), 'the notice is labelled as outside the evidence')
  }
  const plain = await report(project, result.events)
  assert.ok(!plain['report.md'].includes('Marker notice'), 'no notice appears unless one is supplied')
  await assert.rejects(report(project, result.events, { notices: [42] }), /list of sentences/)
})

test('item 13: the exported CLI renders provenance.json and ATTRIBUTIONS.md beside the project byte-identically to the browser report', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'report-paper-cli-')); t.after(() => rm(root, { recursive: true, force: true }))
  const bytes = await sources(), project = await generic(), document = registry()
  const exported = await projectFiles(project, bytes, {})
  for (const [file, text] of Object.entries(exported)) { await mkdir(dirname(resolve(root, file)), { recursive: true }); await writeFile(resolve(root, file), text) }
  // An export whose runtime writes its own registry binds those files in its manifest; the CLI
  // reads them, and the page passes the same live registry. Otherwise place marker files beside it.
  const carried = 'provenance.json' in exported, live = await pageReportOptions({ project, sources: bytes })
  const provenance = carried ? live.provenance : document
  const attributions = carried ? live.attributions : '# Attribution and reused code\n\n## Marker API entry\n## Marker method entry\n## Marker reused entry\n## Marker adapted entry\n'
  if (!carried) { await writeFile(resolve(root, 'provenance.json'), JSON.stringify(document, null, 2) + '\n'); await writeFile(resolve(root, 'ATTRIBUTIONS.md'), attributions) }
  const result = await runProject(root)
  const analysis = spawnSync(process.execPath, [resolve(root, 'cli.mjs'), 'analyze'], { encoding: 'utf8', timeout: 30000, windowsHide: true })
  assert.equal(analysis.status, 0, analysis.stderr)
  // live is the page's own options, so the page side of this parity carries the same
  // runtime-integrity digests the exported CLI computes from its own files.
  const expected = await report(project, result.events, { provenance, attributions, manifest: live.manifest, runtimeIntegrity: live.runtimeIntegrity })
  for (const text of both(expected)) assert.ok(text.includes('It names every registry entry.'), 'ATTRIBUTIONS.md beside the project is read and checked')
  for (const file of ['report.html', 'report.md', 'paper/provenance.json', 'paper/ATTRIBUTIONS.md', 'execution-manifest.json'])
    assert.equal(await readFile(resolve(root, 'results', file), 'utf8'), expected[file], file)
})

test('item 9: a native-graded attempt with a divergent trace names the first differing entry', async () => {
  const image = 'quantconnect/lean@sha256:' + 'a'.repeat(64)
  const project = await leanCanary({ purpose: 'apparatus-development', edit: spec => {
    spec.environment.leanImage = image; spec.protocol.grading = { kind: 'lean-python', executionTimeoutMs: 30000 }
    // lean-python grades a program, so the saved response is one; the grade below is supplied directly.
    spec.conditions[0].adapter.responses = { 'flat-canary': '# REPORT PAPER MARKER PROGRAM; NEVER EXECUTED\n' }
  } })
  const trace = structuredClone(project.tasks[0].expected); trace[1].priceCents = 10600
  const result = await runStudy(project, { grade: async () => ({ passed: false, score: 0, classification: 'trace-mismatch', image,
    candidateSha256: 'b'.repeat(64), execution: { exitCode: 0, stdout: '', stderr: 'marker engine log line' }, trace }) })
  const files = await report(project, result.events)
  const finished = result.events.find(event => event.type === 'finished'), directory = 'trials/' + finished.trialId + '-' + finished.attempt + '/'
  assert.deepEqual(JSON.parse(files[directory + 'native-trace.json']), trace, 'the observed native trace is retained')
  assert.deepEqual(JSON.parse(files[directory + 'expected-trace.json']), project.tasks[0].expected, 'the expected trace is retained beside it')
  for (const text of both(files)) {
    assert.ok(/First divergence at entry 1/.test(text), 'the first differing entry is named')
    assert.ok(text.includes('10600') && text.includes('10700'), 'both differing values are shown')
    assert.ok(text.includes('marker engine log line'), 'the engine log is shown')
    assert.ok(text.includes('trace-mismatch'), 'the grade classification is shown')
  }
})

test('item 2: an apparatus-development run that collected live responses is not called a recorded-response check', async () => {
  const project = await leanCanary({ purpose: 'apparatus-development', edit: spec => {
    spec.conditions.push({ id: 'live-command', label: 'Live command', model: { provider: 'marker', id: 'marker-model', settings: {} }, adapter: { kind: 'command', command: '/usr/bin/true', args: [] } })
  } })
  const files = await report(project, [])
  for (const text of both(files)) {
    const abstract = text.slice(text.indexOf('Abstract'), text.indexOf('Research question and design'))
    assert.ok(!/recorded-response apparatus check/.test(abstract), 'a run with a live condition is not labelled recorded-response')
    assert.ok(/apparatus-development evidence/.test(abstract) && /not a qualified model result/.test(abstract), 'it is labelled development evidence')
  }
  const recorded = await leanCanary({ purpose: 'apparatus-development' })
  assert.ok(/recorded-response apparatus check/.test((await report(recorded, [])) ['report.md']), 'an all-replay run keeps the recorded-response label')
})

test('item 9: the identity and usage the adapter reported are printed verbatim beside the declared identity', async () => {
  const usage = { requestedModel: 'marker-requested-model', reportedModels: ['marker-reported-a', 'marker-reported-b'], numTurns: 2, totalCostUsd: 0.159, permissionDenials: 0 }
  const project = await leanCanary({ purpose: 'apparatus-development', edit: spec => {
    spec.conditions[0] = { ...spec.conditions[0], model: { provider: 'marker-provider', id: 'marker-declared-model', settings: {} }, adapter: { kind: 'command', command: '/usr/bin/true', args: [] } }
  } })
  const events = (await runStudy(project, { adapter: async ({ task }) => ({ output: task.expected, usage, markerAdapterField: { applied: 'marker-applied-value' } }) })).events
  const files = await report(project, events)
  for (const text of both(files)) {
    const trial = text.slice(text.indexOf('Per-trial evidence'), text.indexOf('Integrity and reproduction'))
    assert.ok(trial.includes('Declared model') && trial.includes('marker-declared-model'), 'the declared identity is shown')
    assert.ok(trial.includes('usage.requestedModel (reported by the adapter)') && trial.includes('marker-requested-model'), 'the requested model the adapter reported is shown')
    assert.ok(trial.includes('usage.reportedModels (reported by the adapter)') && trial.includes('["marker-reported-a","marker-reported-b"]'), 'the reported models are shown verbatim')
    assert.ok(trial.includes('usage.numTurns (reported by the adapter)') && trial.includes('usage.totalCostUsd (reported by the adapter)') && trial.includes('0.159'), 'turns and cost are shown')
    assert.ok(trial.includes('markerAdapterField.applied (reported by the adapter)') && trial.includes('marker-applied-value'), 'any other retained envelope field is shown, not dropped')
    assert.match(trial, /Identity \(reported by the adapter\) \| Not declared|Identity \(reported by the adapter\)<\/th><td>Not declared/, 'an identity the adapter did not report is Not declared')
  }
  const replayed = await report(await leanCanary(), (await runStudy(await leanCanary())).events)
  for (const text of both(replayed)) assert.match(text, /Usage \(reported by the adapter\) \| Not declared|Usage \(reported by the adapter\)<\/th><td>Not declared/, 'saved responses without usage say Not declared')
})
