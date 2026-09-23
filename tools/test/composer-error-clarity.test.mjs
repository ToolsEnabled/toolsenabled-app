/* WHAT THE COMPOSER SAYS WHEN A SEND OR A QUEUE ACTION FAILS.
 *
 * Three defects in the visible wording, none of them about which condition
 * fires. Each is pinned from both sides: the false claim must be gone, and the
 * true one must be present.
 *
 * 1. SEND_FAILED said "this screen was not told why". That stopped being true
 *    when de68a1f2 began recording the refusal identifier on the note: the
 *    screen IS told, it deliberately does not show the person a machine code.
 *    Claiming ignorance the product no longer has is the kind of sentence that
 *    survives into a support conversation and misdirects it.
 *
 * 2. A rejected send leaves the person's words ON SCREEN as their own bubble --
 *    deliverTurn paints it optimistically and the .catch does NOT retract it
 *    (only `fail` does, and only when asked). So the person reads "That did not
 *    send" directly beneath the message they just sent, with nothing saying
 *    whether it arrived. The words must say the agent did not receive it.
 *
 * 3. QUEUE_FAILED said "That was not queued" at all three queue doors. It is
 *    only true at ONE of them. At the Send next door and the Send-now hold door
 *    the message was already queued and it is the MOVE that failed -- telling
 *    someone their message was not queued, when it is sitting in the strip in
 *    front of them, contradicts what they can see.
 *
 * The enqueue door keeps its own sentence and gains the fact that the words are
 * still in the composer, which is true there and false at the other two: on a
 * failed enqueue `send()` never clears input.value.
 */

import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { pathToFileURL } from 'node:url'

const moduleUrl = process.env.DOM_STAND_IN_MODULE
  ? pathToFileURL(process.env.DOM_STAND_IN_MODULE).href
  : new URL('./lib/dom-stand-in.mjs', import.meta.url).href
const { installDomStandIn } = await import(moduleUrl)
const { restore } = installDomStandIn(globalThis)

const previousStorage = globalThis.localStorage
const saved = new Map()
globalThis.localStorage = {
  getItem: key => saved.get(key) ?? null,
  setItem: (key, value) => saved.set(key, String(value)),
  removeItem: key => saved.delete(key),
}
after(() => {
  restore()
  if (previousStorage === undefined) delete globalThis.localStorage
  else globalThis.localStorage = previousStorage
})

const { buildChat } = await import('../../src/components.js')
const copy = await import('../../src/chat-copy.js')

const mounted = new Set()
afterEach(() => {
  for (const root of mounted) root.dispose()
  mounted.clear()
})

function mount({ busy = false, rows = [], add = null, sendNow = null, onSend = () => {} } = {}) {
  const entries = rows.map((text, index) => ({ id: `row-${index + 1}`, text }))
  const root = buildChat({
    title: 'agent',
    seed: 0,
    status: { busy: () => busy, subscribe: () => () => {} },
    chips: {},
    queue: {
      list: () => entries.map(entry => ({ ...entry })),
      add: add || (text => { entries.push({ id: `row-${entries.length + 1}`, text }); return { ok: true } }),
      cancel: () => ({ ok: true }),
      sendNow: sendNow || (() => ({ ok: true, sentence: 'Moved to the front.' })),
    },
    onSend,
  })
  mounted.add(root)
  return { root, input: root.querySelector('.chat-input input') }
}

const noteOf = root => root.querySelectorAll('.msg').find(node => /\bnote\b/.test(node.className)) || null
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }

/* ------------------------------------------------- 1 and 2: the send door */

test('a failed send no longer claims the screen was not told why', () => {
  assert.doesNotMatch(copy.SEND_FAILED, /not told why/i,
    'the product records the refusal identifier now, so claiming it was not told why is false')
})

test('a failed send says the agent did not receive the message', () => {
  assert.match(copy.SEND_FAILED, /did not (receive|reach)/i,
    'the words stay on screen as the person\'s own bubble, so the sentence must resolve whether they arrived')
})

test('a failed send still says what to do next', () => {
  assert.match(copy.SEND_FAILED, /try/i, 'a failure sentence that names no next step leaves the person stuck')
})

test('no visible composer failure sentence carries an internal identifier', () => {
  const IDENTIFIER = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/
  for (const name of ['SEND_FAILED', 'QUEUE_FAILED', 'QUEUE_PROMOTE_FAILED', 'QUEUE_HOLD_FAILED']) {
    const sentence = copy[name]
    assert.equal(typeof sentence, 'string', `${name} is missing`)
    assert.doesNotMatch(sentence, IDENTIFIER, `${name} shows an internal identifier to the person`)
  }
})

test('the rejected send paints exactly the sentence, and no code', async () => {
  const failure = new Error('AGENT_TURN_ACTIVE')
  failure.code = 'AGENT_TURN_ACTIVE'
  const fixture = mount({ onSend: () => Promise.reject(failure) })
  fixture.input.value = 'hello'
  fixture.root.querySelector('.chat-send').dispatch('click')
  await settle()
  const note = noteOf(fixture.root)
  assert.equal(note.textContent, copy.SEND_FAILED)
  assert.ok(!note.textContent.includes('AGENT_TURN_ACTIVE'))
  assert.equal(note.getAttribute('data-refusal-code'), 'AGENT_TURN_ACTIVE',
    'the identifier still belongs on the node even though it is not in the words')
})

/* ------------------------------------------------ 3: the three queue doors */

test('the enqueue sentence says the words are still in the composer', () => {
  assert.match(copy.QUEUE_FAILED, /still in the (box|composer)/i,
    'on a failed enqueue send() never clears the input, and the person cannot tell that from the old wording')
})

test('the promote and hold sentences do not claim the message was never queued', () => {
  for (const name of ['QUEUE_PROMOTE_FAILED', 'QUEUE_HOLD_FAILED']) {
    assert.doesNotMatch(copy[name], /not queued/i,
      `${name} is shown for a message already sitting in the strip; saying it was not queued contradicts the screen`)
    assert.match(copy[name], /still waiting/i,
      `${name} must say where the message actually is`)
  }
})

test('a throwing enqueue shows the enqueue sentence', () => {
  const fixture = mount({ busy: true, add: () => { throw new Error('nope') } })
  fixture.input.value = 'hello'
  fixture.root.querySelector('.chat-send').dispatch('click')
  assert.equal(noteOf(fixture.root).textContent, copy.QUEUE_FAILED)
})

test('a throwing Send next shows the promote sentence, not the enqueue one', () => {
  const fixture = mount({ busy: true, rows: ['alpha'], sendNow: () => { throw new Error('nope') } })
  fixture.root.querySelectorAll('.chat-queue-row')[0].querySelector('.chat-queue-next').dispatch('click')
  assert.equal(noteOf(fixture.root).textContent, copy.QUEUE_PROMOTE_FAILED)
})

test('an outbox refusal still speaks in its own words at every door', () => {
  const refusal = { ok: false, sentence: 'This agent already has 20 messages waiting. Let it answer some first.' }
  const fixture = mount({ busy: true, add: () => refusal })
  fixture.input.value = 'hello'
  fixture.root.querySelector('.chat-send').dispatch('click')
  assert.equal(noteOf(fixture.root).textContent, refusal.sentence,
    'the outbox sentence was replaced by a generic one')
})
