/* THE LEDGER PAGE OVER A LIVE DOCUMENT: what a reload keeps, and where the
 * person's hand lands afterwards.
 *
 * tools/test/ledger.test.mjs drives the view against bare stand-in nodes,
 * which is enough for what the register SAYS in each state. Three defects
 * only show over real rows -- an editor that is on screen with half a
 * sentence in it, a focused control, a Delete whose second press redraws the
 * row it sat on -- so this suite mounts the same view over the document
 * stand-in every component test uses, with the real row hand and the real
 * file box, and replaces only the feed, the data-source verdict and the
 * write surface under the register:
 *
 *   DELETED   file R1, delete it: the register offers Show removed and shows
 *             R1 as removed when pressed, never the nothing-on-file notice
 *   HELD      an editor open on R2 with typed words survives the reach
 *             filter, Show removed, and the host's data-source event; so does
 *             a reason typed under Decline
 *   FOCUS     after Save on R2 focus is inside R2's record; after Cancel it
 *             is on R2's Edit
 *   NAMED     the reach chip on a row that arrived with a key and no label
 *             says which circle, read out of this window's own saved trees --
 *             and says the reach word with the key's tail when nothing names it
 */

import assert from 'node:assert/strict'
import { register } from 'node:module'
import test from 'node:test'

import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { ANSWER_ROW, COMPLETE_ROW, DECIDE_ROW, DELETE_ROW, EMPTY_LIST, EXAMPLE_WRITE_NOTE, EXAMPLE_WRITE_NOTE_CHOSEN, FILE_BOX_OFF, FIND_BOX, HIDE_ROW, KIND_FILTER, LEDGER_DAMAGED, LEDGER_EMPTY, LEDGER_REFUSAL, REMOVED_TOGGLE, SCOPE_CHIP } from '../../src/ledger-copy.js'
import { fleetTreesStorageKey } from '../../src/fleet-trees.js'

