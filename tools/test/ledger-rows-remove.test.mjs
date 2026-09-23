// THE × ON EVERY LEDGER ROW, AND THE TWO MODULES BEHIND IT (plan P-O6).
//
// What the owner asked for was a way to take a row off the Ledger page. What
// the three lists can honestly do was measured first (plan O6): an owner
// request lives in an append-only, hash-chained overlay that is never
// shortened and an archived request stays on every projected list until three
// sessions have seen it; an owner question is parsed out of a planning file
// the app has no writer for. So the × hides the row on this screen, in this
// copy's own storage, and every sentence beside it says so.
//
// Three things are held here:
//   1. the row markup -- exactly one × per row, never a button inside a button
//      (the Q row is itself a <button>), the R row no longer pretends to expand;
//   2. createHiddenRows -- round-trips, survives damage, caps, and never shares
//      an id between the live list and the example list;
//   3. armOnce -- false on the first press, true on the second, and a lone press
//      disarms itself.
//
// src/views/ledger.js imports a stylesheet, so a plain `node` run cannot load
// it. The row builders use their item and explicit ledger copy inputs, so
// this suite lifts that stretch of the source (everything between STATE and
// ledgerView) into a module of its own and runs the real builders.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

import { createHiddenRows, HIDDEN_ROWS_CAP } from '../../src/hidden-rows.js'
import { armOnce } from '../../src/arm-press.js'
import { HIDE_ROW } from '../../src/ledger-copy.js'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = relative => readFileSync(path.join(REPO, relative), 'utf8')

const BUILDER_COPY = ['HIDE_ROW', 'ROW_ACTIONS', 'RESOLVE_STATUSES', 'RESOLVE_NOTE']

async function rowBuilders({ omitCopy = [], changeSource = source => source } = {}) {
  const source = read('src/views/ledger.js')
  const start = source.indexOf('const STATE = {')
  const end = source.indexOf('export function ledgerView()')
  assert.ok(start > 0 && end > start, 'the builders no longer sit between STATE and ledgerView; move this extractor')
  const copy = pathToFileURL(path.join(REPO, 'src', 'ledger-copy.js')).href
  /* The builders reach one classification outside this stretch of source:
     ownerWaitingStatus, which decides whether a row wears the owner's waiting
     colour. It is imported here as the real function rather than stubbed --
     the row must be coloured by the rule Home's circle is coloured by, and a
     stand-in would let the two drift without this suite noticing. */
  const owner = pathToFileURL(path.join(REPO, 'src', 'home-ledger-status.js')).href
  const inputs = BUILDER_COPY.filter(name => !omitCopy.includes(name)).join(', ')
  const module = `import { ${inputs} } from ${JSON.stringify(copy)}\n`
    + `import { ownerWaitingStatus } from ${JSON.stringify(owner)}\n`
    + `${changeSource(source.slice(start, end))}\nexport { requestMarkup, questionMarkup }\n`
  return import(`data:text/javascript;base64,${Buffer.from(module, 'utf8').toString('base64')}`)
}

const REQUEST = Object.freeze({ id: 'R12', status: 'done', gateCount: 2, unmetGateCount: 0 })
const QUESTION = Object.freeze({ id: 'Q7', title: 'Which relay region?', status: 'open', statusClass: 'open', packageId: 'P3' })
/* Rows in the live feed's shape (src/ledger-live.js rowOf): the person's
   words, who the rule reaches, who filed it, and the rail glyph. */
