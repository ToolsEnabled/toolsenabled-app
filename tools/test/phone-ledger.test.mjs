/* THE PHONE LEDGER, HELD TO ITS CONTRACT BEFORE ITS FIRST LINE LANDS.
 *
 * src/phone-ledger.js is being written in parallel with this suite, so every
 * behaviour test imports the module INSIDE its own body: while the module is
 * absent, each of those tests fails on its own with a message that names
 * src/phone-ledger.js, and none of them can take the rest of the run down
 * with it. The source sweeps state the module's licences the same way the
 * phone-canvas suite states its own:
 *
 *   1. one writer for the stored choice — only src/phone-ledger.js may call
 *      setItem on 'mc.phoneLedger';
 *   2. the ledger MOVES the page's own elements — it never clones a node and
 *      never re-authors markup through innerHTML;
 *   3. the ledger sheet does not know the phone-canvas attribute — that
 *      string is licensed to src/phone-canvas.css alone by the phone-canvas
 *      suite, restated here so a violation in the NEW sheet names the new
 *      file;
 *   4. every class the module builds is dressed by a stylesheet.
 *
 * This repository has no DOM in its node tests, so the mounted behaviour of
 * the ledger is deliberately NOT asserted — only the guard that keeps it off
 * every desktop. A gate that claims coverage it does not have is worse than
 * no gate.
 */

import { strict as assert } from 'node:assert'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createDocument } from './lib/dom-stand-in.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = path.join(REPO, 'src')
const MODULE = path.join(SRC, 'phone-ledger.js')
const SHEET = path.join(SRC, 'phone-ledger.css')

/* The module lands in parallel with this suite. Behaviour tests pull it in
   through this seam so its absence fails ONE test with a sentence that names
   the file, instead of crashing the whole run at import time. */
async function ledgerModule() {
  try {
    return await import('../../src/phone-ledger.js')
  } catch (error) {
    throw new Error(`src/phone-ledger.js is not importable yet: ${error.message}`)
  }
}

function readModuleSource() {
  assert.ok(existsSync(MODULE), 'src/phone-ledger.js does not exist yet — it lands in parallel with this suite')
  return readFileSync(MODULE, 'utf8')
}

function walkFiles(directory, suffix, found = []) {
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry)
    if (statSync(full).isDirectory()) {
      walkFiles(full, suffix, found)
      continue
    }
    if (full.endsWith(suffix)) found.push(full)
  }
  return found
}

/* Every quoted string in a source file, template literals included. Enough
   for a class census; nobody is parsing JavaScript here. */
function stringLiterals(source) {
  const literals = []
  const pattern = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g
  let match
  while ((match = pattern.exec(source)) !== null) {
    literals.push(match[1] ?? match[2] ?? match[3])
  }
  return literals
}

/* ==================================================================
   THE LICENCES, swept at source.
   ================================================================== */

