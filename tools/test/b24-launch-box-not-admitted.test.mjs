/* B24 (found by hand on 1.0.48 candidate 1): after a pre-admission refusal the
 * tree agent's Launch box stayed disabled with no reason until a restart.
 *
 * The refusal (MC_TREE_BOUNDED_WORK_REFUSED, thrown before anything was
 * reserved) crossed IPC as a bare code. withRetainedStartIdentity therefore kept
 * the request id as a session still to clean up, the controller recorded an
 * "unconfirmed" row and stayed stoppable, and Stop could not clear a session
 * the host never had. agent:start now answers that refusal with a released
 * "not admitted" start outcome (agent-command-surface.test.mjs, B24). This runs
 * the box's own path -- controller.run -> startAgentForNode -> window.mcAgent.start --
 * with both answers.
 *
 *   node --test tools/test/b24-launch-box-not-admitted.test.mjs
 */
import assert from 'node:assert/strict'
import { register } from 'node:module'
import test, { beforeEach } from 'node:test'
import { useStartConsent } from './lib/start-consent-fixture.mjs'
beforeEach(t => { useStartConsent(t) })
register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.css')) return { url: new URL(specifier, context.parentURL).href, shortCircuit: true }
    return nextResolve(specifier, context)
  }
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`), import.meta.url)
const { startAgentForNode } = await import('../../src/views/computers.js')
const { createTreeWorkController } = await import('../../src/tree-bounded-work.js')

function useBridge(t, bridge) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window')
  t.after(() => { if (original) Object.defineProperty(globalThis, 'window', original); else delete globalThis.window })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { mcAgent: bridge } })
}
const boundedWork = { computerId: 'this-computer', treeId: 'tree-1', parentNodeId: 'controller', parentSessionId: 'controller-new', capMs: 1_200_000 }
/* startDraftNode returns the refusal spread with ok:false and its sentence;
   startBoundedChild keeps the sessionId it was given. */
async function launchOnce(t, start) {
  useBridge(t, { start, async send() { return { ok: true } } })
  const controller = createTreeWorkController({ kind: 'launch',
    start: async () => {
      const result = await startAgentForNode({ text: 'Reply with exactly this one word: LAUNCHOK', surface: 'fleet-tree',
        tier: 'claude-sonnet-5', boundedWork, onCleanupRequired() {} })
      return { ...result, ok: false, message: result.sentence, nodeId: 'worker-2', sessionId: result.sessionId || null }
    },
    readStatus: async () => ({ ok: false, code: 'MC_AGENT_UNKNOWN_SESSION' }),
    close: async () => { throw new Error('MC_AGENT_UNKNOWN_SESSION') },
  })
  await controller.run({ ...boundedWork, tier: 'claude-sonnet-5', effort: null, brief: 'LAUNCHOK', members: [] })
  return controller
}

test('B24: a refusal thrown across IPC as a bare code still leaves the box waiting on a session the host never had', async t => {
  const controller = await launchOnce(t, async () => { throw new Error('MC_TREE_BOUNDED_WORK_REFUSED') })
  assert.equal(controller.getState().phase, 'refused')
  assert.equal(controller.getState().stoppable, true, 'why agent:start no longer throws this refusal')
  assert.equal(controller.getState().rows[0]?.phase, 'unconfirmed')
})

test('B24: the released "not admitted" answer leaves the box refused but usable, with the reason shown', async t => {
  const controller = await launchOnce(t, async request => ({ ok: false, sessionId: request.sessionId, code: 'MC_TREE_BOUNDED_WORK_REFUSED',
    reason: 'MC_TREE_BOUNDED_WORK_REFUSED',
    startOutcome: { requestSessionId: request.sessionId, admission: 'not-admitted', cleanup: 'not-required', custody: 'none' } }))
  const state = controller.getState()
  assert.equal(state.phase, 'refused')
  assert.equal(state.stoppable, false, 'Hand work can be pressed again')
  assert.deepEqual(state.rows, [])
  assert.match(state.message, /changed before this work could start/)
})
