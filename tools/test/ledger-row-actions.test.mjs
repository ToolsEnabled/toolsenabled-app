/* THE PERSON'S HAND ON ONE LEDGER ROW -- Edit, a two-press Delete, Approve,
 * and a two-press Decline with room for a reason.
 *
 * src/ledger-row-actions.js is pure over the register it is handed, so this
 * suite drives it against stand-in rows and a recording bridge:
 *
 *   EDIT     opens the box on the row's words, Save sends them verbatim with
 *            id and ledger key and reloads through onChanged; Cancel sends
 *            nothing; an empty Save is refused before anything is sent
 *   DELETE   the first press ARMS and says what the second will do; the second
 *            sends requestRemove once with id and key; a refusal is a sentence
 *            under the row and no reload
 *   DECIDE   Approve is one press; Decline arms, opens a reason box, and the
 *            second press sends the reason it holds
 *   FENCE    an example row is never written from, whatever was pressed
 *   IDS      a press with an id that is not an id does nothing
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { mountLedgerRowActions } from '../../src/ledger-row-actions.js'
import { ANSWER_ROW, COMPLETE_ROW, DECIDE_ROW, DELETE_ROW, EXAMPLE_WRITE_NOTE, LEDGER_REFUSAL, ROW_ACTIONS } from '../../src/ledger-copy.js'
import { REQUEST_PANEL } from '../../src/tree-standing-requests.js'

const settle = async () => { for (let turn = 0; turn < 8; turn += 1) await Promise.resolve() }

function decode(text) {
  return String(text).replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&')
}

/* A stand-in row: a hint slot and an editor slot, the two things the module
   writes into. The editor slot keeps its painted markup as a string and
   answers the textarea and the reason input from it. */
function fakeRecord() {
  const hint = { textContent: '', hidden: true, dataset: {} }
  let editorValue = null
  let reasonValue = ''
  const slot = {
    hidden: true,
    _html: '',
    get innerHTML() { return this._html },
    set innerHTML(value) { this._html = String(value); editorValue = null; reasonValue = '' },
    querySelector(selector) { return record.querySelector(selector) },
  }
  const record = {
    hint,
    slot,
    focused: false,
    querySelector(selector) {
      if (selector === '[data-row-hint]') return hint
      if (selector === '[data-row-editor]') return slot
      if (selector === '[data-row-editor-words]') {
        const match = /data-row-editor-words[^>]*>([\s\S]*?)<\/textarea>/.exec(slot._html)
        if (!match) return null
        if (editorValue === null) editorValue = decode(match[1])
        const purposeMatch = /data-editor-purpose="([^"]*)"/.exec(slot._html)
        return {
          get value() { return editorValue },
          set value(next) { editorValue = String(next) },
          focus() { record.focused = true },
          dataset: { editorPurpose: purposeMatch ? decode(purposeMatch[1]) : 'edit' },
        }
      }
      if (selector === '[data-row-reason]') {
        if (!slot._html.includes('data-row-reason')) return null
        return { get value() { return reasonValue }, set value(next) { reasonValue = String(next) } }
      }
      return null
    },
    typeWords(value) { record.querySelector('[data-row-editor-words]'); editorValue = value },
    typeReason(value) { reasonValue = value },
  }
  return record
}

function fakeButton(action, id, key, record) {
  const attrs = {}
  const button = {
    dataset: { rowAction: action, id, ...(key ? { key } : {}) },
    isConnected: true,
    setAttribute(name, value) { attrs[name] = value },
    getAttribute(name) { return attrs[name] ?? null },
    closest(selector) {
      if (selector === '.ledger-record') return record
      return selector.includes('data-row-action') ? button : null
    },
  }
  return button
}

function fakeRegister() {
  let listener = null
  return {
    addEventListener(type, fn) { if (type === 'click') listener = fn },
    removeEventListener(type, fn) { if (type === 'click' && listener === fn) listener = null },
    press(button) {
      assert.ok(listener, 'the module bound no click listener')
      return listener({ target: { closest: selector => button.closest(selector) } })
    },
    bound: () => listener !== null,
  }
}

function recordingBridge({
  edit = async () => ({ ok: true }), remove = async () => ({ ok: true }), decide = async () => ({ ok: true }),
  complete = async () => ({ ok: true }), answer = async () => ({ ok: true }),
  removeTask = async () => ({ ok: true }), declineAsk = async () => ({ ok: true }), removeAsk = async () => ({ ok: true }),
} = {}) {
  const calls = []
  return {
    calls,
    requestEdit: async request => { calls.push({ verb: 'edit', request }); return edit(request) },
    requestRemove: async request => { calls.push({ verb: 'remove', request }); return remove(request) },
    requestDecide: async request => { calls.push({ verb: 'decide', request }); return decide(request) },
    completeTask: async request => { calls.push({ verb: 'complete', request }); return complete(request) },
    answerAsk: async request => { calls.push({ verb: 'answer', request }); return answer(request) },
    removeTask: async request => { calls.push({ verb: 'removeTask', request }); return removeTask(request) },
    declineAsk: async request => { calls.push({ verb: 'declineAsk', request }); return declineAsk(request) },
    removeAsk: async request => { calls.push({ verb: 'removeAsk', request }); return removeAsk(request) },
  }
}

