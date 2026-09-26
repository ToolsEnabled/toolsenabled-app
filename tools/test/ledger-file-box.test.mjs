/* THE BOX THAT FILES A REQUEST FROM THE LEDGER PAGE.
 *
 * src/ledger-file-box.js is pure over the slot it is handed, so this suite
 * drives it against a stand-in slot, a planted fleet-tree record in a stand-in
 * storage, and a recording bridge:
 *
 *   PICKER   the tree and circle choices are every node of the saved trees,
 *            named the way the Computers page names them; the session choices
 *            are only the nodes with a session on record
 *   SUBMIT   sends scope, key, the words exactly as typed, and the label the
 *            person saw; shows the one-sentence confirmation; reloads
 *   REFUSALS empty words, no target, an example register, a bridge refusal --
 *            each a sentence under the button and nothing sent
 *   ABSENT   an older bridge with no filing verb draws no box at all
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { fileBoxMarkup, keyChoicesFor, mountLedgerFileBox, storedFleetTrees } from '../../src/ledger-file-box.js'
import { EXAMPLE_WRITE_NOTE, FILE_BOX, LEDGER_REFUSAL, SCOPE_FILTER } from '../../src/ledger-copy.js'
import { REQUEST_PANEL } from '../../src/tree-standing-requests.js'
import { requestConfirmationSentence } from '../../src/slash-commands.js'
import { TASK_DIFFICULTIES, taskDifficultyFieldMarkup, taskDifficultyLabel, taskFailedReviewsLabel, taskDifficultyMetadataMarkup } from '../../src/task-difficulty.js'

const settle = async () => { for (let turn = 0; turn < 8; turn += 1) await Promise.resolve() }

const STAMP = '2026-08-30T10:00:00.000Z'

/* A saved fleet-tree record in the shape src/fleet-trees.js writes: one tree,
   a coordinator with a session on record and a draft worker under it. */
const RECORD = Object.freeze({
  version: 1,
  computerId: 'this-computer',
  trees: [{ id: 'tree-1', name: null, createdAt: STAMP, updatedAt: STAMP }],
  nodes: [
    { id: 'node-1-abc12345', treeId: 'tree-1', parentId: null, role: 'coordinator', message: 'Plan the week', status: 'starting', sessionId: 'chat-11111111', createdAt: STAMP, updatedAt: STAMP },
    { id: 'node-2-def67890', treeId: 'tree-1', parentId: 'node-1-abc12345', role: 'manager', message: '', status: 'draft', sessionId: null, createdAt: STAMP, updatedAt: STAMP },
    { id: 'node-3-aaa11111', treeId: 'tree-1', parentId: 'node-1-abc12345', role: 'manager', message: '', status: 'draft', sessionId: null, createdAt: STAMP, updatedAt: STAMP },
  ],
})

function fakeStorage(entries = {}) {
  const map = new Map(Object.entries(entries))
  return {
    get length() { return map.size },
    key: index => [...map.keys()][index] ?? null,
    getItem: key => (map.has(key) ? map.get(key) : null),
  }
}

function decode(text) {
  return String(text).replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&')
}

/* A stand-in slot: innerHTML is kept as the painted string; the selects, the
   textarea and the output are answered from it. */