test('only the ledger module writes the ledger setting', () => {
  /* A setItem call whose first argument is the literal or the constant. The
     stored choice has one writer, so the entry flag and any future settings
     switch can never disagree about who owns it. A file that merely READS the
     setting, or imports the constant, is not a writer and is not counted. */
  const writesTheSetting = /setItem\s*\(\s*(['"`]mc\.phoneLedger|PHONE_LEDGER_SETTING\s*,)/
  const writers = walkFiles(SRC, '.js')
    .filter(file => writesTheSetting.test(readFileSync(file, 'utf8')))
    .map(file => path.relative(REPO, file).replace(/\\/g, '/'))
  assert.deepEqual(writers, ['src/phone-ledger.js'],
    'src/phone-ledger.js must be the one and only writer of the stored ledger choice')
})

test('the ledger module moves elements, it never copies markup', () => {
  const source = readModuleSource()
  assert.ok(!source.includes('cloneNode'), 'a clone would be a second copy of the same facts')
  assert.ok(!source.includes('innerHTML'), 'the ledger must not re-author markup the page already built')
})

test('the ledger sheet does not know the phone-canvas attribute', () => {
  /* The phone-canvas suite licenses 'data-phone-canvas' to src/phone-canvas.css
     alone. Restated here for the new sheet, so the failure names the right
     file when the violation is the ledger's. */
  if (!existsSync(SHEET)) return
  assert.ok(!readFileSync(SHEET, 'utf8').includes('data-phone-canvas'),
    'src/phone-ledger.css must gate through its own classes, never the mode attribute')
})

test('every class the ledger builds exists in a stylesheet', () => {
  const source = readModuleSource()
  const sheets = [SHEET, path.join(SRC, 'phone-canvas.css')]
    .filter(file => existsSync(file))
    .map(file => readFileSync(file, 'utf8'))
    .join('\n')
  const built = new Set()
  for (const literal of stringLiterals(source)) {
    if (literal.includes('/') || /\.(m?js|css)$/.test(literal)) continue // a path, not a class
    if (literal.startsWith('--')) continue // a custom property, not a class
    /* An event name is namespaced with a colon ('mc:phone-ledger-changed'),
       which no class selector may contain. Without this the census read the
       module's own announcement as a class and demanded a stylesheet rule for
       it -- the same false positive the two lines above already exempt for
       paths and custom properties. Added 2026-08-27 with setPhoneLedgerChoice,
       the drawer's way out of the ledger. */
    if (literal.includes(':')) continue // an event name, not a class
    for (const name of literal.match(/phone-ledger[a-z-]*/g) || []) built.add(name)
  }
  const undressed = [...built]
    .filter(name => !new RegExp(`\\.${name}(?![a-z-])`).test(sheets))
  assert.deepEqual(undressed, [],
    'a class the module builds and no sheet dresses is a control nobody can see')
})

/* ==================================================================
   THE CONSTANTS.
   ================================================================== */

test('the setting, its choices, its default and its refusal code are the named ones', async () => {
  const mod = await ledgerModule()
  assert.equal(mod.PHONE_LEDGER_SETTING, 'mc.phoneLedger')
  assert.deepEqual([...mod.PHONE_LEDGER_CHOICES], ['auto', 'on', 'off'])
  assert.equal(mod.PHONE_LEDGER_DEFAULT_CHOICE, 'auto')
  assert.equal(mod.PHONE_LEDGER_COULD_NOT_TELL, 'PHONE_LEDGER_COULD_NOT_TELL')
})

/* ==================================================================
   THE DECISION, enumerated rather than argued.
   ================================================================== */

test('the ledger shows on a phone unless the person turned it off', async () => {
  const { phoneLedgerDecision, PHONE_LEDGER_CHOICES } = await ledgerModule()
  for (const choice of [...PHONE_LEDGER_CHOICES, undefined, null, '', 'ON', ' on']) {
    for (const canvasOn of [true, false, 1, 0, 'on', 'true', undefined, null, {}]) {
      /* Only a literal 'off' withholds it, and only a literal true canvas
         grants it. An unrecognised choice falls to the default, which is now
         'auto' meaning ON -- so ' on' and 'ON' behave as auto, not as off. */
      const expected = canvasOn === true && choice !== 'off'
      assert.equal(
        phoneLedgerDecision({ choice, canvasOn }),
        expected,
        `choice=${JSON.stringify(choice)} canvasOn=${JSON.stringify(canvasOn)} must be ${expected}`,
      )
    }
  }
})

/* THIS TEST USED TO PIN THE OPPOSITE, and the opposite was the defect.
 *
 * 'auto' meant off, so the only way to the ledger was following /app/?ledger=1
 * from the mobile page. Every person who typed the domain on a phone got the
 * canonical agent tree squeezed onto a phone instead -- the owner included,
 * looking at his own site, at the surface he had chosen and been told was
 * live. The design was built and shipped and sat behind a flag that no visible
 * control sets.
 *
 * The old reasoning was that a canonical surface "cannot change under anyone
 * who did not ask". That is right for an experiment and backwards for this:
 * the ledger IS the mobile surface. A default is a decision about what
 * everybody sees, and defaulting to the surface nobody designed for a phone
 * was the wrong one. */
test('auto means ON, because the ledger is the phone surface and not an experiment', async () => {
  const { phoneLedgerDecision } = await ledgerModule()
  assert.equal(phoneLedgerDecision({ choice: 'auto', canvasOn: true }), true,
    'a phone with no stored preference must get the ledger, not the tree')
  assert.equal(phoneLedgerDecision({ choice: 'off', canvasOn: true }), false,
    'off must still mean off -- the quick-settings control has to keep working')
  assert.equal(phoneLedgerDecision({ choice: 'auto', canvasOn: false }), false,
    'and it is still a phone surface: a desktop never gets it, whatever is stored')
})

/* ==================================================================
   READING THE CHOICE BACK.
   ================================================================== */

test('a stored choice is read back, and anything else is the default', async () => {
  const {
    readPhoneLedgerChoice, PHONE_LEDGER_CHOICES, PHONE_LEDGER_DEFAULT_CHOICE, PHONE_LEDGER_SETTING,
  } = await ledgerModule()
  const winWith = value => ({
    localStorage: { getItem: key => (key === PHONE_LEDGER_SETTING ? value : null) },
  })
  for (const choice of PHONE_LEDGER_CHOICES) {
    assert.equal(readPhoneLedgerChoice(winWith(choice)), choice, `stored ${choice} reads back as itself`)
  }
  for (const junk of [null, undefined, '', 'On', 'AUTO', 'banana', ' on', 42]) {
    assert.equal(readPhoneLedgerChoice(winWith(junk)), PHONE_LEDGER_DEFAULT_CHOICE,
      `stored ${JSON.stringify(junk)} is not a choice and must read as the default`)
  }
})

test('a throwing storage is could-not-tell, thrown as an Error and never latched', async () => {
  const { readPhoneLedgerChoice, PHONE_LEDGER_COULD_NOT_TELL } = await ledgerModule()
  let reads = 0
  const win = {
    localStorage: {
      getItem() {
        reads += 1
        if (reads === 1) throw Object.assign(new Error('private mode'), { code: 'EIO' })
        return 'on'
      },
    },
  }
  assert.throws(() => readPhoneLedgerChoice(win), error => {
    assert.ok(error instanceof Error, 'could-not-tell is an Error, not a bare object')
    assert.equal(error.code, PHONE_LEDGER_COULD_NOT_TELL)
    return true
  })
  assert.equal(readPhoneLedgerChoice(win), 'on',
    'a later call with working storage succeeds — could-not-tell must never be latched')
  assert.equal(reads, 2, 'the failed read is retried, not answered from a cache')
})

/* ==================================================================
   THE ENTRY FLAG.
   ================================================================== */

test('the entry flag writes on, once, and says so', async () => {
  const { adoptLedgerEntryFlag, PHONE_LEDGER_SETTING } = await ledgerModule()
  for (const search of ['?ledger=1', '?ledger=1&tab=fleet', '?tab=fleet&ledger=1', '?a=b&ledger=1&c=d']) {
    const written = []
    const win = {
      location: { search },
      localStorage: { setItem: (key, value) => { written.push([key, value]) } },
    }
    assert.equal(adoptLedgerEntryFlag(win), true, `${search} carries the flag`)
    assert.deepEqual(written, [[PHONE_LEDGER_SETTING, 'on']],
      `${search} must write exactly the one choice, once`)
  }
})

test('without the entry flag nothing is written at all', async () => {
  const { adoptLedgerEntryFlag } = await ledgerModule()
  for (const search of ['', '?', '?ledger=0', '?ledger=12', '?ledger=', '?ledger=1x', '?myledger=1', '?tab=ledger']) {
    const written = []
    const win = {
      location: { search },
      localStorage: { setItem: (key, value) => { written.push([key, value]) } },
    }
    assert.equal(adoptLedgerEntryFlag(win), false, `${JSON.stringify(search)} does not carry the flag`)
    assert.deepEqual(written, [], `${JSON.stringify(search)} wrote a setting nobody asked for`)
  }
})

test('a refused entry hint reports failure without consuming the hint and can be retried', async () => {
  let writes = 0
  let refuse = true
  let saved = 'off'
  const win = {
    location: { search: '?ledger=1' },
    localStorage: {
      setItem(key, value) {
        writes += 1
        if (refuse) throw Object.assign(new Error('quota'), { code: 'EDQUOT' })
        saved = value
      },
    },
  }
  const { adoptLedgerEntryFlag, PHONE_LEDGER_STORAGE_UNAVAILABLE } = await ledgerModule()
  assert.throws(() => adoptLedgerEntryFlag(win), { code: PHONE_LEDGER_STORAGE_UNAVAILABLE })
  assert.equal(saved, 'off')
  assert.equal(writes, 1)
  refuse = false
  assert.equal(adoptLedgerEntryFlag(win), true)
  assert.equal(saved, 'on')
  assert.equal(adoptLedgerEntryFlag(win), false, 'a remount must not reapply the entry hint')
  assert.equal(writes, 2)
})

test('an explicit choice survives repeated entry-hint remounts and a fresh window has its own hint', async () => {
  const { adoptLedgerEntryFlag, setPhoneLedgerChoice, readPhoneLedgerChoice, phoneLedgerDecision } = await ledgerModule()
  let saved = 'off', writes = 0
  const storage = { getItem: () => saved, setItem(key, value) { saved = value; writes++ } }
  const win = { location: { search: '?ledger=1' }, localStorage: storage }
  assert.equal(adoptLedgerEntryFlag(win), true)
  assert.equal(phoneLedgerDecision({ canvasOn: true, choice: readPhoneLedgerChoice(win) }), true)
  setPhoneLedgerChoice('off', win)
  for (let remount = 0; remount < 3; remount++) {
    assert.equal(adoptLedgerEntryFlag(win), false)
    assert.equal(phoneLedgerDecision({ canvasOn: true, choice: readPhoneLedgerChoice(win) }), false)
  }
  assert.equal(writes, 2)
  const freshWindow = { location: { search: '?ledger=1' }, localStorage: storage }
  assert.equal(adoptLedgerEntryFlag(freshWindow), true)
  assert.equal(saved, 'on')
  assert.equal(writes, 3)
})

test('missing or inaccessible storage cannot claim a saved choice or a successful entry hint', async () => {
  const { adoptLedgerEntryFlag, setPhoneLedgerChoice, PHONE_LEDGER_STORAGE_UNAVAILABLE } = await ledgerModule()
  for (const storage of [undefined, {}, { setItem() { throw new Error('quota') } }]) {
    const win = { location: { search: '?ledger=1' }, localStorage: storage }
    assert.throws(() => adoptLedgerEntryFlag(win), { code: PHONE_LEDGER_STORAGE_UNAVAILABLE })
    assert.throws(() => setPhoneLedgerChoice('off', win), { code: PHONE_LEDGER_STORAGE_UNAVAILABLE })
  }
  const refused = { location: { search: '?ledger=1' }, get localStorage() { throw new Error('access denied') } }
  assert.throws(() => adoptLedgerEntryFlag(refused), { code: PHONE_LEDGER_STORAGE_UNAVAILABLE })
  assert.throws(() => setPhoneLedgerChoice('off', refused), { code: PHONE_LEDGER_STORAGE_UNAVAILABLE })
})

/* ==================================================================
   THE ROW MODEL. Pure, ordered, fold-aware, and safe against corrupt trees.
   ================================================================== */

/* A row source shaped like the view's treeAgentRecord: only the fields the
   ledger reads are load-bearing; the rest ride along as they do in the real
   records built by src/views/computers.js. */
const agentRecord = (id, parentId = null, extra = {}) => ({
  id,
  name: `Agent ${id}`,
  role: 'default',
  parentId,
  state: 'enabled',
  ...extra,
})

test('rows come out parents before children, siblings in input order', async () => {
  const { ledgerRowModel } = await ledgerModule()
  const agents = [
    agentRecord('a'),
    agentRecord('b', 'a'),
    agentRecord('c', 'a'),
    agentRecord('d', 'b'),
    agentRecord('z'), // a second root, listed last, stays last
  ]
  const rows = ledgerRowModel({ agents, folded: new Set() })
  assert.deepEqual(rows.map(row => row.agent.id), ['a', 'b', 'd', 'c', 'z'],
    'depth-first: each parent directly above its own branch, input order within siblings')
  const byId = new Map(rows.map(row => [row.agent.id, row]))
  assert.equal(byId.get('a').depth, 0)
  assert.equal(byId.get('b').depth, 1)
  assert.equal(byId.get('d').depth, 2)
  assert.equal(byId.get('c').depth, 1)
  assert.equal(byId.get('z').depth, 0)
  assert.equal(byId.get('a').childCount, 2)
  assert.equal(byId.get('b').childCount, 1)
  assert.equal(byId.get('d').childCount, 0)
  assert.equal(byId.get('z').childCount, 0)
  for (const row of rows) {
    assert.equal(row.isFolded, false, `${row.agent.id} is not folded`)
    assert.equal(row.hiddenCount, 0, `${row.agent.id} hides nothing while unfolded`)
  }
})

test('a folded agent keeps its row and hides its whole branch, counted in descendants', async () => {
  const { ledgerRowModel } = await ledgerModule()
  const agents = [
    agentRecord('top'),
    agentRecord('b', 'top'),
    agentRecord('d', 'b'),
    agentRecord('e', 'd'),
    agentRecord('c', 'top'),
  ]
  const rows = ledgerRowModel({ agents, folded: new Set(['b']) })
  assert.deepEqual(rows.map(row => row.agent.id), ['top', 'b', 'c'],
    'the folded row stays; every descendant beneath it goes')
  const folded = rows.find(row => row.agent.id === 'b')
  assert.equal(folded.isFolded, true)
  assert.equal(folded.childCount, 1, 'childCount is the DIRECT children')
  assert.equal(folded.hiddenCount, 2, 'hiddenCount is every hidden DESCENDANT, not just the children')

  /* A fold recorded on an agent already inside a folded branch changes
     nothing a person can see. */
  const doubled = ledgerRowModel({ agents, folded: new Set(['b', 'd']) })
  assert.deepEqual(doubled.map(row => row.agent.id), ['top', 'b', 'c'])
  assert.equal(doubled.find(row => row.agent.id === 'b').hiddenCount, 2)

  /* Folding a leaf hides nobody. */
  const leafFold = ledgerRowModel({ agents, folded: new Set(['c']) })
  assert.deepEqual([...leafFold.map(row => row.agent.id)].sort(), ['b', 'c', 'd', 'e', 'top'],
    'a folded leaf still shows every agent')
  assert.equal(leafFold.find(row => row.agent.id === 'c').hiddenCount, 0)
})

test('a corrupt parent cycle neither hangs nor throws, and every honest agent still appears', async () => {
  const { ledgerRowModel } = await ledgerModule()
  const agents = [
    agentRecord('r'),
    agentRecord('c', 'r'),
    agentRecord('x', 'y'), // x and y point at each other
    agentRecord('y', 'x'),
    agentRecord('s', 's'), // and s points at itself
  ]
  const rows = ledgerRowModel({ agents, folded: new Set() }) // the call itself must terminate
  assert.ok(Array.isArray(rows), 'the model still answers with rows')
  const ids = rows.map(row => row.agent.id)
  assert.equal(new Set(ids).size, ids.length, 'no agent renders twice')
  const byId = new Map(rows.map(row => [row.agent.id, row]))
  assert.equal(byId.get('r').depth, 0, 'the honest root still renders')
  assert.equal(byId.get('c').depth, 1, 'the honest child still renders under it')
  for (const member of ['x', 'y', 's']) {
    const row = byId.get(member)
    if (row) assert.equal(row.depth, 0, `cycle member ${member} renders at depth 0 or not at all`)
  }
})

/* ==================================================================
   THE MOUNT GUARD. The only mounted behaviour a DOM-less test can hold.
   ================================================================== */

test('the mount refuses a missing root and an off-mode document', async () => {
  const { mountPhoneLedger } = await ledgerModule()
  const docWith = value => ({
    documentElement: {
      getAttribute: name => (name === 'data-phone-canvas' ? value : null),
    },
  })
  assert.equal(mountPhoneLedger({ root: null, doc: docWith('on') }), null, 'no root, no mount')
  assert.equal(mountPhoneLedger({ root: undefined, doc: docWith('on') }), null, 'an absent root is a missing root')
  const root = {}
  assert.equal(mountPhoneLedger({ root, doc: docWith(null) }), null, 'no mode attribute, no mount')
  assert.equal(mountPhoneLedger({ root, doc: docWith('off') }), null, 'the attribute must be exactly on')
  /* The full mounted behaviour needs a real phone document and is deliberately
     NOT asserted here — the pass report at the top of this file says why. */
})

/* ==================================================================
   ONE PIECE OF MOUNTED BEHAVIOUR THAT IS SMALL ENOUGH TO DRIVE HONESTLY.
   The file's own preface says there is no DOM in these node tests and the
   pass report is where anything needing a real phone document belongs. An
   add-row's click handler is not one of those: it is two calls
   (sheet.setSubject(null), then onPressAdd) against a DOM double narrow
   enough to build without borrowing a browser -- the same move
   tools/test/chat-surface-behaviors.test.mjs makes for buildChat and
   tools/test/phone-canvas.test.mjs makes for mountPhoneCanvas. Copied
   rather than shared, for the reason this file's own class-census helper
   above already gives.
   ================================================================== */

class FakeLedgerStyle {
  constructor() { this.props = {} }
  setProperty(name, value) { this.props[name] = value }
  removeProperty(name) { delete this.props[name] }
}
class FakeLedgerClassList {
  constructor(node) { this.node = node }
  values() { return String(this.node.className || '').split(/\s+/).filter(Boolean) }
  contains(name) { return this.values().includes(name) }
  add(...names) { this.node.className = [...new Set([...this.values(), ...names])].join(' ') }
  remove(...names) { this.node.className = this.values().filter(name => !names.includes(name)).join(' ') }
}
class FakeLedgerNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.parentNode = null
    this.attributes = new Map()
    this.listeners = new Map()
    this.className = ''
    this.hidden = false
    this.textContent = ''
    this.style = new FakeLedgerStyle()
    this.dataset = {}
    this.classList = new FakeLedgerClassList(this)
  }
  append(...nodes) { for (const node of nodes) { node.parentNode = this; this.children.push(node) } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes) }
  remove() {
    if (!this.parentNode) return
    const at = this.parentNode.children.indexOf(this)
    if (at >= 0) this.parentNode.children.splice(at, 1)
    this.parentNode = null
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)) }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null }
  removeAttribute(name) { this.attributes.delete(name) }
  addEventListener(type, fn) { const list = this.listeners.get(type) || []; list.push(fn); this.listeners.set(type, list) }
  dispatch(type, init = {}) {
    const event = { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, stopPropagation() {}, ...init }
    for (const fn of [...(this.listeners.get(type) || [])]) fn(event)
    return event
  }
  matches(selector) { return selector.startsWith('.') ? this.classList.contains(selector.slice(1)) : false }
  querySelectorAll(selector) {
    const found = []
    const walk = (node) => { for (const child of node.children) { if (child.matches(selector)) found.push(child); walk(child) } }
    walk(this)
    return found
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
}

