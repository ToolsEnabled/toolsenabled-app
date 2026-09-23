import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { readFileSync } from 'node:fs'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { commonCommandIcon } from '../../src/common-command-icons.js'
import { goalTitleFromObjective, goalRefusalSentence } from '../../src/slash-commands.js'
import { refusalCode } from '../../src/agent-availability-copy.js'

/* R1238 / REPORT-B5-SUB2-loop-goal.md's own finding: /goal works end to end
   but nothing on screen answers "is a goal running right now" without
   scrolling the transcript. This drives the REAL goalControlsBox declaration
   out of views/computers.js -- the same lift bounded-work-manual-stop.test.mjs
   uses for nativeBoundedWorkBox -- together with the REAL
   registerNodeStatusListener/notifyNodeStatusListeners pair it subscribes
   through, so a passing test proves the box is wired to the actual rail
   status bus rather than a private one this file invented. */

const world = installDomStandIn()
after(() => world.restore())
const { el } = await import('../../src/components.js')
const source = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
const names = ['goalControlsBox', 'registerNodeStatusListener', 'notifyNodeStatusListeners',
  'refreshSlotUsage', 'clearBoard']
/* disposeBoardGoalBox is the rail's release for the PREVIOUS render's box.
   Stubbed when it is absent so the leak test below fails on the leak it is
   about rather than on a missing symbol. */
const optionalDeclaration = name => source.includes(`function ${name}(`)
  ? declaredFunctionSource(source, name)
  : `function ${name}() { /* the release the leak test is about does not exist yet */ }`
const declarations = [...names.map(name => declaredFunctionSource(source, name)),
  optionalDeclaration('disposeBoardGoalBox')].join('\n')
/* The PRODUCT's terminal-session set, read out of the view rather than
   restated here: a second copy in this file could agree with a box that has
   drifted away from what shell/ actually refuses with. */
const terminalSessionCodes = new Function(
  `return ${/const TERMINAL_AGENT_SESSION_CODES = (new Set\(\[[^\]]*\]\))/.exec(source)[1]}`)()
const flush = async () => { for (let count = 0; count < 20; count++) await Promise.resolve() }

const NO_GOAL_SENTENCE = 'No goal is set on this agent. Type /goal followed by what you want done, and it will work toward it on its own.'
const sentenceFor = goal => goal
  ? `Working toward this goal on its own: ${goal.objective}. It has started ${goal.continuations} turns by itself. Press Stop to pause it, or type /goal clear.`
  : NO_GOAL_SENTENCE

/* A stateful stand-in for shell/agent-host.cjs's readGoal/setGoal/clearGoal,
   shaped exactly like the real IPC round trip runGoalFor already drives:
   { sessionId, operation, objective? } in, { goal, sentence } out. It is not
   asserted against the real sentence WORDING -- shell/ is CJS and this test
   runs in ESM and cannot import it -- only against the box passing the
   sentence through UNCHANGED, which is the property runGoalFor's own
   comment states as the reason a renderer must never compose this text. */
function makeGoalBridge(initialGoal = null) {
  let goal = initialGoal
  return {
    calls: [],
    async goal({ sessionId, operation, objective }) {
      this.calls.push({ sessionId, operation, objective })
      if (operation === 'set') goal = { objective, status: 'active', continuations: 0 }
      else if (operation === 'clear') goal = null
      return Object.freeze({ sessionId, goal, sentence: sentenceFor(goal) })
    },
  }
}