function fakeSlot() {
  const paints = []
  const listeners = new Map()
  const fields = new Map()
  const output = { textContent: '', dataset: {} }
  const slot = {
    hidden: true,
    get innerHTML() { return paints[paints.length - 1] || '' },
    set innerHTML(value) { paints.push(String(value)); fields.clear() },
    querySelector(selector) {
      const html = slot.innerHTML
      if (selector === '[data-action-output]') return html.includes('data-action-output') ? output : null
      if (selector === '[data-file-words]') {
        if (!html.includes('data-file-words')) return null
        if (!fields.has('words')) fields.set('words', { value: '' })
        return fields.get('words')
      }
      if (selector === '[data-ledger-file]') {
        if (!html.includes('data-ledger-file')) return null
        if (!fields.has('submit')) fields.set('submit', { disabled: false })
        return fields.get('submit')
      }
      if (selector === '[data-task-grading-refresh]') {
        if (!html.includes('data-task-grading-refresh')) return null
        if (!fields.has('grading-refresh')) {
          const buttonListeners = new Map()
          const button = {
            disabled: /data-task-grading-refresh(?: disabled| )/.test(html),
            onclick: null,
            closest: target => (target === '[data-task-grading-refresh]' ? button : null),
            addEventListener(type, fn) { buttonListeners.set(type, fn) },
            removeEventListener(type, fn) { if (buttonListeners.get(type) === fn) buttonListeners.delete(type) },
            async click() {
              const event = { target: button, preventDefault() {} }
              await button.onclick?.(event)
              await buttonListeners.get('click')?.(event)
              await listeners.get('click')?.(event)
            },
          }
          fields.set('grading-refresh', button)
        }
        return fields.get('grading-refresh')
      }
      if (selector === '[data-task-difficulty]') {
        const name = 'difficulty'
        const block = new RegExp('<select name="' + name + '"[^>]*>([\\s\\S]*?)</select>').exec(html)
        if (!block) return null
        if (!fields.has(name)) {
          const options = [...block[1].matchAll(/<option value="([^"]*)"( selected)?>([^<]*)<\/option>/g)]
            .map(match => ({ value: decode(match[1]), textContent: decode(match[3]), selected: Boolean(match[2]) }))
          const chosen = options.find(option => option.selected) || options[0] || null
          const select = {
            options,
            disabled: / disabled(?:[ >])/.test(block[0]),
            required: / required(?:[ >])/.test(block[0]),
            value: chosen ? chosen.value : '',
            get selectedOptions() { return [this.options.find(option => option.value === this.value)].filter(Boolean) },
            closest: target => (target === '[data-task-difficulty]' ? select : null),
          }
          fields.set(name, select)
        }
        return fields.get(name)
      }
      if (selector === '[data-file-scope]' || selector === '[data-file-key]') {
        const name = selector === '[data-file-scope]' ? 'scope' : 'key'
        const block = new RegExp(`<select name="${name}"[^>]*>([\\s\\S]*?)</select>`).exec(html)
        if (!block) return null
        if (!fields.has(name)) {
          const options = [...block[1].matchAll(/<option value="([^"]*)"( selected)?>([^<]*)<\/option>/g)]
            .map(match => ({ value: decode(match[1]), textContent: decode(match[3]), selected: Boolean(match[2]) }))
          const chosen = options.find(option => option.selected) || options[0] || null
          const select = {
            options,
            disabled: /<select name="key"[^>]* disabled/.test(block[0]),
            value: chosen ? chosen.value : '',
            get selectedOptions() { return [this.options.find(option => option.value === this.value)].filter(Boolean) },
            closest: target => (target === '[data-file-scope]' && name === 'scope' ? select : null),
          }
          fields.set(name, select)
        }
        return fields.get(name)
      }
      return null
    },
    addEventListener(type, fn) { listeners.set(type, fn) },
    removeEventListener(type, fn) { if (listeners.get(type) === fn) listeners.delete(type) },
    paints: () => paints.slice(),
    output,
    /* Presses and picks, the way the DOM would deliver them. */
    async submit() {
      let prevented = false
      await listeners.get('submit')?.({ preventDefault() { prevented = true } })
      return prevented
    },
    async pick(scope) {
      const select = slot.querySelector('[data-file-scope]')
      select.value = scope
      await listeners.get('change')?.({ target: select })
    },
    async pickDifficulty(value) {
      const select = slot.querySelector('[data-task-difficulty]')
      if (!select) return
      select.value = value
      await listeners.get('change')?.({ target: select })
    },
    type(words) { slot.querySelector('[data-file-words]').value = words },
    bound: type => listeners.has(type),
  }
  return slot
}

function recordingBridge(answer = async () => ({ ok: true, id: 'R12', scope: 'global', key: null, status: 'open' })) {
  const calls = []
  return { calls, request: async request => { calls.push(request); return answer(request) } }
}

function gradingSettings({ value = false, result = null, error = null } = {}) {
  const reads = []
  return {
    reads,
    async read() {
      reads.push(1)
      if (error) throw error
      return result || {
        ok: true,
        available: true,
        rows: [{ id: 'agent.task_difficulty_enabled', present: true, control: 'toggle', value }],
        rejected: [],
      }
    },
  }
}

/* ---------- the picker ---------- */

test('the saved trees are read back through the parser, and the picker names nodes the way the Computers page does', () => {
  const storage = fakeStorage({
    'mc.fleet.trees.v1:this-computer': JSON.stringify(RECORD),
    'mc.fleet.trees.v1:other': 'not json',
    'mc.other': JSON.stringify(RECORD),
  })
  const records = storedFleetTrees(storage)
  assert.equal(records.length, 1, 'a damaged record reads as no trees, and an unrelated key is not a record')
  const tree = keyChoicesFor('tree', records)
  assert.deepEqual(tree, [
    { value: 'node-1-abc12345', label: 'Coordinator', text: 'Coordinator' },
    { value: 'node-2-def67890', label: 'Manager', text: 'Manager' },
    { value: 'node-3-aaa11111', label: 'Manager 2', text: 'Manager 2' },
  ], 'tree choices are every node, named by role with an ordinal among same-role peers')
  assert.deepEqual(keyChoicesFor('thread', records), tree, 'a circle is anchored on the same nodes')
  assert.deepEqual(keyChoicesFor('session', records), [
    { value: 'chat-11111111', label: 'Coordinator', text: `Coordinator · ${FILE_BOX.runningNow}` },
  ], 'session choices are only the nodes with a live session on record, keyed by the session; the label sent is the name alone')
  assert.deepEqual(keyChoicesFor('tree', []), [])
  assert.deepEqual(storedFleetTrees(null), [])
  assert.deepEqual(storedFleetTrees({ getItem: () => null }), [])
})

