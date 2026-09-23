/* THE SWITCH THAT PUTS START BACK, IN THE PLACE THE QUESTION WAS ASKED.
 *
 * Setup's cautious answer switches off starting an assistant, and it is meant
 * to: the owner's rule is that his recorded answer stands until HE changes it.
 * What it must not do is leave a person looking at the panel they wanted with a
 * sentence naming a screen they now have to go and find. The panel carries the
 * switch.
 *
 * THE TWO PROPERTIES THAT PULL AGAINST EACH OTHER, and both are pinned here:
 *   nothing is written until the press          (his rule)
 *   the press is enough, with no restart        (his ask)
 *
 * planNodeChatbox-style: the panel is a real DOM module, so its public seam is
 * mounted into a minimal document and DRIVEN. The view checks below still read
 * source because their rules remain closure-private; they need a callable seam
 * before those checks can be converted without pretending to exercise them.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'

import {
  COMPOSE_ACTION_COULD_NOT_TELL,
  COMPOSE_ACTION_COULD_NOT_TELL_SENTENCE,
  mountAgentComposePanel,
} from '../../src/agent-compose-panel.js'

const here = fileURLToPath(import.meta.url)
const ROOT = dirname(dirname(dirname(here)))
const view = readFileSync(join(ROOT, 'src', 'views', 'computers.js'), 'utf8')

/* The smallest document the panel really uses. Kept here rather than pulled
   from a helper so a change in what the panel touches shows up as a failure in
   this file instead of somewhere shared. */
function fakeDocument() {
  const make = (tag) => {
    const node = {
      tagName: String(tag).toUpperCase(),
      children: [],
      attributes: new Map(),
      listeners: new Map(),
      className: '',
      textContent: '',
      value: '',
      type: '',
      disabled: false,
      style: {},
      appendChild(child) { node.children.push(child); child.parentNode = node; return child },
      insertBefore(child) { node.children.unshift(child); child.parentNode = node; return child },
      removeChild(child) { node.children = node.children.filter(entry => entry !== child); return child },
      remove() { node.parentNode?.removeChild(node) },
      setAttribute(name, value) { node.attributes.set(name, String(value)) },
      getAttribute(name) { return node.attributes.has(name) ? node.attributes.get(name) : null },
      removeAttribute(name) { node.attributes.delete(name) },
      hasAttribute(name) { return node.attributes.has(name) },
      addEventListener(name, fn) {
        if (!node.listeners.has(name)) node.listeners.set(name, [])
        node.listeners.get(name).push(fn)
      },
      removeEventListener(name, fn) {
        node.listeners.set(name, (node.listeners.get(name) || []).filter(entry => entry !== fn))
      },
      dispatch(name, event = {}) { for (const fn of node.listeners.get(name) || []) fn(event) },
      focus() { node.focused = true },
      get firstChild() { return node.children[0] || null },
      querySelector() { return null },
      querySelectorAll() { return [] },
      set innerHTML(value) { if (value === '') node.children = [] },
      get innerHTML() { return '' },
      get classList() {
        return {
          add: (name) => { if (!node.className.split(' ').includes(name)) node.className = `${node.className} ${name}`.trim() },
          remove: (name) => { node.className = node.className.split(' ').filter(entry => entry !== name).join(' ') },
          contains: (name) => node.className.split(' ').includes(name),
          toggle: (name, on) => { if (on) node.classList.add(name); else node.classList.remove(name) },
        }
      },
    }
    return node
  }
  return { createElement: make, createTextNode: (text) => ({ textContent: text }) }
}

const walk = (node, hit, found = []) => {
  if (hit(node)) found.push(node)
  for (const child of node.children || []) walk(child, hit, found)
  return found
}

const findByAttribute = (root, name) => walk(root, node => node.attributes?.has(name))[0] || null

function mount({ unavailableReason, startUnavailableReason, unavailableAction }) {
  const doc = fakeDocument()
  const container = doc.createElement('div')
  const panel = mountAgentComposePanel({ doc, container, unavailableReason, startUnavailableReason, unavailableAction, onSubmit: () => {} })
  return { panel, container }
}

test('a stated absence with no way out draws no button at all', () => {
  /* A missing application is a real reason Start is switched off and it is not
     one a press could change. A control that cannot work is worse than the
     sentence alone; Set remains the separate usable path. */
  const { container } = mount({ startUnavailableReason: 'There is no installed application behind this page.', unavailableAction: null })
  const button = findByAttribute(container, 'data-compose-unavailable-action')
  assert.ok(button, 'the panel no longer builds the control at all')
  assert.equal(button.getAttribute('hidden'), 'hidden', 'a reason this page cannot undo is offering a button anyway')
  assert.equal(button.textContent, '', 'a hidden control is still carrying words')
})

