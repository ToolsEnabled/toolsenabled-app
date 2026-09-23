import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  EXPERIMENT_COMPUTER_ID,
  MAX_LOCAL_CELLS,
  buildExperiment,
  commitExperimentChange,
  experimentsReadCheckpoint,
  decideDispatch,
  dispatchExperiment,
  experimentsSnapshot,
  parseExperimentsRow,
  removeExperiment,
  resetExperimentTracking,
  seedExperiments,
  serializeExperimentsRow,
  submitExperimentRuns,
  workerBrief,
} from '../../src/research-experiments.js'
import { createFleetTreeStore, isTreeStoreLive, markTreeStoreLive, safeTreeStorage } from '../../src/fleet-trees.js'
import { filesUnder } from '../../src/research-projects.js'

/* ONE experiment model: a grid with a runner, upgraded from v1 on read,
   dispatched locally as tree nodes when it is agent-kind and tree-sized, and
   queued through the research service otherwise. The tree semantics, the
   bounded account row, and the live-store discipline are v1's, unchanged. */

const ROOT = resolve(import.meta.dirname, '..', '..')
const read = file => readFileSync(resolve(ROOT, file), 'utf8')

const EMPTY = Object.freeze({ experiments: [], damaged: false })
const SPEC = Object.freeze({
  name: 'Tokenizer drift sweep',
  axes: [{ id: 'tier', values: ['luna', 'terra'] }],
  runner: { kind: 'agent', briefTemplate: 'Read {dataset} and report the drift.' },
  runsPerCell: 2,
  datasetPath: 'C:/data/drift.jsonl',
})

function memoryStorage() {
  const map = new Map()
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: key => { map.delete(key) },
  }
}

test('local outcomes stay with their account, survive navigation, and flush after returning from another account', async t => {
  resetExperimentTracking()
  const originalWindow = globalThis.window, originalCustomEvent = globalThis.CustomEvent
  globalThis.window = { localStorage: memoryStorage(), dispatchEvent() {} }
  globalThis.CustomEvent = class { constructor(type) { this.type = type } }
  t.after(() => { globalThis.window = originalWindow; globalThis.CustomEvent = originalCustomEvent; resetExperimentTracking() })
  const built = buildExperiment({ ...SPEC, axes: [{ id: 'tier', values: ['luna'] }], runsPerCell: 1 }, EMPTY)
  const rows = new Map([['account-a', built.serialized], ['account-b', built.serialized]])
  const writes = []
  let current = 'account-a', receive
  const persist = accountId => async serialized => {
    if (accountId !== current) return { ok: false, code: 'ACCOUNT_CHANGED', reason: 'Account changed.' }
    rows.set(accountId, serialized); writes.push({ accountId, serialized }); return { ok: true }
  }
  const seed = accountId => seedExperiments(parseExperimentsRow(rows.get(accountId)), { accountId, persist: persist(accountId) })
  seed('account-a')
  await dispatchExperiment(built.experiment.id, { agent: { onEvent: listener => { receive = listener; return () => {} } },
    persist: persist('account-a'), startAgent: async () => ({ ok: true, sessionId: 'scope-local-session' }) })
  // An ordinary same-account remount must preserve the in-flight session.
  seed('account-a')
  assert.equal(experimentsSnapshot().experiments[0].cells[0].sessionId, 'scope-local-session')
  current = 'account-b'; seed('account-b')
  const bBefore = JSON.stringify(experimentsSnapshot())
  receive({ sessionId: 'scope-local-session', event: { type: 'assistant_text_delta', text: 'Retained result for account A.' } })
  receive({ sessionId: 'scope-local-session', event: { type: 'turn_completed', status: 'completed' } })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(JSON.stringify(experimentsSnapshot()), bBefore, 'even an identical imported experiment id cannot receive another account’s outcome')
  assert.equal(rows.get('account-b'), built.serialized)
  current = 'account-a'; seed('account-a')
  await new Promise(resolve => setTimeout(resolve, 0))
  const saved = parseExperimentsRow(rows.get('account-a')).experiments[0].cells[0]
  assert.equal(saved.status, 'finished')
  assert.equal(saved.replyExcerpt, 'Retained result for account A.')
  const terminalWrites = () => writes.filter(write => parseExperimentsRow(write.serialized).experiments[0].cells[0].status === 'finished')
  assert.equal(terminalWrites().length, 1)
  seed('account-a'); receive({ sessionId: 'scope-local-session', event: { type: 'turn_completed', status: 'completed' } })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(terminalWrites().length, 1, 'remounts and repeated events do not duplicate an already durable completion')
})

test('a local start acknowledged after a context change stays attached but cannot start another cell', async t => {
  resetExperimentTracking()
  const originalWindow = globalThis.window, originalCustomEvent = globalThis.CustomEvent
  const storage = memoryStorage()
  globalThis.window = { localStorage: storage, dispatchEvent() {} }
  globalThis.CustomEvent = class { constructor(type) { this.type = type } }
  t.after(() => { globalThis.window = originalWindow; globalThis.CustomEvent = originalCustomEvent; resetExperimentTracking() })
  const built = buildExperiment(SPEC, EMPTY)
  let current = true, starts = 0, writes = 0
  const persist = async () => { if (!current) return { ok: false, reason: 'Account changed.' }; writes++; return { ok: true } }
  seedExperiments(parseExperimentsRow(built.serialized), { accountId: 'account-a', persist })
  const outcome = await dispatchExperiment(built.experiment.id, {
    agent: { onEvent: () => () => {} }, persist, isCurrent: () => current,
    startAgent: async () => { starts++; current = false; seedExperiments(EMPTY, { accountId: 'account-b', persist }); return { ok: true, sessionId: 'acknowledged-old-account-session' } },
  })
  assert.equal(outcome.ok, false)
  assert.match(outcome.sentence, /changed/)
  assert.equal(starts, 1); assert.equal(writes, 0)
  assert.deepEqual(experimentsSnapshot().experiments, [])
  const nodes = JSON.parse(storage.getItem('mc.fleet.trees.v1:this-computer')).nodes
  assert.equal(nodes.filter(node => node.sessionId === 'acknowledged-old-account-session').length, 1)
})

test('a local worker completing before its first-send acknowledgement keeps the actual result', async t => {
  resetExperimentTracking()
  const originalWindow = globalThis.window, originalCustomEvent = globalThis.CustomEvent
  globalThis.window = { localStorage: memoryStorage(), dispatchEvent() {} }
  globalThis.CustomEvent = class { constructor(type) { this.type = type } }
  t.after(() => { globalThis.window = originalWindow; globalThis.CustomEvent = originalCustomEvent; resetExperimentTracking() })
  const built = buildExperiment({ ...SPEC, axes: [{ id: 'tier', values: ['luna'] }], runsPerCell: 1 }, EMPTY)
  let receive, saved
  const persist = async value => { saved = value; return { ok: true } }
  seedExperiments(parseExperimentsRow(built.serialized), { accountId: 'account-a', persist })
  const outcome = await dispatchExperiment(built.experiment.id, {
    agent: { onEvent: listener => { receive = listener; return () => {} } }, persist,
    startAgent: async ({ onSessionOpen }) => {
      onSessionOpen?.({ sessionId: 'fast-local-session' })
      receive({ sessionId: 'fast-local-session', event: { type: 'assistant_text_delta', text: 'Immediate answer.' } })
      receive({ sessionId: 'fast-local-session', event: { type: 'turn_completed', status: 'completed' } })
      await new Promise(resolve => setTimeout(resolve, 0))
      return { ok: true, sessionId: 'fast-local-session' }
    },
  })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.startedCount, 1)
  assert.equal(parseExperimentsRow(saved).experiments[0].cells[0].status, 'finished')
  assert.equal(parseExperimentsRow(saved).experiments[0].cells[0].replyExcerpt, 'Immediate answer.')
})