test('a session that has finished, failed or was interrupted is not offered as running now, and the label sent never carries the words', async () => {
  /* The saved record keeps the session id on every node that ever ran; only
     a running or starting one can take a session rule. */
  const dead = ['finished', 'failed', 'interrupted', 'turn-failed'].map((status, index) => ({
    id: `node-${index + 4}-dead0000`, treeId: 'tree-1', parentId: 'node-1-abc12345', role: 'worker', message: '', status, sessionId: `chat-dead000${index}`, createdAt: STAMP, updatedAt: STAMP,
  }))
  const record = { ...RECORD, nodes: [...RECORD.nodes, ...dead] }
  const records = storedFleetTrees(fakeStorage({ 'mc.fleet.trees.v1:this-computer': JSON.stringify(record) }))
  assert.equal(records[0].nodes.length, 7, 'the fixture did not parse whole')
  const session = keyChoicesFor('session', records)
  assert.deepEqual(session.map(choice => choice.value), ['chat-11111111'], 'a dead session was offered as running now')
  assert.equal(session[0].label, 'Coordinator')
  assert.ok(session[0].text.includes(FILE_BOX.runningNow), 'the picker no longer says the session is running now')
  assert.ok(!session[0].label.includes(FILE_BOX.runningNow), '"running now" would be frozen onto the record')

  /* The record keeps the name alone: the words in the picker stay there. */
  const bridge = recordingBridge(async () => ({ ok: true, id: 'R13', scope: 'session', key: 'chat-11111111', status: 'open' }))
  const slot = fakeSlot()
  mountLedgerFileBox(slot, { bridge, storage: fakeStorage({ 'mc.fleet.trees.v1:this-computer': JSON.stringify(record) }) })
  await slot.pick('session')
  assert.match(slot.innerHTML, new RegExp(`<option value="chat-11111111">Coordinator · ${FILE_BOX.runningNow}</option>`), 'the option text does not say running now')
  assert.doesNotMatch(slot.innerHTML, /chat-dead000/, 'a dead session is in the picker')
  slot.type('Only while this session runs.')
  await slot.submit()
  await settle()
  assert.deepEqual(bridge.calls, [{ scope: 'session', key: 'chat-11111111', words: 'Only while this session runs.', label: 'Coordinator' }],
    'the label sent must be the node\'s display name alone')
})

test('the markup carries the four reaches, the reach sentence, and the key row only for a keyed scope', () => {
  const global = fileBoxMarkup({ scope: 'global', choices: [] })
  assert.ok(global.includes(FILE_BOX.title))
  for (const scope of ['global', 'session', 'tree', 'thread']) {
    assert.match(global, new RegExp(`<option value="${scope}"[^>]*>${SCOPE_FILTER[scope]}</option>`), `${scope} is not offered`)
  }
  assert.match(global, /<option value="global" selected>/)
  assert.ok(global.includes(FILE_BOX.reach.global), 'the reach sentence is not under the picker')
  assert.match(global, /<label data-file-key-row hidden>/, 'the key row is drawn open for a global rule')
  assert.match(global, /<button type="submit" data-ledger-file>/)
  assert.ok(global.includes(FILE_BOX.submit))
  assert.match(global, /<textarea name="words" data-file-words rows="3" maxlength="16384"/)

  const tree = fileBoxMarkup({ scope: 'tree', choices: [{ value: 'node-1', label: 'Coordinator <1>' }] })
  assert.match(tree, /<label data-file-key-row>/, 'the key row is hidden for a tree rule')
  assert.match(tree, /<option value="node-1">Coordinator &lt;1&gt;<\/option>/, 'the label is not escaped')
  assert.ok(tree.includes(FILE_BOX.reach.tree))
  assert.match(tree, /data-file-key-hint hidden/, 'the nothing-to-pick sentence shows beside a filled picker')

  const none = fileBoxMarkup({ scope: 'session', choices: [] })
  assert.match(none, /<select name="key" data-file-key disabled>/, 'an empty picker stays live')
  assert.ok(none.includes(FILE_BOX.nothingToPick.session), 'an empty picker has no sentence beside it')
})

/* ---------- filing ---------- */

test('submit sends scope, key, the words as typed and the label the person saw, then shows the confirmation and reloads', async () => {
  const bridge = recordingBridge(async () => ({ ok: true, id: 'R12', scope: 'tree', key: 'node-1-abc12345', status: 'open' }))
  const slot = fakeSlot()
  const filed = []
  const storage = fakeStorage({ 'mc.fleet.trees.v1:this-computer': JSON.stringify(RECORD) })
  mountLedgerFileBox(slot, { bridge, storage, onFiled: async change => { filed.push(change) } })
  assert.equal(slot.hidden, false)
  assert.ok(slot.innerHTML.includes(FILE_BOX.title))

  slot.type('  Keep <the> tests green.\nAlways.  ')
  await slot.pick('tree')
  assert.equal(slot.querySelector('[data-file-words]').value, '  Keep <the> tests green.\nAlways.  ', 'picking the reach lost the words')
  assert.match(slot.innerHTML, /<option value="tree" selected>/)
  assert.match(slot.innerHTML, /<option value="node-1-abc12345">Coordinator<\/option>/)
  const prevented = await slot.submit()
  await settle()
  assert.equal(prevented, true, 'the form was allowed to submit itself')
  assert.deepEqual(bridge.calls, [{ scope: 'tree', key: 'node-1-abc12345', words: '  Keep <the> tests green.\nAlways.  ', label: 'Coordinator' }],
    'the filing did not carry scope, key, verbatim words and the label once')
  assert.equal(slot.output.textContent, requestConfirmationSentence('tree', 'R12'))
  assert.equal(slot.output.dataset.state, 'confirmed')
  assert.deepEqual(filed, [{ id: 'R12', scope: 'tree', key: 'node-1-abc12345' }], 'a successful filing did not reload')
  assert.equal(slot.querySelector('[data-file-words]').value, '', 'the words stayed in the box after filing')

  /* A global rule: no key and no label on the wire. */
  await slot.pick('global')
  slot.type('Placeholder global rule.')
  await slot.submit()
  await settle()
  assert.deepEqual(bridge.calls.at(-1), { scope: 'global', words: 'Placeholder global rule.' })
})

