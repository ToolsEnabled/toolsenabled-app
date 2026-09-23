import test from 'node:test'
import assert from 'node:assert/strict'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { buildChat } from '../../src/components.js'

function mount(t, { busy = true, actions = null, chips = null } = {}) {
  const dom = installDomStandIn()
  // The stand-in bubbles through elements; capture document listeners at the
  // document boundary so the popup's real Escape handler can also be driven.
  const documentKeys = new Set()
  dom.document.addEventListener = (type, listener) => { if (type === 'keydown') documentKeys.add(listener) }
  dom.document.removeEventListener = (type, listener) => { if (type === 'keydown') documentKeys.delete(listener) }
  const queued = [], sent = []
  let stops = 0
  const root = buildChat({
    title: 'Enter repeat regression', seed: 0, actions, chips,
    status: { busy: () => busy },
    queue: { list: () => queued,
      add: text => { queued.push({ id: String(queued.length), text }); return { ok: true } },
      replace: (id, text) => { queued.find(row => row.id === id).text = text; return { ok: true } },
    },
    onSend: text => { sent.push(text); busy = true },
    onStop: async () => { stops++; return { ok: true, settled: true } },
  })
  dom.document.body.appendChild(root)
  const input = root.querySelector('.chat-input input')
  t.after(() => { root.dispose(); root.remove(); dom.restore() })
  return { root, input, queued, sent, stops: () => stops,
    documentKey(extra) {
      const event = { defaultPrevented: false, stopped: false,
        preventDefault() { this.defaultPrevented = true }, stopPropagation() { this.stopped = true }, ...extra }
      for (const listener of [...documentKeys]) listener(event)
      return event
    },
    enter: (extra = {}) => input.dispatch('keydown', { key: 'Enter', repeat: false, defaultPrevented: false, ...extra }) }
}
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

test('held Enter queues once without turning its repeat into Stop; a new Enter still stops', async t => {
  const f = mount(t)
  f.input.value = 'Follow up after this turn'
  f.enter()
  assert.deepEqual(f.queued.map(row => row.text), ['Follow up after this turn'])
  assert.equal(f.input.value, '')
  f.enter({ repeat: true })
  await settle()
  f.enter({ repeat: true })
  assert.equal(f.stops(), 0, 'auto-repeat from the queue gesture must not interrupt')
  assert.equal(f.sent.length, 0)
  f.enter()
  assert.equal(f.stops(), 1, 'a separate ordinary Enter on empty busy input remains Stop')
})

test('held Enter after an idle send never stops the accepted turn; the Stop button still works', async t => {
  const f = mount(t, { busy: false })
  f.input.value = 'Start this turn'
  f.enter()
  await settle()
  f.enter({ repeat: true })
  assert.equal(f.stops(), 0)
  assert.deepEqual(f.sent, ['Start this turn'])
  f.root.querySelector('.chat-send').dispatch('click', { detail: 1 })
  assert.equal(f.stops(), 1)
})

test('repeat cannot submit newly typed text; deliberate Shift+Enter still sends', async t => {
  const f = mount(t, { busy: false })
  f.input.value = 'Keep typing'
  f.enter({ repeat: true, shiftKey: true })
  await settle()
  assert.deepEqual(f.sent, [])
  assert.equal(f.input.value, 'Keep typing')
  f.enter({ shiftKey: true })
  await settle()
  assert.deepEqual(f.sent, ['Keep typing'])
})


test('repeated Enter leaves a recalled edit untouched until a deliberate submit', async t => {
  const f = mount(t)
  f.queued.push({ id: 'held', text: 'Already queued' })
  f.input.dispatch('keydown', { key: 'ArrowUp' })
  assert.equal(f.input.value, 'Already queued')
  f.input.value = 'Edited waiting message'
  f.enter({ repeat: true })
  f.enter({ repeat: true, shiftKey: true })
  await settle()
  assert.equal(f.queued[0].text, 'Already queued')
  assert.equal(f.input.value, 'Edited waiting message')
  assert.equal(f.stops(), 0)
  assert.deepEqual(f.sent, [])
  f.enter()
  assert.deepEqual(f.queued, [{ id: 'held', text: 'Edited waiting message' }])
})