register(`data:text/javascript,${encodeURIComponent(`
  const stub = (source) => ({ format: 'module', source, shortCircuit: true })
  export async function resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.css')) return { url: 'test:css', shortCircuit: true }
    const replacements = {
      '../components.js': 'components', '../ledger-live.js': 'ledger-live',
      '../data-source.js': 'data-source', '../refusal-copy.js': 'refusal-copy',
      '../sample-ledger.js': 'sample-ledger', '../write-surfaces.js': 'write-surfaces',
      '../first-run-needs.js': 'first-run-needs',
    }
    if (context.parentURL?.endsWith('/src/views/ledger.js') && replacements[specifier])
      return { url: 'test:' + replacements[specifier], shortCircuit: true }
    return nextResolve(specifier, context)
  }
  export async function load(url, context, nextLoad) {
    if (url === 'test:css') return stub('')
    if (url === 'test:components') return stub(\`export const el = html => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild }; export const attachSeg = () => () => {}\`)
    if (url === 'test:ledger-live') return stub(\`export const fetchLiveLedger = (options) => { globalThis.__ledgerAsked.push(options); return Promise.resolve(globalThis.__ledgerReply(options)) }\`)
    if (url === 'test:data-source') return stub(\`export const DATA_SOURCE_EVENT='source'; export const resolveDataSource=async()=>globalThis.__ledgerOrigin||'local'; export const sourceIsBadged=o=>o==='mock'; export const currentDataSource=()=>'local'; export const exampleWasChosen=()=>globalThis.__exampleChosen===true\`)
    if (url === 'test:refusal-copy') return stub(\`export const readerRemedy=s=>s\`)
    if (url === 'test:sample-ledger') return stub(\`export const sampleLedgerData=()=>({ requests: [], questions: { ok: true, reason: null, observedAt: null, value: [] }, chain: { ok: true, drift: [] } })\`)
    if (url === 'test:write-surfaces') return stub(\`export function mountLedgerWriteSurface(r,{onMount,onChanged}) { globalThis.__ledgerFormChanged = onChanged; const form = document.createElement('form'); form.setAttribute('data-decision-form', ''); r.appendChild(form); onMount({showRegister:view=>{ globalThis.__formRegister = view }}); return ()=>{} }\`)
    if (url === 'test:first-run-needs') return stub(\`export const GUIDE_ACTION={href:'#guide',label:'Guide'}\`)
    return nextLoad(url, context)
  }
`)}`, import.meta.url)

const dom = installDomStandIn()
/* The page's own storage: the R/Q choice, the reach, and the hide sets. */
const stored = new Map()
const storage = {
  get length() { return stored.size },
  key: index => [...stored.keys()][index] ?? null,
  getItem: key => (stored.has(key) ? stored.get(key) : null),
  setItem: (key, value) => { stored.set(key, String(value)) },
  removeItem: key => { stored.delete(key) },
}
globalThis.localStorage = storage
window.localStorage = storage

const { ledgerView, LEDGER_REFRESH_MS } = await import('../../src/views/ledger.js')

test.after(() => { dom.restore(); delete globalThis.localStorage })

const settle = async () => { for (let index = 0; index < 12; index += 1) await Promise.resolve() }

const row = (id, status, state, extra = {}) => ({
  id, kind: 'R', parentId: null, scope: 'global', scopeKey: null, scopeLabel: null, status, state,
  words: `Placeholder words for ${id}.`, filedBy: 'owner', filedAt: '2026-09-01T10:00:00.000Z',
  gateCount: 0, unmetGateCount: 0, decisions: 0, history: [], removedAt: null, removed: false,
  recurrence: null, completedAt: null, completedBy: null, answer: null, purchase: null, ...extra,
})
const QUESTIONS_OK = { ok: true, reason: null, observedAt: null, value: [] }
const CHAIN_OK = { ok: true, events: 1, drift: [], unchained: [], code: null }
const reply = (requests, { exists = true } = {}) => ({ ok: true, data: { requests, questions: QUESTIONS_OK, revision: 1, updatedAt: '2026-09-01', exists, chain: CHAIN_OK } })

/* A ledger the feed answers from: the rows on file, removed ones included,
   narrowed the way the installed application narrows them. */
function ledgerOf(rows) {
  return options => reply(
    rows.filter(item => (options.scope === 'all' || item.scope === options.scope) && (options.removed || item.state !== 'removed')),
    { exists: rows.length > 0 },
  )
}

/* A PRESS THE WAY THE DOM DELIVERS IT. The page's handlers find their button
   with compound selectors ('button[data-hide]', 'button[data-row-action="resolve"]')
   that the document stand-in cannot match, so the click is dispatched from the
   button itself with a target whose closest() drops the leading tag name and
   answers from the real element chain. */
function press(button) {
  assert.ok(button, 'there is no such control to press')
  const target = { closest: selector => button.closest(String(selector).replace(/^button(?=\[)/, '')) }
  button.dispatchEvent({ type: 'click', target })
}

/* Never hand an element to assert.equal: a failing comparison would print the
   whole document graph. */
const shown = node => Boolean(node)

function mountView({ rows = [], bridge = null, savedTrees = null, mode = null, hiddenKeys = null } = {}) {
  /* Each mount starts from a copy that remembers nothing, whatever an
     earlier test left in storage. */
  stored.clear()
  /* A hide list already on this computer, in the shape src/hidden-rows.js writes. */
  if (hiddenKeys) stored.set('mc.ledger.hidden:live', JSON.stringify({ v: 1, ids: hiddenKeys }))
  /* The tab the page opens on, remembered where the kind picker keeps it. */
  if (mode) stored.set('mc.ledger.mode', mode)
  /* A fleet-tree record planted where the Computers page writes one, so the
     page's own reader finds it exactly as it would on the person's machine.
     Absent by default: most of this suite is about rows, not circles. */
  if (savedTrees) stored.set(fleetTreesStorageKey(savedTrees.computerId), JSON.stringify(savedTrees))
  globalThis.__ledgerAsked = []
  globalThis.__ledgerReply = ledgerOf(rows)
  window.mcAgent = bridge
  const view = ledgerView()
  document.body.appendChild(view.el)
  const root = view.el
  return {
    view,
    root,
    register: root.querySelector('.ledger-register'),
    removedToggle: root.querySelector('[data-show-removed]'),
    record: id => root.querySelector(`[data-row-id="${id}"]`),
    /* The reach filter's listener finds its button with closest('button[data-scope]'),
       a compound selector the document stand-in cannot match, so the press
       is delivered the way the DOM would: on the group, with a target that
       answers closest() with the button. */
    narrowTo(scope) {
      const group = root.querySelector('[data-scope-filter]')
      const button = group.querySelectorAll('[data-scope]').find(candidate => candidate.dataset.scope === scope)
      group.dispatchEvent({ type: 'click', target: { closest: selector => (selector.includes('[data-scope]') ? button : null) } })
    },
    control: (id, action) => root.querySelector(`[data-row-id="${id}"]`)?.querySelectorAll('[data-row-action]').find(button => button.dataset.rowAction === action) || null,
    /* A kind tab pressed the way the DOM delivers it: on the group. */
    pick(mode) {
      const group = root.querySelector('.ledger-mode')
      const button = group.querySelectorAll('[data-mode]').find(item => item.dataset.mode === mode)
      assert.ok(button, `no ${mode} tab`)
      group.dispatchEvent({ type: 'click', target: { closest: () => button } })
    },
    press,
    /* The × on a row, pressed twice: the first press arms, the second hides. */
    hide(id) {
      const button = root.querySelector(`[data-row-id="${id}"]`)?.querySelector('[data-hide]')
      assert.ok(button, `${id} has no hide control`)
      press(button)
      press(button)
    },
    unhide: id => press(root.querySelector(`[data-row-id="${id}"]`)?.querySelector('[data-unhide]')),
    /* Resolve opened the way the DOM delivers the press. A browser gives each
       radio its default checkedness from the markup; the stand-in has no such
       property, so it is copied from the attribute here. */
    openResolve(id) {
      press(root.querySelector(`[data-row-id="${id}"]`)?.querySelectorAll('[data-row-action]').find(button => button.dataset.rowAction === 'resolve'))
      for (const input of root.querySelector(`[data-row-id="${id}"]`)?.querySelectorAll('[data-resolve-status]') || []) input.checked = input.hasAttribute('checked')
    },
    choose(id, status) {
      for (const input of root.querySelector(`[data-row-id="${id}"]`).querySelectorAll('[data-resolve-status]')) input.checked = input.value === status
    },
    checkedIn: id => (root.querySelector(`[data-row-id="${id}"]`)?.querySelectorAll('[data-resolve-status]') || []).filter(input => input.hasAttribute('checked')).map(input => input.value),
    hint: id => root.querySelector(`[data-row-id="${id}"]`)?.querySelector('[data-row-hint]')?.textContent || '',
    undo: () => press(root.querySelector('[data-undo-hide]')),
    feed: rows => { globalThis.__ledgerReply = ledgerOf(rows) },
    done() { view.destroy(); root.remove(); stored.clear() },
  }
}

function recordingBridge(ledgerRows) {
  const calls = []
  return {
    calls,
    request: async request => { calls.push({ verb: 'file', request }); return { ok: true, id: 'R1', scope: request.scope, key: null, status: 'open' } },
    requestEdit: async request => { calls.push({ verb: 'edit', request }); return { ok: true } },
    requestRemove: async request => { calls.push({ verb: 'remove', request }); return { ok: true } },
    requestDecide: async request => { calls.push({ verb: 'decide', request }); return { ok: true } },
    rows: ledgerRows,
  }
}

test('every request deleted: the register offers Show removed, and shows the deleted row when pressed', async () => {
  const bridge = recordingBridge()
  const page = mountView({ rows: [], bridge })
  await settle()
  assert.equal(page.root.dataset.projectionState, 'empty', 'a ledger never written is the nothing-on-file notice')
  assert.ok(page.register.textContent.includes(LEDGER_EMPTY.body))
  assert.equal(page.removedToggle.hidden, true, 'a ledger never written has nothing removed to show')

  /* File R1 from the box at the foot of the page. */
  const form = page.root.querySelector('[data-ledger-file-form]')
  assert.ok(form, 'the file box is not on the page')
  form.querySelector('[data-file-words]').value = 'Keep the tests green.'
  page.feed([row('R1', 'open', 'open', { words: 'Keep the tests green.' })])
  form.dispatchEvent({ type: 'submit', preventDefault() {} })
  await settle()
  assert.equal(bridge.calls.at(-1).verb, 'file')
  assert.ok(page.record('R1'), 'R1 is not drawn after filing')
  assert.equal(page.root.dataset.projectionState, 'ready')

  /* Delete it: two presses, then the ledger answers with no live row but
     the file still there, and R1 in it as removed. */
  const remove = page.control('R1', 'delete')
  assert.ok(remove, 'R1 has no Delete')
  remove.click()
  await settle()
  assert.equal(remove.dataset.armed, 'true', 'the first press did not arm')
  page.feed([row('R1', 'removed', 'removed', { words: 'Keep the tests green.', removedAt: '2026-09-01T11:00:00.000Z', removed: true })])
  remove.click()
  await settle()
  assert.equal(bridge.calls.at(-1).verb, 'remove')
  assert.deepEqual(globalThis.__ledgerAsked.at(-1), { scope: 'all', removed: false })
  assert.equal(page.root.dataset.projectionState, 'ready', 'a ledger whose every request was deleted is not a ledger never written')
  assert.ok(page.register.textContent.includes(EMPTY_LIST.r), 'the list sentence is not shown')
  assert.ok(!page.register.textContent.includes(LEDGER_EMPTY.body), 'the nothing-on-file notice denies the deleted row exists')
  assert.equal(page.removedToggle.hidden, false, 'Show removed is not offered, so the deleted row is unreachable')
  assert.equal(page.removedToggle.textContent, REMOVED_TOGGLE.show)

  page.removedToggle.click()
  await settle()
  assert.deepEqual(globalThis.__ledgerAsked.at(-1), { scope: 'all', removed: true })
  const removed = page.record('R1')
  assert.ok(removed, 'R1 is not drawn with Show removed on')
  assert.equal(removed.querySelector('.ledger-line').dataset.state, 'removed', 'R1 is not drawn as removed')
  assert.equal(removed.querySelectorAll('[data-row-action]').length, 0, 'a removed row offers controls')
  assert.equal(page.removedToggle.textContent, REMOVED_TOGGLE.hide)
  assert.ok(page.root.querySelector('[data-visible-count]').textContent.endsWith(REMOVED_TOGGLE.count(1)))
  page.done()
})

test('an open editor and a typed reason survive every kind of reload with their words', async () => {
  const bridge = recordingBridge()
  const rows = [row('R1', 'open', 'open'), row('R2', 'open', 'open', { scope: 'tree', scopeKey: 'node-1' }), row('R3', 'proposed', 'proposed', { filedBy: 'codex' })]
  const page = mountView({ rows, bridge })
  await settle()

  page.control('R2', 'edit').click()
  await settle()
  const editor = () => page.record('R2')?.querySelector('[data-row-editor-words]')
  assert.ok(editor(), 'Edit did not open the box on R2')
  editor().value = 'Half a sentence, not yet'

  /* The reach filter re-reads the ledger. */
  page.narrowTo('tree')
  await settle()
  assert.deepEqual(globalThis.__ledgerAsked.at(-1), { scope: 'tree', removed: false })
  assert.ok(editor(), 'the reach filter closed the editor')
  assert.equal(editor().value, 'Half a sentence, not yet', 'the reach filter threw the typed words away')
  assert.equal(page.control('R2', 'save')?.dataset.key, 'node-1', 'the reopened editor lost the row\'s key')
  page.narrowTo('all')
  await settle()
  assert.equal(editor().value, 'Half a sentence, not yet')

  /* Show removed re-reads too. */
  page.removedToggle.click()
  await settle()
  assert.equal(editor()?.value, 'Half a sentence, not yet', 'Show removed threw the typed words away')

  /* A reason typed under Decline on another row, then the host says the
     world changed: both boxes come back. */
  const decline = page.control('R3', 'decline')
  decline.click()
  await settle()
  const reason = () => page.record('R3')?.querySelector('[data-row-reason]')
  assert.ok(reason(), 'Decline did not open the reason box')
  reason().value = 'Not what I meant.'
  window.dispatchEvent({ type: 'source' })
  await settle()
  assert.equal(editor()?.value, 'Half a sentence, not yet', 'the data-source event threw the typed words away')
  assert.equal(reason()?.value, 'Not what I meant.', 'the data-source event threw the typed reason away')

  /* Another row's write reloads the register; R2's box is still open, and
     its Save then sends the held words. */
  page.control('R1', 'edit').click()
  await settle()
  page.record('R1').querySelector('[data-row-editor-words]').value = 'R1, reworded.'
  page.control('R1', 'save').click()
  await settle()
  assert.deepEqual(bridge.calls.at(-1), { verb: 'edit', request: { id: 'R1', words: 'R1, reworded.' } })
  assert.equal(page.record('R1').querySelector('[data-row-editor-words]'), null, 'the saved row kept its editor open')
  assert.equal(editor()?.value, 'Half a sentence, not yet', 'another row\'s write threw the typed words away')
  page.control('R2', 'save').click()
  await settle()
  assert.deepEqual(bridge.calls.at(-1), { verb: 'edit', request: { id: 'R2', key: 'node-1', words: 'Half a sentence, not yet' } }, 'Save did not send the words that survived the reloads')
  page.done()
})

test('after Save on R2 focus is inside R2\'s record, and after Cancel it is on R2\'s Edit', async () => {
  const bridge = recordingBridge()
  const page = mountView({ rows: [row('R1', 'open', 'open'), row('R2', 'open', 'open')], bridge })
  await settle()

  page.control('R2', 'edit').click()
  await settle()
  const record = page.record('R2')
  assert.equal(document.activeElement, record.querySelector('[data-row-editor-words]'), 'Edit did not focus the box')
  record.querySelector('[data-row-editor-words]').value = 'R2, reworded.'
  page.control('R2', 'save').click()
  await settle()
  assert.equal(bridge.calls.at(-1).verb, 'edit')
  const redrawn = page.record('R2')
  assert.notEqual(redrawn, record, 'the register was not redrawn, so the case is not the one under test')
  assert.ok(document.activeElement, 'focus is on nothing after the write')
  assert.ok(redrawn.contains(document.activeElement), 'focus is not inside R2\'s record after Save')
  assert.equal(document.activeElement, redrawn.querySelector('.ledger-ctl'), 'focus is not on R2\'s first control')

  page.control('R2', 'edit').click()
  await settle()
  page.control('R2', 'cancel').click()
  await settle()
  assert.equal(document.activeElement, page.control('R2', 'edit'), 'Cancel did not hand focus back to Edit')

  /* Delete: the row is gone from the list, so focus goes to the register. */
  const remove = page.control('R2', 'delete')
  remove.click()
  await settle()
  page.feed([row('R1', 'open', 'open')])
  remove.click()
  await settle()
  assert.equal(page.record('R2'), null)
  /* The row is gone; focus lands on the sentence that says so (T1524),
     never on the page top. */
  const note = page.root.querySelector('[data-hidden-note]')
  assert.equal(note.textContent, DELETE_ROW.deleted(['R2']))
  assert.equal(document.activeElement === note, true, 'focus fell off the page after the deleted row went')
  page.done()
})

/* ---------- who a rule is for, when all the row carries is a key ---------- */

/* A saved fleet-tree record in the shape src/fleet-trees.js writes, with ids
   in the shape it really mints (kind, counter, uuid): one tree, a coordinator
   with a session on record, and two managers under it. */
const STAMP = '2026-09-03T09:00:00.000Z'
const SAVED_TREES = Object.freeze({
  version: 1,
  computerId: 'this-computer',
  trees: [{ id: 'tree-1-9f0a1b2c-3d4e-4f50-8617-28394a5b6c7d', name: null, createdAt: STAMP, updatedAt: STAMP }],
  nodes: [
    { id: 'node-1-1a2b3c4d-5e6f-4708-8912-a3b4c5d6e7f8', treeId: 'tree-1-9f0a1b2c-3d4e-4f50-8617-28394a5b6c7d', parentId: null, role: 'coordinator', message: 'Plan the week', status: 'running', sessionId: 'chat-11111111', createdAt: STAMP, updatedAt: STAMP },
    { id: 'node-2-6c518599-05aa-4c77-a154-cefe49b278ed', treeId: 'tree-1-9f0a1b2c-3d4e-4f50-8617-28394a5b6c7d', parentId: 'node-1-1a2b3c4d-5e6f-4708-8912-a3b4c5d6e7f8', role: 'manager', message: '', status: 'draft', sessionId: null, createdAt: STAMP, updatedAt: STAMP },
    { id: 'node-3-aaa11111-2222-4333-8444-555566667777', treeId: 'tree-1-9f0a1b2c-3d4e-4f50-8617-28394a5b6c7d', parentId: 'node-1-1a2b3c4d-5e6f-4708-8912-a3b4c5d6e7f8', role: 'manager', message: '', status: 'draft', sessionId: null, createdAt: STAMP, updatedAt: STAMP },
  ],
})
const GONE = 'node-9-deadbeef-1111-4222-8333-4444cafe5678'

test('a rule filed with a key and no label names the circle it reaches', async () => {
  /* Every rule an agent files arrives this way: the label the /Request family
     and the file box send is optional on the way in, so the row carries the
     key alone. Before this, the chip read the reach word and eight characters
     of the id. */
  const rows = [
    row('R1', 'open', 'open', { scope: 'thread', scopeKey: SAVED_TREES.nodes[0].id, filedBy: 'codex' }),
    row('R2', 'open', 'open', { scope: 'session', scopeKey: 'chat-11111111', filedBy: 'codex' }),
    row('R3', 'open', 'open', { scope: 'tree', scopeKey: SAVED_TREES.nodes[2].id, filedBy: 'codex' }),
    row('R4', 'open', 'open', { scope: 'thread', scopeKey: SAVED_TREES.nodes[1].id, scopeLabel: 'The words I typed' }),
    row('R5', 'open', 'open'),
  ]
  const page = mountView({ rows, bridge: recordingBridge(), savedTrees: SAVED_TREES })
  await settle()
  const chip = id => page.record(id).querySelector('.ledger-scope').textContent

  /* Every named chip keeps its reach (T1510): a circle rule and a tree rule
     for the same agent are different choices and must not read the same. */
  assert.equal(chip('R1'), `Coordinator · ${SCOPE_CHIP.thread}`, 'a circle rule must name its circle and say it is the circle')
  assert.equal(chip('R2'), `Coordinator · ${SCOPE_CHIP.session}`,
    'a session rule must name the circle running it, and say that it is the session')
  assert.equal(chip('R3'), `Manager 2 · ${SCOPE_CHIP.tree}`, 'siblings sharing a role must still be told apart')
  assert.equal(chip('R4'), `The words I typed · ${SCOPE_CHIP.thread}`, 'the name the person saw when filing still wins')
  assert.equal(chip('R5'), SCOPE_CHIP.global, 'a rule with no key has nobody to name')

  for (const id of ['R1', 'R2', 'R3', 'R4']) {
    assert.ok(!chip(id).includes('node-') && !chip(id).includes('chat-'),
      `${id} still shows a raw id: ${chip(id)}`)
  }
  page.done()
})

test('a key nothing on this computer names keeps the reach word and the key\'s tail', async () => {
  /* THE FALLBACK, AND IT IS NOT A FAILURE. A rule outlives the circle it was
     filed for, and a browser reading this register over the relay has no
     fleet-tree record to look in at all. "I could not place this key" and
     "this rule is for the whole tree" are different answers, so the chip keeps
     saying the reach and enough of the key to match it against the file. */
  const rows = [
    row('R1', 'open', 'open', { scope: 'thread', scopeKey: GONE, filedBy: 'codex' }),
    row('R2', 'open', 'open', { scope: 'session', scopeKey: 'chat-nosuchsession', filedBy: 'codex' }),
  ]
  const withTrees = mountView({ rows, bridge: recordingBridge(), savedTrees: SAVED_TREES })
  await settle()
  const chipOf = page => id => page.record(id).querySelector('.ledger-scope').textContent
  assert.equal(chipOf(withTrees)('R1'), `${SCOPE_CHIP.thread} · …${GONE.slice(-8)}`,
    'a circle that is not on file must not be silently named as something else')
  assert.equal(chipOf(withTrees)('R2'), `${SCOPE_CHIP.session} · …hsession`,
    'a session nothing on file is running must not borrow a circle\'s name')
  withTrees.done()

  /* And with nothing saved to look in at all, the same answer. */
  const noTrees = mountView({ rows, bridge: recordingBridge() })
  await settle()
  assert.equal(chipOf(noTrees)('R1'), `${SCOPE_CHIP.thread} · …${GONE.slice(-8)}`,
    'a copy with no saved trees must still say what it does know')
  noTrees.done()
})

test('Ledger tabs mount only their own filing form and preserve drafts across list reloads and unrelated pages', async () => {
  const bridge = recordingBridge()
  const page = mountView({ rows: [row('R1', 'open', 'open')], bridge })
  await settle()
  const pick = mode => {
    const group = page.root.querySelector('.ledger-mode')
    const button = group.querySelectorAll('[data-mode]').find(item => item.dataset.mode === mode)
    assert.ok(button)
    group.dispatchEvent({ type: 'click', target: { closest: () => button } })
  }
  try {
    pick('r')
    const words = () => page.root.querySelector('[data-file-words]')
    assert.equal(page.root.querySelector('[data-ledger-file-form]').dataset.fileKind, 'r')
    words().value = 'Unsent rule.'
    pick('t')
    assert.equal(page.root.querySelector('[data-ledger-file-form]').dataset.fileKind, 't')
    words().value = 'Unsent task.'
    for (const mode of ['all', 'a', 'p']) {
      pick(mode)
      assert.equal(page.root.querySelector('[data-ledger-file-form]'), null, mode + ' must have no filing control')
    }
    pick('r')
    assert.equal(words().value, 'Unsent rule.')
    window.dispatchEvent({ type: 'source' })
    await settle()
    assert.equal(words().value, 'Unsent rule.')
    pick('t')
    assert.equal(words().value, 'Unsent task.')
    assert.equal(bridge.calls.length, 0)
  } finally { page.done() }
})

test('Ledger page offers explicit history review without adopting on load', async () => {
  const calls = []
  const page = mountView({ rows: [row('R1', 'open', 'open')], bridge: {
    ledgerCustodyPreview: async value => { calls.push(['preview', value]); return { ok: true, count: 0, revision: 1, token: 'a'.repeat(64) } },
    ledgerCustodyConfirm: async () => { assert.fail('page opening or review must never adopt automatically') },
  } })
  try {
    await settle()
    assert.deepEqual(calls, [])
    const review = page.root.querySelector('[data-ledger-custody-review]')
    assert.ok(review, 'the Ledger page must offer the person a reachable history adoption review')
    assert.equal(review.disabled, false)
    assert.equal(page.root.querySelector('[data-ledger-custody]').hidden, false)
    review.click(); await settle()
    assert.deepEqual(calls, [['preview', {}]])
    assert.match(page.root.querySelector('[data-ledger-custody-status]').textContent, /No Ledger records need history adoption/)
  } finally { page.done() }
})

/* ---------- a redraw that is not a reload keeps what the person is typing ---------- */

test('hiding a row, putting it back or opening Resolve keeps a half-typed answer, edit or reason on another row', async () => {
  const resolved = []
  const bridge = {
    ...recordingBridge(),
    resolveStandingRequest: async request => { resolved.push(request); return { ok: true } },
    answerAsk: async () => ({ ok: true }),
    declineAsk: async () => ({ ok: true }),
    removeAsk: async () => ({ ok: true }),
  }
  const rows = [
    row('R1', 'open', 'open'), row('R2', 'open', 'open'), row('R3', 'open', 'open'),
    row('A1', 'open', 'open', { kind: 'A' }), row('A2', 'open', 'open', { kind: 'A' }),
  ]
  const page = mountView({ rows, bridge, mode: 'a' })
  try {
    await settle()
    page.control('A1', 'answer').click()
    await settle()
    const answer = () => page.record('A1')?.querySelector('[data-row-editor-words]')
    assert.ok(shown(answer()), 'Answer did not open the box on A1')
    answer().value = 'Half of my answer, still typing'

    /* The × twice on another ask. */
    page.hide('A2')
    await settle()
    assert.equal(shown(page.record('A2')), false, 'A2 was not hidden, so the case is not the one under test')
    assert.equal(answer()?.value, 'Half of my answer, still typing', 'hiding another row threw the typed answer away')

    /* Show hidden, the put-back arrow and Undo all redraw the list too. */
    page.root.querySelector('[data-show-hidden]').click()
    await settle()
    assert.equal(answer()?.value, 'Half of my answer, still typing', 'Show hidden threw the typed answer away')
    page.unhide('A2')
    await settle()
    assert.equal(answer()?.value, 'Half of my answer, still typing', 'putting a row back threw the typed answer away')
    page.root.querySelector('[data-show-hidden]').click()
    await settle()
    page.hide('A2')
    await settle()
    page.undo()
    await settle()
    assert.equal(shown(page.record('A2')), true, 'Undo did not put A2 back')
    assert.equal(answer()?.value, 'Half of my answer, still typing', 'Undo threw the typed answer away')

    /* A tab change takes A1 off the screen; coming back brings the box back. */
    page.pick('r')
    await settle()
    page.pick('a')
    await settle()
    assert.equal(answer()?.value, 'Half of my answer, still typing', 'looking at another tab threw the typed answer away')

    /* R: an edit half-typed on R1, then Resolve opened on R2, a reason typed
       there, then R3 hidden and the picker cancelled. */
    page.pick('r')
    await settle()
    page.control('R1', 'edit').click()
    await settle()
    const editor = () => page.record('R1')?.querySelector('[data-row-editor-words]')
    editor().value = 'R1, half reworded'
    page.press(page.control('R2', 'resolve'))
    await settle()
    const reason = () => page.record('R2')?.querySelector('[data-resolve-reason]')
    assert.ok(shown(reason()), 'Resolve did not open its picker on R2')
    assert.equal(editor()?.value, 'R1, half reworded', 'opening Resolve on another rule threw the typed edit away')
    reason().value = 'Shipped and checked.'
    page.hide('R3')
    await settle()
    assert.equal(shown(page.record('R3')), false, 'R3 was not hidden')
    assert.equal(editor()?.value, 'R1, half reworded', 'hiding a rule threw the typed edit away')
    assert.equal(reason()?.value, 'Shipped and checked.', 'hiding a rule threw the reason typed in the Resolve picker away')
    page.record('R2').querySelector('[data-resolve-cancel]').click()
    await settle()
    assert.equal(shown(reason()), false, 'Cancel did not close the picker')
    assert.equal(editor()?.value, 'R1, half reworded', 'cancelling Resolve threw the typed edit away')
    assert.deepEqual(resolved, [], 'nothing here may resolve a rule')
  } finally { page.done() }
})

/* ---------- Resolve starts where the rule is, and asks before it is final ---------- */

function resolvingBridge() {
  const resolved = []
  return { resolved, bridge: { ...recordingBridge(), resolveStandingRequest: async request => { resolved.push(request); return { ok: true } } } }
}

test('Resolve opens on the rule\'s own status, and Save with nothing changed changes nothing', async () => {
  const { resolved, bridge } = resolvingBridge()
  const rows = [row('R1', 'open', 'open'), row('R3', 'partial', 'partial'), row('R4', 'blocked-external', 'blocked-external')]
  const page = mountView({ rows, bridge })
  try {
    await settle()
    page.openResolve('R3')
    await settle()
    assert.deepEqual(page.checkedIn('R3'), ['partial'], 'a Partly done rule must open its picker on Partly done, not In progress')
    page.record('R3').querySelector('[data-resolve-submit]').click()
    await settle()
    assert.deepEqual(resolved, [], 'Save with the same status and no reason moved the rule')
    assert.match(page.hint('R3'), /^R3 is already Partly done, so nothing was changed\./)

    /* With a reason typed, the same status is saved: that is the person adding a note. */
    page.record('R3').querySelector('[data-resolve-reason]').value = 'Half the files are moved.'
    page.record('R3').querySelector('[data-resolve-submit]').click()
    await settle()
    assert.deepEqual(resolved, [{ id: 'R3', status: 'partial', reason: 'Half the files are moved.' }])

    page.openResolve('R4')
    await settle()
    assert.deepEqual(page.checkedIn('R4'), ['blocked-external'], 'a Blocked rule must open its picker on Blocked')
    page.openResolve('R1')
    await settle()
    assert.deepEqual(page.checkedIn('R1'), ['in-progress'], 'an open rule starts on the first step forward')
  } finally { page.done() }
})

test('Done, Not possible as asked and Superseded take a second press and say they are final', async () => {
  const { resolved, bridge } = resolvingBridge()
  const page = mountView({ rows: [row('R1', 'open', 'open'), row('R2', 'in-progress', 'in-progress')], bridge })
  try {
    await settle()
    page.openResolve('R1')
    await settle()
    assert.match(page.record('R1').querySelector('[data-resolve-slot]').textContent, /Done, Not possible as asked and Superseded are final\./,
      'the picker must say before Save which choices cannot be undone')
    for (const [status, label] of [['done', 'Done'], ['not-possible-as-asked', 'Not possible as asked'], ['superseded', 'Superseded']]) {
      page.choose('R1', status)
      page.record('R1').querySelector('[data-resolve-submit]').click()
      await settle()
      assert.deepEqual(resolved, [], `one press on ${label} resolved the rule`)
      assert.equal(page.hint('R1'), `Resolve R1 as ${label}? Press Save again. This is final: the Ledger has no way to reopen it.`)
      page.record('R1').querySelector('[data-resolve-submit]').click()
      await settle()
      assert.deepEqual(resolved, [{ id: 'R1', status }], `the second press did not resolve R1 as ${label}`)
      resolved.length = 0
      page.openResolve('R1')
      await settle()
    }
    /* Armed on Done, then switched to a standing status: one press sends it. */
    page.choose('R1', 'done')
    page.record('R1').querySelector('[data-resolve-submit]').click()
    await settle()
    page.choose('R1', 'blocked-external')
    page.record('R1').querySelector('[data-resolve-submit]').click()
    await settle()
    assert.deepEqual(resolved, [{ id: 'R1', status: 'blocked-external' }])
    resolved.length = 0
    page.openResolve('R2')
    await settle()
    page.choose('R2', 'partial')
    page.record('R2').querySelector('[data-resolve-submit]').click()
    await settle()
    assert.deepEqual(resolved, [{ id: 'R2', status: 'partial' }], 'a standing status still takes one press')
  } finally { page.done() }
})

/* ---------- a Delete or a Decline says what it took away ---------- */

test('Delete names a rule\'s refinements, and after Delete or Decline a note says where the rows went and takes focus', async () => {
  const removedIds = []
  const bridge = {
    ...recordingBridge(),
    requestRemove: async request => { removedIds.push(request.id); return { ok: true, removed: ['R202', 'R202.1', 'R202.2'] } },
    declineAsk: async () => ({ ok: true }),
  }
  const live = [
    row('R202', 'open', 'open'),
    row('R202.1', 'open', 'open', { parentId: 'R202', filedBy: 'codex' }),
    row('R202.2', 'open', 'open', { parentId: 'R202', filedBy: 'claude' }),
    row('A5', 'open', 'open', { kind: 'A' }),
  ]
  const page = mountView({ rows: live, bridge })
  try {
    await settle()
    const remove = page.control('R202', 'delete')
    remove.click()
    await settle()
    assert.match(page.hint('R202'), /^Delete R202 and its 2 refinements, R202\.1 and R202\.2\? Press Delete again\./,
      'the armed sentence does not say the refinements go too')
    const gone = id => ({ ...live.find(item => item.id === id), status: 'removed', state: 'removed', removed: true, removedAt: '2026-09-01T11:00:00.000Z' })
    page.feed([gone('R202'), gone('R202.1'), gone('R202.2'), live[3]])
    remove.click()
    await settle()
    assert.deepEqual(removedIds, ['R202'])
    const note = page.root.querySelector('[data-hidden-note]')
    assert.equal(note.hidden, false, 'nothing says what the Delete did')
    assert.equal(note.textContent, 'R202, R202.1 and R202.2 deleted. They are kept in your records as deleted; Show removed lists them.')
    assert.equal(document.activeElement === note, true, 'focus did not land on the sentence')

    page.pick('a')
    await settle()
    const decline = page.control('A5', 'decline')
    decline.click()
    await settle()
    page.feed([gone('R202'), gone('R202.1'), gone('R202.2'), { ...live[3], status: 'declined', state: 'removed', removed: true }])
    decline.click()
    await settle()
    assert.equal(shown(page.record('A5')), false)
    assert.equal(note.textContent, DECIDE_ROW.declined('A5'))
    assert.equal(document.activeElement === note, true, 'focus did not land on the decline sentence')
  } finally { page.done() }
})

/* ---------- the open page follows the Ledger ---------- */

/* The page's own quiet re-read timer, caught so the test decides when it
   fires; every other timer (the two-press arm, for one) runs as it would. */
function catchRefreshTimer() {
  const real = globalThis.setTimeout
  const fired = []
  globalThis.setTimeout = (callback, ms, ...rest) => {
    if (ms === LEDGER_REFRESH_MS) { fired.push(callback); return { unref() {} } }
    return real(callback, ms, ...rest)
  }
  return { fired, next: async () => { const callback = fired.shift(); assert.ok(callback, 'the open page scheduled no re-read'); await callback() }, restore() { globalThis.setTimeout = real } }
}

test('an open Ledger shows what agents file while it is open, and never redraws under a person typing', async () => {
  const timer = catchRefreshTimer()
  const rows = [row('R1', 'open', 'open'), row('R2', 'open', 'open')]
  const page = mountView({ rows, bridge: recordingBridge() })
  try {
    await settle()
    assert.equal(timer.fired.length, 1, 'the open page never re-reads the Ledger')
    /* An agent proposes R3 while the page is open. */
    const withR3 = [...rows, row('R3', 'proposed', 'proposed', { filedBy: 'codex' })]
    page.feed(withR3)
    const asked = globalThis.__ledgerAsked.length
    await timer.next()
    await settle()
    assert.equal(globalThis.__ledgerAsked.length, asked + 1)
    assert.deepEqual(globalThis.__ledgerAsked.at(-1), { scope: 'all', removed: false }, 'the quiet read must use the page\'s own filters')
    assert.equal(shown(page.record('R3')), true, 'a rule an agent filed did not appear while the page was open')
    const note = page.root.querySelector('[data-ledger-update]')
    assert.equal(note.hidden, true)

    /* The person is typing an edit on R1 when R4 arrives: nothing is redrawn
       under them; the change waits behind a button. */
    page.control('R1', 'edit').click()
    await settle()
    const editor = () => page.record('R1')?.querySelector('[data-row-editor-words]')
    editor().value = 'Typing now'
    assert.equal(document.activeElement === editor(), true, 'Edit did not focus its box')
    page.feed([...withR3, row('R4', 'open', 'open')])
    await timer.next()
    await settle()
    assert.equal(shown(page.record('R4')), false, 'the list was redrawn under a person typing')
    assert.equal(note.hidden, false, 'nothing says the Ledger changed')
    assert.equal(editor()?.value, 'Typing now')
    press(note.querySelector('[data-show-updates]'))
    await settle()
    assert.equal(shown(page.record('R4')), true, 'Show the changes did not show R4')
    assert.equal(editor()?.value, 'Typing now', 'showing the changes threw the typed edit away')
    assert.equal(note.hidden, true)

    /* A quiet read that fails keeps the last rows and says so. */
    document.activeElement = null
    globalThis.__ledgerReply = () => ({ ok: false, reason: 'the file is busy', code: 'AGENT_LEDGER_UNREADABLE', questions: QUESTIONS_OK })
    await timer.next()
    await settle()
    assert.equal(shown(page.record('R4')), true, 'a failed quiet read took the rows away')
    assert.match(note.textContent, /could not be read/)
  } finally { timer.restore(); page.done() }
})

test('a decision the Approve or Decline form records re-reads the list, so the row stops offering it', async () => {
  const page = mountView({ rows: [row('R15', 'proposed', 'proposed', { filedBy: 'codex' })], bridge: recordingBridge() })
  try {
    await settle()
    assert.equal(shown(page.control('R15', 'approve')), true)
    assert.equal(typeof globalThis.__ledgerFormChanged, 'function', 'the page gives the decision form no way to say it recorded something')
    page.feed([row('R15', 'open', 'open', { filedBy: 'codex' })])
    globalThis.__ledgerFormChanged({ id: 'R15', decision: 'approve' })
    await settle()
    assert.equal(page.record('R15').querySelector('.ledger-line').dataset.state, 'open', 'R15 still reads proposed after the form approved it')
    assert.equal(shown(page.control('R15', 'approve')), false, 'R15 still offers Approve')
    assert.equal(shown(page.control('R15', 'decline')), false, 'R15 still offers Decline, which would undo the approval')
  } finally { page.done() }
})

/* ---------- controls only where the store acts, and a refusal that re-reads ---------- */

test('Complete is offered only where the store completes, and a blocked task says why it is off', async () => {
  const bridge = { ...recordingBridge(), completeTask: async () => ({ ok: true }), removeTask: async () => ({ ok: true }) }
  const task = (id, status) => row(id, status, status, { kind: 'T' })
  const page = mountView({ rows: [task('T1', 'open'), task('T2', 'in-progress'), task('T3', 'blocked-external'), task('T4', 'recurring')], bridge, mode: 't' })
  try {
    await settle()
    for (const id of ['T1', 'T2', 'T4']) assert.equal(shown(page.control(id, 'complete')), true, `${id} lost its Complete`)
    assert.equal(shown(page.control('T3', 'complete')), false, 'a task blocked on the owner offers a Complete the store always refuses')
    assert.equal(page.record('T3').querySelector('[data-complete-off]')?.textContent, COMPLETE_ROW.blocked('T3'))
    assert.equal(shown(page.control('T3', 'delete')), true, 'Delete stays on a blocked task')
  } finally { page.done() }
})

test('an ask answered first by its agent re-reads the list and keeps the owner\'s typed answer', async () => {
  const live = [row('A68', 'open', 'open', { kind: 'A', filedBy: 'claude', words: 'May I empty the trash folder?' })]
  const bridge = {
    ...recordingBridge(),
    answerAsk: async () => { throw new Error("Error invoking remote method 'mc-agent:ask-answer': Error: R_LEDGER_STATUS_INVALID") },
    declineAsk: async () => ({ ok: true }),
  }
  const page = mountView({ rows: live, bridge, mode: 'a' })
  try {
    await settle()
    page.control('A68', 'answer').click()
    await settle()
    page.record('A68').querySelector('[data-row-editor-words]').value = 'No, keep the trash for a week.'
    page.feed([{ ...live[0], status: 'answered', state: 'answered', answer: { words: 'Answered by the agent itself.', at: '2026-09-22T12:35:44.000Z' } }])
    page.control('A68', 'save').click()
    await settle()
    assert.equal(page.record('A68').querySelector('.ledger-line').dataset.state, 'answered', 'the row still shows the ask open')
    assert.equal(shown(page.control('A68', 'decline')), false, 'the row still offers Decline on an answered ask')
    assert.equal(page.hint('A68'), ANSWER_ROW.gone('A68'))
    assert.equal(page.record('A68').querySelector('[data-row-editor-words]')?.value, 'No, keep the trash for a week.', 'the owner\'s typed answer was thrown away')
  } finally { page.done() }
})

test('a Resolve reason longer than the store keeps is refused before anything is sent', async () => {
  const resolved = []
  const bridge = { ...recordingBridge(), resolveStandingRequest: async request => { resolved.push(request); return { ok: true } } }
  const page = mountView({ rows: [row('R31', 'open', 'open')], bridge })
  try {
    await settle()
    page.openResolve('R31')
    await settle()
    page.choose('R31', 'in-progress')
    page.record('R31').querySelector('[data-resolve-reason]').value = '拒'.repeat(702)
    page.record('R31').querySelector('[data-resolve-submit]').click()
    await settle()
    assert.deepEqual(resolved, [], 'a 2,106-byte reason was sent to a store that keeps 2,048')
    assert.equal(page.hint('R31'), LEDGER_REFUSAL.reasonTooLong)
  } finally { page.done() }
})

/* ---------- a row says what the Ledger has on file about it ---------- */

test('a row says when it was filed, who filed it, and what was answered, completed, blocked or decided, and by whom', async () => {
  const at = '2026-09-22T11:04:09.000Z'
  const history = (kind, actor) => [{ seq: 1, kind: 'file', at: '2026-09-01T10:00:00.000Z', actor: 'codex' }, { seq: 2, kind, at, actor }]
  const rows = [
    row('R11', 'done', 'done', { latestDecision: { decision: 'resolve', status: 'done', reason: 'Shipped and checked.', at, actor: 'owner' } }),
    row('T3', 'blocked-external', 'blocked', { kind: 'T', filedBy: 'codex', latestDecision: { decision: 'progress', status: 'blocked-external', reason: 'needs the owner to sign in', at, actor: 'codex' } }),
    row('T20', 'recurring', 'recurring', { kind: 'T', recurrence: { interval: 'daily', completions: [{ at: '2026-09-21T09:00:00.000Z', actor: 'owner' }, { at, actor: 'owner' }] } }),
    row('T5', 'done', 'done', { kind: 'T', completedAt: at, completedBy: 'owner' }),
    row('A4', 'answered', 'answered', { kind: 'A', filedBy: 'claude', answer: { words: 'Yes, <b>tonight</b> after 10pm.', at }, history: history('answer', 'owner') }),
    row('A63', 'answered', 'answered', { kind: 'A', filedBy: 'claude', answer: { words: 'Yes, delete it.', at }, history: history('answer', 'claude') }),
    row('A65', 'declined', 'removed', { kind: 'A', filedBy: 'codex', removed: true, latestDecision: { decision: 'decline', status: null, reason: 'Not worth it.', at, actor: 'codex' }, history: history('decline', 'codex') }),
  ]
  const bridge = { ...recordingBridge(), completeTask: async () => ({ ok: true }), removeTask: async () => ({ ok: true }), answerAsk: async () => ({ ok: true }), removeAsk: async () => ({ ok: true }) }
  const page = mountView({ rows, bridge, mode: 'all' })
  try {
    await settle()
    page.removedToggle.click()
    await settle()
    const detail = (id, name) => page.record(id)?.querySelector(`[data-row-detail="${name}"]`)?.textContent.replace(/\s+/g, ' ') || ''
    for (const item of rows) {
      const stamp = page.record(item.id)?.querySelector('[data-filed-at] time')
      assert.equal(stamp?.getAttribute('datetime'), item.filedAt, `${item.id} does not say when it was filed`)
    }
    /* The stand-in trims mixed text and preserves escaped HTML entities. */
    assert.match(detail('R11', 'resolved'), /^Resolved as Done by you ?.+: Shipped and checked\.$/, 'the reason typed when resolving is not shown')
    assert.equal(detail('T3', 'progress'), 'Waiting on: needs the owner to sign in', 'a blocked task does not say what it is waiting on')
    assert.match(page.record('T3').querySelector('.ledger-words').textContent, /filed by your agent codex/, 'a task does not say which agent filed it')
    assert.match(detail('T20', 'runs'), /^Completed 2 times, last\s*/, 'a recurring task does not show its runs')
    assert.match(detail('T5', 'completed'), /^Completed by you ?/)
    assert.match(detail('A4', 'answer'), /^Answered by you ?.+: Yes, &lt;b&gt;tonight&lt;\/b&gt; after 10pm\.$/, 'the owner\'s answer is not shown')
    assert.ok(!page.register.innerHTML.includes('<b>tonight</b>'), 'an answer was drawn as markup')
    assert.match(page.record('A4').querySelector('.ledger-words').textContent, /filed by your agent claude/, 'an ask does not say which agent is asking')
    assert.match(detail('A63', 'answer'), /^Answered by your agent claude ?.+: Yes, delete it\.$/, 'an ask an agent answered itself looks like one the owner answered')
    assert.match(detail('A65', 'declined'), /^Declined by your agent codex ?.+: Not worth it\.$/)
  } finally { page.done() }
})

/* ---------- totals and counters count the records on each tab ---------- */

const tilesOf = page => page.root.querySelectorAll('[data-summary]').map(node => [node.getAttribute('data-summary'), Number(node.textContent), node.closest('.ledger-stat').querySelector('.ledger-stat-label').textContent])
const countLine = page => page.root.querySelector('[data-visible-count]').textContent

test('the tabs name rules, tasks, asks and purchases, and every counter says one or many in those words', async () => {
  const kinds = { R: 'R', T: 'T', A: 'A' }
  const make = (kind, n) => Array.from({ length: n }, (_, index) => row(`${kind}${index + 1}`, 'open', 'open', { kind: kinds[kind] }))
  const page = mountView({ rows: [], bridge: recordingBridge() })
  try {
    await settle()
    assert.deepEqual(page.root.querySelectorAll('[data-mode]').map(button => button.textContent), ['Rules', 'Tasks', 'Asks', 'Purchases', 'All'])
    for (const [n, words] of [[0, { r: '0 rules', t: '0 tasks', a: '0 asks · 0 waiting for you · 0 questions · 0 open', all: '0 records' }],
      [1, { r: '1 rule', t: '1 task', a: '1 ask · 1 waiting for you · 0 questions · 0 open', all: '3 records' }],
      [2, { r: '2 rules', t: '2 tasks', a: '2 asks · 2 waiting for you · 0 questions · 0 open', all: '6 records' }]]) {
      /* A ledger that exists with nothing left in it: the list sentence and a
         counter, not the never-filed notice. */
      const rows = [...make('R', n), ...make('T', n), ...make('A', n)]
      globalThis.__ledgerReply = () => reply(rows, { exists: true })
      window.dispatchEvent({ type: 'source' })
      await settle()
      for (const mode of ['r', 't', 'a', 'all']) {
        page.pick(mode)
        await settle()
        assert.equal(countLine(page), words[mode], `${mode} with ${n}`)
      }
    }
    page.pick('t')
    await settle()
    assert.equal(page.register.getAttribute('aria-label'), 'Your tasks')
  } finally { page.done() }
})

test('the Tasks tab counts tasks in their own statuses, blocked on you as waiting, and the tiles add up to the tasks', async () => {
  const task = (id, status) => row(id, status, status, { kind: 'T' })
  const rows = [task('T1', 'open'), task('T2', 'open'), task('T3', 'in-progress'), task('T4', 'blocked-external'), task('T5', 'blocked-external'), task('T6', 'done'), task('T7', 'recurring'), task('T8', 'superseded')]
  const page = mountView({ rows, bridge: recordingBridge(), mode: 't' })
  try {
    await settle()
    assert.deepEqual(tilesOf(page), [
      ['open', 2, 'Open'], ['in-progress', 1, 'In progress'], ['blocked-external', 2, 'Waiting for you'],
      ['recurring', 1, 'Recurring'], ['done', 1, 'Done'], ['superseded', 1, 'Superseded'],
    ], 'the Tasks tab still shows the rules\' tiles')
    assert.equal(tilesOf(page).reduce((sum, tile) => sum + tile[1], 0), 8, 'the tiles do not add up to the tasks listed')
    assert.equal(countLine(page), '8 tasks')
    page.pick('r')
    await settle()
    assert.deepEqual(tilesOf(page).map(tile => tile[0]), ['open', 'in-progress', 'gated', 'proposed', 'done', 'blocked'], 'the Rules tab lost its own tiles')
  } finally { page.done() }
})

test('open asks count as waiting for you, and hiding rows never takes them out of the totals', async () => {
  const ask = (id, status) => row(id, status, status === 'open' ? 'open' : status, { kind: 'A' })
  const rows = [ask('A1', 'open'), ask('A2', 'open'), ask('A3', 'answered'), row('R4', 'blocked-external', 'blocked-external'), row('R5', 'proposed', 'proposed', { filedBy: 'codex' })]
  const page = mountView({ rows, bridge: recordingBridge(), mode: 'a' })
  try {
    await settle()
    const tile = state => tilesOf(page).find(entry => entry[0] === state)?.[1]
    assert.equal(tile('proposed'), 2, 'open asks are not counted as waiting for you')
    assert.equal(countLine(page), '3 asks · 2 waiting for you · 0 questions · 0 open')
    page.hide('A1')
    await settle()
    assert.equal(tile('proposed'), 2, 'hiding an ask took it out of "your records"')
    assert.equal(countLine(page), '2 asks · 1 waiting for you · 1 hidden · 0 questions · 0 open')
    page.pick('r')
    await settle()
    assert.equal(tile('blocked'), 1)
    page.hide('R4')
    await settle()
    assert.equal(tile('blocked'), 1, 'hiding a blocked rule took it out of the totals, so the Ledger disagrees with Home')
    assert.equal(tile('proposed'), 1)
  } finally { page.done() }
})

test('with the asks unreadable, the Asks tab\'s totals and counter say so instead of counting the questions as everything', async () => {
  const page = mountView({ rows: [], bridge: recordingBridge(), mode: 'a' })
  try {
    globalThis.__ledgerReply = () => ({ ok: false, reason: 'the ledger file is damaged', code: 'AGENT_LEDGER_UNREADABLE', questions: { ok: true, reason: null, observedAt: null, value: [] } })
    window.dispatchEvent({ type: 'source' })
    await settle()
    assert.match(countLine(page), /the asks could not be read$/)
    for (const note of page.root.querySelectorAll('[data-summary-note]')) assert.equal(note.textContent, '· asks could not be read', 'the totals claim to be all of your records')
  } finally { page.done() }
})

/* ---------- the page's own words on every row ---------- */

test('rows say their status in the page\'s words, a task blocked outside wears the rule\'s mark, and checks show only when there are any', async () => {
  const rows = [
    row('R3', 'blocked-external', 'blocked-external'),
    row('R7', 'proposed', 'proposed', { filedBy: 'codex' }),
    row('R8', 'open', 'open'),
    row('R9', 'in-progress', 'gated', { gateCount: 2, unmetGateCount: 1 }),
    row('T13', 'blocked-external', 'blocked-external', { kind: 'T' }),
  ]
  const page = mountView({ rows, bridge: recordingBridge(), mode: 'all' })
  try {
    await settle()
    const title = id => page.record(id).querySelector('.ledger-title').textContent
    const spoken = id => page.record(id).querySelector('.ledger-sr-only').textContent
    assert.equal(title('R3'), 'Blocked, needs someone outside')
    assert.equal(spoken('R3'), 'Blocked, needs someone outside')
    assert.equal(title('R7'), 'Waiting for you')
    assert.equal(title('R8'), 'Open')
    for (const id of ['R3', 'R7', 'R8', 'R9', 'T13']) assert.doesNotMatch(title(id), /-/, `${id} shows a stored code`)
    assert.equal(page.record('T13').querySelector('.ledger-line').dataset.state, 'blocked-external', 'a blocked task wears a different mark from a blocked rule')
    assert.equal(page.record('T13').querySelector('.ledger-glyph').textContent, '⊘')
    assert.equal(title('T13'), title('R3'))
    assert.equal(shown(page.record('R8').querySelector('[data-gates]')), false, 'a rule with no checks still says "gates 0 unmet 0"')
    assert.doesNotMatch(page.record('R8').textContent, /gates \d|unmet \d/)
    assert.equal(page.record('R9').querySelector('[data-gates]')?.textContent, '1 of 2 checks still open')
    assert.equal(page.register.querySelectorAll('.ledger-empty').length, 0)
  } finally { page.done() }

  const empty = mountView({ rows: [row('R1', 'removed', 'removed', { removed: true })], bridge: recordingBridge(), mode: 'all' })
  try {
    await settle()
    assert.equal(empty.register.querySelector('.ledger-empty')?.textContent, EMPTY_LIST.all, 'the All tab points at a box it does not have')
  } finally { empty.done() }
})

test('an example press on the desktop names the example switch, and the website keeps its own sentence', async () => {
  const bridge = { ...recordingBridge() }
  for (const [chosen, sentence] of [[true, EXAMPLE_WRITE_NOTE_CHOSEN], [false, EXAMPLE_WRITE_NOTE]]) {
    globalThis.__ledgerOrigin = 'mock'
    globalThis.__exampleChosen = chosen
    const page = mountView({ rows: [], bridge })
    try {
      await settle()
      const form = page.root.querySelector('[data-ledger-file-form]')
      form.querySelector('[data-file-words]').value = 'Try to file on the example.'
      form.dispatchEvent({ type: 'submit', preventDefault() {} })
      await settle()
      assert.equal(form.querySelector('[data-action-output]').textContent, sentence)
      assert.equal(bridge.calls.length, 0, 'the example filed something')
    } finally { page.done(); delete globalThis.__ledgerOrigin; delete globalThis.__exampleChosen }
  }
})

/* ---------- the × and Show hidden ---------- */

test('a full hide list says so and keeps the row; hides for records that are gone stop counting toward the cap', async () => {
  const task = id => row(id, 'open', 'open', { kind: 'T' })
  const tasks = Array.from({ length: 501 }, (_, index) => task(`T${index + 1}`))
  const full = mountView({ rows: tasks, bridge: recordingBridge(), mode: 't', hiddenKeys: tasks.slice(0, 500).map(item => `t:${item.id}`) })
  try {
    await settle()
    full.hide('T501')
    await settle()
    assert.equal(shown(full.record('T501')), true, 'a row the list could not store was taken off the screen anyway')
    assert.equal(full.root.querySelector('[data-hidden-note]').textContent, HIDE_ROW.full('T501'), 'the page claimed T501 was hidden')
  } finally { full.done() }

  /* 500 hides, 480 of them for tasks deleted since: they are forgotten on the
     next complete read, and the hide works. */
  const gone = Array.from({ length: 480 }, (_, index) => `t:T${index + 1000}`)
  const page = mountView({ rows: tasks.slice(0, 30), bridge: recordingBridge(), mode: 't', hiddenKeys: [...gone, ...tasks.slice(0, 20).map(item => `t:${item.id}`)] })
  try {
    await settle()
    assert.equal(JSON.parse(stored.get('mc.ledger.hidden:live')).ids.length, 20, 'hides for deleted tasks still take room')
    page.hide('T25')
    await settle()
    assert.equal(shown(page.record('T25')), false)
    assert.equal(page.root.querySelector('[data-hidden-note]').textContent.startsWith(HIDE_ROW.hiddenR('T25')), true)
  } finally { page.done() }
})

test('after a hide focus is on Undo, after Undo it is back on the row, and Show hidden stays with the tab it was pressed on', async () => {
  const rows = [row('R1', 'open', 'open'), row('R2', 'open', 'open'), row('T1', 'open', 'open', { kind: 'T' }), row('T2', 'open', 'open', { kind: 'T' })]
  const page = mountView({ rows, bridge: recordingBridge(), mode: 't' })
  try {
    await settle()
    page.hide('T1')
    await settle()
    const undo = page.root.querySelector('[data-undo-hide]')
    assert.equal(document.activeElement === undo, true, 'focus fell to the top of the page after the hide')
    page.undo()
    await settle()
    assert.equal(document.activeElement === page.record('T1')?.querySelector('[data-hide]'), true, 'focus did not come back to the restored row')

    page.hide('T1')
    await settle()
    page.root.querySelector('[data-show-hidden]').click()
    await settle()
    assert.equal(page.root.querySelector('[data-show-hidden]').textContent, HIDE_ROW.hideAgain)
    page.pick('r')
    await settle()
    page.hide('R2')
    await settle()
    assert.equal(shown(page.record('R2')), false, 'Show hidden from the Tasks tab kept R2 listed after it was hidden')
    const toggle = page.root.querySelector('[data-show-hidden]')
    assert.equal(toggle.textContent, HIDE_ROW.show)
  } finally { page.done() }
})

test('the Asks tab offers its own Show removed, with the removed count, instead of inheriting one it cannot turn off', async () => {
  const ask = (id, status, state = status) => row(id, status, state, { kind: 'A', removed: state === 'removed' })
  const rows = [ask('A1', 'open'), ask('A2', 'declined', 'removed'), ask('A3', 'removed', 'removed'), row('T1', 'open', 'open', { kind: 'T' })]
  const page = mountView({ rows, bridge: recordingBridge(), mode: 't' })
  try {
    await settle()
    page.removedToggle.click()
    await settle()
    page.pick('a')
    await settle()
    assert.equal(page.removedToggle.hidden, false, 'the Asks tab lists removed asks with no toggle to put them away')
    assert.equal(page.removedToggle.textContent, REMOVED_TOGGLE.hide)
    assert.match(page.root.querySelector('[data-visible-count]').textContent, /· 2 removed · /)
    assert.equal(shown(page.record('A2')), true)
    page.removedToggle.click()
    await settle()
    assert.equal(shown(page.record('A2')), false)
    assert.equal(page.removedToggle.textContent, REMOVED_TOGGLE.show)
  } finally { page.done() }
})

test('a refinement whose rule is hidden is not indented under an unrelated row, and says which rule it refines', async () => {
  const rows = [
    row('R213', 'proposed', 'proposed', { filedBy: 'codex' }),
    row('R214', 'open', 'open'),
    row('R214.1', 'open', 'open', { parentId: 'R214', filedBy: 'codex' }),
    row('R214.2', 'open', 'open', { parentId: 'R214', filedBy: 'claude' }),
  ]
  const page = mountView({ rows, bridge: recordingBridge() })
  try {
    await settle()
    assert.equal(page.record('R214.1').getAttribute('aria-level'), '2', 'a refinement under its drawn rule sits one level in')
    page.hide('R214')
    await settle()
    for (const id of ['R214.1', 'R214.2']) {
      assert.equal(page.record(id).getAttribute('aria-level'), '1', `${id} still reads as a refinement of R213`)
      assert.match(page.record(id).getAttribute('style'), /--depth:0/)
      assert.equal(page.record(id).querySelector('[data-refines]')?.textContent, HIDE_ROW.refines('R214'))
    }
    assert.equal(shown(page.record('R213').querySelector('[data-refines]')), false)
  } finally { page.done() }
})

/* ---------- roles a screen reader can count, chips it can read ---------- */

test('every tab\'s list and its rows agree on their roles, and a named chip keeps its reach and its whole text', async () => {
  const rows = [
    row('R1', 'open', 'open', { scope: 'tree', scopeKey: 'node-9', scopeLabel: 'Worker' }),
    row('R2', 'open', 'open', { scope: 'thread', scopeKey: 'node-9', scopeLabel: 'Worker' }),
    row('R3', 'open', 'open', { scope: 'session', scopeKey: 'chat-1', scopeLabel: 'Coordinator · session' }),
    row('T1', 'open', 'open', { kind: 'T' }),
    row('A1', 'open', 'open', { kind: 'A' }),
  ]
  const page = mountView({ rows, bridge: recordingBridge() })
  try {
    await settle()
    const roles = () => page.register.querySelectorAll('.ledger-record').map(record => record.getAttribute('role'))
    assert.equal(page.register.getAttribute('role'), 'tree')
    assert.deepEqual([...new Set(roles())], ['treeitem'])
    const chip = id => page.record(id).querySelector('.ledger-scope')
    assert.equal(chip('R1').textContent, 'Worker · tree')
    assert.equal(chip('R2').textContent, 'Worker · circle', 'a circle rule reads the same as a tree rule for the same agent')
    assert.equal(chip('R3').textContent, 'Coordinator · session', 'a label that already says its reach is not said twice')
    for (const id of ['R1', 'R2', 'R3']) assert.equal(chip(id).getAttribute('title'), chip(id).textContent, `${id}'s chip has no full text beyond its cut`)
    for (const mode of ['t', 'a', 'all']) {
      page.pick(mode)
      await settle()
      assert.equal(page.register.getAttribute('role'), 'list', `${mode}: the register is not a list`)
      assert.deepEqual([...new Set(roles())], ['listitem'], `${mode}: rows are not list items`)
      assert.equal(page.register.querySelectorAll('[aria-level]').length, 0, `${mode}: tree items inside a list`)
    }
    assert.equal(page.register.querySelector('.ledger-asks-records') ? 'present' : 'absent', 'absent', 'the Asks section is left after leaving the tab')
    page.pick('a')
    await settle()
    assert.equal(page.register.querySelector('.ledger-asks-records').getAttribute('role'), 'none', 'the asks section stands between the list and its items')
  } finally { page.done() }
})