test('empty words, a keyed scope with nothing to pick, and an example register are each refused before anything is sent', async () => {
  const bridge = recordingBridge()
  const slot = fakeSlot()
  const storage = fakeStorage({ 'mc.fleet.trees.v1:this-computer': JSON.stringify({ ...RECORD, nodes: RECORD.nodes.map(node => ({ ...node, status: 'draft', sessionId: null })) }) })
  mountLedgerFileBox(slot, { bridge, storage })
  slot.type('   ')
  await slot.submit()
  await settle()
  assert.equal(slot.output.textContent, FILE_BOX.empty)
  assert.equal(slot.output.dataset.state, 'refused')

  await slot.pick('session')
  assert.ok(slot.innerHTML.includes(FILE_BOX.nothingToPick.session), 'no sentence says there is no session to pick')
  slot.type('A session rule with nowhere to go.')
  await slot.submit()
  await settle()
  assert.equal(slot.output.textContent, FILE_BOX.noTarget)
  assert.deepEqual(bridge.calls, [], 'a refused filing reached the bridge')

  const example = fakeSlot()
  mountLedgerFileBox(example, { bridge, storage, isBadged: () => true })
  example.type('Placeholder.')
  await example.submit()
  await settle()
  assert.equal(example.output.textContent, EXAMPLE_WRITE_NOTE)
  assert.equal(example.output.dataset.state, 'note')
  assert.deepEqual(bridge.calls, [], 'an example register reached the bridge')
})

test('a bridge refusal is a sentence under the button, and the words stay', async () => {
  const tooLong = new Error("Error invoking remote method 'mc-agent:request': Error: AGENT_REQUEST_WORDS_TOO_LONG")
  const bridge = recordingBridge(async () => { throw tooLong })
  const slot = fakeSlot()
  const filed = []
  mountLedgerFileBox(slot, { bridge, storage: fakeStorage(), onFiled: () => { filed.push(1) } })
  slot.type('A very long rule.')
  await slot.submit()
  await settle()
  assert.equal(bridge.calls.length, 1)
  assert.equal(slot.output.textContent, REQUEST_PANEL.tooLong)
  assert.equal(slot.output.dataset.state, 'refused')
  assert.equal(slot.querySelector('[data-file-words]').value, 'A very long rule.', 'the words were lost on refusal')
  assert.deepEqual(filed, [])

  const readOnly = recordingBridge(async () => { const e = new Error('MC_AGENT_PRINCIPAL_READ_ONLY'); e.code = 'MC_AGENT_PRINCIPAL_READ_ONLY'; throw e })
  const slot2 = fakeSlot()
  mountLedgerFileBox(slot2, { bridge: readOnly, storage: fakeStorage() })
  slot2.type('Placeholder.')
  await slot2.submit()
  await settle()
  assert.equal(slot2.output.textContent, REQUEST_PANEL.readOnly)

  const silent = recordingBridge(async () => ({ ok: false }))
  const slot3 = fakeSlot()
  mountLedgerFileBox(slot3, { bridge: silent, storage: fakeStorage() })
  slot3.type('Placeholder.')
  await slot3.submit()
  await settle()
  assert.equal(slot3.output.textContent, FILE_BOX.failed)
})

test('a bridge with no filing verb draws no box, and destroy unbinds', async () => {
  const slot = fakeSlot()
  slot.innerHTML = 'stale'
  const destroy = mountLedgerFileBox(slot, { bridge: { requests: async () => ({ ok: true, entries: [] }) }, storage: fakeStorage() })
  assert.equal(slot.hidden, true)
  assert.equal(slot.innerHTML, '')
  assert.equal(slot.bound('submit'), false)
  destroy()

  const live = fakeSlot()
  const stop = mountLedgerFileBox(live, { bridge: recordingBridge(), storage: fakeStorage() })
  assert.equal(live.bound('submit'), true)
  assert.equal(live.bound('change'), true)
  stop()
  assert.equal(live.bound('submit'), false, 'destroy left the submit listener bound')
  assert.equal(live.bound('change'), false)
  assert.equal(typeof mountLedgerFileBox(null, {}), 'function', 'a missing slot still answers a destroy')
})

