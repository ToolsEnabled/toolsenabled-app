import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
register('./helpers/css-stub-loader.mjs', import.meta.url)
const { installWorld, fleetFetch, seedTreeNode, mountView, settle } = await import('./lib/tree-command-real-mount.mjs')

let serial = 0
async function mount(t, { live = false, transcripts = null, bounded = false } = {}) {
  const computerId = `runtime-computer-${++serial}`
  const world = await installWorld(fleetFetch({ computerId }))
  globalThis.requestAnimationFrame = callback => setTimeout(() => callback(Date.now()), 0)
  globalThis.cancelAnimationFrame = timer => clearTimeout(timer)
  document.createTextNode = text => {
    const node = document.createElement('span')
    node.textContent = text
    Object.defineProperty(node, 'data', { get: () => node.textContent, set: value => { node.textContent = value } })
    return node
  }
  const nodeId = `runtime-controls-${serial}`
  const sessionId = `runtime-session-${serial}`
  const profiles = []
  const packets = new Set()
  const priorOrg = Object.getOwnPropertyDescriptor(globalThis, 'mcOrg')
  world.storage.setItem('mc.write.agent-session', 'enabled')
  world.storage.setItem('mc.set.tree_style', 'boxes')
  window.mcSetup = { workspaceState: async () => ({ ok: true, available: true, chosen: true, roots: ['/fixture/setup'] }) }
  world.bridge.profiles = async () => ({ ok: true, profiles: profiles.slice() })
  world.bridge.profileCreate = async ({ name }) => {
    const profile = { id: 'fixture-profile', name, cwd: '/fixture/named' }
    profiles.push(profile)
    return { ok: true, profile }
  }
  world.bridge.profileRemove = async () => { profiles.length = 0; return { ok: true } }
  world.bridge.pickAttachment = async () => ({ ok: true, path: '/fixture/retained.png' })
  world.bridge.confinement = async () => ({ ok: true, tier: 'guided', sandbox: 'read-only', approvalPolicy: 'never', isolated: true, recorded: true })
  world.bridge.start = async () => ({ ok: true, sessionId, threadId: 'fixture-thread' })
  world.bridge.send = async () => ({ turnId: 'fixture-turn' })
  world.bridge.onEvent = listener => { packets.add(listener); return () => packets.delete(listener) }
  seedTreeNode(world.storage, { computerId, nodeId, sessionId: live ? null : `closed-${sessionId}`, status: 'finished' })
  {
    const org = { revision: 1, source: 'overlay', agents: [{ id: nodeId, role: 'builder', provider: 'codex', enabled: true }], edges: [] }
    const roles = [{ id: 'builder', name: 'Builder', revision: 1, capabilities: {} }, ...(bounded ? [{ id: 'worker', name: 'Worker', revision: 1, capabilities: {} }] : [])]
    globalThis.mcOrg = window.mcOrg = { read: async () => ({ ok: true, org, roles }), ...(bounded ? { ensureSeat: async request => { org.revision++; org.agents.push({ id: request.id, role: request.role, provider: request.provider, enabled: true }); org.edges.push({ from: request.managerId, to: request.id }); return { ok: true, org } } } : {}) }
  }
  if (transcripts) window.mcTranscripts = await transcripts({ computerId, nodeId, sessionId })
  const view = await mountView(world, { computerId })
  const cleanups = []
  t.after(() => { for (const cleanup of cleanups) cleanup(); view.destroy(); if (priorOrg) Object.defineProperty(globalThis, 'mcOrg', priorOrg); else delete globalThis.mcOrg; world.restore() })
  if (live) {
    const started = await view.runTreeNodeCommand({ action: 'fresh-start-existing-node', computerId, nodeId })
    assert.equal(started.ok, true, JSON.stringify(started))
  }
  const openRail = async () => {
    view.el.querySelectorAll('.static-tree-node').find(node => node.dataset.agentId === nodeId).dispatch('keydown', { key: 'Enter', shiftKey: true })
    await settle(6)
    return view.el.querySelector('[data-rail-chat-host] .chat')
  }
  const openShelf = async () => {
    view.el.querySelectorAll('.static-tree-node').find(node => node.dataset.agentId === nodeId).dispatch('dblclick')
    await settle(4)
    return view.el.querySelector('.tree-conversation .chat')
  }
  return { view, world, computerId, nodeId, sessionId, openRail, openShelf, cleanup: callback => cleanups.push(callback), emit: async (event, target = sessionId) => { await Promise.all([...packets].map(listener => listener({ sessionId: target, event }))); await settle(3) } }
}

test('a named folder created on Page 2 is immediately offered when starting another tree', async t => {
  const f = await mount(t)
  const name = f.view.el.querySelector('[data-profile-name]')
  assert.ok(name)
  name.value = 'New QA folder'
  f.view.el.querySelector('[data-profile-add]').dispatch('click')
  await settle(6)
  assert.match(f.view.el.querySelector('[data-profile-list]').textContent, /New QA folder/)
  f.view.el.querySelector('.tree-chat-add').dispatch('click')
  f.view.el.querySelector('.tree-new-tree').dispatch('click')
  await settle(6)
  assert.match(f.view.el.querySelector('[data-compose-field="profile"]').textContent, /New QA folder/)
})

test('a profile removed while the start form is open leaves its draft intact and disappears from the picker', async t => {
  const f = await mount(t)
  f.view.el.querySelector('[data-profile-name]').value = 'Temporary QA folder'
  f.view.el.querySelector('[data-profile-add]').dispatch('click')
  await settle(6)
  f.view.el.querySelector('.tree-chat-add').dispatch('click')
  f.view.el.querySelector('.tree-new-tree').dispatch('click')
  await settle(6)
  const input = f.view.el.querySelector('[data-compose-field="message"]')
  assert.ok(input)
  input.value = 'Keep this unstarted brief.'
  input.dispatch('input')
  f.view.el.querySelector('[data-profile-remove]').dispatch('click')
  await settle(6)
  assert.doesNotMatch(f.view.el.querySelector('[data-compose-field="profile"]').textContent, /Temporary QA folder/)
  assert.equal(f.view.el.querySelector('[data-compose-field="message"]').value, 'Keep this unstarted brief.')
})

