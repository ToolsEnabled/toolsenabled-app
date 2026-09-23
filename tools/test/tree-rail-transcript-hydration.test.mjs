import assert from 'node:assert/strict'
import test from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { createHydrationView, nodeA, nodeB, savedA, savedB } from './helpers/tree-rail-hydration-harness.mjs'

const dom = installDomStandIn()
const { buildChat } = await import('../../src/components.js')
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const inputOf = root => root.querySelector('.chat-input input')
const words = root => root.querySelectorAll('.chat-log .chat-msg-text').map(row => row.textContent)
const views = new Set()
function fixture() { const view = createHydrationView(buildChat); views.add(view); return view }
test.afterEach(() => { for (const view of views) view.destroy(); views.clear(); document.activeElement = null })
test.after(() => dom.restore())

test('delayed hydration replaces the first-question/latest-reply fallback with saved history without a reselect', async () => {
  const view = fixture()
  const first = view.mount()
  assert.deepEqual(words(first), [nodeA.message, nodeA.reply])
  view.host.querySelector('.chat-head .saved-conversation-toggle').click(); await tick()
  assert.deepEqual(view.host.querySelectorAll('.saved-messages .chat-msg-text').map(row => row.textContent), savedA.map(row => row.text), 'Browse saved conversation already reads the complete record')
  view.gate.resolve(); await view.client.ready
  assert.deepEqual(words(view.rail().root), savedA.map(row => row.text), 'the open rail must catch up without selecting its node again')
  assert.deepEqual(view.refreshes, [nodeA.id], 'one readiness event produces one refresh')
  assert.deepEqual(view.writes, [], 'display hydration never writes a projected transcript back')
  assert.equal(view.context.sessionTranscripts.size, 0, 'a read never seeds the write-side session map')
  assert.equal(view.unchangedRecords(), true)
})

test('a ready client mounts its complete history directly and does not loop through another refresh', async () => {
  const view = fixture()
  view.gate.resolve(); await view.client.ready
  assert.deepEqual(words(view.mount()), savedA.map(row => row.text))
  await tick()
  assert.deepEqual(view.refreshes, [])
  assert.equal(view.unchangedRecords(), true)
})

test('hydration waits for typing to finish and preserves the latest draft, selection and attachment handoff', async () => {
  const view = fixture()
  const first = view.mount()
  first.importDraft({ text: 'Before load', attachments: [{ path: 'C:/Users/ToolsEnabled-Dev/fixture-only/kept.png' }], start: 2, end: 5 })
  const input = inputOf(first); input.focus()
  view.gate.resolve(); await view.client.ready
  assert.equal(view.rail().root, first, 'loading must not tear a composer out from under typing')
  input.value = 'Newer typing after load'
  input.setSelectionRange(4, 12)
  const expected = first.exportDraft()
  document.activeElement = null; input.dispatch('blur')
  assert.deepEqual(view.rail().root.exportDraft(), expected)
  assert.deepEqual(words(view.rail().root), savedA.map(row => row.text))
  assert.deepEqual(view.refreshes, [nodeA.id])
})

test('a deferred completion cannot rebuild a different selected node', async () => {
  const view = fixture()
  const first = view.mount()
  const input = inputOf(first); input.focus()
  view.gate.resolve(); await view.client.ready
  const other = view.mount(nodeB.id)
  inputOf(other).value = 'Only B draft'
  document.activeElement = null; input.dispatch('blur')
  assert.equal(view.rail().root, other)
  assert.deepEqual(words(other), savedB.map(row => row.text))
  assert.equal(inputOf(other).value, 'Only B draft')
  assert.deepEqual(view.refreshes, [])
})

test('a client that finishes after view disposal cannot refresh its former rail', async () => {
  const view = fixture()
  view.mount()
  view.destroy()
  view.gate.resolve(); await view.client.ready
  assert.deepEqual(view.refreshes, [])
  assert.equal(view.rail(), null)
  assert.equal(view.unchangedRecords(), true)
})