test('R and T filing stay on their matching page and keep separate exact drafts through other tabs', async () => {
  const slot = fakeSlot()
  const bridge = recordingBridge(async request => ({ ok: true, id: request.kind === 'T' ? 'T23' : 'R23' }))
  const hand = mountLedgerFileBox(slot, { bridge, kind: 'all', settingsBridge: gradingSettings() })
  for (const mode of ['all', 'a', 'p', 'q', 'unknown']) {
    hand.setKind(mode)
    assert.equal(slot.hidden, true)
    assert.equal(slot.innerHTML, '')
    await hand.submit({ preventDefault() {} })
  }
  assert.equal(bridge.calls.length, 0)
  hand.setKind('r')
  slot.type('  Rule draft\nverbatim.  ')
  hand.setKind('t')
  await settle()
  assert.equal(slot.querySelector('[data-file-words]').value, '')
  assert.ok(slot.innerHTML.includes('File a task'))
  slot.type('  Task draft\nverbatim.  ')
  hand.setKind('all')
  hand.setKind('r')
  assert.equal(slot.querySelector('[data-file-words]').value, '  Rule draft\nverbatim.  ')
  hand.setKind('t')
  await settle()
  assert.equal(slot.querySelector('[data-file-words]').value, '  Task draft\nverbatim.  ')
  await slot.submit()
  assert.deepEqual(bridge.calls, [{ scope: 'global', words: '  Task draft\nverbatim.  ', kind: 'T' }])
  assert.match(slot.output.textContent, /^Filed T23/)
  assert.equal(slot.querySelector('[data-file-words]').value, '')
  hand.setKind('r')
  assert.equal(slot.querySelector('[data-file-words]').value, '  Rule draft\nverbatim.  ')
  await slot.submit()
  assert.deepEqual(bridge.calls.at(-1), { scope: 'global', words: '  Rule draft\nverbatim.  ' })
  hand()
})

test('task blank, unavailable target and permission refusal keep the typed task and never report success', async () => {
  const slot = fakeSlot()
  const bridge = recordingBridge(async () => { throw Object.assign(new Error('read only'), { code: 'MC_AGENT_PRINCIPAL_READ_ONLY' }) })
  const hand = mountLedgerFileBox(slot, { bridge, kind: 't', settingsBridge: gradingSettings() })
  await settle()
  slot.type(' \n ')
  await slot.submit()
  assert.equal(bridge.calls.length, 0)
  assert.match(slot.output.textContent, /Type the task first/)
  await slot.pick('session')
  slot.type('No target.')
  await slot.submit()
  assert.equal(bridge.calls.length, 0)
  await slot.pick('global')
  slot.type('Keep this task.')
  await slot.submit()
  assert.equal(bridge.calls.length, 1)
  assert.equal(slot.output.dataset.state, 'refused')
  assert.equal(slot.querySelector('[data-file-words]').value, 'Keep this task.')
  hand.setKind('r')
  hand.setKind('t')
  await settle()
  assert.equal(slot.output.textContent, REQUEST_PANEL.readOnly)
  assert.equal(slot.querySelector('[data-file-words]').value, 'Keep this task.')
  hand()
})

test('an older save cannot clear a new draft or report its scope on a different Ledger page', async () => {
  let answer
  const slot = fakeSlot()
  const bridge = recordingBridge(() => new Promise(resolve => { answer = resolve }))
  const changes = []
  const storage = fakeStorage({ 'mc.fleet.trees.v1:this-computer': JSON.stringify(RECORD) })
  const hand = mountLedgerFileBox(slot, { bridge, storage, kind: 'r', onFiled: change => changes.push(change) })
  await slot.pick('tree')
  slot.type('First rule.')
  const pending = slot.submit()
  await slot.submit()
  assert.equal(bridge.calls.length, 1)
  slot.type('A later unsaved rule.')
  hand.setKind('t')
  slot.type('A separate task.')
  answer({ ok: true, id: 'R24' })
  await pending
  assert.equal(slot.querySelector('[data-file-words]').value, 'A separate task.')
  assert.equal(slot.output.textContent, '')
  assert.deepEqual(changes, [{ id: 'R24', scope: 'tree', key: 'node-1-abc12345' }])
  hand.setKind('r')
  assert.equal(slot.querySelector('[data-file-words]').value, 'A later unsaved rule.')
  assert.equal(slot.output.textContent, requestConfirmationSentence('tree', 'R24'))
  hand()
})

test('unexpected record kind and post-save refresh error report the actual outcome without losing a draft', async () => {
  const slot = fakeSlot()
  const changes = []
  const hand = mountLedgerFileBox(slot, { kind: 't', bridge: recordingBridge(), settingsBridge: gradingSettings(), onFiled: change => changes.push(change) })
  await settle()
  slot.type('A task must not be confirmed as a standing rule.')
  await slot.submit()
  assert.equal(slot.output.dataset.state, 'refused')
  assert.match(slot.output.textContent, /different record type/)
  assert.equal(changes.length, 0)
  assert.equal(slot.querySelector('[data-file-words]').value, 'A task must not be confirmed as a standing rule.')
  hand()
  const other = fakeSlot()
  const stop = mountLedgerFileBox(other, { kind: 't',
    bridge: recordingBridge(async () => ({ ok: true, id: 'T25' })),
    settingsBridge: gradingSettings(),
    onFiled: async () => { throw new Error('read unavailable') } })
  await settle()
  other.type('Save succeeded, refresh failed.')
  await other.submit()
  assert.equal(other.output.dataset.state, 'confirmed')
  assert.match(other.output.textContent, /^Filed T25/)
  assert.match(other.output.textContent, /list could not refresh/)
  assert.equal(other.querySelector('[data-file-words]').value, '')
  stop()
})

