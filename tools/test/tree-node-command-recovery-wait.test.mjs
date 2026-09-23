/* A tree command that lands inside an account recovery is answered after it.
 *
 * These cases drive the real Computers view (runTreeNodeCommand) over the real account-recovery
 * coordinator on a native world: circles are saved with a session the host confirms, the host
 * announces the account_recovery_needed ticket, and the replacement start is held open so a command
 * can land in the middle of the flight. Nothing is stubbed between the command and the coordinator's
 * own isRecovering answer.
 *
 * Every case carries its own circle and session names: the coordinator and the session map are
 * module singletons, and a shared circle would let one case's successor answer another's question. */
import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import { register } from 'node:module'
import { fleetTreesStorageKey } from '../../src/fleet-trees.js'
import { LIFECYCLE_REFUSALS } from '../../src/agent-removal-rule.js'
import { COMPUTER_ID, fleetFetch, installWorld, mountView, seedTreeNode, settle } from './lib/tree-command-real-mount.mjs'

register('./helpers/css-stub-loader.mjs', import.meta.url)

/* The view's bounded wait, in ms. Pinned in tree-node-settle-wait.test.mjs
   against the module's own export; written out here so this file loads (and
   fails on behaviour) against a build that has no such module. */
const SETTLE_BOUND_MS = 30_000
const STAMP = '2026-09-06T04:51:00.000Z'
const KEYS = ['resume', 'guard', 'send', 'unconfirmed', 'quiet', 'bound', 'parent', 'stranger', 'authloss', 'word', 'authloss2', 'kill']
/* The wait's own poll, in ms (tree-node-settle-wait.test.mjs pins the export). */
const POLL_MS = 250
const nodeId = key => `node-${key}`
const oldSession = key => `session-old-${key}`
const newSession = key => `session-new-${key}`

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
async function until(check, message) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (check()) return
    await sleep(10)
  }
  assert.fail(message)
}
/* Still unanswered after a beat? -- the difference between "waited" and "refused". */
const pendingOr = promise => Promise.race([promise, sleep(150).then(() => 'PENDING')])

let world = null
let view = null
const listeners = new Set()
const starts = []
const closes = []
const sends = []
const hostOpen = () => ({ ok: true, busy: true, closing: false, lastTurnStatus: null, turnsCompleted: 0 })
const script = { start: null, activity: hostOpen }
const startsFor = key => starts.filter(row => row.key === key).length

let serial = 0
const command = (key, action, extra = {}) => ({
  protocol: 'mc.tree-node-command', schemaVersion: 1, requestId: `req-${action}-${key}-${serial += 1}`, action,
  computerId: COMPUTER_ID, treeId: null, nodeId: nodeId(key), expectedSessionId: null, parentSessionId: null, ...extra,
})

/* The recovery flight for one circle, held at its replacement start. */
async function startFlight(key) {
  const gate = deferred()
  script.start = async args => {
    starts.push({ key, args })
    await gate.promise
    return { ok: true, sessionId: newSession(key), threadId: `thread-new-${key}` }
  }
  for (const listener of [...listeners]) {
    listener({ sessionId: oldSession(key), event: { type: 'account_recovery_needed', recoveryId: `ticket-${key}`, handoff: 'Continue the work.' } })
  }
  await until(() => startsFor(key) === 1, `the recovery flight for ${key} never reached its replacement start`)
  return gate
}

