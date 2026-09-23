/* THE PERSON'S HAND ON THE RULES PANEL -- Edit and a two-press Delete per entry.
 *
 * O7 improvements, the application half. Owner, 2026-08-22: "its a hand edit
 * tool. for the user to go in on the toolsenabled ledger and hand edit or
 * delete them. its literally exactly in line". The engine's r-ledger.js gained
 * PERSON-ONLY editRequest/removeRequest (one entry in place, a .bak beside the
 * file, a dated history line); the product reaches them through two
 * command-surface verbs and draws the controls in the rules panel.
 *
 * The panel's markup and presses live in src/tree-standing-requests.js
 * (createStandingRequestsPanel), pure over the body they are handed, so this
 * suite drives them against a stand-in body and a recording bridge:
 *
 *   MARKUP    every entry carries Edit and Delete, a hint slot, its words and
 *             its id line; a dotted child is drawn indented under its parent
 *             with "refinement of R3"; an agent-filed entry still names its
 *             author.
 *   DELETE    the first press ARMS -- the hint says exactly what the second
 *             press will do -- and sends nothing; the second press sends
 *             requestRemove ONCE with the id and the ledger key; a success
 *             re-reads the panel; a refusal is a sentence under the entry.
 *   EDIT      Edit turns the words into a text box with Save and Cancel;
 *             Save sends the new words verbatim (no trim) with the id and
 *             key; empty is refused before anything is sent; Cancel sends
 *             nothing; a success re-reads; a refusal keeps the box open with
 *             the draft and the sentence.
 *   PERSON    the controls are renderer-drawn; no agent has a path to them,
 *             and the host refuses the verbs from any principal that is not
 *             the window or the consenting relay (pinned in
 *             agent-command-surface.test.mjs; the source pin here holds the
 *             view to the shared module).
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  REQUEST_PANEL,
  createStandingRequestsPanel,
  standingRequestsMarkup,
  standingRequestsPanelFor,
} from '../../src/tree-standing-requests.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/* Placeholder words only -- no fixture here carries a remark of the owner's. */
const GROUPS = Object.freeze([
  { scope: 'global', entries: [
    { id: 'R2000', words: 'Placeholder global rule one.' },
    { id: 'R2000.1', words: 'Placeholder refinement of global rule one.' },
  ] },
  { scope: 'tree', entries: [
    { id: 'RT1', words: 'Placeholder tree rule.', key: 'node-1' },
    { id: 'RT2', words: 'Placeholder tree rule an agent filed.', filedBy: 'codex', key: 'node-1' },
  ] },
])

/* A stand-in body: innerHTML is kept as the painted string, querySelector
   answers the two selectors the panel uses (the open editor, a hint slot by
   id) from that string, and the click listener is captured so a test can
   press. Nothing here parses HTML beyond what the panel itself needs. */
function fakeBody() {
  const painted = []
  const hints = new Map()
  let editorValue = null
  let listener = null
  const body = {
    get innerHTML() { return painted[painted.length - 1] || '' },
    set innerHTML(value) {
      painted.push(String(value))
      hints.clear()
      editorValue = null
    },
    querySelector(selector) {
      if (selector === '[data-request-editor]') {
        const match = /data-request-editor="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/.exec(body.innerHTML)
        if (!match) return null
        if (editorValue === null) editorValue = decode(match[2])
        return {
          get value() { return editorValue },
          set value(next) { editorValue = String(next) },
          focus() { body.focused = match[1] },
        }
      }
      const hint = /^\[data-request-hint="([^"]+)"\]$/.exec(selector)
      if (hint) {
        if (!body.innerHTML.includes(`data-request-hint="${hint[1]}"`)) return null
        if (!hints.has(hint[1])) hints.set(hint[1], { textContent: '', hidden: true })
        return hints.get(hint[1])
      }
      return null
    },
    addEventListener(type, fn) { if (type === 'click') listener = fn },
    removeEventListener(type, fn) { if (type === 'click' && listener === fn) listener = null },
    paints: () => painted.slice(),
    hintOf: id => hints.get(id) || null,
    press: (action, id, key) => {
      assert.ok(listener, 'the panel bound no click listener')
      const button = fakeButton(action, id, key)
      return { done: listener({ target: { closest: selector => (selector === '[data-request-action]' ? button : null) } }), button }
    },
    pressButton: button => listener({ target: { closest: selector => (selector === '[data-request-action]' ? button : null) } }),
    typeInEditor: value => { body.querySelector('[data-request-editor]'); editorValue = value },
  }
  return body
}

