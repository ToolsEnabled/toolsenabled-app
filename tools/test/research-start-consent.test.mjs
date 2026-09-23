import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'

register('./css-loader.mjs', import.meta.url)

const { startAgentForNode } = await import('../../src/views/computers.js')
const { resolveDataSource } = await import('../../src/data-source.js')
const { setWriteEnabled } = await import('../../src/write-flags.js')
const { START_CONTROL_FLAG, startControlOffReason } = await import('../../src/setup-profile.js')
const {
  EXPERIMENT_COMPUTER_ID, buildExperiment, dispatchExperiment,
  experimentsSnapshot, resetExperimentTracking, seedExperiments,
} = await import('../../src/research-experiments.js')
const { createFleetTreeStore, safeTreeStorage } = await import('../../src/fleet-trees.js')

// Actual dispatcher, starter, consent writer/reader and stores; only browser
// globals and the host IPC endpoints are in-memory stand-ins. No host launches.
async function fixture(t, { enabled = true, hold = null } = {}) {
  resetExperimentTracking()
  const originals = new Map(['window', 'localStorage', 'CustomEvent'].map(key => [key,
    Object.getOwnPropertyDescriptor(globalThis, key)]))
  const values = new Map()
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  }
  const starts = [], sends = [], closes = [], persisted = []
  let release
  const held = new Promise(resolve => { release = resolve })
  const bridge = {
    onEvent: () => () => {},
    async start(request) {
      starts.push(request)
      const sessionId = `research-session-${starts.length}`
      if (hold === 'start' && starts.length === 1) await held
      return { ok: true, sessionId }
    },
    async send(request) {
      sends.push(request)
      if (hold === 'send' && sends.length === 1) await held
      return { ok: true }
    },
    async close(request) { closes.push(request); return { ok: true } },
  }
  const window = { localStorage: storage, mcAgent: bridge,
    mcShell: { getBridgeProof: () => assert.fail('fixture must not request host credentials') },
    dispatchEvent() {}, addEventListener() {}, removeEventListener() {},
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: window })
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
  Object.defineProperty(globalThis, 'CustomEvent', { configurable: true, value: class {
    constructor(type, options = {}) { this.type = type; this.detail = options.detail }
  } })
  t.after(() => {
    release()
    resetExperimentTracking()
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  })
  assert.equal(await resolveDataSource({ reask: true }), 'local')
  setWriteEnabled(START_CONTROL_FLAG, enabled)
  const built = buildExperiment({
    name: 'Consent integration fixture',
    axes: [{ id: 'tier', values: ['luna', 'terra'] }],
    runner: { kind: 'agent', briefTemplate: 'Report the fixture result.' },
    runsPerCell: 1,
  }, { experiments: [], damaged: false })
  assert.equal(built.ok, true)
  seedExperiments({ experiments: built.next.experiments, damaged: false })
  return { starts, sends, closes, persisted, release,
    disable: () => setWriteEnabled(START_CONTROL_FLAG, false),
    run: () => dispatchExperiment(built.experiment.id, { agent: bridge,
      persist: serialized => { persisted.push(serialized) }, startAgent: startAgentForNode }),
    cells: () => experimentsSnapshot().experiments[0].cells,
    nodes: () => createFleetTreeStore({ computerId: EXPERIMENT_COMPUTER_ID,
      storage: safeTreeStorage(storage) }).snapshot().nodes,
  }
}

test('enabled research dispatch uses the actual helper and records every opened worker', async t => {
  const f = await fixture(t)
  const result = await f.run()
  assert.equal(result.ok, true)
  assert.equal(result.startedCount, 2)
  assert.deepEqual(f.starts.map(request => request.surface), ['research-experiment', 'research-experiment'])
  assert.deepEqual(f.starts.map(request => request.tier), ['luna', 'terra'])
  assert.deepEqual(f.sends.map(request => request.sessionId), ['research-session-1', 'research-session-2'])
  assert.ok(f.cells().every(cell => cell.status === 'running'))
  assert.deepEqual(f.nodes().map(node => node.sessionId).sort(), ['research-session-1', 'research-session-2'])
  assert.equal(f.persisted.length, 1)
  assert.deepEqual(f.closes, [])
})

test('disabled research dispatch records the actual refusal and opens no worker', async t => {
  const f = await fixture(t, { enabled: false })
  const result = await f.run()
  assert.equal(result.startedCount, 0)
  assert.deepEqual(f.starts, [])
  assert.deepEqual(f.sends, [])
  assert.ok(f.cells().every(cell => cell.status === 'failed' && cell.sessionId === null))
  assert.ok(f.cells().every(cell => cell.replyExcerpt === startControlOffReason()))
  assert.ok(f.nodes().every(node => node.sessionId === null))
  assert.equal(f.persisted.length, 1)
  assert.deepEqual(f.closes, [])
})

for (const hold of ['start', 'send']) {
  test(`research consent revoked during the first ${hold} keeps that dispatch and refuses later workers`, async t => {
    const f = await fixture(t, { hold })
    const pending = f.run()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.starts.length, 1)
    assert.equal(f.sends.length, hold === 'send' ? 1 : 0)
    f.disable()
    f.release()
    const result = await pending
    assert.equal(result.startedCount, 1)
    assert.equal(f.starts.length, 1, 'a later worker must re-read consent before IPC')
    assert.equal(f.sends.length, 1)
    const [first, second] = f.cells()
    assert.equal(first.status, 'running')
    assert.equal(first.sessionId, 'research-session-1')
    assert.equal(second.status, 'failed')
    assert.equal(second.sessionId, null)
    assert.equal(second.replyExcerpt, startControlOffReason())
    const nodes = f.nodes()
    assert.equal(nodes.find(node => node.id === first.nodeId).sessionId, 'research-session-1')
    assert.equal(nodes.find(node => node.id === second.nodeId).sessionId, null)
    assert.equal(f.persisted.length, 1)
    assert.deepEqual(f.closes, [], 'turning starts off must not cancel a dispatched worker')
  })
}