test('the agent chip reads the host tier field on a Guided computer', async t => {
  const f = await mount(t)
  const chat = await f.openRail()
  assert.match(chat.querySelector('[data-chat-chip="tier"]').textContent, /Guided/)
})

for (const openBeforeWait of [true, false]) test(`queued Resume controls remain reachable in selected Chat and Details (open before wait: ${openBeforeWait})`, async t => {
  const f = await mount(t, { live: true })
  await f.emit({ type: 'turn_completed', status: 'completed', turnId: 'opening-turn' })
  if (openBeforeWait) await f.openRail()
  const starts = []
  f.world.bridge.start = async request => { starts.push(request); return { ok: false, code: 'AGENT_RESOURCE_PRESSURE' } }
  const completion = f.view.runTreeNodeCommand({ action: 'resume-node', computerId: f.computerId, nodeId: f.nodeId })
  await settle(12)
  assert.equal(starts.length, 1, 'one native attempt established the resource hold')
  assert.equal(starts[0].resumeThreadId, 'fixture-thread')
  const chat = openBeforeWait ? f.view.el.querySelector('[data-rail-chat-host] .chat') : await f.openRail()
  const input = chat.querySelector('.chat-input input')
  input.value = 'Keep this unsent draft while waiting.'
  input.dispatch('input')
  const panel = chat.closest('.rail-page')
  assert.ok(panel, 'the actual mounted chat belongs to its rail page')
  const control = text => panel.querySelectorAll('button').find(button => button.textContent === text)
  assert.equal(f.view.el.querySelector('.stats-page').classList.contains('is-active'), false, 'the overview is hidden while reading the conversation')
  for (const tab of ['chat', 'details']) {
    panel.querySelector(`[data-rail-tab="${tab}"]`).dispatch('click')
    const pause = control('Pause queue'), cancel = control('Cancel queued')
    assert.ok(pause && cancel, `the active ${tab} panel must expose both queue controls`)
    assert.equal(panel.classList.contains('is-active'), true)
    assert.equal(pause.closest('[data-rail-body]'), null, 'controls cannot disappear when either tab body is hidden')
    assert.equal(cancel.closest('[data-rail-body]'), null)
    assert.equal(control('Start tree'), undefined, 'the selected conversation gets queue controls, not a second tree-start action')
  }
  control('Pause queue').focus()
  control('Pause queue').dispatch('click')
  assert.ok(control('Resume queue'))
  assert.equal(document.activeElement, control('Resume queue'), 'queue status repaint retains the focused action')
  assert.equal(input.value, 'Keep this unsent draft while waiting.')
  assert.equal(panel.querySelector('[data-rail-body="details"]').hidden, false)
  assert.doesNotMatch(f.view.el.querySelector('.org-status').textContent, /above the tree/)
  control('Resume queue').dispatch('click')
  assert.ok(control('Pause queue'))
  control('Cancel queued').dispatch('click')
  assert.equal((await completion).ok, false)
  await settle(3)
  assert.equal(starts.length, 1, 'Pause/Cancel do not cause another native admission')
  assert.equal(control('Pause queue'), undefined)
  assert.equal(control('Cancel queued'), undefined)
  assert.equal(input.value, 'Keep this unsent draft while waiting.')
})

for (const openBeforeWait of [true, false]) test(`queued Resume controls remain reachable in the full conversation (open before wait: ${openBeforeWait})`, async t => {
  const f = await mount(t, { live: true })
  await f.emit({ type: 'turn_completed', status: 'completed', turnId: 'opening-turn' })
  const openConversation = async () => {
    const node = f.view.el.querySelectorAll('.static-tree-node').find(item => item.dataset.agentId === f.nodeId)
    node.querySelector('.tree-box-chat').dispatch('click')
    await settle(6)
    return f.view.el.querySelector('.tree-conversation')
  }
  if (openBeforeWait) await openConversation()
  const outbox = await import('../../src/session-outbox.js')
  outbox.enqueue(f.sessionId, 'Keep the original waiting message.')
  const original = outbox.list(f.sessionId)
  f.cleanup(() => outbox.clearSession(f.sessionId))
  const starts = []
  f.world.bridge.start = async request => { starts.push(request); return { ok: false, code: 'AGENT_RESOURCE_PRESSURE' } }
  const completion = f.view.runTreeNodeCommand({ action: 'resume-node', computerId: f.computerId, nodeId: f.nodeId })
  await settle(12)
  assert.equal(starts.length, 1, 'the actual Resume wrapper has received a native resource hold')
  assert.equal(starts[0].resumeThreadId, 'fixture-thread')
  const panel = openBeforeWait ? f.view.el.querySelector('.tree-conversation') : await openConversation()
  assert.ok(panel, 'the chat-tab button opens the actual full conversation')
  assert.equal(panel.classList.contains('as-chat-full'), true)
  const body = panel.closest('.comp-body')
  assert.equal(body.classList.contains('tree-workspace-wide'), true)
  const rail = body.querySelector('.rail')
  assert.equal(rail.parentElement, body, 'the real wide-layout CSS hides this direct rail child')
  assert.equal(panel.closest('.rail'), null, 'the full conversation is outside the hidden rail')
  const assertVisibleAncestors = element => {
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
      assert.notEqual(ancestor.hidden, true, 'the selected conversation and its controls have no hidden ancestor')
    }
  }
  assertVisibleAncestors(panel)
  const control = text => panel.querySelectorAll('button').find(button => button.textContent === text)
  const pause = control('Pause queue'), cancel = control('Cancel queued')
  assert.ok(pause && cancel, 'the visible full conversation must expose both resource-queue controls')
  for (const button of [pause, cancel]) {
    assert.equal(button.closest('.rail'), null, 'controls must remain outside the CSS-hidden rail')
    assertVisibleAncestors(button)
    assert.equal(button.closest('.tree-conversation'), panel)
  }
  assert.equal(control('Start tree'), undefined)
  const input = panel.querySelector('.chat-input input')
  input.value = 'Keep this full-chat draft.'
  input.dispatch('input')
  pause.focus()
  pause.dispatch('click')
  assert.equal(document.activeElement, control('Resume queue'), 'queue repaint retains focus in the visible conversation')
  assert.deepEqual(outbox.list(f.sessionId), original)
  control('Resume queue').dispatch('click')
  assert.ok(control('Pause queue'))
  control('Cancel queued').dispatch('click')
  assert.equal((await completion).ok, false)
  await settle(3)
  assert.equal(starts.length, 1, 'Pause/Cancel never dispatch another native start')
  assert.equal(control('Pause queue'), undefined)
  assert.equal(control('Cancel queued'), undefined)
  assert.equal(input.value, 'Keep this full-chat draft.')
  assert.deepEqual(outbox.list(f.sessionId), original, 'cancellation preserves the original entry and confirmation state')
  assert.equal(body.classList.contains('tree-workspace-wide'), true, 'queue actions keep the selected full conversation open')
})