test('destroyed filing forms ignore late answers and cannot issue further writes', async () => {
  let answer
  const slot = fakeSlot()
  const bridge = recordingBridge(() => new Promise(resolve => { answer = resolve }))
  let changed = 0
  const hand = mountLedgerFileBox(slot, { bridge, kind: 't', settingsBridge: gradingSettings(), onFiled: () => { changed++ } })
  await settle()
  slot.type('Pending task.')
  const pending = slot.submit()
  hand()
  answer({ ok: true, id: 'T26' })
  await pending
  await hand.submit({ preventDefault() {} })
  assert.equal(bridge.calls.length, 1)
  assert.equal(changed, 0)
})

/* ---------- nothing to file under, and history that needs review ---------- */

test('with nothing to file under, File it is off beside the reason; a refusal from unconfirmed history names the review', async () => {
  const slot = fakeSlot()
  const storage = fakeStorage({ 'mc.fleet.trees.v1:this-computer': JSON.stringify({ ...RECORD, nodes: [] }) })
  mountLedgerFileBox(slot, { bridge: recordingBridge(), storage })
  for (const scope of ['tree', 'thread', 'session']) {
    await slot.pick(scope)
    assert.ok(slot.innerHTML.includes(FILE_BOX.nothingToPick[scope]))
    assert.match(slot.innerHTML, /<button type="submit" data-ledger-file disabled>/, `File it stays on with nothing to file under for ${scope}`)
  }
  await slot.pick('global')
  assert.match(slot.innerHTML, /<button type="submit" data-ledger-file>/, 'Everywhere always has somewhere to file')

  const refused = fakeSlot()
  const bridge = recordingBridge(async () => { throw new Error("Error invoking remote method 'mc-agent:request': Error: AGENT_REQUEST_CHAIN_APPEND_UNCONFIRMED") })
  mountLedgerFileBox(refused, { bridge, storage })
  refused.type('Always ask before deleting.')
  await refused.submit()
  await settle()
  assert.equal(refused.output.textContent, LEDGER_REFUSAL.historyUnconfirmed)
  assert.doesNotMatch(refused.output.textContent, /try once more/i)
})

test('task difficulty helpers expose the three grades and honest legacy metadata', () => {
  assert.deepEqual(TASK_DIFFICULTIES, ['easy', 'medium', 'hard'])
  assert.equal(taskDifficultyLabel('easy'), 'Easy')
  assert.equal(taskDifficultyLabel('medium'), 'Medium')
  assert.equal(taskDifficultyLabel('hard'), 'Hard')
  assert.equal(taskDifficultyLabel('legacy'), 'Not graded')
  assert.equal(taskFailedReviewsLabel(0), 'Did not pass review 0 times')
  assert.equal(taskFailedReviewsLabel(1), 'Did not pass review 1 time')
  assert.equal(taskFailedReviewsLabel(2), 'Did not pass review 2 times')
  assert.equal(taskFailedReviewsLabel(-1), '')
  assert.equal(taskFailedReviewsLabel(undefined), '')

  const enabled = taskDifficultyFieldMarkup({ enabled: true, value: 'medium' })
  assert.match(enabled, /data-task-difficulty required/)
  assert.match(enabled, /<option value="medium" selected>Medium<\/option>/)
  for (const grade of TASK_DIFFICULTIES) assert.match(enabled, new RegExp('value="' + grade + '"'))
  assert.equal(taskDifficultyFieldMarkup({ enabled: false, value: 'easy' }), '')

  // A task filed before grading shows nothing on its row: no grade, no count.
  assert.equal(taskDifficultyMetadataMarkup({ difficulty: 'legacy', failedReviewCount: undefined }), '')
  const graded = taskDifficultyMetadataMarkup({ difficulty: 'medium', failedReviewCount: 1 })
  assert.match(graded, /data-task-difficulty-value[^>]*>.*medium<\/span>/)
  assert.match(graded, /data-task-failed-reviews[^>]*>.*1 fail<.*Did not pass review 1 time</)
})

test('enabled task filing requires easy, medium or hard and sends the selected grade', async () => {
  for (const [index, difficulty] of TASK_DIFFICULTIES.entries()) {
    const bridge = recordingBridge(async () => ({ ok: true, id: 'T' + (30 + index) }))
    const settingsBridge = gradingSettings({ value: true })
    const slot = fakeSlot()
    mountLedgerFileBox(slot, { bridge, kind: 't', settingsBridge })
    await settle()

    const field = slot.querySelector('[data-task-difficulty]')
    assert.ok(field, 'enabled grading did not draw a difficulty control')
    assert.equal(field.required, true)
    assert.deepEqual(field.options.map(option => option.value), ['', 'easy', 'medium', 'hard'])

    slot.type('Task ' + difficulty)
    await slot.submit()
    assert.equal(bridge.calls.length, 0, 'a new task without a grade reached the bridge')
    assert.match(slot.output.textContent, /Choose Easy, Medium or Hard/)

    await slot.pickDifficulty(difficulty)
    await slot.submit()
    await settle()
    assert.deepEqual(bridge.calls, [{
      scope: 'global',
      words: 'Task ' + difficulty,
      kind: 'T',
      difficulty,
    }])
    assert.equal(slot.output.dataset.state, 'confirmed')
    assert.equal(slot.querySelector('[data-task-difficulty]').value, '', 'a matching successful task did not clear its grade')
  }
})

