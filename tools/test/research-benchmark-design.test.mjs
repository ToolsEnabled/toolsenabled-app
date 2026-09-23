// Grouped assignment design (spec.designPlan, contract version 1): arms,
// draw units, phases and arm contrasts as representation and analysis
// grouping over the frozen crossed schedule. Synthetic recorded responses only.
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { register } from 'node:module'
import { canonical } from '../../src/benchmark/prompts.mjs'
import { analyze, validateDesignPlan, DESIGN_PLAN_VERSION, endpointRecord } from '../../src/benchmark/analysis.mjs'
import { bindRuntimeSources, freezeStudy, RUNTIME_FILES, validateStudy } from '../../src/benchmark/study.mjs'
import { runStudy } from '../../src/benchmark/runner.mjs'
import { researchReportFiles } from '../../src/benchmark/report.mjs'
import { projectFiles } from '../../src/benchmark/export.mjs'
import { genericStarter } from '../../src/benchmark/starters.mjs'
import { developmentDraft } from './fixtures/research-benchmark-development.mjs'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { designRowsFromPlan, designPlanFromRows, createDesignFieldsEditor } from '../../src/research-design-fields.js'

const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async name => [name, await readFile(new URL('../../src/benchmark/' + name, import.meta.url), 'utf8')])))
const SITES = ['s1', 's2', 's3']
// Six tasks: two per site, so a draw under one condition and replicate groups both tasks of a site.
function study({ phases = true, contrasts = true, unit = true, arms = true } = {}) {
  const spec = developmentDraft(genericStarter()), template = spec.tasks[0]
  spec.name = 'Grouped design fixture'; spec.id = 'grouped-design'
  spec.tasks = SITES.flatMap((site, s) => [1, 2].map(member => ({ ...structuredClone(template), id: `${site}-t${member}`, familyId: site, split: s < 2 ? 'development' : 'held-out',
    variables: { a: s + 1, b: member * 10 }, expected: String(s + 1 + member * 10), factors: { site, member: 'm' + member } })))
  const all = Object.fromEntries(spec.tasks.map(task => [task.id, task.expected]))
  const flawed = Object.fromEntries(spec.tasks.map(task => [task.id, task.factors.site === 's3' ? 'wrong' : task.expected]))
  spec.conditions = [{ ...spec.conditions[0], id: 'seq', adapter: { kind: 'replay', responses: all } }, { ...spec.conditions[0], id: 'iso', adapter: { kind: 'replay', responses: flawed } }]
  spec.protocol.replicates = 5; spec.protocol.maxTotalAttempts = 1000
  spec.analysisPlan.primaryPopulation = 'all'
  spec.analysisPlan.contrasts = []
  spec.analysisPlan.uncertainty = { kind: 'cluster-bootstrap', clusterBy: { factor: 'site' }, seed: 7, iterations: 200, confidence: 0.9 }
  spec.designPlan = { version: DESIGN_PLAN_VERSION, rationale: 'Synthetic arms ladder: one sequential arm and one isolation arm over three sites with two colliding tasks each.',
    ...(arms ? { arms: [{ id: 'sequential', conditionIds: ['seq'], label: 'One task at a time' }, { id: 'isolation', conditionIds: ['iso'] }] } : {}),
    ...(unit ? { unit: { kind: 'draw', groupBy: 'factor:site', members: 2 } } : {}),
    ...(phases ? { phases: [{ id: 'pilot', draws: 2, factorLevels: { site: ['s1', 's2'] } }, { id: 'main', draws: 3, requiresRecordedDecision: 'pilot' }] } : {}),
    ...(contrasts && arms ? { contrasts: [{ id: 'isolation-vs-sequential', first: 'isolation', second: 'sequential' }] } : {}) }
  return spec
}
const frozen = async spec => freezeStudy(await bindRuntimeSources(spec, sources))
const refuse = (mutate, pattern) => { const spec = study(); mutate(spec); assert.throws(() => validateDesignPlan(spec), pattern) }
const ticking = () => { let clock = 1700000000000; return () => (clock += 250) }
async function exported(t, project, attachments = {}) {
  const root = await mkdtemp(resolve(tmpdir(), 'research-design-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const files = await projectFiles(project, sources, attachments)
  for (const [file, text] of Object.entries(files)) { await mkdir(dirname(resolve(root, file)), { recursive: true }); await writeFile(resolve(root, file), text) }
  return { root, files }
}
const cli = (root, ...args) => spawnSync(process.execPath, [resolve(root, 'cli.mjs'), ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

test('validation refuses malformed arms, draws, phases and contrasts', () => {
  validateDesignPlan(study()); validateStudy(study())
  refuse(spec => { spec.designPlan.version = 2 }, /needs version 1/)
  refuse(spec => { spec.designPlan.extra = true }, /unsupported fields/)
  refuse(spec => { spec.designPlan.rationale = ' ' }, /design rationale/)
  refuse(spec => { spec.designPlan.arms[0].conditionIds = ['seq', 'iso'] }, /exactly one arm/)
  refuse(spec => { spec.designPlan.arms[1].conditionIds = [] }, /exactly one arm/)
  refuse(spec => { spec.designPlan.arms[1].conditionIds = ['nope'] }, /exactly one arm/)
  refuse(spec => { spec.designPlan.arms = [spec.designPlan.arms[0]] }, /Every condition must belong to exactly one arm/)
  refuse(spec => { spec.designPlan.arms[0].id = 'seq' }, /not also a condition identifier/)
  refuse(spec => { spec.designPlan.unit.members = 3 }, /every group needs exactly 3/)
  refuse(spec => { spec.designPlan.unit.groupBy = 'factor:missing' }, /needs the draw factor missing/)
  refuse(spec => { spec.designPlan.unit.groupBy = 'site' }, /groupBy is "factor:<id>"/)
  refuse(spec => { spec.designPlan.phases[1].draws = 4 }, /Phase draws must sum to protocol.replicates \(5\); the phases declare 6/)
  refuse(spec => { spec.designPlan.phases[0].requiresRecordedDecision = 'main' }, /names an earlier phase/)
  refuse(spec => { spec.designPlan.phases[0].factorLevels = { site: [] } }, /distinct scalar levels/)
  refuse(spec => { spec.designPlan.phases[0].factorLevels = { nope: ['s1'] } }, /declared task factors/)
  refuse(spec => { spec.designPlan.contrasts[0].second = 'isolation' }, /two different declared arms/)
  refuse(spec => { spec.designPlan.contrasts[0].first = 'seq' }, /two different declared arms/)
  refuse(spec => { delete spec.designPlan.arms }, /Arm contrasts need declared arms/)
  refuse(spec => { spec.schemaVersion = 1 }, /requires specification version 2/)
})

test('the frozen schedule keeps every crossed trial except phase-excluded ones, annotates arms, units and phases, and keeps draw members adjacent', async () => {
  const project = await frozen(study()), again = await frozen(study())
  assert.equal(project.sha256, again.sha256, 'freezing is deterministic')
  assert.equal(project.schedule.length, 52); assert.equal(project.design.scheduled, 52); assert.equal(project.design.units, 26)
  assert.equal(project.design.excludedTrials.length, 8)
  assert.ok(project.design.excludedTrials.every(id => id.startsWith('s3-') && /\.[12]$/.test(id)), 'only s3 trials of the pilot replicates are unscheduled')
  for (const row of project.schedule) {
    assert.equal(row.armId, row.conditionId === 'seq' ? 'sequential' : 'isolation')
    assert.equal(row.unitId, `${row.conditionId}/"${row.taskId.slice(0, 2)}"/${row.replicate}`)
    assert.equal(row.memberIndex, Number(row.taskId.at(-1)))
    assert.equal(row.phase, row.replicate <= 2 ? 'pilot' : 'main')
  }
  for (let i = 0; i < project.schedule.length; i += 2) {
    assert.equal(project.schedule[i].unitId, project.schedule[i + 1].unitId, 'members of a draw are adjacent')
    assert.deepEqual([project.schedule[i].memberIndex, project.schedule[i + 1].memberIndex], [1, 2])
  }
  const plain = await frozen(study({ phases: false, unit: false, contrasts: false, arms: false }))
  assert.equal(plain.schedule.length, 60); assert.deepEqual(plain.design.arms.map(arm => arm.id), ['seq', 'iso']); assert.equal(plain.design.unit, undefined)
  assert.ok(plain.schedule.every(row => row.memberIndex === 1 && row.unitId === `${row.conditionId}/${row.taskId}/${row.replicate}` && row.phase === undefined))
  const crossed = study(); delete crossed.designPlan
  const bare = await frozen(crossed)
  assert.equal(bare.design, undefined); assert.equal(bare.schedule.length, 60)
  assert.ok(bare.schedule.every(row => row.armId === undefined && row.unitId === undefined))
})

test('analysis reports arms, draw units, phases and arm contrasts with cluster intervals, and typed endpoints can read the draw-level record', async t => {
  const spec = study()
  spec.analysisPlan.endpoints = [
    { id: 'members-done', kind: 'rate', source: { path: ['unit', 'completedMembers'] }, exposure: { path: ['unit', 'wallMs'], unit: 'wall-ms' }, direction: 'higher-better', primary: false, unit: 'members per wall-ms', rationale: 'Completed draw members over the draw wall time.' },
    { id: 'draw-passed', kind: 'binary', source: { path: ['unit', 'allPassed'] }, direction: 'higher-better', primary: false, unit: 'draws', rationale: 'Every member of the draw passed.' },
  ]
  const project = await frozen(spec), result = await runStudy(project, { now: ticking() })
  assert.equal(result.summary.completed, 52)
  const design = result.summary.design
  // Isolation answers wrong on both s3 tasks; s3 is scheduled only in the three main-phase replicates: 2 × 3 = 6 failures.
  assert.deepEqual(design.arms.map(row => [row.arm, row.scheduled, row.passed]), [['sequential', 26, 26], ['isolation', 26, 20]])
  assert.equal(design.arms[0].label, 'One task at a time'); assert.equal(design.arms[1].label, null)
  assert.equal(design.units.length, 26)
  for (const unit of design.units) {
    assert.equal(unit.members, 2); assert.equal(unit.completedMembers, 2)
    const members = result.summary.rows.filter(row => row.unitId === unit.unitId)
    assert.equal(unit.wallMs, Math.max(...members.map(row => row.latencyMs))); assert.equal(unit.agentMs, members.reduce((sum, row) => sum + row.latencyMs, 0))
    assert.equal(unit.allPassed, members.every(row => row.passed))
  }
  assert.deepEqual(design.phases.map(row => [row.phase, row.draws, row.scheduled, row.decision]), [['pilot', 2, 16, null], ['main', 3, 36, 'not-evaluated']])
  const contrast = design.contrasts[0]
  assert.equal(contrast.id, 'isolation-vs-sequential'); assert.equal(contrast.firstRate, 20 / 26); assert.equal(contrast.secondRate, 1)
  assert.equal(contrast.families, 3); assert.ok(contrast.interval && contrast.interval.low <= contrast.difference && contrast.difference <= contrast.interval.high)
  assert.equal(contrast.interval.kind, 'paired cluster percentile bootstrap')
  assert.deepEqual(result.summary.strata.filter(row => row.dimension === 'arm').map(row => [row.value, row.condition, row.scheduled]), [['isolation', 'seq', 0], ['isolation', 'iso', 26], ['sequential', 'seq', 26], ['sequential', 'iso', 0]])
  assert.deepEqual([...new Set(result.summary.strata.filter(row => row.dimension === 'phase').map(row => row.value))].sort(), ['main', 'pilot'])
  const typed = result.summary.endpoints
  const rate = typed.arms.find(row => row.arm === 'sequential' && row.endpoint === 'members-done')
  assert.equal(rate.n, 26); assert.equal(rate.numerator, 52); assert.ok(rate.exposure > 0 && rate.rate === 52 / rate.exposure)
  const passed = typed.arms.find(row => row.arm === 'isolation' && row.endpoint === 'draw-passed')
  assert.equal(passed.k, 20, 'the three s3 isolation draws fail in both member trials'); assert.equal(passed.n, 26)
  assert.equal(typed.armContrasts[0].id, 'isolation-vs-sequential'); assert.equal(typed.armContrasts.length, 2)
  const record = endpointRecord(project, result.summary.rows[0], null, null, design.units[0])
  assert.deepEqual(record.unit, { members: 2, completedMembers: 2, allPassed: design.units[0].allPassed, wallMs: design.units[0].wallMs, agentMs: design.units[0].agentMs })
  assert.deepEqual(endpointRecord(project, result.summary.rows[0], null, null).unit, null)
  assert.ok(result.summary.limitations.some(text => text.startsWith('Draw units group the tasks')))
  // Reports carry the design tables and sidecar, and the CLI writes the same bytes.
  const files = await researchReportFiles(project, result.events)
  for (const table of ['design-arms', 'design-units', 'design-phases', 'design-arm-contrasts', 'design-endpoint-arms', 'design-endpoint-arm-contrasts']) assert.ok(files['tables/' + table + '.csv'], table)
  assert.equal(JSON.parse(files['design.json']).units.length, 26)
  const { root, files: exportedFiles } = await exported(t, project)
  assert.ok(exportedFiles['design/plan.json']); assert.equal(JSON.parse(exportedFiles['design/plan.json']).excludedTrials.length, 8)
  assert.equal(cli(root, 'verify').status, 0)
  const output = resolve(root, 'results'); await mkdir(output, { recursive: true })
  await writeFile(resolve(output, 'attempts.jsonl'), result.events.map(event => JSON.stringify(event)).join('\n') + '\n')
  const analyzed = cli(root, 'analyze', '--output', output)
  assert.equal(analyzed.status, 0, analyzed.stderr)
  for (const file of Object.keys(files).filter(file => file.startsWith('tables/design') || file === 'design.json')) assert.equal(await readFile(resolve(output, file), 'utf8'), files[file], file)
  await writeFile(resolve(root, 'design', 'plan.json'), exportedFiles['design/plan.json'].replace('"excludedTrials"', '"excluded"'))
  assert.notEqual(cli(root, 'verify').status, 0, 'a changed design artifact refuses verification')
})

test('a project without a design plan has no design summary, sidecar or annotations', async () => {
  const spec = study(); delete spec.designPlan; spec.analysisPlan.uncertainty = null
  const project = await frozen(spec), result = await runStudy(project, { now: ticking() })
  assert.equal(result.summary.design, undefined)
  assert.ok(result.summary.strata.every(row => !['arm', 'phase'].includes(row.dimension)))
  const files = await researchReportFiles(project, result.events)
  assert.equal(files['design.json'], undefined); assert.ok(Object.keys(files).every(file => !file.includes('design')))
})

// Builder: the design plan is an ordinary editor group in the Protocol panel.
register('./css-loader.mjs', import.meta.url)
const { createBenchmarkBuilder } = await import('../../src/research-benchmark.js')
test('the builder mounts labeled design fields that round-trip, refuse without losing the draft, apply, remove, and keep the advanced JSON path', async t => {
  const installed = installDomStandIn(globalThis)
  const values = new Map(), account = { async getSetting(key) { return { ok: true, value: values.get(key) ?? null } }, async putSetting(key, value) { values.set(key, value); return { ok: true } } }
  const view = createBenchmarkBuilder({ account, loadSources: async () => sources, download: () => {} })
  t.after(() => { view.destroy(); view.el.remove(); installed.restore() })
  document.body.append(view.el); await view.setContext('rp-' + 'a'.repeat(36), 'live')
  const field = name => view.el.querySelector('[data-bench-' + name + ']'), df = name => view.el.querySelector('[data-design-fields-' + name + ']'), all = name => [...view.el.querySelectorAll('[data-design-fields-' + name + ']')]
  const status = () => field('status').textContent, specPlan = () => JSON.parse(field('spec-json').value).designPlan
  const idle = async () => { for (let n = 0; n < 1400; n++) { if (view.el.getAttribute('aria-busy') === 'false') return; await new Promise(resolve => setTimeout(resolve, 3)) } assert.fail(status()) }
  const type = (node, value) => { node.value = value; node.dispatch('input') }
  await idle()
  const draft = study(); delete draft.runtimeSources
  const text = JSON.stringify({ spec: draft }), node = field('import')
  node.files = [{ name: 'design-draft.json', size: Buffer.byteLength(text), text: async () => text }]; node.dispatch('change'); await idle()
  assert.match(status(), /Draft imported/)
  assert.equal(df('present').checked, true, 'the design switch reflects the imported plan')
  assert.match(field('design-fields-status').textContent, /design is applied/, 'the freshly imported plan reads as applied before any field is touched')
  // Keystroke by keystroke through the real builder callback path (changed() ->
  // syncControls() -> designEditor.setDisabled(locked || running), which is
  // false both before and after every keystroke here): the focused label
  // input must survive every re-render, including a mid-string edit.
  const labelInput = all('arm-label')[1]
  labelInput.focus()
  for (const [index] of [...'Isolated'].entries()) {
    labelInput.value = 'Isolated'.slice(0, index + 1); labelInput.dispatch('input'); await idle()
    assert.ok(all('arm-label')[1] === labelInput, 'keystroke ' + (index + 1) + ' keeps the same input mounted')
    assert.ok(labelInput.isConnected, 'keystroke ' + (index + 1) + ' leaves the input connected')
    assert.ok(document.activeElement === labelInput, 'keystroke ' + (index + 1) + ' leaves focus on the same input')
  }
  assert.equal(labelInput.value, 'Isolated')
  // A mid-string edit (not just appends at the end).
  labelInput.value = 'Isolatd'; labelInput.dispatch('input'); await idle()
  assert.ok(all('arm-label')[1] === labelInput, 'a mid-string edit keeps the same input mounted')
  assert.ok(document.activeElement === labelInput, 'a mid-string edit leaves focus on the same input')
  assert.equal(labelInput.value, 'Isolatd')
  type(labelInput, '')
  // Typing an arm identifier (a `refresh: true` binding) keeps its own input in
  // place too, and refreshes the dependent contrast options and the phase
  // decision selects in place, without rebuilding them, on every keystroke.
  const idInput = all('arm-id')[1], firstPhaseDecision = df('phase-decision')
  idInput.focus()
  for (const value of ['isolationx', 'isolatonx', 'isolationx', 'isolation']) {
    idInput.value = value; idInput.dispatch('input'); await idle()
    assert.ok(all('arm-id')[1] === idInput, 'retyping the identifier to "' + value + '" keeps the same input mounted')
    assert.ok(idInput.isConnected, 'retyping the identifier to "' + value + '" leaves the input connected')
    assert.ok(document.activeElement === idInput, 'retyping the identifier to "' + value + '" leaves focus on the same input')
    assert.ok([...df('contrast-first').querySelectorAll('option')].some(option => option.value === value), 'the contrast-first options follow the typed identifier in place')
    assert.ok([...df('contrast-second').querySelectorAll('option')].some(option => option.value === value), 'the contrast-second options follow the typed identifier in place')
    assert.ok(df('phase-decision') === firstPhaseDecision, 'an unrelated phase-decision select is not rebuilt while an arm identifier is typed')
    assert.match(df('summary').textContent, /^2 arms, draw unit on site, 2 phases, 1 contrast\.$/, 'the summary sentence stays in place')
  }
  assert.equal(idInput.value, 'isolation', 'the identifier is restored to its original value')
  assert.equal(all('arm').length, 2); assert.equal(df('unit-factor').value, 'site'); assert.equal(df('unit-members').value, '2'); assert.equal(all('phase').length, 2); assert.equal(all('contrast').length, 1)
  assert.equal(all('arm')[0].querySelector('[data-design-fields-arm-condition="seq"]').checked, true); assert.equal(all('arm')[0].querySelector('[data-design-fields-arm-condition="iso"]').checked, false)
  // Unfinished members text refuses by name and keeps the rows and the applied plan.
  type(df('unit-members'), 'x'); assert.match(field('design-fields-status').textContent, /Design fields changed/)
  field('apply-design').click(); await idle()
  assert.match(status(), /Draw unit: members per draw must be a whole number/)
  assert.equal(df('unit-members').value, 'x', 'the unfinished text stays on screen'); assert.deepEqual(specPlan(), draft.designPlan, 'the applied plan is unchanged by the refusal')
  type(df('unit-members'), '2'); type(all('phase-draws')[1], '4')
  field('apply-design').click(); await idle()
  assert.match(status(), /Phase draws must sum to protocol.replicates \(5\); the phases declare 6/)
  assert.deepEqual(specPlan(), draft.designPlan)
  type(all('phase-draws')[1], '3')
  field('apply-design').click(); await idle()
  assert.match(status(), /Design plan applied/)
  assert.deepEqual(specPlan(), draft.designPlan, 'labeled fields round-trip the exact contract')
  // An extra arm claiming a condition twice refuses through the shared validation; removing it recovers.
  df('add-arm').click(); await idle()
  assert.equal(all('arm').length, 3)
  type(all('arm-id')[2], 'extra'); const box = all('arm')[2].querySelector('[data-design-fields-arm-condition="seq"]'); box.checked = true; box.dispatch('input')
  field('apply-design').click(); await idle(); assert.match(status(), /exactly one arm/)
  assert.equal(all('arm').length, 3, 'the refused extra arm is still on screen')
  all('remove-arm')[2].click(); await idle(); field('apply-design').click(); await idle(); assert.match(status(), /Design plan applied/)
  assert.deepEqual(specPlan(), draft.designPlan)
  // The advanced JSON path still applies the same contract and refuses through the same validation.
  field('design-plan').value = JSON.stringify({ ...draft.designPlan, arms: [{ id: 'seq', conditionIds: ['seq'] }, { id: 'isolation', conditionIds: ['iso'] }] }); field('design-plan').dispatch('input')
  field('apply-design-json').click(); await idle(); assert.match(status(), /not also a condition identifier/)
  field('design-plan').value = JSON.stringify({ ...draft.designPlan, rationale: 'Applied through the advanced JSON editor.' }); field('design-plan').dispatch('input')
  field('apply-design-json').click(); await idle(); assert.match(status(), /Design plan applied/)
  assert.equal(specPlan().rationale, 'Applied through the advanced JSON editor.'); assert.equal(df('rationale').value, 'Applied through the advanced JSON editor.', 'the fields follow the JSON apply')
  // Switching the design off removes it.
  df('present').checked = false; df('present').dispatch('input')
  field('apply-design').click(); await idle(); assert.match(status(), /Design plan removed/)
  assert.equal(specPlan(), undefined); assert.match(field('design-fields-status').textContent, /No design is applied/)
})

// syncDesignFields staleness: the design rows compare equal (both empty) on
// a fresh import with no design plan, but the arm-condition checkboxes and
// phase factor lists must still follow the NEWLY loaded project's conditions
// and task factors, not whatever project was mounted before it.
test('the design fields editor follows the loaded project\'s conditions and factors even when the design rows compare equal', async t => {
  const installed = installDomStandIn(globalThis)
  const values = new Map(), account = { async getSetting(key) { return { ok: true, value: values.get(key) ?? null } }, async putSetting(key, value) { values.set(key, value); return { ok: true } } }
  const view = createBenchmarkBuilder({ account, loadSources: async () => sources, download: () => {} })
  t.after(() => { view.destroy(); view.el.remove(); installed.restore() })
  document.body.append(view.el); await view.setContext('rp-' + 'b'.repeat(36), 'live')
  const field = name => view.el.querySelector('[data-bench-' + name + ']'), df = name => view.el.querySelector('[data-design-fields-' + name + ']'), all = name => [...view.el.querySelectorAll('[data-design-fields-' + name + ']')]
  const status = () => field('status').textContent
  const idle = async () => { for (let n = 0; n < 1400; n++) { if (view.el.getAttribute('aria-busy') === 'false') return; await new Promise(resolve => setTimeout(resolve, 3)) } assert.fail(status()) }
  const responses = { 'addition-a': '5', 'addition-b': '11' }
  await idle()
  // The default project the view starts on has the starter's own 'recorded'
  // condition; that is the stale value a fixed bug would leak into the next
  // project's checkboxes.
  const draftA = developmentDraft(genericStarter())
  draftA.conditions = [{ ...draftA.conditions[0], id: 'seq', adapter: { kind: 'replay', responses } }, { ...draftA.conditions[0], id: 'iso', adapter: { kind: 'replay', responses } }]
  delete draftA.runtimeSources
  const textA = JSON.stringify({ spec: draftA })
  field('import').files = [{ name: 'design-draft-a.json', size: Buffer.byteLength(textA), text: async () => textA }]; field('import').dispatch('change'); await idle()
  assert.match(status(), /Draft imported/)
  df('present').checked = true; df('present').dispatch('input'); await idle()
  df('add-arm').click(); await idle()
  assert.deepEqual(all('arm-condition').map(box => box.getAttribute('data-design-fields-arm-condition')).sort(), ['iso', 'seq'], 'the first arm added after import shows THIS project\'s conditions, not a stale project\'s')

  // Import a second, different project (different conditions, a real task
  // factor) with no design plan either; the checkboxes and the phase factor
  // list must follow it too, not the first project.
  const draftB = developmentDraft(genericStarter())
  draftB.conditions = [{ ...draftB.conditions[0], id: 'alpha', adapter: { kind: 'replay', responses } }, { ...draftB.conditions[0], id: 'beta', adapter: { kind: 'replay', responses } }]
  draftB.tasks = draftB.tasks.map(task => ({ ...task, factors: { region: task.id === 'addition-a' ? 'north' : 'south' } }))
  delete draftB.runtimeSources
  const textB = JSON.stringify({ spec: draftB })
  field('import').files = [{ name: 'design-draft-b.json', size: Buffer.byteLength(textB), text: async () => textB }]; field('import').dispatch('change'); await idle()
  assert.match(status(), /Draft imported/)
  df('present').checked = true; df('present').dispatch('input'); await idle()
  df('add-arm').click(); await idle()
  assert.deepEqual(all('arm-condition').map(box => box.getAttribute('data-design-fields-arm-condition')).sort(), ['alpha', 'beta'], 'a second, different project follows through too')
  df('unit-enabled').checked = true; df('unit-enabled').dispatch('input'); await idle()
  assert.deepEqual([...df('unit-factor').querySelectorAll('option')].map(option => option.value).filter(Boolean), ['region'], 'the draw-unit factor choices follow the new project\'s task factors')
  df('add-phase').click(); await idle()
  assert.equal(all('phase-levels').length, 1, 'the phase factor-level input follows the new project\'s task factor')
})

// Reviewer-reproduced defects applied to the design editor: keystroke typing
// keeps the input in place and refreshes dependent selects; restored keys
// never collide with newly added rows.
test('typing an arm identifier keystroke by keystroke keeps its input, refreshes contrast options in place, and restored keys stay unique', async t => {
  const { createDesignFieldsEditor, emptyDesignRows } = await import('../../src/research-design-fields.js')
  const installed = installDomStandIn(globalThis)
  const editor = createDesignFieldsEditor({ onChange: () => {} })
  t.after(() => { editor.destroy(); installed.restore() })
  document.body.append(editor.el); editor.setContext({ conditionIds: ['seq', 'iso'], factors: ['site'] })
  const df = name => editor.el.querySelector('[data-design-fields-' + name + ']'), all = name => [...editor.el.querySelectorAll('[data-design-fields-' + name + ']')]
  df('present').checked = true; df('present').dispatch('input')
  df('add-arm').click(); df('add-contrast').click()
  const idInput = df('arm-id')
  for (const [index] of [...'sequential'].entries()) { idInput.value = 'sequential'.slice(0, index + 1); idInput.dispatch('input'); assert.ok(df('arm-id') === idInput, 'keystroke ' + (index + 1) + ' still targets the same input') }
  assert.equal(df('arm-id').value, 'sequential'); assert.equal(editor.getRows().arms[0].id, 'sequential')
  assert.ok([...df('contrast-first').querySelectorAll('option')].some(option => option.value === 'sequential'), 'the contrast arm options follow the typed identifier without a rebuild')
  const rows = emptyDesignRows(); rows.present = true
  rows.arms = [{ key: 'design-1', id: 'a', label: '', conditionIds: ['seq'] }, { key: 'design-2', id: 'b', label: '', conditionIds: ['iso'] }]
  const restored = createDesignFieldsEditor({ onChange: () => {} }); t.after(() => restored.destroy()); document.body.append(restored.el)
  restored.setContext({ conditionIds: ['seq', 'iso'], factors: ['site'] }); restored.setRows(rows)
  const rp = name => restored.el.querySelector('[data-design-fields-' + name + ']'), rall = name => [...restored.el.querySelectorAll('[data-design-fields-' + name + ']')]
  rp('add-arm').click()
  const keys = restored.getRows().arms.map(row => row.key)
  assert.equal(keys.length, 3); assert.equal(new Set(keys).size, 3, 'no duplicate key: ' + keys.join(','))
  rall('remove-arm')[2].click()
  assert.deepEqual(restored.getRows().arms.map(row => row.id), ['a', 'b'], 'Remove deletes only the added arm')
})

test('setDisabled(value) no-ops when the value is unchanged, and still applies when it changes', () => {
  const installed = installDomStandIn(globalThis)
  const editor = createDesignFieldsEditor({ onChange: () => {} })
  document.body.append(editor.el); editor.setContext({ conditionIds: ['seq', 'iso'], factors: ['site'] })
  const df = name => editor.el.querySelector('[data-design-fields-' + name + ']')
  df('present').checked = true; df('present').dispatch('input')
  df('add-arm').click()
  const idInput = df('arm-id'), presentToggle = df('present')
  assert.equal(presentToggle.disabled, false)
  editor.setDisabled(false)
  assert.ok(df('arm-id') === idInput, 'setDisabled(false) is a no-op while already enabled: the input is not replaced')
  assert.ok(df('present') === presentToggle, 'setDisabled(false) is a no-op while already enabled: the toggle is not replaced')
  editor.setDisabled(true)
  assert.equal(df('present').disabled, true, 'setDisabled(true) really applies once the value changes')
  const disabledIdInput = df('arm-id')
  editor.setDisabled(true)
  assert.ok(df('arm-id') === disabledIdInput, 'a repeated identical setDisabled(true) call is a no-op: the input is not replaced')
  editor.setDisabled(true)
  assert.ok(df('arm-id') === disabledIdInput, 'a third repeated identical call is still a no-op')
  editor.setDisabled(false)
  assert.equal(df('present').disabled, false, 'setDisabled(false) applies again once the value changes back')
  editor.destroy(); installed.restore()
})

test('setContext(next) no-ops when the conditions and factors are unchanged by value, and re-renders only when they change', () => {
  const installed = installDomStandIn(globalThis)
  const editor = createDesignFieldsEditor({ onChange: () => {} })
  document.body.append(editor.el); editor.setContext({ conditionIds: ['seq', 'iso'], factors: ['site'] })
  const df = name => editor.el.querySelector('[data-design-fields-' + name + ']')
  df('present').checked = true; df('present').dispatch('input')
  df('add-arm').click()
  const idInput = df('arm-id'), presentToggle = df('present')
  // New array instances, same values in the same order: a no-op.
  editor.setContext({ conditionIds: ['seq', 'iso'], factors: ['site'] })
  assert.ok(df('arm-id') === idInput, 'an unchanged context is a no-op: the arm-id input is not replaced')
  assert.ok(df('present') === presentToggle, 'an unchanged context is a no-op: the present toggle is not replaced')
  editor.setContext({ conditionIds: ['seq', 'iso'], factors: ['site'] })
  assert.ok(df('arm-id') === idInput, 'a second repeated identical setContext call is still a no-op')
  // A real change (a third condition) really applies.
  editor.setContext({ conditionIds: ['seq', 'iso', 'extra'], factors: ['site'] })
  assert.ok(df('arm-id') !== idInput, 'setContext really applies once the conditions change')
  const conditionIds = [...editor.el.querySelectorAll('[data-design-fields-arm-condition]')].map(box => box.getAttribute('data-design-fields-arm-condition'))
  assert.deepEqual(conditionIds, ['seq', 'iso', 'extra'], 'the new condition is reflected in the arm-conditions list')
  editor.destroy(); installed.restore()
})

// Fresh-realm reload: a restored draft's row keys are read from a document
// that was never mounted by this module instance (keySeq starts at 0), the
// way an actual browser reload restores a saved draft into a fresh page.
test('row keys stay distinct after a fresh module realm restores arms, phases and contrasts, and editing or removing a newly added row leaves the restored rows untouched', async t => {
  const installed = installDomStandIn(globalThis)
  t.after(() => installed.restore())
  const mod = await import('../../src/research-design-fields.js?realm=' + Date.now())
  const rows = mod.emptyDesignRows()
  rows.present = true
  // Keys the way a real restore carries them: issued across arms, phases and
  // contrasts from one shared counter, so they do not sort largest-last.
  rows.arms = [{ key: 'design-2', id: 'a', label: '', conditionIds: ['seq'] }, { key: 'design-4', id: 'b', label: '', conditionIds: ['iso'] }]
  rows.phases = [{ key: 'design-1', id: 'p1', draws: '2', requiresRecordedDecision: '', factorLevels: [] }]
  rows.contrasts = [{ key: 'design-3', id: 'c1', first: 'a', second: 'b' }]
  const editor = mod.createDesignFieldsEditor({ onChange: () => {} })
  t.after(() => editor.destroy())
  document.body.append(editor.el)
  editor.setContext({ conditionIds: ['seq', 'iso'], factors: ['site'] })
  editor.setRows(rows)
  const all = name => [...editor.el.querySelectorAll('[data-design-fields-' + name + ']')]
  all('add-arm')[0].click(); all('add-phase')[0].click(); all('add-contrast')[0].click()
  const after = editor.getRows()
  assert.equal(after.arms.length, 3); assert.equal(after.phases.length, 2); assert.equal(after.contrasts.length, 2)
  const keys = [...after.arms, ...after.phases, ...after.contrasts].map(row => row.key)
  assert.equal(new Set(keys).size, keys.length, 'every key from a fresh-realm restore plus newly added rows is distinct: ' + keys.join(','))
  // Editing the newly added arm leaves the restored arms untouched.
  const newArmId = all('arm-id')[2]
  newArmId.value = 'extra'; newArmId.dispatch('input')
  assert.deepEqual(editor.getRows().arms.slice(0, 2).map(row => row.id), ['a', 'b'], 'editing the new arm does not touch the restored arms')
  // Removing the newly added arm removes only that row.
  all('remove-arm')[2].click()
  assert.deepEqual(editor.getRows().arms.map(row => row.id), ['a', 'b'], 'removing the new arm leaves exactly the restored arms')
  assert.equal(editor.getRows().phases.length, 2); assert.equal(editor.getRows().contrasts.length, 2)
})

// Migration: a draft persisted by the pre-fix build can already hold a
// DUPLICATE key (setRows historically only filled in a MISSING key with
// `row.key ||= nextKey(...)`, so a restored duplicate survived intact and a
// single Remove deleted both rows sharing it).
test('setRows repairs a restored duplicate key by giving every row after the first a fresh distinct key', async t => {
  const installed = installDomStandIn(globalThis)
  const editor = { current: null }, views = []
  // One consolidated teardown, in dependency order: destroy the editor and
  // every mounted view before uninstalling the DOM stand-in they rely on.
  // Separate t.after() calls run in registration order, not LIFO, so an
  // earlier-registered installed.restore() would otherwise tear the DOM down
  // before a later-registered view.destroy() gets to use it.
  t.after(() => { editor.current?.destroy(); for (const view of views) { view.destroy(); view.el.remove() }; installed.restore() })
  const mod = await import('../../src/research-design-fields.js?realm=' + Date.now())
  const rows = mod.emptyDesignRows()
  rows.present = true
  // Two arms restored with the SAME persisted key -- the historical bug shape.
  rows.arms = [{ key: 'design-1', id: 'a', label: '', conditionIds: ['seq'] }, { key: 'design-1', id: 'b', label: '', conditionIds: ['iso'] }]
  editor.current = mod.createDesignFieldsEditor({ onChange: () => {} })
  document.body.append(editor.current.el)
  editor.current.setContext({ conditionIds: ['seq', 'iso'], factors: [] })
  editor.current.setRows(rows)
  const keysAfterRestore = editor.current.getRows().arms.map(row => row.key)
  assert.equal(new Set(keysAfterRestore).size, 2, 'the two restored arms no longer share a key: ' + keysAfterRestore.join(','))
  assert.deepEqual(editor.current.getRows().arms.map(row => row.id), ['a', 'b'], 'restoring keeps both rows and their values, only the duplicate key is repaired')
  const all = name => [...editor.current.el.querySelectorAll('[data-design-fields-' + name + ']')]
  all('remove-arm')[0].click()
  assert.deepEqual(editor.current.getRows().arms.map(row => row.id), ['b'], 'removing the first restored arm now deletes exactly that one row; the other survives with its values')

  // Same repair through the mounted builder, with a retained design-fields
  // draft (the shape a real persisted-then-remounted duplicate takes).
  const values = new Map(), account = { async getSetting(key) { return { ok: true, value: values.get(key) ?? null } }, async putSetting(key, value) { values.set(key, value); return { ok: true } } }
  const { createBenchmarkBuilder } = await import('../../src/research-benchmark.js')
  const mount = async () => { const created = createBenchmarkBuilder({ account, loadSources: async () => sources, download: () => {} }); views.push(created); document.body.append(created.el); await created.setContext('rp-' + 'c'.repeat(36), 'live'); return created }
  const idle = async view => { for (let n = 0; n < 1400; n++) { if (view.el.getAttribute('aria-busy') === 'false') return; await new Promise(resolve => setTimeout(resolve, 3)) } assert.fail(view.el.querySelector('[data-bench-status]').textContent) }
  let view = await mount(); await idle(view)
  const field = name => view.el.querySelector('[data-bench-' + name + ']')
  const df = name => view.el.querySelector('[data-design-fields-' + name + ']'), all2 = name => [...view.el.querySelectorAll('[data-design-fields-' + name + ']')]
  const duplicateRows = { present: true, rationale: '', arms: [
    { key: 'design-1', id: 'first', label: '', conditionIds: [] },
    { key: 'design-1', id: 'second', label: '', conditionIds: [] },
  ], unit: { enabled: false, groupBy: '', members: '2' }, phases: [], contrasts: [] }
  // Write the pre-fix-build's persisted shape straight into the retained
  // field text (the way an imported/restored draft's raw editor snapshot
  // works), then save and remount -- the real restore path (`applyEditors`
  // on remount) is what calls syncDesignFields/setRows on this exact text.
  field('design-fields').value = JSON.stringify(duplicateRows); field('design-fields').dispatch('input')
  field('save').click(); await idle(view)
  view = await mount(); await idle(view)
  assert.equal(all2('arm').length, 2, 'both arms restore from the retained draft')
  const restoredIds = all2('arm-id').map(input => input.value)
  assert.deepEqual(restoredIds, ['first', 'second'], 'both restored rows keep their own values')
  all2('remove-arm')[0].click()
  assert.deepEqual([...view.el.querySelectorAll('[data-design-fields-arm-id]')].map(input => input.value), ['second'], 'removing the first restored arm in the mounted builder deletes exactly that one row')
})

// F4: nextKey's taken-set retry must terminate even when a restored key's
// numeric suffix is at or beyond Number.MAX_SAFE_INTEGER (where ++ on a
// float is a fixed point) or is not numeric at all.
test('a restored key at or beyond Number.MAX_SAFE_INTEGER, or a non-numeric suffix, does not stall Add and still yields distinct keys', async t => {
  const installed = installDomStandIn(globalThis)
  t.after(() => installed.restore())
  const mod = await import('../../src/research-design-fields.js?realm=' + Date.now())
  const rows = mod.emptyDesignRows()
  rows.present = true
  rows.arms = [
    { key: 'design-9007199254740993', id: 'huge', label: '', conditionIds: ['seq'] },
    { key: 'design-abc', id: 'nonnum', label: '', conditionIds: ['iso'] },
  ]
  const editor = mod.createDesignFieldsEditor({ onChange: () => {} })
  t.after(() => editor.destroy())
  document.body.append(editor.el)
  editor.setContext({ conditionIds: ['seq', 'iso'], factors: [] })
  editor.setRows(rows)
  const all = name => [...editor.el.querySelectorAll('[data-design-fields-' + name + ']')]
  const started = Date.now()
  // Two Add clicks: the fixed point only surfaces once a first generated key
  // is itself already taken by the previous Add's result (reviewer's own
  // reproduction needed the same second click to observe the hang).
  all('add-arm')[0].click()
  all('add-arm')[0].click()
  assert.ok(Date.now() - started < 2000, 'Add completed well within the enclosing timeout, not stuck retrying a fixed-point key')
  const keys = editor.getRows().arms.map(row => row.key)
  assert.equal(new Set(keys).size, 4, 'all four keys (two restored, two added) are distinct: ' + keys.join(','))
  assert.deepEqual(editor.getRows().arms.map(row => row.id), ['huge', 'nonnum', '', ''], 'both restored rows and both newly added rows are present')
})

// Literal factor levels: a string level that would otherwise be read back as a
// different JSON type (the string "1" as a number, "true" as a boolean) must
// round-trip exactly through the labeled fields' display/reapply cycle.
test('factor levels round-trip losslessly through designRowsFromPlan/designPlanFromRows for literal strings that would otherwise change type', () => {
  const plan = { version: 1, rationale: 'r', phases: [{ id: 'p1', draws: 2, factorLevels: { site: ['1', 1, 'true', true, 's1'] } }] }
  const rows = designRowsFromPlan(plan)
  assert.equal(rows.phases[0].factorLevels[0].levels, '"1", 1, "true", true, s1', 'a string level that would parse back as a different type is shown quoted; the rest are shown plain')
  const result = designPlanFromRows({ ...rows, present: true })
  assert.deepEqual(result.phases[0].factorLevels.site, ['1', 1, 'true', true, 's1'], 'the exact literal values and their types survive the display/reapply round trip')
})

test('factor levels round-trip losslessly through the mounted builder: import, reapply through the labeled fields, save and remount', async t => {
  const installed = installDomStandIn(globalThis)
  const values = new Map(), account = { async getSetting(key) { return { ok: true, value: values.get(key) ?? null } }, async putSetting(key, value) { values.set(key, value); return { ok: true } } }
  const views = []
  const mount = async () => { const created = createBenchmarkBuilder({ account, loadSources: async () => sources, download: () => {} }); views.push(created); document.body.append(created.el); await created.setContext('rp-' + 'a'.repeat(36), 'live'); return created }
  const idle = async view => { for (let n = 0; n < 1400; n++) { if (view.el.getAttribute('aria-busy') === 'false') return; await new Promise(resolve => setTimeout(resolve, 3)) } assert.fail(view.el.querySelector('[data-bench-status]').textContent) }
  t.after(() => { for (const view of views) { view.destroy(); view.el.remove() }; installed.restore() })

  const draft = study(); delete draft.runtimeSources
  // "member" is a real declared task factor (values "m1"/"m2"); the literal
  // levels below are chosen to collide with number/boolean parsing.
  draft.designPlan.phases[0].factorLevels = { member: ['1', 1, 'true', true, 'm1'] }

  let view = await mount(); await idle(view)
  const field = name => view.el.querySelector('[data-bench-' + name + ']')
  const specPlan = () => JSON.parse(field('spec-json').value).designPlan
  const text = JSON.stringify({ spec: draft }), node = field('import')
  node.files = [{ name: 'design-draft.json', size: Buffer.byteLength(text), text: async () => text }]; node.dispatch('change'); await idle(view)
  assert.match(field('status').textContent, /Draft imported/)
  // The imported plan's phase-level display is quoted exactly where needed to stay lossless.
  const levelsInput = () => view.el.querySelectorAll('[data-design-fields-phase-levels]')[0]
  assert.equal(levelsInput().value, '"1", 1, "true", true, m1', 'the labeled field shows the literal levels quoted where a plain reading would change their type')
  // Reapplying through the labeled fields with no edits round-trips the exact contract.
  field('apply-design').click(); await idle(view)
  assert.match(field('status').textContent, /Design plan applied/)
  assert.deepEqual(specPlan().phases[0].factorLevels, { member: ['1', 1, 'true', true, 'm1'] }, 'labeled fields keep the exact literal types and values on reapply')
  // Save, remount against the same account, and confirm the applied plan and the field draft both retain the literal levels.
  field('save').click(); await idle(view); assert.match(field('status').textContent, /Draft saved/)
  view = await mount(); await idle(view)
  assert.deepEqual(specPlan().phases[0].factorLevels, { member: ['1', 1, 'true', true, 'm1'] }, 'the remounted applied plan retains the exact literal levels')
  assert.equal(levelsInput().value, '"1", 1, "true", true, m1', 'the remounted field draft shows the same lossless text')
})

test('factor levels round-trip losslessly through designRowsFromPlan/designPlanFromRows for a literal string level that itself contains a comma', () => {
  // "1,2" is the sharper case: unlike "a,b", an unescaped split on this level
  // reparses the two halves as the NUMBERS 1 and 2 -- a type change, not just
  // a delimiter collision -- so it is asserted explicitly alongside "a,b".
  const levels = ['a,b', '1,2', '1', 1, 'true', true, 's1', ' x ']
  const plan = { version: 1, rationale: 'r', phases: [{ id: 'p1', draws: 2, factorLevels: { site: levels } }] }
  const rows = designRowsFromPlan(plan)
  assert.equal(rows.phases[0].factorLevels[0].levels, '"a,b", "1,2", "1", 1, "true", true, s1, " x "', 'a level containing a comma, or that would otherwise parse back as a different type or value, is shown quoted; the rest are shown plain')
  const result = designPlanFromRows({ ...rows, present: true })
  assert.deepEqual(result.phases[0].factorLevels.site, levels, 'the exact literal values, including the embedded commas (one of which would otherwise silently become two numbers) and the leading/trailing space, survive the display/reapply round trip')
})

test('factor levels containing a comma round-trip losslessly through the mounted builder: import, reapply through the labeled fields, save and remount', async t => {
  const installed = installDomStandIn(globalThis)
  const values = new Map(), account = { async getSetting(key) { return { ok: true, value: values.get(key) ?? null } }, async putSetting(key, value) { values.set(key, value); return { ok: true } } }
  const views = []
  const mount = async () => { const created = createBenchmarkBuilder({ account, loadSources: async () => sources, download: () => {} }); views.push(created); document.body.append(created.el); await created.setContext('rp-' + 'a'.repeat(36), 'live'); return created }
  const idle = async view => { for (let n = 0; n < 1400; n++) { if (view.el.getAttribute('aria-busy') === 'false') return; await new Promise(resolve => setTimeout(resolve, 3)) } assert.fail(view.el.querySelector('[data-bench-status]').textContent) }
  t.after(() => { for (const view of views) { view.destroy(); view.el.remove() }; installed.restore() })

  const draft = study(); delete draft.runtimeSources
  const levels = ['a,b', '1,2', '1', 1, 'true', true, 'm1', ' x ']
  draft.designPlan.phases[0].factorLevels = { member: levels }

  let view = await mount(); await idle(view)
  const field = name => view.el.querySelector('[data-bench-' + name + ']')
  const specPlan = () => JSON.parse(field('spec-json').value).designPlan
  const text = JSON.stringify({ spec: draft }), node = field('import')
  node.files = [{ name: 'design-draft.json', size: Buffer.byteLength(text), text: async () => text }]; node.dispatch('change'); await idle(view)
  assert.match(field('status').textContent, /Draft imported/)
  const levelsInput = () => view.el.querySelectorAll('[data-design-fields-phase-levels]')[0]
  assert.equal(levelsInput().value, '"a,b", "1,2", "1", 1, "true", true, m1, " x "', 'the labeled field shows both comma-containing levels quoted, alongside the other levels needing it')
  field('apply-design').click(); await idle(view)
  assert.match(field('status').textContent, /Design plan applied/)
  assert.deepEqual(specPlan().phases[0].factorLevels, { member: levels }, 'labeled fields keep the exact literal levels, including both embedded commas (one of which stays the STRING "1,2", not the numbers 1 and 2), on reapply')
  field('save').click(); await idle(view); assert.match(field('status').textContent, /Draft saved/)
  view = await mount(); await idle(view)
  assert.deepEqual(specPlan().phases[0].factorLevels, { member: levels }, 'the remounted applied plan retains the exact literal levels')
  assert.equal(levelsInput().value, '"a,b", "1,2", "1", 1, "true", true, m1, " x "', 'the remounted field draft shows the same lossless text')
})
