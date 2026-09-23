/* The home VIEW, through the same CSS import hook the other view tests use.
 *
 * These are deliberately observations of the constructed DOM.  In particular,
 * none of the assertions below inspect home.js: an unloadable view, a branch
 * inversion, or a value discarded between the readers and the DOM must fail.
 */
import assert from 'node:assert/strict'
import { register } from 'node:module'
import test from 'node:test'
import { readFileSync } from 'node:fs'

register('./helpers/css-stub-loader.mjs', import.meta.url)

class Classes {
  constructor(node) { this.node = node }
  names() { return this.node.className.split(/\s+/).filter(Boolean) }
  contains(name) { return this.names().includes(name) }
  add(...names) { this.node.className = [...new Set([...this.names(), ...names])].join(' ') }
  remove(...names) { this.node.className = this.names().filter(name => !names.includes(name)).join(' ') }
  toggle(name, force) { const on = force ?? !this.contains(name); on ? this.add(name) : this.remove(name); return on }
}

class FakeElement {
  constructor(documentRef, tagName = 'div') {
    this.ownerDocument = documentRef
    this.tagName = tagName.toUpperCase()
    this.children = []
    this.parentNode = null
    this.attributes = new Map()
    this.dataset = {}
    const styleProperties = new Map()
    this.style = {
      setProperty(name, value) { styleProperties.set(String(name), String(value)) },
      getPropertyValue(name) { return styleProperties.get(String(name)) ?? '' },
      removeProperty(name) {
        const previous = this.getPropertyValue(name)
        styleProperties.delete(String(name))
        return previous
      },
      background: '',
    }
    this.className = ''
    this.classList = new Classes(this)
    this.hidden = false
    this.disabled = false
    this.listeners = new Map()
    this._text = ''
  }
  get firstElementChild() { return this.children[0] || null }
  get lastElementChild() { return this.children.at(-1) || null }
  get isConnected() { return this.parentNode ? this.parentNode.isConnected !== false : false }
  get textContent() { return this._text + this.children.map(child => child.textContent).join('') }
  set textContent(value) { for (const child of this.children) child.parentNode = null; this.children = []; this._text = String(value) }
  set innerHTML(value) { this.replaceChildren(...parse(this.ownerDocument, String(value))) }
  append(...nodes) { for (const node of nodes) { if (typeof node === 'string') this._text += node; else { node.parentNode = this; this.children.push(node) } } }
  appendChild(node) { this.append(node); return node }
  insertBefore(node, before) { const at = this.children.indexOf(before); if (at < 0) return this.appendChild(node); node.parentNode = this; this.children.splice(at, 0, node); return node }
  insertAdjacentElement(position, node) { if (position !== 'afterend' || !this.parentNode) throw new Error(`unsupported insertion: ${position}`); const at = this.parentNode.children.indexOf(this); node.parentNode = this.parentNode; this.parentNode.children.splice(at + 1, 0, node); return node }
  replaceChildren(...nodes) { for (const child of this.children) child.parentNode = null; this.children = []; this._text = ''; this.append(...nodes) }
  remove() { if (this.parentNode?.children) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null }
  setAttribute(name, value) {
    const string = String(value)
    this.attributes.set(name, string)
    if (name === 'class') this.className = string
    if (name === 'id') this.id = string
    if (name === 'disabled') this.disabled = true
    if (name === 'hidden') this.hidden = true
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_all, letter) => letter.toUpperCase())] = string
  }
  getAttribute(name) { return this.attributes.get(name) ?? null }
  hasAttribute(name) { return this.attributes.has(name) }
  removeAttribute(name) { this.attributes.delete(name) }
  toggleAttribute(name, force) { const on = force ?? !this.hasAttribute(name); on ? this.setAttribute(name, '') : this.removeAttribute(name); return on }
  addEventListener(name, listener) { this.listeners.set(name, [...(this.listeners.get(name) || []), listener]) }
  removeEventListener(name, listener) { this.listeners.set(name, (this.listeners.get(name) || []).filter(item => item !== listener)) }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
  querySelectorAll(selector) { return descendants(this).filter(node => selector.split(',').some(part => matches(node, part.trim()))) }
  contains(node) { return node === this || descendants(this).includes(node) }
  closest(selector) { for (let node = this; node; node = node.parentNode) if (matches(node, selector)) return node; return null }
  getBoundingClientRect() { return { width: 600, height: 400, top: 0, bottom: 400, left: 0, right: 600 } }
  focus() { this.ownerDocument.activeElement = this }
  getContext() { return null }
}