test('a reason the caller can undo draws the switch, with the caller\'s words', () => {
  const { container } = mount({
    startUnavailableReason: 'Starting an assistant is switched off for this computer.',
    unavailableAction: { label: 'Turn on running agents', run: () => true },
  })
  const button = findByAttribute(container, 'data-compose-unavailable-action')
  assert.equal(button.getAttribute('hidden'), null, 'the switch is hidden beside a reason it can clear')
  assert.equal(button.textContent, 'Turn on running agents')
  assert.equal(button.disabled, false)
})

test('NOTHING is written until the press -- the owner\'s rule, as a test', () => {
  let ran = 0
  const { container, panel } = mount({
    startUnavailableReason: 'Starting an assistant is switched off for this computer.',
    unavailableAction: { label: 'Turn on running agents', run: () => { ran += 1; return true } },
  })
  // Mounting, rendering and reopening must all leave the recorded answer alone.
  panel.open({})
  assert.equal(ran, 0, 'the panel ran the write without anybody pressing anything')
  const button = findByAttribute(container, 'data-compose-unavailable-action')
  button.dispatch('click', {})
  assert.equal(ran, 1, 'the press did not reach the write')
})

test('the press puts Start back in place, with no second journey', async () => {
  const { container } = mount({
    startUnavailableReason: 'Starting an assistant is switched off for this computer.',
    unavailableAction: { label: 'Turn on running agents', run: () => true },
  })
  findByAttribute(container, 'data-compose-unavailable-action').dispatch('click', {})
  await new Promise(resolve => setTimeout(resolve, 0))
  const submit = walk(container, node => node.className.includes('agent-compose-submit'))[0]
  assert.ok(submit, 'the panel lost its Start control')
  assert.equal(submit.disabled, false, 'Start is still switched off after the switch was thrown')
  const notice = findByAttribute(container, 'data-compose-notice')
  assert.equal(notice.getAttribute('hidden'), 'hidden', 'the reason is still on screen after it stopped being true')
  const button = findByAttribute(container, 'data-compose-unavailable-action')
  assert.equal(button.getAttribute('hidden'), 'hidden', 'the switch is still offering itself after it was thrown')
})

test('a write that did not take leaves the panel exactly as it was', async () => {
  /* The flag store can refuse -- storage switched off in a browser keeps the
     old answer. Reporting a switch that did not move would put a live Start
     over a computer that still refuses every start. */
  const { container } = mount({
    startUnavailableReason: 'Starting an assistant is switched off for this computer.',
    unavailableAction: { label: 'Turn on running agents', run: () => false },
  })
  findByAttribute(container, 'data-compose-unavailable-action').dispatch('click', {})
  await new Promise(resolve => setTimeout(resolve, 0))
  const submit = walk(container, node => node.className.includes('agent-compose-submit'))[0]
  assert.equal(submit.disabled, true, 'Start came back over a switch that never moved')
  const button = findByAttribute(container, 'data-compose-unavailable-action')
  assert.equal(button.getAttribute('hidden'), null, 'the switch withdrew itself without having worked')
  assert.equal(button.disabled, false, 'the switch cannot be pressed again after failing once')
})

test('a run that cannot tell is distinct from a proved unchanged switch and is not latched', async () => {
  let attempts = 0
  const { container } = mount({
    startUnavailableReason: 'Starting an assistant is switched off for this computer.',
    unavailableAction: { label: 'Turn on running agents', run: () => {
      attempts += 1
      // No Error and no code: even this must not become the definite `false`.
      throw { machineWasBusy: true }
    } },
  })
  const button = findByAttribute(container, 'data-compose-unavailable-action')
  button.dispatch('click', {})
  await new Promise(resolve => setTimeout(resolve, 0))
  const submit = walk(container, node => node.className.includes('agent-compose-submit'))[0]
  assert.equal(submit.disabled, true, 'a thrown write left Start enabled')
  const notice = findByAttribute(container, 'data-compose-notice')
  assert.equal(notice.getAttribute('data-compose-error-code'), COMPOSE_ACTION_COULD_NOT_TELL)
  assert.equal(notice.textContent, COMPOSE_ACTION_COULD_NOT_TELL_SENTENCE)
  assert.match(notice.textContent, /does not mean/i, 'the could-not-tell sentence claims the old absence is fact')
  assert.equal(button.disabled, false, 'a could-not-tell result was latched and cannot be retried')
  button.dispatch('click', {})
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(attempts, 2, 'the could-not-tell result was cached instead of asking again')
})

