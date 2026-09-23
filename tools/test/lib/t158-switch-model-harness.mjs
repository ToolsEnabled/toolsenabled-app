/* SHARED HARNESS for T158 cross-provider model-switch cases, extracted from
 * tools/test/t158-cross-provider-model-switch.test.mjs so a second file
 * (tools/test/t158-model-switch-transcript-carry.test.mjs) can press the same
 * real row through the same real organisation record and agent host without
 * copying the wiring -- and risking it drifting out of agreement with the
 * original. See that file's own header for why each piece here is real
 * rather than a stand-in: a stub bridge or a stub org record is exactly the
 * shortcut that let AGENT_ROLE_BINDING_INVALID go unnoticed at 88/88.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { register, createRequire } from 'node:module'
import { fleetTreesStorageKey } from '../../../src/fleet-trees.js'
import { canonicalRootForTests } from '../../canonical-root.mjs'

/* Registered here, once, before the dynamic import below pulls in anything
 * that needs CSS stubbing -- exactly the order the original file used, kept
 * in this shared module so a second importer never has to remember it. */
register('../helpers/css-stub-loader.mjs', import.meta.url)

const require = createRequire(import.meta.url)
const orgRecordModule = require('../../../shell/agent-org-record.cjs')

export const { installWorld, fleetFetch, seedTreeNode, mountView, settle } =
  await import('./tree-command-real-mount.mjs')

export const PAYLOAD = canonicalRootForTests()
/* A skip names itself and its reason. Without the packed payload there is no
   real organisation store to resolve a binding through, and a stand-in one is
   the very thing these cases exist to avoid. */
export const payloadSkip = fs.existsSync(path.join(PAYLOAD, 'src/lib/agent-org-store.js'))
  ? false
  : 'no capability payload in this worktree: nothing real to resolve a role binding through'

export const FROM_TIER = 'claude-sonnet'          // provider claude
export const TO_TIER = 'astra'                    // provider codex
export const CROSS_ROW = 'Continue on GPT-6-Astra · Codex'
export const SAME_ROW = 'Continue on Opus · Claude'

let caseCounter = 0
export const freshIds = () => {
  caseCounter += 1
  return {
    computerId: `t158-computer-${caseCounter}`,
    nodeId: `node-2-t158-case-${caseCounter}`,
    oldSession: `session-old-claude-${caseCounter}`,
    newSession: `session-new-target-${caseCounter}`,
  }
}

/* ONE BRIDGE OBJECT AND ONE ORG OBJECT PER IMPORTING FILE, delegating to
 * whichever case is running -- see the original file's header for the
 * measured reason this must not be rebuilt per case. */
export const liveCase = { start: null, close: null, send: null, interrupt: null, listeners: new Set(), org: null }
export const sharedBridge = {
  start: async request => liveCase.start(request),
  close: async request => liveCase.close(request),
  send: async request => liveCase.send(request),
  sendAutomatic: async request => liveCase.sendAutomatic(request),
  /* Optional: a case that never presses Stop never sets this, and the
     default answers as an ordinary successful interrupt so an unrelated
     case cannot be broken by a door it never opens. */
  interrupt: async request => (liveCase.interrupt ? liveCase.interrupt(request) : { ok: true }),
  onEvent: listener => { liveCase.listeners.add(listener); return () => liveCase.listeners.delete(listener) },
}
export const sharedOrgWindow = {
  read: async () => liveCase.org.read(),
  ensureSeat: async request => liveCase.org.ensureSeat(request),
  releaseSeat: async request => liveCase.org.releaseSeat(request),
}

/* THE REAL ORGANISATION RECORD, ON ITS OWN STATE ROOT. Read this before
 * copying the pattern -- see the original file's own long comment for why
 * both LOCALAPPDATA and TOOLSENABLED_STATE_ROOT must be overridden together
 * on this machine, and why the overlay path is asserted rather than assumed. */
export function realOrgRecord(t) {
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), 't158-org-'))
  const stateRoot = path.join(stateHome, 'capability')
  fs.mkdirSync(stateRoot, { recursive: true })
  const modules = orgRecordModule.loadModules({ root: PAYLOAD })
  assert.equal(modules.ok, true, `payload modules must load: ${modules.reason || ''}`)
  if (process.env.TOOLSENABLED_TEST_RETAIN_FIXTURES === '1') {
    console.log('RETAINED_T158_FIXTURE ' + stateHome)
  } else {
    t.after(() => { try { fs.rmSync(stateHome, { recursive: true, force: true }) } catch { /* scratch */ } })
  }
  const record = orgRecordModule.createAgentOrgRecord({
    modules,
    env: { ...process.env, LOCALAPPDATA: stateHome, TOOLSENABLED_STATE_ROOT: stateRoot },
  })
  const read = record.read()
  assert.equal(read.ok, true, `the isolated organisation must read: ${read.reason || ''}`)
  assert.ok(String(read.overlayFile || '').startsWith(stateHome),
    `this case must not touch a real organisation: overlay resolved to ${read.overlayFile}`)
  return record
}