test('Stop this agent remains available after its live session finishes a reply', async t => {
  const f = await mount(t, { live: true })
  const chat = await f.openRail()
  await f.emit({ type: 'turn_completed', status: 'completed', turnId: 'fixture-turn' })
  chat.openActions()
  const stop = chat.querySelectorAll('.chat-actions-list button').find(button => button.textContent.startsWith('Stop this agent'))
  assert.ok(stop)
  assert.notEqual(stop.getAttribute('aria-disabled'), 'true')
})

test('an open shelf observes a reply sent from the rail as it streams and completes exactly once', async t => {
  const f = await mount(t, { live: true })
  const shelf = await f.openShelf()
  const rail = await f.openRail()
  await f.emit({ type: 'assistant_text_delta', text: 'SHARED_REPLY', turnId: 'fixture-turn' })
  assert.match(shelf.textContent, /SHARED_REPLY/)
  assert.match(rail.textContent, /SHARED_REPLY/)
  await f.emit({ type: 'turn_completed', status: 'completed', turnId: 'fixture-turn' })
  assert.equal(shelf.querySelectorAll('.msg').filter(row => row.classList.contains('them') && row.textContent.includes('SHARED_REPLY')).length, 1)
  assert.equal(rail.querySelectorAll('.msg').filter(row => row.classList.contains('them') && row.textContent.includes('SHARED_REPLY')).length, 1)
})

test('a shelf send receives one answer when its callback and the shared stream both settle', async t => {
  const f = await mount(t, { live: true })
  await f.emit({ type: 'turn_completed', status: 'completed', turnId: 'opening-turn' })
  const shelf = await f.openShelf()
  const input = shelf.querySelector('.chat-input input')
  input.value = 'A question from this shelf'
  input.dispatch('input')
  shelf.querySelector('.chat-send').dispatch('click')
  await settle(5)
  await f.emit({ type: 'assistant_text_delta', text: 'ONE_SHELF_ANSWER', turnId: 'fixture-turn' })
  await f.emit({ type: 'turn_completed', status: 'completed', turnId: 'fixture-turn' })
  assert.equal(shelf.querySelectorAll('.msg').filter(row => row.classList.contains('them') && row.textContent.includes('ONE_SHELF_ANSWER')).length, 1)
})

test('a resumed shelf keeps its draft and image, reads its new history, and observes the resumed reply', async t => {
  const f = await mount(t, { live: true })
  await f.emit({ type: 'assistant_text_delta', text: 'Earlier real fixture reply.', turnId: 'opening-turn' })
  await f.emit({ type: 'turn_completed', status: 'completed', turnId: 'opening-turn' })
  const shelf = await f.openShelf()
  const input = shelf.querySelector('.chat-input input')
  input.value = 'Keep my next unsent question'
  input.dispatch('input')
  shelf.querySelector('[data-chat-attach]').dispatch('click')
  await settle(3)
  const replacement = `${f.sessionId}-resumed`
  f.world.bridge.start = async request => {
    if (request.resumeThreadId) throw new Error('AGENT_RESUME_UNAVAILABLE')
    return { ok: true, sessionId: replacement, threadId: 'resumed-thread' }
  }
  const resumed = await f.view.runTreeNodeCommand({ action: 'resume-node', computerId: f.computerId, nodeId: f.nodeId })
  assert.equal(resumed.ok, true, JSON.stringify(resumed))
  await settle(5)
  const rebound = f.view.el.querySelector('.tree-conversation .chat')
  assert.equal(rebound.querySelector('.chat-input input').value, 'Keep my next unsent question')
  assert.equal(rebound.querySelectorAll('.chat-attachment-chip').length, 1)
  assert.match(rebound.textContent, /Earlier real fixture reply\./)
  assert.match(rebound.textContent, /Resumed/)
  assert.match(rebound.querySelector('[data-chat-subtitle]').textContent, /live session/)
  await f.emit({ type: 'assistant_text_delta', text: 'RESUMED_REPLY', turnId: 'resumed-turn' }, replacement)
  await f.emit({ type: 'turn_completed', status: 'completed', turnId: 'resumed-turn' }, replacement)
  assert.equal(rebound.querySelectorAll('.msg').filter(row => row.classList.contains('them') && row.textContent.includes('RESUMED_REPLY')).length, 1)
})