/** A document that reads as phone-canvas-on (mountPhoneLedger's first gate)
    and an entry flag in the URL, so the ledger choice resolves 'on' without
    a localStorage round trip. */
function fakeLedgerMountDoc() {
  const documentElement = new FakeLedgerNode('html')
  documentElement.setAttribute('data-phone-canvas', 'on')
  const doc = { documentElement, createElement: (tag) => new FakeLedgerNode(tag) }
  doc.defaultView = { location: { search: '?ledger=1' }, localStorage: { setItem() {} } }
  return doc
}

/** The one element mountPhoneLedger's second gate requires: a
    `.graph-canvas-slot` for it to draw the ledger and its zoom into. */
function fakeLedgerMountRoot(doc) {
  const root = doc.createElement('div')
  root.className = 'computers'
  const slot = doc.createElement('div')
  slot.className = 'graph-canvas-slot'
  root.append(slot)
  return root
}

test('ordinary mobile entry mounts dropdown rows and preserves a saved graph choice', async () => {
  const { mountPhoneLedger } = await ledgerModule()
  for (const choice of [null, 'auto', 'on', 'off']) {
    const doc = fakeLedgerMountDoc()
    doc.defaultView = { location: { search: '' }, localStorage: { getItem: () => choice } }
    const root = fakeLedgerMountRoot(doc)
    const mounted = mountPhoneLedger({ root, doc, computerFn: () => ({ agents: [agentRecord('a1')] }), signedInFn: () => true })
    if (choice === 'off') {
      assert.equal(mounted, null)
      assert.equal(root.classList.contains('phone-ledger-mode'), false)
    } else {
      assert.ok(mounted)
      mounted.refresh()
      assert.equal(root.querySelectorAll('.phone-ledger-row').length, 1)
      mounted.destroy()
    }
  }
})