for (const observed of ['running', 'completed', 'unavailable']) test(`a reloaded local experiment recovers its ${observed} session without launching work`, async t => {
  resetExperimentTracking()
  const originalWindow = globalThis.window, originalCustomEvent = globalThis.CustomEvent
  globalThis.window = { localStorage: memoryStorage(), dispatchEvent() {} }
  globalThis.CustomEvent = class { constructor(type) { this.type = type } }
  t.after(() => { globalThis.window = originalWindow; globalThis.CustomEvent = originalCustomEvent; resetExperimentTracking() })
  const built = buildExperiment({ ...SPEC, axes: [{ id: 'tier', values: ['luna'] }], runsPerCell: 1 }, EMPTY)
  Object.assign(built.experiment.cells[0], { status: 'running', sessionId: 'retained-session', nodeId: 'retained-node' })
  let receive, saved, observedReads = 0
  const agent = {
    onEvent(listener) { receive = listener; return () => {} },
    async sessionActivity({ sessionId }) {
      assert.equal(sessionId, 'retained-session'); observedReads++
      return observed === 'unavailable' ? { ok: false, code: 'MC_AGENT_UNKNOWN_SESSION' }
        : { ok: true, busy: observed === 'running', turnsCompleted: observed === 'completed' ? 1 : 0, lastTurnStatus: observed === 'completed' ? 'success' : null }
    },
  }
  seedExperiments(parseExperimentsRow(serializeExperimentsRow(built.next)), {
    accountId: 'account-a', agent, persist: async value => { saved = value; return { ok: true } },
    transcripts: { async read({ computerId, nodeId }) {
      assert.equal(computerId, EXPERIMENT_COMPUTER_ID); assert.equal(nodeId, 'retained-node')
      return { ok: true, entries: [{ id: 'agent:older-session:turn', who: 'agent', text: 'Do not copy another session.' },
        { id: 'agent:retained-session:turn', who: 'agent', text: 'Actual retained answer.' }] }
    } },
  })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(typeof receive, 'function')
  assert.equal(observedReads, 1)
  if (observed === 'running') {
    assert.equal(experimentsSnapshot().experiments[0].cells[0].status, 'running')
    receive({ sessionId: 'retained-session', event: { type: 'assistant_text_delta', text: 'A later observed answer.' } })
    receive({ sessionId: 'retained-session', event: { type: 'turn_completed', status: 'completed' } })
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(parseExperimentsRow(saved).experiments[0].cells[0].replyExcerpt, 'A later observed answer.')
  } else if (observed === 'completed') {
    const cell = parseExperimentsRow(saved).experiments[0].cells[0]
    assert.equal(cell.status, 'finished'); assert.equal(cell.replyExcerpt, 'Actual retained answer.')
  } else {
    assert.equal(experimentsSnapshot().experiments[0].cells[0].status, 'unconfirmed')
    const attempt = await dispatchExperiment(built.experiment.id, { agent, persist: async () => assert.fail('no guessed write'), startAgent: () => assert.fail('no automatic replacement') })
    assert.equal(attempt.ok, false); assert.match(attempt.sentence, /confirmed|Inspect/)
  }
})

test('a spec builds bounded cells, and every refusal is a sentence', () => {
  const built = buildExperiment(SPEC, EMPTY)
  assert.equal(built.ok, true)
  assert.equal(built.experiment.cells.length, 4, 'two tiers times two repeats')
  assert.ok(built.experiment.cells.every(cell => cell.status === 'designed'))
  assert.deepEqual(built.experiment.cells.map(cell => cell.params.tier), ['luna', 'luna', 'terra', 'terra'],
    'row-major with replicates inner reproduces the v1 cell order exactly')

  const noTier = buildExperiment({ ...SPEC, axes: [{ id: 'style', values: ['a'] }] }, EMPTY)
  assert.equal(noTier.ok, false)
  assert.match(noTier.sentence, /at least one model tier/)
  const badRuns = buildExperiment({ ...SPEC, runsPerCell: 0 }, EMPTY)
  assert.equal(badRuns.ok, false)
  const strayToken = buildExperiment({ ...SPEC, runner: { kind: 'agent', briefTemplate: 'Do {missing_axis}.' } }, EMPTY)
  assert.equal(strayToken.ok, false)
  assert.match(strayToken.sentence, /no axis called missing_axis/, 'an unknown token is refused at design, never mid-run')
})

test('an oversized grid is refused by its measured count, counting repeats', () => {
  const wide = buildExperiment({
    ...SPEC,
    axes: [{ id: 'tier', values: ['luna'] }, { id: 'v', values: Array.from({ length: 24 }, (_x, i) => `v${i}`) }, { id: 'w', values: Array.from({ length: 5 }, (_x, i) => `w${i}`) }],
    runsPerCell: 5,
  }, EMPTY)
  assert.equal(wide.ok, false)
  assert.match(wide.sentence, /600 runs/, 'the refusal states what it measured, repeats included')
})

test('decideDispatch: tree-sized agent grids run local, everything else queues under a project', () => {
  const local = buildExperiment(SPEC, EMPTY).experiment
  assert.deepEqual(decideDispatch(local), { ok: true, mode: 'local' })
  assert.equal(local.cells.length <= MAX_LOCAL_CELLS, true)

  const big = buildExperiment({ ...SPEC, axes: [{ id: 'tier', values: ['luna', 'terra', 'sol'] }], runsPerCell: 3 }, EMPTY).experiment
  assert.equal(big.cells.length, 9)
  assert.equal(decideDispatch(big).ok, false, 'queue-sized with no project is a refusal, not a guess')
  assert.match(decideDispatch(big).sentence, /pick one above/)
  assert.deepEqual(decideDispatch(big, { projectId: 'rp-1234' }), { ok: true, mode: 'queue', projectId: 'rp-1234' })

  const process = buildExperiment({
    ...SPEC, axes: [{ id: 'n', values: ['1'] }], runsPerCell: 1,
    runner: { kind: 'process', command: 'node', args: [] },
  }, EMPTY).experiment
  assert.equal(decideDispatch(process).ok, false, 'a command never runs from the bench, whatever its size')
  assert.equal(decideDispatch(process, { projectId: 'rp-1' }).mode, 'queue')
})