function buildScope({ bridge = null, nodes = new Map(), nodeStatusListeners = new Map() } = {}) {
  const treeStore = { getNode: id => nodes.get(id) }
  const scope = {
    el, commonCommandIcon, goalTitleFromObjective, goalRefusalSentence, refusalCode,
    TERMINAL_AGENT_SESSION_CODES: terminalSessionCodes,
    treeStore, unsubs: [], nodeStatusListeners, controlsPage: null,
    boardGoalUnsub: null, boardGoalReleaseHeld: false, boardCloudBox: null, railChatUnsub: null,
    window: { mcAgent: bridge },
    START_NEEDS_APP_TEXT: () => 'unavailable -- an app window is needed to reach the goal.',
  }
  const api = new Function(...Object.keys(scope), `${declarations}; return { box: goalControlsBox, register: registerNodeStatusListener, notify: notifyNodeStatusListeners }`)(...Object.values(scope))
  return { ...scope, ...api }
}

test('no goal: the box says so plainly and Clear stays disabled', async () => {
  const bridge = makeGoalBridge(null)
  const nodes = new Map([['node-1', { id: 'node-1', sessionId: 'session-1' }]])
  const { box } = buildScope({ bridge, nodes })
  const el1 = box({ id: 'node-1' })
  document.body.appendChild(el1)
  await flush()
  assert.equal(el1.querySelector('[data-goal="objective"]').textContent, 'No goal set.')
  assert.equal(el1.querySelector('[data-goal="out"]').textContent, NO_GOAL_SENTENCE)
  assert.equal(el1.querySelector('[data-goal="clear"]').disabled, true)
})

test('a goal set elsewhere is reflected once the shared status bus fires, not on a private timer', async () => {
  const bridge = makeGoalBridge(null)
  const nodes = new Map([['node-1', { id: 'node-1', sessionId: 'session-1' }]])
  const { box, register, notify } = buildScope({ bridge, nodes })
  const el1 = box({ id: 'node-1' })
  document.body.appendChild(el1)
  await flush()
  assert.equal(el1.querySelector('[data-goal="clear"]').disabled, true, 'starts with no goal')

  // Exactly what runGoalFor()/the /goal command now does: set through the
  // bridge, then notify the same bus this box subscribed through.
  await bridge.goal({ sessionId: 'session-1', operation: 'set', objective: 'Ship the release notes' })
  let otherHeard = 0
  const unsubscribeOther = register('node-1', () => { otherHeard += 1 })
  notify()
  await flush()

  assert.equal(el1.querySelector('[data-goal="objective"]').textContent, 'Ship the release notes')
  assert.equal(el1.querySelector('[data-goal="out"]').textContent, sentenceFor({ objective: 'Ship the release notes', continuations: 0 }))
  assert.equal(el1.querySelector('[data-goal="clear"]').disabled, false)
  assert.equal(otherHeard, 1, 'a second, independent subscriber on the same node id must also have been notified -- proving one shared bus, not a private refresh')
  unsubscribeOther()
})

test('a long objective is bounded on the glance line and left whole in the sentence', async () => {
  const objective = 'x'.repeat(150)
  const bridge = makeGoalBridge({ objective, status: 'active', continuations: 3 })
  const nodes = new Map([['node-1', { id: 'node-1', sessionId: 'session-1' }]])
  const { box } = buildScope({ bridge, nodes })
  const el1 = box({ id: 'node-1' })
  document.body.appendChild(el1)
  await flush()
  const glance = el1.querySelector('[data-goal="objective"]').textContent
  assert.ok(glance.length < objective.length, 'the glance line must be bounded, like every other rail line')
  assert.equal(glance, goalTitleFromObjective(objective))
  assert.ok(el1.querySelector('[data-goal="out"]').textContent.includes(objective), 'the full sentence -- the one runGoalFor itself would show -- keeps the whole objective')
})