const ROWS = Object.freeze({
  R3: { id: 'R3', scopeKey: 'node-1', words: 'Keep <the> tests & green.' },
  R7: { id: 'R7', scopeKey: null, words: 'Placeholder global rule.' },
  R9: { id: 'R9', scopeKey: 'node-1', words: 'Placeholder rule an agent filed.' },
  T4: { id: 'T4', scopeKey: 'node-1', words: 'Placeholder task words.' },
  A1: { id: 'A1', scopeKey: null, words: 'Which relay region should this use?' },
})

function mount({ bridge, arm, badged = false, changed = [] } = {}) {
  const register = fakeRegister()
  const api = mountLedgerRowActions(register, {
    bridge,
    ...(arm ? { arm } : {}),
    onChanged: async change => { changed.push(change) },
    rowOf: id => ROWS[id] || null,
    isBadged: () => badged,
  })
  return { register, api, changed }
}

/* ---------- edit ---------- */

test('Edit opens the box on the row\'s words, Save sends them verbatim with id and key, and a success reloads', async () => {
  const bridge = recordingBridge()
  const changed = []
  const { register } = mount({ bridge, changed })
  const record = fakeRecord()

  await register.press(fakeButton('edit', 'R3', 'node-1', record))
  await settle()
  assert.equal(record.slot.hidden, false, 'the editor slot did not open')
  assert.match(record.slot.innerHTML, /<textarea class="ledger-editor" data-row-editor-words[^>]*>Keep &lt;the&gt; tests &amp; green\.<\/textarea>/, 'the box does not open on the row\'s words, escaped')
  assert.match(record.slot.innerHTML, /data-row-action="save" data-id="R3" data-key="node-1"/)
  assert.match(record.slot.innerHTML, /data-row-action="cancel" data-id="R3"/)
  assert.ok(record.slot.innerHTML.includes(`>${ROW_ACTIONS.save}<`) && record.slot.innerHTML.includes(`>${ROW_ACTIONS.cancel}<`))
  assert.equal(record.focused, true, 'the box was not focused')
  assert.deepEqual(bridge.calls, [], 'opening the box sent something')

  /* Verbatim: leading and trailing spaces, an inner newline, all kept. */
  record.typeWords('  Keep the tests green.\nAnd fast.  ')
  await register.press(fakeButton('save', 'R3', 'node-1', record))
  await settle()
  assert.deepEqual(bridge.calls, [{ verb: 'edit', request: { id: 'R3', key: 'node-1', words: '  Keep the tests green.\nAnd fast.  ' } }],
    'Save did not send the new words verbatim, once, with id and key')
  assert.deepEqual(changed, [{ id: 'R3', verb: 'edit' }], 'a successful save did not reload')
  assert.equal(record.slot.hidden, true, 'the box is still open after the save')
  assert.equal(record.slot.innerHTML, '')

  /* A global entry: no key on the wire. */
  await register.press(fakeButton('edit', 'R7', null, record))
  await settle()
  assert.doesNotMatch(record.slot.innerHTML, /data-key=/, 'a global row carries a key')
  record.typeWords('Placeholder global rule, amended.')
  await register.press(fakeButton('save', 'R7', null, record))
  await settle()
  assert.deepEqual(bridge.calls.at(-1), { verb: 'edit', request: { id: 'R7', words: 'Placeholder global rule, amended.' } })
})

test('Cancel closes the box and sends nothing; an empty Save is refused before anything is sent', async () => {
  const bridge = recordingBridge()
  const changed = []
  const { register } = mount({ bridge, changed })
  const record = fakeRecord()
  await register.press(fakeButton('edit', 'R3', 'node-1', record))
  await settle()
  await register.press(fakeButton('cancel', 'R3', 'node-1', record))
  await settle()
  assert.equal(record.slot.hidden, true, 'Cancel left the box open')
  assert.deepEqual(bridge.calls, [])

  await register.press(fakeButton('edit', 'R3', 'node-1', record))
  await settle()
  record.typeWords('   \n  ')
  await register.press(fakeButton('save', 'R3', 'node-1', record))
  await settle()
  assert.deepEqual(bridge.calls, [], 'an empty rule was sent')
  assert.equal(record.slot.hidden, false, 'the box closed on an empty save; the person loses their place')
  assert.equal(record.hint.textContent, REQUEST_PANEL.editEmpty)
  assert.equal(record.hint.hidden, false)
  assert.deepEqual(changed, [])
})

test('a refused edit keeps the box open with the draft and says the sentence under the row', async () => {
  const tooLong = new Error("Error invoking remote method 'mc-agent:request-edit': Error: AGENT_REQUEST_WORDS_TOO_LONG")
  const bridge = recordingBridge({ edit: async () => { throw tooLong } })
  const changed = []
  const { register } = mount({ bridge, changed })
  const record = fakeRecord()
  await register.press(fakeButton('edit', 'R3', 'node-1', record))
  await settle()
  record.typeWords('Reworded.')
  await register.press(fakeButton('save', 'R3', 'node-1', record))
  await settle()
  assert.equal(bridge.calls.length, 1)
  assert.deepEqual(changed, [], 'a refused edit reloaded as if it had worked')
  assert.equal(record.slot.hidden, false, 'the draft was lost on refusal')
  assert.equal(record.querySelector('[data-row-editor-words]').value, 'Reworded.')
  assert.equal(record.hint.textContent, REQUEST_PANEL.tooLong)
  assert.equal(record.hint.dataset.state, 'refused')
})

