import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildExperiment, decideDispatch, parseExperimentsRow, resetExperimentTracking, runnerConfigFor, seedExperiments, submitExperimentRuns } from '../../src/research-experiments.js'
import { parseDesignerRunner, parsePinnedFiles, parseRunner, pinnedFileRowsToConfig, runnerDesignerFields } from '../../src/research-grid.js'

const require = createRequire(import.meta.url)
const { createStateStore } = require('../../capability/src/lib/state-store.js')
const { ResearchControl } = require('../../capability/src/lib/providers/research.js')
const { validatePinnedFiles } = require('../../capability/src/lib/research/provenance.js')
const root = path.resolve(import.meta.dirname, '../..')
const pin = { path: path.join(root, 'declared-input.txt'), sha256: 'a'.repeat(64) }
const runner = {
  kind: 'process', command: 'not-executed', args: ['{sample}'], stdin: 'params-json',
  pinnedFiles: [pin], envKeys: ['FIXTURE_SETTING'], maxOutputBytes: 8192,
  futureReceiptSettings: { keep: ['nested', true, null] },
}
const formValues = value => {
  const fields = runnerDesignerFields(value)
  return { kind: fields.runnerKind, detail: fields.runnerDetail, pinnedRows: fields.pinnedRows,
    optionsText: fields.runnerOptions, optionsKind: fields.runnerKind, originalRunner: fields.originalRunner }
}

test('the service config retains every optional setting instead of rebuilding a lossy subset', () => {
  const { kind, ...expected } = runner
  assert.deepEqual(runnerConfigFor(runner), expected)
  assert.deepEqual(runnerConfigFor({ kind: 'http', url: 'https://example.invalid', method: 'POST', headers: { Accept: 'application/json' } }),
    { url: 'https://example.invalid', method: 'POST', headers: { Accept: 'application/json' } })
})

test('pins cannot be saved under agent/http through either the view validator or builder', () => {
  for (const kind of ['agent', 'http']) {
    const invalid = { kind, briefTemplate: 'A synthetic task.', url: 'https://example.invalid', pinnedFiles: [pin] }
    assert.equal(parseRunner(invalid).ok, false)
    assert.equal(buildExperiment({ name: 'Refused', axes: [{ id: 'tier', values: ['synthetic'] }], runner: invalid, runsPerCell: 1 }, { experiments: [] }).ok, false)
  }
})

test('the actual designer parser preserves duplicate pins, nested settings, and exact unchanged arguments', () => {
  const original = { ...runner, args: ['', '  surrounded  ', 'line\nbreak', '\u03bb'], pinnedFiles: [{ ...pin, sha256: 'A'.repeat(64) }] }
  const fields = formValues(original)
  assert.deepEqual(parseDesignerRunner(fields), { ok: true, runner: original })
  assert.deepEqual(JSON.parse(fields.optionsText).futureReceiptSettings, runner.futureReceiptSettings)
  const changed = parseDesignerRunner({ ...fields, detail: 'different-command\n{sample}' })
  assert.equal(changed.ok, true)
  assert.equal(changed.runner.command, 'different-command')
  assert.deepEqual(changed.runner.pinnedFiles, original.pinnedFiles)
  assert.equal(changed.runner.stdin, 'params-json')
  const removed = parseDesignerRunner({ ...fields, pinnedRows: [] })
  assert.equal(Object.hasOwn(removed.runner, 'pinnedFiles'), false, 'explicit removal does not resurrect hidden old pins')
})

test('the form refuses kind changes with retained settings and cannot smuggle pins through advanced JSON', () => {
  for (const kind of ['agent', 'http']) {
    assert.equal(parseDesignerRunner({ ...formValues(runner), kind }).ok, false)
    assert.equal(parseDesignerRunner({ ...formValues(runner), kind, optionsText: '' }).ok, false)
    const cleared = parseDesignerRunner({ kind, detail: kind === 'http' ? 'https://example.invalid' : 'Synthetic brief.', pinnedRows: [], optionsText: '' })
    assert.equal(cleared.ok, true)
  }
  for (const optionsText of ['{', '[]', 'null', JSON.stringify({ pinnedFiles: [pin] }), '{"command":"hidden"}']) {
    assert.equal(parseDesignerRunner({ ...formValues(runner), optionsText }).ok, false)
  }
  const unsupported = { ...runner, url: 'a retained but misplaced setting' }
  assert.equal(JSON.parse(runnerDesignerFields(unsupported).runnerOptions).url, unsupported.url)
  assert.equal(parseDesignerRunner(formValues(unsupported)).ok, false, 'misplaced settings remain visible and refused, never silently discarded')
})

