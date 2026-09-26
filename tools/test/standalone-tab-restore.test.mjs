/* B4 (1.0.48). The rule is that New agent tabs come back after
 * ToolsEnabled is closed and reopened. They used to vanish: the only record of an open
 * tab was a WeakMap keyed by the page's document, which a restart empties.
 *
 * Every other suite "remounts" on the SAME document, which never exercised a
 * restart. machine() below keeps what survives a restart -- settings storage,
 * saved conversations, the organisation's seats, the host -- and launch() puts a
 * NEW document over it, which is what a relaunch is. launch({ reload: true }) is
 * a page reload: a new document while the host's sessions keep running.
 *
 * Two cases mount the real Computers page, because what they prove lives there:
 * the context ToolsEnabled added to a conversation is folded rather than shown
 * as the person's words, and the page's own reload check closes a session the
 * old page left running. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { TreeWorkspace, heldStandaloneSeatIds } from '../../src/tree-workspace.js'
import { StaticTreeGraph } from '../../src/tree-graph.js'
import { createStandaloneTabLedger, STANDALONE_TABS_PREFIX } from '../../src/standalone-tab-ledger.js'
import { defaultStandaloneStart, standaloneStartChoices } from '../../src/tree-standalone-agent.js'
import * as fleetCopy from '../../src/fleet-tree-copy.js'
const { TRANSCRIPT_OLDER_NOTE } = fleetCopy
import { fleetTreesStorageKey } from '../../src/fleet-trees.js'
import { list as outboxList } from '../../src/session-outbox.js'
import { mountComputers, settle as settleMounted, COMPUTER_ID } from './helpers/t1308-computers-fixture.mjs'
register('./helpers/css-stub-loader.mjs', import.meta.url)

const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const COMPUTER = 'restore-computer'
const LIST_KEY = STANDALONE_TABS_PREFIX + COMPUTER
const STILL_RUNNING = 'Agent 1 was not reopened because it is still running from before the reload. Restart ToolsEnabled to reopen it.'
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

function machine(t) {
  const values = new Map([['mc.write.agent-session', 'enabled']])
  const storage = {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => { values.set(key, String(value)) },
    removeItem: key => { values.delete(key) },
    key: index => [...values.keys()][index] ?? null,
    get length() { return values.size },
  }
  const priorStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  globalThis.localStorage = storage
  const saved = new Map(), reads = [], declared = [], released = [], bindings = [], calls = []
  const listeners = new Set(), hostSessions = new Set(), turns = new Map()
  const behaviour = { refuseSeat: new Set(), send: null, closeRefused: false, beforeStaleClose: null, beforeStart: null,
    // What the page answers about a restart: a list of tabs kept, the delete-on-exit setting, a reload.
    keepsTabs: true, tabsComeBack: true, reloaded: false }
  const owner = { version: 1, ownerId: 'restore-fixture-owner', currentEpoch: 'restore-epoch', kind: 'local' }
  const bridge = {
    availability: async () => ({ ok: true }),
    confinement: async () => ({ ok: true, tier: 'standard' }),
    onEvent: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    ownerContext: async () => owner,
    onOwnerContextChanged: () => () => {},
    start: async value => { calls.push(['start', value]); await behaviour.beforeStart?.(value); hostSessions.add(value.sessionId); return { sessionId: value.sessionId } },
    send: async value => {
      calls.push(['send', value])
      const answer = behaviour.send?.(value)
      if (answer) return answer
      const count = (turns.get(value.sessionId) || 0) + 1
      turns.set(value.sessionId, count)
      return { turnId: `${value.sessionId}:turn-${count}` }
    },
    interrupt: async value => { calls.push(['interrupt', value]); return { ok: true } },
    close: async value => { calls.push(['close', value]); hostSessions.delete(value.sessionId); return { closed: true } },
  }
  const emit = (sessionId, event) => { for (const listener of [...listeners]) listener({ sessionId, event }) }
  const cleanups = []
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) { try { await cleanup() } catch { /* keep tearing down */ } }
    await settle()
    if (priorStorage) Object.defineProperty(globalThis, 'localStorage', priorStorage); else delete globalThis.localStorage
  })
  const spoken = line => line && (line.who === 'you' || line.who === 'agent') && line.promptSource !== 'toolsenabled'
  function mountOn(document) {
    const zoomHost = document.createElement('div'); document.body.appendChild(zoomHost)
    const cache = new Map()
    const agent = {
      live: true, bridge, computerId: COMPUTER, persistenceKey: COMPUTER,
      tabs: behaviour.keepsTabs ? createStandaloneTabLedger({ storage, computerId: COMPUTER }) : null,
      tabsComeBack: async () => behaviour.tabsComeBack,
      pageReloaded: () => behaviour.reloaded,
      transcript: {
        bind: async (sessionId, seatId) => { bindings.push({ sessionId, seatId }); return { ok: true } },
        release: async () => ({ ok: true, released: true }),
        readLatest: async id => {
          reads.push(id)
          const value = saved.get(id)
          const record = typeof value === 'function' ? await value() : value
          if (record instanceof Error) throw record
          if (record) cache.set(id, record)
          return record ?? null
        },
      },
      declareSeat: async ({ id, name, tier }) => {
        declared.push({ id, name, tier })
        if (behaviour.refuseSeat.has(id)) return { ok: false, code: 'MC_TREE_IDENTITY_UNAVAILABLE', reason: 'no seat here' }
        return { id, name, role: 'worker', tier, parentId: null, sessionId: null, message: '', reply: '', statusNote: '' }
      },
      releaseSeat: async ({ id }) => { released.push(id); return true },
      roleBindingFor: async seat => ({ ok: true, binding: { agentId: seat.id, id: 'worker', expectedOrgRevision: 1, expectedRoleRevision: 1 } }),
      // Stand-ins for the page's own builders (the real ones are proved against the real page below).
      chatConfigFor: seat => ({ seed: 0, history: (cache.get(seat.id)?.lines || []).filter(spoken),
        actions: () => [{ id: 'stop', group: 'Agent', label: 'Stop agent', enabled: false, disabledHint: 'This agent is not running right now.', run: () => {} }] }),
      displayHistory: id => (cache.get(id)?.lines || []).filter(spoken),
      closeStaleSession: async sessionId => {
        calls.push(['stale', sessionId])
        await null
        if (!hostSessions.has(sessionId)) return { running: false }
        behaviour.beforeStaleClose?.()
        if (behaviour.closeRefused) return { ok: false }
        await bridge.close({ sessionId })
        return { closed: true }
      },
    }
    const graph = { computer: { id: COMPUTER }, zoomHost, nodes: new Map(), chatDrafts: new Map(), standaloneAgent: agent,
      _bindStandaloneDrop: StaticTreeGraph.prototype._bindStandaloneDrop,
      setWide() {}, _renderChatChoices() {}, resize() {}, _applyZoom() {}, _agentFor() {} }
    graph.workspace = new TreeWorkspace(graph)
    const workspace = graph.workspace
    cleanups.push(() => {
      for (const record of [...workspace.standalone.values()]) workspace.close(record, { focus: false })
      workspace.destroy()
    })
    return { document, graph, workspace, records: () => [...workspace.standalone.values()],
      again: () => { workspace.destroy(); return mountOn(document) } }
  }
  return {
    values, saved, reads, declared, released, bindings, calls, behaviour, hostSessions, emit,
    list: () => JSON.parse(values.get(LIST_KEY) || '{"v":1,"tabs":[]}').tabs,
    /* A quit ends every host session; a reload does not. Either way the page
       gets a new document, so nothing kept in the old one survives. */
    launch({ reload = false } = {}) {
      if (!reload) hostSessions.clear()
      behaviour.reloaded = reload
      const dom = installDomStandIn()
      cleanups.push(() => dom.restore())
      return mountOn(dom.document)
    },
  }
}