test('Clear sends the same clear operation runGoalFor sends, and repaints through the shared bus', async () => {
  const bridge = makeGoalBridge({ objective: 'Ship the release notes', status: 'active', continuations: 1 })
  const nodes = new Map([['node-1', { id: 'node-1', sessionId: 'session-1' }]])
  const { box, register } = buildScope({ bridge, nodes })
  const el1 = box({ id: 'node-1' })
  document.body.appendChild(el1)
  await flush()
  assert.equal(el1.querySelector('[data-goal="clear"]').disabled, false)

  let otherHeard = 0
  const unsubscribeOther = register('node-1', () => { otherHeard += 1 })
  el1.querySelector('[data-goal="clear"]').click()
  await flush()

  // notify() (below) reaches this box's OWN subscription too, so a 'get'
  // legitimately follows the 'clear' -- assert the clear was sent, not that
  // it was the last call.
  assert.ok(bridge.calls.some(call => call.sessionId === 'session-1' && call.operation === 'clear'))
  assert.equal(el1.querySelector('[data-goal="objective"]').textContent, 'No goal set.')
  assert.equal(el1.querySelector('[data-goal="out"]').textContent, NO_GOAL_SENTENCE)
  assert.equal(el1.querySelector('[data-goal="clear"]').disabled, true)
  assert.equal(otherHeard, 1, 'Clear must notify the same shared bus a set does')
  unsubscribeOther()
})

test('no live session: refused honestly, never a thrown error or a fabricated goal', async () => {
  const bridge = makeGoalBridge(null)
  const nodes = new Map([['node-1', { id: 'node-1' }]]) // no sessionId: never started, or ended
  const { box } = buildScope({ bridge, nodes })
  const el1 = box({ id: 'node-1' })
  document.body.appendChild(el1)
  await flush()
  assert.equal(el1.querySelector('[data-goal="out"]').textContent, goalRefusalSentence('noSession'))
  assert.equal(el1.querySelector('[data-goal="clear"]').disabled, true)
  assert.equal(bridge.calls.length, 0, 'a session that does not exist must never be asked for its goal')
})

test('no bridge at all (no app window): refused honestly rather than throwing', async () => {
  const nodes = new Map([['node-1', { id: 'node-1', sessionId: 'session-1' }]])
  const { box } = buildScope({ bridge: null, nodes })
  const el1 = box({ id: 'node-1' })
  document.body.appendChild(el1)
  await flush()
  assert.equal(el1.querySelector('[data-goal="out"]').textContent, 'unavailable -- an app window is needed to reach the goal.')
  assert.equal(el1.querySelector('[data-goal="clear"]').disabled, true)
})


function deferredGoal() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const goalResult = (sessionId, objective) => {
  const goal = objective ? { objective, status: 'active', continuations: 0 } : null
  return { sessionId, goal, sentence: sentenceFor(goal) }
}

for (const replaced of [false, true]) test(`a delayed goal read cannot overwrite a newer ${replaced ? 'session' : 'goal'} observation`, async () => {
  const pending = []
  const bridge = { goal: request => {
    const held = deferredGoal()
    pending.push({ ...held, ...request })
    return held.promise
  } }
  const nodes = new Map([['node-1', { id: 'node-1', sessionId: 'session-1' }]])
  const { box, notify } = buildScope({ bridge, nodes })
  const panel = box({ id: 'node-1' })
  document.body.appendChild(panel)
  if (replaced) nodes.set('node-1', { id: 'node-1', sessionId: 'session-2' })
  notify()
  assert.equal(pending.length, 2)
  pending[1].resolve(goalResult(replaced ? 'session-2' : 'session-1', 'Current objective'))
  await flush()
  assert.equal(panel.querySelector('[data-goal="objective"]').textContent, 'Current objective')
  pending[0].resolve(goalResult('session-1', 'Obsolete objective'))
  await flush()
  assert.equal(panel.querySelector('[data-goal="objective"]').textContent, 'Current objective')
  assert.equal(panel.querySelector('[data-goal="out"]').textContent, sentenceFor({ objective: 'Current objective', continuations: 0 }))
})

