/* THE COORDINATOR COMPOSER'S DRAFT MUST SURVIVE A SUBJECT-SWITCH REBUILD.
 *
 * Owner, verbatim: "theres occassionally really annoying UI redraws and
 * they erase my typing." THE TRIGGER, NAMED: src/home-chat-takeover.js's
 * mountChatTakeover exposes `show(nextId)` (the `show:` method on its
 * returned surface, wrapping the internal `show` closure), which
 * src/views/home.js:631 calls on the subject picker's own 'change' event --
 * `subjectPicker.addEventListener('change', () => takeoverSurface?.show(...))`.
 * Every call to `show()` -- the one exposed method, no other path -- tears
 * the whole stage down (`host.replaceChildren()`) and, for the coordinator
 * subject, mounts a BRAND NEW buildChat() composer. This file drives that
 * exact exposed `.show()` method, never a private symbol, exactly the way
 * the picker's own listener does.
 *
 * THIS FILE NEEDS A REAL DOM, unlike tools/test/home-chat-takeover.test.mjs
 * (which deliberately has none, and proves reuse by catching the
 * ReferenceError buildChat throws without one). Adding DOM globals to that
 * shared file would silence those proofs, so this is its own file, built on
 * the same NodeDouble contract tools/test/chat-context-chips.test.mjs
 * already uses to drive buildChat for real.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

class NodeDouble {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null
    this.attributes = new Map(); this.listeners = new Map(); this.className = ''
    this.hidden = false; this.value = ''; this.textContent = ''; this.style = {}
    this.dataset = {}; this.scrollTop = 0; this.scrollHeight = this.clientHeight = 100
    this.classList = {
      toggle: (name, on) => {
        const names = new Set(this.className.split(/\s+/).filter(Boolean))
        const use = on === undefined ? !names.has(name) : Boolean(on)
        use ? names.add(name) : names.delete(name); this.className = [...names].join(' ')
      },
      add: (...names) => { for (const name of names) this.classList.toggle(name, true) },
      remove: (...names) => { for (const name of names) this.classList.toggle(name, false) },
      contains: (name) => this.className.split(/\s+/).filter(Boolean).includes(name),
    }
  }
  appendChild(node) { node.parentNode = this; this.children.push(node); return node }
  append(...nodes) { nodes.forEach(node => this.appendChild(node)) }
  prepend(node) { node.parentNode = this; this.children.unshift(node) }
  insertBefore(node, at) { const i = this.children.indexOf(at); node.parentNode = this; this.children.splice(i < 0 ? this.children.length : i, 0, node); return node }
  remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1) }
  replaceWith(node) { const i = this.parentNode?.children.indexOf(this) ?? -1; if (i >= 0) this.parentNode.children.splice(i, 1, node) }
  /* home-chat-takeover.js's own `show()` calls this with no arguments to
     clear the stage before every mount -- the exact rebuild under test. */
  replaceChildren(...kids) { for (const child of this.children.slice()) child.remove(); kids.forEach(node => this.appendChild(node)) }
  get childElementCount() { return this.children.length }
  get lastElementChild() { return this.children.at(-1) || null }
  setAttribute(name, value) { this.attributes.set(name, String(value)); if (name === 'class') this.className = String(value) }
  getAttribute(name) { return name === 'class' ? this.className : this.attributes.get(name) ?? null }
  removeAttribute(name) { this.attributes.delete(name) }
  addEventListener(name, listener) { this.listeners.set(name, [...(this.listeners.get(name) || []), listener]) }
  removeEventListener() {}
  focus() { document.activeElement = this }
  scrollIntoView() {}
  matches(selector) {
    if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1))
    if (selector.startsWith('[')) {
      const match = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/)
      return Boolean(match && this.attributes.has(match[1]) && (match[2] === undefined || this.attributes.get(match[1]) === match[2]))
    }
    return this.tagName === selector.toUpperCase()
  }
  querySelectorAll(selector) { const out = []; const walk = node => node.children.forEach(child => { if (child.matches(selector.split(/\s+/).at(-1))) out.push(child); walk(child) }); walk(this); return out }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
  set innerHTML(value) { this.children = []; parse(value, this) }
}