test('pressing an add-row clears the sheet subject before it opens the compose door', async () => {
  /* An empty slot has no agent to name -- src/phone-ledger.js says so at the
     add-row's own click handler, right above sheet?.setSubject?.(null). If
     that call is dropped, the sheet re-opens on whichever agent's row was
     pressed last, over a compose form that is not about it. */
  const { mountPhoneLedger } = await ledgerModule()
  const doc = fakeLedgerMountDoc()
  const root = fakeLedgerMountRoot(doc)
  const order = []
  const sheet = { setSubject: (next) => order.push(['setSubject', next]) }
  const agents = [agentRecord('a1')]
  const mounted = mountPhoneLedger({
    root,
    doc,
    computerFn: () => ({ agents }),
    extensionPointsFn: () => [{ kind: 'child', parentId: 'a1' }],
    onPressAdd: (next) => order.push(['onPressAdd', next]),
    sheet,
    /* This test is about the add-row's own press behaviour, not the routing
       law's sign-in gate — see phone-ledger-sign-in-gate.test.mjs for that.
       Signed in, so refresh() draws rows instead of the door. */
    signedInFn: () => true,
  })
  assert.ok(mounted, 'the ledger must mount: phone canvas on, a graph-canvas-slot present, the entry flag carrying the ledger choice')
  mounted.refresh()
  const addRow = root.querySelector('.phone-ledger-add')
  assert.ok(addRow, 'refresh must draw the add-row for the one extension point supplied')

  addRow.dispatch('click')

  assert.equal(order.length, 2, 'the press must reach both the sheet and the compose door, in order')
  assert.deepEqual(order[0], ['setSubject', null],
    'the sheet must be told to forget whichever agent was pressed last BEFORE the compose door opens')
  assert.deepEqual(order[1], ['onPressAdd', { kind: 'child', parentId: 'a1' }],
    'the compose door opens for the pressed family, after the subject is cleared')
})