const panelOf = record => ({
  input: () => record.chatPanel.querySelector('.chat-input textarea'),
  chat: () => record.chatPanel.querySelector('[data-chat-panel]'),
})
async function send(record, text) {
  const panel = panelOf(record)
  panel.input().value = text
  panel.input().dispatch('input')
  panel.chat().querySelector('.chat-send').click()
  await settle()
}
const startsSince = (m, mark) => m.calls.slice(mark).filter(([kind]) => kind === 'start').map(([, value]) => value)
const chip = record => record.chatPanel.querySelector('[data-chat-chip="tier"]')?.textContent || ''
const chatText = record => panelOf(record).chat()?.textContent || ''
const conversation = (...words) => ({ lines: words.map(([who, text], index) => ({ id: `${who}:old:${index}`, who, text, at: index + 1 })), before: null, recoveryDirectory: null })
const placeOnTree = nodeId => async ({ record }) => {
  assert.equal(record.session.beginPlacement().ok, true)
  record.session.commitPlacement({ nodeId, getStartOptions: () => ({ surface: 'fleet-tree' }), onSessionChange() {} })
  return { ok: true, nodeId, sentence: 'Agent added as its own tree.' }
}
async function stopFromActions(record) {
  const chat = panelOf(record).chat()
  chat.openActions()
  const row = chat.querySelectorAll('.chat-actions-row').find(button => /Stop agent/.test(button.textContent))
  assert.equal(Boolean(row), true, 'the Stop row is in the Actions menu')
  row.dispatch('click')
  await settle()
}

test('tabs open at quit come back in order, with their names and programs, and nothing starts (B4)', async t => {
  const m = machine(t)
  const first = m.launch()
  await first.workspace.openStandalone({ tier: 'claude-sonnet', effort: 'high' }); await settle()
  await first.workspace.openStandalone({ tier: 'luna', effort: 'low' }); await settle()
  await first.workspace.openStandalone(); await settle()
  await first.workspace.openStandalone(); await settle()
  const [a, b, closed, placed] = first.records()
  first.workspace.close(closed, { focus: false }); await settle()
  first.graph.onPlaceStandalone = placeOnTree('placed-node')
  assert.equal((await first.workspace.placeStandalone(placed, null)).ok, true)
  await settle()
  const mark = m.calls.length, declaredBefore = m.declared.length

  const second = m.launch()
  await settle()
  assert.deepEqual(second.records().map(record => [record.id, record.agent.name]), [[a.id, 'Agent 1'], [b.id, 'Agent 2']],
    'the open tabs did not come back, came back in another order, or a closed or placed tab came back too')
  assert.deepEqual(second.graph.chatTabs.querySelectorAll('.tree-chat-tab-wrap').map(tab => tab.dataset.agentId), [a.id, b.id])
  const [ra, rb] = second.records()
  assert.match(chip(ra), /Sonnet/); assert.match(chip(ra), /high/)
  assert.match(chip(rb), /Luna/); assert.match(chip(rb), /low/)
  assert.deepEqual(m.declared.slice(declaredBefore), [{ id: a.id, name: 'Agent 1', tier: 'claude-sonnet' }, { id: b.id, name: 'Agent 2', tier: 'luna' }])
  assert.deepEqual(m.calls.slice(mark).filter(([kind]) => kind === 'start' || kind === 'send'), [], 'reopening a tab started or sent something')
  assert.equal(second.workspace.mode, 'trees', 'reopening changed what the person is looking at')
  assert.match(chatText(ra), /Reopened after ToolsEnabled restarted/)
})

test('the first send continues the saved conversation, once (B4)', async t => {
  const m = machine(t)
  const first = m.launch()
  await first.workspace.openStandalone({ tier: 'claude-sonnet', effort: 'high' }); await settle()
  const [a] = first.records()
  const record = conversation(['you', 'remember KIWI'], ['agent', 'I will remember KIWI.'])
  record.lines.push({ id: 'context:old:9', who: 'you', text: 'Standing rules for this computer.', promptSource: 'toolsenabled', promptKind: 'requests', at: 9 })
  m.saved.set(a.id, record)
  const second = m.launch()
  await settle()
  const [restored] = second.records()
  assert.match(chatText(restored), /remember KIWI/)
  const mark = m.calls.length
  await send(restored, 'What word did I give you?')
  const [start, ...more] = startsSince(m, mark)
  assert.equal(more.length, 0)
  assert.equal(start.surface, 'standalone-agent')
  assert.equal(start.tier, 'claude-sonnet')
  assert.equal(start.effort, 'high')
  assert.match(start.historyHandoff || '', /The person said: remember KIWI/, 'the new session was not given the saved conversation')
  assert.doesNotMatch(start.historyHandoff, /Standing rules/, 'context ToolsEnabled added was replayed as the person\'s words')
  for (const key of ['replacesSessionId', 'treeIdentity', 'requestKeys', 'resumeThreadId']) assert.equal(key in start, false, key)
  const turnId = `${start.sessionId}:turn-1`
  m.emit(start.sessionId, { type: 'assistant_text_delta', text: 'KIWI', turnId })
  m.emit(start.sessionId, { type: 'turn_completed', status: 'completed', turnId })
  await settle()
  await stopFromActions(restored)
  await send(restored, 'Say it again')
  const starts = startsSince(m, mark)
  assert.equal(starts.length, 2, 'fixture premise: the second message started a new session')
  assert.equal('historyHandoff' in starts[1], false, 'the saved conversation was sent again after the agent had it')
})

test('a first send the host refuses keeps the saved conversation for the next start (B4)', async t => {
  const m = machine(t)
  const first = m.launch()
  await first.workspace.openStandalone({ tier: 'claude-sonnet', effort: 'high' }); await settle()
  const [a] = first.records()
  m.saved.set(a.id, conversation(['you', 'remember KIWI'], ['agent', 'I will remember KIWI.']))
  const second = m.launch()
  await settle()
  const [restored] = second.records()
  let refuse = true
  m.behaviour.send = () => { if (!refuse) return null; refuse = false; return { ok: false, deliveryDisposition: 'not-sent' } }
  const mark = m.calls.length
  await send(restored, 'first try')
  await send(restored, 'second try')
  const starts = startsSince(m, mark)
  assert.equal(starts.length, 2, 'fixture premise: the refused send was followed by a second start')
  assert.match(starts[0].historyHandoff || '', /remember KIWI/)
  assert.match(starts[1].historyHandoff || '', /remember KIWI/, 'a refused first send used up the only copy of the earlier conversation')
})

test('restored tabs hold their seats from the first moment, while their conversations are still being read (B4)', async t => {
  const m = machine(t)
  const first = m.launch()
  await first.workspace.openStandalone(); await settle()
  await first.workspace.openStandalone(); await settle()
  const [a, b] = first.records()
  const gate = deferred()
  m.saved.set(a.id, () => gate.promise)
  const second = m.launch()
  const held = heldStandaloneSeatIds(second.document, second.workspace)
  assert.equal(held.has(a.id) && held.has(b.id), true, 'a tab coming back could have its seat released under it')
  assert.equal(m.reads.at(-1), a.id, 'fixture premise: the first conversation is being read')
  assert.equal(second.records().length, 0)
  gate.resolve(null)
  await settle()
  assert.deepEqual(second.records().map(record => record.id), [a.id, b.id])
})

test('a new tab opened while tabs are coming back takes the next free name (B4)', async t => {
  const m = machine(t)
  const first = m.launch()
  await first.workspace.openStandalone(); await settle()
  await first.workspace.openStandalone(); await settle()
  const [a] = first.records()
  const gate = deferred()
  m.saved.set(a.id, () => gate.promise)
  const second = m.launch()
  await second.workspace.openStandalone(); await settle()
  assert.deepEqual(second.records().map(record => record.agent.name), ['Agent 3'], 'the new tab took a name a returning tab still has')
  gate.resolve(null)
  await settle()
  assert.deepEqual(second.records().map(record => record.agent.name).sort(), ['Agent 1', 'Agent 2', 'Agent 3'])
})

test('closing a restored tab keeps its seat when it has a conversation or its conversation could not be read (B4)', async t => {
  const m = machine(t)
  const first = m.launch()
  for (let i = 0; i < 3; i++) { await first.workspace.openStandalone(); await settle() }
  const [kept, empty, unreadable] = first.records()
  m.saved.set(kept.id, conversation(['you', 'Keep this.']))
  m.saved.set(unreadable.id, new Error('the saved conversation could not be read'))
  const second = m.launch()
  await settle()
  assert.equal(second.records().length, 3)
  for (const record of second.records()) second.workspace.close(record, { focus: false })
  await settle()
  assert.deepEqual(m.released, [empty.id], 'only the tab with nothing saved gives its seat back')
  assert.deepEqual(m.list(), [], 'closed tabs do not come back')
})