test('an unconfirmed Clear retains the last confirmed goal and an available retry', async () => {
  let reads = 0
  const bridge = { async goal({ sessionId, operation }) {
    if (operation === 'get' && ++reads === 1) return goalResult(sessionId, 'Keep this objective')
    throw new Error('temporary bridge failure')
  } }
  const nodes = new Map([['node-1', { id: 'node-1', sessionId: 'session-1' }]])
  const { box } = buildScope({ bridge, nodes })
  const panel = box({ id: 'node-1' })
  document.body.appendChild(panel)
  await flush()
  panel.querySelector('[data-goal="clear"]').click()
  await flush()
  assert.equal(panel.querySelector('[data-goal="objective"]').textContent, 'Keep this objective')
  assert.equal(panel.querySelector('[data-goal="clear"]').disabled, false)
  assert.match(panel.querySelector('[data-goal="out"]').textContent, /could not confirm.*clear/i)
})

test('status refresh during Clear cannot enable or dispatch a second Clear', async () => {
  const clearing = deferredGoal()
  let clearCalls = 0
  const bridge = { async goal({ sessionId, operation }) {
    if (operation === 'clear') { clearCalls++; return clearing.promise }
    return goalResult(sessionId, 'Active objective')
  } }
  const nodes = new Map([['node-1', { id: 'node-1', sessionId: 'session-1' }]])
  const { box, notify } = buildScope({ bridge, nodes })
  const panel = box({ id: 'node-1' })
  document.body.appendChild(panel)
  await flush()
  const clear = panel.querySelector('[data-goal="clear"]')
  clear.click()
  notify()
  await flush()
  assert.equal(clear.disabled, true)
  clear.click()
  assert.equal(clearCalls, 1)
  clearing.resolve(goalResult('session-1', null))
  await flush()
})

test('a successful Clear cannot be undone on screen by an earlier read', async () => {
  const stale = deferredGoal()
  let reads = 0, cleared = false
  const bridge = { async goal({ sessionId, operation }) {
    if (operation === 'clear') { cleared = true; return goalResult(sessionId, null) }
    if (++reads === 2) return stale.promise
    return goalResult(sessionId, cleared ? null : 'Old objective')
  } }
  const nodes = new Map([['node-1', { id: 'node-1', sessionId: 'session-1' }]])
  const { box, notify } = buildScope({ bridge, nodes })
  const panel = box({ id: 'node-1' })
  document.body.appendChild(panel)
  await flush()
  notify()
  panel.querySelector('[data-goal="clear"]').click()
  await flush()
  assert.equal(panel.querySelector('[data-goal="objective"]').textContent, 'No goal set.')
  stale.resolve(goalResult('session-1', 'Old objective'))
  await flush()
  assert.equal(panel.querySelector('[data-goal="objective"]').textContent, 'No goal set.')
  assert.equal(panel.querySelector('[data-goal="clear"]').disabled, true)
})

test('a goal receipt for another session is never displayed as current', async () => {
  const bridge = { async goal() { return goalResult('other-session', 'Unrelated objective') } }
  const nodes = new Map([['node-1', { id: 'node-1', sessionId: 'session-1' }]])
  const { box } = buildScope({ bridge, nodes })
  const panel = box({ id: 'node-1' })
  document.body.appendChild(panel)
  await flush()
  assert.notEqual(panel.querySelector('[data-goal="objective"]').textContent, 'Unrelated objective')
  assert.equal(panel.querySelector('[data-goal="clear"]').disabled, true)
  assert.match(panel.querySelector('[data-goal="out"]').textContent, /could not confirm/i)
})

/* LIVE 2026-09-21: one rail box left on a node whose saved session the host no
   longer held asked `goal get` on every tick of the shared status bus -- 76,380
   refusals, each an Electron "Error occurred in handler" stack in the app log
   (87 MB in one session). The host's answer cannot change until the node does. */
function makeRefusingBridge(known = new Set()) {
  return {
    calls: [],
    async goal({ sessionId, operation }) {
      this.calls.push({ sessionId, operation })
      if (!known.has(sessionId)) throw new Error("Error invoking remote method 'mc-agent:goal': Error: MC_AGENT_UNKNOWN_SESSION")
      return Object.freeze({ sessionId, goal: null, sentence: NO_GOAL_SENTENCE })
    },
  }
}