test('add-rows land under their own family, deterministic in the rows’ order alone', async () => {
  /* Measured on a fresh profile (2026-08-27): the five add-rows clustered
     mid-list in scrambled order — "add an agent under Default 2" three rows
     ABOVE Default 2 — because insertion indexes were computed against the row
     model and applied to a list that had already been spliced. ledgerEntries
     is the one writer of the order now: every family reads parent, agents,
     add-row, whatever order the store hands its points in. */
  const { ledgerEntries, ledgerRowModel } = await ledgerModule()
  const agents = [
    agentRecord('coordinator'),
    agentRecord('manager', 'coordinator'),
    agentRecord('d1'),
    agentRecord('d2'),
    agentRecord('d3'),
  ]
  const rows = ledgerRowModel({ agents, folded: new Set() })
  /* The store's arrival order carries no meaning — this one is deliberately
     scrambled the way the fresh-profile run arrived. */
  const points = [
    { kind: 'child', parentId: 'manager' },
    { kind: 'child', parentId: 'coordinator' },
    { kind: 'child', parentId: 'd2' },
    { kind: 'child', parentId: 'd3' },
    { kind: 'child', parentId: 'd1' },
    { kind: 'root' },
  ]
  const shape = ledgerEntries({ rows, points }).map(entry =>
    entry.kind === 'agent' ? entry.row.agent.id
      : entry.kind === 'add' ? `+${entry.parentId}`
        : '+root')
  assert.deepEqual(shape, [
    'coordinator', 'manager', '+manager', '+coordinator',
    'd1', '+d1',
    'd2', '+d2',
    'd3', '+d3',
    '+root',
  ], 'each family must read parent, agents, add-row — with the deeper family’s offer closing first')

  /* Deterministic: a different arrival order changes nothing. */
  const reversed = ledgerEntries({ rows, points: [...points].reverse() }).map(entry =>
    entry.kind === 'agent' ? entry.row.agent.id : entry.kind === 'add' ? `+${entry.parentId}` : '+root')
  assert.deepEqual(reversed, shape, 'the points’ arrival order leaked into the ledger’s order')

  /* The offer carries its family's own indent and name. */
  const managerAdd = ledgerEntries({ rows, points }).find(entry => entry.kind === 'add' && entry.parentId === 'manager')
  assert.equal(managerAdd.depth, 2, 'an add-row must sit one step under its parent')
  assert.equal(managerAdd.parentName, 'Agent manager')
})

