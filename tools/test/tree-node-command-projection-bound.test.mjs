/* THE WAIT ON `projectionReady` INSIDE runTreeNodeCommand MUST BE BOUNDED.
 *
 * Ported from 4d3cfab9 (app repo, "computers: wait for the projection a tree
 * command needs, not only the first boot") onto live 6d4b47e7, which already
 * carries its OWN independent fix for the reload-window defect that commit
 * describes: `projectionReady` / `resolveProjectionReady` / `finishProjectionLoad`
 * already exist here and `runTreeNodeCommand` already does
 * `await bootPromise; await projectionReady;` before its gates. MEASURED
 * (Worker 14, 2026-09-07, REPORT-rebase-check-4d3cfab9-on-6d4b47e7-20260907.md):
 * that existing wait has no bound at all, so a fleet read that never answers
 * parks a tree command forever rather than refusing it -- the exact
 * unbounded-timeout failure 4d3cfab9's own suite exists to rule out, just not
 * yet ruled out HERE. Only test 3 of that file is ported (the bound case);
 * tests 1 and 2 in that file pin the reload-window defect itself, which this
 * tree does not have -- see the report above for how that was confirmed
 * (the test passed unmodified against this tree's own source).
 *
 * Second test below is new: a race regression guard for THIS change
 * specifically. A bound implemented as `Promise.race([projectionReady, timer])`
 * must not change the answer for the load that actually finishes -- only for
 * the one that never does. Nothing here reads a variable name, a helper name
 * or a source line; both tests assert on the command's own answer.
 *
 *   node --test tools/test/tree-node-command-projection-bound.test.mjs
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'

register('./helpers/css-stub-loader.mjs', import.meta.url)

const FLEET_SCHEMA = JSON.parse(readFileSync(new URL('../../public/data/schema/fleet.schema.json', import.meta.url), 'utf8'))

const COMPUTER_ID = 'this-computer'
const OBSERVED_AT = '2026-09-06T04:51:00.000Z'

/* A circle id no store here has ever minted. The command is therefore always
   answerable -- "no such circle" -- once a store is open, and never answerable
   while there is none. That difference is what tells a real answer apart from
   the bound giving up. */
const ABSENT_NODE_ID = 'node-1-00000000-0000-4000-8000-000000000000'

const stopCommand = () => ({
  protocol: 'mc.tree-node-command',
  schemaVersion: 1,
  requestId: 'tnc-00000000-0000-4000-8000-000000000002',
  action: 'stop-node',
  computerId: COMPUTER_ID,
  treeId: null,
  nodeId: ABSENT_NODE_ID,
  expectedSessionId: null,
  parentSessionId: null,
})

const fleetProjection = () => ({
  schemaVersion: 1,
  domain: 'fleet',
  generatedAt: OBSERVED_AT,
  ok: true,
  reason: null,
  sources: [],
  data: {
    computers: [{
      id: COMPUTER_ID,
      label: 'This computer',
      sourceKind: 'observed',
      observedAt: OBSERVED_AT,
      activeSessions: 0,
      services: [],
    }],
    graph: {
      revision: 1,
      contentHash: '0'.repeat(64),
      nodes: [{ id: 'seat-one', label: 'Seat one', role: 'builder', provider: 'claude', enabled: true }],
      edges: [],
    },
  },
})

const jsonResponse = value => ({ ok: true, status: 200, statusText: 'OK', json: async () => value })

/* THE FLEET READ, HELD OPEN ON DEMAND. */
function fleetFetch() {
  let unblock = null
  let held = null
  const gate = {
    hold() { if (!held) held = new Promise(resolve => { unblock = resolve }) },
    release() { const go = unblock; held = null; unblock = null; go?.() },
    async fetch(url) {
      if (held) await held
      if (url === '/data/fleet.json') return jsonResponse(fleetProjection())
      if (url === '/data/schema/fleet.schema.json') return jsonResponse(FLEET_SCHEMA)
      return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) }
    },
  }
  return gate
}

const turn = () => new Promise(resolve => setTimeout(resolve, 0))
const settle = async (turns = 60) => { for (let index = 0; index < turns; index += 1) await turn() }

const saved = new Map()
function replaceGlobal(key, value) {
  if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
  Object.defineProperty(globalThis, key, { value, writable: true, enumerable: true, configurable: true })
}
function restoreGlobals() {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else delete globalThis[key]
  }
  saved.clear()
}