test('a session the host does not hold is asked about once, not on every tick of the status bus', async () => {
  const bridge = makeRefusingBridge()
  const nodes = new Map([['node-1', { id: 'node-1', sessionId: 'session-gone', status: 'ended' }]])
  const { box, notify } = buildScope({ bridge, nodes })
  const el1 = box({ id: 'node-1' })
  document.body.appendChild(el1)
  await flush()
  assert.equal(bridge.calls.length, 1)
  assert.equal(el1.querySelector('[data-goal="out"]').textContent, goalRefusalSentence('noSession'))
  for (let tick = 0; tick < 50; tick++) { notify(); await flush() }
  assert.equal(bridge.calls.length, 1, 'fifty status ticks with the same node state must not send fifty refused reads')
  assert.equal(el1.querySelector('[data-goal="out"]').textContent, goalRefusalSentence('noSession'), 'the refusal stays on screen')
})

test('the refused read is retried as soon as the node changes: a new status, then a new session', async () => {
  const known = new Set()
  const bridge = makeRefusingBridge(known)
  const nodes = new Map([['node-1', { id: 'node-1', sessionId: 'session-gone', status: 'ended' }]])
  const { box, notify } = buildScope({ bridge, nodes })
  const el1 = box({ id: 'node-1' })
  document.body.appendChild(el1)
  await flush()
  assert.equal(bridge.calls.length, 1)

  // The same session id comes back to life (a resume keeps the id): status moves, so the box asks again.
  known.add('session-gone')
  nodes.set('node-1', { id: 'node-1', sessionId: 'session-gone', status: 'working' })
  notify(); await flush()
  assert.equal(bridge.calls.length, 2)
  assert.equal(el1.querySelector('[data-goal="out"]').textContent, NO_GOAL_SENTENCE)

  // A healthy session keeps following the bus exactly as before.
  notify(); await flush()
  assert.equal(bridge.calls.length, 3)

  // A replacement session the host does not hold is again asked about once.
  nodes.set('node-1', { id: 'node-1', sessionId: 'session-new', status: 'working' })
  notify(); await flush()
  notify(); await flush()
  assert.equal(bridge.calls.length, 4)
  assert.equal(el1.querySelector('[data-goal="out"]').textContent, goalRefusalSentence('noSession'))
})

/* THE HOST HAS TWO WAYS TO SAY "THIS SESSION IS OVER", AND THE BOX KNEW ONE.
 *
 * shell/agent-command-surface.cjs runs ownedAgentSession() before it reads the
 * goal operation, and that function raises MC_AGENT_UNKNOWN_SESSION for an id
 * it never held and ENDED_SESSION_REFUSAL -- 'MC_AGENT_SESSION_ENDED' -- for
 * one it still RETAINS so Stop keeps working. The box compared against the
 * relay's 'AGENT_SESSION_ENDED' instead, so the retained-and-ended session was
 * painted as "could not confirm", was never memoised, and was re-asked on
 * every tick of the shared status bus: the storm the unknown-session case was
 * just stopped from making, through the other door. */
function makeCodeBridge(code) {
  return {
    calls: [],
    async goal({ sessionId, operation }) {
      this.calls.push({ sessionId, operation })
      throw new Error(`Error invoking remote method 'mc-agent:goal': Error: ${code}`)
    },
  }
}

test('a session the host still holds but has ended is stated as not running, not as unconfirmed', async () => {
  assert.ok(terminalSessionCodes.has('MC_AGENT_SESSION_ENDED'),
    "the view's own terminal set must contain the host's ended-session refusal")
  const bridge = makeCodeBridge('MC_AGENT_SESSION_ENDED')
  const nodes = new Map([['node-1', { id: 'node-1', sessionId: 'session-ended', status: 'interrupted' }]])
  const { box } = buildScope({ bridge, nodes })
  const panel = box({ id: 'node-1' })
  document.body.appendChild(panel)
  await flush()
  assert.equal(bridge.calls.length, 1)
  assert.equal(panel.querySelector('[data-goal="out"]').textContent, goalRefusalSentence('noSession'))
  assert.equal(panel.querySelector('[data-goal="objective"]').textContent, 'Goal status unavailable.')
  assert.equal(panel.querySelector('[data-goal="clear"]').disabled, true)
})