test('a folded family takes its offers with it; no root point, no root row', async () => {
  const { ledgerEntries, ledgerRowModel } = await ledgerModule()
  const agents = [
    agentRecord('coordinator'),
    agentRecord('manager', 'coordinator'),
    agentRecord('solo'),
  ]
  const points = [
    { kind: 'child', parentId: 'coordinator' },
    { kind: 'child', parentId: 'manager' },
    { kind: 'child', parentId: 'solo' },
  ]
  const folded = ledgerRowModel({ agents, folded: new Set(['coordinator']) })
  const shape = ledgerEntries({ rows: folded, points }).map(entry =>
    entry.kind === 'agent' ? entry.row.agent.id : `+${entry.parentId}`)
  assert.deepEqual(shape, ['coordinator', 'solo', '+solo'],
    'a folded head must hide its own offer and its buried children’s — exactly what the fold press-check verified')
  assert.ok(!ledgerEntries({ rows: folded, points }).some(entry => entry.kind === 'add-root'),
    'a root offer appeared without a root point')
})

/* ==================================================================
   THE WAY BACK OUT. Added 2026-08-27 with the quick-settings row that offers
   it: until this existed the entry flag was the ONLY writer of the stored
   choice, so a phone that followed /app/?ledger=1 could never return to the
   canonical graph — nothing in the shipped product could store 'off'.
   ================================================================== */