test('an open shelf updates its live subtitle when its session closes without changing session ID', async t => {
  const f = await mount(t, { live: true })
  await f.emit({ type: 'turn_completed', status: 'completed', turnId: 'fixture-turn' })
  const shelf = await f.openShelf()
  assert.match(shelf.querySelector('[data-chat-subtitle]').textContent, /live session/)
  const stopped = await f.view.runTreeNodeCommand({ action: 'stop-node', computerId: f.computerId, nodeId: f.nodeId })
  assert.equal(stopped.ok, true)
  await settle(4)
  assert.match(shelf.querySelector('[data-chat-subtitle]').textContent, /no longer open/)
})

test('repeated Stop distinguishes an ended session from failed process cleanup', async t => {
  const f = await mount(t, { live: true })
  const command = { action: 'stop-node', computerId: f.computerId, nodeId: f.nodeId, expectedSessionId: f.sessionId }
  const stopped = await f.view.runTreeNodeCommand(command)
  assert.equal(stopped.ok, true)
  f.world.bridge.close = async () => { throw new Error('MC_AGENT_UNKNOWN_SESSION') }
  const repeated = await f.view.runTreeNodeCommand(command)
  assert.equal(repeated.ok, false)
  assert.equal(repeated.code, 'MC_TREE_COMMAND_SESSION_ENDED')
  assert.match(repeated.reason, /already ended/)
  f.world.bridge.close = async () => { throw new Error('AGENT_SESSION_CLEANUP_FAILED') }
  const failed = await f.view.runTreeNodeCommand(command)
  assert.equal(failed.code, 'MC_TREE_COMMAND_STOP_FAILED', 'uncertain cleanup must remain a failure')
  const stale = await f.view.runTreeNodeCommand({ ...command, expectedSessionId: 'old-session' })
  assert.equal(stale.code, 'MC_TREE_COMMAND_SESSION_CHANGED')
  assert.match(stale.reason, /current session/)
})

test('a confirmed rewind refreshes both open histories while preserving the shelf draft and image', async t => {
  const f = await mount(t, { live: true })
  await f.emit({ type: 'assistant_text_delta', text: 'Opening fixture reply.', turnId: 'opening-turn' })
  await f.emit({ type: 'turn_completed', status: 'completed', turnId: 'opening-turn' })
  let turn = 0
  f.world.bridge.send = async () => ({ turnId: `rewind-turn-${++turn}` })
  const shelf = await f.openShelf()
  const send = async (question, answer) => {
    const input = shelf.querySelector('.chat-input input')
    input.value = question
    input.dispatch('input')
    shelf.querySelector('.chat-send').dispatch('click')
    await settle(5)
    await f.emit({ type: 'assistant_text_delta', text: answer, turnId: `rewind-turn-${turn}` })
    await f.emit({ type: 'turn_completed', status: 'completed', turnId: `rewind-turn-${turn}` })
  }
  await send('KEEP_POINT_FOR_REWIND', 'KEPT_REPLY')
  await send('FORGET_AFTER_REWIND', 'FORGOTTEN_REPLY')
  await f.openRail()
  const input = shelf.querySelector('.chat-input input')
  input.value = 'KEEP_UNSENT_REWIND_DRAFT'
  input.dispatch('input')
  shelf.querySelector('[data-chat-attach]').dispatch('click')
  await settle(3)
  const calls = []
  f.world.bridge.rewind = async request => { calls.push(request); return { ...request, threadId: 'rewound-thread' } }
  shelf.openActions('rewind')
  await settle(3)
  const point = shelf.querySelectorAll('.chat-actions-row').find(row => row.textContent === 'KEEP_POINT_FOR_REWIND')
  assert.ok(point)
  point.dispatch('click')
  await settle(3)
  const confirm = shelf.querySelectorAll('.chat-actions-row').find(row => row.textContent.startsWith('Rewind'))
  assert.ok(confirm)
  confirm.dispatch('click')
  await settle(8)
  assert.deepEqual(calls, [{ sessionId: f.sessionId, turnId: 'rewind-turn-1' }])
  const refreshedShelf = f.view.el.querySelector('.tree-conversation .chat')
  const refreshedRail = f.view.el.querySelector('[data-rail-chat-host] .chat')
  for (const chat of [refreshedShelf, refreshedRail]) {
    assert.match(chat.textContent, /Rewound/)
    assert.doesNotMatch(chat.textContent, /FORGET_AFTER_REWIND|FORGOTTEN_REPLY/)
  }
  assert.equal(refreshedShelf.querySelector('.chat-input input').value, 'KEEP_UNSENT_REWIND_DRAFT')
  assert.equal(refreshedShelf.querySelectorAll('.chat-attachment-chip').length, 1)
  await f.emit({ type: 'assistant_text_delta', text: 'AFTER_REWIND_REPLY', turnId: 'after-rewind' })
  await f.emit({ type: 'turn_completed', status: 'completed', turnId: 'after-rewind' })
  for (const chat of [refreshedShelf, refreshedRail]) {
    assert.equal(chat.querySelectorAll('.msg').filter(row => row.classList.contains('them') && row.textContent.includes('AFTER_REWIND_REPLY')).length, 1)
  }
})