test('after a page reload the session the old page left running is closed before the tab reopens (B4)', async t => {
  const m = machine(t)
  const first = m.launch()
  await first.workspace.openStandalone(); await settle()
  const [a] = first.records()
  await send(a, 'Start working')
  const sessionId = m.list()[0].sessionId
  assert.equal(typeof sessionId === 'string' && sessionId.length > 0, true, 'fixture premise: the list holds the running session')
  let mountedAtClose = null
  let second = null
  m.behaviour.beforeStaleClose = () => { mountedAtClose = second?.workspace.standalone.has(a.id) ?? false }
  second = m.launch({ reload: true })
  await settle()
  assert.deepEqual(m.calls.filter(([kind]) => kind === 'close').map(([, value]) => value.sessionId), [sessionId])
  assert.equal(mountedAtClose, false, 'the tab reopened while its old session could still write to it')
  const [restored] = second.records()
  assert.match(chatText(restored), /This agent was stopped when the page reloaded/)
})

test('after a page reload a session that cannot be closed keeps its tab closed until the next start (B4)', async t => {
  const m = machine(t)
  const first = m.launch()
  await first.workspace.openStandalone(); await settle()
  const [a] = first.records()
  await send(a, 'Start working')
  m.behaviour.closeRefused = true
  const second = m.launch({ reload: true })
  await settle()
  assert.equal(second.records().length, 0, 'two sessions could now write to one conversation')
  assert.deepEqual(m.list().map(row => row.id), [a.id], 'the tab must come back next time')
  const status = second.workspace.root.querySelector('.tree-standalone-placement-status')
  assert.equal(status.hidden, false)
  assert.equal(status.textContent, STILL_RUNNING)
})

test('a view rebuilt on the same page keeps the very same restored tab (B4)', async t => {
  const m = machine(t)
  const first = m.launch()
  await first.workspace.openStandalone(); await settle()
  const [a] = first.records()
  const second = m.launch()
  await settle()
  const [restored] = second.records()
  const declared = m.declared.length
  const third = second.again()
  await settle()
  assert.equal(third.workspace.standalone.get(a.id) === restored, true, 'a rebuilt view must re-adopt the tab, not restore a copy')
  assert.equal(third.records().length, 1)
  assert.equal(m.declared.length, declared, 'the rebuilt view restored the tab a second time')
})

test('an unreadable conversation, a refused seat and a retired program are each said in the tab (B4)', async t => {
  const m = machine(t)
  const first = m.launch()
  for (let i = 0; i < 3; i++) { await first.workspace.openStandalone({ tier: 'claude-sonnet', effort: 'high' }); await settle() }
  const [lost, seatless, retired] = first.records()
  m.saved.set(lost.id, new Error('the saved conversation could not be read'))
  m.saved.set(seatless.id, conversation(['you', 'from the seatless tab']))
  m.behaviour.refuseSeat.add(seatless.id)
  const rows = JSON.parse(m.values.get(LIST_KEY))
  rows.tabs[2].tier = 'gpt-retired-9'
  m.values.set(LIST_KEY, JSON.stringify(rows))
  const second = m.launch()
  await settle()
  const [rLost, rSeatless, rRetired] = second.records()
  assert.match(chatText(rLost), /The earlier conversation could not be read/)
  assert.match(chatText(rSeatless), /could not be set up again, so it cannot use computer control/)
  assert.match(chatText(rSeatless), /from the seatless tab/, 'the conversation is still shown without a seat')
  const fallback = defaultStandaloneStart()
  const label = standaloneStartChoices().tiers.find(row => row.id === fallback.tier).label
  assert.match(chatText(rRetired), new RegExp(`no longer offered\\. It will use ${label}`))
  assert.match(chip(rRetired), new RegExp(label))
  assert.equal(m.list()[2].tier, fallback.tier, 'the next start would say the same thing again')
  assert.equal(retired.id, rRetired.id)

  let mark = m.calls.length
  await send(rLost, 'hello')
  assert.equal('historyHandoff' in startsSince(m, mark)[0], false, 'a conversation that could not be read was still sent')
  mark = m.calls.length
  await send(rSeatless, 'hello')
  const seatlessStart = startsSince(m, mark)[0]
  assert.equal('roleBinding' in seatlessStart, false, 'a tab with no seat claimed one')
  assert.match(seatlessStart.historyHandoff || '', /from the seatless tab/)
})

test('changing the program writes it down, and so does the session that opens (B4)', async t => {
  const m = machine(t)
  const first = m.launch()
  await first.workspace.openStandalone({ tier: 'claude-opus', effort: 'high' }); await settle()
  const [a] = first.records()
  assert.deepEqual(m.list().map(row => [row.id, row.tier, row.effort, row.sessionId]), [[a.id, 'claude-opus', 'high', null]])
  a.chatPanel.querySelector('[data-chat-chip="tier"]').click(); await settle()
  const notice = first.workspace.root.querySelector('.tree-agent-notice')
  notice.querySelector('[data-spawn-field=tier]').value = 'claude-sonnet'
  notice.querySelector('[data-spawn-field=effort]').value = 'low'
  first.workspace.root.querySelector('.tree-agent-continue').click(); await settle()
  assert.deepEqual([m.list()[0].tier, m.list()[0].effort], ['claude-sonnet', 'low'], 'the tab would come back on the program it was changed from')
  const mark = m.calls.length
  await send(a, 'go')
  const [start] = startsSince(m, mark)
  assert.equal(m.list()[0].sessionId, start.sessionId)
})

/* B25: a reopened tab's chip, then the same tab after the view is rebuilt, opens a model pop-up
   that is on screen (no hidden ancestor up to the workspace, which is on the page) and filled
   with the tab's model. The stand-in draws hidden ancestors, so they are walked here. */
test('a reopened tab\'s chip opens a pop-up that is on screen, also after the view is rebuilt (B25)', async t => {
  const m = machine(t)
  const first = m.launch()
  await first.workspace.openStandalone({ tier: 'claude-opus', effort: 'high' }); await settle()
  const shown = view => {
    const notice = view.workspace.root.querySelector('.tree-agent-notice')
    const hidden = []
    for (let node = notice; node && node !== view.workspace.root.parentElement; node = node.parentElement) if (node.hidden !== false) hidden.push(node.className)
    assert.deepEqual(hidden, [], 'THE DEFECT: the pop-up the tab opened has a hidden ancestor')
    assert.equal(view.workspace.root.isConnected, true, 'the pop-up belongs to a view that is not on the page')
    assert.ok(notice.querySelector('[data-spawn-field=tier]').querySelectorAll('option').length > 0, 'the Model menu has no rows')
    assert.equal(notice.querySelector('[data-spawn-field=tier]').value, 'claude-opus')
    assert.equal(notice.querySelector('[data-spawn-field=effort]').value, 'high')
    notice.querySelector('.tree-agent-cancel').click()
    assert.equal(notice.hidden, true)
    assert.equal(view.workspace.root.querySelector('.tree-chat-chooser').hidden, true, 'Cancel left the + menu open')
  }
  const second = m.launch()
  await settle()
  const [restored] = second.records()
  assert.ok(restored, 'fixture premise: the tab came back')
  restored.chatPanel.querySelector('[data-chat-chip="tier"]').click(); await settle()
  shown(second)
  const third = second.again()
  await settle()
  assert.equal(third.workspace.standalone.get(restored.id) === restored, true, 'fixture premise: the rebuilt view kept the tab')
  restored.chatPanel.querySelector('[data-chat-chip="tier"]').click(); await settle()
  shown(third)
  assert.equal(third.records().length, 1, 'the pop-up opened a tab')
})

test('the New agent pop-up no longer says a tab is lost when ToolsEnabled restarts (B4)', async t => {
  const m = machine(t)
  const view = m.launch()
  view.workspace.openSpawnChooser(); await settle()
  const words = view.workspace.root.querySelector('.tree-agent-notice p').textContent
  assert.doesNotMatch(words, /keep it across app restarts/)
  assert.match(words, /come back after ToolsEnabled restarts/)
})

/* B4 review (1.0.48), D8. The pop-up promised "the tab and its conversation come back" everywhere.
   The example and a relay computer keep no list of tabs, and "Delete agent nodes when the app
   exits" deletes the list at quit, so there the promise was false. */