test('an ended session is asked about once, and a transient refusal is still retried on every tick', async () => {
  const ended = makeCodeBridge('MC_AGENT_SESSION_ENDED')
  const nodes = new Map([['node-1', { id: 'node-1', sessionId: 'session-ended', status: 'interrupted' }]])
  const endedBox = buildScope({ bridge: ended, nodes })
  const panel = endedBox.box({ id: 'node-1' })
  document.body.appendChild(panel)
  await flush()
  for (let tick = 0; tick < 10; tick++) { endedBox.notify(); await flush() }
  assert.equal(ended.calls.length, 1, 'ten status ticks on an ended session must not send ten refused reads')
  assert.equal(panel.querySelector('[data-goal="out"]').textContent, goalRefusalSentence('noSession'))

  /* THE MEMO MUST NOT WIDEN PAST THE TERMINAL CODES. A session that is merely
     not ready yet gets a different answer the moment it is, so that refusal is
     retried exactly as before -- proving this fix silenced one storm and did
     not silence the box. */
  const transient = makeCodeBridge('AGENT_SESSION_NOT_READY')
  const readyNodes = new Map([['node-2', { id: 'node-2', sessionId: 'session-starting', status: 'starting' }]])
  const transientBox = buildScope({ bridge: transient, nodes: readyNodes })
  const second = transientBox.box({ id: 'node-2' })
  document.body.appendChild(second)
  await flush()
  for (let tick = 0; tick < 10; tick++) { transientBox.notify(); await flush() }
  assert.equal(transient.calls.length, 11, 'a transient refusal must keep being retried')
  assert.match(second.querySelector('[data-goal="out"]').textContent, /could not confirm/i)
})

/* EVERY RAIL RENDER USED TO LEAVE ITS GOAL BOX ON THE SHARED BUS.
 *
 * notifyNodeStatusListeners() is GLOBAL -- it calls every listener of every
 * node, and refreshTree() calls it on every path. Each box handed its own
 * unsubscribe to `unsubs`, which is flushed only when the whole view is
 * destroyed, so each node click built another live box on top of the last: N
 * clicks, N subscribers, N goal reads over IPC per tick for the rest of the
 * session.
 *
 * The release belongs to the NEXT box, with ONE entry in `unsubs` closing the
 * last one when the view does. It deliberately does NOT belong to clearBoard():
 * clearBoard() also runs on its own 200 ms after the rail returns to the
 * overview, and three routes re-show that same board without rebuilding it
 * (showStats()'s chat branch, focusDetailsControl, openLoopFor, all ending in
 * `else activateRail(controlsPage)`). The second test below is that half. */
function buildRail({ bridge, nodes }) {
  const nodeStatusListeners = new Map()
  const scope = {
    el, commonCommandIcon, goalTitleFromObjective, goalRefusalSentence, refusalCode,
    TERMINAL_AGENT_SESSION_CODES: terminalSessionCodes,
    treeStore: { getNode: id => nodes.get(id) }, unsubs: [], nodeStatusListeners,
    controlsPage: null, boardGoalUnsub: null, boardGoalReleaseHeld: false,
    boardCloudBox: null, railChatUnsub: null,
    window: { mcAgent: bridge },
    START_NEEDS_APP_TEXT: () => 'unavailable -- an app window is needed to reach the goal.',
  }
  const api = new Function(...Object.keys(scope), `${declarations}; return {
    box: goalControlsBox, notify: notifyNodeStatusListeners, clearBoard }`)(...Object.values(scope))
  const live = () => [...nodeStatusListeners.values()].reduce((count, held) => count + held.size, 0)
  // What destroy() does with everything this view collected, and nothing else.
  const closeView = () => scope.unsubs.forEach(unsubscribe => unsubscribe())
  return { ...api, live, closeView, unsubs: scope.unsubs }
}