test('closing an active session keeps its partial words and ignores a late completion and delta', async t => {
  const f = await mount(t, { live: true })
  const shelf = await f.openShelf()
  const rail = await f.openRail()
  await f.emit({ type: 'assistant_text_delta', text: 'Partial words before close.', turnId: 'fixture-turn' })
  const stopped = await f.view.runTreeNodeCommand({ action: 'stop-node', computerId: f.computerId, nodeId: f.nodeId })
  assert.equal(stopped.ok, true)
  await f.emit({ type: 'assistant_text_delta', text: 'LATE_CLOSED_WORDS', turnId: 'fixture-turn' })
  await f.emit({ type: 'turn_completed', status: 'completed', turnId: 'fixture-turn' })
  for (const chat of [shelf, rail]) {
    assert.match(chat.textContent, /Partial words before close\./)
    assert.doesNotMatch(chat.textContent, /LATE_CLOSED_WORDS|turn finished without any words/)
    assert.match(chat.querySelector('[data-chat-subtitle]').textContent, /no longer open/)
  }
})

test('a refused queued Send now keeps its words paused, ignores a later completion, and retries only on a new press', async t => {
  const f = await mount(t, { live: true })
  const shelf = await f.openShelf()
  f.world.bridge.interrupt = async () => {
    setTimeout(() => void f.emit({ type: 'turn_completed', status: 'interrupted', turnId: 'fixture-turn' }), 0)
    return { sessionId: f.sessionId, turnId: 'fixture-turn' }
  }
  let calls = 0
  f.world.bridge.send = async () => { calls += 1; throw new Error('CODEX_PROTOCOL_INVALID') }
  const input = shelf.querySelector('.chat-input input')
  input.value = 'PRESERVE_QUEUED_SEND_NOW'
  input.dispatch('input')
  shelf.querySelector('.chat-send').dispatch('click')
  await settle(4)
  shelf.querySelector('.chat-queue-now').dispatch('click')
  await settle(16)
  assert.equal(calls, 1)
  assert.match(shelf.querySelector('.chat-queue-text').textContent, /PRESERVE_QUEUED_SEND_NOW.*Delivery unconfirmed/)
  assert.match(shelf.textContent, /agent connection stopped responding correctly/)
  assert.doesNotMatch(shelf.textContent, /Nothing was started/)
  await f.emit({ type: 'turn_completed', status: 'completed', turnId: 'fixture-turn' })
  assert.equal(calls, 1, 'a late completion must not automatically repeat an unconfirmed message')
  f.world.bridge.send = async () => { calls += 1; return { turnId: 'retry-turn' } }
  const retry = shelf.querySelector('.chat-queue-now')
  assert.equal(retry.textContent, 'Retry send')
  retry.dispatch('click')
  await settle(8)
  assert.equal(calls, 2)
  assert.equal(shelf.querySelectorAll('.chat-queue-text').length, 0, 'only acknowledged delivery removes the retained row')
})

test('a Send now refusal after Page 2 unmounts preserves the paused queue row', async t => {
  const f = await mount(t, { live: true })
  const shelf = await f.openShelf()
  f.world.bridge.interrupt = async () => {
    setTimeout(() => void f.emit({ type: 'turn_completed', status: 'interrupted', turnId: 'fixture-turn' }), 0)
    return { sessionId: f.sessionId, turnId: 'fixture-turn' }
  }
  let refuse
  f.world.bridge.send = () => new Promise((resolve, reject) => { refuse = reject })
  const input = shelf.querySelector('.chat-input input')
  input.value = 'KEEP_AFTER_NAVIGATION'
  input.dispatch('input')
  shelf.querySelector('.chat-send').dispatch('click')
  await settle(3)
  shelf.querySelector('.chat-queue-now').dispatch('click')
  await settle(12)
  assert.equal(typeof refuse, 'function')
  f.view.destroy()
  refuse(new Error('CODEX_PROTOCOL_INVALID'))
  await settle(6)
  const outbox = await import('../../src/session-outbox.js')
  assert.equal(outbox.list(f.sessionId)[0]?.text, 'KEEP_AFTER_NAVIGATION')
  assert.equal(outbox.list(f.sessionId)[0]?.deliveryUnconfirmed, true)
  assert.equal(outbox.takeNext(f.sessionId), null)
})

test('a cold canonical transcript keeps the owner brief visible and the actually consumed role separately folded', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createRequire } = await import('node:module')
  const { fileURLToPath } = await import('node:url')
  const { composeNodeBrief } = await import('../../src/tree-node-brief.js')
  const require = createRequire(import.meta.url)
  const { createAgentHost } = require('../../shell/agent-host.cjs')
  const { createNodeTranscriptStore } = require('../../shell/node-transcript-store.cjs')
  const { createNodeTranscriptCapture } = require('../../shell/node-transcript-capture.cjs')
  const enginePath = fileURLToPath(new URL('./fixtures/confined-engine/src/lib/agent-engine/codex-process.js', import.meta.url))
  const directory = await mkdtemp(join(tmpdir(), 'te-page2-cold-prompt-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const ask = 'KEEP_THE_ACTUAL_OWNER_BRIEF_VISIBLE'
  const f = await mount(t, { transcripts: async ({ computerId, nodeId, sessionId }) => {
    const store = createNodeTranscriptStore({ directory })
    const capture = createNodeTranscriptCapture({ store })
    capture.bind({ computerId, nodeId, sessionId })
    const host = createAgentHost({ enginePath, defaultCwd: directory, freeMemory: () => 64 * 1024 ** 3,
      confinementPlanner: () => ({ ok: true, tier: 'guided', isolated: true, threadOptions: { sandbox: 'read-only', approvalPolicy: 'never' }, env: {}, servers: [] }) })
    host.onAcceptedPrompt(request => { void capture.recordAcceptedTranscriptSend(request) })
    host.onEvent(packet => capture.packet(packet))
    const started = await host.startSession({ sessionId, role: { id: 'qa-role', name: 'QA role', owns: 'Inspect the provided evidence.', mustNot: 'Invent a result.', handoff: 'Report the measured outcome.', rules: [], revision: 1 } })
    const text = composeNodeBrief({ message: ask, selfName: 'Builder' })
    const accepted = await host.sendTurn({ sessionId, text })
    assert.equal(accepted.transcriptPrompt.additions.find(part => part.kind === 'role').text, started.roleIntroduction)
    await capture.recordAcceptedTranscriptSend({ sessionId, text, turnId: accepted.turnId, transcriptPrompt: accepted.transcriptPrompt })
    const engine = require(enginePath).calls.at(-1)
    engine.onEvent({ type: 'assistant_text_delta', turnId: accepted.turnId, text: 'CAPTURED_PROVIDER_ANSWER' })
    engine.onEvent({ type: 'turn_completed', turnId: accepted.turnId, status: 'completed' })
    await host.closeAll()
    await capture.shutdown()
    await store.shutdown()
    const reopened = createNodeTranscriptStore({ directory })
    const saved = await reopened.read({ computerId, nodeId })
    assert.equal(saved.entries[0].text, text, 'the accepted compound input stays verbatim on disk')
    assert.equal(saved.entries.filter(entry => entry.promptKind === 'role' && entry.text === started.roleIntroduction).length, 1, 'observer plus command capture must remain idempotent')
    t.after(() => reopened.shutdown())
    return { ...reopened, bind: async () => ({ ok: true }) }
  } })
  const chat = await f.openRail()
  const owner = chat.querySelectorAll('.msg').filter(row => row.classList.contains('me'))
  assert.equal(owner.filter(row => row.textContent.includes(ask)).length, 1)
  assert.ok(owner.every(row => !row.textContent.includes('Tree address:')))
  assert.match(chat.textContent, /Role directions.*QA role/)
  assert.match(chat.textContent, /CAPTURED_PROVIDER_ANSWER/)
})