function decode(text) {
  return String(text).replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&')
}

/* A button the way armOnce sees it: dataset, setAttribute, isConnected, and
   a classList the panel toggles 'armed' on. */
function fakeButton(action, id, key) {
  const classes = new Set()
  return {
    dataset: { requestAction: action, requestId: id, ...(key ? { requestKey: key } : {}) },
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value },
    isConnected: true,
    classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) },
  }
}

function recordingBridge({ edit = async () => ({ ok: true }), remove = async () => ({ ok: true }) } = {}) {
  const calls = []
  return {
    calls,
    requestEdit: async request => { calls.push({ verb: 'edit', request }); return edit(request) },
    requestRemove: async request => { calls.push({ verb: 'remove', request }); return remove(request) },
  }
}

const settle = async () => { for (let turn = 0; turn < 8; turn += 1) await Promise.resolve() }

function entryBlock(html, id) {
  const start = html.indexOf(`data-request-entry="${id}"`)
  assert.ok(start >= 0, `${id} is not drawn`)
  const next = html.indexOf('data-request-entry="', start + 1)
  return html.slice(start, next === -1 ? undefined : next)
}

/* ---------- markup ---------- */

test('every entry carries its words, its id line, Edit and Delete, and a hint slot', () => {
  const html = standingRequestsMarkup({ groups: GROUPS })
  for (const id of ['R2000', 'R2000.1', 'RT1', 'RT2']) {
    const block = entryBlock(html, id)
    assert.match(block, /class="rail-prose request-words"/, `${id} has no words line`)
    assert.match(block, /class="rail-prose is-dim request-id"/, `${id} has no id line`)
    assert.match(block, new RegExp(`data-request-action="edit" data-request-id="${id.replace(/\\./g, '\\\\.')}"`), `${id} has no Edit`)
    assert.match(block, new RegExp(`data-request-action="delete" data-request-id="${id.replace(/\\./g, '\\\\.')}"`), `${id} has no Delete`)
    assert.match(block, new RegExp(`data-request-hint="${id.replace(/\\./g, '\\\\.')}"[^>]*hidden`), `${id} has no hidden hint slot`)
    assert.equal((block.match(/data-request-action="delete"/g) || []).length, 1, `${id} carries more than one Delete`)
    assert.equal((block.match(/data-request-action="edit"/g) || []).length, 1, `${id} carries more than one Edit`)
    assert.match(block, />Edit</)
    assert.match(block, />Delete</)
    assert.match(block, /aria-pressed="false"/, `${id}'s Delete does not announce its unarmed state`)
  }
  /* The ledger key rides the buttons of a keyed ledger and is absent from the
     global one, so the verbs can name the ledger without the heading. */
  assert.match(entryBlock(html, 'RT1'), /data-request-action="edit" data-request-id="RT1" data-request-key="node-1"/)
  assert.doesNotMatch(entryBlock(html, 'R2000'), /data-request-key/)
  /* The author is still named for an agent-filed entry. */
  assert.match(entryBlock(html, 'RT2'), /Filed as RT2, filed by your agent codex/)
  assert.doesNotMatch(entryBlock(html, 'RT2'), /waiting for your approval/, 'a rule that counts must not say it is waiting')
  /* A rule an agent filed that nobody has approved yet says so beside the
     id, in the author's own line, so a rule listed here and not yet in force
     never reads as one that is. */
  const proposed = standingRequestsMarkup({ groups: [{ scope: 'tree', entries: [
    { id: 'R9', words: 'Placeholder proposed rule.', filedBy: 'claude', key: 'node-1', awaitingApproval: true },
  ] }] })
  assert.match(entryBlock(proposed, 'R9'), /Filed as R9, filed by your agent claude, waiting for your approval on the Ledger page/)
  /* The scope headings, the precedence sentence, and the how-to lines. */
  assert.match(html, /Everywhere on this computer/)
  assert.match(html, /This tree/)
  assert.ok(html.includes(REQUEST_PANEL.precedence))
  assert.ok(html.includes(REQUEST_PANEL.howToAdd))
  assert.ok(html.includes(REQUEST_PANEL.howToRemove))
  /* Nothing but the person's words and ids: no key, no path-shaped thing. */
  assert.doesNotMatch(html, /[A-Z]:\\|\/state\/r-ledger/)
})