test('the New agent pop-up promises a tab comes back only where it does (B4 review D8)', async t => {
  const cases = [
    ['no list of tabs is kept (example, relay)', { keepsTabs: false, tabsComeBack: true }, /closes when ToolsEnabled closes\. Add it to a tree to keep it\./],
    ['agents are deleted when the app exits', { keepsTabs: true, tabsComeBack: false }, /closes when ToolsEnabled closes, because agents are deleted when the app exits/],
    ['the setting could not be read', { keepsTabs: true, tabsComeBack: null }, /^It opens in its own chat tab\.$/],
  ]
  for (const [label, answers, expected] of cases) await t.test(label, async child => {
    const m = machine(child)
    Object.assign(m.behaviour, answers)
    const view = m.launch()
    view.workspace.openSpawnChooser(); await settle()
    const words = view.workspace.root.querySelector('.tree-agent-notice p').textContent
    assert.equal(/come back after ToolsEnabled restarts/.test(words), false, `THE DEFECT: the pop-up promises a restart brings the tab back: ${words}`)
    assert.match(words, expected)
  })
})

/* B4 step 10: what a restored tab hands a tree when it is added before any agent has its
   conversation. Once a turn of the seeded session has finished, an agent has it, and what that
   agent said since is under the tab's own seat -- the pre-existing case of speech before a
   placement, which this does not change. */
test('a restored tab offers its conversation to a tree only until an agent has had it (B4)', async t => {
  const m = machine(t)
  const first = m.launch()
  await first.workspace.openStandalone({ tier: 'claude-sonnet', effort: 'high' }); await settle()
  const [a] = first.records()
  m.saved.set(a.id, conversation(['you', 'remember KIWI'], ['agent', 'I will remember KIWI.']))
  const second = m.launch()
  await settle()
  const [restored] = second.records()
  assert.equal(typeof restored.session.restoredConversation, 'function', 'THE DEFECT: a placed tab has no conversation to give its circle')
  assert.deepEqual(restored.session.restoredConversation().map(line => line.text), ['remember KIWI', 'I will remember KIWI.'])
  const mark = m.calls.length
  await send(restored, 'What word?')
  const [start] = startsSince(m, mark)
  const turnId = `${start.sessionId}:turn-1`
  m.emit(start.sessionId, { type: 'assistant_text_delta', text: 'KIWI', turnId })
  m.emit(start.sessionId, { type: 'turn_completed', status: 'completed', turnId })
  await settle()
  assert.deepEqual(restored.session.restoredConversation(), [], 'the conversation an agent already has would be copied a second time')
})

/* B4 step 11 (owner default: the tree's own rule). Words the person queued while the agent was
   answering are saved with the session they were written to, and a restart ends that session. A
   tree circle carries them to the session its Resume opens; a reopened tab carries them to the
   session its first send opens. They go after that first turn, never before it, and ahead of
   anything queued after the restart, because they were written first. */
test('a message waiting at quit is carried to the new session and sent after its first turn, never before (B4)', async t => {
  const m = machine(t)
  const first = m.launch()
  await first.workspace.openStandalone({ tier: 'claude-sonnet', effort: 'high' }); await settle()
  const [a] = first.records()
  await send(a, 'Start working')
  const earlier = m.list()[0].sessionId
  await send(a, 'and then check the tests')
  assert.deepEqual(outboxList(earlier).map(entry => entry.text), ['and then check the tests'],
    'fixture premise: the second message waits behind the running turn')
  const second = m.launch()
  await settle()
  const [restored] = second.records()
  const sent = mark => m.calls.slice(mark).filter(([kind]) => kind === 'send').map(([, value]) => [value.sessionId, value.text])
  const mark = m.calls.length
  assert.deepEqual(sent(mark), [], 'reopening the tab sent something')

  // The new session is still starting when the person writes again.
  const starting = deferred()
  m.behaviour.beforeStart = () => starting.promise
  await send(restored, 'What next?')
  const [opened] = startsSince(m, mark)
  assert.equal(Boolean(opened), true, 'fixture premise: the first send is starting a session')
  const now = opened.sessionId
  await send(restored, 'typed while it started')
  m.behaviour.beforeStart = null
  starting.resolve()
  await settle()
  assert.deepEqual(sent(mark), [[now, 'What next?']], 'a waiting message went before the first turn finished')
  assert.deepEqual(outboxList(now).map(entry => entry.text), ['and then check the tests', 'typed while it started'],
    'THE DEFECT: the words waiting at quit are not waiting for this session, or not ahead of newer ones')
  assert.deepEqual(outboxList(earlier), [])

  const turn = n => { const turnId = `${now}:turn-${n}`; m.emit(now, { type: 'assistant_text_delta', text: 'ok', turnId }); m.emit(now, { type: 'turn_completed', status: 'completed', turnId }) }
  turn(1); await settle()
  assert.deepEqual(sent(mark), [[now, 'What next?'], [now, 'and then check the tests']])
  turn(2); await settle()
  assert.deepEqual(sent(mark), [[now, 'What next?'], [now, 'and then check the tests'], [now, 'typed while it started']])
})

test('a message waiting at quit is not stranded by a first send the host refuses (B4)', async t => {
  const m = machine(t)
  const first = m.launch()
  await first.workspace.openStandalone({ tier: 'claude-sonnet', effort: 'high' }); await settle()
  const [a] = first.records()
  await send(a, 'Start working')
  await send(a, 'and then check the tests')
  const second = m.launch()
  await settle()
  const [restored] = second.records()
  let refuse = true
  m.behaviour.send = () => { if (!refuse) return null; refuse = false; return { ok: false, deliveryDisposition: 'not-sent' } }
  const mark = m.calls.length
  await send(restored, 'first try')
  await send(restored, 'second try')
  const starts = startsSince(m, mark)
  assert.equal(starts.length, 2, 'fixture premise: the refused send was followed by a second start')
  const now = starts[1].sessionId
  assert.deepEqual(outboxList(now).map(entry => entry.text), ['and then check the tests'],
    'the waiting message stayed with the session the host refused')
  const turnId = `${now}:turn-1`
  m.emit(now, { type: 'assistant_text_delta', text: 'ok', turnId })
  m.emit(now, { type: 'turn_completed', status: 'completed', turnId })
  await settle()
  assert.deepEqual(m.calls.slice(mark).filter(([kind]) => kind === 'send').map(([, value]) => [value.sessionId, value.text]).slice(-2),
    [[now, 'second try'], [now, 'and then check the tests']])
})

/* ---- the real Computers page ---- */

const solo = n => `standalone-0000000${n}-0000-4000-8000-00000000000${n}`
const orgSeat = id => ({ id, displayName: 'Agent 1', role: 'worker', provider: 'claude', enabled: true, nodeId: id })
const listOne = (id, sessionId = null) => JSON.stringify({ v: 1, tabs: [{ id, name: 'Agent 1', tier: 'claude-sonnet', effort: 'high', openedAt: 1, sessionId }] })
const transcriptBridge = records => ({
  list: async () => ({ ok: true, records: [...records.keys()].map(nodeId => ({ nodeId })) }),
  read: async ({ nodeId }) => {
    const record = records.get(nodeId)
    return record
      ? { ok: true, metadata: { nodeId }, entries: record.lines, before: record.before || null, recoveryDirectory: record.recoveryDirectory || null }
      : { ok: true, metadata: null, entries: [], before: null }
  },
  append: async () => ({ ok: true }),
  bind: async () => ({ ok: true }),
  release: async () => ({ ok: true, released: true }),
  onError: () => () => {},
})

