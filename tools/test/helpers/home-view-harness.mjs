/* THE FIRST PAGE, MOUNTED, FOR EVERY SUITE THAT NEEDS IT DRIVEN RATHER THAN READ.
 *
 * WHERE THIS CAME FROM. tools/test/home-chat-structure.test.mjs built this to
 * get src/views/home.js onto a glass -- a DOM stand-in honest about selectors,
 * scrolling and mutation delivery, plus the sources the screen really reads
 * (a configured fleet profile, a coordinator projection, a bridge). The
 * SECOND suite that needed a mounted home view would otherwise have copied
 * three hundred lines of it, so it lives here instead and both import it.
 *
 * WHAT A CALLER SUPPLIES. `fixture` is mutable and read at mount time, not at
 * import time, so a suite sets what it needs and then mounts:
 *
 *   fixture.thread  the coordinator conversation (message() builds one entry)
 *   fixture.ledger  this computer's run record, as bridge.history() answers it
 *   fixture.sent    what the bridge was asked to post; a suite empties it
 *
 * `stored` is the localStorage behind the screen -- seed a saved forest or a
 * saved transcript into it before mounting and the run rows can find their
 * conversations.
 *
 * AND THE FAKE ELEMENTS HERE CAN SCROLL. A pin is a claim about scrollTop
 * after an append, so scrollTop/scrollHeight/clientHeight behave the way a
 * browser's do (a write is clamped to scrollHeight - clientHeight, which is
 * what makes "scroll to the bottom" land at the bottom), and MutationObserver
 * delivers to the observers that asked for the subtree the change happened
 * in. Without those two, assertions built on this would pass on any
 * implementation at all.
 *
 * Every importer must call restoreGlobals() from its own test.after().
 */
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import { fileURLToPath } from 'node:url'

register('./css-stub-loader.mjs', import.meta.url)

/* ------------------------------------------------------------------
   A DOM small enough to read and honest about the three things asked of it:
   selectors, scrolling, and mutation delivery.
   ------------------------------------------------------------------ */

class Classes {
  constructor(node) { this.node = node }
  names() { return this.node.className.split(/\s+/).filter(Boolean) }
  contains(name) { return this.names().includes(name) }
  add(...names) { this.node.className = [...new Set([...this.names(), ...names])].join(' ') }
  remove(...names) { this.node.className = this.names().filter(name => !names.includes(name)).join(' ') }
  toggle(name, force) { const on = force ?? !this.contains(name); on ? this.add(name) : this.remove(name); return on }
}

/* Every live observer, so a mutation can be delivered to the ones watching the
   place it happened. `subtree` is honoured because that is the whole question
   one of the tests below asks. */
const observers = new Set()
function notifyMutation(node) {
  for (const entry of [...observers]) {
    const watching = entry.target === node || (entry.options.subtree === true && entry.target.contains(node))
    if (watching) entry.callback([], entry.self)
  }
}