/* ONE RUNNING CIRCLE, STARTED BY THE PRODUCT. See the original file's own
 * comment for why the node is seeded unstarted and started through the
 * chat's own retry row rather than pushed straight into storage already
 * running. */
export async function runningCircle(t, handlers, { fromTier = FROM_TIER, provider = 'claude', initialAccount = null } = {}) {
  const { computerId: COMPUTER_ID, nodeId: NODE_ID, oldSession: OLD_SESSION, newSession: NEW_SESSION } = freshIds()
  const org = realOrgRecord(t)
  const world = await installWorld(fleetFetch({ computerId: COMPUTER_ID }))
  const priorOrg = Object.getOwnPropertyDescriptor(globalThis, 'mcOrg')
  world.storage.setItem('mc.write.agent-session', 'enabled')
  window.mcSetup = { workspaceState: async () => ({ ok: true, available: true, chosen: true, roots: ['/fixture/setup'] }) }

  const calls = []
  let starts = 0
  liveCase.org = org
  liveCase.start = async request => {
    calls.push({ call: 'start', sessionId: request.sessionId, request })
    starts += 1
    if (starts === 1) return { ok: true, sessionId: OLD_SESSION, ...(handlers.initialThreadId ? { threadId: handlers.initialThreadId } : {}), ...(initialAccount ? { account: initialAccount } : {}) }
    return handlers.replacementStart(request, NEW_SESSION)
  }
  liveCase.close = async request => {
    calls.push({ call: 'close', sessionId: request?.sessionId, request })
    return { ok: true, closed: true, sessionId: request?.sessionId }
  }
  liveCase.send = async request => {
    calls.push({ call: 'send', sessionId: request?.sessionId, request })
    return { ok: true, turnId: `turn-${calls.length}` }
  }
  liveCase.sendAutomatic = async request => {
    calls.push({ call: 'send', channel: 'automatic', sessionId: request?.sessionId, request })
    if (handlers.automaticDelivery) return handlers.automaticDelivery(request)
    return { ok: true, result: { ok: true, turnId: `automatic-turn-${calls.length}` }, deliveryDisposition: 'accepted' }
  }
  liveCase.interrupt = async request => {
    calls.push({ call: 'interrupt', sessionId: request?.sessionId, request })
    return { ok: true }
  }
  const emit = packet => { for (const listener of liveCase.listeners) listener(packet) }
  window.mcAgent = globalThis.mcAgent = sharedBridge
  globalThis.mcOrg = window.mcOrg = sharedOrgWindow
  /* The seat as a Claude start would have left it: the state the measured
     failure began from. */
  const seated = org.ensureSeat({ id: NODE_ID, role: 'builder', provider, displayName: 'Agent', nodeId: NODE_ID })
  assert.equal(seated.ok, true, 'the circle starts out seated on Claude')
  assert.equal(seated.org.agents.find(row => row.id === NODE_ID).provider, provider)

  seedTreeNode(world.storage, { nodeId: NODE_ID, sessionId: null, status: 'failed', computerId: COMPUTER_ID })
  const key = fleetTreesStorageKey(COMPUTER_ID)
  const seedRecord = JSON.parse(world.storage.getItem(key))
  seedRecord.nodes[0].tier = fromTier
  seedRecord.nodes[0].message = 'Answer my questions.'
  world.storage.setItem(key, JSON.stringify(seedRecord))

  if (handlers.configureWindow) await handlers.configureWindow(window)
  const view = await mountView(world, { computerId: COMPUTER_ID })
  t.after(() => {
    view.destroy()
    if (priorOrg) Object.defineProperty(globalThis, 'mcOrg', priorOrg); else delete globalThis.mcOrg
    world.restore()
  })
  const readNode = () => JSON.parse(world.storage.getItem(key)).nodes.find(row => row.id === NODE_ID)

  view.el.querySelectorAll('.static-tree-node').find(row => row.dataset.agentId === NODE_ID)
    .dispatch('keydown', { key: 'Enter', shiftKey: true })
  await settle(6)
  const chat = view.el.querySelector('[data-rail-chat-host] .chat')
  assert.ok(chat, 'the circle opens a chat')
  chat.openActions()
  const retry = chat.querySelectorAll('.chat-actions-row').find(row => /Retry starting this agent/.test(row.textContent))
  assert.ok(retry, 'the unstarted circle offers its start')
  retry.dispatch('click')
  await settle(8)
  for (let attempt = 0; attempt < 400 && readNode().sessionId !== OLD_SESSION; attempt += 1) await settle(4)
  assert.equal(readNode().sessionId, OLD_SESSION, 'the circle is running on its Claude session')

  emit({ sessionId: OLD_SESSION, event: { type: 'turn_completed', status: 'completed', turnId: 'turn-first' } })
  for (let attempt = 0; attempt < 400 && readNode().status !== 'finished'; attempt += 1) await settle(4)
  assert.equal(readNode().status, 'finished', 'the circle is idle between turns, as it was when this was walked')

  calls.length = 0
  /* The rail chat is re-rendered by the start, so the element captured above
     is stale. Every later press re-reads it; pressing a detached node is a
     silent no-op that reads exactly like a passing case. */
  const liveChat = () => view.el.querySelector('[data-rail-chat-host] .chat')
  return { org, world, view, liveChat, calls, readNode, emit, key, NODE_ID, COMPUTER_ID, OLD_SESSION, NEW_SESSION }
}

