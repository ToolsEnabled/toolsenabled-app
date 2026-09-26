import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'
import { withResearchTreeBinding } from '../../src/research-tree-session.js'
import { refusalCode } from '../../src/agent-availability-copy.js'
import { refusalCodeOf } from '../../src/refusal-copy.js'
import { buildExperiment, parseExperimentImport, serializeExperimentImport, seedExperiments,
  dispatchExperiment, resetExperimentTracking, experimentsSnapshot } from '../../src/research-experiments.js'
const source = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8').replace(/^export (?=(?:async )?function )/gm, '')
const declarations = ['withRetainedStartIdentity', 'endedAgentStartOutcome', 'startAgentForNode']
  .map(name => declaredFunctionSource(source, name)).join('\n')

function flow(t, { cleanRoom = true, missingScope = false, failScopeSave = false } = {}) {
  resetExperimentTracking()
  const previousWindow = globalThis.window, previousCustomEvent = globalThis.CustomEvent
  const values = new Map(), starts = [], sends = []
  const access = { version: 1, mode: 'clean-room', access: 'read-only', root: path.resolve('fixture-research-room') }
  const storage = {
    getItem: key => values.get(key) || null,
    setItem(key, value) {
      if (failScopeSave && key.startsWith('mc.fleet.trees.') && value.includes('"researchRestriction"')) throw new Error('fixture store refused')
      values.set(key, value)
    },
    removeItem: key => values.delete(key),
  }
  const native = {
    async start(request) {
      starts.push(request)
      return { sessionId: request.sessionId, threadId: 'fixture-native-thread',
        ...(cleanRoom && !missingScope ? { researchRestriction: access } : {}) }
    },
    async send(request) {
      const saved = JSON.parse(values.get('mc.fleet.trees.v1:this-computer'))
      const node = saved.nodes.find(node => node.id === starts[0].requestKeys.threadId)
      if (cleanRoom) assert.deepEqual(node.researchRestriction, access, 'scope must be durable before sending the prompt')
      else assert.equal(node.researchRestriction, undefined)
      sends.push(request)
      return { sessionId: request.sessionId, turnId: 'turn' }
    },
  }
  globalThis.CustomEvent = class { constructor(type) { this.type = type } }
  globalThis.window = { localStorage: storage, mcAgent: native, dispatchEvent() {} }
  t.after(() => {
    resetExperimentTracking()
    globalThis.window = previousWindow
    globalThis.CustomEvent = previousCustomEvent
  })
  const scope = { window: globalThis.window, withResearchTreeBinding, currentDataSource: () => 'local',
    isWriteEnabled: () => true, START_CONTROL_FLAG: 'agent-session', START_NEEDS_APP_TEXT: () => 'Needs app',
    exampleBoardText: () => 'Example', startControlOffReason: () => 'Starting is off',
    refusalCode, refusalCodeOf, readerRemedy: sentence => sentence,
    startRefusalSentence: result => result?.reason || result?.code || 'Start refused',
    sendRefusalSentence: result => result?.reason || result?.code || 'Send refused',
    refusalNeedsAssistantProgram: () => false, TERMINAL_AGENT_SESSION_CODES: new Set() }
  const startAgent = new Function(...Object.keys(scope), declarations + ';return startAgentForNode;')(...Object.values(scope))
  const spec = { name: 'Imported worker example', axes: [{ id: 'tier', values: ['astra'] }],
    runner: { kind: 'agent', briefTemplate: 'Inspect the supplied text for {tier}.' },
    resultSchema: { fields: { answer: 'string' }, required: [] }, datasetPath: '', runsPerCell: 1,
    ...(cleanRoom ? { agentSetup: { mode: 'clean-room', access: 'read-only',
      files: [{ path: 'inputs/sample.txt', content: 'red green blue' }] } } : {}) }
  const serialized = serializeExperimentImport(spec)
  assert.equal(serialized.ok, true)
  const imported = parseExperimentImport(serialized.text)
  assert.equal(imported.ok, true)
  const built = buildExperiment(imported.spec, { experiments: [] })
  assert.equal(built.ok, true)
  seedExperiments(built.next, { accountId: 'fixture-account', persist: async () => ({ ok: true }) })
  const run = () => dispatchExperiment(built.experiment.id, {
    agent: { onEvent: () => () => {} }, persist: async () => ({ ok: true }), startAgent })
  return { run, starts, sends, values, access }
}

test('imported clean-room experiment stores real scope before the actual launch flow sends only its prompt', async t => {
  const f = flow(t)
  assert.equal((await f.run()).ok, true)
  assert.equal(f.starts.length, 1)
  assert.equal(f.sends.length, 1)
  assert.equal(f.starts[0].researchSetup, true)
  assert.equal(f.starts[0].treeIdentity.selfName, f.starts[0].requestKeys.threadId)
  assert.equal(f.sends[0].text, f.starts[0].research.prompt)
  assert.deepEqual(f.starts[0].research.files, [{ path: 'inputs/sample.txt', content: 'red green blue' }])
})

test('checkbox off retains ordinary imported/manual start with no research marker or grant', async t => {
  const f = flow(t, { cleanRoom: false })
  assert.equal((await f.run()).ok, true)
  assert.equal(f.sends.length, 1)
  assert.equal(Object.hasOwn(f.starts[0], 'research'), false)
  assert.equal(Object.hasOwn(f.starts[0], 'researchSetup'), false)
})

for (const options of [{ missingScope: true }, { failScopeSave: true }]) {
  test('missing or unsaved scope stops first send while retaining the visible session: ' + JSON.stringify(options), async t => {
    const f = flow(t, options)
    const result = await f.run()
    assert.equal(result.ok, true, 'the batch records the failed cell without claiming a worker was accepted')
    assert.equal(result.startedCount, 0)
    assert.equal(f.starts.length, 1)
    assert.equal(f.sends.length, 0)
    const cell = experimentsSnapshot().experiments[0].cells[0]
    assert.equal(cell.sessionId, f.starts[0].sessionId)
    assert.equal(cell.status, 'failed')
  })
}