/* ---------- purchases on file, and the rules form only where the rules are ---------- */

test('Purchases lists every purchase on file with what it is, who decided and what was charged; All includes them', async () => {
  const at = '2026-09-22T11:05:00.000Z'
  const purchase = (id, status, extra = {}) => row(id, status, status, { kind: 'P', filedBy: 'codex', words: `Purchase ${id}`, purchase: { lines: [{ merchant: 'An example registrar', purpose: 'Renew the domain', amountCents: 1200, currency: 'USD' }], decision: null, recordedCharge: null, ...extra } })
  const rows = [
    purchase('P1', 'proposed'),
    purchase('P2', 'approved', { decision: { decision: 'approve', reason: 'Needed for the launch.', at, actor: 'owner' } }),
    purchase('P3', 'recorded', { decision: { decision: 'approve', reason: null, at, actor: 'owner' }, recordedCharge: { amountCents: 1200, currency: 'USD', at } }),
    row('R1', 'open', 'open'),
  ]
  const page = mountView({ rows, bridge: recordingBridge(), mode: 'p' })
  try {
    await settle()
    assert.equal(page.register.hidden, false, 'the Purchases tab lists nothing on file')
    for (const id of ['P1', 'P2', 'P3']) assert.equal(shown(page.record(id)), true, `${id} is not listed`)
    assert.equal(page.root.querySelector('[data-visible-count]').textContent, '3 purchases')
    const detail = (id, name) => page.record(id).querySelector(`[data-row-detail="${name}"]`)?.textContent.replace(/\s+/g, ' ') || ''
    assert.equal(detail('P1', 'purchase-line'), 'Item: An example registrar — Renew the domain, 12.00 USD')
    assert.match(detail('P2', 'purchase-decision'), /^Approved by you ?.+: Needed for the launch\.$/)
    assert.match(detail('P3', 'purchase-charge'), /^Charge recorded ?.+: 12\.00 USD$/)
    assert.equal(page.record('P1').querySelector('.ledger-title').textContent, 'Waiting for you')
    assert.equal(page.record('P2').querySelector('.ledger-title').textContent, 'Approved')
    assert.equal(page.record('P1').querySelectorAll('[data-row-action]').length, 0, 'a purchase row offers a control that does nothing')
    page.pick('all')
    await settle()
    for (const id of ['P1', 'P2', 'P3', 'R1']) assert.equal(shown(page.record(id)), true, `All leaves ${id} out`)
  } finally { page.done() }
})