test('a choice is stored, announced, and answered back', async () => {
  const { setPhoneLedgerChoice, PHONE_LEDGER_SETTING, PHONE_LEDGER_EVENT, PHONE_LEDGER_CHOICES } = await ledgerModule()
  for (const choice of PHONE_LEDGER_CHOICES) {
    const written = []
    const heard = []
    const win = {
      localStorage: { setItem: (key, value) => { written.push([key, value]) } },
      CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail } },
      dispatchEvent: (event) => { heard.push([event.type, event.detail?.choice]) },
    }
    assert.equal(setPhoneLedgerChoice(choice, win), choice, `${choice} must be answered back as stored`)
    assert.deepEqual(written, [[PHONE_LEDGER_SETTING, choice]], `${choice} must be written once, under the one key`)
    assert.deepEqual(heard, [[PHONE_LEDGER_EVENT, choice]],
      `${choice} must be announced, or the page that read the decision once never redraws`)
  }
})

test('an unrecognised choice writes nothing, announces nothing, and says so', async () => {
  const { setPhoneLedgerChoice } = await ledgerModule()
  for (const junk of ['ON', 'rows', '', null, undefined, 1, {}, ' on']) {
    const written = []
    const heard = []
    const win = {
      localStorage: { setItem: (key, value) => { written.push([key, value]) } },
      CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail } },
      dispatchEvent: (event) => { heard.push(event.type) },
    }
    assert.equal(setPhoneLedgerChoice(junk, win), null, `${JSON.stringify(junk)} is not a choice and must be refused`)
    assert.deepEqual(written, [], `${JSON.stringify(junk)} reached storage`)
    assert.deepEqual(heard, [], `${JSON.stringify(junk)} was announced as though it had been applied`)
  }
})

test('a refused choice does not announce or replace the saved view, and retry announces after persistence', async () => {
  const { setPhoneLedgerChoice, PHONE_LEDGER_EVENT, PHONE_LEDGER_STORAGE_UNAVAILABLE } = await ledgerModule()
  let writes = 0
  let refuse = true
  let saved = 'on'
  const heard = []
  const win = {
    localStorage: { setItem(key, value) { writes += 1; if (refuse) throw Object.assign(new Error('quota'), { code: 'EDQUOT' }); saved = value } },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail } },
    dispatchEvent: (event) => { heard.push([event.type, saved]) },
  }
  assert.throws(() => setPhoneLedgerChoice('off', win), { code: PHONE_LEDGER_STORAGE_UNAVAILABLE })
  assert.equal(saved, 'on')
  assert.equal(writes, 1)
  assert.deepEqual(heard, [])
  refuse = false
  assert.equal(setPhoneLedgerChoice('off', win), 'off')
  assert.equal(saved, 'off')
  assert.equal(writes, 2)
  assert.deepEqual(heard, [[PHONE_LEDGER_EVENT, 'off']], 'the redraw reads the successfully saved choice')
})