/* ---------- delete: two presses ---------- */

test('the first Delete press arms and sends nothing; the second sends once, with the ledger key, and reloads', async () => {
  const bridge = recordingBridge()
  const changed = []
  const { register } = mount({ bridge, changed })
  const record = fakeRecord()
  const button = fakeButton('delete', 'R3', 'node-1', record)

  await register.press(button)
  await settle()
  assert.deepEqual(bridge.calls, [], 'the first press sent something')
  assert.equal(button.dataset.armed, 'true', 'the first press did not arm the control')
  assert.equal(button.getAttribute('aria-pressed'), 'true')
  assert.equal(record.hint.textContent, DELETE_ROW.armed('R3'))
  assert.equal(record.hint.hidden, false)
  assert.equal(record.hint.dataset.state, DELETE_ROW.tone)
  assert.deepEqual(changed, [])

  await register.press(button)
  await settle()
  assert.deepEqual(bridge.calls, [{ verb: 'remove', request: { id: 'R3', key: 'node-1' } }], 'the second press did not send exactly once, with id and key')
  assert.equal(button.dataset.armed, undefined, 'the control stayed armed after acting')
  assert.deepEqual(changed, [{ id: 'R3', verb: 'delete' }], 'a successful delete did not reload')

  /* A global entry sends no key. */
  const global = fakeButton('delete', 'R7', null, record)
  await register.press(global)
  await settle()
  await register.press(global)
  await settle()
  assert.deepEqual(bridge.calls.at(-1), { verb: 'remove', request: { id: 'R7' } })
})

test('a lone Delete press disarms itself and the sentence goes with it', async () => {
  const bridge = recordingBridge()
  /* A stand-in arm that fires its disarm at once; armOnce's own timing is
     src/arm-press.js's and is held by tools/test/ledger-rows-remove.test.mjs. */
  const arm = (button, { onDisarm }) => {
    if (button.dataset.armed === 'true') { delete button.dataset.armed; return true }
    button.dataset.armed = 'true'
    setTimeout(() => { delete button.dataset.armed; onDisarm(button) }, 0)
    return false
  }
  const { register } = mount({ bridge, arm })
  const record = fakeRecord()
  await register.press(fakeButton('delete', 'R3', 'node-1', record))
  await settle()
  assert.equal(record.hint.hidden, false)
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(record.hint.hidden, true, 'the sentence stayed after the control disarmed')
  assert.equal(record.hint.textContent, '')
  assert.deepEqual(bridge.calls, [], 'a lone press sent something')
})

test('a refused delete says its sentence under the row and reloads nothing', async () => {
  const gone = new Error("Error invoking remote method 'mc-agent:request-remove': Error: AGENT_REQUEST_ENTRY_UNKNOWN")
  const bridge = recordingBridge({ remove: async () => { throw gone } })
  const changed = []
  const { register } = mount({ bridge, changed })
  const record = fakeRecord()
  const button = fakeButton('delete', 'R9', 'node-1', record)
  await register.press(button)
  await settle()
  await register.press(button)
  await settle()
  assert.equal(bridge.calls.length, 1)
  assert.deepEqual(changed, [], 'a refused delete reloaded as if it had worked')
  assert.equal(record.hint.textContent, REQUEST_PANEL.entryGone('R9'))

  /* A refusal with no recognisable code: the plain delete sentence. */
  const other = recordingBridge({ remove: async () => ({ ok: false }) })
  const second = mount({ bridge: other })
  const record2 = fakeRecord()
  const b2 = fakeButton('delete', 'R3', 'node-1', record2)
  await second.register.press(b2)
  await settle()
  await second.register.press(b2)
  await settle()
  assert.equal(record2.hint.textContent, DELETE_ROW.failed)

  /* The read-only refusal names itself as such. */
  const readOnly = recordingBridge({ remove: async () => { const e = new Error('MC_AGENT_PRINCIPAL_READ_ONLY'); e.code = 'MC_AGENT_PRINCIPAL_READ_ONLY'; throw e } })
  const third = mount({ bridge: readOnly })
  const record3 = fakeRecord()
  const b3 = fakeButton('delete', 'R3', 'node-1', record3)
  await third.register.press(b3)
  await settle()
  await third.register.press(b3)
  await settle()
  assert.equal(record3.hint.textContent, REQUEST_PANEL.readOnly)
})

/* ---------- approve and decline ---------- */