test('a deferred refresh refuses disposed, replaced, disconnected and changed-session rails', async () => {
  const mutations = {
    disposed: view => { view.context.destroyed = true },
    'replaced tree store': view => { view.context.treeStore = { ...view.context.treeStore } },
    'replaced transcript client': view => { view.context.transcriptStore = { get: () => null } },
    'changed session': view => { view.nodes.set(nodeA.id, { ...nodeA, sessionId: 'replacement-session' }) },
    'changed selected node': view => { view.context.currentRailTreeNode = nodeB },
    'disconnected root': view => { view.rail().root.remove() },
    'inactive rail': view => { view.controlsPage.classList.remove('is-active') },
  }
  for (const [name, change] of Object.entries(mutations)) {
    const view = fixture()
    const first = view.mount()
    const input = inputOf(first); input.focus()
    view.gate.resolve(); await view.client.ready
    change(view)
    document.activeElement = null; input.dispatch('blur')
    assert.deepEqual(view.refreshes, [], name)
    assert.equal(view.unchangedRecords(), true, name)
    view.destroy()
  }
})

test('an old client completing after replacement cannot refresh the new store rail', async () => {
  const view = fixture()
  const first = view.mount()
  view.context.transcriptStore = { get: () => null }
  view.gate.resolve(); await view.client.ready
  assert.equal(view.rail().root, first)
  assert.deepEqual(view.refreshes, [])
})

test('hydration does not tear down an active stream or overwrite newer live session history', async () => {
  for (const active of ['stream', 'session history']) {
    const view = fixture()
    const first = view.mount()
    inputOf(first).value = 'Current draft'
    let closed = 0
    if (active === 'stream') view.rail().stream = { close: () => { closed++ } }
    else view.context.sessionTranscripts.set(nodeA.sessionId, [{ who: 'you', text: 'Newer live message' }])
    view.gate.resolve(); await view.client.ready
    assert.equal(view.rail().root, first, active)
    assert.equal(inputOf(first).value, 'Current draft', active)
    assert.equal(closed, 0, active)
    assert.deepEqual(view.refreshes, [], active)
    view.destroy()
  }
})

test('failed hydration reports its existing warning and preserves the current rail and saved history', async () => {
  const view = fixture()
  const first = view.mount()
  inputOf(first).value = 'Keep through read failure'
  view.gate.reject(new Error('Fixture history read refused'))
  await assert.rejects(view.client.ready, /Fixture history read refused/)
  await tick()
  assert.equal(view.rail().root, first)
  assert.equal(inputOf(first).value, 'Keep through read failure')
  assert.deepEqual(view.refreshes, [])
  assert.ok(view.warnings.some(([message]) => message.includes('Fixture history read refused')))
  assert.deepEqual(view.writes, [])
  assert.equal(view.unchangedRecords(), true)
})

/* T1404. A saved conversation longer than the chat's newest page: measured on
   the rig 2026-09-22, a 150-message conversation reopened at message 91 with
   nothing above it, no sign that 90 more were kept, and Search for an early
   line found nothing and said nothing. */
