/* SHARED REAL-SOURCE MOUNT for computersView + runTreeNodeCommand.
 *
 * Extracted and generalized from tools/test/tree-node-command-projection-
 * bound.test.mjs, which itself extracted its own harness from app 4d3cfab9's
 * suite. Every suite that used to slice src/views/computers.js's source text
 * to assert a structural invariant about runTreeNodeCommand can import this
 * instead and drive the SAME guarantee through a real mount: a DOM stand-in,
 * one computer, one real tree store seeded through the same localStorage key
 * createFleetTreeStore itself reads/writes (mc.fleet.trees.v1:<computerId>),
 * and a runTreeNodeCommand entry point that is the view's own, not a copy.
 *
 * The extraction-sandbox suite, tools/test/tree-command-projection-ready.
 * test.mjs, is untouched by this file and by anything that imports it: that
 * suite reconstructs runTreeNodeCommand's source text into an isolated
 * sandbox with its own local declarations, a different technique entirely,
 * and nothing here changes what it does.
 */
import { readFileSync } from 'node:fs'
import { fleetTreesStorageKey } from '../../../src/fleet-trees.js'

const FLEET_SCHEMA = JSON.parse(readFileSync(new URL('../../../public/data/schema/fleet.schema.json', import.meta.url), 'utf8'))

export const COMPUTER_ID = 'this-computer'
const OBSERVED_AT = '2026-09-06T04:51:00.000Z'

function fleetProjection(computerId = COMPUTER_ID) {
  return {
    schemaVersion: 1,
    domain: 'fleet',
    generatedAt: OBSERVED_AT,
    ok: true,
    reason: null,
    sources: [],
    data: {
      computers: [{
        id: computerId, label: 'This computer', sourceKind: 'observed', observedAt: OBSERVED_AT,
        activeSessions: 0, services: [],
      }],
      /* At least one item, or /data/fleet.json fails its own schema
         validation ($.data.graph.nodes: too few items) and the page never
         opens a store at all -- MEASURED while building this helper. The
         node a case actually drives is seeded separately, through
         seedTreeNode's own localStorage record; this placeholder is here
         only to satisfy the schema. */
      graph: { revision: 1, contentHash: '0'.repeat(64), nodes: [{ id: 'seat-one', label: 'Seat one', role: 'builder', provider: 'claude', enabled: true }], edges: [] },
    },
  }
}

const jsonResponse = value => ({ ok: true, status: 200, statusText: 'OK', json: async () => value })

/* THE FLEET READ, HELD OPEN ON DEMAND -- unused by most callers of this
   helper (a computer resolves instantly), kept for parity with the
   projection-bound suite in case a future case needs it. */
export function fleetFetch({ computerId = COMPUTER_ID } = {}) {
  let unblock = null
  let held = null
  return {
    hold() { if (!held) held = new Promise(resolve => { unblock = resolve }) },
    release() { const go = unblock; held = null; unblock = null; go?.() },
    async fetch(url) {
      if (held) await held
      if (url === '/data/fleet.json') return jsonResponse(fleetProjection(computerId))
      if (url === '/data/schema/fleet.schema.json') return jsonResponse(FLEET_SCHEMA)
      return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) }
    },
  }
}

const turn = () => new Promise(resolve => setTimeout(resolve, 0))
export const settle = async (turns = 60) => { for (let index = 0; index < turns; index += 1) await turn() }

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

/* The page's world: a DOM stand-in, this computer's storage, a desktop shell,
 * and a controllable agent bridge (window.mcAgent -- stop-node's close and
 * fresh-start's start both read it, real bridge calls the tests below can
 * hold open on demand). Returns { storage, bridge, restore() }. */
export async function installWorld(gate, { asyncFrames = false } = {}) {
  const { installDomStandIn } = await import('./dom-stand-in.mjs')
  const dom = installDomStandIn(globalThis)
  const frames = new Map()
  let nextFrame = 0
  if (asyncFrames) {
    // Browser RAF callbacks run after the caller stores their returned ID.
    // Layout/branch-transition proofs need that ordering; a synchronous
    // callback can recursively reconcile an unfinished multi-node mount.
    globalThis.requestAnimationFrame = callback => {
      const id = ++nextFrame
      frames.set(id, setTimeout(() => { frames.delete(id); callback(performance.now()) }, 0))
      return id
    }
    globalThis.cancelAnimationFrame = id => { clearTimeout(frames.get(id)); frames.delete(id) }
  }
  const stored = new Map()
  const storage = {
    get length() { return stored.size },
    key: index => [...stored.keys()][index] ?? null,
    getItem: key => (stored.has(key) ? stored.get(key) : null),
    setItem: (key, value) => { stored.set(key, String(value)) },
    removeItem: key => { stored.delete(key) },
  }
  const bridge = {
    close: async () => ({ ok: true, closed: true }),
    start: async () => ({ ok: false }),
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
  globalThis.window.mcAgent = bridge
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
  return { dom, storage, bridge, restore() {
    for (const timer of frames.values()) clearTimeout(timer)
    frames.clear()
    dom.restore(); restoreGlobals()
  } }
}

/* SEED ONE REAL NODE, through the exact key createFleetTreeStore itself reads
 * (fleetTreesStorageKey) -- not the fleet fetch, which only supplies the
 * COMPUTER, never a node. Without this every command answers
 * MC_TREE_COMMAND_NODE_NOT_FOUND regardless of nodeId, because openTreeStore
 * opens a real but empty store. Must be called BEFORE mountView(), since the
 * store opens once during the view's own boot. `status: 'running'` is
 * accepted here but ingested as 'starting' -- see fleet-trees.js's own
 * "NOTHING COMES BACK OFF DISK RUNNING" -- sessionId survives either way,
 * which is all a stop or a caller-gate check needs. */
export function seedTreeNode(storage, { nodeId, treeId = 'tree-1', sessionId = null, status = 'starting', parentId = null, computerId = COMPUTER_ID } = {}) {
  const stamp = OBSERVED_AT
  storage.setItem(fleetTreesStorageKey(computerId), JSON.stringify({
    version: 1,
    computerId,
    trees: [{ id: treeId, name: null, createdAt: stamp, updatedAt: stamp, profileId: null }],
    nodes: [{
      id: nodeId, treeId, status, createdAt: stamp, updatedAt: stamp,
      role: 'builder', message: '', statusNote: '', sessionId, parentId,
    }],
  }))
}

/** Mount the real view over an already-installed world (seed first). */
export async function mountView(world, { computerId = COMPUTER_ID } = {}) {
  const { computersView } = await import('../../../src/views/computers.js')
  const view = computersView({ initialComputer: computerId, navigate() {} })
  globalThis.document.body.appendChild(view.el)
  await settle()
  return view
}