test('grading turned on elsewhere: the refusal asks for a grade, keeps the words and shows the choice', async () => {
  let enabled = false
  const settingsBridge = {
    async read() {
      return { ok: true, available: true, rejected: [],
        rows: [{ id: 'agent.task_difficulty_enabled', present: true, control: 'toggle', value: enabled }] }
    },
  }
  const bridge = recordingBridge(async request => (request.difficulty
    ? { ok: true, id: 'T61' }
    : { ok: false, code: 'AGENT_REQUEST_DIFFICULTY_REQUIRED' }))
  const slot = fakeSlot()
  mountLedgerFileBox(slot, { bridge, kind: 't', settingsBridge })
  await settle()
  assert.equal(slot.querySelector('[data-task-difficulty]'), null, 'grading read as off')
  enabled = true // the person turns grading on in Settings while this page is open
  slot.type('Graded elsewhere.')
  await slot.submit()
  await settle()
  assert.deepEqual(bridge.calls, [{ scope: 'global', words: 'Graded elsewhere.', kind: 'T' }])
  assert.equal(slot.output.dataset.state, 'refused')
  assert.equal(slot.output.textContent, 'Choose Easy, Medium or Hard for this new task.')
  assert.equal(slot.querySelector('[data-file-words]').value, 'Graded elsewhere.', 'the refusal kept the words')
  assert.ok(slot.querySelector('[data-task-difficulty]'), 'the page read grading again and now asks for the grade')
  await slot.pickDifficulty('medium')
  await slot.submit()
  await settle()
  assert.deepEqual(bridge.calls[1], { scope: 'global', words: 'Graded elsewhere.', kind: 'T', difficulty: 'medium' })
  assert.equal(slot.output.dataset.state, 'confirmed')
})

test('an explicit false grading read keeps legacy task filing ordinary and omits difficulty', async () => {
  const bridge = recordingBridge(async () => ({ ok: true, id: 'T60' }))
  const slot = fakeSlot()
  const settingsBridge = gradingSettings({ value: false })
  mountLedgerFileBox(slot, { bridge, kind: 't', settingsBridge })
  await settle()

  assert.equal(slot.querySelector('[data-task-difficulty]'), null)
  assert.equal(slot.querySelector('[data-ledger-file]').disabled, false)
  slot.type('Legacy task.')
  await slot.submit()
  await settle()
  assert.deepEqual(bridge.calls, [{ scope: 'global', words: 'Legacy task.', kind: 'T' }])
  assert.equal(slot.output.dataset.state, 'confirmed')
})

test('missing, rejected, malformed and thrown grading reads lock only tasks while rules remain fileable', async () => {
  const cases = [
    ['missing', gradingSettings({
      result: { ok: true, available: true, rows: [], rejected: [] },
    })],
    ['rejected', gradingSettings({
      result: {
        ok: true,
        available: true,
        rows: [{ id: 'agent.task_difficulty_enabled', present: true, control: 'toggle', value: true }],
        rejected: [{ id: 'agent.task_difficulty_enabled', reason: 'unavailable' }],
      },
    })],
    ['malformed', gradingSettings({
      result: {
        ok: true,
        available: true,
        rows: [{ id: 'agent.task_difficulty_enabled', present: true, control: 'text', value: true }],
        rejected: [],
      },
    })],
    ['malformed-rows', gradingSettings({ result: { ok: true, available: true, rows: { find: true } } })],
    ['null-row', gradingSettings({ result: { ok: true, available: true, rows: [null] } })],
    ['duplicate-row', gradingSettings({ result: { ok: true, available: true, rows: [
      { id: 'agent.task_difficulty_enabled', present: true, control: 'toggle', value: true },
      { id: 'agent.task_difficulty_enabled', present: true, control: 'toggle', value: false },
    ] } })],
    ['thrown', gradingSettings({ error: new Error('settings unavailable') })],
  ]

  for (const [index, [label, settingsBridge]] of cases.entries()) {
    const bridge = recordingBridge(async () => ({ ok: true, id: 'R' + (80 + index) }))
    const slot = fakeSlot()
    const hand = mountLedgerFileBox(slot, { bridge, kind: 't', settingsBridge })
    await settle()

    assert.equal(slot.querySelector('[data-ledger-file]').disabled, true, label + ' grading read enabled the task')
    assert.equal(slot.querySelector('[data-task-difficulty]'), null)
    const retry = slot.querySelector('[data-task-grading-refresh]')
    assert.ok(retry, label + ' unknown grading did not offer retry')
    assert.equal(retry.disabled, false)
    slot.type('Blocked task ' + label + '.')
    await slot.submit()
    assert.equal(bridge.calls.length, 0, label + ' task was sent without a confirmed grading read')
    assert.match(slot.output.textContent, /Task grading could not be read/)

    hand.setKind('r')
    slot.type('Rule allowed ' + label + '.')
    await slot.submit()
    await settle()
    assert.deepEqual(bridge.calls, [{ scope: 'global', words: 'Rule allowed ' + label + '.' }])
    hand()
  }
})