test('pin declaration validators reject partial, duplicate, malformed and excessive inputs without filesystem access', () => {
  assert.deepEqual(pinnedFileRowsToConfig('agent', [{ path: '', sha256: '' }]), { ok: true })
  assert.equal(pinnedFileRowsToConfig('process', [{ path: pin.path, sha256: '' }]).ok, false)
  assert.equal(pinnedFileRowsToConfig('process', [{ path: '', sha256: pin.sha256 }]).ok, false)
  for (const pins of [undefined, null, [], 'files', [{ ...pin, sha256: 'abc' }], [{ ...pin, optional: true }], [pin, pin], Array(65).fill(pin)]) {
    assert.equal(parsePinnedFiles('process', pins).ok, false)
    assert.throws(() => validatePinnedFiles('process', { pinnedFiles: pins }))
  }
  for (const file of ['relative.txt', pin.path + '\0', path.dirname(pin.path) + path.sep + '..' + path.sep + 'input.txt']) {
    assert.equal(parsePinnedFiles('process', [{ ...pin, path: file }]).ok, false)
    assert.throws(() => validatePinnedFiles('process', { pinnedFiles: [{ ...pin, path: file }] }))
  }
  const windowsPin = { ...pin, path: 'C:\\declared-fixture\\input.txt' }
  assert.equal(parsePinnedFiles('process', [windowsPin, { ...windowsPin, path: 'c:/DECLARED-FIXTURE/input.txt' }]).ok, false)
  const full = Array.from({ length: 64 }, (_, index) => ({ ...pin, path: path.join(root, `input-${index}.txt`) }))
  assert.equal(parsePinnedFiles('process', full).ok, true)
  assert.equal(validatePinnedFiles('process', { pinnedFiles: full }).length, 64)
})

test('a malformed legacy row cannot dispatch agent/http pins even if it bypassed the new save guard', async () => {
  let submitted = 0
  for (const kind of ['agent', 'http']) {
    const malformed = { id: `bad-${kind}`, projectId: 'rp-abcd', runner: { ...runner, kind, briefTemplate: 'Synthetic.', url: 'https://example.invalid' }, cells: [{ params: {}, status: 'designed' }] }
    seedExperiments({ experiments: [malformed], damaged: false })
    assert.equal(decideDispatch(malformed).ok, false)
    const answer = await submitExperimentRuns(malformed.id, { submit: async () => { submitted++; throw Error('must not submit') } })
    assert.equal(answer.ok, false)
  }
  assert.equal(submitted, 0)
  resetExperimentTracking()
})

test('the view wires pin rows and visible preserved options to the tested parser and explicitly exposes receipt limitations', () => {
  const view = readFileSync(new URL('../../src/views/research.js', import.meta.url), 'utf8')
  for (const hook of ['data-pin-rows', 'data-pin-add', 'data-pin-remove', 'data-pin-path', 'data-pin-sha256', 'name="runnerOptions"']) assert.ok(view.includes(hook))
  assert.match(view, /parseDesignerRunner\(\{ kind, detail/)
  assert.match(view, /runnerDesignerFields\(experiment\.runner\)/)
  assert.match(view, /data-research-input-checks/)
  assert.match(view, /esc\(drillModel\.inputReceiptText\)/, 'untrusted receipt content is escaped, never inserted as markup')
  assert.match(view, /in-run immutability, a cleanroom, or scientific correctness/)
})

test('local save/reload and real Research state submission preserve pins and receipt settings without executing a runner', async t => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'research-ui-pins-'))
  const stateFile = path.join(scratch, 'research.sqlite3')
  let state = createStateStore({ file: stateFile })
  state.health()
  t.after(() => { state.close(); resetExperimentTracking() })
  const enabled = { state: 'enabled', why: null }
  const control = new ResearchControl({ state, gate: () => ({ pipelineWithheld: false, pipeline: enabled, runners: { process: enabled, http: enabled, agent: enabled } }), auditRequire: () => ({ durable: true }) })
  const { project } = control.projectSave({ actor: 'human', name: 'Synthetic persistence fixture', enabled: true })
  const built = buildExperiment({ name: 'Synthetic pinned design', axes: [{ id: 'sample', values: [1] }], runner, runsPerCell: 1, projectId: project.projectId }, { experiments: [] })
  assert.equal(built.ok, true)
  const rowFile = path.join(scratch, 'account-row.json')
  writeFileSync(rowFile, built.serialized)
  seedExperiments(parseExperimentsRow(readFileSync(rowFile, 'utf8')))
  let experimentId
  const answer = await submitExperimentRuns(built.experiment.id, {
    persist: text => writeFileSync(rowFile, text),
    submit: async body => {
      const receipt = control.runSubmit({ actor: 'human', ...body })
      experimentId = receipt.experiment.experimentId
      return { ok: true, ...receipt }
    },
  })
  assert.equal(answer.ok, true)
  assert.equal(answer.submitted, 1)
  state.close()
  state = createStateStore({ file: stateFile })
  const { kind, ...expected } = runner
  const stored = state.getResearchExperiment({ experimentId })
  assert.deepEqual(stored.runnerConfig, expected)
  const fromService = parseDesignerRunner(formValues({ ...stored.runnerConfig, kind: stored.runnerKind }))
  assert.equal(fromService.ok, true)
  assert.deepEqual(runnerConfigFor(fromService.runner), expected, 'service-loaded optional settings survive the same designer parser')
  const runs = state.listResearchRuns({ experimentId })
  assert.equal(runs.length, 1)
  assert.equal(runs[0].task.status, 'queued', 'only persistence ran; no runner or provider was executed')
  assert.deepEqual(parseExperimentsRow(readFileSync(rowFile, 'utf8')).experiments[0].runner, runner)
  for (const runnerKind of ['agent', 'http']) {
    assert.throws(() => state.createResearchExperiment({ projectId: project.projectId, name: `Refused ${runnerKind}`, runnerKind, runnerConfig: runnerConfigFor(runner), resultSchema: { fields: {} }, collector: { kind: 'none' } }), { code: 'RESEARCH_PIN_RUNNER_UNSUPPORTED' })
  }
})
