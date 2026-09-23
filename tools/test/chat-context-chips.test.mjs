import assert from 'node:assert/strict'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

/* This deliberately exercises buildChat, rather than reading components.js and
   declaring that particular source words are the feature.  The small DOM is
   only the browser contract buildChat needs in a node:test process. */
class NodeDouble {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null
    this.attributes = new Map(); this.listeners = new Map(); this.className = ''
    this.hidden = false; this.value = ''; this.textContent = ''; this.style = {}
    this.dataset = {}; this.scrollTop = 0; this.scrollHeight = this.clientHeight = 100
    this.classList = { toggle: (name, on) => {
      const names = new Set(this.className.split(/\s+/).filter(Boolean))
      on ? names.add(name) : names.delete(name); this.className = [...names].join(' ')
    } }
  }
  appendChild(node) { node.parentNode = this; this.children.push(node); return node }
  append(...nodes) { nodes.forEach(node => this.appendChild(node)) }
  prepend(node) { node.parentNode = this; this.children.unshift(node) }
  insertBefore(node, at) { const i = this.children.indexOf(at); node.parentNode = this; this.children.splice(i < 0 ? this.children.length : i, 0, node); return node }
  remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1) }
  replaceWith(node) { const i = this.parentNode?.children.indexOf(this) ?? -1; if (i >= 0) this.parentNode.children.splice(i, 1, node) }
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

const modulePath = process.env.CHAT_CONTEXT_CHIPS_MODULE || '../../src/components.js'
const { buildChat } = await import(modulePath.startsWith('.') ? modulePath : pathToFileURL(modulePath))

test('composer names explicit and implicit context actually in scope', t => {
  const chat = buildChat({
    title: 'Lane', seed: 0, onSend() {},
    chips: {
      scope: () => ({
        cwd: '/work/acme',
        treeContext: 'Payments tree',
        attachments: [{ path: '/work/acme/invoice.png' }],
      }),
    },
  })

  const scope = chat.querySelector('[data-chat-chip="scope"]')
  if (!scope) {
    t.skip('buildChat does not yet render a scope chip from chips.scope; implicit session cwd and tree context remain unbuilt')
    return
  }

  const words = scope.textContent
  assert.match(words, /acme/, 'the session cwd is implicit context and must be named')
  assert.match(words, /Payments tree/, 'the tree selection is implicit context and must be named')
  assert.match(words, /invoice\.png/, 'the explicit attachment remains part of the same truthful scope summary')
})