test('a pending grading read disables task submission and retry until reread succeeds', async () => {
  let reads = 0
  const settingsBridge = {
    async read() {
      reads += 1
      if (reads === 1) return { ok: true, available: true, rows: [], rejected: [] }
      return {
        ok: true,
        available: true,
        rows: [{ id: 'agent.task_difficulty_enabled', present: true, control: 'toggle', value: true }],
        rejected: [],
      }
    },
  }
  const bridge = recordingBridge(async () => ({ ok: true, id: 'T81' }))
  const slot = fakeSlot()
  mountLedgerFileBox(slot, { bridge, kind: 't', settingsBridge })

  assert.equal(slot.querySelector('[data-ledger-file]').disabled, true)
  assert.equal(slot.querySelector('[data-task-grading-refresh]').disabled, true)
  await settle()
  assert.equal(reads, 1)
  assert.equal(slot.querySelector('[data-task-grading-refresh]').disabled, false)

  const retry = slot.querySelector('[data-task-grading-refresh]')
  await retry.click()
  await settle()
  assert.equal(reads, 2)
  assert.equal(slot.querySelector('[data-task-difficulty]').required, true)
  assert.equal(slot.querySelector('[data-ledger-file]').disabled, false)

  slot.type('Retry task.')
  await slot.pickDifficulty('medium')
  await slot.submit()
  await settle()
  assert.deepEqual(bridge.calls, [{ scope: 'global', words: 'Retry task.', kind: 'T', difficulty: 'medium' }])
})

test('task words and grade survive scope changes, kind changes, refusal, then clear only on matching success', async () => {
  let attempts = 0
  const bridge = recordingBridge(async () => {
    attempts += 1
    if (attempts === 1) return { ok: false, code: 'AGENT_REQUEST_UNAVAILABLE' }
    return { ok: true, id: 'T90' }
  })
  const settingsBridge = gradingSettings({ value: true })
  const storage = fakeStorage({ 'mc.fleet.trees.v1:this-computer': JSON.stringify(RECORD) })
  const slot = fakeSlot()
  const hand = mountLedgerFileBox(slot, { bridge, storage, kind: 't', settingsBridge })
  await settle()

  slot.type('Task draft')
  await slot.pickDifficulty('hard')
  await slot.pick('tree')
  assert.equal(slot.querySelector('[data-file-words]').value, 'Task draft')
  assert.equal(slot.querySelector('[data-task-difficulty]').value, 'hard')

  hand.setKind('r')
  slot.type('Rule side draft')
  hand.setKind('t')
  await settle()
  assert.equal(slot.querySelector('[data-file-words]').value, 'Task draft')
  assert.equal(slot.querySelector('[data-task-difficulty]').value, 'hard')

  await slot.submit()
  await settle()
  assert.equal(bridge.calls.length, 1)
  assert.deepEqual(bridge.calls[0], {
    scope: 'tree',
    key: 'node-1-abc12345',
    words: 'Task draft',
    label: 'Coordinator',
    kind: 'T',
    difficulty: 'hard',
  })
  assert.equal(slot.querySelector('[data-file-words]').value, 'Task draft')
  assert.equal(slot.querySelector('[data-task-difficulty]').value, 'hard')
  assert.equal(slot.output.dataset.state, 'refused')

  await slot.submit()
  await settle()
  assert.equal(bridge.calls.length, 2)
  assert.equal(slot.output.dataset.state, 'confirmed')
  assert.equal(slot.querySelector('[data-file-words]').value, '')
  assert.equal(slot.querySelector('[data-task-difficulty]').value, '')

  hand.setKind('r')
  assert.equal(slot.querySelector('[data-file-words]').value, 'Rule side draft')
  hand()
})

test('a late task success cannot clear a newer words-and-grade draft', async () => {
  let answer
  const slot = fakeSlot()
  const bridge = recordingBridge(() => new Promise(resolve => { answer = resolve }))
  const settingsBridge = gradingSettings({ value: true })
  const hand = mountLedgerFileBox(slot, { bridge, kind: 't', settingsBridge })
  await settle()

  slot.type('First task')
  await slot.pickDifficulty('easy')
  const pending = slot.submit()
  await settle()
  assert.deepEqual(bridge.calls, [{ scope: 'global', words: 'First task', kind: 'T', difficulty: 'easy' }])

  slot.type('Later task')
  await slot.pickDifficulty('hard')
  answer({ ok: true, id: 'T91' })
  await pending
  await settle()

  assert.equal(slot.output.dataset.state, 'confirmed')
  assert.equal(slot.querySelector('[data-file-words]').value, 'Later task')
  assert.equal(slot.querySelector('[data-task-difficulty]').value, 'hard')
  hand()
})