test('on the real page a restored tab folds what ToolsEnabled added and says where older messages are (B4)', async t => {
  for (const [label, seatBack] of [['its seat came back', true], ['its seat did not come back', false]]) await t.test(label, async child => {
    const id = solo(1)
    const records = new Map([[id, { before: 'older-page', recoveryDirectory: '/saved/conversation', lines: [
      { id: 'person:old:1', who: 'you', text: 'remember KIWI', at: 1 },
      { id: 'context:old:1', who: 'you', text: 'Standing rules for this computer.', promptSource: 'toolsenabled', promptKind: 'requests', at: 1 },
      { id: 'agent:old:1', who: 'agent', text: 'I will remember KIWI.', at: 2 }] }]])
    const fixture = await mountComputers(child, { nodes: [{ id: 'node-1-live', role: 'worker' }], agents: [{ id: 'controller', role: 'controller', enabled: true }, orgSeat(id)],
      seed: storage => {
        storage.setItem(STANDALONE_TABS_PREFIX + COMPUTER_ID, listOne(id))
        globalThis.window.mcTranscripts = transcriptBridge(records)
        if (seatBack) {
          // A Role library that knows the worker role, so the seat is found again as it was.
          const read = globalThis.window.mcOrg.read
          globalThis.window.mcOrg.read = async () => ({ ...(await read()),
            roles: [{ id: 'controller', revision: 1, capabilities: { orgRoot: true } }, { id: 'worker', revision: 2 }] })
        }
      } })
    await settleMounted()
    const record = fixture.graph?.workspace?.standalone.get(id)
    assert.equal(Boolean(record), true, 'the tab open at quit did not come back on the real page')
    const chat = record.chatPanel.querySelector('[data-chat-panel]')
    assert.equal(/cannot use computer control/.test(chat.textContent), !seatBack, 'fixture premise: the seat came back only when it could')
    const mine = chat.querySelectorAll('.me').map(node => node.textContent)
    assert.equal(mine.some(text => /remember KIWI/.test(text)), true, 'the person\'s own words are not shown')
    assert.equal(mine.some(text => /Standing rules/.test(text)), false, 'context ToolsEnabled added is shown as the person\'s words')
    assert.equal(chat.querySelectorAll('.chat-context').length, 1, 'the added context is not folded')
    assert.match(chat.textContent, /I will remember KIWI/)
    assert.equal(typeof fleetCopy.STANDALONE_OLDER_NOTE === 'string' && chat.textContent.includes(fleetCopy.STANDALONE_OLDER_NOTE), true, 'nothing says older messages are kept')
    // B4 review D9: the tab has no Saved conversation browser, so its note must not send the person to one.
    assert.equal(chat.textContent.includes(TRANSCRIPT_OLDER_NOTE) || /Saved conversation/.test(chat.textContent), false,
      'THE DEFECT: the tab says older messages are in Saved conversation, which the tab does not have')
    assert.equal(fixture.operations.filter(row => row.name === 'start' || row.name === 'send').length, 0)
  })
})

test('on the real page a session left running by a reload is closed before its tab reopens (B4)', async t => {
  const id = solo(2)
  const closes = []
  const fixture = await mountComputers(t, { nodes: [{ id: 'node-1-live', role: 'worker' }], agents: [{ id: 'controller', role: 'controller', enabled: true }, orgSeat(id)],
    seed: storage => {
      storage.setItem(STANDALONE_TABS_PREFIX + COMPUTER_ID, listOne(id, 'left-running'))
      globalThis.window.mcAgent.sessionActivity = async ({ sessionId }) => {
        if (sessionId !== 'left-running') throw Object.assign(new Error('unknown'), { code: 'MC_AGENT_UNKNOWN_SESSION' })
        return { ok: true, busy: false, closing: false, lastTurnStatus: null, turnsCompleted: 1 }
      }
      globalThis.window.mcAgent.close = async request => { closes.push(request); return { ok: true, closed: true } }
    } })
  await settleMounted()
  assert.deepEqual(closes, [{ sessionId: 'left-running' }])
  const record = fixture.graph?.workspace?.standalone.get(id)
  assert.equal(Boolean(record), true)
  assert.match(record.chatPanel.textContent, /This agent was stopped when the page reloaded/)
})

test('on the real page a restored tab added to a tree before it sent gives the circle its conversation (B4)', async t => {
  const id = solo(3)
  const appended = []
  const records = new Map([[id, { lines: [
    { id: 'person:old:1', who: 'you', text: 'remember KIWI', at: 1 },
    { id: 'agent:old:1', who: 'agent', text: 'I will remember KIWI.', at: 2 }] }]])
  const fixture = await mountComputers(t, { nodes: [{ id: 'node-1-live', role: 'worker' }], agents: [{ id: 'controller', role: 'controller', enabled: true }, orgSeat(id)],
    seed: storage => {
      storage.setItem(STANDALONE_TABS_PREFIX + COMPUTER_ID, listOne(id))
      const bridge = transcriptBridge(records)
      bridge.append = async request => { appended.push(structuredClone(request)); return { ok: true } }
      globalThis.window.mcTranscripts = bridge
    } })
  await settleMounted()
  const workspace = fixture.graph?.workspace
  const record = workspace?.standalone.get(id)
  assert.equal(Boolean(record), true, 'fixture premise: the tab open at quit came back')
  const placed = await workspace.placeStandalone(record, null)
  assert.equal(placed.ok, true, `fixture premise: the tab was added to a tree (${placed.sentence})`)
  await settleMounted()
  const written = appended.filter(request => request.nodeId === placed.nodeId).flatMap(request => request.entries)
  assert.deepEqual(written.map(entry => entry.text), ['remember KIWI', 'I will remember KIWI.'],
    'the circle has none of the conversation the tab showed, so its Resume starts from nothing')
  const node = JSON.parse(fixture.world.storage.getItem(fleetTreesStorageKey(COMPUTER_ID))).nodes.find(row => row.id === placed.nodeId)
  assert.equal(node?.message, '', 'an old request became the brief Start tree would send')
  assert.equal(fixture.operations.filter(row => row.name === 'start' || row.name === 'send').length, 0)
})

/* Decision (B4): the handoff a restored New agent tab sends says "this
   conversation", because a standalone tab is not a circle. Tree wording stays. */
test('the saved-conversation handoff names a standalone tab\'s conversation, and a tree circle stays a circle (B4)', async () => {
  const { transcriptSeedText } = await import('../../src/session-transcript-store.js')
  const lines = [{ who: 'you', text: 'remember KIWI' }]
  const standalone = transcriptSeedText(lines, { recoveryDirectory: '/saved/conversation', earlierMessages: true, place: 'conversation' })
  assert.match(standalone, /Full record of this conversation: "\/saved\/conversation"\./)
  assert.doesNotMatch(standalone, /circle/)
  assert.match(transcriptSeedText(lines, { recoveryDirectory: '/saved/conversation', earlierMessages: true }), /Full conversation for this circle:/)
})

/* ---- B4 review (1.0.48): what Add to tree carries into the new circle ---- */

/* D1. The tab's saved conversation holds the context ToolsEnabled added to its first turn, saved
   from the person's side. The circle made from the tab has no session, and a circle with no
   session draws its saved lines as they are -- so the standing rules and tool list showed as the
   person's bubbles there, on every surface and after every restart. */
test('on the real page a circle made from a restored tab does not show ToolsEnabled\'s context as the person\'s words (B4 review D1)', async t => {
  const id = solo(4)
  const appended = []
  const records = new Map([[id, { lines: [
    { id: 'person:old:1', who: 'you', text: 'remember KIWI', at: 1 },
    { id: 'context:old:1', who: 'you', text: 'Standing rules for this computer.', promptSource: 'toolsenabled', promptKind: 'requests', at: 1 },
    { id: 'context:old:2', who: 'you', text: 'Tools you may use here.', promptSource: 'toolsenabled', promptKind: 'tools', at: 1 },
    { id: 'agent:old:1', who: 'agent', text: 'I will remember KIWI.', at: 2 }] }]])
  const fixture = await mountComputers(t, { nodes: [{ id: 'node-1-live', role: 'worker' }], agents: [{ id: 'controller', role: 'controller', enabled: true }, orgSeat(id)],
    seed: storage => {
      storage.setItem(STANDALONE_TABS_PREFIX + COMPUTER_ID, listOne(id))
      const bridge = transcriptBridge(records)
      bridge.append = async request => {
        appended.push(structuredClone(request))
        const held = records.get(request.nodeId) || { lines: [] }
        held.lines.push(...structuredClone(request.entries))
        records.set(request.nodeId, held)
        return { ok: true }
      }
      globalThis.window.mcTranscripts = bridge
    } })
  await settleMounted()
  const workspace = fixture.graph?.workspace
  const record = workspace?.standalone.get(id)
  assert.equal(Boolean(record), true, 'fixture premise: the tab open at quit came back')
  assert.equal(record.session.restoredConversation().some(line => line.promptSource === 'toolsenabled'), false,
    'the tab hands ToolsEnabled\'s context to the tree as conversation')
  const placed = await workspace.placeStandalone(record, null)
  assert.equal(placed.ok, true, `fixture premise: the tab was added to a tree (${placed.sentence})`)
  await settleMounted()
  const written = appended.filter(request => request.nodeId === placed.nodeId).flatMap(request => request.entries)
  assert.deepEqual(written.map(entry => entry.text), ['remember KIWI', 'I will remember KIWI.'])
  const node = JSON.parse(fixture.world.storage.getItem(fleetTreesStorageKey(COMPUTER_ID))).nodes.find(row => row.id === placed.nodeId)
  const mine = (fixture.graph.standaloneAgent.chatConfigFor(node)?.history || []).filter(row => row.who === 'you').map(row => row.text)
  assert.deepEqual(mine, ['remember KIWI'], 'THE DEFECT: the circle shows ToolsEnabled\'s context as things the person said')
})