class FakeElement {
  constructor(documentRef, tagName = 'div') {
    this.ownerDocument = documentRef
    this.tagName = tagName.toUpperCase()
    this.children = []
    this.parentNode = null
    this.attributes = new Map()
    this.dataset = {}
    this.style = { setProperty() {}, getPropertyValue() { return '' }, background: '' }
    this.className = ''
    this.classList = new Classes(this)
    this.hidden = false
    this.disabled = false
    /* A real input answers '' for its value before anyone types; buildChat's
       composer state machine reads it on every repaint. */
    if (this.tagName === 'INPUT' || this.tagName === 'TEXTAREA') this.value = ''
    this.listeners = new Map()
    this._text = ''
    /* Zero means "not a scroll port": every element reports scrollHeight 0
       until a test says how tall one line of its content is. */
    this.contentUnit = 0
    this.clientHeight = 0
    this._scrollTop = 0
  }
  get firstElementChild() { return this.children[0] || null }
  get lastElementChild() { return this.children.at(-1) || null }
  get isConnected() { return this.parentNode ? this.parentNode.isConnected !== false : false }
  get textContent() { return this._text + this.children.map(child => child.textContent).join('') }
  set textContent(value) {
    for (const child of this.children) child.parentNode = null
    this.children = []
    this._text = String(value)
    notifyMutation(this)
  }
  get scrollHeight() { return this.contentUnit ? descendants(this).length * this.contentUnit : 0 }
  get scrollTop() { return this._scrollTop }
  set scrollTop(value) {
    const ceiling = Math.max(0, this.scrollHeight - this.clientHeight)
    const wanted = Number(value)
    this._scrollTop = Number.isFinite(wanted) ? Math.max(0, Math.min(wanted, ceiling)) : 0
  }
  set innerHTML(value) { this.replaceChildren(...parse(this.ownerDocument, String(value))) }
  append(...nodes) {
    for (const node of nodes) {
      if (typeof node === 'string') this._text += node
      else { node.parentNode = this; this.children.push(node) }
    }
    notifyMutation(this)
  }
  appendChild(node) { this.append(node); return node }
  insertBefore(node, before) {
    const at = this.children.indexOf(before)
    if (at < 0) return this.appendChild(node)
    node.parentNode = this
    this.children.splice(at, 0, node)
    notifyMutation(this)
    return node
  }
  insertAdjacentElement(position, node) {
    if (position !== 'afterend' || !this.parentNode) throw new Error(`unsupported insertion: ${position}`)
    const at = this.parentNode.children.indexOf(this)
    node.parentNode = this.parentNode
    this.parentNode.children.splice(at + 1, 0, node)
    notifyMutation(this.parentNode)
    return node
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parentNode = null
    this.children = []
    this._text = ''
    this.append(...nodes)
    notifyMutation(this)
  }
  remove() {
    const parent = this.parentNode
    if (parent?.children) parent.children = parent.children.filter(child => child !== this)
    this.parentNode = null
    if (parent) notifyMutation(parent)
  }
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
  /** What a browser does when a person drags the scroller: move it, then tell. */
  scrollTo(offset) {
    this.scrollTop = offset
    for (const listener of this.listeners.get('scroll') || []) listener({ target: this })
  }
  dispatch(name, event = {}) { for (const listener of this.listeners.get(name) || []) listener(event) }
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
  /* The document itself has no classes and matches nothing, exactly as in a
     browser, where Element.closest() stops before it. buildChat's lifecycle
     sweep walks closest('.as-chat') up to the root. */
  if (!node || !node.classList) return false
  /* DESCENDANT COMBINATORS. buildChat finds its own box with '.chat-input
     input'; a matcher that read that as one compound selector matched the
     WRAPPER (class chat-input, no tag) and the surface typed into a div.
     The last compound must match the node and every earlier one an ancestor,
     in order, which is what a browser does. */
  const compounds = selector.trim().split(/\s+/)
  if (compounds.length > 1) {
    if (!matches(node, compounds[compounds.length - 1])) return false
    let ancestor = node.parentNode
    for (let index = compounds.length - 2; index >= 0; index -= 1) {
      while (ancestor && !matches(ancestor, compounds[index])) ancestor = ancestor.parentNode
      if (!ancestor) return false
      ancestor = ancestor.parentNode
    }
    return true
  }
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
      if (!/^(?:input|path|circle|rect|stop|br|img|i|hr)$/i.test(closing || '')) stack.pop()
      continue
    }
    if (token.startsWith('<')) {
      const found = /^<\s*([\w-]+)([^>]*)>/.exec(token)
      if (!found) continue
      const node = new FakeElement(documentRef, found[1])
      for (const attr of found[2].matchAll(/([:\w-]+)(?:="([^"]*)")?/g)) node.setAttribute(attr[1], attr[2] ?? '')
      stack.at(-1).append(node)
      if (!/\/$/.test(found[2]) && !/^(?:input|path|circle|rect|stop|br|img|i|hr)$/i.test(found[1])) stack.push(node)
    } else if (token.trim()) stack.at(-1)._text += token.replace(/\s+/g, ' ')
  }
  return holder.children
}

class FakeDocument {
  constructor() {
    this.documentElement = new FakeElement(this, 'html')
    this.body = new FakeElement(this, 'body')
    this.documentElement.append(this.body)
    this.documentElement.parentNode = { isConnected: true }
    this.fonts = { addEventListener() {}, removeEventListener() {}, ready: Promise.resolve() }
    this.activeElement = null
  }
  querySelector(selector) { return this.documentElement.querySelector(selector) }
  querySelectorAll(selector) { return this.documentElement.querySelectorAll(selector) }
  addEventListener() {}
  removeEventListener() {}
  createElement(tagName) {
    if (tagName !== 'template') return new FakeElement(this, tagName)
    const template = new FakeElement(this, 'template')
    template.content = { firstElementChild: null }
    Object.defineProperty(template, 'innerHTML', { set: markup => { template.content.firstElementChild = parse(this, markup)[0] || null } })
    return template
  }
}