const descendants = root => root.children.flatMap(child => [child, ...descendants(child)])

function matches(node, selector) {
  const attribute = selector.match(/\[([^=\]]+)(?:="([^"]*)")?\]/)
  const classNames = [...selector.matchAll(/\.([\w-]+)/g)].map(match => match[1])
  const tag = selector.match(/^[a-z][\w-]*/i)?.[0]
  if (tag && node.tagName !== tag.toUpperCase()) return false
  if (classNames.some(name => !node.classList.contains(name))) return false
  if (attribute) {
    const [, name, value] = attribute
    if (!node.hasAttribute(name)) return false
    if (value !== undefined && node.getAttribute(name) !== value) return false
  }
  return Boolean(tag || classNames.length || attribute)
}

function parse(documentRef, markup) {
  const holder = new FakeElement(documentRef, 'fragment')
  const stack = [holder]
  const tokens = markup.match(/<!--[\s\S]*?-->|<[^>]+>|[^<]+/g) || []
  for (const token of tokens) {
    if (token.startsWith('<!--')) continue
    if (token.startsWith('</')) {
      const closing = /^<\/\s*([\w-]+)/.exec(token)?.[1]
      if (!/^(?:input|path|circle|rect|stop|br|img|i)$/i.test(closing || '')) stack.pop()
      continue
    }
    if (token.startsWith('<')) {
      const found = /^<\s*([\w-]+)([^>]*)>/.exec(token)
      if (!found) continue
      const node = new FakeElement(documentRef, found[1])
      for (const attr of found[2].matchAll(/([:\w-]+)(?:="([^"]*)")?/g)) node.setAttribute(attr[1], attr[2] ?? '')
      stack.at(-1).append(node)
      if (!/\/$/.test(found[2]) && !/^(?:input|path|circle|rect|stop|br|img|i)$/i.test(found[1])) stack.push(node)
    } else if (token.trim()) stack.at(-1)._text += token.replace(/\s+/g, ' ')
  }
  return holder.children
}

class FakeDocument {
  addEventListener() {}
  removeEventListener() {}
  constructor() {
    this.documentElement = new FakeElement(this, 'html')
    this.body = new FakeElement(this, 'body')
    this.documentElement.append(this.body)
    this.documentElement.parentNode = { isConnected: true }
    this.fonts = { addEventListener() {}, removeEventListener() {}, ready: Promise.resolve() }
    this.activeElement = null
  }
  createElement(tagName) {
    if (tagName !== 'template') return new FakeElement(this, tagName)
    const template = new FakeElement(this, 'template')
    template.content = { firstElementChild: null }
    Object.defineProperty(template, 'innerHTML', { set: markup => { template.content.firstElementChild = parse(this, markup)[0] || null } })
    return template
  }
}

const original = {}
for (const key of ['document', 'window', 'localStorage', 'ResizeObserver', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'mcAgent', 'mcProviders', 'mcShell', 'fetch']) original[key] = globalThis[key]

const documentRef = new FakeDocument()
const bridgeRequests = [], unexpectedFetches = []
// This DOM fixture supplies the maintained host transport seam explicitly.
// It reports an unavailable bridge; no local discovery or network is part of
// these view assertions, including after the view has been destroyed.
const fixtureTransport = async (...args) => {
  bridgeRequests.push(args)
  return { ok: false, code: 'BRIDGE_TEST_UNAVAILABLE', reason: 'Owned home view fixture has no live bridge.' }
}
globalThis.fetch = async url => { unexpectedFetches.push(String(url)); throw new Error('Home view fixture must use its declared host transport') }
globalThis.document = documentRef
globalThis.window = Object.assign(new EventTarget(), {
  document: documentRef, innerWidth: 1280, innerHeight: 800,
  location: { search: '', hostname: 'localhost' }, mcAgent: null,
  mcShell: { getBridgeTransport: async () => fixtureTransport },
  getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
})
/* A STORE THAT REMEMBERS, because two of the choices this view reads live in
   it -- the example toggle (src/data-source.js) and which run rows a person
   opened (src/components.js openMemory). The previous stub answered null to
   everything, which is indistinguishable from an empty store until a test
   needs to put a choice in front of the view; it starts empty, so every
   assertion written against the old stub means what it meant. */
const storage = new Map()
globalThis.localStorage = {
  get length() { return storage.size },
  key: index => [...storage.keys()][index] ?? null,
  getItem: name => (storage.has(name) ? storage.get(name) : null),
  setItem(name, value) { storage.set(String(name), String(value)) },
  removeItem(name) { storage.delete(String(name)) },
  clear() { storage.clear() },
}
globalThis.ResizeObserver = globalThis.MutationObserver = class { observe() {} disconnect() {} }
globalThis.requestAnimationFrame = () => 1
globalThis.cancelAnimationFrame = () => {}
globalThis.setInterval = () => 1
globalThis.clearInterval = () => {}
globalThis.setTimeout = () => 1
globalThis.clearTimeout = () => {}
globalThis.mcShell = window.mcShell

const { homeView } = await import('../../src/views/home.js')

async function settle() { for (let index = 0; index < 20; index += 1) await Promise.resolve() }

async function mount(agent) {
  globalThis.mcAgent = agent
  window.mcAgent = agent
  const view = homeView()
  view.el.parentNode = { isConnected: true }
  await settle()
  return view
}

test('mounted Home projects shared Local readiness without Codex installation instructions', async () => {
  const previous = globalThis.mcProviders
  globalThis.mcProviders = { presence: async () => ({ ok: true, providers: [{ id: 'codex', installed: 'yes', signedIn: 'no' }] }) }
  const view = await mount({
    history: async () => ({ ok: true, entries: [] }),
    availability: async () => ({ ok: true, code: 'AGENT_ENGINE_READY', readyProvider: 'local', codexCode: 'AGENT_CONFINEMENT_SIGNED_OUT' }),
  })
  try {
    assert.match(view.el.textContent, /Local agents can run/)
    assert.equal(view.el.dataset.panel, 'empty')
    assert.match(view.el.querySelector('.log-notices').textContent, /No agents have run here yet/)
    assert.match(view.el.querySelector('.log-notices').textContent, /When you start an agent, every run shows up here/)
    assert.equal(view.el.querySelectorAll('.run-row').length, 0, 'readiness does not invent a running agent')
    assert.doesNotMatch(view.el.querySelector('.home-facts').textContent, /codex login|npm install|nobody is signed in/i)
  } finally { view.destroy(); globalThis.mcProviders = previous }
})

test('the phone ring stage keeps voice outside its clipped decoration', async () => {
  const view = await mount(null)
  try {
    assert.ok(bridgeRequests.length > 0, 'the real view must observe the explicit bridge refusal')
    const wrap = view.el.querySelector('.home-ring-wrap')
    const stage = wrap.querySelector('.home-ring-stage')
    const voice = wrap.querySelector('.voice-contact')
    assert.ok(stage?.querySelector('.uring'), 'the ring belongs inside the responsive stage')
    assert.ok(voice, 'home must retain its voice contact')
    assert.equal(voice.parentNode, wrap, 'voice stays a sibling of the decorative stage')
    assert.equal(stage.contains(voice), false, 'ring clipping cannot clip voice controls')
  } finally { view.destroy() }
})

test('the home screen does not advertise subscriptions at all', async () => {
  /* REPLACES two tests that pinned a DISABLED "Subscriptions coming soon"
     control and its reason. Owner, 2026-08-26: "i dont want to advertise
     subscriptions in the app" -- and separately, that payments do not open
     during public beta, so it was not a hold with a date behind it. Honest
     about being shut is not the same as absent, and this is the first screen
     of the product.
     Kept as an ABSENCE pin rather than deleted, so the door cannot drift back
     in unnoticed. The /subscribe view still exists and still refuses honestly
     for anyone who reaches it; what is gone is the selling of it here. */
  const view = await mount(null)
  try {
    assert.equal(view.el.querySelector('[data-door-subscribe]'), null,
      'no subscription door is rendered on the home screen')
    assert.equal(view.el.querySelector('[data-door-subscribe-reason]'), null,
      'and no reason element for one either')
    assert.doesNotMatch(view.el.textContent || '', /subscription/i,
      'and the word does not reach the screen by another route')
  } finally { view.destroy() }
})

test('a readable empty run record reaches the reader as an empty state', async () => {
  const view = await mount({
    history: async () => ({ ok: true, entries: [] }),
    availability: async () => ({ ok: true, available: true }),
  })
  try {
    assert.equal(view.el.dataset.panel, 'empty', 'a successfully read empty record must render the compact empty panel')
  } finally { view.destroy() }
})

test('the readable empty state explains that the view is ready for a first run', async () => {
  const view = await mount({
    history: async () => ({ ok: true, entries: [] }),
    availability: async () => ({ ok: true, available: true }),
  })
  try {
    assert.equal(view.el.dataset.panel, 'empty')
    assert.match(view.el.querySelector('.home-facts').textContent, /Agents can run/)
    const notice = view.el.querySelector('.log-notices')
    assert.match(notice.textContent, /No agents have run here yet/)
    assert.match(notice.textContent, /When you start an agent, every run shows up here/,
      'the readable empty record explains how a first run will appear')
    assert.equal(view.el.querySelectorAll('.run-row').length, 0)
  } finally { view.destroy() }
})

test('could-not-read failures do not collapse into a definite empty answer', async () => {
  const view = await mount({
    history: async () => { throw new Error('fixture ledger refusal') },
    availability: async () => { throw new Error('fixture engine refusal') },
  })
  try {
    const rendered = view.el.textContent
    assert.match(rendered, /could not be read|couldn.t read|unavailable/i,
      `a refused read must be visible as uncertainty; rendered: "${rendered}"`)
    assert.doesNotMatch(rendered, /no agents have run here yet/i,
      `a failed ledger read must not be reported as a definite empty history; rendered: "${rendered}"`)
    assert.doesNotMatch(view.el.querySelector('.home-facts').textContent, /agents can run/i,
      'failed availability cannot inherit a previous successful readiness answer')
  } finally { view.destroy() }
})

/* ------------------------------------------------------------------
   THE TRANSCRIPT IN THE BOX. tools/test/home-turns.test.mjs measures the four
   decisions themselves, with values; these two prove this VIEW asks them --
   that the wiring exists at all, which no amount of unit testing of a module
   nothing calls can show.

   The example is the state where a mounted view really has turns on the glass:
   its record and its conversations ship with the product (src/sample-activity
   .js). The lines a run row draws as turns are the ones BETWEEN the question
   and the answer -- describeRun() lifts the question out to "Asked:" and the
   answer to "Said:" -- so the two registers under test here are the quiet
   action lines and what the agent wrote. The person's own register is measured
   with values next door, where it can be asked for directly.
   ------------------------------------------------------------------ */

async function mountExample() {
  localStorage.setItem('mc.example', 'on')
  try { return await mount(null) } finally { localStorage.removeItem('mc.example') }
}

const turnsIn = view => view.el.querySelectorAll('.turn')

test("the pane draws an agent's markdown and leaves the other two registers alone", async () => {
  const view = await mountExample()
  try {
    const turns = turnsIn(view)
    assert.ok(turns.length, 'the example put no turns on the glass; this test can prove nothing')

    const registers = new Set(turns.map(turn => turn.className.split(/\s+/).find(name => name.startsWith('is-'))))
    for (const register of ['is-act', 'is-agent']) {
      assert.ok(registers.has(register), `no ${register} line was drawn; the example transcript changed shape`)
    }

    /* An action line is one clause this product wrote. It must arrive with its
       own characters, never restructured -- and it must not be labelled, which
       is what makes it read as a tool line rather than as a speaker. */
    for (const turn of turns.filter(node => node.classList.contains('is-act'))) {
      assert.equal(turn.querySelector('.turn-who'), null, 'an action line was given a speaker label')
      assert.equal(turn.querySelector('.md-p'), null, 'an action line was read as markdown')
    }
    /* The agent's, which IS drawn the way it wrote it. */
    const answered = turns.find(turn => turn.classList.contains('is-agent'))
    assert.ok(answered.querySelector('.turn-who'), "an agent's line was drawn with no name on it")
    assert.ok(answered.querySelector('.md-p'), "an agent's reply was not drawn as what it wrote")
  } finally { view.destroy() }
})

test('every turn on the glass says who spoke, or is an action line', async () => {
  const view = await mountExample()
  try {
    for (const turn of turnsIn(view)) {
      const label = turn.querySelector('.turn-who')
      const isAction = turn.classList.contains('is-act')
      assert.ok(
        isAction || (label && label.textContent.trim()),
        `a turn was drawn with no speaker and is not an action line: "${turn.textContent.slice(0, 60)}"`,
      )
    }
  } finally { view.destroy() }
})

test.after(async () => {
  await settle()
  assert.deepEqual(unexpectedFetches, [], 'view-only fixtures must never discover or contact a real listener')
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete globalThis[key]
    else globalThis[key] = value
  }
})

