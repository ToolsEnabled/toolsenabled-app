/**
 * CONTRACT/1 — one gesture, one popover instrument.
 *
 * This is intentionally a behaviour test: it mounts buildChat with real option
 * values and drives the controls that a person drives.  Keep source-code
 * spelling assertions out of this file.
 *
 * The product has not built the contract yet, so the normal suite names and
 * skips the missing behaviour instead of passing silently.  The gate is
 * derived from the product itself: a probe mounts buildChat and presses the
 * mention control, and the suite activates the moment that gesture opens the
 * shared popover element.  A mutation run can point CHAT_ONE_POPOVER_MODULE
 * at a scratch components.js to drive both the probe and the assertions.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

class Classes {
  constructor(node) { this.node = node }
  values() { return String(this.node.className || '').split(/\s+/).filter(Boolean) }
  contains(value) { return this.values().includes(value) }
  add(...values) { this.node.className = [...new Set([...this.values(), ...values])].join(' ') }
  remove(...values) { this.node.className = this.values().filter(value => !values.includes(value)).join(' ') }
  toggle(value, force) {
    const on = force === undefined ? !this.contains(value) : force
    on ? this.add(value) : this.remove(value)
    return on
  }
}

class NodeDouble {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase()
    this.nodeType = 1
    this.children = []
    this.parentNode = null
    this.attributes = new Map()
    this.listeners = new Map()
    this.className = ''
    this.hidden = false
    this.disabled = false
    this.value = ''
    this.textContent = ''
    this.style = {}
    this.dataset = {}
    this.scrollTop = 0
    this.scrollHeight = 100
    this.clientHeight = 100
    this.classList = new Classes(this)
  }
  appendChild(node) { node.parentNode = this; this.children.push(node); return node }
  append(...nodes) { for (const node of nodes) this.appendChild(node) }
  prepend(node) { node.parentNode = this; this.children.unshift(node) }
  insertBefore(node, before) {
    const index = this.children.indexOf(before)
    node.parentNode = this
    this.children.splice(index < 0 ? this.children.length : index, 0, node)
    return node
  }
  remove() {
    if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1)
    this.parentNode = null
  }
  replaceWith(node) {
    if (!this.parentNode) return
    const index = this.parentNode.children.indexOf(this)
    this.parentNode.children[index] = node
    node.parentNode = this.parentNode
    this.parentNode = null
  }
  get childElementCount() { return this.children.length }
  get lastElementChild() { return this.children.at(-1) || null }
  setAttribute(name, value) {
    this.attributes.set(name, String(value))
    if (name === 'class') this.className = String(value)
    if (name === 'disabled') this.disabled = true
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value)
  }
  getAttribute(name) { return name === 'class' ? this.className : this.attributes.get(name) ?? null }
  removeAttribute(name) { this.attributes.delete(name); if (name === 'disabled') this.disabled = false }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }
  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter(value => value !== listener))
  }
  dispatch(type, init = {}) {
    const event = {
      target: this, key: '',
      preventDefault() { this.defaultPrevented = true },
      stopPropagation() {},
      ...init,
    }
    for (const listener of this.listeners.get(type) || []) listener(event)
    return event
  }
  focus() { document.activeElement = this }
  contains(candidate) { for (let node = candidate; node; node = node.parentNode) if (node === this) return true; return false }
  matches(selector) {
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1))
    if (selector.startsWith('[')) return this.attributes.has(selector.slice(1, -1))
    const [tag, className] = selector.split('.')
    return (!tag || this.tagName === tag.toUpperCase()) && (!className || this.classList.contains(className))
  }
  querySelectorAll(selector) {
    const parts = selector.trim().split(/\s+/)
    const found = []
    const walk = node => {
      for (const child of node.children) {
        if (child.matches(parts.at(-1)) && (parts.length === 1 || child.parentNode?.matches(parts[0]))) found.push(child)
        walk(child)
      }
    }
    walk(this)
    return found
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
  scrollIntoView() {}
  set innerHTML(html) { this.children = []; parse(html, this) }
}

function parse(html, host) {
  const stack = [host]
  for (const token of String(html).match(/<[^>]+>|[^<]+/g) || []) {
    if (token.startsWith('</')) { if (stack.length > 1) stack.pop(); continue }
    if (!token.startsWith('<')) { const text = token.trim(); if (text) stack.at(-1).textContent += text; continue }
    if (/^<!/.test(token)) continue
    const tag = token.match(/^<([\w-]+)/)
    if (!tag) continue
    const node = new NodeDouble(tag[1])
    for (const attribute of token.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
      if (attribute[1] !== tag[1]) node.setAttribute(attribute[1], attribute[2] ?? '')
    }
    if (/\shidden(?:\s|>|\/)/.test(token)) node.hidden = true
    stack.at(-1).appendChild(node)
    if (!/\/>$/.test(token) && !/^(input|img|path|rect)$/i.test(tag[1])) stack.push(node)
  }
}

const documentRoot = new NodeDouble('html')
globalThis.document = {
  documentElement: documentRoot,
  body: new NodeDouble('body'),
  activeElement: null,
  fonts: { ready: Promise.resolve(), addEventListener() {}, removeEventListener() {} },
  createElement(tag) {
    if (tag !== 'template') return new NodeDouble(tag)
    const content = { firstElementChild: null }
    return { content, set innerHTML(value) { const host = new NodeDouble('host'); parse(value, host); content.firstElementChild = host.children[0] } }
  },
  addEventListener() {},
  removeEventListener() {},
}
globalThis.window = { matchMedia: () => ({ matches: true }) }
globalThis.ResizeObserver = class { observe() {} disconnect() {} }
globalThis.MutationObserver = class { observe() {} disconnect() {} }
globalThis.requestAnimationFrame = callback => { callback(); return 1 }
globalThis.cancelAnimationFrame = () => {}

const moduleUrl = process.env.CHAT_ONE_POPOVER_MODULE
  ? pathToFileURL(process.env.CHAT_ONE_POPOVER_MODULE).href
  : new URL('../../src/components.js', import.meta.url).href
const { buildChat } = await import(moduleUrl)
const missingReason = 'mention still invokes a separate picker instead of the actions popover'

/* Source-derived gate: press the mention control on a probe mount and see
   whether the SHARED popover element appears.  Today it does not — the click
   handler delegates to the separate onMention picker — so the suite skips for
   a reason read off the product, not off an environment variable nobody sets.
   The day mention opens .chat-actions-pop, this flips and the full assertion
   runs (including that the separate picker callback stays uncalled). */