test('clearing one absence can reveal another, and the panel says the new one', async () => {
  /* Measured case: the flag is checked BEFORE the bridge, so a page open in a
     browser showed the flag's sentence over a second, equally real absence. */
  const revealed = 'This page is open in a browser, not in the installed application.'
  const { container } = mount({
    startUnavailableReason: 'Starting an assistant is switched off for this computer.',
    unavailableAction: { label: 'Turn on running agents', run: () => revealed },
  })
  findByAttribute(container, 'data-compose-unavailable-action').dispatch('click', {})
  await new Promise(resolve => setTimeout(resolve, 0))
  const notice = findByAttribute(container, 'data-compose-notice')
  assert.equal(notice.textContent, revealed, 'the panel kept the old sentence over a new reason')
  const submit = walk(container, node => node.className.includes('agent-compose-submit'))[0]
  assert.equal(submit.disabled, true, 'Start came back over a page that still cannot start anything')
})

/* ---------------------------------------------------------------
   And the view offers it for the one reason it can actually undo.
   --------------------------------------------------------------- */

test('the view offers the switch only for the switched-off flag', () => {
  const fn = declaredFunctionSource(view, 'composeUnavailableAction')
  // The authoritative projection is read-only too; the local switch cannot
  // make that projection writable. Keep all three current refusal conditions.
  assert.match(fn, /if \(mockSource\(\) \|\| treeStoreProblem \|\| authoritativeTreeSnapshot\) return null/, 'the switch is offered on the example fleet, over an unreadable forest, or on an authoritative projection')
  assert.match(fn, /if \(isWriteEnabled\(START_CONTROL_FLAG\)\) return null/, 'the switch is offered when nothing is switched off')
  assert.match(fn, /setWriteEnabled\(START_CONTROL_FLAG, true\)/, 'the press no longer writes the recorded answer')
  assert.match(fn, /if \(!isWriteEnabled\(START_CONTROL_FLAG\)\) \{ composeToRestore = null; return false \}/, 'the write is reported without being read back')
  assert.match(fn, /return composeUnavailableReason\(\) \|\| composeStartUnavailableReason\(\) \|\| true/,
    'the panel is not re-asked for both full and Start-only reasons after the press')
})

test('the panel survives the page rebuild its own switch causes', () => {
  /* MEASURED on a staged build before this existed: the press wrote the flag,
     src/write-flags.js announced it, src/main.js re-rendered the whole route on
     a microtask, and the panel the person was standing in was destroyed. Start
     "came back" on a page they were no longer on -- a restart in everything but
     name, and the owner asked for no restart. */
  assert.match(view, /let composeToRestore = null/, 'nothing carries the open panel across the rebuild')
  const run = declaredFunctionSource(view, 'composeUnavailableAction')
  assert.ok(
    run.indexOf('composeToRestore = detail') !== -1
      && run.indexOf('composeToRestore = detail') < run.indexOf('setWriteEnabled(START_CONTROL_FLAG, true)'),
    'the panel is recorded after the write that destroys it, which is too late',
  )
  assert.match(run, /composeToRestore = null; return false/, 'a write that did not take still leaves a panel queued to reopen')
  const mount = view.slice(view.indexOf('if (composeToRestore) {'), view.indexOf('if (composeToRestore) {') + 300)
  assert.match(mount, /composeToRestore = null/, 'the rebuilt view does not clear what it consumed; a later visit inherits a panel nobody asked for')
  assert.match(mount, /openComposeFor\(resume\)/, 'the rebuilt view never reopens the panel')
})

test('the write goes through the one writer these rows have', () => {
  /* setWriteEnabled is the single writer (src/write-flags.js), which is what
     makes this panel and the Settings control incapable of disagreeing. A
     second write path here would be the "user setting that is a lie" defect. */
  /* The import may carry more names from the same module (WRITE_FLAGS_EVENT
     arrived 2026-08-20 so the view can hear the teardown its own switch
     causes); what this test pins is that the WRITER is write-flags.js's, and
     the count below still pins that there is exactly one call to it. */
  assert.match(view, /import \{ [^}]*\bsetWriteEnabled\b[^}]* \} from '\.\.\/write-flags\.js'/, 'the view writes the flag some other way')
  const writes = view.match(/setWriteEnabled\(/g) || []
  assert.equal(writes.length, 1, 'a second write path appeared; the two surfaces can now disagree')
})

test('both surfaces name the switch with one string', () => {
  const session = readFileSync(join(ROOT, 'src', 'agent-session.js'), 'utf8')
  const profile = readFileSync(join(ROOT, 'src', 'setup-profile.js'), 'utf8')
  assert.match(profile, /export const START_CONTROL_ON = Object\.freeze\(\{/, 'the shared label is gone')
  assert.match(session, /\$\{START_CONTROL_ON\.label\}/, 'the agent page went back to its own copy of the words')
  assert.match(view, /label: START_CONTROL_ON\.label/, 'the fleet page went back to its own copy of the words')
})