/* ------------------------------------------------------------------
   The sources this screen reads, answered the way a real machine answers.
   ------------------------------------------------------------------ */

const readRepoFile = relative => readFileSync(fileURLToPath(new URL(`../../../${relative}`, import.meta.url)), 'utf8')
const COORDINATOR_SCHEMA = JSON.parse(readRepoFile('public/data/schema/coordinator.schema.json'))

/* A configured fleet, so this screen is not the bundled demonstration. Every
   section it does not name -- the cast of speakers among them -- is inherited
   from the sample profile, which is exactly what a real profile that does not
   redress its own agents gets. */
const PROFILE = {
  schemaVersion: 1,
  id: 'chat-structure-fixture',
  label: 'Chat structure fixture',
  machines: [{ id: 'fixture-one', name: 'Fixture computer', ip: '10.0.0.2' }],
  transports: [{ id: 'fixture-lane', endpoint: '10.0.0.2:9200', port: 9200 }],
}

export const stored = new Map([
  ['mc.fleet.profile', JSON.stringify(PROFILE)],
  /* The composer only exists where a message can actually be sent. */
  ['mc.write.thread-reply', 'enabled'],
])

export const message = (id, sender, text) => ({
  id,
  sender,
  at: '2026-09-03T10:00:00.000Z',
  text,
  contentTrust: 'untrusted',
  grantsAuthority: false,
})

/* WHAT THE SCREEN IS GIVEN, read at mount time rather than at import time so a
   suite can set it in its own body and still get it onto the glass.

   `thread` is the coordinator conversation. `owner` and `act` are the two
   voices in the bundled cast that are not agents (src/chatbox-feed.js keeps
   the same pair), and both of them write characters that markdown would eat.

   `ledger` is this computer's run record, exactly as bridge.history() answers
   it -- empty by default, because a suite that has not asked for run rows
   must not silently get them.

   `sent` is what the bridge was asked to post. A suite that reads it empties
   it first; a suite that does not, ignores it. */
export const fixture = {
  thread: [
    message('m1', 'owner', 'Use **stars** and _underscores_ literally please'),
    message('m2', 'act', '- read the record'),
    message('m3', 'codex', '## Findings\n\nThe run **passed**.'),
  ],
  ledger: [],
  sent: [],
}

function coordinatorProjection() {
  return {
    schemaVersion: 1,
    domain: 'coordinator',
    generatedAt: '2026-09-03T10:00:00.000Z',
    ok: true,
    reason: null,
    sources: [],
    data: {
      identity: { id: 'codex', displayName: 'codex', provider: 'fixture', enabled: true },
      sessions: { ok: true, reason: null, observedAt: '2026-09-03T10:00:00.000Z', value: [] },
      thread: { ok: true, reason: null, observedAt: '2026-09-03T10:00:00.000Z', value: fixture.thread },
    },
  }
}

const statusSnapshot = () => ({
  schemaVersion: 1,
  ok: true,
  health: {
    available: true,
    observedAtMs: Date.parse('2026-09-03T10:00:00.000Z'),
    total: 2,
    counts: { OK: 2, DOWN: 0, STOPPED: 0, UNKNOWN: 0, OTHER: 0 },
  },
  peerLink: { outbound: { available: false } },
})

const jsonResponse = value => ({ ok: true, status: 200, statusText: 'OK', json: async () => value })

/* What the bridge answers. bridgeStatus() has to say yes or the composer stays
   disabled and says why, and thread-reply has to succeed or nothing is echoed
   into the transcript. */
async function bridgeTransport(pathname, { body = null } = {}) {
  if (pathname === '/v1/status') return { ok: true, status: { ready: true } }
  if (pathname === '/v1/actions/thread-reply') {
    fixture.sent.push(body)
    return { ok: true, receipt: { action: 'thread-reply', actor: 'mission-bridge-service' } }
  }
  return { ok: false, reason: 'not part of this fixture', code: 'FIXTURE_UNHANDLED' }
}

const original = {}
for (const key of ['document', 'window', 'localStorage', 'fetch', 'ResizeObserver', 'MutationObserver',
  'requestAnimationFrame', 'cancelAnimationFrame', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout',
  'mcAgent', 'mcProviders', 'mcShell', 'mcFleetProfile']) original[key] = globalThis[key]