function installBoundedBridge(f) {
  const starts = [], states = new Map(), closes = []
  f.world.bridge.workStatus = async ({ sessionId }) => states.get(sessionId)
  f.world.bridge.start = async request => {
    starts.push(request)
    const work = { action: 'tree.dispatch', ...request.boundedWork, nodeId: request.roleBinding.agentId,
      agentId: request.roleBinding.agentId, sessionId: request.sessionId, startedAt: 1000, deadlineAt: 1000 + request.boundedWork.capMs }
    const record = { sequence: 17, eventHash: 'b'.repeat(64) }
    states.set(request.sessionId, { ok: true, ...work, state: 'ready', record })
    return { ok: true, sessionId: request.sessionId, boundedWork: work, record }
  }
  f.world.bridge.close = async ({ sessionId }) => { closes.push(sessionId); states.set(sessionId, { ...states.get(sessionId), state: 'closed', endRecord: { sequence: 18, eventHash: 'c'.repeat(64) } }); return { ok: true } }
  return { starts, states, closes }
}

test('normal parent start ownership precedes bounded child terminal close', async t => {
  const f = await mount(t, { live: true, bounded: true })
  f.world.storage.setItem('mc.write.dispatch', 'enabled')
  const { starts, states, closes } = installBoundedBridge(f)
  const realTimer = globalThis.setTimeout, realClear = globalThis.clearTimeout
  const due = []
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (delay === 60_000) { const token = { callback, args, cleared: false }; due.push(token); return token }
    return realTimer(callback, delay, ...args)
  }
  globalThis.clearTimeout = token => { if (due.includes(token)) token.cleared = true; else realClear(token) }
  t.after(() => { globalThis.setTimeout = realTimer; globalThis.clearTimeout = realClear })
  await f.openRail()
  f.view.el.querySelector('[data-rail-tab="details"]').dispatch('click')
  await settle(4)
  const box = f.view.el.querySelector('[data-native-work="loop"]')
  box.querySelector('[data-loop="runs"]').value = '2'
  box.querySelector('[data-loop="every"]').value = '1'
  box.querySelector('[data-work-brief]').value = 'Normal ownership lifecycle fixture'
  box.querySelector('[data-work-brief]').dispatch('input')
  box.querySelector('[data-loop="go"]').dispatch('click')
  await settle(16)
  assert.equal(starts.length, 1)
  assert.equal(starts[0].boundedWork.parentSessionId, f.sessionId)
  assert.ok(due.length >= 1)
  const first = starts[0]
  states.set(first.sessionId, { ...states.get(first.sessionId), state: 'closed', endRecord: { sequence: 18, eventHash: 'c'.repeat(64) } })
  await f.emit({ type: 'session_ended', reason: 'exited', exit: { code: 0, signal: null } }, first.sessionId)
  due.at(-1).callback()
  await settle(20)
  assert.equal(starts.length, 2, 'a normal parent-owned child close advances the bounded schedule')
  assert.deepEqual(closes, [], 'verified terminal status does not require an extra close call')
  assert.equal(starts[1].boundedWork.parentSessionId, f.sessionId)
})