test('6-, 7- and 8-cell local grids start every cell: the experiment tree is exempt from the agent-tree width', async () => {
  /* The owner, 2026-09-11: "loops and grids dont even need to be tied together
     or to any of this". A local grid is one tree -- the first cell is its root,
     every other cell a child -- so when the agent-tree width fell to four, the
     base dispatcher lost every cell past the fifth to "This agent already has
     four agents under it". The grid marks the tree it builds as an experiment
     tree, and that tree keeps the width it always had, the engine's eight. */
  const grids = [
    [6, { axes: [{ id: 'tier', values: ['luna', 'terra', 'sol'] }], runsPerCell: 2 }],
    [7, { axes: [{ id: 'tier', values: ['astra', 'luna', 'terra', 'sol', 'claude-fable', 'claude-sonnet', 'claude-opus'] }], runsPerCell: 1 }],
    [8, { axes: [{ id: 'tier', values: ['luna', 'terra'] }], runsPerCell: 4 }],
  ]
  for (const [size, shape] of grids) {
    resetExperimentTracking()
    const storage = memoryStorage()
    const originalWindow = globalThis.window
    globalThis.window = { localStorage: storage, dispatchEvent: () => {}, addEventListener: () => {}, removeEventListener: () => {} }
    try {
      const built = buildExperiment({ ...SPEC, ...shape }, EMPTY)
      assert.equal(built.ok, true, built.sentence)
      assert.equal(built.experiment.cells.length, size)
      assert.deepEqual(decideDispatch(built.experiment), { ok: true, mode: 'local' }, `a ${size}-cell grid is tree-sized`)
      seedExperiments({ experiments: built.next.experiments, damaged: false })
      let sessions = 0
      const outcome = await dispatchExperiment(built.experiment.id, {
        agent: { onEvent: () => () => {} },
        persist: () => {},
        startAgent: async () => ({ ok: true, sessionId: `grid-${size}-session-${(sessions += 1)}` }),
      })
      const cells = experimentsSnapshot().experiments[0].cells
      assert.deepEqual(cells.filter(cell => cell.status !== 'running').map(cell => cell.replyExcerpt), [],
        `the ${size}-cell grid lost cells`)
      assert.equal(outcome.startedCount, size)

      // The tree it built carries the mark, and every cell after the first is live under its root.
      const trees = createFleetTreeStore({ computerId: EXPERIMENT_COMPUTER_ID, storage: safeTreeStorage(storage) })
      const [tree] = trees.listTrees()
      assert.equal(tree.kind, 'experiment', 'the grid did not mark its tree')
      const root = trees.rootOf(tree.id)
      assert.equal(trees.childrenOf(root.id).filter(node => node.status === 'starting' || node.status === 'running').length, size - 1)

      // An agent tree in the same store still seats four and refuses a fifth.
      const top = trees.addNode({ role: 'manager' }).node
      assert.notEqual(top.treeId, tree.id)
      for (let index = 0; index < 4; index += 1) {
        const child = trees.addNode({ parentId: top.id, role: 'worker' }).node
        assert.equal(trees.setNodeStatus(child.id, 'starting').ok, true, `agent-tree child ${index + 1} of four`)
      }
      assert.equal(trees.addNode({ parentId: top.id, role: 'worker' }).ok, false, 'an agent tree beside the grid seated a fifth live child')
    } finally {
      globalThis.window = originalWindow
      resetExperimentTracking()
    }
  }
})