function parse(html, host) {
  const stack = [host]
  for (const token of String(html).match(/<[^>]+>|[^<]+/g) || []) {
    if (token.startsWith('</')) { stack.pop(); continue }
    if (!token.startsWith('<')) { stack.at(-1).textContent += token.trim(); continue }
    const match = token.match(/^<([\w-]+)/); if (!match) continue
    const node = new NodeDouble(match[1])
    for (const attr of token.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) if (attr[1] !== match[1]) node.setAttribute(attr[1], attr[2] ?? '')
    stack.at(-1).appendChild(node)
    if (!/\/$/.test(token) && !/^(input|img|path|rect)$/i.test(match[1])) stack.push(node)
  }
}

const documentRoot = new NodeDouble('html')
globalThis.document = { documentElement: documentRoot, body: new NodeDouble('body'), activeElement: null,
  fonts: { ready: Promise.resolve(), addEventListener() {}, removeEventListener() {} },
  createElement(tag) { if (tag !== 'template') return new NodeDouble(tag); const content = { firstElementChild: null }; return { content, set innerHTML(value) { const host = new NodeDouble(); parse(value, host); content.firstElementChild = host.children[0] } } },
  addEventListener() {}, removeEventListener() {} }
globalThis.window = { matchMedia: () => ({ matches: true }) }
globalThis.ResizeObserver = class { observe() {} disconnect() {} }
globalThis.MutationObserver = class { observe() {} disconnect() {} }
globalThis.requestAnimationFrame = callback => { callback(); return 1 }
globalThis.cancelAnimationFrame = () => {}

const { mountChatTakeover, buildSubjectChoices } = await import('../../src/home-chat-takeover.js')
const { CHAT_COMPOSER_INPUT_SELECTOR } = await import('../../src/components.js')

const choices = buildSubjectChoices({ machines: [], speakers: {} })

function coordinatorInput(host) {
  const chat = host.children.at(-1)
  return chat ? chat.querySelector(CHAT_COMPOSER_INPUT_SELECTOR) : null
}

test('a word typed into the coordinator composer survives switching to another subject and back -- the picker\'s own change trigger', () => {
  const host = new NodeDouble('div')
  const surface = mountChatTakeover(host, { choices, subjectId: 'coordinator', live: false })

  const before = coordinatorInput(host)
  assert.ok(before, 'the coordinator subject must mount a real composer with an input')
  const typed = 'do not lose this'
  before.value = typed

  /* THE TRIGGER, FIRED EXACTLY AS src/views/home.js:631 fires it: the
     exposed `.show(nextId)` method, nothing internal. */
  surface.show('everything')
  surface.show('coordinator')

  const after = coordinatorInput(host)
  assert.ok(after, 'the coordinator subject must still mount a real composer after switching back')
  assert.notEqual(after, before, 'this is a genuine rebuild -- a fresh element, not the same one reused')
  assert.ok(after.value === typed, `the typed words must survive the round trip: got ${JSON.stringify(after.value)}`)

  surface.destroy()
})

test('the same word survives the picker firing on the SAME subject, matching a native change event with no visible switch', () => {
  const host = new NodeDouble('div')
  const surface = mountChatTakeover(host, { choices, subjectId: 'coordinator', live: false })
  const before = coordinatorInput(host)
  before.value = 'still typing'

  surface.show('coordinator')

  const after = coordinatorInput(host)
  assert.ok(after.value === 'still typing', `a same-subject rebuild must not discard the box either: got ${JSON.stringify(after.value)}`)
  surface.destroy()
})

test('an empty composer holds no stale draft -- switching away with nothing typed restores nothing invented', () => {
  const host = new NodeDouble('div')
  const surface = mountChatTakeover(host, { choices, subjectId: 'coordinator', live: false })
  surface.show('everything')
  surface.show('coordinator')
  const after = coordinatorInput(host)
  assert.ok(after.value === '', `no draft was ever typed, so none may appear: got ${JSON.stringify(after.value)}`)
  surface.destroy()
})