/* D4. The tab read only the newest page of its conversation. Adding it to a tree copied that page
   alone, so the circle lost the older lines and any sign they existed. The older pages are read from
   the tab's seat, with the cursor the tab came back with, and written first. */
test('on the real page a restored tab added to a tree gives the circle its older pages too (B4 review D4)', async t => {
  const id = solo(5)
  // Long enough that the newest page already fills the handoff budget, so the tab reads no further back (c5).
  const all = Array.from({ length: 90 }, (_, n) => ({ id: `line:${String(n).padStart(3, '0')}`, who: n % 2 ? 'agent' : 'you', text: `line ${n} ${'w'.repeat(120)}`, at: n + 1 }))
  const appended = [], reads = []
  const fixture = await mountComputers(t, { nodes: [{ id: 'node-1-live', role: 'worker' }], agents: [{ id: 'controller', role: 'controller', enabled: true }, orgSeat(id)],
    seed: storage => {
      storage.setItem(STANDALONE_TABS_PREFIX + COMPUTER_ID, listOne(id))
      globalThis.window.mcTranscripts = {
        list: async () => ({ ok: true, records: [{ nodeId: id }] }),
        read: async ({ nodeId, before = null, limit = 60, strictBefore = false }) => {
          reads.push({ nodeId, before, strictBefore })
          if (nodeId !== id) return { ok: true, metadata: null, entries: [], before: null }
          const cursor = before ? all.findIndex(entry => entry.id === before) : -1
          if (strictBefore && before && cursor < 0) return { ok: false, error: { code: 'MC_AGENT_TRANSCRIPT_CURSOR_INVALID', message: 'cursor' } }
          const files = cursor >= 0 ? all.slice(0, cursor) : all
          const page = files.slice(-Math.min(100, limit))
          return { ok: true, metadata: { nodeId }, entries: page, before: files.length > page.length ? page[0].id : null, recoveryDirectory: '/saved/seat' }
        },
        append: async request => { appended.push(structuredClone(request)); return { ok: true } },
        bind: async () => ({ ok: true }),
        release: async () => ({ ok: true, released: true }),
        onError: () => () => {},
      }
    } })
  await settleMounted()
  const workspace = fixture.graph?.workspace
  const record = workspace?.standalone.get(id)
  assert.equal(Boolean(record), true, 'fixture premise: the tab open at quit came back')
  assert.equal(record.session.restoredConversation().length, 60, 'fixture premise: the tab showed its newest page only')
  const placed = await workspace.placeStandalone(record, null)
  assert.equal(placed.ok, true, `fixture premise: the tab was added to a tree (${placed.sentence})`)
  await settleMounted()
  const written = appended.filter(request => request.nodeId === placed.nodeId).flatMap(request => request.entries)
  assert.deepEqual(written.map(entry => entry.id), all.map(entry => entry.id),
    'THE DEFECT: the circle holds only the newest page, so its older messages are gone from the tree')
  assert.equal(reads.some(read => read.nodeId === id && read.before === all[30].id && read.strictBefore === true), true,
    'the older pages were not read from the tab\'s own cursor')
})

/* ---- B4 review (1.0.48): when the saved conversation counts as delivered ---- */

/* The held waits of agent-session.js (4 s first) run at once here; nothing else in these cases
   waits that long. */
function quickHeldWaits(t) {
  const real = globalThis.setTimeout
  globalThis.setTimeout = (callback, ms, ...rest) => real(callback, ms === 4000 ? 0 : ms, ...rest)
  t.after(() => { globalThis.setTimeout = real })
}
const finishTurn = (m, sessionId, n = 1) => {
  const turnId = `${sessionId}:turn-${n}`
  m.emit(sessionId, { type: 'assistant_text_delta', text: 'ok', turnId })
  m.emit(sessionId, { type: 'turn_completed', status: 'completed', turnId })
}

/* D2. A held start (the computer is busy) asks again under a NEW session id with the options it
   already had, so the retry carries the seed without getStartOptions being asked. The delivery
   check still watched the first attempt's id, so the seed never counted as delivered: the tab kept
   offering the pre-restart lines to a tree, and the next session after Stop sent the stale excerpt
   again. */
test('a held first start that is retried counts the saved conversation delivered once the retry\'s turn finishes (B4 review D2)', async t => {
  quickHeldWaits(t)
  const m = machine(t)
  const first = m.launch()
  await first.workspace.openStandalone({ tier: 'claude-sonnet', effort: 'high' }); await settle()
  const [a] = first.records()
  m.saved.set(a.id, conversation(['you', 'remember KIWI'], ['agent', 'I will remember KIWI.']))
  const second = m.launch()
  await settle()
  const [restored] = second.records()
  let held = true
  m.behaviour.send = () => { if (!held) return null; held = false; return { ok: false, code: 'AGENT_RESOURCE_PACING', deliveryDisposition: 'not-sent' } }
  const mark = m.calls.length
  await send(restored, 'first try')
  await settle(); await settle()
  const starts = startsSince(m, mark)
  assert.equal(starts.length, 2, 'fixture premise: the held start was asked again')
  assert.notEqual(starts[1].sessionId, starts[0].sessionId, 'fixture premise: the retry runs under a new session id')
  assert.match(starts[1].historyHandoff || '', /remember KIWI/, 'fixture premise: the retry carries the seed it was given')
  finishTurn(m, starts[1].sessionId)
  await settle()
  assert.deepEqual(restored.session.restoredConversation(), [],
    'THE DEFECT: the tab still offers the conversation the retried session already has')
  await stopFromActions(restored)
  await send(restored, 'Say it again')
  const later = startsSince(m, mark).at(-1)
  assert.equal(startsSince(m, mark).length, 3, 'fixture premise: the next message started a new session')
  assert.equal('historyHandoff' in later, false, 'a later session was sent the stale pre-restart excerpt again')
})

/* D3. A refused first send whose session the host has already forgotten: closeSession gets
   MC_AGENT_UNKNOWN_SESSION and publishes the seeded session as open with a failed turn -- which the
   old check read as "a turn finished". The seed was dropped and the messages waiting at quit were
   left under a dead session. Only a turn the host accepted counts. */
test('a refused first send whose session is already gone keeps the saved conversation and the waiting messages (B4 review D3)', async t => {
  const m = machine(t)
  const first = m.launch()
  await first.workspace.openStandalone({ tier: 'claude-sonnet', effort: 'high' }); await settle()
  const [a] = first.records()
  await send(a, 'Start working')
  await send(a, 'and then check the tests')
  m.saved.set(a.id, conversation(['you', 'remember KIWI'], ['agent', 'I will remember KIWI.']))
  const second = m.launch()
  await settle()
  const [restored] = second.records()
  const bridge = second.graph.standaloneAgent.bridge
  const close = bridge.close
  let refuse = true, forgotten = false
  m.behaviour.send = () => { if (!refuse) return null; refuse = false; return { ok: false, code: 'MC_AGENT_SESSION_ENDED', deliveryDisposition: 'not-sent' } }
  bridge.close = async value => {
    if (!refuse && !forgotten) { forgotten = true; throw Object.assign(new Error('gone'), { code: 'MC_AGENT_UNKNOWN_SESSION' }) }
    return close(value)
  }
  t.after(() => { bridge.close = close })
  const mark = m.calls.length
  await send(restored, 'first try')
  assert.equal(forgotten, true, 'fixture premise: the host no longer knew the refused session')
  await send(restored, 'second try')
  const starts = startsSince(m, mark)
  assert.equal(starts.length, 2, 'fixture premise: the refused send was followed by a second start')
  const now = starts[1].sessionId
  // Both halves at once, so each is seen to fail on its own: the seed, and the words waiting at quit.
  assert.deepEqual({
    seedCarried: /remember KIWI/.test(starts[1].historyHandoff || ''),
    waitingOnNewSession: outboxList(now).map(entry => entry.text),
    waitingOnRefusedSession: outboxList(starts[0].sessionId).map(entry => entry.text),
  }, { seedCarried: true, waitingOnNewSession: ['and then check the tests'], waitingOnRefusedSession: [] },
  'THE DEFECT: a refused first send used up the saved conversation, or left the waiting message with the refused session')
})

/* ---- B4 review (1.0.48): the list of open tabs and the names in it ---- */