test('the Approve or Decline form is on Rules and All only, and offers only rules a decision can land on', async () => {
  const rows = [row('R1', 'open', 'open'), row('R5', 'done', 'done'), row('R7', 'superseded', 'superseded'), row('R15', 'proposed', 'proposed', { filedBy: 'codex' })]
  const page = mountView({ rows, bridge: recordingBridge() })
  try {
    await settle()
    const form = page.root.querySelector('[data-decision-form]')
    assert.equal(form.hidden, false)
    assert.deepEqual(globalThis.__formRegister.items.map(item => item.id), ['R1', 'R15'], 'the picker offers rules no decision can land on')
    for (const [mode, hidden] of [['t', true], ['a', true], ['p', true], ['all', false], ['r', false]]) {
      page.pick(mode)
      await settle()
      assert.equal(form.hidden, hidden, `${mode}: the rules form is ${hidden ? 'shown' : 'hidden'}`)
    }
  } finally { page.done() }
})

/* ---------- the list Home's ledger line opens ---------- */

test('opened from Home\'s ledger line, the Ledger lists exactly the records Home counts, across every kind, until asked for the whole', async () => {
  const rows = [
    row('R1', 'open', 'open'),
    row('R4', 'blocked-external', 'blocked-external'),
    row('R5', 'proposed', 'proposed', { filedBy: 'codex' }),
    row('T3', 'blocked-external', 'blocked-external', { kind: 'T' }),
    row('T4', 'open', 'open', { kind: 'T' }),
    row('A1', 'open', 'open', { kind: 'A' }),
  ]
  const before = globalThis.location
  globalThis.location = { hash: '#/ledger?waiting=blocked' }
  const page = mountView({ rows, bridge: recordingBridge(), mode: 'r', hiddenKeys: ['t:T3'] })
  try {
    await settle()
    const listed = () => page.register.querySelectorAll('.ledger-record').map(record => record.getAttribute('data-row-id'))
    assert.deepEqual(listed(), ['R4', 'T3'], 'Home\'s blocked count does not match the list it opens')
    assert.equal(page.root.querySelector('[data-mode="all"]').getAttribute('aria-pressed'), 'true', 'the list opened on the last-used tab instead of across every kind')
    const note = page.root.querySelector('[data-waiting-filter]')
    assert.equal(note.hidden, false)
    assert.match(note.textContent, /blocked on you, the ones Home counts/)
    assert.equal(page.root.querySelector('[data-visible-count]').textContent.startsWith('2 records'), true)
    press(note.querySelector('[data-clear-waiting]'))
    await settle()
    assert.deepEqual(listed(), ['R1', 'R4', 'R5', 'T4', 'A1'], 'Show the whole Ledger did not show the rest (T3 stays hidden by its own ×)')
    assert.equal(note.hidden, true)
  } finally { page.done(); globalThis.location = before }

  globalThis.location = { hash: '#/ledger?waiting=attention' }
  const review = mountView({ rows, bridge: recordingBridge() })
  try {
    await settle()
    assert.deepEqual(review.register.querySelectorAll('.ledger-record').map(record => record.getAttribute('data-row-id')), ['R5', 'A1'])
    review.pick('t')
    await settle()
    assert.equal(review.root.querySelector('[data-waiting-filter]').hidden, true, 'a tab press did not end the narrowed view')
  } finally { review.done(); globalThis.location = before }
})