before(async () => {
  world = await installWorld(fleetFetch(), { asyncFrames: true })
  const { bridge, storage } = world
  storage.setItem('mc.write.agent-session', 'enabled')
  bridge.onEvent = listener => { listeners.add(listener); return () => listeners.delete(listener) }
  bridge.start = async args => { if (!script.start) throw new Error('an unexpected session start'); return script.start(args) }
  bridge.close = async args => { closes.push(args.sessionId); return { sessionId: args.sessionId, closed: true } }
  bridge.send = async args => { sends.push({ sessionId: args.sessionId, text: args.text }); return { ok: true, turnId: 'turn-person' } }
  bridge.sendAutomatic = async args => {
    sends.push({ sessionId: args.sessionId, text: args.text, automatic: true })
    return { ok: true, result: { ok: true }, deliveryDisposition: 'accepted' }
  }
  bridge.updateTreeAddress = async () => ({ ok: true })
  bridge.sessionActivity = async request => script.activity(request.sessionId)
  bridge.models = async () => ({ provider: 'claude', catalogSupported: true, models: [] })
  bridge.history = async () => ({ ok: true, entries: [] })
  bridge.availability = async () => ({ ok: true, available: true })
  // Recovery pauses before it closes anything unless the native conversation's directory and the
  // current task records can both be read.
  bridge.ledger = async () => ({ ok: true, records: [] })
  const nodeIds = ['node-lead', 'node-lead2', 'node-lead3', 'node-sibling', ...KEYS.map(nodeId)]
  window.mcTranscripts = {
    list: async () => ({ ok: true, records: nodeIds.map(id => ({ computerId: COMPUTER_ID, nodeId: id })) }),
    read: async request => ({ ok: true, entries: [], metadata: { computerId: request.computerId, nodeId: request.nodeId }, before: null,
      recoveryDirectory: `/synthetic/conversations/${request.nodeId}` }),
    append: async () => ({ ok: true }),
    bind: async () => ({ ok: true }),
    onError: () => () => {},
  }
  const node = (id, sessionId, parentId) => ({
    id, treeId: 'tree-1', status: 'running', createdAt: STAMP, updatedAt: STAMP,
    role: 'builder', message: '', statusNote: '', sessionId, parentId,
  })
  storage.setItem(fleetTreesStorageKey(COMPUTER_ID), JSON.stringify({
    version: 1, computerId: COMPUTER_ID,
    trees: [{ id: 'tree-1', name: null, createdAt: STAMP, updatedAt: STAMP, profileId: null }],
    nodes: [node('node-lead', 'session-lead', null), node('node-lead2', 'session-lead2', 'node-lead'),
      node('node-lead3', 'session-lead3', 'node-lead'), node('node-sibling', 'session-sibling', 'node-lead'),
      ...KEYS.map(key => node(nodeId(key), oldSession(key),
        key === 'authloss' ? 'node-lead2' : key === 'authloss2' ? 'node-lead3' : 'node-lead'))],
  }))
  view = await mountView(world)
  await settle(60)
})

after(() => {
  // The last case below destroys the shared view itself, to prove the destroyed answer on
  // a real mount; a repeat destroy() here must not turn that into a reported hook failure.
  try { view?.destroy() } catch { /* already destroyed by the last case */ }
  delete window.mcTranscripts
  world?.restore()
})

test('resume-node that lands inside a recovery waits for it and answers with the successor, without starting a second session', async () => {
  const gate = await startFlight('resume')
  try {
    const pending = view.runTreeNodeCommand(command('resume', 'resume-node'))
    assert.equal(await pendingOr(pending), 'PENDING', 'a resume inside the flight was answered before the flight ended')
    gate.resolve()
    const answer = await pending
    assert.equal(answer.ok, true, `refused: ${JSON.stringify(answer)}`)
    assert.equal(answer.nodeId, nodeId('resume'))
    assert.equal(answer.sessionId, newSession('resume'))
    assert.equal(answer.threadId, 'thread-new-resume')
    assert.equal(startsFor('resume'), 1, 'the circle was started a second time')
    assert.deepEqual(closes.filter(id => id === oldSession('resume')), [oldSession('resume')])
  } finally { gate.resolve() }
})

test('an authorised parent that lands inside the recovery is answered the same way', async () => {
  const gate = await startFlight('parent')
  try {
    const pending = view.runTreeNodeCommand(command('parent', 'resume-node', { parentSessionId: 'session-lead' }))
    assert.equal(await pendingOr(pending), 'PENDING')
    gate.resolve()
    const answer = await pending
    assert.equal(answer.ok, true, `refused: ${JSON.stringify(answer)}`)
    assert.equal(answer.sessionId, newSession('parent'))
    assert.equal(startsFor('parent'), 1)
  } finally { gate.resolve() }
})

test('a resume that named the retiring session is refused as a changed session after the wait, and starts nothing', async () => {
  const gate = await startFlight('guard')
  try {
    const pending = view.runTreeNodeCommand(command('guard', 'resume-node', { expectedSessionId: oldSession('guard') }))
    assert.equal(await pendingOr(pending), 'PENDING', 'the retiring session was still the circle\'s session, so the guard passes and the command waits')
    gate.resolve()
    const answer = await pending
    assert.equal(answer.ok, false)
    assert.equal(answer.code, 'MC_TREE_COMMAND_SESSION_CHANGED')
    assert.equal(startsFor('guard'), 1)
  } finally { gate.resolve() }
})