test('Approve is one press; Decline arms with a reason box and the second press sends the reason', async () => {
  const bridge = recordingBridge()
  const changed = []
  const { register } = mount({ bridge, changed })
  const record = fakeRecord()

  await register.press(fakeButton('approve', 'R9', 'node-1', record))
  await settle()
  assert.deepEqual(bridge.calls, [{ verb: 'decide', request: { id: 'R9', decision: 'approve' } }], 'Approve did not send once, with no reason')
  assert.deepEqual(changed, [{ id: 'R9', verb: 'decide' }])

  const decline = fakeButton('decline', 'R9', 'node-1', record)
  await register.press(decline)
  await settle()
  assert.equal(bridge.calls.length, 1, 'the first Decline press sent something')
  assert.equal(decline.dataset.armed, 'true')
  assert.equal(record.hint.textContent, DECIDE_ROW.declineArmed('R9'))
  assert.equal(record.slot.hidden, false, 'no reason box opened')
  assert.match(record.slot.innerHTML, /data-row-reason/, 'the reason box is not in the slot')
  assert.ok(record.slot.innerHTML.includes(ROW_ACTIONS.reasonLabel))
  record.typeReason('  Not what I meant.  ')
  await register.press(decline)
  await settle()
  assert.deepEqual(bridge.calls.at(-1), { verb: 'decide', request: { id: 'R9', decision: 'decline', reason: 'Not what I meant.' } }, 'the second press did not carry the trimmed reason')
  assert.equal(changed.length, 2)
  assert.equal(record.slot.hidden, true, 'the reason box stayed open after the decision')

  /* An empty reason is left off the wire. */
  const again = fakeButton('decline', 'R9', 'node-1', record)
  await register.press(again)
  await settle()
  await register.press(again)
  await settle()
  assert.deepEqual(bridge.calls.at(-1), { verb: 'decide', request: { id: 'R9', decision: 'decline' } })

  /* A decision on a row that is no longer waiting. */
  const settled = recordingBridge({ decide: async () => { const e = new Error('AGENT_REQUEST_STATUS_INVALID'); e.code = 'AGENT_REQUEST_STATUS_INVALID'; throw e } })
  const other = mount({ bridge: settled })
  const record2 = fakeRecord()
  await other.register.press(fakeButton('approve', 'R9', 'node-1', record2))
  await settle()
  assert.equal(record2.hint.textContent, DECIDE_ROW.gone('R9'))
  assert.deepEqual(other.changed, [])
})

test('a lone Decline press disarms itself but keeps the reason box and its words; the next press re-arms around them', async () => {
  const bridge = recordingBridge()
  const changed = []
  /* A stand-in arm that hands its disarm back so the test can fire it the
     way src/arm-press.js's timer would, eight seconds later. */
  let disarm = null
  const arm = (button, { onDisarm }) => {
    if (button.dataset.armed === 'true') { delete button.dataset.armed; disarm = null; return true }
    button.dataset.armed = 'true'
    disarm = () => { delete button.dataset.armed; onDisarm(button) }
    return false
  }
  const { register } = mount({ bridge, arm, changed })
  const record = fakeRecord()
  const decline = fakeButton('decline', 'R9', 'node-1', record)

  await register.press(decline)
  await settle()
  assert.equal(record.slot.hidden, false, 'no reason box opened')
  record.typeReason('Not what I meant, and I paused to say so.')
  assert.ok(disarm, 'the arm did not hand back its disarm')
  disarm()
  await settle()
  assert.equal(decline.dataset.armed, undefined, 'the control stayed armed after the disarm')
  assert.equal(record.hint.hidden, true, 'the armed sentence stayed after the disarm')
  assert.equal(record.slot.hidden, false, 'the disarm closed the reason box')
  assert.equal(record.querySelector('[data-row-reason]').value, 'Not what I meant, and I paused to say so.', 'the disarm threw the typed reason away')
  assert.deepEqual(bridge.calls, [], 'a lone press sent something')

  /* The next press re-arms without repainting the box. */
  await register.press(decline)
  await settle()
  assert.equal(decline.dataset.armed, 'true', 'the second press after a disarm did not re-arm')
  assert.equal(record.hint.textContent, DECIDE_ROW.declineArmed('R9'))
  assert.equal(record.querySelector('[data-row-reason]').value, 'Not what I meant, and I paused to say so.', 're-arming painted a fresh box over the reason')
  assert.deepEqual(bridge.calls, [])

  await register.press(decline)
  await settle()
  assert.deepEqual(bridge.calls, [{ verb: 'decide', request: { id: 'R9', decision: 'decline', reason: 'Not what I meant, and I paused to say so.' } }], 'the decision did not carry the reason that survived the disarm')
  assert.deepEqual(changed, [{ id: 'R9', verb: 'decide' }])
  assert.equal(record.slot.hidden, true, 'the reason box stayed open after the decision')
})