async function installWorld(gate) {
  const { installDomStandIn } = await import('./lib/dom-stand-in.mjs')
  const dom = installDomStandIn(globalThis)
  const stored = new Map()
  const storage = {
    get length() { return stored.size },
    key: index => [...stored.keys()][index] ?? null,
    getItem: key => (stored.has(key) ? stored.get(key) : null),
    setItem: (key, value) => { stored.set(key, String(value)) },
    removeItem: key => { stored.delete(key) },
  }
  const shell = {
    getBridgeProof: async () => ({ ok: true, proof: 'fixture' }),
    getBridgeTransport: async () => null,
  }
  replaceGlobal('localStorage', storage)
  replaceGlobal('location', { hash: `#/computers/${COMPUTER_ID}`, search: '', hostname: 'localhost' })
  replaceGlobal('CustomEvent', class { constructor(type, options = {}) { this.type = type; this.detail = options.detail } })
  replaceGlobal('fetch', gate.fetch)
  replaceGlobal('mcShell', shell)
  globalThis.window.document = globalThis.document
  globalThis.document.defaultView = globalThis.window
  globalThis.window.localStorage = storage
  globalThis.window.location = globalThis.location
  globalThis.window.innerWidth = 1280
  globalThis.window.innerHeight = 800
  globalThis.window.getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1' })
  globalThis.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  globalThis.window.mcShell = shell
  globalThis.document.querySelector = selector =>
    globalThis.document.documentElement.querySelector(selector) || globalThis.document.body.querySelector(selector)
  globalThis.document.querySelectorAll = selector => [
    ...globalThis.document.documentElement.querySelectorAll(selector),
    ...globalThis.document.body.querySelectorAll(selector),
  ]
  globalThis.document.createElementNS = (_namespace, tag) => globalThis.document.createElement(tag)
  return { dom, storage, restore() { dom.restore(); restoreGlobals() } }
}

/* AND THE WAIT ITSELF IS BOUNDED, for the read that never comes back at all.
 *
 * Ported from 4d3cfab9's third test, unchanged in intent: the clock is mocked
 * rather than waited out, so this pins a half-minute bound in about a
 * millisecond. Enabled only after the view has mounted, so nothing about the
 * mount depends on a fake clock.
 */
test('a fleet read that never answers is still bounded: the command is refused rather than held for ever (bad value: no answer at all)', { concurrency: false, timeout: 20_000 }, async (t) => {
  const gate = fleetFetch()
  gate.hold()
  const world = await installWorld(gate)
  let view = null
  try {
    const { computersView } = await import('../../src/views/computers.js')
    view = computersView({ initialComputer: COMPUTER_ID, navigate() {} })
    globalThis.document.body.appendChild(view.el)
    await settle()

    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
    const pending = view.runTreeNodeCommand(stopCommand())
    /* Microtasks only: the fake clock has not moved, so nothing timed can run
       and the command is now parked on the wait this test is about. */
    for (let index = 0; index < 20; index += 1) await Promise.resolve()
    let answered = false
    void pending.then(() => { answered = true })
    for (let index = 0; index < 20; index += 1) await Promise.resolve()
    assert.equal(answered, false,
      'bad value true: the command did not wait for the fleet read at all, so this test is not measuring the bound')

    /* Past any bound a command may reasonably hold the one drain slot for. */
    t.mock.timers.tick(120_000)
    const refused = await pending
    assert.equal(refused.code, 'MC_TREE_COMMAND_COMPUTER_NOT_FOUND',
      `a fleet read that never answered produced ${refused.code}; after its bound the wait must hand the decision back ` +
      'to the page\'s own gates, which is a refusal naming the computer the page does not have open')
  } finally {
    t.mock.timers.reset()
    view?.destroy()
    gate.release()
    world.restore()
  }
})

/* THE RACE, AND WHY THIS SUITE HAS A SECOND TEST FOR ONE CHANGE.
 *
 * A bound written as `Promise.race([projectionReady, timer])` has a cheap wrong
 * shape: forgetting to clear the timer, or resolving the race on the wrong
 * side, could make a load that actually FINISHES answer as though it had
 * timed out, or leave a stray timer callback to fire later against a command
 * that has already been answered. Real timers, no mock: the fleet read is
 * held for a few real-clock turns, well inside any bound this file's other
 * test measures in the tens of seconds, then released -- proving the winning
 * side of the race is still "the load actually finished," not "thirty
 * seconds elapsed," for the ordinary case of a slow-but-answering reload.
 */
test('a fleet read that answers before the bound still wins the race, not the timeout', { concurrency: false, timeout: 20_000 }, async () => {
  const gate = fleetFetch()
  gate.hold()
  const world = await installWorld(gate)
  let view = null
  try {
    const { computersView } = await import('../../src/views/computers.js')
    view = computersView({ initialComputer: COMPUTER_ID, navigate() {} })
    globalThis.document.body.appendChild(view.el)
    await settle()

    const pending = view.runTreeNodeCommand(stopCommand())
    await settle(20)
    let answered = false
    void pending.then(() => { answered = true })
    await settle(5)
    assert.equal(answered, false,
      'the command answered before the fleet read was ever released -- this test is not measuring the wait at all')

    gate.release()
    const settled = await pending
    assert.equal(settled.code, 'MC_TREE_COMMAND_NODE_NOT_FOUND',
      `a fleet read that DID answer produced ${settled.code} instead of the real gate one past the computer check; ` +
      'the bound must only take over when nothing ever answers, never race ahead of an answer that is already coming')
  } finally {
    view?.destroy()
    gate.release()
    world.restore()
  }
})