/* D7. A tab kept away because its earlier session would not close stays in the list and comes back
   next time, but the skip freed its reserved name, so a new tab could take it and two tabs came
   back with the same name. */
test('a tab kept away by a session still running keeps its name, so a new tab does not take it (B4 review D7)', async t => {
  const m = machine(t)
  const first = m.launch()
  await first.workspace.openStandalone(); await settle()
  const [a] = first.records()
  await send(a, 'Start working')
  m.behaviour.closeRefused = true
  const second = m.launch({ reload: true })
  await settle()
  assert.equal(second.records().length, 0, 'fixture premise: the tab was kept away this time')
  await second.workspace.openStandalone(); await settle()
  const names = m.list().map(row => row.name)
  assert.deepEqual(names, ['Agent 1', 'Agent 2'], 'THE DEFECT: two tabs in the list share a name')
  assert.equal(heldStandaloneSeatIds(second.document, second.workspace).has(a.id), false,
    'fixture premise: the kept-away tab is held by the list, not as a tab coming back now')
})

/* D12. close() ignored forget() answering false (the settings write was refused), so a tab the
   person closed came back after the next restart with nothing said. */
test('a close whose list write is refused says the tab may come back (B4 review D12)', async t => {
  const m = machine(t)
  const view = m.launch()
  await view.workspace.openStandalone(); await settle()
  const [a] = view.records()
  const storage = globalThis.localStorage
  const { setItem, removeItem } = storage
  storage.setItem = () => { throw Object.assign(new Error('refused'), { code: 'MC_PREFS_WRITE_REFUSED' }) }
  storage.removeItem = storage.setItem
  try { view.workspace.close(a, { focus: false }) } finally { storage.setItem = setItem; storage.removeItem = removeItem }
  await settle()
  assert.deepEqual(m.list().map(row => row.id), [a.id], 'fixture premise: the refused write left the tab in the list')
  const status = view.workspace.root.querySelector('.tree-standalone-placement-status')
  assert.equal(status.hidden === false && /Agent 1 could not be removed/.test(status.textContent), true,
    'THE DEFECT: a closed tab will come back and nothing said so')
  assert.match(status.textContent, /Close it again/)
})

/* B4 verify: standalonePlaced ignored forget() answering false, the same way close() did before
   D12, so a tab added to a tree could come back as a tab after the next restart, with nothing said. */
test('a placement whose list write is refused says the tab may come back (B4 verify)', async t => {
  const m = machine(t)
  const view = m.launch()
  await view.workspace.openStandalone(); await settle()
  const [a] = view.records()
  view.graph.onPlaceStandalone = placeOnTree('placed-node')
  const storage = globalThis.localStorage
  const { setItem, removeItem } = storage
  storage.setItem = () => { throw Object.assign(new Error('refused'), { code: 'MC_PREFS_WRITE_REFUSED' }) }
  storage.removeItem = storage.setItem
  let placed
  try { placed = await view.workspace.placeStandalone(a, null) } finally { storage.setItem = setItem; storage.removeItem = removeItem }
  await settle()
  assert.equal(placed?.ok, true, 'fixture premise: the tab was added to a tree')
  assert.deepEqual(m.list().map(row => row.id), [a.id], 'fixture premise: the refused write left the tab in the list')
  const status = view.workspace.root.querySelector('.tree-standalone-placement-status')
  assert.equal(Boolean(status) && status.hidden === false && /Agent 1 is in the tree now/.test(status.textContent), true,
    'THE DEFECT: a placed tab will come back as a tab and nothing said so')
  assert.match(status.textContent, /close it\./)
})

/* ---- B4 review (1.0.48): what a reopened tab says ---- */

/* D10. Every reopened tab began "Reopened after ToolsEnabled restarted ... Send a message to
   continue the conversation." That was wrong after a page reload, over a conversation that could
   not be read, and on a tab that never sent anything. */
test('a reopened tab\'s first line fits its case (B4 review D10)', async t => {
  await t.test('after a reload that stopped the session the old page left running', async child => {
    const m = machine(child)
    const first = m.launch()
    await first.workspace.openStandalone(); await settle()
    const [a] = first.records()
    await send(a, 'Start working')
    m.saved.set(a.id, conversation(['you', 'Start working']))
    const second = m.launch({ reload: true })
    await settle()
    const text = chatText(second.records()[0])
    assert.match(text, /This agent was stopped when the page reloaded\. Send a message to continue the conversation\./)
    assert.equal(/ToolsEnabled restarted/.test(text), false, 'THE DEFECT: a reload was called a restart')
  })
  await t.test('after a reload with nothing left running', async child => {
    const m = machine(child)
    const first = m.launch()
    await first.workspace.openStandalone(); await settle()
    const [a] = first.records()
    m.saved.set(a.id, conversation(['you', 'hello'], ['agent', 'hi']))
    const second = m.launch({ reload: true })
    await settle()
    const text = chatText(second.records()[0])
    assert.match(text, /Reopened after the page reloaded\. This agent is not running\. Send a message to continue the conversation\./)
    assert.equal(/ToolsEnabled restarted/.test(text), false, 'THE DEFECT: a reload was called a restart')
  })
  await t.test('when the conversation could not be read', async child => {
    const m = machine(child)
    const first = m.launch()
    await first.workspace.openStandalone(); await settle()
    const [a] = first.records()
    m.saved.set(a.id, new Error('the saved conversation could not be read'))
    const second = m.launch()
    await settle()
    const text = chatText(second.records()[0])
    assert.match(text, /Reopened after ToolsEnabled restarted\. This agent is not running\./)
    assert.equal(/continue the conversation/.test(text), false, 'THE DEFECT: it offers to continue a conversation it could not read')
    assert.match(text, /could not be read\. Send a message to start this agent without it\./)
  })
  await t.test('for a tab that never sent anything', async child => {
    const m = machine(child)
    const first = m.launch()
    await first.workspace.openStandalone(); await settle()
    const second = m.launch()
    await settle()
    const text = chatText(second.records()[0])
    assert.match(text, /Reopened after ToolsEnabled restarted\. Send a message to start this agent\./)
    assert.equal(/continue the conversation|not running/.test(text), false, 'THE DEFECT: a tab that never sent has no conversation to continue')
  })
})

/* D11. The sentences a reopened tab and the page say: plain words, a next step, at most 25 words
   each. "Identity" named a mechanism, and the still-running line did not say which tab. */
test('what a reopened tab says is plain, names the tab, and gives a next step (B4 review D11)', async () => {
  const { STANDALONE_RESTORE_COPY } = await import('../../src/tree-standalone-agent.js')
  const { STANDALONE_NOTICE_COPY } = await import('../../src/tree-workspace.js')
  const said = Object.entries({ ...STANDALONE_RESTORE_COPY, ...Object.fromEntries(Object.entries(STANDALONE_NOTICE_COPY).map(([key, text]) => [`notice.${key}`, text])) })
    .map(([key, value]) => [key, typeof value === 'function' ? value('Agent 1') : value])
  for (const [key, text] of said) {
    assert.equal(/\bidentity\b|\bseats?\b/i.test(text), false, `THE DEFECT: ${key} names a mechanism: ${text}`)
    for (const sentence of text.split(/(?<=[.!?])\s+/)) assert.equal(sentence.split(/\s+/).length <= 25, true, `${key}: over 25 words: ${sentence}`)
  }
  const failures = ['notSaved', 'listUnreadable', 'conversationUnreadable', 'seatRefused', 'stillRunning', 'closeNotSaved']
  const nextStep = /\b(try|press|open|close|choose|use|add|send|restart|reopen)\b/i
  for (const key of failures) assert.match(said.find(([name]) => name === key)[1], nextStep, `${key} does not say what to do`)
  assert.match(STANDALONE_RESTORE_COPY.stillRunning('Agent 7'), /^Agent 7 /, 'THE DEFECT: the still-running line does not say which tab')
})

/* ---- c5, soak of candidate 4: a restored tab carries its conversation up to the budget ---- */

/* The long-lived soak profile asked its Agent 1 tab, after every restart, what it was first asked
   to say. Once the tab's saved record passed 60 entries the answer was "You have not asked me to
   say a word yet": the tab read only its newest 60 entries, so the opening request was not in what
   the new session was handed, and the handoff said "(Older messages were left out to fit.)" while
   the whole conversation was a few hundred characters of a 6,000-character budget. Most entries
   are not conversation: every relaunch also saves the context ToolsEnabled added (the handoff copy,
   the role, the tools), and every turn a Thinking line. */
