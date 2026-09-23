/* The phone entrance requires sign-in for real data. Only an explicitly
 * chosen example with a resolved mock source can open without an account. */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = path.join(REPO, 'src')
const MODULE_PATH = path.join(SRC, 'phone-ledger.js')
const PHONE_CANVAS_CSS_PATH = path.join(SRC, 'phone-canvas.css')

async function ledgerModule() {
  try {
    return await import('../../src/phone-ledger.js')
  } catch (error) {
    throw new Error(`src/phone-ledger.js is not importable yet: ${error.message}`)
  }
}

/* ==================================================================
   THE PURE GATE.
   ================================================================== */

test('phoneLedgerNeedsSignIn: a positive sign-in opens real fleet data', async () => {
  const { phoneLedgerNeedsSignIn } = await ledgerModule()
  assert.equal(phoneLedgerNeedsSignIn({ signedIn: true }), false, 'a real, positive signedIn:true must open the ledger')
})

test('phoneLedgerNeedsSignIn: every other shape fails closed to the door', async () => {
  const { phoneLedgerNeedsSignIn } = await ledgerModule()
  const cases = [
    [{ signedIn: false }, 'an explicit false'],
    [{}, 'an absent field'],
    [{ signedIn: undefined }, 'an explicit undefined'],
    [{ signedIn: null }, 'null'],
    [{ signedIn: 'true' }, 'the STRING "true", truthy but not the literal boolean'],
    [{ signedIn: 1 }, 'the number 1, truthy but not the literal boolean'],
    [undefined, 'no argument at all'],
  ]
  for (const [input, label] of cases) {
    assert.equal(phoneLedgerNeedsSignIn(input), true, `${label} must still show the door -- fail CLOSED, never truthy-open`)
  }
})

test('phoneLedgerNeedsSignIn is a property of the ledger surface, not of how it was entered', async () => {
  const { phoneLedgerNeedsSignIn } = await ledgerModule()
  /* No ledgerRoute field is read at all -- the function's only parameter is
     signedIn. A future settings control that writes choice='on' and turns
     the canvas on some other way must not get a free pass around sign-in
     just because it did not arrive via ?ledger=1. */
  assert.equal(phoneLedgerNeedsSignIn({ signedIn: false, ledgerRoute: true }), true)
  assert.equal(phoneLedgerNeedsSignIn({ signedIn: true, ledgerRoute: false }), false)
})

/* ==================================================================
   THE MOUNTED DOOR. Same small DOM double tools/test/phone-ledger.test.mjs
   builds for its own one mounted test, copied rather than imported for the
   reason that file's own preface gives: a suite that imports its subject's
   test double can be made to pass by editing the double.
   ================================================================== */

class FakeNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.parentNode = null
    this.attributes = new Map()
    this.listeners = new Map()
    this.className = ''
    this.hidden = false
    this.textContent = ''
    this.href = ''
    this.style = { setProperty() {}, removeProperty() {} }
    this.dataset = {}
    const node = this
    this.classList = {
      values: () => String(node.className || '').split(/\s+/).filter(Boolean),
      contains(name) { return this.values().includes(name) },
      add(...names) { node.className = [...new Set([...this.values(), ...names])].join(' ') },
      remove(...names) { node.className = this.values().filter(n => !names.includes(n)).join(' ') },
    }
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
  matches(selector) { return selector.startsWith('.') ? this.classList.contains(selector.slice(1)) : false }
  querySelectorAll(selector) {
    const found = []
    const walk = (node) => { for (const child of node.children) { if (child.matches(selector)) found.push(child); walk(child) } }
    walk(this)
    return found
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
}

function fakeDoc() {
  const documentElement = new FakeNode('html')
  documentElement.setAttribute('data-phone-canvas', 'on')
  const doc = { documentElement, createElement: (tag) => new FakeNode(tag) }
  doc.defaultView = { location: { search: '?ledger=1' }, localStorage: { setItem() {} } }
  return doc
}

function fakeRoot(doc) {
  const root = doc.createElement('div')
  root.className = 'computers'
  const slot = doc.createElement('div')
  slot.className = 'graph-canvas-slot'
  root.append(slot)
  return root
}

const agentRecord = (id) => ({ id, name: `Agent ${id}`, role: 'default', parentId: null, state: 'enabled' })

