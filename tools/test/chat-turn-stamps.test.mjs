/* Behaviour contract: the execution identity supplied when a live turn opens
   remains attached after that turn completes. This drives buildChat's public
   stream API and observes its rendered values; it intentionally does not
   inspect components.js source text. */
import assert from 'node:assert/strict'
import test from 'node:test'

class Classes {
  constructor(node) { this.node = node }
  values() { return String(this.node.className || '').split(/\s+/).filter(Boolean) }
  contains(v) { return this.values().includes(v) }
  add(...vs) { this.node.className = [...new Set([...this.values(), ...vs])].join(' ') }
  remove(...vs) { this.node.className = this.values().filter(v => !vs.includes(v)).join(' ') }
  toggle(v, force) { const on = force === undefined ? !this.contains(v) : force; on ? this.add(v) : this.remove(v); return on }
}
class NodeDouble {
  constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.nodeType = 1; this.children = []; this.parentNode = null; this.attributes = new Map(); this.listeners = new Map(); this.className = ''; this.hidden = false; this.value = ''; this.textContent = ''; this.style = {}; this.dataset = {}; this.scrollTop = 0; this.scrollHeight = 100; this.clientHeight = 100; this.classList = new Classes(this) }
  appendChild(n) { n.parentNode = this; this.children.push(n); return n }
  append(...nodes) { for (const n of nodes) this.appendChild(typeof n === 'string' ? Object.assign(new NodeDouble('span'), { textContent: n }) : n) }
  prepend(n) { n.parentNode = this; this.children.unshift(n) }
  insertBefore(n, at) { const i = this.children.indexOf(at); n.parentNode = this; this.children.splice(i < 0 ? this.children.length : i, 0, n); return n }
  remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null }
  replaceWith(n) { if (!this.parentNode) return; const i = this.parentNode.children.indexOf(this); this.parentNode.children[i] = n; n.parentNode = this.parentNode; this.parentNode = null }
  get childElementCount() { return this.children.length }
  get lastElementChild() { return this.children.at(-1) || null }
  setAttribute(k, v) { this.attributes.set(k, String(v)); if (k === 'class') this.className = String(v); if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(v) }
  getAttribute(k) { return k === 'class' ? this.className : this.attributes.get(k) ?? null }
  removeAttribute(k) { this.attributes.delete(k) }
  addEventListener(k, fn) { const a = this.listeners.get(k) || []; a.push(fn); this.listeners.set(k, a) }
  removeEventListener() {}
  dispatch(type, init = {}) { const e = { target: this, key: '', preventDefault() { this.defaultPrevented = true }, stopPropagation() {}, ...init }; for (const fn of this.listeners.get(type) || []) fn(e); return e }
  focus() { document.activeElement = this }
  contains(n) { for (let p = n; p; p = p.parentNode) if (p === this) return true; return false }
  matches(sel) { if (sel.startsWith('.')) return this.classList.contains(sel.slice(1)); if (sel.startsWith('[')) return this.attributes.has(sel.slice(1, -1)); const [tag, cls] = sel.split('.'); return (!tag || this.tagName === tag.toUpperCase()) && (!cls || this.classList.contains(cls)) }
  querySelectorAll(selector) { const parts = selector.trim().split(/\s+/); const out = []; const walk = n => { for (const c of n.children) { if (c.matches(parts.at(-1)) && (parts.length === 1 || c.parentNode?.matches(parts[0]))) out.push(c); walk(c) } }; walk(this); return out }
  querySelector(s) { return this.querySelectorAll(s)[0] || null }
  scrollIntoView() {}
  set innerHTML(html) { this.children = []; parse(html, this) }
}
function parse(html, host) {
  const stack = [host]
  for (const token of String(html).match(/<[^>]+>|[^<]+/g) || []) {
    if (token.startsWith('</')) { if (stack.length > 1) stack.pop(); continue }
    if (!token.startsWith('<')) { const t = token.trim(); if (t) stack.at(-1).textContent += t; continue }
    if (/^<!/.test(token)) continue
    const m = token.match(/^<([\w-]+)/); if (!m) continue
    const n = new NodeDouble(m[1]);
    for (const a of token.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) { if (a[1] !== m[1]) n.setAttribute(a[1], a[2] ?? '') }
    if (/\shidden(?:\s|>|\/)/.test(token)) n.hidden = true
    stack.at(-1).appendChild(n)
    if (!/\/>$/.test(token) && !/^(input|img|path|rect)$/i.test(m[1])) stack.push(n)
  }
}
const docRoot = new NodeDouble('html')
globalThis.document = { documentElement: docRoot, body: new NodeDouble('body'), activeElement: null, fonts: { ready: Promise.resolve(), addEventListener() {}, removeEventListener() {} }, createElement(tag) { if (tag !== 'template') return new NodeDouble(tag); const content = { firstElementChild: null }; return { content, set innerHTML(v) { const h = new NodeDouble('host'); parse(v, h); content.firstElementChild = h.children[0] } } }, addEventListener() {}, removeEventListener() {} }
globalThis.window = { matchMedia: () => ({ matches: true }) }
globalThis.ResizeObserver = class { observe() {} disconnect() {} }
globalThis.MutationObserver = class { observe() {} disconnect() {} }
globalThis.requestAnimationFrame = fn => { fn(); return 1 }
globalThis.cancelAnimationFrame = () => {}

const { buildChat } = await import('../../src/components.js')
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

test('a completed turn carries the model and mode it ran under', () => {
  const model = 'gpt-5.6-sol'
  const mode = 'xhigh'
  const turnStamp = `${model} · ${mode}`
  const chat = buildChat({ title: 'Lane', seed: 0, composerReason: 'Read only' })
  docRoot.appendChild(chat)

  const stream = chat.openStream({ turnStamp })
  stream.push('Answer in progress')
  /* Assert the positive state while the stream is open: without this, a row
     that never entered the busy state reads identically to one that completed
     (the DOM double returns null for never-set and removed alike). */
  const completed = chat.querySelectorAll('.msg').at(-1)
  assert.equal(completed.getAttribute('aria-busy'), 'true', 'the exercised row never entered its live state')
  stream.close('Completed answer')

  assert.equal(completed.getAttribute('aria-busy'), null, 'the exercised row did not complete')
  const stamp = completed.querySelector('.turn-stamp')
  assert.ok(stamp, 'the completed turn dropped its execution stamp')
  assert.match(stamp.textContent, new RegExp(model.replaceAll('.', '\\.')), 'the completed turn dropped the model it ran under')
  assert.match(stamp.textContent, new RegExp(mode), 'the completed turn dropped the mode it ran under')
  chat.dispose()
})