test('a dotted child is drawn indented under its parent with the refinement hint', () => {
  const html = standingRequestsMarkup({ groups: GROUPS })
  const parent = html.indexOf('data-request-entry="R2000"')
  const child = html.indexOf('data-request-entry="R2000.1"')
  assert.ok(parent >= 0 && child > parent, 'the child is not drawn after its parent')
  const block = entryBlock(html, 'R2000.1')
  assert.match(block, /^data-request-entry="R2000\.1" style="margin-left: 16px"/, 'the child is not indented')
  assert.match(block, /Filed as R2000\.1, refinement of R2000/, 'the child does not say which rule it refines')
  assert.doesNotMatch(entryBlock(html, 'R2000'), /style="margin-left/, 'a root is indented')
  assert.doesNotMatch(entryBlock(html, 'R2000'), /refinement of/)
  /* An orphaned child (its parent deleted by hand) still lists, unindented,
     still saying what it refined. */
  const orphan = standingRequestsMarkup({ groups: [{ scope: 'tree', entries: [{ id: 'RT4.2', words: 'Placeholder orphan.', key: 'k' }] }] })
  assert.match(entryBlock(orphan, 'RT4.2'), /refinement of RT4/)
  assert.doesNotMatch(entryBlock(orphan, 'RT4.2'), /margin-left/)
})

test('empty, refused and editing states each draw what they say', () => {
  const empty = standingRequestsMarkup({ groups: [] })
  assert.ok(empty.includes(REQUEST_PANEL.empty))
  assert.doesNotMatch(empty, /data-request-action/)
  const refused = standingRequestsMarkup({ groups: GROUPS, refused: true })
  assert.ok(refused.includes(REQUEST_PANEL.unavailable), 'a refusal must ride WITH what was read')
  assert.match(refused, /data-request-entry="RT1"/)
  const editing = standingRequestsMarkup({ groups: GROUPS, editing: 'RT1', draft: 'Typed <words> & "quotes"' })
  const block = entryBlock(editing, 'RT1')
  assert.match(block, /<textarea class="ctl-textarea request-editor" data-request-editor="RT1"[^>]*>Typed &lt;words&gt; &amp; &quot;quotes&quot;<\/textarea>/, 'the draft is not in the box, escaped')
  assert.match(block, /data-request-action="save" data-request-id="RT1" data-request-key="node-1"/)
  assert.match(block, /data-request-action="cancel" data-request-id="RT1"/)
  assert.doesNotMatch(block, /data-request-action="edit"/, 'Edit is still offered while editing')
  assert.doesNotMatch(block, /data-request-action="delete"/, 'Delete is still offered while editing')
  assert.doesNotMatch(block, /request-words/, 'the words line is drawn beside the box')
  /* The other entries keep their ordinary controls. */
  assert.match(entryBlock(editing, 'RT2'), /data-request-action="edit"/)
  /* A note under one entry and nowhere else. */
  const noted = standingRequestsMarkup({ groups: GROUPS, note: { id: 'RT2', text: 'A sentence.' } })
  assert.match(entryBlock(noted, 'RT2'), /data-request-hint="RT2" role="status">A sentence\.<\/p>/)
  assert.match(entryBlock(noted, 'RT1'), /data-request-hint="RT1" role="status" hidden><\/p>/)
})

test('missing write verbs disable their controls with the refusal beside them before any press can change the panel', async () => {
  const noRemoveBody = fakeBody()
  const editOnly = { requestEdit: async () => ({ ok: true }) }
  createStandingRequestsPanel(noRemoveBody, { bridge: editOnly }).show({ groups: GROUPS })
  let block = entryBlock(noRemoveBody.innerHTML, 'RT1')
  assert.doesNotMatch(block, /data-request-action="edit"[^>]* disabled/, 'Edit was disabled even though its verb exists')
  assert.match(block, /data-request-action="delete"[^>]* disabled/, 'Delete stayed live without requestRemove')
  assert.ok(block.includes(REQUEST_PANEL.deleteUnavailable), 'Delete has no adjacent reason')

  const noEditBody = fakeBody()
  const removeOnly = { requestRemove: async () => ({ ok: true }) }
  createStandingRequestsPanel(noEditBody, { bridge: removeOnly }).show({ groups: GROUPS })
  block = entryBlock(noEditBody.innerHTML, 'RT1')
  assert.match(block, /data-request-action="edit"[^>]* disabled/, 'Edit stayed live without requestEdit')
  assert.doesNotMatch(block, /data-request-action="delete"[^>]* disabled/, 'Delete was disabled even though its verb exists')
  assert.ok(block.includes(REQUEST_PANEL.editUnavailable), 'Edit has no adjacent reason')

  const absentBody = fakeBody()
  const absentPanel = createStandingRequestsPanel(absentBody, { bridge: null })
  absentPanel.show({ groups: GROUPS })
  block = entryBlock(absentBody.innerHTML, 'RT1')
  assert.match(block, /data-request-action="edit"[^>]* disabled/)
  assert.match(block, /data-request-action="delete"[^>]* disabled/)
  assert.ok(block.includes(REQUEST_PANEL.unavailableWrite), 'the shared refusal is not beside the disabled controls')
  const paints = absentBody.paints().length
  const { button } = absentBody.press('delete', 'RT1', 'node-1')
  await settle()
  assert.equal(button.dataset.armed, undefined, 'the unavailable Delete armed before it refused')
  absentBody.press('edit', 'RT1', 'node-1')
  await settle()
  assert.equal(absentBody.paints().length, paints, 'an unavailable write control changed the panel after press')
  assert.doesNotMatch(absentBody.innerHTML, /data-request-editor/, 'the unavailable Edit opened an editor')
})

/* ---------- delete: two presses ---------- */

test('the first Delete press arms and sends nothing; the second sends once, with the ledger key, and re-reads', async () => {
  const body = fakeBody()
  const bridge = recordingBridge()
  let rereads = 0
  const panel = createStandingRequestsPanel(body, { bridge })
  panel.show({ groups: GROUPS, reread: async () => { rereads += 1 } })
  const paintsBefore = body.paints().length

  const { button } = body.press('delete', 'RT1', 'node-1')
  await settle()
  assert.deepEqual(bridge.calls, [], 'the first press sent something')
  assert.equal(button.dataset.armed, 'true', 'the first press did not arm the control')
  assert.equal(button.attributes['aria-pressed'], 'true')
  assert.ok(button.classList.contains('armed'))
  const hint = body.hintOf('RT1')
  assert.ok(hint, 'no hint slot was written')
  assert.equal(hint.textContent, 'Delete RT1? Press again. It stays in the ledger as deleted, and agents stop reading it at their next start.')
  assert.equal(hint.hidden, false)
  assert.equal(body.paints().length, paintsBefore, 'arming repainted the body, which would have replaced the armed control')
  assert.equal(rereads, 0)

  /* The second press, on the SAME control. */
  body.pressButton(button)
  await settle()
  assert.deepEqual(bridge.calls, [{ verb: 'remove', request: { id: 'RT1', key: 'node-1' } }], 'the second press did not send exactly once, with id and key')
  assert.equal(button.dataset.armed, undefined, 'the control stayed armed after acting')
  assert.ok(!button.classList.contains('armed'))
  assert.equal(rereads, 1, 'a successful delete did not re-read the panel')
  /* A global entry sends no key. */
  const { button: global } = body.press('delete', 'R2000')
  await settle()
  body.pressButton(global)
  await settle()
  assert.deepEqual(bridge.calls.at(-1), { verb: 'remove', request: { id: 'R2000' } })
  assert.equal(rereads, 2)
})

test('a lone Delete press disarms itself and the hint goes with it', async () => {
  const body = fakeBody()
  const bridge = recordingBridge()
  /* A stand-in arm that fires its disarm immediately, so the timer is not
     waited on; armOnce's own timing is src/arm-press.js's and is held by
     tools/test/ledger-rows-remove.test.mjs. */
  const arm = (button, { onDisarm }) => {
    if (button.dataset.armed === 'true') { delete button.dataset.armed; return true }
    button.dataset.armed = 'true'
    setTimeout(() => { delete button.dataset.armed; onDisarm(button) }, 0)
    return false
  }
  const panel = createStandingRequestsPanel(body, { bridge, arm })
  panel.show({ groups: GROUPS })
  const { button } = body.press('delete', 'RT1', 'node-1')
  await settle()
  assert.equal(body.hintOf('RT1').hidden, false)
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(body.hintOf('RT1').hidden, true, 'the hint stayed after the control disarmed')
  assert.equal(body.hintOf('RT1').textContent, '')
  assert.ok(!button.classList.contains('armed'))
  assert.deepEqual(bridge.calls, [], 'a lone press sent something')
})

test('a refused delete shows its sentence under the entry and re-reads nothing', async () => {
  const body = fakeBody()
  const gone = new Error("Error invoking remote method 'mc-agent:request-remove': Error: AGENT_REQUEST_ENTRY_UNKNOWN")
  const bridge = recordingBridge({ remove: async () => { throw gone } })
  let rereads = 0
  const panel = createStandingRequestsPanel(body, { bridge })
  panel.show({ groups: GROUPS, reread: async () => { rereads += 1 } })
  const { button } = body.press('delete', 'RT2', 'node-1')
  await settle()
  body.pressButton(button)
  await settle()
  assert.equal(bridge.calls.length, 1)
  assert.equal(rereads, 0, 'a refused delete re-read the panel as if it had worked')
  assert.equal(body.hintOf('RT2').textContent, REQUEST_PANEL.entryGone('RT2'))
  assert.equal(body.hintOf('RT2').hidden, false)

  /* A refusal with no recognisable code: the plain delete sentence. */
  const other = recordingBridge({ remove: async () => ({ ok: false }) })
  const body2 = fakeBody()
  createStandingRequestsPanel(body2, { bridge: other }).show({ groups: GROUPS })
  const { button: b2 } = body2.press('delete', 'RT1', 'node-1')
  await settle()
  body2.pressButton(b2)
  await settle()
  assert.equal(body2.hintOf('RT1').textContent, REQUEST_PANEL.deleteFailed)

  /* The read-only refusal names itself as such. */
  const readOnly = recordingBridge({ remove: async () => { const e = new Error('MC_AGENT_PRINCIPAL_READ_ONLY'); e.code = 'MC_AGENT_PRINCIPAL_READ_ONLY'; throw e } })
  const body3 = fakeBody()
  createStandingRequestsPanel(body3, { bridge: readOnly }).show({ groups: GROUPS })
  const { button: b3 } = body3.press('delete', 'RT1', 'node-1')
  await settle()
  body3.pressButton(b3)
  await settle()
  assert.equal(body3.hintOf('RT1').textContent, REQUEST_PANEL.readOnly)
})

/* ---------- edit: the round trip ---------- */

test('Edit opens the box with the words, Save sends them verbatim with id and key, and a success re-reads', async () => {
  const body = fakeBody()
  const bridge = recordingBridge()
  let rereads = 0
  const panel = createStandingRequestsPanel(body, { bridge })
  panel.show({ groups: GROUPS, reread: async () => { rereads += 1; panel.show({ groups: GROUPS, reread: async () => { rereads += 1 } }) } })

  body.press('edit', 'RT1', 'node-1')
  await settle()
  let html = body.innerHTML
  assert.match(entryBlock(html, 'RT1'), /<textarea[^>]*data-request-editor="RT1"[^>]*>Placeholder tree rule\.<\/textarea>/, 'the box does not open on the entry\'s words')
  assert.equal(body.focused, 'RT1', 'the box was not focused')
  assert.deepEqual(bridge.calls, [], 'opening the box sent something')

  /* Verbatim: leading and trailing spaces, an inner newline, all kept. */
  body.typeInEditor('  Placeholder tree rule, reworded.\nSecond line.  ')
  body.press('save', 'RT1', 'node-1')
  await settle()
  assert.deepEqual(bridge.calls, [{ verb: 'edit', request: { id: 'RT1', key: 'node-1', words: '  Placeholder tree rule, reworded.\nSecond line.  ' } }],
    'Save did not send the new words verbatim, once, with id and key')
  assert.equal(rereads, 1, 'a successful save did not re-read the panel')
  html = body.innerHTML
  assert.doesNotMatch(html, /data-request-editor/, 'the box is still open after the re-read')

  /* A global entry: no key on the wire. */
  body.press('edit', 'R2000')
  await settle()
  body.typeInEditor('Placeholder global rule one, amended.')
  body.press('save', 'R2000')
  await settle()
  assert.deepEqual(bridge.calls.at(-1), { verb: 'edit', request: { id: 'R2000', words: 'Placeholder global rule one, amended.' } })
})

test('Cancel closes the box and sends nothing; an empty Save is refused before anything is sent', async () => {
  const body = fakeBody()
  const bridge = recordingBridge()
  const panel = createStandingRequestsPanel(body, { bridge })
  panel.show({ groups: GROUPS })

  body.press('edit', 'RT2', 'node-1')
  await settle()
  assert.match(body.innerHTML, /data-request-editor="RT2"/)
  body.press('cancel', 'RT2', 'node-1')
  await settle()
  assert.doesNotMatch(body.innerHTML, /data-request-editor/, 'Cancel left the box open')
  assert.match(entryBlock(body.innerHTML, 'RT2'), /Placeholder tree rule an agent filed\./, 'Cancel lost the words')
  assert.deepEqual(bridge.calls, [])

  body.press('edit', 'RT2', 'node-1')
  await settle()
  body.typeInEditor('   \n  ')
  body.press('save', 'RT2', 'node-1')
  await settle()
  assert.deepEqual(bridge.calls, [], 'an empty rule was sent')
  const block = entryBlock(body.innerHTML, 'RT2')
  assert.match(block, /data-request-editor="RT2"/, 'the box closed on an empty save; the person loses their place')
  assert.ok(block.includes(REQUEST_PANEL.editEmpty), 'the empty refusal is not said under the entry')
})

test('a refused edit keeps the box open with the draft and says the sentence; unavailable bridges say so', async () => {
  const body = fakeBody()
  const tooLong = new Error("Error invoking remote method 'mc-agent:request-edit': Error: AGENT_REQUEST_WORDS_TOO_LONG")
  const bridge = recordingBridge({ edit: async () => { throw tooLong } })
  let rereads = 0
  const panel = createStandingRequestsPanel(body, { bridge })
  panel.show({ groups: GROUPS, reread: async () => { rereads += 1 } })
  body.press('edit', 'RT1', 'node-1')
  await settle()
  body.typeInEditor('Placeholder, reworded.')
  body.press('save', 'RT1', 'node-1')
  await settle()
  assert.equal(bridge.calls.length, 1)
  assert.equal(rereads, 0, 'a refused edit re-read the panel as if it had worked')
  const block = entryBlock(body.innerHTML, 'RT1')
  assert.match(block, /data-request-editor="RT1"[^>]*>Placeholder, reworded\.<\/textarea>/, 'the draft was lost on refusal')
  assert.ok(block.includes(REQUEST_PANEL.tooLong), 'the refusal sentence is not under the entry')

  /* No bridge method at all (an older shell): the sentence still says so and
     nothing is attempted, but that proof now belongs to the render boundary.
     The house rule moved the refusal ahead of the old Edit/open/Save and
     Delete/arm/confirm sequences; replaying those sequences would assert the
     defect this test now prevents. */
  const body2 = fakeBody()
  createStandingRequestsPanel(body2, { bridge: { requests: async () => ({ ok: true, entries: [] }) } }).show({ groups: GROUPS })
  const unavailableBlock = entryBlock(body2.innerHTML, 'RT1')
  assert.ok(unavailableBlock.includes(REQUEST_PANEL.unavailableWrite))
  assert.match(unavailableBlock, /data-request-action="edit"[^>]* disabled/)
  assert.match(unavailableBlock, /data-request-action="delete"[^>]* disabled/)
  const unavailablePaints = body2.paints().length
  body2.press('edit', 'RT1', 'node-1')
  await settle()
  const { button } = body2.press('delete', 'RT2', 'node-1')
  await settle()
  assert.equal(body2.paints().length, unavailablePaints)
  assert.equal(button.dataset.armed, undefined)
  assert.doesNotMatch(body2.innerHTML, /data-request-editor/)
})

test('a press on anything that is not one of the four controls, or with an id that is not an id, does nothing', async () => {
  const body = fakeBody()
  const bridge = recordingBridge()
  const panel = createStandingRequestsPanel(body, { bridge })
  panel.show({ groups: GROUPS })
  const paints = body.paints().length
  await panel.press({ target: { closest: () => null } })
  await panel.press({ target: null })
  await panel.press(null)
  await panel.press({ target: { closest: () => ({ dataset: { requestAction: 'delete', requestId: '../R1' } }) } })
  await panel.press({ target: { closest: () => ({ dataset: { requestAction: 'nonsense', requestId: 'RT1' } }) } })
  await settle()
  assert.deepEqual(bridge.calls, [])
  assert.equal(body.paints().length, paints)
})

test('one panel per body: a re-read never stacks a second listener', () => {
  const body = fakeBody()
  let bound = 0
  const add = body.addEventListener
  body.addEventListener = (type, fn) => { bound += 1; add.call(body, type, fn) }
  const first = standingRequestsPanelFor(body, { bridge: recordingBridge() })
  const second = standingRequestsPanelFor(body, { bridge: recordingBridge() })
  assert.equal(first, second)
  assert.equal(bound, 1)
  first.destroy()
})

/* ---------- the view, pinned in source ---------- */

test('the view hands the shared panel its body, keeps the ledger key on every entry, and re-reads through itself', () => {
  const view = readFileSync(path.join(ROOT, 'src', 'views', 'computers.js'), 'utf8')
  const mount = view.slice(view.indexOf('async function mountStandingRequests(node, slot, { preserveEditing = false } = {})'), view.indexOf('const REQUEST_FILE_FAILED'))
  assert.ok(mount.length > 0, 'mountStandingRequests is where this test expects it')
  assert.match(mount, /answer\.entries\.map\(entry => \(\{ \.\.\.entry, key \}\)\)/, 'entries no longer carry the key of the ledger they were read from')
  assert.match(mount, /standingRequestsPanelFor\(body, \{ bridge, escape: escapeMarkup \}\)/, 'the view does not paint through the shared panel')
  assert.match(mount, /\.show\(\{ groups, refused, preserveEditing, reread: \(\) => mountStandingRequests\(node, slot\) \}\)/, 'a success does not re-read through the same mount')
  assert.doesNotMatch(mount, /request-words/, 'the view keeps its own copy of the entry markup')
  assert.match(view, /import \{ REQUEST_PANEL, standingRequestScopesFor, standingRequestsPanelFor \} from '\.\.\/tree-standing-requests\.js'/)
  /* The bridge the panel calls is the preload's, by the two names the main
     process registers. */
  const preload = readFileSync(path.join(ROOT, 'shell', 'fleet-profile-preload.cjs'), 'utf8')
  assert.match(preload, /requestEdit: request => ipcRenderer\.invoke\('mc-agent:request-edit', request\)/)
  assert.match(preload, /requestRemove: request => ipcRenderer\.invoke\('mc-agent:request-remove', request\)/)
})