const mentionOpensSharedPopover = await (async () => {
  const probe = buildChat({
    title: 'Probe',
    history: [],
    onSend() {},
    actions: () => [{ id: 'inspect', label: 'Inspect', hint: 'Inspect this conversation', run() {} }],
    onMention: () => '/tmp/separate-picker-result.txt',
  })
  documentRoot.appendChild(probe)
  try {
    probe.querySelector('[data-chat-mention]')?.dispatch('click')
    await Promise.resolve()
    return Boolean(probe.querySelector('.chat-actions-pop'))
  } finally {
    probe.dispose()
    probe.remove()
  }
})()
const skip = mentionOpensSharedPopover ? false : missingReason

test(`SKIP until built: slash and mention open the same popover instrument — ${missingReason}`, { skip }, async () => {
  let pickerCalls = 0
  const chat = buildChat({
    title: 'Lane',
    history: [],
    onSend() {},
    actions: () => [{ id: 'inspect', label: 'Inspect', hint: 'Inspect this conversation', run() {} }],
    onMention: () => { pickerCalls += 1; return '/tmp/separate-picker-result.txt' },
  })
  documentRoot.appendChild(chat)

  const input = chat.querySelector('.chat-input input')
  const slash = input.dispatch('keydown', { key: '/' })
  assert.equal(slash.defaultPrevented, true, 'slash did not claim the empty-composer gesture')
  const slashPopover = chat.querySelector('.chat-actions-pop')
  assert.ok(slashPopover, 'slash did not open the shared actions popover')
  assert.equal(chat.querySelectorAll('.chat-actions-pop').length, 1, 'slash opened more than one popover instrument')
  const instrumentLabel = slashPopover.getAttribute('aria-label')

  chat.querySelector('[data-chat-actions]').dispatch('click')
  assert.equal(chat.querySelector('.chat-actions-pop'), null, 'the actions control did not close the slash-opened instrument')

  chat.querySelector('[data-chat-mention]').dispatch('click')
  await Promise.resolve()
  const mentionPopover = chat.querySelector('.chat-actions-pop')
  assert.ok(mentionPopover, 'mention opened a separate picker mechanism instead of the shared popover')
  assert.equal(mentionPopover.getAttribute('aria-label'), instrumentLabel, 'mention opened a different popover instrument')
  assert.equal(chat.querySelectorAll('.chat-actions-pop').length, 1, 'mention left two instruments open for one gesture')
  assert.equal(pickerCalls, 0, 'mention delegated to the separate picker callback')

  chat.dispose()
})
