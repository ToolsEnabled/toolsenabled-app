/* TWO DEFECTS A NEW USER MEETS ON THE WAY TO THEIR FIRST AGENT.
 *
 * Both were found by driving the SHIPPED installer (ToolsEnabled Setup 1.0.20)
 * on a fresh profile, not by reading source, and both are the same mistake in
 * two places: the product knows something and shows the person nothing.
 *
 * ONE -- A BLANK BUTTON IN THE START-AN-AGENT PANEL.
 *
 * src/agent-compose-panel.js builds `unavailableAction` -- the "turn the switch
 * on" way out of a stated absence -- and marks it `hidden` until a caller hands
 * over an action it can actually perform. On a healthy install no caller does,
 * so it must never be seen. MEASURED in the packaged window, on the panel that
 * opens from the "+" node:
 *
 *     hidden attribute .. true
 *     computed display .. flex          <- not none
 *     textContent ...... ""
 *     painted rect ..... 349x40 at (1049, 299)
 *     elementFromPoint . the button itself
 *
 * -- a blank, pressable, full-width control in the middle of the panel a person
 * fills in to start their first agent. The cause is the cascade, not the module:
 * `[hidden] { display: none }` is a USER-AGENT rule, and `.ctl-btn` in
 * src/styles.css sets `display: flex` as an AUTHOR rule, which beats it. The
 * button wears both classes.
 *
 * THIS IS THE THIRD TIME. src/cloud.css and home.css each carry a comment about
 * the same trap and each fixed it for their own corner
 * (`.board-cloud-box .ctl-btn[hidden]`). Fixing it per-corner is why it keeps
 * coming back, so the guard belongs beside the rule that causes it.
 *
 * TWO -- "THE APPLICATION DID NOT SAY WHY", WHEN IT DID.
 *
 * The folder question in setup calls `mcSetup.chooseWorkspace()`. That bridge
 * answers in TWO different shapes and only one of them was ever read:
 *
 *   a refused folder      { ok: false, code, reason, resolved }   <- read
 *   anything that THREW   { ok: false, error: { code, message } } <- dropped
 *
 * The second is what `withFleetProfileSender` (shell/main.cjs) returns for every
 * exception in that handler. MEASURED on a fresh profile: the reply was
 *     { ok: false, error: { code: 'MC_FLEET_PROFILE_ACTION_FAILED',
 *                           message: "Failed to get 'documents' path" } }
 * and the screen said "That folder cannot be used -- The application did not say
 * why." It had been told why, in a sentence, and threw it away.
 *
 * capability/src/lib/setup/workspace.js says the rule this breaks in its own
 * words: "every refusal here has to be explainable to the person who chose the
 * folder. 'That folder cannot be used' with no reason is the shape that makes
 * someone pick a worse one."
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { setupRefusalDetail } from '../../src/setup-profile-settings.js'
import { mountAgentComposePanel } from '../../src/agent-compose-panel.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '..', '..', 'src')
const read = name => readFileSync(path.join(SRC, name), 'utf8')
const domStandInUrl = process.env.DOM_STAND_IN_MODULE
  ? pathToFileURL(process.env.DOM_STAND_IN_MODULE).href
  : new URL('./lib/dom-stand-in.mjs', import.meta.url).href
const { createDocument } = await import(domStandInUrl)

/* ---------- one: the blank button ---------- */

/* This deliberately small cascade evaluator answers the question the defect is
   about rather than requiring one particular selector or declaration layout.
   It covers ordinary class/attribute selectors and the author-versus-UA origin
   involved here; unsupported selectors simply do not match this fixture. */
function displayedAs(css, { classes = [], attributes = [] }) {
  let winner = { specificity: -1, order: -1, value: attributes.includes('hidden') ? 'none' : 'inline-block' }
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  let order = 0
  for (const rule of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const display = rule[2].match(/(?:^|;)\s*display\s*:\s*([^;!}]+)/i)?.[1]?.trim()
    if (!display) continue
    for (const rawSelector of rule[1].split(',')) {
      const selector = rawSelector.trim()
      const wantedClasses = [...selector.matchAll(/\.([\w-]+)/g)].map(match => match[1])
      const wantedAttributes = [...selector.matchAll(/\[([\w-]+)(?:[^\]]*)\]/g)].map(match => match[1])
      if (/[:#>+~]/.test(selector.replace(/\[[^\]]*\]/g, ''))) continue
      if (!wantedClasses.every(name => classes.includes(name))) continue
      if (!wantedAttributes.every(name => attributes.includes(name))) continue
      const specificity = wantedClasses.length + wantedAttributes.length
      if (specificity > winner.specificity || (specificity === winner.specificity && order > winner.order)) {
        winner = { specificity, order, value: display }
      }
    }
    order += 1
  }
  return winner.value
}