test('Cancel hands focus back to the row\'s Edit, and reopen puts an editor or a reason box back on a row with its words', async () => {
  const bridge = recordingBridge()
  const rows = new Map()
  const register = fakeRegister()
  /* The register can find a row by id, the way the view's can. */
  register.querySelector = selector => {
    const id = /^\[data-row-id="([^"]+)"\]$/.exec(selector)?.[1]
    return id ? rows.get(id) || null : null
  }
  const api = mountLedgerRowActions(register, { bridge, rowOf: id => ROWS[id] || null })

  const record = fakeRecord()
  let editFocused = false
  const inner = record.querySelector.bind(record)
  record.querySelector = selector => (selector === '[data-row-action="edit"]' ? { focus() { editFocused = true } } : inner(selector))
  rows.set('R3', record)
  await register.press(fakeButton('edit', 'R3', 'node-1', record))
  await settle()
  await register.press(fakeButton('cancel', 'R3', 'node-1', record))
  await settle()
  assert.equal(record.slot.hidden, true)
  assert.equal(editFocused, true, 'Cancel left focus on the removed button instead of the row\'s Edit')

  /* An editor reopened after a redraw carries the held words and the row's
     key, as if Edit had been pressed and the words typed again. */
  assert.equal(api.reopen({ id: 'R3', kind: 'editor', value: 'Half a sentence' }), true)
  assert.equal(record.slot.hidden, false, 'reopen did not open the editor')
  assert.match(record.slot.innerHTML, /data-row-action="save" data-id="R3" data-key="node-1"/, 'the reopened editor lost the row\'s key')
  assert.equal(record.querySelector('[data-row-editor-words]').value, 'Half a sentence')
  await register.press(fakeButton('save', 'R3', 'node-1', record))
  await settle()
  assert.deepEqual(bridge.calls.at(-1), { verb: 'edit', request: { id: 'R3', key: 'node-1', words: 'Half a sentence' } }, 'Save after a reopen did not send the held words')

  /* A reason box comes back open with its words, unarmed; the next Decline
     press arms around it. */
  assert.equal(api.reopen({ id: 'R3', kind: 'reason', value: 'Because.' }), true)
  assert.match(record.slot.innerHTML, /data-row-reason/)
  assert.equal(record.querySelector('[data-row-reason]').value, 'Because.')
  const decline = fakeButton('decline', 'R3', 'node-1', record)
  await register.press(decline)
  await settle()
  assert.equal(decline.dataset.armed, 'true')
  assert.equal(record.querySelector('[data-row-reason]').value, 'Because.', 'arming over a reopened box lost its words')
  await register.press(decline)
  await settle()
  assert.deepEqual(bridge.calls.at(-1), { verb: 'decide', request: { id: 'R3', decision: 'decline', reason: 'Because.' } })

  /* A row that is not on screen, an id that is not an id, a verb the bridge
     lacks: nothing is opened. */
  assert.equal(api.reopen({ id: 'R99', kind: 'editor', value: 'x' }), false)
  assert.equal(api.reopen({ id: '../R3', kind: 'editor', value: 'x' }), false)
  assert.equal(api.reopen({ id: 'R3', kind: 'nonsense', value: 'x' }), false)
  const editOnly = mountLedgerRowActions(register, { bridge: { requestEdit: async () => ({ ok: true }) }, rowOf: id => ROWS[id] || null })
  assert.equal(editOnly.reopen({ id: 'R3', kind: 'reason', value: 'x' }), false)
})

/* ---------- the fence, missing verbs, and ids ---------- */

test('an example row is never written from, whatever was pressed', async () => {
  const bridge = recordingBridge()
  const { register } = mount({ bridge, badged: true })
  const record = fakeRecord()
  for (const [action, key] of [['edit', 'node-1'], ['delete', 'node-1'], ['approve', null], ['decline', null]]) {
    const button = fakeButton(action, 'R3', key, record)
    await register.press(button)
    await settle()
    assert.equal(button.dataset.armed, undefined, `${action} armed on an example row`)
  }
  assert.deepEqual(bridge.calls, [], 'an example row reached the bridge')
  assert.equal(record.hint.textContent, EXAMPLE_WRITE_NOTE)
  assert.equal(record.hint.dataset.state, 'note')
  assert.equal(record.slot.hidden, true, 'an example row opened an editor')
})

test('a verb the bridge lacks is refused with its sentence and nothing is attempted', async () => {
  const editOnly = { requestEdit: async () => ({ ok: true }) }
  const { register, api } = mount({ bridge: editOnly })
  assert.deepEqual(api.verbs, {
    edit: true, remove: false, decide: false,
    complete: false, removeTask: false, answer: false, declineAsk: false, removeAsk: false,
  })
  const record = fakeRecord()
  const del = fakeButton('delete', 'R3', 'node-1', record)
  await register.press(del)
  await settle()
  assert.equal(del.dataset.armed, undefined, 'an unavailable Delete armed')
  assert.equal(record.hint.textContent, REQUEST_PANEL.deleteUnavailable)
  await register.press(fakeButton('approve', 'R9', null, record))
  await settle()
  assert.equal(record.hint.textContent, REQUEST_PANEL.unavailableWrite)

  const none = mount({ bridge: null })
  assert.deepEqual(none.api.verbs, {
    edit: false, remove: false, decide: false,
    complete: false, removeTask: false, answer: false, declineAsk: false, removeAsk: false,
  })
  const record2 = fakeRecord()
  await none.register.press(fakeButton('edit', 'R3', 'node-1', record2))
  await settle()
  assert.equal(record2.slot.hidden, true, 'an unavailable Edit opened an editor')
  assert.equal(record2.hint.textContent, REQUEST_PANEL.editUnavailable)
})