test('native Launch uses a saved Worker under the selected session and keeps its signed cap receipt reachable', async t => {
  const f = await mount(t, { live: true, bounded: true })
  f.world.storage.setItem('mc.write.dispatch', 'enabled')
  const { starts, states, closes } = installBoundedBridge(f)
  await f.openRail()
  f.view.el.querySelector('[data-rail-tab="details"]').dispatch('click')
  await settle(4)
  const box = f.view.el.querySelector('[data-native-work="launch"]')
  assert.ok(box)
  assert.equal(box.querySelector('[data-launch="tier"]').querySelectorAll('option').some(option => option.value === 'local'), false)
  const brief = box.querySelector('[data-work-brief]')
  brief.value = 'NATIVE_CONTRACT_CHILD_BRIEF'
  brief.dispatch('input')
  const go = box.querySelector('[data-launch="dispatch"]')
  assert.equal(go.disabled, false, box.textContent)
  go.dispatch('click')
  go.dispatch('click')
  await settle(18)
  assert.equal(starts.length, 1, box.textContent)
  const started = starts[0]
  assert.equal(started.boundedWork.parentNodeId, f.nodeId)
  assert.equal(started.boundedWork.parentSessionId, f.sessionId)
  assert.equal(started.boundedWork.computerId, f.computerId)
  assert.equal(started.boundedWork.treeId, 'tree-1')
  assert.notEqual(started.roleBinding.agentId, f.nodeId)
  assert.equal(started.roleBinding.id, 'worker')
  assert.equal(started.delegationToken, undefined)
  const child = f.view.el.querySelectorAll('.static-tree-node').find(node => node.dataset.agentId === started.roleBinding.agentId)
  assert.equal(child.dataset.parentId, f.nodeId)
  assert.ok(box.querySelector('[data-work-roster]').textContent.includes('Started'))
  box.querySelector('[data-launch="stop"]').dispatch('click')
  await settle(8)
  assert.deepEqual(closes, [started.sessionId])
  assert.match(box.textContent, /host confirmed all started sessions closed/)
})

test('bounded Launch refuses a closed selected parent before creating a draft or calling the host', async t => {
  const f = await mount(t, { bounded: true })
  f.world.storage.setItem('mc.write.dispatch', 'enabled')
  f.world.bridge.workStatus = async () => ({ ok: false })
  let starts = 0
  f.world.bridge.start = async () => { starts++; return { ok: false } }
  await f.openRail()
  f.view.el.querySelector('[data-rail-tab="details"]').dispatch('click')
  await settle(4)
  const box = f.view.el.querySelector('[data-native-work="launch"]')
  const brief = box.querySelector('[data-work-brief]')
  brief.value = 'Do not start against an ended parent'
  brief.dispatch('input')
  const before = f.view.el.querySelectorAll('.static-tree-node').length
  assert.equal(box.querySelector('[data-launch="dispatch"]').disabled, true)
  box.querySelector('[data-launch="dispatch"]').dispatch('click')
  await settle(4)
  assert.equal(starts, 0)
  assert.equal(f.view.el.querySelectorAll('.static-tree-node').length, before)
})

test('a bounded loop continues after Page 2 unmounts and the reopened panel stops its exact next child', async t => {
  const f = await mount(t, { live: true, bounded: true })
  f.world.storage.setItem('mc.write.dispatch', 'enabled')
  const { starts, states, closes } = installBoundedBridge(f)
  const realTimer = globalThis.setTimeout, realClear = globalThis.clearTimeout
  const due = []
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (delay === 60_000) { const token = { callback, cleared: false }; due.push(token); return token }
    return realTimer(callback, delay, ...args)
  }
  globalThis.clearTimeout = token => { if (due.includes(token)) token.cleared = true; else realClear(token) }
  t.after(() => { globalThis.setTimeout = realTimer; globalThis.clearTimeout = realClear })
  await f.openRail()
  f.view.el.querySelector('[data-rail-tab="details"]').dispatch('click')
  await settle(4)
  const box = f.view.el.querySelector('[data-native-work="loop"]')
  box.querySelector('[data-loop="every"]').value = '1'
  box.querySelector('[data-loop="runs"]').value = '2'
  const brief = box.querySelector('[data-work-brief]')
  brief.value = 'Bounded fixture background work'
  brief.dispatch('input')
  box.querySelector('[data-loop="go"]').dispatch('click')
  await settle(16)
  assert.equal(starts.length, 1, box.textContent)
  assert.equal(due.length, 1)
  const first = starts[0]
  await f.emit({ type: 'assistant_text_delta', text: 'First bounded fixture reply.', turnId: 'fixture-first' }, first.sessionId)
  await f.emit({ type: 'turn_completed', status: 'completed', turnId: 'fixture-first' }, first.sessionId)
  f.view.destroy()
  assert.equal(due[0].cleared, false, 'navigation must not cancel an authorized schedule')
  due[0].callback()
  await settle(20)
  assert.equal(starts.length, 2, 'the next saved child must start while the view is absent')
  assert.deepEqual(closes, [first.sessionId], 'the host must close the prior idle session before the next starts')
  const second = starts[1]
  assert.equal(second.boundedWork.parentNodeId, f.nodeId)
  assert.equal(second.boundedWork.parentSessionId, f.sessionId)
  await f.emit({ type: 'assistant_text_delta', text: 'Second bounded background reply.', turnId: 'fixture-second' }, second.sessionId)
  await f.emit({ type: 'turn_completed', status: 'completed', turnId: 'fixture-second' }, second.sessionId)
  const reopened = await mountView(f.world, { computerId: f.computerId })
  f.cleanup(() => reopened.destroy())
  const parent = reopened.el.querySelectorAll('.static-tree-node').find(node => node.dataset.agentId === f.nodeId)
  parent.dispatch('keydown', { key: 'Enter', shiftKey: true })
  await settle(4)
  reopened.el.querySelector('[data-rail-tab="details"]').dispatch('click')
  await settle(4)
  const recovered = reopened.el.querySelector('[data-native-work="loop"]')
  assert.equal(recovered.querySelector('[data-loop="stop"]').disabled, false)
  assert.match(recovered.textContent, /2 runs started/)
  const lastRow = recovered.querySelectorAll('[data-work-session]').at(-1)
  assert.equal(lastRow.getAttribute('data-work-session'), second.sessionId)
  assert.equal(lastRow.getAttribute('data-phase'), 'started', 'the final child remains active after its START receipt')
  recovered.querySelector('[data-loop="stop"]').dispatch('click')
  await settle(12)
  assert.deepEqual(closes, [first.sessionId, second.sessionId])
  assert.match(recovered.textContent, /host confirmed all started sessions closed/)
})