test('signed out: refresh() draws the door, not the rows, and hides the zoom and Details controls', async () => {
  const { mountPhoneLedger } = await ledgerModule()
  const doc = fakeDoc()
  const root = fakeRoot(doc)
  const opener = doc.createElement('button')
  opener.className = 'phone-sheet-open'
  root.append(opener)
  const mounted = mountPhoneLedger({
    root,
    doc,
    computerFn: () => ({ agents: [agentRecord('a1')] }),
    signedInFn: () => false,
  })
  assert.ok(mounted, 'the ledger must still mount -- the door is drawn BY the ledger, not instead of mounting it')
  assert.ok(root.classList.contains('phone-ledger-auth-required'), 'sample chrome is hidden before the account read')
  mounted.refresh()
  assert.ok(root.classList.contains('phone-ledger-auth-required'), 'the whole fleet surface remains gated while signed out')

  assert.equal(root.querySelectorAll('.phone-ledger-row').length, 0, 'no agent row may be drawn while signed out')
  assert.equal(root.querySelectorAll('.phone-ledger-add').length, 0, 'no add-row may be drawn while signed out')
  const door = root.querySelector('.phone-ledger-door')
  assert.ok(door, 'the sign-in door must be drawn in the ledger list')

  const zoom = root.querySelector('.phone-ledger-zoom')
  assert.ok(zoom, 'the zoom cluster must still exist (built at mount, unconditionally)')
  assert.equal(zoom.hidden, true, 'the zoom cluster must be hidden while the door is up -- there is nothing to zoom into')
  assert.equal(opener.hidden, true, 'the Details opener must be hidden while the door is up -- there is no agent to open')
})