test('a press with an id that is not an id, or an unknown action, does nothing', async () => {
  const bridge = recordingBridge()
  const { register, api } = mount({ bridge })
  const record = fakeRecord()
  /* T and A share R's id grammar (LEDGER-KINDS-INTERFACE-20260907.md); P
     is deliberately absent -- this module never draws a P row, so a P id
     reaching it is refused the same as any id it never minted. */
  for (const id of ['../R1', 'r3', 'R', 'R0', 'R3.', 'R3.0', 'Q7', 'P1', '']) {
    const button = fakeButton('delete', id, 'node-1', record)
    await register.press(button)
    await settle()
    assert.equal(button.dataset.armed, undefined, `${JSON.stringify(id)} armed`)
  }
  await register.press(fakeButton('nonsense', 'R3', 'node-1', record))
  await api.press({ target: { closest: () => null } })
  await api.press({ target: null })
  await api.press(null)
  await settle()
  assert.deepEqual(bridge.calls, [])
  assert.equal(record.hint.textContent, '')
  assert.equal(record.slot.hidden, true)
  api.destroy()
  assert.equal(register.bound(), false, 'destroy left the listener bound')
})

/* ---------- T's Complete, A's Answer (owner's 2026-09-07 addition) ---------- */

test('Complete sends completeTask once with its globally unique id, on one press, and reloads on success', async () => {
  const bridge = recordingBridge()
  const changed = []
  const { register } = mount({ bridge, changed })
  const record = fakeRecord()
  await register.press(fakeButton('complete', 'T4', 'node-1', record))
  await settle()
  assert.deepEqual(bridge.calls, [{ verb: 'complete', request: { id: 'T4' } }], 'Complete is one press and sends no display scope key')
  assert.deepEqual(changed, [{ id: 'T4', verb: 'complete' }])

  const globalTask = fakeRecord()
  await register.press(fakeButton('complete', 'T9', null, globalTask))
  await settle()
  assert.deepEqual(bridge.calls.at(-1), { verb: 'complete', request: { id: 'T9' } }, 'a global task carries no key')
})

test('Complete is refused with its own sentence when the bridge lacks it, and a refusal does not reload', async () => {
  const { register, changed } = mount({ bridge: recordingBridge({ complete: async () => ({ ok: false }) }) })
  const record = fakeRecord()
  await register.press(fakeButton('complete', 'T4', 'node-1', record))
  await settle()
  assert.equal(record.hint.textContent, COMPLETE_ROW.failed)
  assert.deepEqual(changed, [], 'a refused completion reloaded')

  const none = mount({ bridge: null })
  const record2 = fakeRecord()
  await none.register.press(fakeButton('complete', 'T4', 'node-1', record2))
  await settle()
  assert.equal(record2.hint.textContent, COMPLETE_ROW.unavailableWrite)
})

test('Answer opens a blank box (never prefilled with the ask\'s own words), Save sends it verbatim, and an empty Save is refused', async () => {
  const bridge = recordingBridge()
  const changed = []
  const { register } = mount({ bridge, changed })
  const record = fakeRecord()

  await register.press(fakeButton('answer', 'A1', null, record))
  await settle()
  assert.equal(record.slot.hidden, false, 'the answer box did not open')
  assert.match(record.slot.innerHTML, /data-editor-purpose="answer"/, 'the box does not carry its own purpose')
  assert.match(record.slot.innerHTML, /<textarea class="ledger-editor" data-row-editor-words data-editor-purpose="answer"[^>]*><\/textarea>/,
    'Answer must not open on the ask\'s own words -- that is the question, not a place to type over it')
  assert.equal(record.focused, true)

  record.typeWords('')
  await register.press(fakeButton('save', 'A1', null, record))
  await settle()
  assert.deepEqual(bridge.calls, [], 'an empty answer was sent')
  assert.equal(record.hint.textContent, ANSWER_ROW.empty)

  record.typeWords('Use the EU region.')
  await register.press(fakeButton('save', 'A1', null, record))
  await settle()
  assert.deepEqual(bridge.calls, [{ verb: 'answer', request: { id: 'A1', words: 'Use the EU region.' } }], 'Save on an answer box must call answerAsk, not requestEdit')
  assert.deepEqual(changed, [{ id: 'A1', verb: 'answer' }])
})

test('Answer is refused with its own sentence when the bridge lacks it, and Edit is unaffected by Answer\'s absence', async () => {
  const bridge = recordingBridge()
  delete bridge.answerAsk
  const { register } = mount({ bridge })
  const record = fakeRecord()
  await register.press(fakeButton('answer', 'A1', null, record))
  await settle()
  assert.equal(record.slot.hidden, true, 'an unavailable Answer opened a box')
  assert.equal(record.hint.textContent, ANSWER_ROW.unavailableWrite)

  /* Edit still works on the very same bridge: the two verbs are independent,
     the way edit/remove/decide already are. */
  await register.press(fakeButton('edit', 'R3', 'node-1', record))
  await settle()
  assert.equal(record.slot.hidden, false, 'Edit was affected by Answer being unavailable')
})

test('Cancel closes an open Answer box and sends nothing', async () => {
  const bridge = recordingBridge()
  const { register } = mount({ bridge })
  const record = fakeRecord()
  await register.press(fakeButton('answer', 'A1', null, record))
  await settle()
  assert.equal(record.slot.hidden, false)
  await register.press(fakeButton('cancel', 'A1', null, record))
  await settle()
  assert.equal(record.slot.hidden, true)
  assert.equal(record.slot.innerHTML, '')
  assert.deepEqual(bridge.calls, [], 'Cancel on an answer box sent something')
})

/* ---------- each kind's own Delete, and A's own Decline (2026-09-07) ---------- */