/* T1499: Chat on a roster row hides the roster that held the pressed button,
   and Back to list hides the chat that held that one. A browser drops focus to
   the page when its element is hidden, so both presses left a keyboard user
   nowhere. Focus must move into the opened chat, and come back to the row's
   Chat button. */
test('Chat moves keyboard focus into the opened chat, and Back to list brings it back to the row', async () => {
  const view = await mountExample()
  const press = node => { for (const listener of node.listeners.get('click') || []) listener({ preventDefault() {}, stopPropagation() {}, target: node }) }
  try {
    const chat = view.el.querySelectorAll('.home-roster-chat')[0]
    assert.ok(chat, 'the example drew no roster row; this test can prove nothing')
    const key = chat.closest('.home-roster-row')?.dataset.key
    chat.focus()
    press(chat)
    await settle()
    const toolbar = view.el.querySelector('[data-home-chat-toolbar]')
    const back = view.el.querySelector('[data-chat-toolbar-back]')
    assert.equal(toolbar.hidden, false, 'Chat did not open the chat in the panel')
    assert.equal(documentRef.activeElement, back, 'after Chat, focus is left on a button the chat just hid')
    press(back)
    await settle()
    const rowChat = view.el.querySelectorAll('.home-roster-row').find(row => row.dataset.key === key)?.querySelector('.home-roster-chat')
    assert.ok(rowChat, 'the row the person came from is gone')
    assert.equal(documentRef.activeElement, rowChat, 'after Back to list, focus is left on the hidden Back to list')
  } finally { view.destroy() }
})