const LIVE_ROW = Object.freeze({ id: 'R12', parentId: null, scope: 'tree', scopeKey: 'node-1-2f6a9c3e', scopeLabel: null, status: 'open', state: 'open', words: 'Keep <b>the</b> tests & green.', filedBy: 'owner', filedAt: '2026-09-01T10:00:00.000Z', gateCount: 0, unmetGateCount: 0, decisions: 0, history: [], removedAt: null, removed: false })
const PROPOSED_ROW = Object.freeze({ ...LIVE_ROW, id: 'R13', status: 'proposed', state: 'proposed', filedBy: 'codex', scopeLabel: 'Coordinator' })
const REMOVED_ROW = Object.freeze({ ...LIVE_ROW, id: 'R14', status: 'removed', state: 'removed', removedAt: '2026-09-01T11:00:00.000Z', removed: true })
const ACTIONS = Object.freeze({ edit: 'Edit', delete: 'Delete', approve: 'Approve', decline: 'Decline', groupLabel: id => `What you can do with ${id}` })
const COPY = Object.freeze({ scope: { global: 'everywhere', tree: 'tree', session: 'session', thread: 'circle' }, proposed: who => `Your agent ${who} filed this from your words.`, filedBy: who => `filed by your agent ${who}` })

/* A tag-stack walk over the markup: the one thing a regex cannot do is tell
   whether a <button> opened inside another that has not closed yet. */
function nestedButtons(markup) {
  const stack = []
  let nested = 0
  for (const match of markup.matchAll(/<(\/?)([a-z][a-z0-9-]*)[^>]*?(\/?)>/gi)) {
    const [, closing, name, selfClosing] = match
    const tag = name.toLowerCase()
    if (closing) {
      const index = stack.lastIndexOf(tag)
      if (index >= 0) stack.splice(index)
      continue
    }
    if (selfClosing || ['br', 'hr', 'img', 'input', 'meta', 'link'].includes(tag)) continue
    if (tag === 'button' && stack.includes('button')) nested += 1
    stack.push(tag)
  }
  return nested
}

/* Read start tags as the browser-facing name/attribute values that matter to
   these checks. Attribute order, whitespace, and unrelated attributes are
   intentionally ignored: none of those changes what a row does. */
