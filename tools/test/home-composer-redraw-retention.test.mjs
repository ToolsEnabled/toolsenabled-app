/* A REDRAW MUST NOT ERASE WHAT THE PERSON IS STILL TYPING.
 *
 * Owner, verbatim: "theres occassionally really annoying UI redraws and they
 * erase my typing." src/home-chat-composer-draft.js carries that sentence and
 * holds the TEXT across a subject-switch rebuild, and
 * tools/test/home-chat-composer-draft.test.mjs pins the text. Neither covers
 * the other two things lost in the same instant: WHERE THE CARET WAS and WHAT
 * WAS ATTACHED. A draft restored with the words but the caret thrown back to 0
 * eats the next keystroke in the wrong place; a restored draft that dropped an
 * attachment has lost unsent work.
 *
 * The tree rail already proves all three (tools/test/tree-rail-draft-navigation
 * .test.mjs asserts exportDraft() whole plus the attachment chip). This is the
 * HOME takeover's equivalent.
 *
 * THE REDRAW IS THE REAL ONE: mountChatTakeover's exposed .show(nextId), the
 * same method src/views/home.js calls from the subject picker's own change
 * listener. Every call runs host.replaceChildren() and builds a BRAND NEW
 * buildChat composer, so the element holding the value is discarded.
 *
 * THE STAND-IN IMPLEMENTS THE SELECTION API EXPLICITLY. Without it buildChat's
 * input.setSelectionRange?.(...) silently no-ops and a caret assertion would
 * pass while measuring nothing. tools/test/helpers/tree-rail-chat-harness.mjs
 * makes the same choice for the rail. The product export/import path is actual.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

class NodeDouble {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null
    this.attributes = new Map(); this.listeners = new Map(); this.className = ''
    this.hidden = false; this.value = ''; this.textContent = ''; this.style = {}
    this.dataset = {}; this.scrollTop = 0; this.scrollHeight = this.clientHeight = 100
    /* The standard input selection API, stated rather than assumed. */
    this.selectionStart = 0; this.selectionEnd = 0
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
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end }
  appendChild(node) { node.parentNode = this; this.children.push(node); return node }
  append(...nodes) { nodes.forEach(node => this.appendChild(node)) }
  prepend(node) { node.parentNode = this; this.children.unshift(node) }
  insertBefore(node, at) { const i = this.children.indexOf(at); node.parentNode = this; this.children.splice(i < 0 ? this.children.length : i, 0, node); return node }
  remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1) }
  replaceWith(node) { const i = this.parentNode?.children.indexOf(this) ?? -1; if (i >= 0) this.parentNode.children.splice(i, 1, node) }
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
const { createComposerDraftStore } = await import('../../src/home-chat-composer-draft.js')
const { CHAT_COMPOSER_INPUT_SELECTOR } = await import('../../src/components.js')

const choices = buildSubjectChoices({ machines: [], speakers: {} })
const inputOf = host => { const chat = host.children.at(-1); return chat ? chat.querySelector(CHAT_COMPOSER_INPUT_SELECTOR) : null }
const chipsOf = host => { const chat = host.children.at(-1); return chat ? chat.querySelectorAll('.chat-attachment-chip') : [] }

/* One held draft carrying all three things a redraw can destroy. This is the
   same store src/views/home.js:597 creates and hands the takeover at :763. */
function mountWithHeldDraft() {
  const drafts = createComposerDraftStore()
  drafts.writeDraft('coordinator', {
    text: 'keep these words', attachments: [{ name: 'diagram.png', path: '/fixture/diagram.png' }], start: 4, end: 4,
  })
  const host = new NodeDouble('div')
  const surface = mountChatTakeover(host, { choices, subjectId: 'coordinator', live: false, draftStore: drafts })
  return { host, surface, drafts }
}

test('the held draft reaches a freshly built composer whole -- words, caret and attachment', () => {
  const { host, surface } = mountWithHeldDraft()
  const input = inputOf(host)
  assert.ok(input, 'the coordinator subject must mount a real composer')
  assert.equal(input.value, 'keep these words', 'the words are restored')
  assert.equal(input.selectionStart, 4, 'the caret is restored where the person left it')
  assert.equal(chipsOf(host).length, 1, 'the attachment is restored as a visible chip')
  surface.destroy()
})

test('a subject switch away and back keeps words, caret AND attachment', () => {
  const { host, surface } = mountWithHeldDraft()
  const before = inputOf(host)
  before.value = 'keep these words and more'
  before.setSelectionRange(25, 25)

  /* The real redraw: the exposed .show(), exactly as the picker calls it. */
  surface.show('everything')
  surface.show('coordinator')

  const after = inputOf(host)
  assert.notEqual(after, before, 'this is a genuine rebuild, a fresh element')
  assert.equal(after.value, 'keep these words and more', 'the words survived the redraw')
  assert.equal(after.selectionStart, 25, 'the caret survived the redraw')
  assert.equal(chipsOf(host).length, 1, 'the attachment survived the redraw')
  surface.destroy()
})

test('a same-subject rebuild, the picker firing twice, keeps all three too', () => {
  const { host, surface } = mountWithHeldDraft()
  const before = inputOf(host)
  before.value = 'still typing'
  before.setSelectionRange(6, 12)

  surface.show('coordinator')

  const after = inputOf(host)
  assert.equal(after.value, 'still typing', 'a same-subject rebuild must not discard the box')
  assert.equal(after.selectionStart, 6, 'nor the selection start')
  assert.equal(after.selectionEnd, 12, 'nor the selection end -- a range, not only a caret')
  assert.equal(chipsOf(host).length, 1, 'nor the attachment')
  surface.destroy()
})

test('clearing the words keeps the attachment, which is unsent work of its own', () => {
  const { host, surface } = mountWithHeldDraft()
  inputOf(host).value = ''

  surface.show('everything')
  surface.show('coordinator')

  assert.equal(inputOf(host).value, '', 'the cleared box stays cleared')
  assert.equal(chipsOf(host).length, 1, 'the attachment is not collateral damage of clearing the line')
  surface.destroy()
})

test('a subject that never held anything invents nothing', () => {
  const host = new NodeDouble('div')
  const surface = mountChatTakeover(host, { choices, subjectId: 'coordinator', live: false, draftStore: createComposerDraftStore() })
  surface.show('everything')
  surface.show('coordinator')
  assert.equal(inputOf(host).value, '', 'no draft was typed, so none may appear')
  assert.equal(chipsOf(host).length, 0, 'and no attachment either')
  surface.destroy()
})