test('a conversation longer than the chat says where its older messages are, keeps saying it through Search, and opens them', async () => {
  const { TRANSCRIPT_OLDER_NOTE, TRANSCRIPT_OLDER_DOOR } = await import('../../src/fleet-tree-copy.js')
  const early = [{ id: 'a-early-1', who: 'you', text: 'Line 7: an early question', at: 0 }]
  const view = createHydrationView(buildChat, { older: early }); views.add(view)
  view.gate.resolve(); await view.client.ready
  const chat = view.mount()
  const rows = chat.querySelector('.chat-log').children
  assert.match(rows[0].textContent, /Older messages are not shown or searched here/, 'the top of the chat admits the older messages')
  assert.equal(rows[0].querySelector('.chat-msg-text')?.textContent ?? rows[0].textContent.replace(TRANSCRIPT_OLDER_DOOR, '').trim(), TRANSCRIPT_OLDER_NOTE)
  assert.deepEqual(words(chat).filter(text => text !== TRANSCRIPT_OLDER_NOTE), savedA.map(row => row.text), 'the newest page is shown whole, under the line')
  /* Search hides what it did not match and keeps the line that says what it did not look at. */
  chat.querySelector('.chat-search-toggle').click()
  const search = chat.querySelector('.chat-search input')
  search.value = 'Line 7:'
  search.dispatch('input')
  const shown = chat.querySelector('.chat-log').children.filter(row => !row.hidden)
  assert.equal(shown.length, 1, 'only the line about older messages stays in view')
  assert.match(shown[0].textContent, /not shown or searched here/)
  /* The line carries the door, and the door opens the saved conversation, whose earlier page holds the line. */
  const door = rows[0].querySelector('button.chat-older-door')
  assert.ok(door, 'the line offers the way to the older messages')
  assert.equal(door.textContent, TRANSCRIPT_OLDER_DOOR)
  door.click(); await tick(); await tick()
  const panel = view.host.querySelector('[data-saved-conversation]')
  assert.equal(panel.hidden, false, 'the door opens Saved conversation')
  door.click(); await tick()
  assert.equal(panel.hidden, false, 'pressing the door again does not close what it opened')
  const earlier = panel.querySelectorAll('button').find(button => button.textContent === 'Earlier messages')
  assert.equal(earlier.disabled, false, 'Saved conversation can page back')
  earlier.click(); await tick(); await tick()
  assert.deepEqual(panel.querySelectorAll('.saved-messages .chat-msg-text').map(row => row.textContent), ['Line 7: an early question'])
  assert.deepEqual(view.writes, [], 'reading older messages writes nothing')
})

test('a conversation the chat holds whole carries no line about older messages', async () => {
  const view = fixture()
  view.gate.resolve(); await view.client.ready
  const chat = view.mount()
  assert.deepEqual(words(chat), savedA.map(row => row.text))
  assert.equal(chat.querySelector('.chat-older-door'), null)
})

/* T1495. A turn that ended without a completion (the app quit, crashed, or the
   computer powered off) leaves its last call saved as 'working' and its approval
   as 'waiting'. Measured on the rig 2026-09-22: reopened under "this session is no
   longer open", the rail spun the call as still running and showed "waiting for
   you" on an approval nothing could answer, for ever. */
const unfinished = [
  { id: 'u1', who: 'you', text: 'Install and test.', at: 1 },
  { id: 'u2', who: 'action', kind: 'call', tool: 'Shell', text: 'Run npm test', state: 'working', at: 2 },
  { id: 'u3', who: 'action', kind: 'approval', tool: 'Shell', text: 'Allow running npm install?', state: 'waiting', at: 3 },
  { id: 'u4', who: 'action', kind: 'call', tool: 'Shell', text: 'Run npm ci', state: 'done', at: 4 },
]
const actionStates = root => root.querySelectorAll('.chat-log [data-action-state]')
  .filter(row => !row.classList?.contains?.('chat-action-run')).map(row => row.dataset.actionState)

test('a session that is no longer open replays its unfinished call and approval as settled, not running or waiting', async () => {
  const view = createHydrationView(buildChat, { saved: unfinished, realActions: true }); views.add(view)
  view.gate.resolve(); await view.client.ready
  const chat = view.mount()
  const states = actionStates(chat)
  assert.ok(states.length >= 3, 'the saved actions are drawn')
  assert.ok(!states.includes('working'), 'a call from a session that is gone is not drawn as still running: ' + states)
  assert.ok(!states.includes('waiting'), 'an approval from a session that is gone is not drawn as waiting: ' + states)
  const text = chat.querySelector('.chat-log').textContent
  assert.doesNotMatch(text, /waiting for you/)
  assert.match(text, /no result came back/)
  assert.match(text, /no longer waiting/)
  assert.ok(states.includes('done'), 'a finished call keeps its own state')
  assert.deepEqual(view.writes, [], 'the replay rewrites nothing on disk')
})

test('a session that is still open replays its saved rows as they were saved', async () => {
  const view = createHydrationView(buildChat, { saved: unfinished, realActions: true }); views.add(view)
  view.context.nodeSessionLive = () => true
  view.gate.resolve(); await view.client.ready
  const states = actionStates(view.mount())
  assert.ok(states.includes('working'), 'a live call still reads as running')
  assert.ok(states.includes('waiting'), 'a live approval still reads as waiting')
})
