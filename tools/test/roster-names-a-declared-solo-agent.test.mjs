/* THE APP PERMISSIONS LIST CALLS A SOLO AGENT BY ITS NAME.
 *
 * Measured on a built candidate at 49d50038, on screen, in Settings > App
 * permissions: the row for a + agent read
 *
 *   standalone-3f9f14df-89d3-4144-8136-f23fc616367f
 *
 * instead of "Agent 1". A person deciding whether to hand something the mouse,
 * keyboard and screen was shown a UUID.
 *
 * IT IS NOT A MISSING NAME. I read the org record in the running window: the
 * seat is declared with displayName "Agent 1", exactly as ensureSeatForNode
 * sends it, and shell/agent-command-surface.cjs forwards displayName through
 * 'org:ensure-seat'. The name was there the whole time.
 *
 * The roster never asked for it. screen-access-controls resolves a row's label
 * through roleForSessionTarget(), and session-roles.js reads ONE source: the
 * fleet-trees store. A standalone agent is deliberately absent from that store
 * -- that is the whole design of mountStandaloneAgent, and the pop-up promises
 * it ("This agent won't appear on the tree") -- so the lookup can never hit,
 * and the label falls through to the agent id.
 *
 * So the fix is a second source, not a second name: the org record is the
 * authority on what a DECLARED agent is called, and this list is a list of
 * declared agents. A tree agent's name still wins where it has one, so nothing
 * about the existing rows changes.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { seedTreeNode } from './lib/tree-command-real-mount.mjs'

const dom = installDomStandIn()
const { createScreenAccessControls } = await import('../../src/screen-access-controls.js')
const settle = async (turns = 12) => { for (let i = 0; i < turns; i += 1) await new Promise(resolve => setTimeout(resolve, 0)) }

function world(t, { seats = [], targets = [], trees = null } = {}) {
  const previous = {
    mcVoice: globalThis.window.mcVoice, mcScreenControl: globalThis.window.mcScreenControl,
    mcOrg: globalThis.window.mcOrg, localStorage: globalThis.localStorage,
    windowLocalStorage: globalThis.window.localStorage,
  }
  const store = new Map()
  /* readSessionRoles walks the whole storage by index, so `length` and `key`
     are not optional decoration here -- without them it answers null and every
     row would fall to the declared name, which is the very precedence this
     suite is trying to measure. */
  globalThis.localStorage = {
    get length() { return store.size },
    key: index => [...store.keys()][index] ?? null,
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)) },
    removeItem: key => { store.delete(key) },
  }
  /* readSessionRoles defaults to window.localStorage, not globalThis's. Setting
     only the latter made the tree lookup answer null, which reads exactly like
     "the tree has no name for this agent" -- and that is the precedence this
     suite exists to measure, so it would have passed against the wrong code. */
  globalThis.window.localStorage = globalThis.localStorage
  if (trees) seedTreeNode(globalThis.localStorage, trees)
  globalThis.window.mcVoice = { targets: async () => targets }
  globalThis.window.mcScreenControl = {
    status: async () => ({ mode: 'selected', agents: targets.map(row => ({ ...row, eligible: true })), grants: [] }),
    onEvent: () => () => {},
  }
  globalThis.window.mcOrg = { read: async () => ({ org: { agents: seats } }) }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (key === 'localStorage') { if (value) globalThis.localStorage = value; else delete globalThis.localStorage }
      else if (key === 'windowLocalStorage') { if (value) globalThis.window.localStorage = value; else delete globalThis.window.localStorage }
      else if (value === undefined) delete globalThis.window[key]
      else globalThis.window[key] = value
    }
  })
}

const rowLabels = controls => (controls.el.querySelector('[data-control-agents]')?.textContent || '')

test('a declared solo agent is listed by the name it was declared with, not by its seat id', async t => {
  const SEAT = 'standalone-3f9f14df-89d3-4144-8136-f23fc616367f'
  world(t, {
    seats: [{ id: SEAT, role: 'worker', enabled: true, displayName: 'Agent 1' }],
    targets: [{ sessionId: 'chat-solo', agentId: SEAT }],
  })
  const controls = createScreenAccessControls({ sample: false })
  t.after(() => controls.destroy?.())
  await settle(20)

  const text = rowLabels(controls)
  assert.ok(text.includes('Agent 1'),
    'THE DEFECT: the row does not name the agent, so a person granting the mouse and keyboard is shown a UUID')
  assert.equal(text.includes(SEAT), false,
    'the seat id is still on screen beside the name, which is the thing being replaced')
})

test('a session with no declared seat is still not given an invented name', async t => {
  world(t, {
    seats: [{ id: 'standalone-declared', role: 'worker', enabled: true, displayName: 'Agent 1' }],
    targets: [{ sessionId: 'chat-unknown', agentId: 'standalone-never-declared' }],
  })
  const controls = createScreenAccessControls({ sample: false })
  t.after(() => controls.destroy?.())
  await settle(20)

  const text = rowLabels(controls)
  assert.ok(text.includes('standalone-never-declared'),
    'a row with nothing to call it must still say which session it is, not go blank')
  assert.equal(text.includes('Agent 1'), false,
    'the name of a DIFFERENT declared agent was put on this row, which would hand control to the wrong one')
})

test('a seat that is not enabled does not lend its name to a running session', async t => {
  const SEAT = 'standalone-retired'
  world(t, {
    seats: [{ id: SEAT, role: 'worker', enabled: false, displayName: 'Retired agent' }],
    targets: [{ sessionId: 'chat-retired', agentId: SEAT }],
  })
  const controls = createScreenAccessControls({ sample: false })
  t.after(() => controls.destroy?.())
  await settle(20)

  /* An agent whose seat is not enabled cannot be granted control at all --
     screen-control-host refuses SCREEN_ROLE_UNAVAILABLE -- so naming it here
     would dress a row that cannot act as one that can. */
  assert.equal(rowLabels(controls).includes('Retired agent'), false,
    'a disabled seat lent its name to a row, making an unusable grant look ordinary')
})

test('a tree agent keeps the name the tree gave it, and the declared seat does not override it', async t => {
  /* THE PRECEDENCE IS A CLAIM, so it is measured. A tree node's composed name
     is what every other surface calls it, and the org record's displayName for
     the same agent is a second opinion. If the seat won here, renaming a
     circle on the tree would leave this list calling it something else -- and
     the person granting mouse and keyboard would be reading the stale one. */
  const AGENT = 'tree-node-with-a-seat'
  world(t, {
    seats: [{ id: AGENT, role: 'worker', enabled: true, displayName: 'The seat name' }],
    targets: [{ sessionId: 'chat-both', agentId: AGENT }],
    trees: { nodeId: AGENT, sessionId: 'chat-both', status: 'running' },
  })
  const controls = createScreenAccessControls({ sample: false })
  t.after(() => controls.destroy?.())
  await settle(20)

  const text = rowLabels(controls)
  assert.equal(text.includes('The seat name'), false,
    'the declared seat overrode the name the tree gave this agent')
  assert.equal(text.includes(AGENT), false,
    'the row fell all the way back to the id, so neither name reached it and this case measures nothing')
})
