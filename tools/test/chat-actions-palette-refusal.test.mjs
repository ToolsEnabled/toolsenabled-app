import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

/* AN EMPTY ACTIONS MENU AND A MENU THAT COULD NOT BE BUILT.
 *
 * MEASURED 2026-09-03, driving the running app over the outside-control port
 * (tooling/live/resume-circle.mjs): press a tree circle, press Actions, read
 * the popup's rows back. Every circle answered `rows: []`, and the driver
 * turned that into "no Resume row on this circle's palette" -- a claim about
 * the product, made from an absence, on a product that has a Resume row
 * (RESUME_PANEL.action, built by chatActionRowsFor in src/views/computers.js).
 *
 * The popup's `actions()` is the caller's own function and it can throw. The
 * catch in openActions wrote an empty list and said nothing, so "the list
 * could not be built" and "this agent has nothing you can do" arrived at the
 * eye, at the ear and at a driver as the same answer. These are behaviour
 * tests: they mount buildChat with real option values and drive the filter a
 * person types into, because the filter is what turned the refusal into
 * nothing at all on the run that was measured. */

import { installDomStandIn } from './lib/dom-stand-in.mjs'

installDomStandIn()

const { buildChat } = await import('../../src/components.js')
const { ACTIONS_BUILD_FAILED, actionsBuildFailedWhy } = await import('../../src/chat-copy.js')
const { PALETTE_PANEL, RESUME_PANEL, recordRailVerbElsewhere } = await import('../../src/fleet-tree-copy.js')

const mount = (actions) => {
  const chat = buildChat({ title: 'Lane', history: [{ who: 'agent', text: 'hello' }], seed: 0, actions })
  document.body.appendChild(chat)
  return chat
}

/* What the outside driver reads, in its own shape: the rows that are not the
   popup's Back row, each with the label, whether it can be pressed, and the
   sentence for why it cannot. */
const rowsOf = chat => [...chat.querySelectorAll('.chat-actions-row')]
  .filter(row => !row.classList.contains('chat-actions-back'))
  .map(row => ({
    label: (row.children[0]?.textContent || '').trim(),
    disabled: row.disabled === true,
    why: row.querySelector('.chat-actions-why')?.textContent || '',
  }))

const typeFilter = (chat, text) => {
  const filter = chat.querySelector('.chat-actions-filter')
  filter.value = text
  filter.dispatch('input')
  return filter
}

/* WHAT THE PERSON IS TOLD IS A CODE THIS PRODUCT WROTE, OR NOTHING.
 *
 * This test used to throw a plain Error and require its MESSAGE to arrive on
 * screen. tools/test/agent-session-surface.test.mjs forbids exactly that in
 * this file -- "the chat window must not put an Error's own message on screen:
 * on this channel that message is the machine code" -- so the two tests
 * contradicted each other, and the one that ran the product was winning: a
 * renderer fault put "Cannot read properties of undefined" in front of a
 * person as the reason their menu was empty.
 *
 * Both intents survive here. THE FAILURE IS STILL ALWAYS SHOWN, which is what
 * this test exists for and is asserted below exactly as before. What changed is
 * the detail: a bounded code is quoted, anything else is withheld and the
 * sentence says it gave no reason. The remedy -- close the menu and open it
 * again -- is unchanged and is what the person actually acts on. */
test('a palette whose builder throws says so, and no filter can hide it', () => {
  const chat = mount(() => { throw new Error('the tree store went away') })
  chat.openActions()

  /* A plain Error carries no code, so nothing of it is quoted. */
  const expected = actionsBuildFailedWhy(null)
  assert.deepEqual(rowsOf(chat), [{ label: ACTIONS_BUILD_FAILED, disabled: true, why: expected }],
    'a palette that could not be built still reports as a palette with nothing in it')
  assert.equal(chat.querySelector('.chat-actions-out').textContent, expected,
    'the status line, which is what a screen reader hears, says nothing about the failure')

  /* The measured path: the driver types the verb it wants before reading the
     rows. A refusal a filter can remove is a refusal that comes back as []. */
  typeFilter(chat, 'resume')
  assert.deepEqual(rowsOf(chat).map(row => row.label), [ACTIONS_BUILD_FAILED],
    'filtering removed the refusal, so the palette answers `rows: []` again')
})

test('a refusal this product named is quoted, because that one a person can act on', () => {
  /* The counterpart to the case above. When the builder throws something this
     product itself named -- a bounded identifier from the closed vocabulary
     shell/agent-facade.cjs describes -- withholding it would lose the one
     useful thing in the failure. */
  const named = Object.assign(new Error('internal prose nobody should read'), { code: 'TREE_STORE_UNAVAILABLE' })
  const chat = mount(() => { throw named })
  chat.openActions()

  const expected = actionsBuildFailedWhy('TREE_STORE_UNAVAILABLE')
  assert.deepEqual(rowsOf(chat), [{ label: ACTIONS_BUILD_FAILED, disabled: true, why: expected }])
  assert.equal(chat.querySelector('.chat-actions-out').textContent, expected)
  assert.ok(!expected.includes('internal prose'),
    'the code was quoted and the machine prose beside it was not')
})

