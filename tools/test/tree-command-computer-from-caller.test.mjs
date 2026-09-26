import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'

/* WHICH TREE AN ASSISTANT'S OWN ERRAND IS ADDRESSED TO.
 *
 * shell/main.cjs learns the computer to address from the Computers page, which
 * announces it when it opens a tree store (src/views/computers.js
 * openTreeStore -> mcTreeCommand.announce). That announcement is the ONLY
 * source, so a run in which nobody has opened that page yet -- a session first
 * started from the Home chat or from the agent drill-in, both of which start
 * sessions without it -- left dispatchTreeSpawn with nothing to address, and
 * every agent-to-agent verb (spawn, resume, restart, stop, remove) refused
 * MC_TREE_SPAWN_TREE_NOT_OPEN with a sentence telling a human to open a page.
 * The assistant reading that sentence has no page and no hands.
 *
 * The shell can name that tree itself: every session placed on a tree node is
 * bound to its node AND its computer at start (shell/agent-command-surface.cjs
 * calls recordTranscriptBinding on every accepted start that carries a thread
 * key), and the asking circle's own binding is the tree its child belongs in.
 * These cases run the real dispatchTreeSpawn out of shell/main.cjs. */
const require = createRequire(new URL('../../shell/main.cjs', import.meta.url))
const main = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
const declarations = declaredFunctionSource(main, 'dispatchTreeSpawn')
const { CONFIGURATION_ACTIONS } = require('./tree-slot-configuration.cjs')

function fixture({ announced = null, binding = { computerId: 'this-computer', nodeId: 'parent-node' } } = {}) {
  const parent = { sessionId: 'parent', nodeId: 'parent-node', owner: 'owner-key', cwd: '/parent',
    treeId: 'tree', treeAnchors: ['tree', 'parent-node'], workspaceRoots: ['/parent'],
    permissionSession: { origin: 'local', tier: 'full' } }
  const localTreeCommands = new Map()
  const reserved = []
  let queued = null
  const injected = {
    randomUUID, require, localTreeCommands, CONFIGURATION_ACTIONS,
    agentSessions: new Map(), agentHost: { readTreeParent: () => parent },
    treeCommandComputerId: announced,
    // The one seam under test: the binding the shell already holds for the
    // asking circle. `null` is a circle with no saved tree of its own.
    transcriptCapture: { bindingFor: sessionId => (sessionId === parent.sessionId ? binding : null) },
    treeSlotAdmission: { reserve(request) {
      reserved.push(request)
      return { nodeId: '11111111-1111-4111-8111-111111111111', release() {} }
    } },
    TREE_SPAWN_DELIVERY_MS: 10000,
    setTimeout: () => 'timer', clearTimeout: () => {},
    treeOwnerKey: () => 'owner-key', readTreeParentAuthority: () => parent,
    getResearchDelegationAuthority: () => { throw new Error('no research delegation in these cases') },
    researchNodeAdmissions: new Map(),
    treeNodeCommandBroker: { state: () => ({}) },
    treeSpawnError: (code, message) => Object.assign(new Error(message), { code }),
    queueTreeNodeCommand(id) { queued = localTreeCommands.get(id); return true },
    getAgentCommandSurface: () => ({ run: async () => {} }),
  }
  const load = new Function(...Object.keys(injected), `${declarations}; return { dispatchTreeSpawn }`)
  const { dispatchTreeSpawn } = load(...Object.values(injected))
  return { dispatchTreeSpawn, reserved,
    /* Every case settles its own errand: the waiter holds the caller's promise
       and nothing else in this harness would ever answer it. */
    async send(request) {
      const promise = dispatchTreeSpawn(request)
      promise.catch(() => {})
      if (!queued) return { refusal: await promise.then(() => null, error => error), command: null }
      const command = queued.envelope.request
      queued.resolve({ ok: true })
      await promise
      queued = null
      return { refusal: null, command }
    },
  }
}

const stop = { action: 'stop-node', parentSessionId: 'parent', nodeId: 'child' }

test('a lifecycle command is addressed to the asking circle\'s own tree when no page has announced one', async () => {
  const flow = fixture()
  const { refusal, command } = await flow.send(stop)
  assert.equal(refusal, null, 'the shell knows this circle\'s computer without a page open')
  assert.equal(command.computerId, 'this-computer')
  assert.equal(command.action, 'stop-node')
  assert.equal(command.nodeId, 'child')
})

test('a resume and a spawn reach the same tree, and the spawn reserves its slot there', async () => {
  const flow = fixture()
  const resume = await flow.send({ action: 'resume-node', parentSessionId: 'parent', nodeId: 'child' })
  assert.equal(resume.command.computerId, 'this-computer')
  const spawn = await flow.send({ parentSessionId: 'parent', role: 'worker', tier: 'luna' })
  assert.equal(spawn.command.computerId, 'this-computer')
  assert.deepEqual(flow.reserved, [{ computerId: 'this-computer', parentSessionId: 'parent' }],
    'the seat is counted against the tree the child is drawn in, not a default one')
})

test('the open page still wins, so a person looking at a tree is never redirected by this fallback', async () => {
  const flow = fixture({ announced: 'on-screen', binding: { computerId: 'this-computer', nodeId: 'parent-node' } })
  const { command } = await flow.send(stop)
  assert.equal(command.computerId, 'on-screen')
})

test('a circle with no saved tree of its own is refused in words its own caller can act on', async () => {
  const flow = fixture({ binding: null })
  const { refusal } = await flow.send(stop)
  assert.equal(refusal.code, 'MC_TREE_SPAWN_TREE_NOT_OPEN')
  /* The sentence is read by the assistant that asked, not by anyone at a
     screen: it must name something that assistant can do. */
  assert.match(refusal.message, /Ask the person/)
  assert.match(refusal.message, /send this command again/)
  assert.doesNotMatch(refusal.message, /^No tree is open on screen/)
})

test('a binding that cannot name a computer identifier is not used as one', async () => {
  for (const computerId of ['', '../other', 'a computer', 'x'.repeat(300)]) {
    const flow = fixture({ binding: { computerId, nodeId: 'parent-node' } })
    const { refusal } = await flow.send(stop)
    assert.equal(refusal?.code, 'MC_TREE_SPAWN_TREE_NOT_OPEN', `refused: ${JSON.stringify(computerId)}`)
  }
})