/* ---------- a damaged Ledger file ---------- */

test('a damaged Ledger file says so with the repair, draws no unrelated link, and turns filing off with the reason', async () => {
  const bridge = recordingBridge()
  const page = mountView({ rows: [], bridge })
  try {
    globalThis.__ledgerReply = () => ({ ok: false, code: 'AGENT_LEDGER_DAMAGED', reason: 'The ledger file on this computer is damaged.', backup: true, questions: QUESTIONS_OK })
    window.dispatchEvent({ type: 'source' })
    await settle()
    assert.match(page.register.textContent, /Replace OWNER-REQUEST-LEDGER\.json with the backup copy beside it/)
    assert.doesNotMatch(page.register.textContent, /Close ToolsEnabled and open it again/)
    assert.equal(page.register.querySelectorAll('.host-absent-action').length, 0, 'a link to unrelated Settings is offered as the repair')
    const form = page.root.querySelector('[data-ledger-file-form]')
    const submit = form.querySelector('[data-ledger-file]')
    assert.equal(submit.disabled, true, 'File it stays on over a damaged Ledger')
    assert.equal(form.querySelector('[data-action-output]').textContent, FILE_BOX_OFF.damaged)
    form.querySelector('[data-file-words]').value = 'A rule typed anyway.'
    form.dispatchEvent({ type: 'submit', preventDefault() {} })
    await settle()
    assert.equal(bridge.calls.length, 0, 'a filing reached a damaged Ledger')
    assert.equal(form.querySelector('[data-action-output]').textContent, FILE_BOX_OFF.damaged)
    page.pick('t')
    await settle()
    assert.equal(page.register.textContent.includes(LEDGER_DAMAGED.body), true, 'the Tasks tab tells a different story')
  } finally { page.done() }
})