test('signed out: the hidden zoom cluster is actually removed from the rendered canvas', () => {
  /* `.phone-ledger-zoom` needs `display:flex` while it is usable, which is an
     author rule and therefore beats the browser's default `hidden` styling.
     The mounted behaviour test above correctly sees zoom.hidden=true either
     way; this source pin prevents that DOM state from leaving a visibly
     clipped zoom cluster below the sign-in door. */
  const css = readFileSync(PHONE_CANVAS_CSS_PATH, 'utf8')
  assert.match(css,
    /\[data-phone-canvas="on"\]\s+\.computers\.phone-ledger-mode\s+\.phone-ledger-zoom\[hidden\]\s*\{\s*display:\s*none;/,
    'the phone ledger must explicitly remove its hidden zoom cluster from layout')
})

test('signed out: the door is house mark, one sentence, sign in -- nothing else', async () => {
  const { mountPhoneLedger } = await ledgerModule()
  const doc = fakeDoc()
  const root = fakeRoot(doc)
  const mounted = mountPhoneLedger({ root, doc, computerFn: () => ({ agents: [] }), signedInFn: () => false })
  mounted.refresh()

  const door = root.querySelector('.phone-ledger-door')
  assert.equal(door.children.length, 3, 'house mark, one sentence, sign in -- nothing else means exactly three children')

  const mark = root.querySelector('.phone-ledger-door-mark')
  assert.ok(mark, 'the house mark must be present')
  assert.equal(mark.tagName, 'A', 'the product mark is a real Home link')
  assert.equal(mark.href, '#/', 'Home is the same in-app destination as the desktop brand')
  assert.equal(mark.tabIndex, 0, 'keyboard users can reach Home in WebKit too')
  assert.equal(mark.getAttribute('aria-label'), 'ToolsEnabled — Home')
  assert.equal(mark.textContent, 'ToolsEnabled', 'the house mark is the product name -- this product has no logo asset, so text is the existing convention, not an invention')

  const sentence = root.querySelector('.phone-ledger-door-sentence')
  assert.ok(sentence, 'the one sentence must be present')
  assert.equal(typeof sentence.textContent, 'string')
  assert.ok(sentence.textContent.length > 0, 'the sentence must say something')
  assert.equal((sentence.textContent.match(/\./g) || []).length <= 1, true, 'one sentence means one full stop at most')

  const signIn = root.querySelector('.phone-ledger-door-signin')
  assert.ok(signIn, 'the sign-in control must be present')
  assert.equal(signIn.tagName, 'A', 'sign in is a link, not a form -- see the module for why a local username/password form is the wrong surface here')
  assert.equal(signIn.href, '/signin/', "sign in must point at the app's own real sign-in page, not an invented endpoint")
  assert.ok(signIn.classList.contains('ctl-btn'), 'sign in reuses the product\'s own action-button class rather than inventing a new button style')
  assert.equal(signIn.textContent, 'Sign in')
})

test('signed in: refresh() draws the rows, not the door, and shows the zoom and Details controls', async () => {
  const { mountPhoneLedger } = await ledgerModule()
  const doc = fakeDoc()
  const root = fakeRoot(doc)
  const opener = doc.createElement('button')
  opener.className = 'phone-sheet-open'
  root.append(opener)
  const mounted = mountPhoneLedger({
    root,
    doc,
    computerFn: () => ({ agents: [agentRecord('a1')] }),
    signedInFn: () => true,
  })
  mounted.refresh()

  assert.equal(root.querySelectorAll('.phone-ledger-row').length, 1, 'signed in must draw the real row')
  assert.equal(root.querySelector('.phone-ledger-door'), null, 'the door must not be drawn while signed in')
  assert.equal(root.querySelector('.phone-ledger-zoom').hidden, false, 'the zoom cluster must be visible while signed in')
  assert.equal(opener.hidden, false, 'the Details opener must be visible while signed in')
})

test('no signedInFn at all fails closed to the door -- the same direction an absent bridge takes everywhere else in this product', async () => {
  const { mountPhoneLedger } = await ledgerModule()
  const doc = fakeDoc()
  const root = fakeRoot(doc)
  const mounted = mountPhoneLedger({ root, doc, computerFn: () => ({ agents: [agentRecord('a1')] }) })
  mounted.refresh()
  assert.equal(root.querySelectorAll('.phone-ledger-row').length, 0, 'an unspecified signedInFn must never be read as "signed in"')
  assert.ok(root.querySelector('.phone-ledger-door'), 'an unspecified signedInFn must show the door')
})

test('sign-out mid-session drops straight to the door on the next refresh, without a re-mount', async () => {
  const { mountPhoneLedger } = await ledgerModule()
  const doc = fakeDoc()
  const root = fakeRoot(doc)
  let signedIn = true
  const mounted = mountPhoneLedger({
    root,
    doc,
    computerFn: () => ({ agents: [agentRecord('a1')] }),
    signedInFn: () => signedIn,
  })
  mounted.refresh()
  assert.equal(root.querySelectorAll('.phone-ledger-row').length, 1, 'starts signed in, drawing the row')

  signedIn = false
  mounted.refresh()
  assert.equal(root.querySelectorAll('.phone-ledger-row').length, 0, 'a refresh after sign-out must not still draw the old row')
  assert.ok(root.querySelector('.phone-ledger-door'), 'a refresh after sign-out must draw the door')
})

test('anonymous refreshes preserve the mounted Sign in link without detaching it', async () => {
  const { mountPhoneLedger } = await ledgerModule()
  const doc = fakeDoc()
  const root = fakeRoot(doc)
  let signedIn = false
  let authReads = 0
  const mounted = mountPhoneLedger({
    root,
    doc,
    signedInFn: () => { authReads++; return signedIn },
    computerFn: () => { assert.fail('an anonymous refresh must not read computer data') },
    extensionPointsFn: () => { assert.fail('an anonymous refresh must not read extension data') },
  })
  mounted.refresh()
  const door = root.querySelector('.phone-ledger-door')
  const signIn = root.querySelector('.phone-ledger-door-signin')
  const list = door.parentNode
  let replacements = 0
  const replaceChildren = list.replaceChildren.bind(list)
  list.replaceChildren = (...nodes) => { replacements++; replaceChildren(...nodes) }

  for (const value of [false, undefined, null, 'true', 1, false]) {
    signedIn = value
    const before = authReads
    mounted.refresh()
    assert.equal(authReads, before + 1, 'keeping the door must not cache the authentication decision')
    assert.equal(root.querySelector('.phone-ledger-door'), door, 'a repeated anonymous refresh must keep the same door')
    assert.equal(root.querySelector('.phone-ledger-door-signin'), signIn, 'focus and an in-progress press belong to the existing link')
    assert.equal(replacements, 0, 'even re-inserting the same node would detach the active link')
  }
  mounted.destroy()
})

test('every fresh non-true auth result immediately clears signed-in rows without reading gated data', async () => {
  const { mountPhoneLedger } = await ledgerModule()
  const doc = fakeDoc()
  const root = fakeRoot(doc)
  const opener = doc.createElement('button')
  opener.className = 'phone-sheet-open'
  root.append(opener)
  let signedIn = false
  let authReads = 0
  let computerReads = 0
  let extensionReads = 0
  const mounted = mountPhoneLedger({
    root,
    doc,
    signedInFn: () => { authReads++; return signedIn },
    computerFn: () => {
      assert.equal(signedIn, true, 'computer data is only read after a positive auth decision')
      computerReads++
      return { agents: [agentRecord('a1')] }
    },
    extensionPointsFn: () => {
      assert.equal(signedIn, true, 'extension data is only read after a positive auth decision')
      extensionReads++
      return []
    },
  })
  mounted.refresh()
  for (const value of [false, undefined, null, 'true', 1]) {
    signedIn = true
    const beforeAuth = authReads
    mounted.refresh()
    assert.equal(authReads, beforeAuth + 1)
    assert.equal(root.querySelectorAll('.phone-ledger-row').length, 1, 'a new positive auth decision still draws the signed-in rows')
    assert.equal(root.querySelector('.phone-ledger-door'), null)
    assert.equal(root.querySelector('.phone-ledger-zoom').hidden, false)
    assert.equal(opener.hidden, false)

    signedIn = value
    const beforeComputer = computerReads
    const beforeExtensions = extensionReads
    mounted.refresh()
    assert.equal(authReads, beforeAuth + 2, 'auth must be read again before retaining any signed-in content')
    assert.equal(computerReads, beforeComputer)
    assert.equal(extensionReads, beforeExtensions)
    assert.equal(root.querySelectorAll('.phone-ledger-row').length, 0, 'false or unknown auth removes the old row synchronously')
    assert.equal(root.querySelectorAll('.phone-ledger-add').length, 0)
    assert.equal(root.querySelectorAll('.phone-ledger-door').length, 1)
    assert.equal(root.querySelector('.phone-ledger-zoom').hidden, true)
    assert.equal(opener.hidden, true)
  }
  mounted.destroy()
})

/* ==================================================================
   SOURCE-LEVEL PIN, not just a behavioural one (coordinator completeness
   convention, see tools/test/phone-canvas-ledger-override.test.mjs's own
   copy of this pin): the tests above prove refresh() behaves correctly for
   the inputs they happened to choose. This pins the actual mechanism, so a
   change that swapped in a different-looking but coincidentally-similar
   check (or read the wrong field, or called the right function but ignored
   its answer) cannot pass by accident.
   ================================================================== */
test('refresh() actually calls phoneLedgerNeedsSignIn and acts on its answer, as source', () => {
  const source = readFileSync(MODULE_PATH, 'utf8')
  const refreshBody = source.slice(source.indexOf('const refresh = () => {'), source.indexOf('heading.hidden = false', source.indexOf('const refresh = () => {')))
  assert.match(refreshBody, /phoneLedgerNeedsSignIn\(\s*\{\s*signedIn\s*:/,
    'refresh() no longer calls phoneLedgerNeedsSignIn near its own top -- the gate may have been bypassed or moved somewhere unreachable')
  assert.match(refreshBody, /typeof signedInFn === 'function' \? signedInFn\(\) : undefined/,
    'refresh() no longer reads signedInFn defensively -- an absent signedInFn must resolve to "not signed in", not throw and not silently pass a function reference where a boolean was expected')
  assert.match(refreshBody, /buildSignInDoor\(doc, \{ onExploreDemo \}\)/, 'the signed-out entrance must remain separate from fleet rows')
})

test('demo exploration requires an explicit choice and reports a failed preference write',async()=>{
  const {buildSignInDoor}=await ledgerModule();let calls=0;
  const door=buildSignInDoor(fakeDoc(),{onExploreDemo:()=>{calls++;throw new Error('Storage unavailable');}});
  assert.equal(calls,0,'displaying the sign-in entrance must not choose simulation');
  const demo=door.querySelector('.phone-ledger-door-demo');
  demo.listeners.get('click')[0]();
  assert.equal(calls,1);
  assert.match(door.querySelector('.phone-ledger-door-error').textContent,/could not be saved/);
  assert.equal(door.querySelector('.phone-ledger-door-signin').href,'/signin/');
});


test('only an explicitly chosen mock source opens the signed-out demo', async () => {
  const { phoneLedgerNeedsSignIn } = await ledgerModule()
  assert.equal(phoneLedgerNeedsSignIn({ signedIn: false, source: 'mock', exampleChosen: true }), false)
  for (const source of [undefined, null, 'relay', 'local']) {
    assert.equal(phoneLedgerNeedsSignIn({ signedIn: false, source, exampleChosen: true }), true)
  }
  for (const exampleChosen of [undefined, null, false, 1, 'true']) {
    assert.equal(phoneLedgerNeedsSignIn({ signedIn: false, source: 'mock', exampleChosen }), true)
  }
})

test('the signed-out demo closes when the example is disabled or records become real', async () => {
  const { mountPhoneLedger } = await ledgerModule()
  const doc = fakeDoc(), root = fakeRoot(doc)
  let source = 'mock', exampleChosen = true
  const mounted = mountPhoneLedger({root, doc, computerFn: () => ({agents: [agentRecord('example')]}),
    signedInFn: () => false, sourceFn: () => source, exampleChosenFn: () => exampleChosen})
  mounted.refresh()
  assert.equal(root.querySelectorAll('.phone-ledger-row').length, 1)
  exampleChosen = false; mounted.refresh()
  assert.ok(root.querySelector('.phone-ledger-door'))
  assert.equal(root.querySelectorAll('.phone-ledger-row').length, 0)
  exampleChosen = true; source = 'relay'; mounted.refresh()
  assert.ok(root.querySelector('.phone-ledger-door'))
  assert.equal(root.querySelectorAll('.phone-ledger-row').length, 0)
  mounted.destroy()
})