const PINEAPPLE_ASK = 'Reply with exactly this one word and nothing else: PINEAPPLE'
function pineappleRecord() {
  const rows = []
  const add = (who, text, extra = {}) => rows.push({ id: `${String(rows.length + 1).padStart(16, '0')}-entry.json`, who, text, at: rows.length + 1, ...extra })
  const added = kind => add('you', `${kind.toUpperCase()} added by ToolsEnabled. ` + 'x'.repeat(kind === 'history' ? 900 : 1900), { promptSource: 'toolsenabled', promptKind: kind })
  const thinking = () => add('action', 'Thinking', { kind: 'thinking' })
  add('you', PINEAPPLE_ASK); added('role'); added('tools'); thinking(); add('agent', 'PINEAPPLE')
  add('you', 'What word did I just ask you to say? Answer with only that word.'); added('tools'); thinking(); add('agent', 'PINEAPPLE')
  add('you', 'Count from 1 to 300, one line each with a comment. Be thorough.'); added('tools'); thinking(); add('agent', '1 - one\n2 - two\n3 - three')
  add('action', 'Turn stopped before completion.', { kind: 'turn' })
  add('you', 'Stop counting. In one word, what did I first ask you to say?'); added('tools'); thinking(); add('agent', 'PINEAPPLE')
  for (let relaunch = 0; relaunch < 9; relaunch += 1) {
    add('you', 'In one word, what did I first ask you to say?'); added('history'); added('role'); added('tools'); add('agent', 'PINEAPPLE')
  }
  return rows
}
function pagingTranscripts(all, id, reads) {
  return {
    list: async () => ({ ok: true, records: [{ nodeId: id }] }),
    // shell/node-transcript-store.cjs read(): the newest `limit` (at most 100) before the cursor.
    read: async ({ nodeId, before = null, limit = 60, strictBefore = false, includeRecoveryFiles = false }) => {
      reads.push({ nodeId, before, limit, strictBefore })
      if (nodeId !== id) return { ok: true, metadata: null, entries: [], before: null }
      const cursor = before ? all.findIndex(entry => entry.id === before) : -1
      if (strictBefore && before && cursor < 0) return { ok: false, error: { code: 'MC_AGENT_TRANSCRIPT_CURSOR_INVALID', message: 'cursor' } }
      const files = cursor >= 0 ? all.slice(0, cursor) : all
      const page = files.slice(-Math.max(1, Math.min(100, Number(limit) || 60)))
      return { ok: true, metadata: { nodeId }, entries: structuredClone(page), before: files.length > page.length ? page[0].id : null,
        count: all.length, ...(includeRecoveryFiles ? { recoveryDirectory: '/saved/seat' } : {}) }
    },
    append: async () => ({ ok: true }),
    bind: async () => ({ ok: true }),
    release: async () => ({ ok: true, released: true }),
    onError: () => () => {},
  }
}

test('on the real page a restored tab with more than 60 saved entries still hands over its opening request (c5, soak B4)', async t => {
  const id = solo(6)
  const all = pineappleRecord()
  assert.equal(all.length, 63, 'fixture premise: the 63-entry record the soak profile had')
  const reads = []
  const fixture = await mountComputers(t, { nodes: [{ id: 'node-1-live', role: 'worker' }], agents: [{ id: 'controller', role: 'controller', enabled: true }, orgSeat(id)],
    seed: storage => {
      storage.setItem(STANDALONE_TABS_PREFIX + COMPUTER_ID, listOne(id))
      globalThis.window.mcTranscripts = pagingTranscripts(all, id, reads)
      // What a first send asks the host before it starts (the stand-in page bridge has only start/close/send).
      const owner = { version: 1, ownerId: 'restore-fixture-owner', currentEpoch: 'restore-epoch', kind: 'local' }
      Object.assign(globalThis.window.mcAgent, { availability: async () => ({ ok: true }), confinement: async () => ({ ok: true, tier: 'standard' }),
        interrupt: async () => ({ ok: true }), onEvent: () => () => {}, ownerContext: async () => owner, onOwnerContextChanged: () => () => {} })
      storage.setItem('mc.write.agent-session', 'enabled')
    } })
  await settleMounted()
  const record = fixture.graph?.workspace?.standalone.get(id)
  assert.equal(Boolean(record), true, 'fixture premise: the tab open at quit came back')
  const panel = record.chatPanel.querySelector('[data-chat-panel]')
  // The tab shows its newest page, as before: the display is not the handoff.
  assert.equal(panel.querySelectorAll('.me').some(node => node.textContent.includes(PINEAPPLE_ASK)), false,
    'the tab now draws more than its newest 60 entries')
  const input = record.chatPanel.querySelector('.chat-input textarea')
  input.value = 'In one word, what did I first ask you to say?'
  input.dispatch('input')
  panel.querySelector('.chat-send').click()
  await settleMounted()
  const start = fixture.operations.find(row => row.name === 'start')?.request
  assert.equal(Boolean(start), true, 'fixture premise: the first send started a session')
  const handoff = start.historyHandoff || ''
  assert.equal(handoff.includes(`The person said: ${PINEAPPLE_ASK}`), true,
    'THE DEFECT: the opening request is not in what the new session was handed, so it answers that nothing was asked')
  assert.equal(handoff.includes('Older messages were left out'), false,
    'THE DEFECT: the handoff says older messages were left out to fit, with the whole conversation far inside the budget')
  assert.equal(handoff.includes('added by ToolsEnabled'), false, 'context ToolsEnabled added was handed over as the person\'s words')
  assert.equal(reads.some(read => read.nodeId === id && read.strictBefore === true && read.before === all[3].id), true,
    'the older entries were not read from the tab\'s own cursor')
})

test('reading a restored conversation back to the budget: bounded pages, and the shown lines stay the newest page (c5)', async () => {
  const { createNodeTranscriptClient, RESTORE_PAGE_LIMIT } = await import('../../src/node-transcript-client.js')
  const { TRANSCRIPT_LIMITS } = await import('../../src/session-transcript-store.js')
  const id = 'standalone-seat-1'
  // A conversation far longer than any budget: every entry is conversation.
  const all = Array.from({ length: 5000 }, (_, n) => ({ id: `${String(n).padStart(16, '0')}.json`, who: n % 2 ? 'agent' : 'you', text: `line ${n} `.padEnd(40, '.'), at: n + 1 }))
  const reads = []
  const client = createNodeTranscriptClient({ computerId: 'local', bridge: pagingTranscripts(all, id, reads) })
  await client.ready
  const full = await client.readLatest(id, { speechChars: TRANSCRIPT_LIMITS.seedMaxChars })
  const speech = full.lines.reduce((sum, line) => sum + line.text.length, 0)
  assert.equal(speech >= TRANSCRIPT_LIMITS.seedMaxChars, true, `the read stopped before the budget (${speech} characters)`)
  assert.equal(speech < TRANSCRIPT_LIMITS.seedMaxChars + 100 * 40, true, 'the read went a page past the budget')
  assert.equal(full.lines.at(-1).id, all.at(-1).id)
  assert.equal(full.before, full.lines[0].id, 'the cursor names where the older entries start')
  assert.equal(client.get(id).lines.length, 60, 'the shown conversation grew past the newest page')
  assert.equal(client.get(id).lines[0].id, all.at(-60).id)
  // A record that is mostly context ToolsEnabled added stops at the page bound, not at the start of time.
  const noisy = Array.from({ length: 5000 }, (_, n) => ({ id: `${String(n).padStart(16, '0')}.json`, who: 'you', text: 'x', at: n + 1, promptSource: 'toolsenabled', promptKind: 'tools' }))
  const noisyReads = []
  const other = createNodeTranscriptClient({ computerId: 'local', bridge: pagingTranscripts(noisy, id, noisyReads) })
  await other.ready
  const bounded = await other.readLatest(id, { speechChars: TRANSCRIPT_LIMITS.seedMaxChars })
  assert.equal(Number.isSafeInteger(RESTORE_PAGE_LIMIT) && RESTORE_PAGE_LIMIT > 0, true)
  assert.equal(noisyReads.filter(read => read.before).length, RESTORE_PAGE_LIMIT, 'the older pages are not bounded')
  assert.equal(typeof bounded.before, 'string', 'a read stopped by its bound still says older entries exist')
  // Without a budget the read is the newest page, as every other caller has it.
  const plain = await client.readLatest(id)
  assert.equal(plain.lines.length, 60)
})