export const documentRef = new FakeDocument()
globalThis.document = documentRef
globalThis.window = {
  document: documentRef,
  innerWidth: 1280,
  innerHeight: 800,
  location: { search: '', hostname: 'localhost' },
  mcAgent: null,
  mcShell: {
    getBridgeProof: async () => ({ ok: true, proof: 'fixture' }),
    getBridgeTransport: async () => bridgeTransport,
  },
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() { return true },
  getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
}
globalThis.localStorage = {
  get length() { return stored.size },
  key: index => [...stored.keys()][index] ?? null,
  getItem: key => (stored.has(key) ? stored.get(key) : null),
  setItem(key, value) { stored.set(key, String(value)) },
  removeItem(key) { stored.delete(key) },
}
/* THE SAME OBJECT ON BOTH DOORS, because in a browser it IS the same object.
   src/views/home.js reaches its saved forest and its saved transcripts through
   `window.localStorage` (readConversations, and the tree store read beside
   it), and a harness that answered only on the global made every one of those
   reads come back null -- a screen with a full record on this computer,
   silently drawing rows that say nothing was saved. */
globalThis.window.localStorage = globalThis.localStorage
globalThis.fetch = async (url) => {
  if (url === '/data/status.json') return jsonResponse(statusSnapshot())
  if (url === '/data/coordinator.json') return jsonResponse(coordinatorProjection())
  if (url === '/data/schema/coordinator.schema.json') return jsonResponse(COORDINATOR_SCHEMA)
  return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) }
}
globalThis.ResizeObserver = class { observe() {} disconnect() {} }
globalThis.MutationObserver = class {
  constructor(callback) { this.callback = callback; this.entry = null }
  observe(target, options = {}) {
    this.entry = { target, options, callback: this.callback, self: this }
    observers.add(this.entry)
  }
  disconnect() { if (this.entry) observers.delete(this.entry); this.entry = null }
}
globalThis.requestAnimationFrame = () => 1
globalThis.cancelAnimationFrame = () => {}
globalThis.setInterval = () => 1
globalThis.clearInterval = () => {}
globalThis.setTimeout = () => 1
globalThis.clearTimeout = () => {}
globalThis.mcShell = window.mcShell

const { homeView } = await import('../../../src/views/home.js')

export async function settle() { for (let index = 0; index < 40; index += 1) await Promise.resolve() }

export async function mount() {
  const agent = {
    /* The run record, read at CALL time from the mutable fixture, so a suite
       that seeded runs gets rows and a suite that did not gets none. */
    history: async () => ({ ok: true, entries: fixture.ledger }),
    availability: async () => ({ ok: true, available: true }),
    onEvent: () => () => {},
  }
  globalThis.mcAgent = agent
  window.mcAgent = agent
  const view = homeView()
  view.el.parentNode = { isConnected: true }
  await settle()
  const log = view.el.querySelector('.session-log')
  /* A scroll port with a viewport shorter than its content, so "pinned to the
     newest" and "held where the reader left it" are different numbers. */
  log.contentUnit = 20
  log.clientHeight = 100
  return { view, log }
}

/* THE SHARED SURFACE'S ROWS. The home thread mounts buildChat (src/components.js)
   into .log-turns now, so a turn is a `.msg` row in its `.chat-log` -- `me`
   for the person, `note` for a product line, `them` for the agent -- and its
   words sit in `.chat-msg-text`. The old `.turn` painter is gone; a suite that
   still looked for it would be asserting about nothing. */
export const chatOf = view => view.el.querySelectorAll('.log-turns')[0].querySelector('.chat')
export const turnsOf = view => { const chat = chatOf(view); return chat ? chat.querySelector('.chat-log').querySelectorAll('.msg') : [] }
export const textOf = node => node.querySelector('.chat-msg-text').textContent
export const composerOf = view => { const chat = chatOf(view); return chat ? { input: chat.querySelector('.chat-input').querySelector('input'), send: chat.querySelector('.chat-send') } : { input: null, send: null } }

/* Put back every global this module replaced. Called from each importer's own
   test.after(), because the harness does not own the suite's lifecycle. */
export function restoreGlobals() {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete globalThis[key]
    else globalThis[key] = value
  }
}