/* ---------- finding one record in a large Ledger ---------- */

test('the find box narrows the tab to an id or words, says so, and a link naming a record opens its tab on it', async () => {
  const task = (id, words) => row(id, 'open', 'open', { kind: 'T', words })
  const rows = [
    ...Array.from({ length: 40 }, (_, index) => task(`T${1500 + index}`, `Routine task ${index}.`)),
    task('T1553', 'Restart the build server after 10pm.'),
    row('R1', 'open', 'open', { words: 'Ask before restarting anything.' }),
  ]
  const bridge = { ...recordingBridge(), completeTask: async () => ({ ok: true }) }
  const page = mountView({ rows, bridge, mode: 't' })
  try {
    await settle()
    const find = page.root.querySelector('[data-ledger-find]')
    assert.ok(find, 'the Ledger has no way to find a record')
    const listed = () => page.register.querySelectorAll('.ledger-record').map(record => record.getAttribute('data-row-id'))
    find.value = 'T1553'
    find.dispatchEvent({ type: 'input' })
    await settle()
    assert.deepEqual(listed(), ['T1553'])
    assert.equal(page.root.querySelector('[data-visible-count]').textContent, `1 task · ${FIND_BOX.tail('T1553')}`)
    find.value = 'restart'
    find.dispatchEvent({ type: 'input' })
    await settle()
    assert.deepEqual(listed(), ['T1553'], 'words do not find the task')
    page.pick('r')
    await settle()
    assert.deepEqual(listed(), ['R1'], 'the find box does not follow to the Rules tab')
    find.value = 'nothing like this'
    find.dispatchEvent({ type: 'input' })
    await settle()
    assert.equal(page.register.querySelector('.ledger-empty')?.textContent, FIND_BOX.none('nothing like this'))
    find.value = ''
    find.dispatchEvent({ type: 'input' })
    await settle()
    assert.deepEqual(listed(), ['R1'])
  } finally { page.done() }

  const before = globalThis.location
  globalThis.location = { hash: '#/ledger?id=T1553' }
  const linked = mountView({ rows, bridge, mode: 'r' })
  try {
    await settle()
    assert.equal(linked.root.querySelector('[data-mode="t"]').getAttribute('aria-pressed'), 'true', 'a link naming T1553 did not open the Tasks tab')
    assert.equal(linked.root.querySelector('[data-ledger-find]').value, 'T1553')
    assert.deepEqual(linked.register.querySelectorAll('.ledger-record').map(record => record.getAttribute('data-row-id')), ['T1553'])
    assert.equal(linked.record('T1553').contains(document.activeElement), true, 'focus is not on the named record')
  } finally { linked.done(); globalThis.location = before }
})