test('a palette that builds keeps its own rows, and Resume survives the filter', () => {
  const chat = mount(() => [
    { id: 'stop', label: PALETTE_PANEL.stop, hint: PALETTE_PANEL.stopHint, enabled: true, run() {} },
    { id: 'resume', label: RESUME_PANEL.action, hint: RESUME_PANEL.hint, enabled: true, run() {} },
  ])
  chat.openActions()

  assert.deepEqual(rowsOf(chat).map(row => row.label), [PALETTE_PANEL.stop, RESUME_PANEL.action])
  assert.equal(chat.querySelector('.chat-actions-out').textContent, '',
    'a healthy palette announced a failure it did not have')

  typeFilter(chat, 'resume')
  assert.deepEqual(rowsOf(chat).map(row => row.label), [RESUME_PANEL.action],
    'the row the outside driver presses is no longer reachable by typing the verb')
})

test('the palette recovers: the next open that builds shows the real rows', () => {
  let broken = true
  const chat = mount(() => {
    if (broken) throw new Error('storage was busy')
    return [{ id: 'resume', label: RESUME_PANEL.action, enabled: true, run() {} }]
  })

  chat.openActions()
  assert.deepEqual(rowsOf(chat).map(row => row.label), [ACTIONS_BUILD_FAILED])

  broken = false
  chat.openActions()
  assert.deepEqual(rowsOf(chat).map(row => row.label), [RESUME_PANEL.action],
    'one failed build made the refusal permanent for the life of this chat')
})

/* ---------- the fleet-record rail's three switched-off buttons ---------- */

test('the record rail sends Resume and Respawn to the row that performs them', () => {
  const resumeWhy = recordRailVerbElsewhere(RESUME_PANEL.action)
  assert.ok(resumeWhy.includes(RESUME_PANEL.action), 'the reason no longer names the row that really resumes')
  assert.match(resumeWhy, /not an agent in your tree/)
  /* The false premise this replaced: "nothing can be paused, so nothing can be
     resumed". Resume is its own verb and never depended on pause. */
  assert.doesNotMatch(resumeWhy, /paus/i, 'resume is being explained as a consequence of pause again')

  const respawnWhy = recordRailVerbElsewhere(PALETTE_PANEL.clear)
  assert.ok(respawnWhy.includes(PALETTE_PANEL.clear), 'the reason no longer names the row that really starts it over')
  /* The mechanism this replaced appeared nowhere else in the repository. */
  assert.doesNotMatch(respawnWhy, /supervisor sweep/i)
})

test('the record rail builds those two reasons from the rows, not from its own words', () => {
  const view = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
  const table = view.slice(view.indexOf('const DEAD_ACTIONS'), view.indexOf('function deadActionButtons'))
  assert.ok(table.length > 0, 'the switched-off lifecycle table moved; this pin is aimed at nothing')
  assert.match(table, /id: 'resume'[\s\S]*?recordRailVerbElsewhere\(RESUME_PANEL\.action\)/,
    'Resume’s reason went back to a hand-written sentence that can drift from the row')
  assert.match(table, /id: 'respawn'[\s\S]*?recordRailVerbElsewhere\(PALETTE_PANEL\.clear\)/,
    'Respawn’s reason went back to a hand-written sentence that can drift from the row')
  assert.doesNotMatch(table, /supervisor sweep/i)
  assert.doesNotMatch(table, /nothing can be paused/i)
})


test('open actions follow turn status without losing the filter or popup', () => {
  let busy = true, changed
  const chat = buildChat({ title: 'Lane', seed: 0, history: [{ who: 'agent', text: 'hello' }],
    status: { busy: () => busy, subscribe: listener => { changed = listener; return () => {} } },
    actions: () => [{ id: 'interrupt', label: 'Interrupt', enabled: busy,
      disabledHint: busy ? null : 'There is no running turn.', run() {} }],
  })
  document.body.appendChild(chat)
  try {
    chat.openActions()
    const popup = chat.querySelector('.chat-actions-pop')
    const filter = typeFilter(chat, 'inter')
    assert.equal(rowsOf(chat)[0].disabled, false)
    busy = false; changed()
    assert.equal(chat.querySelector('.chat-actions-pop'), popup)
    assert.equal(chat.querySelector('.chat-actions-filter'), filter)
    assert.equal(filter.value, 'inter')
    assert.equal(rowsOf(chat)[0].disabled, true)
    assert.equal(rowsOf(chat)[0].why, 'There is no running turn.')
    busy = true; changed()
    assert.equal(rowsOf(chat)[0].disabled, false)
  } finally { chat.dispose?.(); chat.remove() }
})