test('Delete on a T row sends removeTask, never requestRemove; R\'s own Delete is unaffected', async () => {
  const bridge = recordingBridge()
  const changed = []
  const { register } = mount({ bridge, changed })
  const record = fakeRecord()
  const button = fakeButton('delete', 'T4', 'node-1', record)

  await register.press(button)
  await settle()
  assert.deepEqual(bridge.calls, [], 'the first press sent something')
  await register.press(button)
  await settle()
  assert.deepEqual(bridge.calls, [{ verb: 'removeTask', request: { id: 'T4' } }],
    'a T id must call removeTask, never R\'s requestRemove')
  assert.deepEqual(changed, [{ id: 'T4', verb: 'delete' }])

  /* R's own Delete, on the very same bridge, still calls requestRemove. */
  const rButton = fakeButton('delete', 'R3', 'node-1', record)
  await register.press(rButton)
  await settle()
  await register.press(rButton)
  await settle()
  assert.deepEqual(bridge.calls.at(-1), { verb: 'remove', request: { id: 'R3', key: 'node-1' } })
})

test('Delete on a T row is refused with its own sentence when the bridge lacks removeTask, even though it has requestRemove', async () => {
  const bridge = recordingBridge()
  delete bridge.removeTask
  const { register } = mount({ bridge })
  const record = fakeRecord()
  await register.press(fakeButton('delete', 'T4', 'node-1', record))
  await settle()
  assert.equal(record.hint.textContent, REQUEST_PANEL.deleteUnavailable)
  assert.deepEqual(bridge.calls, [], 'an unavailable removeTask fell back to requestRemove')
})

test('Delete on an A row sends removeAsk, never requestRemove or removeTask', async () => {
  const bridge = recordingBridge()
  const changed = []
  const { register } = mount({ bridge, changed })
  const record = fakeRecord()
  const button = fakeButton('delete', 'A1', null, record)

  await register.press(button)
  await settle()
  await register.press(button)
  await settle()
  assert.deepEqual(bridge.calls, [{ verb: 'removeAsk', request: { id: 'A1' } }],
    'an A id must call removeAsk, never requestRemove or removeTask')
  assert.deepEqual(changed, [{ id: 'A1', verb: 'delete' }])
})

test('Decline on an A row arms, opens a reason box, and the second press sends declineAsk; R\'s own Decline is unaffected', async () => {
  const bridge = recordingBridge()
  const changed = []
  const { register } = mount({ bridge, changed })
  const record = fakeRecord()
  const decline = fakeButton('decline', 'A1', null, record)

  await register.press(decline)
  await settle()
  assert.deepEqual(bridge.calls, [], 'the first Decline press sent something')
  assert.equal(record.hint.textContent, DECIDE_ROW.declineArmed('A1'))
  assert.equal(record.slot.hidden, false, 'no reason box opened')
  record.typeReason('Not this one.')
  await register.press(decline)
  await settle()
  assert.deepEqual(bridge.calls, [{ verb: 'declineAsk', request: { id: 'A1', reason: 'Not this one.' } }],
    'an A id\'s Decline must call declineAsk, never requestDecide')
  assert.deepEqual(changed, [{ id: 'A1', verb: 'decide' }])

  /* R's own Decline, on the very same bridge, still calls requestDecide. */
  const rDecline = fakeButton('decline', 'R9', 'node-1', record)
  await register.press(rDecline)
  await settle()
  await register.press(rDecline)
  await settle()
  assert.deepEqual(bridge.calls.at(-1), { verb: 'decide', request: { id: 'R9', decision: 'decline' } })
})

test('Decline on an A row is refused with its own sentence when the bridge lacks declineAsk, even though it has requestDecide', async () => {
  const bridge = recordingBridge()
  delete bridge.declineAsk
  const { register } = mount({ bridge })
  const record = fakeRecord()
  await register.press(fakeButton('decline', 'A1', null, record))
  await settle()
  assert.equal(record.hint.textContent, REQUEST_PANEL.unavailableWrite)
  assert.deepEqual(bridge.calls, [], 'an unavailable declineAsk fell back to requestDecide')
})

/* ---------- what a Delete or a Decline did, said before the reload ---------- */

test('a rule\'s Delete names its live refinements first, and the outcome lists every id the store removed', async () => {
  const bridge = recordingBridge({ remove: async () => ({ ok: true, removed: ['R3', 'R3.1'] }), removeTask: async () => { throw new Error('R_LEDGER_WRITE_FAILED') } })
  const changed = []
  const outcomes = []
  const register = fakeRegister()
  mountLedgerRowActions(register, {
    bridge,
    onChanged: async change => { changed.push(change) },
    onOutcome: outcome => { outcomes.push(outcome) },
    rowOf: id => ROWS[id] || null,
    refinementsOf: id => (id === 'R3' ? ['R3.1'] : []),
  })
  const record = fakeRecord()
  const button = fakeButton('delete', 'R3', 'node-1', record)
  await register.press(button)
  await settle()
  assert.equal(record.hint.textContent, DELETE_ROW.armed('R3', ['R3.1']))
  assert.match(record.hint.textContent, /R3\.1/, 'the refinement that goes with R3 is not named before the second press')
  await register.press(button)
  await settle()
  assert.deepEqual(outcomes, [{ id: 'R3', verb: 'delete', removed: ['R3', 'R3.1'] }], 'the page is not told which ids went')
  assert.deepEqual(changed, [{ id: 'R3', verb: 'delete' }])

  /* A task's Delete names the task, never "request", when it is refused. */
  const task = fakeRecord()
  const taskButton = fakeButton('delete', 'T4', 'node-1', task)
  await register.press(taskButton)
  await settle()
  assert.equal(task.hint.textContent, DELETE_ROW.armed('T4'))
  await register.press(taskButton)
  await settle()
  assert.equal(task.hint.textContent, 'That task was not deleted. Try once more.')

  /* A Decline says it was a decline. */
  const ask = fakeRecord()
  const decline = fakeButton('decline', 'A1', null, ask)
  await register.press(decline)
  await settle()
  await register.press(decline)
  await settle()
  assert.deepEqual(outcomes.at(-1), { id: 'A1', verb: 'decide', decision: 'decline' })
})