test('the brief substitutes the dataset as TEXT and names the cell', () => {
  const built = buildExperiment(SPEC, EMPTY)
  const brief = workerBrief(built.experiment, built.experiment.cells[0])
  assert.match(brief, /C:\/data\/drift\.jsonl/)
  assert.match(brief, /luna · #1/)
  assert.ok(!brief.includes('{dataset}'))
})

test('a v1-upgraded row with a stray token falls back to plain dataset substitution', () => {
  const v1Raw = JSON.stringify({
    v: 1,
    experiments: [{
      id: 'exp-legacy', name: 'Legacy', promptTemplate: 'Read {dataset} and keep {this} literal.',
      datasetPath: 'C:/data/x.jsonl', createdAtMs: 5, treeId: null,
      cells: [{ tier: 'luna', run: 1, status: 'designed', sessionId: null, nodeId: null, startedAtMs: null, endedAtMs: null, replyExcerpt: '' }],
    }],
  })
  const upgraded = parseExperimentsRow(v1Raw).experiments[0]
  const brief = workerBrief(upgraded, upgraded.cells[0])
  assert.match(brief, /C:\/data\/x\.jsonl/)
  assert.match(brief, /\{this\}/, 'a stray token in v1 prose stays literal, exactly as v1 ran it')
})

test('a malformed stored v2 experiment drops at the parse gate, never reaching a renderer', () => {
  // The re-review's finding: the gate must enforce what renderDesigner
  // dereferences, or one bad row from a partial write or another device
  // blanks the whole bench with a throw instead of losing the one row.
  const good = buildExperiment(SPEC, EMPTY)
  const raw = JSON.stringify({
    v: 2,
    experiments: [
      good.experiment,
      { id: 'exp-bad-1', name: 'No brief', runner: { kind: 'agent' }, axes: [{ id: 'tier', values: ['luna'] }], cells: [] },
      { id: 'exp-bad-2', name: 'Null axis', runner: { kind: 'process', command: 'node' }, axes: [null], cells: [] },
      { id: 'exp-bad-3', name: 'Bare cells', runner: { kind: 'agent', briefTemplate: 'Do it.' }, axes: [{ id: 'tier', values: ['luna'] }], cells: [{}] },
    ],
  })
  const parsed = parseExperimentsRow(raw)
  assert.equal(parsed.damaged, false)
  assert.deepEqual(parsed.experiments.map(experiment => experiment.id), [good.experiment.id],
    'the three malformed rows drop; the good one survives')
})

test('the row round-trips as v2 and damage is stated', () => {
  const built = buildExperiment(SPEC, EMPTY)
  const serialized = serializeExperimentsRow(built.next)
  assert.match(serialized, /"v":2/)
  const parsed = parseExperimentsRow(serialized)
  assert.equal(parsed.experiments.length, 1)
  assert.equal(parsed.experiments[0].name, SPEC.name)
  assert.equal(parseExperimentsRow('broken').damaged, true)
  assert.equal(parseExperimentsRow(null).damaged, false)
  assert.equal(serializeExperimentsRow({ experiments: [] }), null)
  const removed = removeExperiment(built.next, built.experiment.id)
  assert.equal(removed.ok, true)
  assert.equal(removed.serialized, null)
})

test('a v1 row upgrades on read: order, status and excerpts preserved, and the upgrade is idempotent', () => {
  const v1Raw = JSON.stringify({
    v: 1,
    experiments: [{
      id: 'exp-old', name: 'Old sweep', promptTemplate: 'Read {dataset}.',
      datasetPath: 'C:/data/old.jsonl', createdAtMs: 7, treeId: 'tree-1',
      cells: [
        { tier: 'luna', run: 1, status: 'finished', sessionId: 's1', nodeId: 'n1', startedAtMs: 1, endedAtMs: 2, replyExcerpt: 'kept' },
        { tier: 'luna', run: 2, status: 'failed', sessionId: null, nodeId: 'n2', startedAtMs: 1, endedAtMs: 3, replyExcerpt: 'also kept' },
        { tier: 'terra', run: 1, status: 'designed', sessionId: null, nodeId: null, startedAtMs: null, endedAtMs: null, replyExcerpt: '' },
        { tier: 'terra', run: 2, status: 'designed', sessionId: null, nodeId: null, startedAtMs: null, endedAtMs: null, replyExcerpt: '' },
      ],
    }],
  })
  const upgraded = parseExperimentsRow(v1Raw)
  assert.equal(upgraded.damaged, false)
  const experiment = upgraded.experiments[0]
  assert.deepEqual(experiment.axes, [{ id: 'tier', values: ['luna', 'terra'] }])
  assert.equal(experiment.runsPerCell, 2)
  assert.equal(experiment.runner.kind, 'agent')
  assert.equal(experiment.projectId, null)
  assert.deepEqual(experiment.cells.map(cell => cell.params), [
    { tier: 'luna', replicate: 1 }, { tier: 'luna', replicate: 2 },
    { tier: 'terra', replicate: 1 }, { tier: 'terra', replicate: 2 },
  ], 'the tracked map indexes into this array; order is load-bearing')
  assert.deepEqual(experiment.cells.map(cell => cell.status), ['finished', 'failed', 'designed', 'designed'])
  assert.equal(experiment.cells[0].replyExcerpt, 'kept')
  const again = parseExperimentsRow(serializeExperimentsRow(upgraded))
  assert.deepEqual(again.experiments, upgraded.experiments, 're-serializing the upgrade changes nothing')
})

test('submitExperimentRuns queues designed cells: inline spec first, service id after, refusals honest', async () => {
  resetExperimentTracking()
  try {
    const big = buildExperiment({ ...SPEC, axes: [{ id: 'tier', values: ['luna', 'terra', 'sol'] }], runsPerCell: 3 }, EMPTY)
    seedExperiments({ experiments: big.next.experiments, damaged: false })
    const bodies = []
    let counter = 0
    const outcome = await submitExperimentRuns(big.experiment.id, {
      projectId: 'rp-abcd',
      persist: () => {},
      submit: async body => {
        bodies.push(body)
        counter += 1
        if (counter === 5) return { ok: false, reason: 'the research pipeline is off' }
        return { ok: true, disposition: counter === 2 ? 'replay' : 'submitted', run: { runId: `rr-${counter}` }, experiment: { experimentId: 'rx-service' } }
      },
    })
    assert.equal(outcome.ok, true)
    assert.equal(outcome.submitted, 7)
    assert.equal(outcome.replayed, 1)
    assert.match(outcome.sentence, /pipeline is off/, 'the refused cell rides back as a sentence, not silence')
    assert.ok(Object.hasOwn(bodies[0], 'experiment'), 'the first submit registers the declaration inline')
    assert.ok(bodies.slice(1).every(body => body.experimentId === 'rx-service'),
      'every later cell submits by the captured service id, never a second inline spec')
    const cells = experimentsSnapshot().experiments[0].cells
    assert.equal(cells.filter(cell => cell.status === 'queued').length, 8)
    assert.equal(cells.filter(cell => cell.status === 'designed').length, 1, 'the refused cell stays designed — the honest state')
    const paramKeys = new Set(bodies.map(body => JSON.stringify(body.params)))
    assert.equal(paramKeys.size, bodies.length,
      'the replicate key keeps every repeat a distinct params hash, or the service would replay them into one run')

    // Resubmitting sends ONLY the remaining designed cell, by service id.
    bodies.length = 0
    const retry = await submitExperimentRuns(big.experiment.id, {
      projectId: 'rp-abcd', persist: () => {},
      submit: async body => { bodies.push(body); return { ok: true, disposition: 'submitted', run: { runId: 'rr-late' }, experiment: { experimentId: 'rx-service' } } },
    })
    assert.equal(bodies.length, 1)
    assert.equal(bodies[0].experimentId, 'rx-service')
    assert.equal(retry.submitted, 1)
  } finally {
    resetExperimentTracking()
  }
})

test('dispatch builds one tree of real nodes and starts one worker per cell', async () => {
  resetExperimentTracking()
  const storage = memoryStorage()
  const originalWindow = globalThis.window
  globalThis.window = { localStorage: storage, dispatchEvent: () => {}, addEventListener: () => {}, removeEventListener: () => {} }
  try {
    const built = buildExperiment(SPEC, EMPTY)
    seedExperiments({ experiments: built.next.experiments, damaged: false })
    const startedBriefs = []
    let persisted = null
    const outcome = await dispatchExperiment(built.experiment.id, {
      agent: { onEvent: () => () => {} },
      persist: serialized => { persisted = serialized },
      startAgent: async ({ text, surface, tier, requestKeys }) => {
        startedBriefs.push({ text, surface, tier, requestKeys })
        return { ok: true, sessionId: `chat-test-${startedBriefs.length}` }
      },
    })
    assert.equal(outcome.ok, true)
    assert.equal(outcome.startedCount, 4)
    assert.equal(startedBriefs.length, 4)
    assert.ok(startedBriefs.every(request => request.surface === 'research-experiment'))
    assert.deepEqual(startedBriefs.map(request => request.tier), ['luna', 'luna', 'terra', 'terra'])

    /* What dispatch WROTE is read from the raw record: running, with the
       session attached. A fresh store instance deliberately demotes a
       persisted 'running' to 'starting' on load (a run it did not witness is
       not one it may claim), so the rehydrated read asserts THAT. */
    const raw = storage.getItem('mc.fleet.trees.v1:this-computer') || ''
    assert.equal((raw.match(/"status":"running"/g) || []).length, 4, 'dispatch did not record four running workers')
    const store = createFleetTreeStore({ computerId: EXPERIMENT_COMPUTER_ID, storage: safeTreeStorage(storage) })
    const snapshot = store.snapshot()
    const nodes = snapshot.nodes.filter(node => node.sessionId)
    assert.equal(nodes.length, 4, 'every cell landed as a session-bearing node')
    assert.equal(new Set(nodes.map(node => node.treeId)).size, 1, 'one experiment is one tree')
    assert.ok(nodes.every(node => node.status === 'starting'),
      'a fresh instance rehydrates running as starting — the honest unwitnessed state')
    for (const [index, request] of startedBriefs.entries()) {
      const node = nodes.find(node => node.sessionId === `chat-test-${index + 1}`)
      assert.equal(request.requestKeys?.threadId, node.id, 'the host must bind the native transcript to this exact saved circle before sending')
      assert.deepEqual(request.requestKeys.treeAnchors, node.parentId ? [node.parentId, node.id] : [node.id])
    }
    assert.equal(typeof persisted, 'string', 'the results row was persisted after dispatch')
    const snapshotState = experimentsSnapshot()
    assert.ok(snapshotState.experiments[0].cells.every(cell => cell.status === 'running'))
  } finally {
    globalThis.window = originalWindow
    resetExperimentTracking()
  }
})

test('a refused start fails its cell with the sentence and the rest continue', async () => {
  resetExperimentTracking()
  const storage = memoryStorage()
  const originalWindow = globalThis.window
  globalThis.window = { localStorage: storage, dispatchEvent: () => {}, addEventListener: () => {}, removeEventListener: () => {} }
  try {
    const built = buildExperiment({ ...SPEC, axes: [{ id: 'tier', values: ['luna'] }], runsPerCell: 2 }, EMPTY)
    seedExperiments({ experiments: built.next.experiments, damaged: false })
    let calls = 0
    const outcome = await dispatchExperiment(built.experiment.id, {
      agent: { onEvent: () => () => {} },
      persist: () => {},
      startAgent: async () => {
        calls += 1
        if (calls === 1) return { ok: false, sessionId: null, sentence: 'Nothing was started for this test.' }
        return { ok: true, sessionId: 'chat-test-second' }
      },
    })
    assert.equal(outcome.ok, true)
    assert.equal(outcome.startedCount, 1)
    const cells = experimentsSnapshot().experiments[0].cells
    assert.equal(cells[0].status, 'failed')
    assert.match(cells[0].replyExcerpt, /Nothing was started/)
    assert.equal(cells[1].status, 'running')
  } finally {
    globalThis.window = originalWindow
    resetExperimentTracking()
  }
})

test('a queue-sized experiment refuses the local dispatcher by name', async () => {
  resetExperimentTracking()
  try {
    const big = buildExperiment({ ...SPEC, axes: [{ id: 'tier', values: ['luna', 'terra', 'sol'] }], runsPerCell: 3 }, EMPTY)
    seedExperiments({ experiments: big.next.experiments, damaged: false })
    const outcome = await dispatchExperiment(big.experiment.id, {
      agent: null, persist: () => {}, startAgent: async () => ({ ok: true, sessionId: 'never' }),
    })
    assert.equal(outcome.ok, false)
    assert.match(outcome.sentence, /queue/)
  } finally {
    resetExperimentTracking()
  }
})

test('the live-store registry refuses a second writer and releases exactly once', () => {
  assert.equal(isTreeStoreLive('probe-computer'), false)
  const release = markTreeStoreLive('probe-computer')
  assert.equal(isTreeStoreLive('probe-computer'), true)
  const second = markTreeStoreLive('probe-computer')
  release()
  assert.equal(isTreeStoreLive('probe-computer'), true, 'the second holder keeps it live')
  release()
  assert.equal(isTreeStoreLive('probe-computer'), true, 'a double release must not free another holder')
  second()
  assert.equal(isTreeStoreLive('probe-computer'), false)
})

test('a completed worker does not overwrite the tree while a view store is live', async () => {
  resetExperimentTracking()
  const storage = memoryStorage()
  const originalWindow = globalThis.window
  const originalCustomEvent = globalThis.CustomEvent
  globalThis.window = { localStorage: storage, dispatchEvent: () => {}, addEventListener: () => {}, removeEventListener: () => {} }
  globalThis.CustomEvent = class CustomEvent { constructor(type) { this.type = type } }
  let receiveAgentEvent
  const releaseViewStore = markTreeStoreLive(EXPERIMENT_COMPUTER_ID)
  try {
    const built = buildExperiment({ ...SPEC, axes: [{ id: 'tier', values: ['luna'] }], runsPerCell: 1 }, EMPTY)
    seedExperiments({ experiments: built.next.experiments, damaged: false })
    const outcome = await dispatchExperiment(built.experiment.id, {
      agent: { onEvent: listener => { receiveAgentEvent = listener; return () => {} } },
      persist: () => {},
      startAgent: async () => ({ ok: true, sessionId: 'chat-live-store' }),
    })
    assert.equal(outcome.ok, true)
    const beforeCompletion = storage.getItem('mc.fleet.trees.v1:this-computer')
    receiveAgentEvent({ sessionId: 'chat-live-store', event: { type: 'assistant_text_delta', text: 'finished answer' } })
    receiveAgentEvent({ sessionId: 'chat-live-store', event: { type: 'turn_completed', status: 'completed' } })
    assert.equal(experimentsSnapshot().experiments[0].cells[0].status, 'finished',
      'the experiment outcome must still be filed while the computers view owns the tree')
    assert.equal(storage.getItem('mc.fleet.trees.v1:this-computer'), beforeCompletion,
      'a worker completion overwrote the tree record beside a live view store')
  } finally {
    releaseViewStore()
    globalThis.window = originalWindow
    globalThis.CustomEvent = originalCustomEvent
    resetExperimentTracking()
  }
})

test('the computers view exposes the shared starter and the research view wires the bench', () => {
  const computers = read('src/views/computers.js')
  assert.match(computers, /treeStoreLiveRelease = markTreeStoreLive\(computerId\)/,
    'the computers view no longer marks its store live; the registry reads empty and the listener writes beside it')
  assert.match(computers, /export async function startAgentForNode/,
    'the shared start contract is no longer exported; the bench would need its own copy')
  const view = read('src/views/research.js')
  assert.match(view, /startAgent: startAgentForNode/, 'the bench dispatches through a different start path than the compose panel')
  for (const hook of ['data-exp-form', 'data-exp-run', 'data-results-csv', 'data-results-json']) {
    assert.match(view, new RegExp(hook), `the bench lost its ${hook} control`)
  }
  assert.match(view, /Set up clean rooms for agents/, 'clean-room setup is not an explicit opt-in')
  assert.match(view, /name="agentSetupAccess"/, 'clean-room access choice is missing')
  assert.match(view, /data-exp-import-file/, 'experiment import is not connected to a file input')
  assert.match(view, /data-exp-export/, 'editable experiment download control is missing')
  assert.ok(view.includes('parseExperimentImport(await file.text())'), 'experiment import must prefill from the selected file')
  assert.ok(!view.includes('data-grid-form'), 'the second designer form is gone; one form designs every experiment')
})

test('the gathered chips speak service truth for queued cells, without mutation', async () => {
  const { cellsWithServiceStatus } = await import('../../src/research-experiments.js')
  const experiment = {
    cells: [
      { params: { a: 2 }, status: 'queued', runId: 'rr-done' },
      { params: { a: 3 }, status: 'queued', runId: 'rr-broke' },
      { params: { a: 4 }, status: 'queued', runId: 'rr-busy' },
      { params: { a: 5 }, status: 'queued', runId: 'rr-waiting' },
      { params: { a: 6 }, status: 'queued', runId: 'rr-odd' },
      { params: { a: 7 }, status: 'queued' },              // never submitted a runId
      { params: { a: 8 }, status: 'finished', runId: 'rr-done' }, // local truth wins when not queued
    ],
  }
  const runs = [
    { runId: 'rr-done', task: { status: 'succeeded' } },
    { runId: 'rr-broke', task: { status: 'failed' } },
    { runId: 'rr-busy', task: { status: 'claimed' } },
    { runId: 'rr-waiting', task: { status: 'queued' } },
    { runId: 'rr-odd', task: { status: 'held' } },
    { runId: 'rr-null', task: null },
  ]
  const shown = cellsWithServiceStatus(experiment, runs)
  assert.deepEqual(shown.map(cell => cell.status),
    ['unverified', 'failed', 'claimed', 'queued', 'held', 'queued', 'finished'],
    'succeeded without evidence remains unverified; unknown words still pass through honestly')
  assert.ok(experiment.cells.every(cell => ['queued', 'finished'].includes(cell.status)),
    'the account rows themselves are untouched — display only')
  assert.deepEqual(cellsWithServiceStatus(experiment, undefined).map(cell => cell.status),
    experiment.cells.map(cell => cell.status), 'no runs, no change')

  const view = read('src/views/research.js')
  assert.match(view, /data-gathered-cells/, 'the gathered panel lost its addressable chips block')
  assert.match(view, /cellsWithServiceStatus\(experiment, read\.runs\)/,
    'the service read no longer refreshes the chips from service truth')
})

test('removing an experiment card takes two presses, and a lone press disarms', () => {
  const view = read('src/views/research.js')
  const handler = view.slice(view.indexOf('if (removeId) {'))
  assert.match(handler, /Press again to remove/, 'the first press must arm, not remove')
  assert.match(handler, /dataset\.armed !== 'true'/, 'the removal no longer checks the armed state before acting')
  assert.match(handler, /button\.isConnected && button\.dataset\.armed === 'true'/,
    'a lone press must disarm itself so the label never lies')
  assert.ok(handler.indexOf('Press again to remove') < handler.indexOf('removeExperiment('),
    'the arm gate must sit before the destructive call')
})

test('the bench follows the project selector, hides nothing unreachable, and says what it left out', () => {
  const view = read('src/views/research.js')
  const benchAt = view.indexOf('function benchExperiments')
  assert.ok(benchAt !== -1, 'the shared bench filter is gone')
  const bench = view.slice(benchAt, benchAt + 1200)
  const filterBody = view.slice(benchAt, view.indexOf('\n  }', benchAt) + 4)
  const filter = new Function('selection', 'experimentsSnapshot', 'filesUnder', `${filterBody}; return benchExperiments()`)
  const rows = [{ id: 'a', projectId: 'rp-aaaa' }, { id: 'b', projectId: 'rp-bbbb' }, { id: 'unfiled' }]
  for (const [selection, ids] of [['rp-aaaa', ['a']], ['rp-bbbb', ['b']], ['unfiled', ['unfiled']], ['all', ['a', 'b', 'unfiled']]]) {
    const result = filter(selection, () => ({ experiments: rows }), filesUnder)
    assert.deepEqual(result.shown.map(row => row.id), ids, `${selection} shows only its own experiments`)
    assert.equal(result.hidden, rows.length - ids.length)
  }
  assert.match(bench, /filed under another project/, 'the bench must count what the filter left out')

  // Both bench modules must consume the filter, or the page blends two projects.
  const designer = view.slice(view.indexOf('function renderDesigner'), view.indexOf('function renderRunBoard'))
  assert.match(designer, /benchExperiments\(\)/, 'the designer ignores the project selector again')
  const runboard = view.slice(view.indexOf('function renderRunBoard'), view.indexOf('function renderResults'))
  assert.match(runboard, /benchExperiments\(\)/, 'the run board ignores the project selector again')
  assert.match(runboard, /cellsWithServiceStatus\(experiment, read\.runs\)/,
    'the run board promises live state; queue-dispatched cells must read their service state')

  // Switching projects must re-render the bench, not only the service modules.
  const onChange = view.slice(view.indexOf("projectSelect.addEventListener('change'"))
  const handler = onChange.slice(0, onChange.indexOf('\n  })'))
  assert.match(handler, /renderExperimentModules\(\)/, 'a project switch must re-render the bench')
  assert.match(handler, /renderServiceModules\(\)/)
  assert.match(handler, /gatheredExperimentId = null/, 'a gathered panel from the project just left must close')
})

test('the run board and the service board cannot wipe each other, and the worker press is never silent', () => {
  const view = read('src/views/research.js')
  // Both render into [data-research-runboard]; the bench board assigns
  // innerHTML, which deletes the appended service block and the Start button.
  const runboard = view.slice(view.indexOf('function renderRunBoard'), view.indexOf('function renderResults'))
  // The bench board now owns ONE child block and never writes host.innerHTML,
  // so it cannot delete the service board however it exits; the paired calls
  // remain so the service board repaints with fresh cell words.
  assert.match(runboard, /data-bench-runboard/, 'the bench run board must own its own block')
  assert.doesNotMatch(runboard, /^\s*host\.innerHTML\s*=/m, 'writing the shared host deletes the service board again')
  const results = view.slice(view.indexOf('function renderResults()'), view.indexOf('function renderExperimentModules'))
  assert.match(results, /data-bench-results/, 'the bench results must own their own block')
  assert.doesNotMatch(results, /^\s*host\.innerHTML\s*=/m, 'writing the shared host blanks every service results table on save (installed 1.0.13)')
  assert.match(results, /serviceHasResults/, '"No results have arrived yet." printed above a page of results tables')

  // The cache fill must repaint the bench board, or its cells stay cold.
  const refresh = view.slice(view.indexOf('async function refreshRuns'), view.indexOf('function anyRunActive'))
  assert.match(refresh, /renderRunBoard\(\)/, 'the runs cache fills without repainting the bench board again')

  // A slow lifecycle call must survive the poll's repaint as a pending state.
  assert.match(view, /let workerPending = null/)
  const control = view.slice(view.indexOf('function workerControlMarkup'), view.indexOf('function runDrillMarkup'))
  assert.match(control, /if \(workerPending\)/, 'a repaint mid-call hands back an enabled button again')
  assert.match(control, /This can take a few seconds/)

  // A fully-replayed submit must say so instead of doing nothing visible.
  assert.match(view, /Already queued — the run service recognised all/)
})

test('cells with no service answer say so instead of asserting queued', async () => {
  const { cellsAwaitingService } = await import('../../src/research-experiments.js')
  const experiment = {
    cells: [
      { params: { a: 1 }, status: 'queued', runId: 'rr-1' },
      { params: { a: 2 }, status: 'finished' },
      { params: { a: 3 }, status: 'designed' },
    ],
  }
  assert.deepEqual(cellsAwaitingService(experiment).map(cell => cell.status),
    ['unread', 'finished', 'designed'],
    'a queued cell whose service state is unknown reads unread; local truth is untouched')
  assert.equal(experiment.cells[0].status, 'queued', 'display only — the stored row is unchanged')

  const view = read('src/views/research.js')
  assert.match(view, /unread: 'with the run service'/, 'the unread word lost its sentence')
  assert.match(view, /cellsAwaitingService\(experiment\)/, 'the boards no longer fall back to unread')
  // The poll must refresh the LIFECYCLE too, or a dead worker keeps its word.
  const poll = view.slice(view.indexOf('function scheduleRunPoll'), view.indexOf('function workerControlMarkup'))
  assert.match(poll, /refreshServiceSnapshot\(\)/, 'the poll refreshes runs only; the worker control goes stale again')
  assert.match(view, /Already sent — all \$\{alreadySent\} cells/, 'the replay sentence lost its count')
})

/* THE COPY THIS TEST PINS CHANGED, AND EVERY PROPERTY IT PINNED IS STILL PINNED.
 *
 * It used to require the words "The report catalog could not be read" and the
 * mast line "report catalog: could not be read". Both describe a FAILURE, and on
 * every installed copy there is no failure to describe: tools/gen-research.mjs
 * builds that catalog from a directory of curated documents on the builder's own
 * machine, and those documents are deliberately never shipped (T4c — a previous
 * release carried their titles and absolute paths into the installer). So a
 * customer's copy has no catalog by design, no setting creates one, and the
 * banner told the owner his product was broken. It was not.
 *
 * What this test is FOR survives unchanged: the copy must not claim the whole
 * page failed while a live bench is on screen, the mast must name what is
 * absent, the three seeded "Reading …" lines must be settled, only the loading
 * paragraph may be replaced, and the banner must sit under the mast because its
 * own sentence says "below". Two clauses are added: the block may not print the
 * envelope's internal reason, and may not describe a failure at all. */
test('a copy with no report library says so plainly, and does not leave three modules reading for ever', () => {
  const view = read('src/views/research.js')
  const block = view.slice(view.indexOf('const CATALOG_ABSENT'), view.indexOf('function renderProjection'))
  // The bench and the catalog are different sources; the copy must not claim
  // the whole page failed while projects, runs and results are on screen.
  assert.doesNotMatch(block, /Your research could not be loaded/,
    'the alarming claim is back over a working bench')
  assert.match(block, /There is no report library in this copy/)
  assert.match(block, /read live from this computer and is not affected/)
  assert.match(block, /no report library on this computer/, 'the mast must name what is absent')
  // A failure that did not happen must not be reported as one, and the
  // envelope's own reason must not be quoted at a person: on every install it is
  // the fleet-host sentence, about a file on somebody else's machine.
  assert.doesNotMatch(block, /could not be read/,
    'the banner is claiming a failure again, over a catalog that was never shipped')
  assert.doesNotMatch(block, /esc\(reason/,
    'the envelope reason is back on the glass')
  // The three seeded "Reading …" placeholders must be settled, not left spinning.
  for (const module of ['data-research-library', 'data-research-methods', 'data-research-worklists']) {
    assert.match(block, new RegExp(module), `${module} is left saying "Reading …" for ever again`)
  }
  assert.match(block, /\/\^Reading \/\.test/, 'only the loading placeholder may be replaced')
  assert.match(block, /p\.research-observed-empty/,
    'the working-lists host also holds the findings block; settle the paragraph, not the host')
  assert.match(block, /\.research-mast'\)\.insertAdjacentHTML\('afterend'/,
    'the block says "the bench below" and must sit under the mast, not at the foot of the page')
})

test('the run board speaks the same words as the service board, including stalled', async () => {
  const { cellsWithServiceStatus } = await import('../../src/research-experiments.js')
  // Installed 1.0.12: the same run read "stalled" on the service board and
  // "uncertain" on this one, on the same screen at the same instant, because
  // this map read only task.status and never leaseExpired. It also passed the
  // machine's own enums through raw: retry_wait, leased, uncertain.
  const experiment = {
    cells: [
      { params: { a: 1 }, status: 'queued', runId: 'rr-stalled-running' },
      { params: { a: 2 }, status: 'queued', runId: 'rr-stalled-leased' },
      { params: { a: 3 }, status: 'queued', runId: 'rr-retry' },
      { params: { a: 4 }, status: 'queued', runId: 'rr-leased' },
      { params: { a: 5 }, status: 'queued', runId: 'rr-uncertain-live' },
    ],
  }
  const runs = [
    { runId: 'rr-stalled-running', task: { status: 'uncertain', storedStatus: 'running', leaseExpired: true } },
    { runId: 'rr-stalled-leased', task: { status: 'expired', storedStatus: 'leased', leaseExpired: true } },
    { runId: 'rr-retry', task: { status: 'retry_wait', leaseExpired: false } },
    { runId: 'rr-leased', task: { status: 'leased', leaseExpired: false } },
    { runId: 'rr-uncertain-live', task: { status: 'uncertain', leaseExpired: false } },
  ]
  assert.deepEqual(cellsWithServiceStatus(experiment, runs).map(cell => cell.status),
    ['stalled', 'stalled', 'retrying', 'claimed', 'uncertain'],
    'a dead lease is stalled here too, and no raw machine enum survives')

  // Every key this map can emit must have a word, or the enum reaches a person.
  const view = read('src/views/research.js')
  const wordBlock = view.slice(view.indexOf('const CELL_WORD'), view.indexOf('const CELL_WORD') + 500)
  for (const key of ['stalled', 'retrying', 'claimed', 'cancelled', 'uncertain', 'unread']) {
    assert.match(wordBlock, new RegExp(`${key}:`), `CELL_WORD has no word for ${key}`)
  }

  // And the poll must keep watching a worker the service says is running,
  // even with nothing in flight.
  const poll = view.slice(view.indexOf('function scheduleRunPoll'), view.indexOf('function workerControlMarkup'))
  assert.match(poll, /lifecycle\?\.running === true/, 'an idle dead worker goes unnoticed again')
  assert.match(poll, /active \? 5000 : 15000/, 'the idle watch lost its slower cadence')
})

test('a service experiment fed by several duplicated designs says so', () => {
  const view = read('src/views/research.js')
  const board = view.slice(view.indexOf('function renderServiceRunBoard'), view.indexOf("moduleEl('runboard').addEventListener"))
  assert.match(board, /designs on this bench file their runs here/,
    'forty runs under one heading reads as a labelling bug without this line')
  assert.match(board, /bench\.serviceExperimentId === experiment\.experimentId/,
    'the line must name the designs that actually feed this service experiment')
  assert.match(board, /designs\.length > 1/, 'a single design must not be explained at')
})

test('a seeded placeholder never survives beside live data, and each block speaks only for its source', () => {
  const view = read('src/views/research.js')
  // The module markup seeds both hosts with a placeholder paragraph. When the
  // renderers stopped writing host.innerHTML, the seed was left standing
  // between the bench block and the service block: "No results have arrived
  // yet." above 57 rows, "Nothing is running yet." above a running cell
  // (installed 1.0.14). The first claim of a host removes it.
  const claim = view.slice(view.indexOf('function claimHost'), view.indexOf('function claimHost') + 400)
  assert.match(claim, /seed\.matches\('p\.research-observed-empty'\)/, 'the seed placeholder is no longer removed on claim')
  assert.match(claim, /host\.prepend\(block\)/)
  for (const renderer of ['function renderRunBoard', 'function renderResults()']) {
    const body = view.slice(view.indexOf(renderer), view.indexOf(renderer) + 900)
    assert.match(body, /claimHost\(host, block\)/, `${renderer} must claim its host through claimHost`)
  }
  const runboard = view.slice(view.indexOf('function renderRunBoard'), view.indexOf('function renderResults'))
  assert.match(runboard, /serviceIsBusy/, '"Nothing is running yet." must not print above a service run that is running')
  // The results module's chart carries the same picker as the gathered view.
  const results = view.slice(view.indexOf('async function renderServiceResults'), view.indexOf('const onServiceCopyClick'))
  assert.match(results, /data-service-chart-column/, 'the results-module chart lost its column picker')
  const disposeAt = results.indexOf('chart.destroy()')
  const replaceAt = results.indexOf('block.innerHTML = sections.join')
  assert.ok(disposeAt !== -1 && replaceAt !== -1 && disposeAt < replaceAt,
    'charts must be destroyed BEFORE the markup they live in is replaced')
  // The register names each finding's id, so a receipt can be found again.
  assert.match(view, /research-finding-id/, 'register rows lost the finding id')
})

test('the chart choice outlives a re-render, and the cold results block is asked again once the cache fills', () => {
  const view = read('src/views/research.js')
  // The results block re-renders every run poll; a chosen column must survive.
  assert.match(view, /const chartChoice = new Map\(\)/, 'the per-experiment chart choice is gone')
  const svcStart = view.indexOf('async function renderServiceResults')
  const svc = view.slice(svcStart, view.indexOf('/* One copy handler for the service tables', svcStart))
  assert.match(svc, /chosenColumn\(experiment\.experimentId, model, experiment\.resultSchema\)/, 'the results module ignores the remembered choice')
  assert.match(svc, /chartChoice\.set\(experiment\.experimentId, event\.target\.value\)/, 'a pick in the results module is not remembered')
  const gathered = view.slice(view.indexOf('async function renderGatheredService'), view.indexOf('async function renderGatheredService') + 3500)
  assert.match(gathered, /chartChoice\.set\(serviceId, event\.target\.value\)/, 'a pick in the gathered view is not remembered')
  // The bench results block decides "no results yet" from the runs cache; the
  // cache fill must repaint it or a cold verdict is permanent.
  const refresh = view.slice(view.indexOf('async function refreshRuns'), view.indexOf('function anyRunActive'))
  assert.match(refresh, /renderResults\(\)/, '"No results have arrived yet." stays above the tables for ever again')
  // The finding id sits inside the first grid cell, not as a third grid child.
  assert.match(view, /<span>Recorded status: \$\{esc\(findingStateWord\(item\?\.status\)\)\}\$\{item\?\.findingId \? `<br>/, 'the finding id pushed the claim into the narrow column again')
  /* Same property, new words: the worklists line sits directly above a findings
     register that IS readable, so it must name the catalog's own registers as
     the absent thing and say where the findings below come from. The sentence it
     pinned reported a read failure the shipped product never has. */
  assert.match(view, /The project findings below are read live from this computer/, 'the worklists sentence contradicts the findings beneath it again')
})


for (const accepted of [true, false]) test(`a ${accepted ? 'saved' : 'refused'} new design cannot lose a concurrent worker result`, async t => {
  resetExperimentTracking()
  const originalWindow = globalThis.window, originalCustomEvent = globalThis.CustomEvent
  globalThis.window = { localStorage: memoryStorage(), dispatchEvent() {} }
  globalThis.CustomEvent = class { constructor(type) { this.type = type } }
  t.after(() => { globalThis.window = originalWindow; globalThis.CustomEvent = originalCustomEvent; resetExperimentTracking() })
  const spec = { ...SPEC, axes: [{ id: 'tier', values: ['luna'] }], runsPerCell: 1 }
  const original = buildExperiment(spec, EMPTY)
  let row = original.serialized, receive, releaseWrite, held = false
  const persist = async value => {
    if (held) {
      held = false
      const answer = await new Promise(resolve => { releaseWrite = resolve })
      if (!answer) return { ok: false, reason: 'Synthetic refusal' }
    }
    row = value; return { ok: true }
  }
  seedExperiments(parseExperimentsRow(row), { accountId: 'writer-account', persist })
  await dispatchExperiment(original.experiment.id, { agent: { onEvent: listener => { receive = listener; return () => {} } }, persist,
    startAgent: async () => ({ ok: true, sessionId: 'concurrent-save-result' }) })
  held = true
  const saving = commitExperimentChange(current => buildExperiment({ ...spec, name: 'New design' }, current))
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(typeof releaseWrite, 'function')
  receive({ sessionId: 'concurrent-save-result', event: { type: 'assistant_text_delta', text: 'Result received while saving.' } })
  receive({ sessionId: 'concurrent-save-result', event: { type: 'turn_completed', status: 'completed' } })
  releaseWrite(accepted)
  const result = await saving
  assert.equal(result.ok, accepted)
  await new Promise(resolve => setTimeout(resolve, 0))
  const stored = parseExperimentsRow(row).experiments
  assert.equal(stored.length, accepted ? 2 : 1)
  assert.equal(stored[0].cells[0].status, 'finished')
  assert.equal(stored[0].cells[0].replyExcerpt, 'Result received while saving.')
  assert.equal(experimentsSnapshot().experiments.length, stored.length)
})

test('a read started before an accepted deletion cannot restore the old membership', async () => {
  resetExperimentTracking()
  try {
    const built = buildExperiment(SPEC, EMPTY)
    const parsed = parseExperimentsRow(built.serialized)
    seedExperiments(parsed, { accountId: 'read-order-account', persist: async () => ({ ok: true }) })
    const readCheckpoint = experimentsReadCheckpoint()
    const removed = await commitExperimentChange(current => removeExperiment(current, built.experiment.id))
    assert.equal(removed.ok, true)
    seedExperiments(parsed, { accountId: 'read-order-account', readCheckpoint })
    assert.deepEqual(experimentsSnapshot().experiments, [])
  } finally { resetExperimentTracking() }
})


test('clean-room dispatch carries research marker, exact tree identity, and persisted node scope', async () => {
  resetExperimentTracking()
  const storage = memoryStorage()
  const originalWindow = globalThis.window
  globalThis.window = { localStorage: storage, dispatchEvent: () => {}, addEventListener: () => {}, removeEventListener: () => {} }
  try {
    const setup = { mode: 'clean-room', access: 'read-only', files: [{ path: 'inside.txt', content: 'fixture' }] }
    const built = buildExperiment({ ...SPEC, axes: [{ id: 'tier', values: ['luna'] }], runsPerCell: 1, agentSetup: setup }, EMPTY)
    assert.equal(built.ok, true)
    seedExperiments({ experiments: built.next.experiments, damaged: false })
    const requests = []
    const outcome = await dispatchExperiment(built.experiment.id, {
      agent: { onEvent: () => () => {} },
      persist: () => {},
      startAgent: async request => {
        requests.push(request)
        return { ok: true, sessionId: 'clean-room-session', researchRestriction: { version: 1, mode: 'clean-room', access: 'read-only', root: 'C:/fixture-clean-room' } }
      },
    })
    assert.equal(outcome.ok, true)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].researchSetup, true)
    assert.deepEqual(requests[0].research, { ...setup, prompt: requests[0].text })
    assert.equal(requests[0].requestKeys.threadId, requests[0].treeIdentity.selfName)
    assert.deepEqual(requests[0].requestKeys.treeAnchors, [requests[0].treeIdentity.selfName])
    assert.equal(requests[0].treeIdentity.managerName, null)
    const raw = storage.getItem('mc.fleet.trees.v1:this-computer') || ''
    assert.match(raw, /"researchRestriction":\{"version":1,"mode":"clean-room","access":"read-only","root":/)
  } finally {
    globalThis.window = originalWindow
    resetExperimentTracking()
  }
})
