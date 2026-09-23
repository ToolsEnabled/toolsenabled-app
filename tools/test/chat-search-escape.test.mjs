import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { treeChatShelfFixture } from './lib/tree-chat-shelf-fixture.mjs'

test('Search Escape restores the transcript before a later Escape hides the workspace and preserves its draft', async t => {
  const { graph, document, addCard } = treeChatShelfFixture(t, () => ({
    history: [{ who: 'agent', text: 'alpha search match' }, { who: 'agent', text: 'beta unrelated message' }],
    onAttach: async () => ({ ok: true, path: '/fixture/unsent-image.png' }),
  }))
  const record = addCard('manager')
  const chat = record.chatRoot, panel = record.chatPanel
  const composer = chat.querySelector('.chat-input input')
  composer.value = 'KEEP_SEARCH_DRAFT'
  chat.querySelector('[data-chat-attach]').dispatch('click')
  await new Promise(resolve => setTimeout(resolve, 0))
  const toggle = chat.querySelector('.chat-search-toggle')
  toggle.dispatch('click')
  const search = chat.querySelector('.chat-search input')
  search.value = 'alpha'
  search.dispatch('input')
  const messages = chat.querySelectorAll('.msg')
  assert.equal(messages.filter(message => message.hidden).length, 1)
  const escape = search.dispatch('keydown', { key: 'Escape' })
  assert.equal(escape.defaultPrevented, true)
  assert.equal(chat.querySelector('.chat-search').hidden, true)
  assert.ok(messages.every(message => !message.hidden))
  assert.equal(record.chatOpen, true, 'Closing search must not reach the containing tree conversation')
  assert.equal(panel.parentNode, graph.chatTrack)
  assert.equal(composer.value, 'KEEP_SEARCH_DRAFT')
  assert.equal(chat.querySelectorAll('.chat-attachment-chip').length, 1)
  assert.equal(document.activeElement, toggle, 'Focus must return to the visible search control')
  toggle.dispatch('keydown', { key: 'Escape' })
  assert.equal(graph.chatShelf.hidden, true, 'A later Escape hides the containing workspace')
  assert.equal(record.chatOpen, true, 'Hiding must not close the conversation')
  assert.equal(record.chatRoot, chat)
  assert.equal(panel.parentNode, graph.chatTrack)
  assert.equal(composer.value, 'KEEP_SEARCH_DRAFT')
  assert.equal(chat.querySelectorAll('.chat-attachment-chip').length, 1)
})

const compositionSignals = [
  ['active composition', { isComposing: true }],
  ['composition boundary', { isComposing: false, keyCode: 229 }],
]

for (const [label, flags] of compositionSignals) {
  for (const surface of ['composer', 'search']) test(`${label}: Escape keeps the ${surface} and containing conversation open`, t => {
    const { graph, document, addCard } = treeChatShelfFixture(t)
    const record = addCard('manager')
    const chat = record.chatRoot
    if (surface === 'search') chat.querySelector('.chat-search-toggle').click()
    const input = chat.querySelector(surface === 'search' ? '.chat-search input' : '.chat-input input')
    input.value = '変換中'
    input.focus()
    const event = input.dispatch('keydown', { key: 'Escape', ...flags, defaultPrevented: false })
    assert.equal(event.defaultPrevented, false, 'native composition must receive Escape')
    assert.equal(graph.chatShelf.hidden, false, 'the containing workspace must ignore the same key')
    assert.equal(record.chatOpen, true)
    assert.equal(input.value, '変換中')
    assert.equal(document.activeElement, input)
    if (surface === 'search') assert.equal(chat.querySelector('.chat-search').hidden, false)
    input.dispatch('keydown', { key: 'Escape' })
    if (surface === 'search') {
      assert.equal(chat.querySelector('.chat-search').hidden, true)
      assert.equal(graph.chatShelf.hidden, false)
    } else assert.equal(graph.chatShelf.hidden, true, 'a deliberate later Escape still hides chat')
  })
}

// The main module and nested Computers callbacks are not importable alone.
// Execute their actual listener registrations with inert closure boundaries;
// no hand-copied handler or source-pattern verdict stands in for behavior.
const mainSource = readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8')
const computersSource = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
function sourceRange(source, startText, endText) {
  const start = source.indexOf(startText), end = source.indexOf(endText, start)
  assert.ok(start >= 0 && end > start, 'production listener boundaries must be present')
  return source.slice(start, end)
}
function execute(source, bindings) { return new Function(...Object.keys(bindings), source)(...Object.values(bindings)) }
function keyEvent(flags = {}) {
  return { key: 'Escape', defaultPrevented: false, stopped: false, ...flags,
    preventDefault() { this.defaultPrevented = true }, stopPropagation() { this.stopped = true } }
}

for (const [label, flags] of compositionSignals) {
  test(`${label}: the settings drawer neither closes nor traps a composition key`, () => {
    let onKeydown, closed = 0, focused = 0
    const last = { hasAttribute: () => false, tabIndex: 0, offsetParent: {}, focus() { focused++ } }
    const first = { ...last }
    const registration = sourceRange(mainSource, "document.addEventListener('keydown', (e) => {", '/* The drawer has no scrim')
    execute(registration, {
      document: { activeElement: last, addEventListener(type, fn) { assert.equal(type, 'keydown'); onKeydown = fn } },
      drawerOpen: true, closeDrawer: () => { closed++ },
      drawer: { querySelectorAll: () => [first, last] }, FOCUSABLE: 'fixture',
    })
    for (const key of ['Escape', 'Tab']) {
      const event = keyEvent({ ...flags, key })
      onKeydown(event)
      assert.equal(event.defaultPrevented, false)
    }
    assert.equal(closed, 0)
    assert.equal(focused, 0)
    onKeydown(keyEvent({ key: 'Tab' }))
    assert.equal(focused, 1, 'normal Tab still wraps focus')
    onKeydown(keyEvent())
    assert.equal(closed, 1, 'normal Escape still closes the drawer')
  })

  test(`${label}: the Computers capture handler leaves the contact dialog open`, () => {
    let closed = 0
    const handler = sourceRange(computersSource, '  const onRailEscape = (event) => {', "  document.addEventListener('keydown', onRailEscape, true)")
    const onKeydown = execute(handler + '\nreturn onRailEscape', {
      agentScreenVoice: { el: { open: true } }, closeAgentContact: () => { closed++ },
    })
    const event = keyEvent(flags)
    onKeydown(event)
    assert.equal(event.defaultPrevented, false)
    assert.equal(closed, 0)
    onKeydown(keyEvent())
    assert.equal(closed, 1)
  })

  test(`${label}: the rail chat keeps focus while cancelling composition`, () => {
    let onKeydown, blurred = 0
    const start = computersSource.indexOf('  function mountRailChat(')
    assert.ok(start >= 0)
    const registration = sourceRange(computersSource.slice(start), "    host.addEventListener('keydown', (event) => {", '\n    render()')
    execute(registration, { host: { addEventListener(type, fn) { assert.equal(type, 'keydown'); onKeydown = fn } } })
    const target = { closest: () => ({}), blur() { blurred++ } }
    const event = keyEvent({ ...flags, target })
    onKeydown(event)
    assert.equal(event.stopped, false)
    assert.equal(blurred, 0)
    onKeydown(keyEvent({ target }))
    assert.equal(blurred, 1)
  })
}
