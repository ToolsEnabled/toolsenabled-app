/* REDRAW PATH 4: A TRANSCRIPT APPEND AND A STATUS TICK MUST NOT COST THE PERSON
 * WHAT THEY HAVE TYPED.
 *
 * Builder 4 covered the takeover re-render paths and named this one as not
 * driven (HANDOFF-B4-composer-redraw-retention-20260909.md, path 4): these are
 * buildChat-INTERNAL repaints that never rebuild the input element, so they can
 * only lose typing if something writes `input.value`. That has to be proved
 * against the real component rather than argued from a reading, and it needs
 * buildChat driven DIRECTLY with history/status/onReady, not through the
 * takeover, which builds its own config.
 *
 * WHY THIS FILE DEFINES A SELECTION API, AND WHY THAT IS THE WHOLE DIFFICULTY.
 *
 * The shared DOM stand-in models no browser selection. buildChat's exportDraft
 * reads `input.selectionStart`/`selectionEnd`, so without one those read
 * undefined, an assertion comparing undefined to undefined passes, and the test
 * measures nothing while looking green -- Builder 4 hit exactly this and said so.
 *
 * Defining the two properties is not enough on its own either. A real input
 * MOVES THE CARET TO THE END WHEN `.value` IS ASSIGNED. If this stand-in ignored
 * that, then a product that clobbered the composer mid-tick would still show an
 * unchanged caret here and the suite would clear it. So the `value` setter below
 * reproduces that behaviour, and `caret survival is measurable at all` proves it
 * is live before any retention case runs. That control is the reason the other
 * cases mean something.
 *
 * TEST ONLY. No product file is changed, and no status wording is touched: the
 * status strings are frozen on this line by the two crossing commits.
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

const mounted = new Set()
afterEach(() => {
  for (const root of mounted) root.dispose()
  mounted.clear()
})

/* The selection an <input> really has, including the part that matters here:
   assigning `.value` collapses the caret to the end of the new text. */
function installSelectionApi(input) {
  let text = String(input.value ?? '')
  let start = text.length
  let end = text.length
  Object.defineProperty(input, 'value', {
    configurable: true,
    get() { return text },
    set(next) { text = String(next ?? ''); start = text.length; end = text.length },
  })
  Object.defineProperty(input, 'selectionStart', {
    configurable: true, get() { return start }, set(v) { start = Number(v) || 0 },
  })
  Object.defineProperty(input, 'selectionEnd', {
    configurable: true, get() { return end }, set(v) { end = Number(v) || 0 },
  })
  input.setSelectionRange = (from, to) => { start = Number(from) || 0; end = Number(to) || 0 }
  return input
}

/* buildChat driven directly: real history, a real status object whose ticks this
   test fires by hand, and onReady for the root the product itself hands back. */
function mount({ busy = false } = {}) {
  const listeners = new Set()
  const state = { busy, sent: [] }
  let ready = null
  const root = buildChat({
    title: 'agent',
    seed: 0,
    history: [
      { from: 'me', text: 'first thing I said' },
      { from: 'them', text: 'the agent answering' },
    ],
    status: {
      busy: () => state.busy,
      subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    },
    chips: {},
    onAttach: async () => ({ ok: true, path: 'C:/pictures/diagram.png' }),
    onSend: text => { state.sent.push(text); },
    onReady: instance => { ready = instance },
  })
  mounted.add(root)
  const input = installSelectionApi(root.querySelector('.chat-input input'))
  return {
    root,
    input,
    ready,
    state,
    tick(next) {
      if (next !== undefined) state.busy = next
      for (const listener of [...listeners]) listener()
    },
    attachments: () => root.querySelectorAll('.chat-attachment-chip').length,
  }
}

/* Everything the person would lose, read through the product's own seam. */
const draftOf = root => root.exportDraft()

/* chooseAttachment is async, so the click has to settle before the chip exists.
   Returns the chip count so a caller can prove the fixture actually attached
   something before asserting that it survived. */
async function attach(fixture) {
  fixture.root.querySelector('[data-chat-attach]').dispatch('click')
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  return fixture.attachments()
}

function typeWithRange(fixture, text, from, to) {
  fixture.input.value = text
  fixture.input.setSelectionRange(from, to)
  return { text, start: from, end: to }
}

/* ------------------------------------------------------ the controls first */

test('onReady hands back the same root, so this suite drives the real component', () => {
  const fixture = mount()
  assert.equal(fixture.ready, fixture.root, 'onReady did not deliver the mounted chat')
  assert.ok(typeof fixture.root.exportDraft === 'function', 'exportDraft is missing; the assertions below would have no seam')
})

test('caret survival is measurable at all', () => {
  /* THE ANTI-VACUITY CONTROL. If this fails, every retention case below is
     meaningless, because the stand-in would report an unchanged caret no matter
     what the product did to the input. */
  const fixture = mount()
  typeWithRange(fixture, 'hello there', 2, 7)
  assert.equal(fixture.input.selectionStart, 2)
  assert.equal(fixture.input.selectionEnd, 7)
  assert.deepEqual(
    { start: draftOf(fixture.root).start, end: draftOf(fixture.root).end },
    { start: 2, end: 7 },
    'exportDraft does not see this suite\'s selection, so caret assertions would prove nothing')
  // Now the part that makes a clobber detectable: a real input collapses the
  // caret to the end when .value is assigned.
  fixture.input.value = 'hello there'
  assert.equal(fixture.input.selectionStart, 11, 'assigning .value did not move the caret, so a product clobber would go unnoticed')
})