/* ---------- a record adopted with unconfirmed history is marked ---------- */

test('a record adopted with its history unconfirmed says so on its row', async () => {
  const at = '2026-09-22T11:11:30.000Z'
  const rows = [
    row('R1', 'open', 'open', { history: [{ seq: 1, kind: 'file', at: '2026-09-01T10:00:00.000Z', actor: 'owner' }, { seq: 2, kind: 'adopt', at, actor: 'owner' }] }),
    row('R2', 'open', 'open'),
  ]
  const page = mountView({ rows, bridge: recordingBridge() })
  try {
    await settle()
    assert.match(page.record('R1').querySelector('[data-row-detail="adopted"]')?.textContent || '', /^History not verified: adopted as it stood/)
    assert.equal(shown(page.record('R2').querySelector('[data-row-detail="adopted"]')), false)
  } finally { page.done() }
})

/* T1387: pressing Show removed with the keyboard reloads the list, and the
   reload hides the toggle while it reads, which drops focus to the page; the
   next Tab went back up to the top of the Ledger. The stand-in models the
   browser rule on this one control: hiding it while it has focus blurs it. */
test('Show removed keeps keyboard focus through its reload, now reading Hide removed', async () => {
  const page = mountView({ rows: [row('R1', 'open', 'removed', { removed: true, removedAt: '2026-09-02T10:00:00.000Z' })] })
  await settle()
  const toggle = page.removedToggle
  assert.equal(toggle.hidden, false)
  let hidden = toggle.hidden
  Object.defineProperty(toggle, 'hidden', {
    configurable: true,
    get: () => hidden,
    set: next => { hidden = Boolean(next); if (hidden && document.activeElement === toggle) document.activeElement = document.body },
  })
  toggle.focus()
  toggle.click()
  await settle()
  assert.equal(toggle.textContent, REMOVED_TOGGLE.hide)
  assert.equal(toggle.getAttribute('aria-pressed'), 'true')
  assert.equal(document.activeElement, toggle, 'focus fell to the page after Show removed')
  toggle.click()
  await settle()
  assert.equal(toggle.textContent, REMOVED_TOGGLE.show)
  assert.equal(document.activeElement, toggle, 'focus fell to the page after Hide removed')
  page.done()
})
