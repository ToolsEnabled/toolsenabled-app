import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { canonicalRootForTests } from '../canonical-root.mjs'
import { parseAxes, parsePinnedFiles } from '../../src/research-grid.js'
import { readRuns, readResults, resultTableModel, resultsExport, runInputChecks } from '../../src/research-runs.js'

// Same source-selection seam as the maintained exported Research integration.
// Neither route reaches a running service, owner database or external provider.
const engineRoot = canonicalRootForTests({ requireConfigured: true })
const require = createRequire(import.meta.url)
const { createStateStore } = require(path.join(engineRoot, 'src/lib/state-store.js'))
const { ResearchControl } = require(path.join(engineRoot, 'src/lib/providers/research.js'))
const { createResearchActions } = require(path.join(engineRoot, 'src/lib/mission-bridge/research-actions.js'))
const { runProcess } = require(path.join(engineRoot, 'src/lib/research/runners.js'))
const provenance = require(path.join(engineRoot, 'src/lib/research/provenance.js'))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const enabled = { state: 'enabled', why: null }
const gate = () => ({ pipelineWithheld: false, pipeline: enabled, runners: { process: enabled } })
function scratch(t, beforeCleanup = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'te-research-wiring-'))
  t.after(() => { beforeCleanup(); fs.rmSync(dir, { recursive: true, force: true }) })
  return dir
}

for (const count of [32, 33, 64]) test(`${count} real process pins cross Engine receipt validation into the renderer`, async t => {
  const dir = scratch(t)
  const pins = Array.from({ length: count }, (_, i) => {
    const file = path.join(dir, `pin-${i}.txt`), bytes = Buffer.from(`input ${i}\r\n\0λ`)
    fs.writeFileSync(file, bytes)
    return { path: file, sha256: digest(bytes) }
  })
  assert.equal(parsePinnedFiles('process', pins).ok, true)
  const checkedPins = provenance.validatePinnedFiles('process', { pinnedFiles: pins })
  const run = { runId: `pins-${count}`, params: {}, artifactDir: dir }
  const experiment = { runnerKind: 'process', timeoutMs: 10000,
    runnerConfig: { command: process.execPath, args: ['-e', 'process.stdout.write("fixture complete")'], pinnedFiles: pins } }
  const result = await runProcess({ experiment, run, artifactDir: dir })
  assert.equal(result.exitCode, 0); assert.equal(result.stdout, 'fixture complete')
  provenance.assertProcessReceipt(result.provenance, { pins: checkedPins, runId: run.runId, artifactDir: dir })
  assert.equal(result.provenance.before.files.length, count)
  const rendered = runInputChecks({ ...run, task: { result: { ...result, runnerKind: 'process' } } })
  assert.equal(rendered.status, 'recorded')
  assert.match(rendered.sentence, /does not recheck files or authenticate/)
})

test('65 pins remain refused by designer, Engine and renderer receipt presentation', () => {
  const pins = Array.from({ length: 65 }, (_, i) => ({ path: path.join(path.parse(process.execPath).root, `pin-${i}`), sha256: 'a'.repeat(64) }))
  assert.equal(parsePinnedFiles('process', pins).ok, false)
  assert.throws(() => provenance.validatePinnedFiles('process', { pinnedFiles: pins }), { code: 'RESEARCH_PIN_CONFIG_INVALID' })
  const invocation = provenance.invocationReceipt({ command: 'fixture', args: [], artifactDir: 'fixture', stdinMode: 'none', stdinPayload: '', environment: {} })
  const files = pins.map(pin => ({ ...pin, bytes: 1 }))
  const receipt = provenance.processReceipt({ runId: 'refused', invocation,
    before: { startedAtMs: 1, checkedAtMs: 2, files }, after: { startedAtMs: 3, checkedAtMs: 4, files } })
  assert.equal(runInputChecks({ runId: 'refused', artifactDir: 'fixture', task: { result: { runnerKind: 'process', provenance: receipt } } }).status, 'unrecognized')
})

function history(t) {
  let state
  const dir = scratch(t, () => state?.close())
  state = createStateStore({ file: path.join(dir, 'state.sqlite3'), clock: () => 1700000000000 })
  state.health()
  const control = new ResearchControl({ state, gate, auditRequire: () => ({ durable: true }) })
  const { project } = control.projectSave({ actor: 'human', name: 'Fixture project', enabled: true })
  const { experiment } = control.experimentSave({ actor: 'human', projectId: project.projectId, name: 'Fixture grid', runnerKind: 'process',
    runnerConfig: { command: 'never-executed' }, resultSchema: { fields: { score: 'number' }, required: ['score'] }, collector: { kind: 'stdout-json' } })
  const actions = createResearchActions({ control })
  const calls = []
  const postAction = async (action, body) => {
    calls.push({ action, body })
    return action === 'research-runs' ? actions.researchRuns(body) : actions.researchResults(body)
  }
  function add(index) {
    const { run } = control.runSubmit({ actor: 'human', experimentId: experiment.experimentId, params: { index } })
    const { handle } = state.claimTask({ queue: 'research-runs', workerLabel: 'fixture', leaseMs: 300000 })
    state.startTask(handle)
    state.completeResearchRun(handle, { runId: run.runId, records: [{ recordKind: 'summary', record: { score: index } }],
      result: { summary: 'Fixture completed', runnerKind: 'process', evidenceStatus: 'collected' } })
    return run.runId
  }
  return { state, control, actions, experiment, postAction, calls, add }
}

test('a supported 225-cell grid reaches every run and result in JSON and CSV exports', async t => {
  assert.equal(parseAxes({ x: Array.from({ length: 15 }, (_, i) => i), y: Array.from({ length: 15 }, (_, i) => i) }).cellCount, 225)
  const f = history(t), ids = Array.from({ length: 225 }, (_, i) => f.add(i))
  const read = await readRuns(f.experiment.experimentId, { postAction: f.postAction })
  assert.equal(read.ok, true); assert.equal(read.runs.length, 225)
  assert.deepEqual(new Set(read.runs.map(run => run.runId)), new Set(ids))
  const resultsByRun = new Map()
  for (const run of read.runs) resultsByRun.set(run.runId, await readResults(run.runId, { postAction: f.postAction }))
  const model = resultTableModel({ runs: read.runs, resultsByRun, resultSchema: f.experiment.resultSchema })
  const exported = JSON.parse(resultsExport(model, 'json'))
  assert.equal(exported.rows.length, 225)
  assert.deepEqual(new Set(exported.rows.map(row => row.runId)), new Set(ids))
  assert.equal(resultsExport(model, 'csv').trim().split('\n').length, 226)
})

test('history beyond 1000 follows explicit pages and excludes a newly appended run until the next read', async t => {
  const f = history(t), ids = Array.from({ length: 1001 }, (_, i) => f.add(i))
  let appended = null
  const postAction = async (action, body) => {
    const result = await f.postAction(action, body)
    if (!appended) appended = f.add(1001)
    return result
  }
  const first = await readRuns(f.experiment.experimentId, { postAction })
  assert.equal(first.ok, true); assert.equal(first.runs.length, 1001)
  assert.deepEqual(new Set(first.runs.map(run => run.runId)), new Set(ids))
  assert.equal(first.runs.some(run => run.runId === appended), false)
  assert.ok(f.calls.length > 1)
  const second = await readRuns(f.experiment.experimentId, { postAction: f.postAction })
  assert.equal(second.ok, true); assert.equal(second.runs.length, 1002)
  assert.ok(second.runs.some(run => run.runId === appended))
})