test('the wait ends on the coordinator\'s own word when its poll is switched off', async t => {
  const nativeInterval = globalThis.setInterval
  // The poll is the only other way out of the wait short of the bound: a poll that
  // never fires leaves the coordinator's word as the only thing that can end it.
  t.mock.method(globalThis, 'setInterval', (callback, ms, ...args) => nativeInterval(ms === POLL_MS ? () => {} : callback, ms, ...args))
  const gate = await startFlight('word')
  try {
    const pending = view.runTreeNodeCommand(command('word', 'resume-node'))
    assert.equal(await pendingOr(pending), 'PENDING')
    gate.resolve()
    const answer = await Promise.race([pending, sleep(4000).then(() => 'STUCK')])
    assert.notEqual(answer, 'STUCK', 'the wait did not end when the recovery did')
    assert.equal(answer.ok, true, `refused: ${JSON.stringify(answer)}`)
    assert.equal(answer.sessionId, newSession('word'))
    assert.equal(startsFor('word'), 1)
  } finally { gate.resolve() }
})

test('an asker who is not above the circle is refused at once, never held for the recovery', async () => {
  const gate = await startFlight('stranger')
  try {
    const nobody = await pendingOr(view.runTreeNodeCommand(command('stranger', 'resume-node', { parentSessionId: 'ses-nobody' })))
    assert.notEqual(nobody, 'PENDING', 'an unplaceable asker was made to wait for a recovery it has no right to')
    assert.equal(nobody.code, LIFECYCLE_REFUSALS.callerUnknown)
    const sibling = await pendingOr(view.runTreeNodeCommand(command('stranger', 'resume-node', { parentSessionId: 'session-sibling' })))
    assert.notEqual(sibling, 'PENDING', 'a sibling was made to wait for a recovery it has no right to')
    assert.equal(sibling.code, LIFECYCLE_REFUSALS.notBelowCaller)
    assert.equal(startsFor('stranger'), 1)
  } finally { gate.resolve() }
})

test('an asker whose own session ends while the command waits is placed again afterwards and refused', async () => {
  const gate = await startFlight('authloss')
  try {
    const pending = view.runTreeNodeCommand(command('authloss', 'resume-node', { parentSessionId: 'session-lead2' }))
    assert.equal(await pendingOr(pending), 'PENDING', 'the asker was above the circle when it asked, so the command waits')
    for (const listener of [...listeners]) {
      listener({ sessionId: 'session-lead2', event: { type: 'session_ended', reason: 'exited', exit: { code: 0, signal: null } } })
    }
    await settle(20)
    gate.resolve()
    const answer = await pending
    assert.equal(answer.ok, false)
    assert.equal(answer.code, LIFECYCLE_REFUSALS.callerUnknown, 'the wait let an asker that is gone resume the circle')
    assert.equal(startsFor('authloss'), 1)
  } finally { gate.resolve() }
})

test('a message naming the retiring session is not written into it, and one naming the successor is delivered', async () => {
  const gate = await startFlight('send')
  const words = 'Synthetic note for the circle that is being moved'
  try {
    const pending = view.runTreeNodeCommand(command('send', 'send-to-bound-node', { expectedSessionId: oldSession('send'), message: words }))
    assert.equal(await pendingOr(pending), 'PENDING', 'a send inside the flight was answered before the flight ended')
    gate.resolve()
    const refused = await pending
    assert.equal(refused.ok, false)
    assert.equal(refused.code, 'MC_TREE_COMMAND_SESSION_CHANGED')
    assert.deepEqual(sends.filter(row => row.text === words), [], 'the message went into the session the recovery closed')
    const delivered = await view.runTreeNodeCommand(command('send', 'send-to-bound-node', { expectedSessionId: newSession('send'), message: words }))
    assert.equal(delivered.ok, true, `refused: ${JSON.stringify(delivered)}`)
    assert.equal(delivered.sessionId, newSession('send'))
    assert.deepEqual(sends.filter(row => row.text === words).map(row => row.sessionId), [newSession('send')])
  } finally { gate.resolve() }
})

test('a successor the host does not confirm is refused, and nothing is started over it', async () => {
  const gate = await startFlight('unconfirmed')
  try {
    const pending = view.runTreeNodeCommand(command('unconfirmed', 'resume-node'))
    assert.equal(await pendingOr(pending), 'PENDING')
    script.activity = () => ({ ok: false })
    gate.resolve()
    const answer = await pending
    assert.equal(answer.ok, false)
    assert.equal(answer.code, 'MC_TREE_COMMAND_RESUME_REFUSED')
    assert.match(answer.reason || '', /not confirmed/)
    assert.equal(startsFor('unconfirmed'), 1, 'a session was started over a successor the application owns')
  } finally { script.activity = hostOpen; gate.resolve() }
})

