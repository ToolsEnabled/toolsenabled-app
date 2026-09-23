import assert from 'node:assert/strict'
import test from 'node:test'
import { parseResearchAgentSetup, portableAgentInputPath, researchSetupForRunner } from '../../src/research-agent-setup.js'
import { parseExperimentImport, serializeExperimentImport } from '../../src/research-experiments.js'

const setup = (overrides = {}) => ({
  mode: 'clean-room', access: 'read-only',
  files: [{ path: 'inputs/data.txt', content: 'alpha' }], ...overrides,
})

test('absent setup preserves ordinary behavior and clean-room output is frozen', () => {
  assert.deepEqual(parseResearchAgentSetup(undefined), { ok: true, agentSetup: null })
  const parsed = parseResearchAgentSetup(setup())
  assert.equal(parsed.ok, true)
  assert.equal(Object.isFrozen(parsed.agentSetup), true)
  assert.equal(Object.isFrozen(parsed.agentSetup.files), true)
  assert.equal(Object.isFrozen(parsed.agentSetup.files[0]), true)
})

test('portable paths reject traversal, hidden/device names and platform separators', () => {
  for (const value of ['../x', 'a/../x', '.hidden', 'CON', 'CON.txt', 'NUL.txt', 'dir\\x', 'a/', 'x.']) {
    assert.equal(portableAgentInputPath(value), false, value)
  }
  assert.equal(portableAgentInputPath('inputs/data.txt'), true)
})

test('setup strictly bounds and rejects unsupported input', () => {
  assert.equal(parseResearchAgentSetup({ ...setup(), extra: true }).ok, false)
  assert.equal(parseResearchAgentSetup({ ...setup(), files: Array.from({ length: 33 }, (_, i) => ({ path: `x${i}.txt`, content: '' })) }).ok, false)
  assert.equal(parseResearchAgentSetup({ ...setup(), files: [{ path: 'x.txt', content: 'x'.repeat(512 * 1024 + 1) }] }).ok, false)
  assert.equal(parseResearchAgentSetup({ ...setup(), files: [{ path: 'x.txt', content: String.fromCharCode(0) }] }).ok, false)
  assert.equal(parseResearchAgentSetup({ ...setup(), files: [{ path: 'x.txt', content: '' }, { path: 'x.txt', content: '' }] }).ok, false)
})

test('clean-room is local agent-only and queue-sized work is refused', () => {
  const parsed = parseResearchAgentSetup(setup())
  assert.deepEqual(researchSetupForRunner(parsed.agentSetup, { kind: 'agent' }, 8), { ok: true })
  assert.equal(researchSetupForRunner(parsed.agentSetup, { kind: 'agent' }, 9).ok, false)
  assert.equal(researchSetupForRunner(parsed.agentSetup, { kind: 'process' }, 1).ok, false)
})


test('experiment imports round-trip normalized specs and refuse malformed untrusted shapes', () => {
  const spec = {
    name: 'Import fixture',
    axes: [{ id: 'tier', values: ['luna'] }],
    runner: { kind: 'agent', briefTemplate: 'Read {dataset}.' },
    resultSchema: { fields: { answer: 'string' }, required: ['answer'] },
    runsPerCell: 1,
    datasetPath: 'inputs/data.txt',
    agentSetup: setup(),
  }
  const serialized = serializeExperimentImport(spec)
  assert.equal(serialized.ok, true)
  const parsed = parseExperimentImport(serialized.text)
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.spec.axes, spec.axes)
  assert.deepEqual(parsed.spec.agentSetup, spec.agentSetup)
  for (const badSpec of [
    { ...spec, axes: null },
    { ...spec, axes: [{ id: 'tier', values: null }] },
    { ...spec, axes: [{ id: 'tier', values: ['luna'] }, { id: 'tier', values: ['terra'] }] },
    { ...spec, axes: [{ id: 'tier', values: ['luna'], extra: true }] },
    { ...spec, resultSchema: null },
    { ...spec, resultSchema: { fields: { answer: 'bogus' } } },
  ]) {
    const result = parseExperimentImport(JSON.stringify({ format: 'toolsenabled-research-experiment', version: 1, spec: badSpec }))
    assert.equal(result.ok, false)
    assert.equal(typeof result.sentence, 'string')
  }
})


test('experiment files use the same UTF-8 byte limit for import and download', () => {
  const spec = {
    name: 'Unicode input',
    axes: [{ id: 'tier', values: ['astra'] }],
    runner: { kind: 'agent', briefTemplate: 'Read input.txt.' },
    resultSchema: { fields: { answer: 'string' }, required: [] },
    runsPerCell: 1, datasetPath: null,
    agentSetup: setup({ files: [{ path: 'input.txt', content: '€'.repeat(21000) }] }),
  }
  const text = JSON.stringify({ format: 'toolsenabled-research-experiment', version: 1, spec })
  assert.ok(text.length < 60000)
  assert.ok(new TextEncoder().encode(text).byteLength > 60000)
  assert.equal(serializeExperimentImport(spec).ok, false, 'downloads must not produce a file that the file picker refuses')
  assert.equal(parseExperimentImport(text).ok, false, 'the parser must use the file picker byte boundary')
  spec.agentSetup = setup({ files: [{ path: 'input.txt', content: '€'.repeat(100) }] })
  const small = serializeExperimentImport(spec)
  assert.equal(small.ok, true, small.sentence)
  assert.deepEqual(parseExperimentImport(small.text).spec.agentSetup, spec.agentSetup)
})