test('five rail renders leave one goal box on the shared status bus, not five', async () => {
  const bridge = makeGoalBridge({ objective: 'Ship the release notes', status: 'active', continuations: 0 })
  const nodes = new Map([['node-1', { id: 'node-1', sessionId: 'session-1', status: 'working' }]])
  const rail = buildRail({ bridge, nodes })
  // A person clicking the same circle five times. showTreeNodeControls wipes
  // the board first and then builds the box, which is this exact order.
  for (let render = 0; render < 5; render++) {
    rail.clearBoard()
    document.body.appendChild(rail.box({ id: 'node-1' }))
    await flush()
  }
  assert.equal(rail.live(), 1, 'five rail renders must leave one live subscriber on the shared bus')
  assert.equal(rail.unsubs.length, 1,
    'the view-lifetime list must hold one release for the goal box, not one per render')

  const before = bridge.calls.length
  rail.notify()
  await flush()
  assert.equal(bridge.calls.length - before, 1,
    'one status tick must cost one goal read over IPC, not one per rail render ever made')

  // Closing the view runs exactly what destroy() runs, and the last box goes.
  rail.closeView()
  assert.equal(rail.live(), 0, 'a closed view must leave nothing on the shared bus')
  const quiet = bridge.calls.length
  rail.notify()
  await flush()
  assert.equal(bridge.calls.length, quiet, 'a closed view must not keep reading goals')
})

test('a board wipe does not kill the goal box still on screen: Clear keeps working after the rail is re-shown', async () => {
  const bridge = makeGoalBridge({ objective: 'Ship the release notes', status: 'active', continuations: 0 })
  const nodes = new Map([['node-1', { id: 'node-1', sessionId: 'session-1', status: 'working' }]])
  const rail = buildRail({ bridge, nodes })
  rail.clearBoard()
  const panel = rail.box({ id: 'node-1' })
  document.body.appendChild(panel)
  await flush()
  const clear = panel.querySelector('[data-goal="clear"]')
  assert.equal(clear.disabled, false, 'a confirmed goal enables Clear')

  /* The person presses the rail's back arrow: activateRail(statsPage) arms
     railDisposeTimer, which fires clearBoard() 200 ms later. The board's DOM
     stays exactly where it was -- activateRail only toggles is-active. */
  const reads = bridge.calls.length
  rail.clearBoard()

  /* Then they type /loop, or move focus from the palette. openLoopFor and
     focusDetailsControl find the same node and the same board still in the
     DOM, so they take `else activateRail(controlsPage)` and rebuild nothing.
     The box the person is looking at is the one built above. */
  rail.notify()
  await flush()
  assert.equal(bridge.calls.length, reads + 1,
    'a re-shown board must still answer the status bus, or its Goal line freezes on stale words')

  clear.click()
  await flush()
  assert.equal(bridge.calls.filter(call => call.operation === 'clear').length, 1,
    'Clear goal must still clear, not sit enabled and do nothing')
  assert.equal(panel.querySelector('[data-goal="objective"]').textContent, 'No goal set.')
})

test('the next goal box owns the release, and the board wipe is not what ends it', () => {
  const box = declaredFunctionSource(source, 'goalControlsBox')
  assert.match(box, /disposeBoardGoalBox\(\)[\s\S]*boardGoalUnsub = \(\) =>/,
    'each goal box must release the previous one before it registers its own')
  assert.doesNotMatch(declaredFunctionSource(source, 'clearBoard'), /disposeBoardGoalBox/,
    'clearBoard also runs on the overview timer while the board stays on screen, '
    + 'so releasing there hands back a frozen Goal box and a dead Clear button')
})