test('a window with no event machinery is not a crash', async () => {
  /* The renderer always has CustomEvent; a caller that does not is a test or a
     shell, and neither is a reason for a setting write to throw. */
  const { setPhoneLedgerChoice, PHONE_LEDGER_SETTING } = await ledgerModule()
  const written = []
  assert.equal(setPhoneLedgerChoice('on', { localStorage: { setItem: (k, v) => written.push([k, v]) } }), 'on')
  assert.deepEqual(written, [[PHONE_LEDGER_SETTING, 'on']])
  assert.throws(() => setPhoneLedgerChoice('on', null), { code: 'PHONE_LEDGER_STORAGE_UNAVAILABLE' })
})

test('failed entry adoption leaves the saved graph visible with a readable warning and clears after an explicit retry', async () => {
  const { mountPhoneLedger, setPhoneLedgerChoice } = await ledgerModule()
  const doc = createDocument()
  doc.documentElement.setAttribute('data-phone-canvas', 'on')
  let saved = 'off', refuse = true
  doc.defaultView = { location: { search: '?ledger=1' }, localStorage: { getItem: () => saved, setItem(key, value) { if (refuse) throw new Error('quota'); saved = value } } }
  const root = doc.createElement('div'), slot = doc.createElement('div')
  slot.className = 'graph-canvas-slot'; root.append(slot)
  assert.equal(mountPhoneLedger({ root, doc }), null)
  assert.equal(saved, 'off')
  assert.equal(root.classList.contains('phone-ledger-mode'), false)
  assert.match(root.querySelector('.phone-ledger-entry-error').textContent, /could not be saved.*quick settings/)
  refuse = false
  setPhoneLedgerChoice('off', doc.defaultView)
  assert.equal(mountPhoneLedger({ root, doc }), null)
  assert.equal(saved, 'off', 'the still-present URL hint must not overwrite an explicit Graph retry')
  assert.equal(root.querySelector('.phone-ledger-entry-error'), null)
})

test('the page that reads the decision once is told to read it again', async () => {
  /* src/views/computers.js asks phoneLedgerDecision while it BUILDS, so a
     choice stored afterwards is inert until something re-renders. src/main.js
     owns render(); this pins that it listens, closes the drawer covering the
     answer, and re-renders — the same shape the checkout probe's listener has. */
  const main = readFileSync(path.join(REPO, 'src', 'main.js'), 'utf8')
  assert.match(main, /import \{ PHONE_LEDGER_EVENT \} from '\.\/phone-ledger\.js'/,
    'main.js does not know the announcement, so the choice would change nothing until the next launch')
  const listener = /window\.addEventListener\(PHONE_LEDGER_EVENT, \(\) => \{([\s\S]*?)\n\}\)/.exec(main)
  assert.ok(listener, 'main.js has no listener for the ledger choice')
  assert.match(listener[1], /closeDrawer\(\)/,
    'the drawer covers 320 of a 390px phone; leaving it open hides the very change that was just made')
  assert.match(listener[1], /render\(\)/, 'nothing redraws the page the setting is about')
})

test('search reveals a matching descendant with its ancestors and preserves the source records', async () => {
  const { ledgerSearchModel, ledgerRowModel } = await ledgerModule()
  const agents = [{ id: 'root', name: 'Coordinator', role: 'coordinator' }, { id: 'child', parentId: 'root', name: 'Review release', role: 'default' }, { id: 'other', name: 'Writer', role: 'default' }]
  const folded = new Set(['root'])
  const found = ledgerSearchModel({ agents, query: ' REVIEW ' })
  assert.deepEqual(found.agents.map(agent => agent.id), ['root', 'child'])
  assert.equal(found.matches, 1)
  assert.equal(found.searching, true)
  assert.equal(found.agents[1], agents[1])
  assert.deepEqual(ledgerRowModel({ agents, folded }).map(row => row.agent.id), ['root', 'other'])
  assert.deepEqual(ledgerSearchModel({ agents, query: '' }).agents, agents)
  assert.equal(ledgerSearchModel({ agents, query: 'missing' }).matches, 0)
})

test('search matches role labels and terminates on malformed cyclic families', async () => {
  const { ledgerSearchModel } = await ledgerModule()
  const agents = [{ id: 'a', parentId: 'b', name: 'First', role: 'coordinator' }, { id: 'b', parentId: 'a', name: 'Second', role: 'default' }, { id: 'a', name: 'duplicate' }, null]
  const found = ledgerSearchModel({ agents, query: 'coordinator' })
  assert.deepEqual(found.agents.map(agent => agent.id), ['a', 'b'])
  assert.equal(found.matches, 1)
})