test('a bounded loop does not spend a selected run on an active previous child', async t => {
  const f = await mount(t, { live: true, bounded: true })
  f.world.storage.setItem('mc.write.dispatch', 'enabled')
  const { starts, states, closes } = installBoundedBridge(f)
  const realTimer = globalThis.setTimeout, realClear = globalThis.clearTimeout
  const due = []
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (delay === 60_000) { const token = { callback, args, cleared: false }; due.push(token); return token }
    return realTimer(callback, delay, ...args)
  }
  globalThis.clearTimeout = token => { if (due.includes(token)) token.cleared = true; else realClear(token) }
  t.after(() => { globalThis.setTimeout = realTimer; globalThis.clearTimeout = realClear })
  await f.openRail()
  f.view.el.querySelector('[data-rail-tab="details"]').dispatch('click')
  await settle(4)
  const box = f.view.el.querySelector('[data-native-work="loop"]')
  box.querySelector('[data-loop="every"]').value = '1'
  box.querySelector('[data-loop="runs"]').value = '3'
  const brief = box.querySelector('[data-work-brief]')
  brief.value = 'Bounded active-child collision fixture'
  brief.dispatch('input')
  box.querySelector('[data-loop="go"]').dispatch('click')
  await settle(16)
  assert.equal(starts.length, 1, box.textContent)
  assert.equal(box.querySelectorAll('[data-work-session]').at(-1).getAttribute('data-phase'), 'started')
  const first = starts[0]
  states.set(first.sessionId, { ...states.get(first.sessionId), state: 'active' })

  // A scheduled tick observes the previous child still active. It must retain
  // the selected budget rather than consuming run 2.
  due.at(-1).callback()
  await settle(16)
  assert.equal(starts.length, 1, 'an active previous child cannot consume a selected run')
  assert.match(box.textContent, /previous run is still active/)
  assert.equal(box.querySelector('[data-loop="stop"]').disabled, false, 'the loop remains stoppable while the one started child is active')

  // Once the first child closes, the controller may advance to run 2, then 3.
  states.set(first.sessionId, { ...states.get(first.sessionId), state: 'closed', endRecord: { sequence: 18, eventHash: 'c'.repeat(64) } })
  due.filter(token => !token.cleared).at(-1).callback()
  await settle(18)
  assert.equal(starts.length, 2)
  const second = starts[1]
  states.set(second.sessionId, { ...states.get(second.sessionId), state: 'closed', endRecord: { sequence: 18, eventHash: 'c'.repeat(64) } })
  due.filter(token => !token.cleared).at(-1).callback()
  await settle(18)
  assert.equal(starts.length, 3)
  assert.match(box.textContent, /3 runs started/)
  assert.doesNotMatch(box.textContent, /4 runs started/)
  for (const token of due.filter(token => !token.cleared)) token.callback()
  await settle(10)
  assert.equal(starts.length, 3, 'a stale scheduled callback cannot create a fourth start')

  // The final child remains active after its START receipt; Stop closes it and
  // cannot create a late fourth dispatch.
  const third = starts[2]
  assert.equal(box.querySelectorAll('[data-work-session]').at(-1).getAttribute('data-phase'), 'started')
  box.querySelector('[data-loop="stop"]').dispatch('click')
  await settle(16)
  assert.equal(states.get(first.sessionId).state, 'closed')
  assert.equal(states.get(second.sessionId).state, 'closed')
  assert.deepEqual(closes, [third.sessionId], 'Stop closes the final still-open child; prior children were already closed')
  assert.equal(starts.length, 3, 'Stop prevents a late dispatch')
  assert.match(box.textContent, /host confirmed all started sessions closed/)
})

test('native Team creates the lead and same-tier member on their actual saved parent chain', async t => {
  const f = await mount(t, { live: true, bounded: true })
  f.world.storage.setItem('mc.write.dispatch', 'enabled')
  const { starts, closes } = installBoundedBridge(f)
  await f.openRail()
  f.view.el.querySelector('[data-rail-tab="details"]').dispatch('click')
  await settle(4)
  const box = f.view.el.querySelector('[data-native-work="team"]')
  box.querySelector('[data-team="lead"]').value = 'astra'
  box.querySelector('[data-work-effort]').value = 'max'
  const member = box.querySelector('[data-team-member="astra"]')
  member.checked = true
  member.dispatch('change')
  const brief = box.querySelector('[data-work-brief]')
  brief.value = 'Same provider, separate saved Worker identities.'
  brief.dispatch('input')
  box.querySelector('[data-team="go"]').dispatch('click')
  await settle(20)
  assert.equal(starts.length, 2, box.textContent)
  const [lead, child] = starts
  assert.equal(lead.boundedWork.parentNodeId, f.nodeId)
  assert.equal(lead.boundedWork.parentSessionId, f.sessionId)
  assert.equal(child.boundedWork.parentNodeId, lead.roleBinding.agentId)
  assert.equal(child.boundedWork.parentSessionId, lead.sessionId)
  assert.equal(lead.effort, 'max')
  assert.equal(child.effort, 'max')
  assert.notEqual(lead.roleBinding.agentId, child.roleBinding.agentId)
  for (const request of starts) {
    const node = f.view.el.querySelectorAll('.static-tree-node').find(node => node.dataset.agentId === request.roleBinding.agentId)
    assert.equal(node.dataset.parentId, request.boundedWork.parentNodeId)
    assert.equal(request.boundedWork.computerId, f.computerId)
    assert.equal(request.boundedWork.treeId, 'tree-1')
  }
  box.querySelector('[data-team="stop"]').dispatch('click')
  await settle(12)
  assert.deepEqual(closes, [child.sessionId, lead.sessionId])
  assert.match(box.textContent, /host confirmed all started sessions closed/)
})