// Composition confirmation is text entry, not a Send/Stop/Send now gesture.
// Some IMEs report the closing key after compositionend with keyCode 229.
for (const [signal, flags] of [
  ['active composition', { isComposing: true }],
  ['composition boundary', { isComposing: false, keyCode: 229 }],
]) {
  for (const busy of [false, true]) test(`${signal}: Enter keeps composed text until a separate submit (${busy ? 'busy' : 'idle'})`, async t => {
    const f = mount(t, { busy })
    f.input.value = '日本語の下書き'
    const event = f.enter(flags)
    await settle()
    assert.deepEqual(f.sent, [], 'confirming composition must not send a turn')
    assert.deepEqual(f.queued, [], 'confirming composition must not queue a draft')
    assert.equal(f.stops(), 0)
    assert.equal(f.input.value, '日本語の下書き')
    assert.equal(event.defaultPrevented, false, 'the IME must receive its confirmation key')
    f.enter()
    await settle()
    assert.deepEqual(busy ? f.queued.map(row => row.text) : f.sent, ['日本語の下書き'])
  })

  test(`${signal}: Enter on an empty busy composer does not stop the agent`, async t => {
    const f = mount(t)
    f.enter(flags)
    await settle()
    assert.equal(f.stops(), 0)
    f.enter()
    assert.equal(f.stops(), 1, 'a separate ordinary Enter still stops')
  })

  test(`${signal}: Shift+Enter does not interrupt or send the composition`, async t => {
    const f = mount(t)
    f.input.value = '変換中'
    f.enter({ ...flags, shiftKey: true })
    await settle()
    assert.equal(f.stops(), 0)
    assert.deepEqual(f.sent, [])
    assert.deepEqual(f.queued, [])
    assert.equal(f.input.value, '変換中')
  })

  test(`${signal}: candidate navigation does not recall a queued message`, t => {
    const f = mount(t)
    f.queued.push({ id: 'waiting', text: 'Already queued' })
    const event = f.input.dispatch('keydown', { key: 'ArrowUp', defaultPrevented: false, ...flags })
    assert.equal(f.input.value, '')
    assert.equal(event.defaultPrevented, false)
    f.input.dispatch('keydown', { key: 'ArrowUp' })
    assert.equal(f.input.value, 'Already queued')
  })

  for (const key of ['ArrowDown', 'Escape']) test(`${signal}: ${key} leaves a recalled draft and candidate selection alone`, t => {
    const f = mount(t)
    f.queued.push({ id: 'waiting', text: 'Already queued' })
    f.input.dispatch('keydown', { key: 'ArrowUp' })
    f.input.value = '編集中'
    const event = f.input.dispatch('keydown', { key, defaultPrevented: false, ...flags })
    assert.equal(f.input.value, '編集中')
    assert.equal(event.defaultPrevented, false)
    assert.deepEqual(f.queued, [{ id: 'waiting', text: 'Already queued' }])
  })

  test(`${signal}: slash and Shift+Tab stay with the input method`, t => {
    let cycles = 0
    const f = mount(t, { actions: () => [], chips: { onCycleTier: () => { cycles++ } } })
    for (const chord of [{ key: '/' }, { key: 'Tab', shiftKey: true }]) {
      const event = f.input.dispatch('keydown', { ...chord, ...flags, defaultPrevented: false })
      assert.equal(event.defaultPrevented, false)
    }
    assert.equal(f.root.querySelector('.chat-actions-pop'), null)
    assert.equal(cycles, 0)
    f.input.dispatch('keydown', { key: 'Tab', shiftKey: true })
    assert.equal(cycles, 1)
    f.input.dispatch('keydown', { key: '/' })
    assert.equal(f.root.querySelector('.chat-actions-filter').value, '/')
  })

  test(`${signal}: confirming a typed action does not run it`, async t => {
    const f = mount(t, { busy: false, actions: () => [] })
    f.root.openActions()
    const filter = f.root.querySelector('.chat-actions-filter')
    filter.value = '/Request 日本語'
    filter.dispatch('input')
    const event = filter.dispatch('keydown', { key: 'Enter', ...flags, defaultPrevented: false })
    await settle()
    assert.deepEqual(f.sent, [])
    assert.equal(filter.value, '/Request 日本語')
    assert.equal(event.defaultPrevented, false)
    assert.ok(f.root.querySelector('.chat-actions-pop'))
    filter.dispatch('keydown', { key: 'Enter' })
    await settle()
    assert.deepEqual(f.sent, ['/Request 日本語'])
  })

  test(`${signal}: candidate keys do not move or close the Actions menu`, t => {
    const f = mount(t, { actions: () => [
      { id: 'first', label: 'First action', enabled: true, run() {} },
      { id: 'second', label: 'Second action', enabled: true, run() {} },
    ] })
    f.root.openActions()
    const filter = f.root.querySelector('.chat-actions-filter')
    const selected = filter.getAttribute('aria-activedescendant')
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) {
      const event = filter.dispatch('keydown', { key, ...flags, defaultPrevented: false })
      assert.equal(event.defaultPrevented, false)
      assert.equal(filter.getAttribute('aria-activedescendant'), selected)
    }
    assert.equal(f.documentKey({ key: 'Escape', ...flags }).stopped, false)
    assert.ok(f.root.querySelector('.chat-actions-pop'))
    assert.equal(f.documentKey({ key: 'Escape' }).stopped, true)
    assert.equal(f.root.querySelector('.chat-actions-pop'), null)
  })

  test(`${signal}: cancelling composition preserves the transcript search`, t => {
    const f = mount(t)
    f.root.querySelector('.chat-search-toggle').click()
    const search = f.root.querySelector('.chat-search input')
    search.value = '検索中'
    const event = search.dispatch('keydown', { key: 'Escape', ...flags, defaultPrevented: false })
    assert.equal(event.defaultPrevented, false)
    assert.equal(f.root.querySelector('.chat-search').hidden, false)
    assert.equal(search.value, '検索中')
    search.dispatch('keydown', { key: 'Escape' })
    assert.equal(f.root.querySelector('.chat-search').hidden, true)
  })
}