test('a command that meets no recovery is answered exactly as before, and arms no wait', async t => {
  const armed = []
  const nativeInterval = globalThis.setInterval
  t.mock.method(globalThis, 'setInterval', (callback, ms, ...args) => { armed.push(ms); return nativeInterval(callback, ms, ...args) })
  const before = starts.length
  const answer = await pendingOr(view.runTreeNodeCommand(command('quiet', 'resume-node')))
  assert.notEqual(answer, 'PENDING')
  assert.equal(answer.ok, false)
  assert.equal(answer.code, 'MC_TREE_COMMAND_RESUME_REFUSED')
  assert.equal(answer.sessionId, oldSession('quiet'), 'a running circle is still refused with the session it is running')
  assert.equal(answer.reason, undefined)
  assert.equal(armed.includes(250), false, 'a poll was armed for a circle that is not being recovered')
  assert.equal(starts.length, before)
})

test('the wait is bounded: at the bound the command is a retryable refusal, and a later command meets the ordinary rule at once', async t => {
  const nativeTimeout = globalThis.setTimeout
  const armed = []
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => {
    const timer = nativeTimeout(callback, ms, ...args)
    if (ms === SETTLE_BOUND_MS) armed.push(() => { clearTimeout(timer); callback(...args) })
    return timer
  })
  const gate = await startFlight('bound')
  try {
    const pending = view.runTreeNodeCommand(command('bound', 'resume-node'))
    assert.equal(await pendingOr(pending), 'PENDING')
    assert.ok(armed.length > 0, 'no timer of the bound\'s length was armed')
    for (const fire of armed) fire()
    const answer = await pending
    assert.equal(answer.ok, false)
    assert.equal(answer.code, 'MC_TREE_COMMAND_RESUME_REFUSED')
    assert.equal(answer.retryable, true)
    assert.match(answer.reason || '', /still being moved/)
    assert.equal(startsFor('bound'), 1)
    gate.resolve()
    await until(() => sends.some(row => row.sessionId === newSession('bound')), 'the recovery never finished after the wait was refused')
    // The recovery is over and the successor runs: resume is for a circle that
    // is not running, so the ordinary rule answers, immediately and unchanged.
    const later = await pendingOr(view.runTreeNodeCommand(command('bound', 'resume-node')))
    assert.notEqual(later, 'PENDING', 'a wait outlived its recovery')
    assert.equal(later.ok, false)
    assert.equal(later.code, 'MC_TREE_COMMAND_RESUME_REFUSED')
    assert.equal(later.sessionId, newSession('bound'))
    assert.equal(later.reason, undefined)
    assert.equal(startsFor('bound'), 1)
  } finally { gate.resolve() }
})

test('an asker whose own session ends during the host confirmation itself is placed again, not carried from before that call', async () => {
  const gate = await startFlight('authloss2')
  script.activity = async sessionId => {
    for (const listener of [...listeners]) {
      listener({ sessionId: 'session-lead3', event: { type: 'session_ended', reason: 'exited', exit: { code: 0, signal: null } } })
    }
    await settle(10)
    return hostOpen()
  }
  try {
    const pending = view.runTreeNodeCommand(command('authloss2', 'resume-node', { parentSessionId: 'session-lead3' }))
    assert.equal(await pendingOr(pending), 'PENDING', 'the asker was above the circle when it asked, so the command waits')
    gate.resolve()
    const answer = await pending
    assert.equal(answer.ok, false)
    assert.equal(answer.code, LIFECYCLE_REFUSALS.callerUnknown, 'the host confirmation ended the asker\'s own session, and the resume still used the authority it had before that call')
    assert.equal(startsFor('authloss2'), 1)
  } finally { gate.resolve(); script.activity = hostOpen }
})

/* A real command's expectedSessionId is fixed at admission, and computers.js's own outer gate
 * refuses a mismatch against the session at that instant before this module is ever reached -- so
 * no value can both clear that gate and still be wrong only at the second internal check. That
 * branch of revalidate() is the same code as the first, admission-time use; no separate case here
 * exercises it a second way. */

test('a view destroyed during the host confirmation is the retryable destroyed answer, not a completed resume', async () => {
  const gate = await startFlight('kill')
  let destroyedDuringCall = false
  script.activity = async () => { view.destroy(); destroyedDuringCall = true; return hostOpen() }
  const pending = view.runTreeNodeCommand(command('kill', 'resume-node'))
  assert.equal(await pendingOr(pending), 'PENDING')
  gate.resolve()
  const answer = await pending
  assert.equal(destroyedDuringCall, true, 'the host confirmation never ran, so this proves nothing about the awaited call')
  assert.equal(answer.code, 'MC_TREE_COMMAND_VIEW_DESTROYED')
  assert.equal(answer.retryable, true)
})
