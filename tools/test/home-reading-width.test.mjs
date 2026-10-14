/* THE READING WIDTH, DRIVEN RATHER THAN READ.
 *
 * R1206, the owner: "in the chat window when a user resizes it we should use
 * up all the space, right now the text doesnt expand ato full size."
 *
 * src/home-chat.css already carried the wide mode --
 * `.home-takeover[data-reading-width="wide"]` fills the window and drops
 * the text max-width -- and nothing in the app ever wrote that attribute, so
 * the rule was unreachable and the measured behaviour was "the text does not
 * grow". These drive the MOUNTED view: they click the control a person clicks
 * and observe the attribute the stylesheet keys on. None of them reads
 * src/views/home.js, so a rewrite that keeps the behaviour keeps them green.
 *
 *   node --test tools/test/home-reading-width.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { mount, restoreGlobals, stored } from './helpers/home-view-harness.mjs'

const KEY = 'mc.home.chat-width'
const homeChatCss = readFileSync(new URL('../../src/home-chat.css', import.meta.url), 'utf8')
const chatContentCss = readFileSync(new URL('../../src/chat-content.css', import.meta.url), 'utf8')

/* The FIRST top-level `selector { ... }` body for an exact selector string --
   the same helper tools/test/chat-reading-measure.test.mjs uses, so the two
   suites cannot come to disagree about how a rule is read. */
function ruleBody(css, selector) {
  const needle = `${selector} {`
  const start = css.indexOf(needle)
  if (start === -1) return null
  const openBrace = start + needle.length - 1
  const close = css.indexOf('}', openBrace)
  if (close === -1) return null
  return css.slice(openBrace + 1, close)
}

const readingMax = selector => {
  const body = ruleBody(homeChatCss, selector)
  const found = body && /--reading-max:\s*([0-9.]+)px/.exec(body)
  return found ? Number(found[1]) : null
}

const surface = view => view.el.querySelector('[data-chat-takeover]')
const control = view => view.el.querySelector('[data-chat-width]')
const forget = () => stored.delete(KEY)
/* This harness's elements carry `dispatch(name, event)` rather than a DOM
   `click()`; pressing through it runs the same listener a person's click runs. */
const press = node => node.dispatch('click')

test('the control is on the glass, not merely in the source', async () => {
  /* Not an assertion about width -- an assertion that the tests below are
     looking at something. Every one of them is vacuous if this is null. */
  forget()
  const { view } = await mount()
  try {
    assert.ok(control(view), 'the reading width control must be mounted')
  } finally { view.destroy() }
})

test('with nothing saved the surface reports the narrow measure', async () => {
  forget()
  const { view } = await mount()
  try {
    assert.equal(surface(view).dataset.readingWidth, 'narrow',
      'the stylesheet keys on this attribute; leaving it unset is what made the wide rule unreachable')
    assert.equal(control(view).getAttribute('aria-pressed'), 'false')
    assert.equal(control(view).textContent.trim(), 'Narrow')
  } finally { view.destroy() }
})

test('clicking reaches the attribute the stylesheet keys on, and the choice is saved', async () => {
  forget()
  const { view } = await mount()
  try {
    press(control(view))
    assert.equal(surface(view).dataset.readingWidth, 'wide')
    assert.equal(control(view).getAttribute('aria-pressed'), 'true')
    assert.equal(control(view).textContent.trim(), 'Wide')
    assert.equal(stored.get(KEY), 'wide', 'the choice must outlive the screen')

    press(control(view))
    assert.equal(surface(view).dataset.readingWidth, 'narrow', 'the control must go both ways')
    assert.equal(control(view).getAttribute('aria-pressed'), 'false')
    assert.equal(stored.get(KEY), 'narrow')
  } finally { view.destroy(); forget() }
})

test('a saved wide choice is already in force the next time the screen is built', async () => {
  stored.set(KEY, 'wide')
  const { view } = await mount()
  try {
    assert.equal(surface(view).dataset.readingWidth, 'wide')
    assert.equal(control(view).getAttribute('aria-pressed'), 'true')
    assert.equal(control(view).textContent.trim(), 'Wide')
  } finally { view.destroy(); forget() }
})

test('an unrecognised saved width is not treated as a choice', async () => {
  stored.set(KEY, 'enormous')
  const { view } = await mount()
  try {
    assert.equal(surface(view).dataset.readingWidth, 'narrow',
      'a stale or damaged saved value must fall back to the default, not reach the attribute')
  } finally { view.destroy(); forget() }
})

test('the wide attribute unlocks a genuinely wider measure', () => {
  const narrow = readingMax('.home-takeover')
  assert.ok(Number.isFinite(narrow) && narrow > 0, 'Narrow must declare a bounded reading measure')
  const wide = ruleBody(homeChatCss, '.home-takeover[data-reading-width="wide"]')
  assert.match(wide, /--reading-max:\s*100%/, 'Wide uses the available window width')

})

test('wide relaxes the paragraph cap, or the wider container changes nothing a person sees', () => {
  /* Vacuity guard first: this means nothing if the cap it is about is gone.
     chat-content.css caps the markdown paragraph at 72ch, narrower than the
     wide measure, so widening the container alone would leave the text exactly
     where it was -- which is the owner's actual complaint. */
  const capped = ruleBody(chatContentCss, '.chat-message-body .md-p')
  assert.match(capped ?? '', /max-width:\s*72ch/,
    'this test is vacuous if the paragraph cap is gone -- re-derive it rather than deleting this')

  const relaxed = ruleBody(homeChatCss,
    '.home-takeover[data-reading-width="wide"] .chat-message-body :is(.md-p, .md-list)')
  assert.match(relaxed ?? '', /max-width:\s*none/,
    'the wide mode must relax the paragraph measure as well as the container')
})

test.after(restoreGlobals)