/* T1579: the whole activity panel was role="log", a polite live region, and
   every repaint wrote every field of every row again, so a screen reader was
   handed about 850 rewrites and 31,000 characters a minute, most of them the
   same words, plus a region full of buttons and a search box. The panel is a
   named region, not a live log, and a row's words are replaced only when they
   change. */
test('the activity panel is not a live log, and a row is rewritten only when its words change', async () => {
  const view = await mountExample()
  try {
    const log = view.el.querySelector('.session-log')
    assert.ok(log, 'the activity panel is gone; this test can prove nothing')
    assert.notEqual(log.getAttribute('role'), 'log', 'the activity panel is still a live log around the roster and its controls')
    assert.ok(log.getAttribute('aria-labelledby'), 'the panel lost its name')
    const live = view.el.querySelectorAll('[role="log"], [aria-live]').filter(node => node.querySelectorAll('button, input, select').length)
    assert.deepEqual(live.map(node => node.className), [], 'a live region still holds controls')
  } finally { view.destroy() }
  const source = readFileSync(new URL('../../src/views/home.js', import.meta.url), 'utf8')
  const setLine = source.slice(source.indexOf('  function setLine(node, value) {'), source.indexOf('  function runTurnNode'))
  assert.match(setLine, /putText\(node, value \|\| ''\)/, 'setLine rewrites unchanged words')
  assert.match(setLine, /if \(node\.textContent !== next\) node\.textContent = next/)
  for (const field of ['what', 'result', 'when']) {
    assert.doesNotMatch(source, new RegExp(`parts\\.${field}\\.textContent = `), `the row's ${field} is rewritten on every repaint`)
  }
})
