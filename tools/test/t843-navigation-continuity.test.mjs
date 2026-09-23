import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import test from 'node:test'
import { fleetTreesStorageKey } from '../../src/fleet-trees.js'

register('./helpers/css-stub-loader.mjs', import.meta.url)
const { installWorld, fleetFetch, seedTreeNode, mountView, settle } = await import('./lib/tree-command-real-mount.mjs')
const { DATA_SOURCE_EVENT } = await import('../../src/data-source.js')
const { WRITE_FLAGS_EVENT } = await import('../../src/write-flags.js')

const main = readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8')
const start = main.indexOf('window.addEventListener(DATA_SOURCE_EVENT, event => {')
const end = main.indexOf('\nconst hashFor', start)
assert.ok(start >= 0 && end > start, 'the current router listener must be available')
const listener = main.slice(start, end)

// Real computersView, graph activation, chat and coordinator. DOM, storage
// and provider IPC are stand-ins. This proves mounted behavior, not visible
// browser navigation, physical scrolling or real-provider acceptance.
test('mounted navigation keeps streaming chat intent through host/gap refresh and an off-page completion', async t => {
  const computerId = 'navigation-continuity-computer'
  const nodeId = 'navigation-continuity-node'
  const sessionId = 'navigation-continuity-session'
  const world = await installWorld(fleetFetch({ computerId }), { asyncFrames: true })
  const prototype = Object.getPrototypeOf(document.body)
  const additions = []
  for (const [key, value] of Object.entries({
    showPopover() { this.hidden = false },
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end },
  })) {
    if (typeof prototype[key] !== 'function') { prototype[key] = value; additions.push(key) }
  }
  const computedStyle = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle')
  globalThis.getComputedStyle = element => window.getComputedStyle(element)
  const subscribers = new Set(), models = [], actions = []
  world.bridge.onEvent = fn => { subscribers.add(fn); return () => subscribers.delete(fn) }
  world.bridge.models = async ({ sessionId }) => {
    models.push(sessionId)
    return { provider: 'codex', catalogSupported: true, models: [] }
  }
  world.bridge.sessionActivity = async () => ({ ok: true, busy: true, closing: false, lastTurnStatus: null, turnsCompleted: 0 })
  for (const name of ['start', 'send', 'close', 'interrupt']) world.bridge[name] = async () => {
    actions.push(name)
    throw new Error(`Navigation must not invoke ${name}`)
  }
  world.storage.setItem('mc.write.agent-session', 'enabled')
  world.storage.setItem('mc.set.tree_style', 'boxes')
  seedTreeNode(world.storage, { computerId, nodeId, sessionId, status: 'running' })
  let view
  const mounted = new Set(), pending = []
  const mount = async () => { view = await mountView(world, { computerId }); mounted.add(view); return view }
  const dispose = old => { old.destroy(); old.el.remove(); mounted.delete(old) }
  t.after(async () => {
    await Promise.all(pending)
    for (const current of mounted) dispose(current)
    world.restore()
    for (const key of additions) delete prototype[key]
    if (computedStyle) Object.defineProperty(globalThis, 'getComputedStyle', computedStyle)
    else delete globalThis.getComputedStyle
  })
  await mount()
  const router = { route: { name: 'computers' }, view }
  const render = () => {
    dispose(view)
    pending.push(mount().then(current => { router.view = current }))
  }
  Function('window', 'DATA_SOURCE_EVENT', 'WRITE_FLAGS_EVENT', 'syncPhoneExampleNotice',
    'isExampleMode', 'currentDataSource', 'resetPersistentVoice', 'accessibilityControls',
    'resetCartChanges', 'current', 'render', listener)(window, DATA_SOURCE_EVENT, WRITE_FLAGS_EVENT,
    () => {}, () => false, () => 'local', () => {}, {}, () => {}, router, render)
  const open = async () => {
    const node = [...view.el.querySelectorAll('.static-tree-node')].find(item => item.dataset.agentId === nodeId)
    assert.ok(node, 'the mounted graph must expose the saved node')
    node.dispatch('dblclick'); await settle(8)
    const panel = [...view.el.querySelectorAll('.tree-conversation')].find(item => item.dataset.agentId === nodeId)
    assert.ok(panel, 'a real node activation must open its chat')
    return panel.querySelector('.chat')
  }
  const emit = async event => {
    for (const fn of [...subscribers]) await fn({ sessionId, event })
    await settle(12)
  }
  const chat = await open(), input = chat.querySelector('.chat-input input'), log = chat.querySelector('.chat-log')
  const draftText = '  Navigation keeps these unsent words.  '
  input.value = draftText
  input.setSelectionRange(3, 14); input.dispatch('input')
  const draft = chat.exportDraft()
  await emit({ type: 'assistant_text_delta', turnId: 'continuity-turn', text: 'Before leaving. ' })
  assert.match(log.textContent, /Before leaving\./)
  const probesBefore = models.length, listenersBefore = subscribers.size
  assert.ok(probesBefore > 0, 'the native saved session must actually have been verified')
  for (const why of ['host', 'agent-events-gap']) {
    log.scrollTop = 137
    window.dispatchEvent(new CustomEvent(DATA_SOURCE_EVENT, { detail: { why } }))
    await settle(); await Promise.all(pending)
    assert.equal(view.el.querySelector('.tree-conversation .chat') === chat, true, `${why} preserves the selected open conversation`)
    assert.deepEqual(chat.exportDraft(), draft, `${why} preserves draft text and input selection`)
    assert.equal(input.value, draftText, `${why} preserves the input text`)
    assert.equal(input.selectionStart, 3, `${why} preserves the input selection start`)
    assert.equal(input.selectionEnd, 14, `${why} preserves the input selection end`)
    assert.equal(log.scrollTop, 137, `${why} preserves the existing log scroll position`)
    assert.equal(models.length, probesBefore, `${why} must not re-probe the unchanged session`)
    assert.equal(subscribers.size, listenersBefore, `${why} must not duplicate stream listeners`)
    await emit({ type: 'assistant_text_delta', turnId: 'continuity-turn', text: `${why} continued. ` })
    assert.match(log.textContent, new RegExp(`${why} continued\\.`), 'the same chat still receives incoming text')
  }
  dispose(view)
  await emit({ type: 'assistant_text_delta', turnId: 'continuity-turn', text: 'Completed while away.' })
  await emit({ type: 'turn_completed', turnId: 'continuity-turn', status: 'completed' })
  const saved = JSON.parse(world.storage.getItem(fleetTreesStorageKey(computerId))).nodes.find(node => node.id === nodeId)
  assert.equal(saved.status, 'finished', 'off-page completion settles the real saved node')
  const expected = 'Before leaving. host continued. agent-events-gap continued. Completed while away.'
  assert.equal(saved.reply, expected, 'off-page completion retains all text from the original turn')
  await mount()
  const reopened = await open()
  assert.deepEqual(reopened.exportDraft(), draft, 'reopening the same node retains unsent intent')
  const reopenedInput = reopened.querySelector('.chat-input input')
  assert.equal(reopenedInput.value, draftText, 'reopening retains the input text')
  assert.equal(reopenedInput.selectionStart, 3, 'reopening retains the input selection start')
  assert.equal(reopenedInput.selectionEnd, 14, 'reopening retains the input selection end')
  const replies = [...reopened.querySelectorAll('.them .chat-msg-text')].map(row => row.textContent)
  assert.deepEqual(replies, [expected], 'the completed turn returns as exactly one full reply with no partial bubble')
  assert.equal(models.length, probesBefore, 'a window-owned session does not need a new reconnect probe')
  assert.equal(subscribers.size, listenersBefore, 'reopening keeps the original stream listener count')
  assert.deepEqual(actions, [], 'navigation never starts, sends, closes or interrupts provider work')
})
