/* A SEND THAT FAILED THROUGH THE CATCH LEFT NOTHING TO NAME IT BY.
 *
 * buildChat has two doors for a turn that did not send. `fail` writes the
 * sender's sentence AND records the identifier on the note it creates:
 *
 *     const note = addMsg('note', String(text))
 *     if (code && note) note.dataset.refusalCode = code
 *
 * The `.catch` beside it did neither. It was written `.catch(() => {`, so the
 * rejection was never bound to a name, and it posted the flat SEND_FAILED
 * sentence with no identifier anywhere on the node. Every send that failed by
 * rejection rather than through `fail` was therefore indistinguishable from
 * every other one, afterwards, to a support conversation and to a probe.
 *
 * THE SENTENCE MUST NOT CHANGE, AND THAT IS THE POINT OF THE FIRST TEST HERE.
 * The catch's own comment explains why the error's message is not shown: on
 * this product's agent channel the message IS the machine code, and printing it
 * would put a bare identifier in front of a person through the one route
 * src/refusal-copy.js's scan cannot see. So the fix must be invisible on the
 * glass and visible only in the attribute, which is what these tests pin from
 * opposite sides.
 *
 * The prose test is the one that keeps the fix honest as the product grows: a
 * rejection whose message is ordinary English is NOT a code, and recording it
 * would put prose in a field support reads as an identifier. refusalCodeOf
 * draws that line, and markRefusalCode removes the attribute rather than
 * writing an empty one, so "there is no code" and "the code is blank" stay
 * different answers.
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
const { SEND_FAILED } = await import('../../src/chat-copy.js')

const mounted = new Set()
afterEach(() => {
  for (const root of mounted) root.dispose()
  mounted.clear()
})

// An idle composer whose send REJECTS. Nothing else here refuses, so the note
// that lands can only have come from the catch.
function mountRejecting(rejection) {
  const root = buildChat({
    title: 'agent',
    seed: 0,
    status: { busy: () => false, subscribe: () => () => {} },
    chips: {},
    onSend: () => Promise.reject(rejection),
  })
  mounted.add(root)
  return { root, input: root.querySelector('.chat-input input') }
}

// The rejection is handled a microtask later and the note is painted in the
// same tick. A few turns of the queue is enough and depends on no timer.
const settle = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

const noteOf = root => root.querySelectorAll('.msg').find(node => /\bnote\b/.test(node.className)) || null

async function sendAndSettle(fixture, text) {
  fixture.input.value = text
  fixture.root.querySelector('.chat-send').dispatch('click')
  await settle()
  return noteOf(fixture.root)
}

test('a rejected send says exactly what it always said, with no identifier on the glass', async () => {
  const failure = new Error('AGENT_TURN_ACTIVE')
  failure.code = 'AGENT_TURN_ACTIVE'
  const note = await sendAndSettle(mountRejecting(failure), 'hello')
  assert.ok(note, 'a rejected send painted no note at all')
  assert.equal(note.textContent, SEND_FAILED,
    'the words a person reads after a failed send changed; this fix must be invisible on the glass')
  assert.ok(!note.textContent.includes('AGENT_TURN_ACTIVE'),
    'the identifier reached the person, which is the one thing refusal-copy.js exists to prevent')
})

test('the identifier is recorded on the note, where support and a probe can read it', async () => {
  const failure = new Error('AGENT_TURN_ACTIVE')
  failure.code = 'AGENT_TURN_ACTIVE'
  const note = await sendAndSettle(mountRejecting(failure), 'hello')
  assert.equal(note.getAttribute('data-refusal-code'), 'AGENT_TURN_ACTIVE',
    'the rejection was discarded, so this failure cannot be told apart from any other afterwards')
})

test('an identifier carried only on the message is still recorded', async () => {
  // shell/main.cjs replaces a rejected call's error with one whose MESSAGE is
  // the identifier, so the common case on this channel has no `code` field at
  // all. A fix reading only `.code` would record nothing for it.
  const note = await sendAndSettle(mountRejecting(new Error('AGENT_SEND_REFUSED')), 'hello')
  assert.equal(note.getAttribute('data-refusal-code'), 'AGENT_SEND_REFUSED')
  assert.equal(note.textContent, SEND_FAILED)
})

test('a rejection that is ordinary English records no code rather than a fake one', async () => {
  const note = await sendAndSettle(mountRejecting(new Error('the network went away for a moment')), 'hello')
  assert.equal(note.getAttribute('data-refusal-code'), null,
    'prose was recorded in the field support reads as an identifier')
  assert.equal(note.textContent, SEND_FAILED)
})

test('a rejection with nothing on it at all is still reported to the person', async () => {
  const note = await sendAndSettle(mountRejecting(undefined), 'hello')
  assert.ok(note, 'a send that rejected with nothing told the person nothing')
  assert.equal(note.textContent, SEND_FAILED)
  assert.equal(note.getAttribute('data-refusal-code'), null)
})