/* THE SAME CIRCLE, MID-TURN. Added alongside runningCircle, never in place of
 * it: the fifteen cases that press an idle circle must go on pressing an idle
 * circle, because that is a real state and they are the only cover it has.
 *
 * WHY THIS VARIANT HAD TO EXIST. runningCircle() ends by emitting
 * turn_completed and asserting `status === 'finished'` -- "the circle is idle
 * between turns" -- BEFORE anything is pressed. Every case built on it
 * therefore measures a circle that holds a live session and is doing nothing.
 * The helper's NAME is what hid that: "running" there means it has a session,
 * not that a turn is in flight, so each case reads as a running-circle test
 * while measuring the idle one. The owner's words were "mid session", and mid
 * session is the state nothing was pressing.
 *
 * THE STATE HELD HERE is a turn started and never completed: the person's
 * message goes in through the composer exactly as they send it, the fixture
 * answers with a turnId, and no turn_completed packet ever follows. That is
 * what nodeBusy() reads (BUSY_STATUSES = starting|running in
 * src/tree-session-liveness.js), so the view sees precisely what it sees while
 * an agent is working.
 *
 * `calls` is cleared before returning, so a case sees only what ITS press did.
 */
export async function busyCircle(t, handlers, { text = 'keep going', fromTier = FROM_TIER, provider = 'claude', initialAccount = null } = {}) {
  const ctx = await runningCircle(t, handlers, { fromTier, provider, initialAccount })
  assert.equal(ctx.readNode().status, 'finished', 'the busy variant starts from the idle circle the suite already builds')

  const chat = ctx.liveChat()
  const input = chat.querySelector('.chat-input input')
  assert.ok(input, 'the idle circle offers a composer to send from')
  input.value = text
  chat.querySelector('.chat-send').dispatch('click')
  await waitFor(() => ctx.readNode().status === 'running', 'a turn to be in flight with no completion behind it')

  ctx.calls.length = 0
  return ctx
}

/* WAIT FOR THE EFFECT, NOT FOR A TICK COUNT -- see the original file's own
 * comment: a fixed settle count is a race between real mounts. */
export async function waitFor(predicate, label, tries = 400) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (predicate()) return
    await settle(4)
  }
  assert.fail(`timed out waiting for: ${label}`)
}

/* PRESS IT. Actions -> Switch model -> the continuation row, by its words. */
export async function pressContinueRow(ctx, rowLabel) {
  const chat = ctx.liveChat()
  assert.ok(chat, 'the running circle still has a chat to press')
  chat.openActions()
  const switchRow = chat.querySelectorAll('.chat-actions-row').find(row => /Switch model/.test(row.textContent))
  assert.ok(switchRow, 'Actions offers "Switch model" on a running circle')
  switchRow.dispatch('click')
  await settle(8)
  const target = chat.querySelectorAll('.chat-actions-row').find(row => row.textContent.includes(rowLabel))
  assert.ok(target, `the "${rowLabel}" row is on the sub-stage`)
  assert.notEqual(target.getAttribute('aria-disabled'), 'true', `the "${rowLabel}" row is pressable`)
  target.dispatch('click')
  await settle(8)
  return target
}

export const startedRequests = ctx => ctx.calls.filter(entry => entry.call === 'start')