function startTags(markup) {
  return [...markup.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*)>/gi)].map(([, name, source]) => {
    const attrs = new Map()
    for (const match of source.matchAll(/([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
      attrs.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? '')
    }
    return { name: name.toLowerCase(), attrs }
  })
}

const hasClass = (tag, name) => (tag.attrs.get('class') || '').split(/\s+/).includes(name)
const tagsWith = (markup, attribute) => startTags(markup).filter(tag => tag.attrs.has(attribute))

function assertRequestBadges(requestMarkup) {
  /* These row identities remain exact even though the summary strip groups
     partial with in-progress and blocked-external with blocked. ledger.test
     separately exercises that strip through the mounted view. */
  /* The accessible status and the visible one are the page's own words,
     never the stored code with its hyphens (T1264). */
  for (const [status, glyph, label] of [['partial', '◑', 'Partly done'], ['blocked-external', '⊘', 'Blocked, needs someone outside'], ['not-possible-as-asked', '⊗', 'Not possible as asked'], ['superseded', '»', 'Superseded']]) {
    const markup = requestMarkup({ id: 'R9', status, gateCount: 1, unmetGateCount: 1 })
    assert.equal(startTags(markup).find(tag => hasClass(tag, 'ledger-line'))?.attrs.get('data-state'), status,
      `the ${status} row lost its own badge identity`)
    assert.ok(markup.includes(`<span class="ledger-glyph" aria-hidden="true">${glyph}</span>`), `${status} lost its glyph`)
    assert.ok(markup.includes(`<span class="ledger-sr-only">${label}</span>`), `${status} lost its accessible status`)
    assert.ok(markup.includes(`<span class="ledger-title">${label}</span>`), `${status} shows its stored code instead of its words`)
    assert.ok(!markup.includes(`>${status}<`), `${status} still shows the stored code`)
  }
}

function assertResolvePicker(requestMarkup) {
  const markup = requestMarkup(LIVE_ROW, { resolveOpen: true, actions: { ...ACTIONS, resolve: 'Resolve' }, copy: COPY })
  const slots = tagsWith(markup, 'data-resolve-slot')
  assert.equal(slots.length, 1)
  assert.equal(slots[0].attrs.has('hidden'), false, 'the opened Resolve picker is hidden')
  const choices = tagsWith(markup, 'data-resolve-status')
  assert.deepEqual(choices.map(tag => tag.attrs.get('value')),
    ['in-progress', 'partial', 'blocked-external', 'done', 'not-possible-as-asked', 'superseded'])
  assert.deepEqual(choices.map(tag => tag.attrs.has('checked')), [true, false, false, false, false, false])
  assert.ok(choices.every(tag => tag.name === 'input' && tag.attrs.get('type') === 'radio' && tag.attrs.get('name') === 'resolve-status-R12'))
  const group = startTags(markup).find(tag => tag.attrs.get('role') === 'radiogroup')
  assert.equal(group?.attrs.get('aria-label'), 'Resolve R12')
  assert.match(markup, /Resolve R12 to move it off the open list without deleting it/)
  const reason = tagsWith(markup, 'data-resolve-reason')
  assert.equal(reason.length, 1)
  assert.equal(reason[0].attrs.get('maxlength'), '2000')
  const submit = tagsWith(markup, 'data-resolve-submit')
  assert.equal(submit.length, 1)
  assert.equal(submit[0].attrs.get('data-id'), 'R12', 'Resolve must submit the row that opened it')
  assert.equal(tagsWith(markup, 'data-resolve-cancel').length, 1)
  assert.equal(nestedButtons(markup), 0)
  const closed = requestMarkup(LIVE_ROW)
  assert.equal(tagsWith(closed, 'data-resolve-slot')[0]?.attrs.has('hidden'), true)
  assert.equal(tagsWith(closed, 'data-resolve-status').length, 0, 'a closed picker still draws choices')
  assert.equal(tagsWith(closed, 'data-resolve-submit').length, 0, 'a closed picker still offers submission')
}

test('every row carries exactly one × and no button is nested inside another', async () => {
  const { requestMarkup, questionMarkup } = await rowBuilders()
  const rows = {
    'R row': requestMarkup(REQUEST),
    'R row, hidden and shown': requestMarkup(REQUEST, { hidden: true }),
    'R row with its controls': requestMarkup(LIVE_ROW, { actions: ACTIONS, copy: COPY }),
    'R row waiting for approval': requestMarkup(PROPOSED_ROW, { actions: ACTIONS, copy: COPY }),
    'R row, removed': requestMarkup(REMOVED_ROW, { actions: ACTIONS, copy: COPY }),
    'Q row': questionMarkup(QUESTION),
    'Q row, expanded': questionMarkup(QUESTION, { expanded: true }),
    'Q row, hidden and shown': questionMarkup(QUESTION, { hidden: true }),
  }
  for (const [name, markup] of Object.entries(rows)) {
    assert.equal(startTags(markup).filter(tag => tag.name === 'button' && hasClass(tag, 'ledger-hide')).length, 1, `${name} does not carry exactly one ×`)
    assert.equal(nestedButtons(markup), 0, `${name} nests a button inside a button`)
    assert.equal(tagsWith(markup, 'data-row-hint').length, 1, `${name} has nowhere to put the first press's sentence`)
  }
  /* The control's two states. */
  assert.equal(tagsWith(rows['R row'], 'data-hide')[0]?.attrs.get('data-hide'), 'r:R12', 'the R-row hide control targets a different row')
  assert.equal(tagsWith(rows['R row'], 'data-hide')[0]?.attrs.get('aria-label'), HIDE_ROW.aria('R12'), 'the R-row hide control does not explain its action')
  assert.equal(tagsWith(rows['R row'], 'data-hidden').length, 0, 'a visible R row is marked hidden')
  assert.equal(tagsWith(rows['R row, hidden and shown'], 'data-unhide')[0]?.attrs.get('data-unhide'), 'r:R12', 'the restore control targets a different row')
  assert.equal(tagsWith(rows['R row, hidden and shown'], 'data-hidden').length, 1, 'a hidden R row is not marked hidden')
  assert.equal(tagsWith(rows['R row, hidden and shown'], 'data-unhide')[0]?.attrs.get('aria-label'), HIDE_ROW.putBack('R12'), 'the restore control does not explain its action')
  assert.equal(tagsWith(rows['Q row'], 'data-hide')[0]?.attrs.get('data-hide'), 'q:Q7', 'the Q-row hide control targets a different row')
})

test('the R row no longer pretends to expand; the Q row still does', async () => {
  const { requestMarkup, questionMarkup } = await rowBuilders()
  const r = requestMarkup(REQUEST)
  /* The R detail repeated the row word for word (status / gates / unmet) --
     zero information behind a control that looked like it held some. */
  assert.equal(tagsWith(r, 'data-expand').length, 0, 'the R row still offers an expansion')
  assert.equal(startTags(r).some(tag => hasClass(tag, 'ledger-detail')), false, 'the R row still carries the empty detail')
  assert.equal(startTags(r).some(tag => tag.name === 'button' && hasClass(tag, 'ledger-row')), false, 'the R row is still a button')
  assert.equal(startTags(r).some(tag => tag.name === 'div' && hasClass(tag, 'ledger-row')), true, 'the R row is not plain content')
  const q = questionMarkup(QUESTION, { expanded: true })
  const qRow = tagsWith(q, 'data-expand').find(tag => hasClass(tag, 'ledger-row'))
  assert.deepEqual({ name: qRow?.name, type: qRow?.attrs.get('type'), target: qRow?.attrs.get('data-expand'), expanded: qRow?.attrs.get('aria-expanded') },
    { name: 'button', type: 'button', target: 'q:Q7', expanded: 'true' }, 'the expanded Q row is not an expanded button for Q7')
  assert.equal(startTags(q).some(tag => hasClass(tag, 'ledger-detail')), true, 'the expanded Q row has no detail')
  assert.equal(q.includes('status-class'), true, 'the Q detail omits its status class')
})

/* THE LIVE ROW (2026-09-02): the person's words under the rail, escaped; the
   reach chip; the row controls as siblings under the words, never inside the
   row and never nested; a proposed row with Approve and Decline and its note;
   a removed row with no controls at all. The builder stays pure: `actions`
   and `copy` are handed in, so a row with neither draws neither. */
test('the R row carries the person\'s words, the reach chip and its controls as siblings, by state', async () => {
  const { requestMarkup } = await rowBuilders()
  const plain = requestMarkup(REQUEST)
  assert.equal(tagsWith(plain, 'data-row-action').length, 0, 'a row handed no actions drew controls')
  assert.match(plain, /<p class="ledger-words"><\/p>/, 'a row with no words still carries the (empty) words line')
  assert.match(plain, /<span class="ledger-scope" data-scope="global">global<\/span>/, 'a row with no reach words shows the ledger\'s own word')

  const live = requestMarkup(LIVE_ROW, { actions: ACTIONS, copy: COPY })
  assert.match(live, /<p class="ledger-words">Keep &lt;b&gt;the&lt;\/b&gt; tests &amp; green\.<\/p>/, 'the words are not escaped')
  assert.match(live, /<span class="ledger-scope" data-scope="tree">tree · …2f6a9c3e<\/span>/, 'the chip does not carry the reach word and the key\'s tail')
  assert.match(live, /data-row-id="R12"/)
  assert.match(live, /<div class="ledger-row-editor" data-row-editor hidden><\/div>/, 'no slot for the editor')
  assert.doesNotMatch(live, /filed by your agent/, 'the person\'s own row names an agent')
  const controls = tagsWith(live, 'data-row-action')
  assert.deepEqual(controls.map(tag => [tag.attrs.get('data-row-action'), tag.attrs.get('data-id'), tag.attrs.get('data-key')]),
    [['edit', 'R12', 'node-1-2f6a9c3e'], ['delete', 'R12', 'node-1-2f6a9c3e']], 'a live row does not carry Edit and Delete with id and key')
  assert.equal(controls[1].attrs.get('aria-pressed'), 'false', 'Delete does not announce its unarmed state')
  assert.ok(startTags(live).every(tag => !(tag.name === 'button' && hasClass(tag, 'ledger-row'))), 'the R row became a button')
  /* The controls sit OUTSIDE .ledger-line, after the words: never inside the
     row grid, so the columns the owner laid down never move. */
  assert.ok(live.indexOf('data-row-action') > live.indexOf('class="ledger-words"'), 'the controls are drawn before the words')
  assert.ok(live.indexOf('data-row-action') > live.indexOf('class="ledger-hide"'), 'the controls are drawn inside the row line')

  const proposed = requestMarkup(PROPOSED_ROW, { actions: ACTIONS, copy: COPY })
  assert.match(proposed, /data-state="proposed"/)
  assert.match(proposed, /<span class="ledger-glyph" aria-hidden="true">◇<\/span>/, 'a proposed row does not wear the waiting glyph')
  assert.match(proposed, /<span class="ledger-scope" data-scope="tree">Coordinator<\/span>/, 'a labelled row does not show its label')
  assert.match(proposed, /<span class="ledger-filed-by">filed by your agent codex<\/span>/, 'an agent-filed row does not name its author')
  assert.match(proposed, /<p class="ledger-row-note" data-state="note">Your agent codex filed this from your words\.<\/p>/)
  assert.deepEqual(tagsWith(proposed, 'data-row-action').map(tag => tag.attrs.get('data-row-action')), ['approve', 'decline', 'edit'], 'a proposed row does not offer Approve, Decline and Edit')

  const removed = requestMarkup(REMOVED_ROW, { actions: ACTIONS, copy: COPY })
  assert.match(removed, /data-state="removed"/)
  assert.match(removed, /<span class="ledger-glyph" aria-hidden="true">–<\/span>/)
  assert.equal(tagsWith(removed, 'data-row-action').length, 0, 'a removed row still offers controls')
  assert.equal(startTags(removed).filter(tag => tag.name === 'button' && hasClass(tag, 'ledger-hide')).length, 1, 'a removed row lost its ×')

  /* Only the verbs the bridge has are drawn. */
  const editOnly = requestMarkup(LIVE_ROW, { actions: { edit: 'Edit', delete: null, approve: null, decline: null }, copy: COPY })
  assert.deepEqual(tagsWith(editOnly, 'data-row-action').map(tag => tag.attrs.get('data-row-action')), ['edit'])
  const noDecide = requestMarkup(PROPOSED_ROW, { actions: { edit: null, delete: 'Delete', approve: null, decline: null }, copy: COPY })
  assert.equal(tagsWith(noDecide, 'data-row-action').length, 0, 'a proposed row drew Delete, or a decision the bridge cannot take')

  /* A refinement is drawn one level in. */
  const child = requestMarkup({ ...LIVE_ROW, id: 'R12.1', parentId: 'R12' })
  assert.match(child, /style="--depth:1" role="treeitem" aria-level="2"/)
  /* The projection's old shape -- a status word and no state -- still draws
     each resolution status exactly. Prove the same checks reject a return
     of the old coarse badge mapping, using only an in-memory source copy. */
  assertRequestBadges(requestMarkup)
  for (const [status, folded] of [['partial', 'in-progress'], ['blocked-external', 'blocked']]) {
    const changed = await rowBuilders({ changeSource(source) {
      const original = 'const state = rowState(item)'
      assert.equal(source.split(original).length, 2, 'the badge mutation must reach exactly one builder')
      return source.replace(original, `const state = rowState(item) === '${status}' ? '${folded}' : rowState(item)`)
    } })
    assert.throws(() => assertRequestBadges(changed.requestMarkup), { code: 'ERR_ASSERTION', message: new RegExp(`${status} row lost its own badge identity`) })
  }
  assert.match(requestMarkup({ id: 'R9', status: 'declined', gateCount: 0, unmetGateCount: 0 }), /data-state="removed"/)
})

test('the view keys the reach filter and fences every write control, and builders use explicit copy inputs', async () => {
  const view = read('src/views/ledger.js')
  assert.match(view, /'mc\.ledger\.scope'/, 'the reach filter is not remembered per copy')
  assert.match(view, /button\[data-decision\], button\[data-queue-operation\], button\[data-ledger-file\], button\[data-row-action\]/, 'the example fence does not cover every write control')
  assert.match(view, /mountLedgerRowActions\(register, \{/, 'the row controls are not mounted on the register')
  assert.match(view, /mountLedgerFileBox\(fileSlot, \{/, 'the file box is not mounted in its slot')
  assert.match(view, /fetchLiveLedger\(\{ scope, removed: showRemoved \}\)/, 'the read does not carry the reach filter and the removed toggle')
  /* The Resolve picker now lives in this stretch too. Its copy inputs are
     supplied explicitly by rowBuilders and executed below, including the
     open branch the old extractor never reached. View-only helpers remain
     outside this markup boundary. */
  const start = view.indexOf('const STATE = {')
  const end = view.indexOf('export function ledgerView()')
  /* Comments may NAME the copy objects (a note saying which object `words`
     is); code may not reach for them. */
  const slice = view.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  for (const name of ['SCOPE_CHIP', 'PROPOSED_NOTE', 'REQUEST_PANEL', 'EMPTY_LIST', 'REMOVED_TOGGLE', 'CHAIN_NOTE', 'registerNotice', 'sampleLedgerData', 'mountLedger']) {
    assert.ok(!slice.includes(name), `the pure slice references ${name}, which the extractor does not inject`)
  }
  const { requestMarkup } = await rowBuilders()
  assertResolvePicker(requestMarkup)
  for (const name of BUILDER_COPY) {
    const incomplete = await rowBuilders({ omitCopy: [name] })
    assert.throws(() => assertResolvePicker(incomplete.requestMarkup), { name: 'ReferenceError', message: `${name} is not defined` },
      `omitting ${name} must fail on an actual builder call`)
  }
  for (const [needle, replacement] of [['data-resolve-submit', 'data-unused-submit'], ['data-resolve-status', 'data-unused-status']]) {
    const changed = await rowBuilders({ changeSource(source) {
      assert.ok(source.includes(needle), `the picker mutation must reach ${needle}`)
      return source.replaceAll(needle, replacement)
    } })
    assert.throws(() => assertResolvePicker(changed.requestMarkup), { code: 'ERR_ASSERTION' }, `${needle} must be checked on rendered markup`)
  }
})

test('the actual open Resolve row uses shared copy and keeps its controls separate from Hide and Edit', async () => {
  const { requestMarkup } = await rowBuilders()
  const id = 'R12'
  const closed = requestMarkup(LIVE_ROW, { actions: ACTIONS, copy: COPY })
  assert.equal(tagsWith(closed, 'data-resolve-slot')[0]?.attrs.has('hidden'), true)
  assert.equal(tagsWith(closed, 'data-resolve-status').length, 0)
  const opened = requestMarkup(LIVE_ROW, { actions: { ...ACTIONS, resolve: 'Resolve' }, copy: COPY, resolveOpen: true })
  assert.equal(nestedButtons(opened), 0)
  assert.equal(tagsWith(opened, 'data-hide')[0]?.attrs.get('data-hide'), `r:${id}`)
  assert.equal(tagsWith(opened, 'data-resolve-slot')[0]?.attrs.has('hidden'), false)
  // The engine's RESOLUTION_STATUSES includes in-progress; Delete is a
  // separate operation, so removed must never appear in this picker.
  assert.deepEqual(tagsWith(opened, 'data-resolve-status').map(tag => tag.attrs.get('value')),
    ['in-progress', 'partial', 'blocked-external', 'done', 'not-possible-as-asked', 'superseded'])
  assert.equal(tagsWith(opened, 'data-resolve-status').filter(tag => tag.attrs.has('checked')).length, 1)
  assert.equal(tagsWith(opened, 'data-resolve-status')[0]?.attrs.has('checked'), true)
  for (const attribute of ['data-resolve-submit', 'data-resolve-cancel']) {
    const controls = tagsWith(opened, attribute)
    assert.equal(controls.length, 1)
    assert.equal(controls[0].attrs.get('data-id'), id)
  }
  assert.equal(tagsWith(opened, 'data-row-editor')[0]?.attrs.has('hidden'), true)
})

/* ---------------------------------------------------------- hidden rows -- */

function fakeStorage() {
  const map = new Map()
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: key => { map.delete(key) },
    raw: map,
  }
}

test('createHiddenRows round-trips through storage, and a fresh instance on the same key sees the same set', () => {
  globalThis.localStorage = fakeStorage()
  try {
    const hidden = createHiddenRows('mc.ledger.hidden:live')
    assert.equal(hidden.count(), 0)
    assert.equal(hidden.add('r:R12'), true)
    assert.equal(hidden.add('q:Q7'), true)
    assert.equal(hidden.add('r:R12'), true, 'adding twice is still one row')
    assert.equal(hidden.has('r:R12'), true)
    assert.deepEqual(hidden.list(), ['r:R12', 'q:Q7'])
    assert.deepEqual(JSON.parse(globalThis.localStorage.getItem('mc.ledger.hidden:live')), { v: 1, ids: ['r:R12', 'q:Q7'] })
    /* The desktop re-mounts the page on every route change: a new instance
       over the same key must agree without any shared object. */
    assert.deepEqual(createHiddenRows('mc.ledger.hidden:live').list(), ['r:R12', 'q:Q7'])
    assert.equal(hidden.remove('r:R12'), true)
    assert.equal(hidden.remove('r:R12'), false)
    assert.deepEqual(hidden.list(), ['q:Q7'])
    hidden.clear()
    assert.equal(hidden.count(), 0)
    assert.equal(globalThis.localStorage.getItem('mc.ledger.hidden:live'), null, 'an empty set stores as absence')
  } finally {
    delete globalThis.localStorage
  }
})

test('damage reads as an empty set, never as an error, and the cap holds', () => {
  globalThis.localStorage = fakeStorage()
  try {
    for (const damaged of ['not json', '{"v":2,"ids":["r:R1"]}', '{"v":1,"ids":"r:R1"}', '[]', '{"v":1,"ids":[1,null,{}]}']) {
      globalThis.localStorage.setItem('k', damaged)
      const hidden = createHiddenRows('k')
      assert.deepEqual(hidden.list(), [], `damaged value was read as rows: ${damaged}`)
      assert.equal(hidden.has('r:R1'), false)
    }
    const hidden = createHiddenRows('k')
    hidden.clear()
    for (let index = 0; index < HIDDEN_ROWS_CAP; index += 1) assert.equal(hidden.add(`r:R${index}`), true)
    assert.equal(hidden.add('r:one-too-many'), false, 'the cap must refuse rather than grow without bound')
    assert.equal(hidden.count(), HIDDEN_ROWS_CAP)
    /* A machine-busy read is not damage and must not masquerade as the
       definite empty answer. A successful retry also proves that the failed
       result is neither cached nor latched. */
    let reads = 0
    const busy = Object.assign(new Error('too many open files'), { code: 'EMFILE' })
    globalThis.localStorage = {
      getItem() {
        reads += 1
        if (reads === 1) throw busy
        return JSON.stringify({ v: 1, ids: ['r:R1'] })
      },
    }
    const uncertain = createHiddenRows('k')
    assert.throws(
      () => uncertain.list(),
      error => error?.code === 'HIDDEN_ROWS_COULD_NOT_TELL'
        && /does not claim that no rows are hidden/.test(error.message)
        && error.cause === busy,
      'EMFILE must be an explicit could-not-tell result, not an empty hide list',
    )
    assert.deepEqual(uncertain.list(), ['r:R1'], 'the next call must retry storage after a transient failure')
    assert.equal(reads, 2, 'the successful retry controls against latching the failed read')
  } finally {
    delete globalThis.localStorage
  }
})

test('the live list and the example list never share an id', () => {
  globalThis.localStorage = fakeStorage()
  try {
    const live = createHiddenRows('mc.ledger.hidden:live')
    const example = createHiddenRows('mc.ledger.hidden:example')
    example.add('r:R1')
    assert.equal(live.has('r:R1'), false, 'an example R1 hid a real R1')
    live.add('r:R2')
    assert.equal(example.has('r:R2'), false)
    assert.deepEqual(live.list(), ['r:R2'])
    assert.deepEqual(example.list(), ['r:R1'])
  } finally {
    delete globalThis.localStorage
  }
  assert.throws(() => createHiddenRows(''), TypeError)
})

test('the view keys the set by the badge and the research queue by its own key', () => {
  const view = read('src/views/ledger.js')
  assert.match(view, /'mc\.ledger\.hidden:live'/)
  assert.match(view, /'mc\.ledger\.hidden:example'/)
  assert.match(view, /createHiddenRows\(badged \? HIDDEN_KEY_EXAMPLE : HIDDEN_KEY_LIVE\)/, 'the set must be re-bound where the badge is set')
  assert.match(view, /armOnce\(/, 'the × must go through the shared two-press helper')
  assert.match(view, /HIDE_ROW\.armed\(/, 'the first press must say what the second does')
  assert.doesNotMatch(view, /postBridgeAction|postAction/, 'hiding a row must never post anything')
})

/* ------------------------------------------------------------ arm press -- */

function fakeButton() {
  const attrs = new Map()
  return {
    dataset: {},
    isConnected: true,
    setAttribute: (name, value) => attrs.set(name, value),
    getAttribute: name => attrs.get(name) ?? null,
  }
}

test('armOnce is false on the first press, true on the second, and a lone press disarms', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const button = fakeButton()
  assert.equal(armOnce(button, { ms: 4000 }), false, 'the first press must arm, not act')
  assert.equal(button.dataset.armed, 'true')
  assert.equal(button.getAttribute('aria-pressed'), 'true')
  assert.equal(armOnce(button, { ms: 4000 }), true, 'the second press acts')
  assert.equal(button.dataset.armed, undefined, 'and leaves the control disarmed')
  assert.equal(button.getAttribute('aria-pressed'), 'false')

  const lone = fakeButton()
  let disarmed = 0
  assert.equal(armOnce(lone, { ms: 4000, onDisarm: () => { disarmed += 1 } }), false)
  t.mock.timers.tick(3999)
  assert.equal(lone.dataset.armed, 'true', 'still armed inside the window')
  t.mock.timers.tick(1)
  assert.equal(lone.dataset.armed, undefined, 'a lone press must disarm itself so the label never lies')
  assert.equal(disarmed, 1)
  /* After the disarm the next press is a first press again. */
  assert.equal(armOnce(lone, { ms: 4000 }), false)

  /* A control that left the page is not touched. */
  const gone = fakeButton()
  armOnce(gone, { ms: 10 })
  gone.isConnected = false
  t.mock.timers.tick(10)
  assert.equal(gone.dataset.armed, 'true')
  assert.equal(armOnce(null), false)
})
