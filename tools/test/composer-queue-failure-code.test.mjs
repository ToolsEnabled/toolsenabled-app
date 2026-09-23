/* THE QUEUE'S FAILURE DOORS THREW THE REASON AWAY THE SAME WAY THE SEND DOOR DID.
 *
 * Three doors in buildChat could fail and each was written the same way:
 *
 *     try { outcome = queue.sendNow(entry.id) } catch { outcome = null }
 *     try { held    = queue.hold(request)    } catch { held    = null }
 *     try { queued  = queue.add(v)           } catch { queued  = null }
 *
 * A bare `catch {}` does not bind the throw, so when one of these threw the
 * person got the flat QUEUE_FAILED sentence and nothing anywhere recorded WHICH
 * failure it was. These doors can genuinely throw: session-outbox.js writes
 * through localStorage, which throws on quota and on a store the browser has
 * blocked.
 *
 * WHAT MUST NOT MOVE, and what the controls here hold still: the ordinary
 * {ok:false, sentence} path. session-outbox.js carries no `code` on any of its
 * refusals, so on that path there is no identifier to record and the attribute
 * must be ABSENT rather than empty. Only the throw path gains anything.
 *
 * The Send-now hold door is not driven here. It needs the Page 2 hold adapter
 * that chat-queue-doors.test.mjs constructs, and it runs the identical
 * refusalCodeFromThrown/markRefusalCode pair as the two doors below; that is a
 * shared-helper argument, not a measurement, and is stated rather than implied.
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
const { QUEUE_FAILED, QUEUE_PROMOTE_FAILED } = await import('../../src/chat-copy.js')

const mounted = new Set()
afterEach(() => {
  for (const root of mounted) root.dispose()
  mounted.clear()
})

// A busy composer over a queue whose doors behave however the test asks. The
// list is real enough to paint the strip, which is what puts the row controls
// on screen.
function mount({ rows = [], add = null, sendNow = null } = {}) {
  const entries = rows.map((text, index) => ({ id: `row-${index + 1}`, text }))
  const root = buildChat({
    title: 'agent',
    seed: 0,
    status: { busy: () => true, subscribe: () => () => {} },
    chips: {},
    queue: {
      list: () => entries.map(entry => ({ ...entry })),
      add: add || (text => { entries.push({ id: `row-${entries.length + 1}`, text }); return { ok: true } }),
      cancel: () => ({ ok: true }),
      sendNow: sendNow || (() => ({ ok: true, sentence: 'Moved to the front.' })),
    },
    onSend: () => {},
  })
  mounted.add(root)
  return { root, input: root.querySelector('.chat-input input') }
}

const noteOf = root => root.querySelectorAll('.msg').find(node => /\bnote\b/.test(node.className)) || null

const identifierError = code => {
  const error = new Error(code)
  error.code = code
  return error
}

/* ------------------------------------------------------------------ enqueue */

test('an enqueue that THROWS records the identifier and still says what it always said', () => {
  const fixture = mount({ add: () => { throw identifierError('OUTBOX_WRITE_REFUSED') } })
  fixture.input.value = 'hello'
  fixture.root.querySelector('.chat-send').dispatch('click')
  const note = noteOf(fixture.root)
  assert.ok(note, 'a throwing enqueue painted no note at all')
  assert.equal(note.textContent, QUEUE_FAILED, 'the words a person reads changed')
  assert.equal(note.getAttribute('data-refusal-code'), 'OUTBOX_WRITE_REFUSED',
    'the throw was discarded, so this failure cannot be told apart from any other afterwards')
})

test('an enqueue REFUSAL keeps its own sentence and records no code', () => {
  // The control that holds the ordinary path still. session-outbox.js puts no
  // code on its refusals, so an identifier here would be invented.
  const refusal = { ok: false, sentence: 'This agent already has 20 messages waiting. Let it answer some first.' }
  const fixture = mount({ add: () => refusal })
  fixture.input.value = 'hello'
  fixture.root.querySelector('.chat-send').dispatch('click')
  const note = noteOf(fixture.root)
  assert.equal(note.textContent, refusal.sentence, 'the outbox sentence was replaced by the generic one')
  assert.equal(note.getAttribute('data-refusal-code'), null,
    'a code was recorded for a refusal that carries none')
})

test('an enqueue that throws ordinary English records no code rather than a fake one', () => {
  const fixture = mount({ add: () => { throw new Error('the browser blocked local storage') } })
  fixture.input.value = 'hello'
  fixture.root.querySelector('.chat-send').dispatch('click')
  const note = noteOf(fixture.root)
  assert.equal(note.textContent, QUEUE_FAILED)
  assert.equal(note.getAttribute('data-refusal-code'), null,
    'prose was recorded in the field support reads as an identifier')
})

/* ------------------------------------------------------------- the row door */

test('a Send next that THROWS records the identifier on its note', () => {
  const fixture = mount({
    rows: ['alpha'],
    sendNow: () => { throw identifierError('OUTBOX_PROMOTE_REFUSED') },
  })
  const row = fixture.root.querySelectorAll('.chat-queue-row')[0]
  assert.ok(row, 'the strip painted no row, so the door under test was never on screen')
  row.querySelector('.chat-queue-next').dispatch('click')
  const note = noteOf(fixture.root)
  assert.ok(note, 'a throwing Send next painted no note at all')
  /* The promote door has its own sentence: the message WAS queued and it is the
     move that failed, so the enqueue wording would contradict the strip the
     person is looking at. */
  assert.equal(note.textContent, QUEUE_PROMOTE_FAILED)
  assert.equal(note.getAttribute('data-refusal-code'), 'OUTBOX_PROMOTE_REFUSED')
})

test('a Send next that REFUSES keeps its own sentence and records no code', () => {
  const refusal = { ok: false, sentence: 'That message is no longer waiting; it has already gone or been removed.' }
  const fixture = mount({ rows: ['alpha'], sendNow: () => refusal })
  fixture.root.querySelectorAll('.chat-queue-row')[0].querySelector('.chat-queue-next').dispatch('click')
  const note = noteOf(fixture.root)
  assert.equal(note.textContent, refusal.sentence)
  assert.equal(note.getAttribute('data-refusal-code'), null)
})

test('a Send next that SUCCEEDS still says where the message went', () => {
  const fixture = mount({ rows: ['alpha'], sendNow: () => ({ ok: true, sentence: 'Moved to the front.' }) })
  fixture.root.querySelectorAll('.chat-queue-row')[0].querySelector('.chat-queue-next').dispatch('click')
  const note = noteOf(fixture.root)
  assert.equal(note.textContent, 'Moved to the front.')
  assert.equal(note.getAttribute('data-refusal-code'), null)
})