test('the transcript really has entries to append to', () => {
  const fixture = mount()
  assert.ok(fixture.root.querySelectorAll('.msg').length >= 2, 'history did not render, so an append proves nothing')
})

/* ------------------------------------------------------- a status tick */

test('a status tick keeps the typed text, the caret RANGE and the attachment', async () => {
  const fixture = mount({ busy: false })
  assert.equal(await attach(fixture), 1, 'the attachment never landed, so its survival proves nothing')
  const wanted = typeWithRange(fixture, 'a message half written', 2, 9)

  fixture.tick(true)

  const draft = draftOf(fixture.root)
  assert.equal(draft.text, wanted.text, 'a status tick lost the typed text')
  assert.equal(draft.start, wanted.start, 'a status tick moved the start of the selection')
  assert.equal(draft.end, wanted.end, 'a status tick moved the end of the selection')
  assert.equal(fixture.attachments(), 1, 'a status tick dropped the attachment')
  assert.equal(draft.attachments.length, 1, 'a status tick dropped the attachment from the draft')
})

test('the send, queued and failed ticks each keep the draft whole', () => {
  /* The three status shapes this lane owns, driven one after another through the
     same subscription the product registers. */
  const fixture = mount({ busy: false })
  const wanted = typeWithRange(fixture, 'still typing this one', 4, 11)
  for (const busy of [true, false, true]) {
    fixture.tick(busy)
    const draft = draftOf(fixture.root)
    assert.equal(draft.text, wanted.text, `a tick to busy=${busy} lost the typed text`)
    assert.equal(draft.start, wanted.start, `a tick to busy=${busy} moved the selection start`)
    assert.equal(draft.end, wanted.end, `a tick to busy=${busy} moved the selection end`)
  }
})

test('repeated ticks with nothing typed invent nothing', () => {
  const fixture = mount()
  fixture.tick(true)
  fixture.tick(false)
  const draft = draftOf(fixture.root)
  assert.equal(draft.text, '', 'a tick put words in an empty composer')
  assert.equal(draft.attachments.length, 0, 'a tick invented an attachment')
})

/* -------------------------------------------------- a transcript append */

test('an owner-message append keeps the typed text, the caret range and the attachment', async () => {
  const fixture = mount()
  assert.equal(await attach(fixture), 1, 'the attachment never landed, so its survival proves nothing')
  const wanted = typeWithRange(fixture, 'words I have not sent yet', 6, 13)
  const before = fixture.root.querySelectorAll('.msg').length

  fixture.root.addOwnerMessage('something appended to the transcript')

  assert.ok(fixture.root.querySelectorAll('.msg').length > before, 'nothing was appended, so this proves nothing')
  const draft = draftOf(fixture.root)
  assert.equal(draft.text, wanted.text, 'a transcript append lost the typed text')
  assert.equal(draft.start, wanted.start, 'a transcript append moved the selection start')
  assert.equal(draft.end, wanted.end, 'a transcript append moved the selection end')
  assert.equal(fixture.attachments(), 1, 'a transcript append dropped the attachment chip')
  /* The painted chip can outlive the draft, so the array the send rides on is
     asserted too. A chip alone would keep this case green while the attachment
     had actually gone. */
  assert.equal(draft.attachments.length, 1, 'a transcript append dropped the attachment from the draft')
})

test('a thinking append keeps the draft whole', () => {
  const fixture = mount()
  const wanted = typeWithRange(fixture, 'mid sentence when it thought', 3, 12)
  fixture.root.addThinking('considering the question')
  const draft = draftOf(fixture.root)
  assert.equal(draft.text, wanted.text, 'a thinking append lost the typed text')
  assert.equal(draft.start, wanted.start)
  assert.equal(draft.end, wanted.end)
})

test('an append followed by a tick, the pair, keeps the draft whole', async () => {
  /* The real sequence: the agent says something and its status changes with it. */
  const fixture = mount({ busy: false })
  assert.equal(await attach(fixture), 1, 'the attachment never landed, so its survival proves nothing')
  const wanted = typeWithRange(fixture, 'typed across the whole exchange', 6, 17)

  fixture.root.addOwnerMessage('an appended line')
  fixture.tick(true)
  fixture.root.addThinking('working on it')
  fixture.tick(false)

  const draft = draftOf(fixture.root)
  assert.equal(draft.text, wanted.text, 'the append-and-tick sequence lost the typed text')
  assert.equal(draft.start, wanted.start, 'the sequence moved the selection start')
  assert.equal(draft.end, wanted.end, 'the sequence moved the selection end')
  assert.equal(fixture.attachments(), 1, 'the sequence dropped the attachment chip')
  assert.equal(draft.attachments.length, 1, 'the sequence dropped the attachment from the draft')
})