test('a ctl-btn marked hidden is not painted', () => {
  assert.equal(displayedAs(read('styles.css'), { classes: ['ctl-btn'], attributes: ['hidden'] }), 'none',
    'a hidden ctl-btn computes to a painted display value instead of none')
})

test('the compose panel starts without painting an unavailable action', () => {
  const doc = createDocument()
  const container = doc.createElement('div')
  const panel = mountAgentComposePanel({ doc, container, onSubmit: () => {}, onCancel: () => {} })
  assert.ok(panel, 'the compose panel mount returned no panel handle')
  const root = panel.element()
  assert.ok(root, 'the compose panel mount returned no panel root')
  const action = root.querySelector('[data-compose-unavailable-action="panel"]')
  assert.ok(action, 'the compose panel has no unavailable-action control')
  assert.equal(root.ownerDocument, doc, 'the compose panel root belongs to a different document')
  assert.equal(action.ownerDocument, doc, 'the unavailable action belongs to a different document')
  assert.equal(root.contains(action), true, 'the unavailable action is not parented under the compose panel root')
  assert.equal(action.hasAttribute('hidden'), true, 'the unavailable action does not retain its hidden attribute')
  const actionAttributes = [...action.attributes.keys()]
  assert.equal(actionAttributes.includes('hidden'), true, 'the display fixture did not observe the hidden attribute')
  assert.equal(displayedAs(read('styles.css'), {
    classes: action.className.split(/\s+/),
    attributes: actionAttributes,
  }), 'none', 'the compose panel paints its unavailable action before a caller supplies one')
  assert.equal(root.parentNode, container, 'the compose panel root is not parented by its mount container')
  panel.destroy()
  assert.equal(container.children.includes(root), false, 'destroy left the saved compose panel root in its mount container')
  assert.equal(root.parentNode, null, 'destroy left the saved compose panel root linked to its mount container')
})

/* ---------- two: the dropped reason ---------- */

test('a refusal that arrives in the shell error shape still says why', () => {
  const shellShape = { ok: false, error: { code: 'MC_FLEET_PROFILE_ACTION_FAILED', message: "Failed to get 'documents' path" } }
  assert.equal(setupRefusalDetail(shellShape), "Failed to get 'documents' path")
})

test('a refusal that arrives in the workspace-check shape still says why', () => {
  const checkShape = { ok: false, code: 'SETUP_WORKSPACE_DRIVE_ROOT_REFUSED', reason: 'That is the top of a whole drive. Choose a folder inside it instead.' }
  assert.equal(setupRefusalDetail(checkShape), 'That is the top of a whole drive. Choose a folder inside it instead.')
})

test('the reason is preferred over the fallback, and the fallback is only for a truly silent refusal', () => {
  assert.equal(setupRefusalDetail({ ok: false }), 'The application did not say why.')
  assert.equal(setupRefusalDetail(null), 'The application did not say why.')
  assert.equal(setupRefusalDetail({ ok: false, error: {} }), 'The application did not say why.')
})

test('a bare identifier is not a sentence, so it does not stand in for one', () => {
  /* src/refusal-copy.js refuses these for the same reason: MC_SOMETHING_FAILED
     on the glass is not an explanation, it is a code with no reader. */
  assert.equal(setupRefusalDetail({ ok: false, error: { message: 'MC_FLEET_PROFILE_ACTION_FAILED' } }), 'The application did not say why.')
  assert.equal(setupRefusalDetail({ ok: false, reason: 'SETUP_WORKSPACE_MISSING' }), 'The application did not say why.')
})

test('both screens that ask the folder question read the refusal the same way', () => {
  const walkthrough = read(path.join('views', 'setup.js'))
  const settings = read('setup-profile-settings.js')
  for (const [name, source] of [['src/views/setup.js', walkthrough], ['src/setup-profile-settings.js', settings]]) {
    assert.match(source, /setupRefusalDetail\(/,
      `${name} reads the chooseWorkspace refusal its own way again; two readers is how one of them came to miss the shell's error shape`)
    assert.ok(!/\?\.reason \|\| 'The application did not say why\.'/.test(source),
      `${name} still falls back straight off .reason, which drops the shell's { error: { message } } shape`)
  }
})