/* ---------- refusals no retry can fix ---------- */

const refusedWith = code => async () => { const error = new Error(`Error invoking remote method 'mc-agent:x': Error: ${code}`); throw error }

test('an ask answered first by its agent says so, keeps the typed answer and has the list read again', async () => {
  const bridge = recordingBridge({ answer: refusedWith('R_LEDGER_STATUS_INVALID'), complete: refusedWith('R_LEDGER_STATUS_INVALID') })
  const changed = []
  const stale = []
  const register = fakeRegister()
  mountLedgerRowActions(register, { bridge, onChanged: async change => { changed.push(change) }, onStale: async change => { stale.push(change) }, rowOf: id => ROWS[id] || null })
  const record = fakeRecord()
  await register.press(fakeButton('answer', 'A1', null, record))
  await settle()
  record.typeWords('No, keep the trash for a week.')
  await register.press(fakeButton('save', 'A1', null, record))
  await settle()
  assert.equal(bridge.calls.length, 1)
  assert.equal(record.hint.textContent, ANSWER_ROW.gone('A1'))
  assert.doesNotMatch(record.hint.textContent, /try once more/i)
  assert.equal(record.querySelector('[data-row-editor-words]').value, 'No, keep the trash for a week.', 'the typed answer was thrown away')
  assert.deepEqual(stale, [{ id: 'A1', verb: 'answer', sentence: ANSWER_ROW.gone('A1') }], 'the list was not read again')
  assert.deepEqual(changed, [], 'a refusal must not pretend the write landed')

  const task = fakeRecord()
  await register.press(fakeButton('complete', 'T4', 'node-1', task))
  await settle()
  assert.equal(task.hint.textContent, COMPLETE_ROW.gone('T4'))
  assert.equal(stale.at(-1).verb, 'complete')
})

test('history that needs review or is damaged, and text longer than the store keeps, are never "Try once more"', async () => {
  const bridge = recordingBridge({
    edit: refusedWith('AGENT_REQUEST_CHAIN_APPEND_UNCONFIRMED'),
    complete: refusedWith('R_LEDGER_CHAIN_APPEND_UNCONFIRMED'),
    removeTask: refusedWith('R_LEDGER_CHAIN_BROKEN'),
  })
  const { register } = mount({ bridge })
  const edit = fakeRecord()
  await register.press(fakeButton('edit', 'R3', 'node-1', edit))
  await settle()
  edit.typeWords('Reworded.')
  await register.press(fakeButton('save', 'R3', 'node-1', edit))
  await settle()
  assert.equal(edit.hint.textContent, LEDGER_REFUSAL.historyUnconfirmed)
  const complete = fakeRecord()
  await register.press(fakeButton('complete', 'T4', 'node-1', complete))
  await settle()
  assert.equal(complete.hint.textContent, LEDGER_REFUSAL.historyUnconfirmed)
  const remove = fakeRecord()
  const removeButton = fakeButton('delete', 'T4', 'node-1', remove)
  await register.press(removeButton)
  await settle()
  await register.press(removeButton)
  await settle()
  assert.equal(remove.hint.textContent, LEDGER_REFUSAL.historyDamaged)

  /* Too long, said before anything is sent, and the words stay. */
  const calls = bridge.calls.length
  const answer = fakeRecord()
  await register.press(fakeButton('answer', 'A1', null, answer))
  await settle()
  const long = 'x'.repeat(17_500)
  answer.typeWords(long)
  await register.press(fakeButton('save', 'A1', null, answer))
  await settle()
  assert.equal(bridge.calls.length, calls, 'an answer over the store\'s limit was sent anyway')
  assert.equal(answer.hint.textContent, LEDGER_REFUSAL.wordsTooLong)
  assert.equal(answer.querySelector('[data-row-editor-words]').value, long)
  const decline = fakeRecord()
  const declineButton = fakeButton('decline', 'R9', 'node-1', decline)
  await register.press(declineButton)
  await settle()
  decline.typeReason('拒'.repeat(702))
  await register.press(declineButton)
  await settle()
  assert.equal(bridge.calls.length, calls, 'a reason over 2,048 bytes was sent anyway')
  assert.equal(decline.hint.textContent, LEDGER_REFUSAL.reasonTooLong)
})
