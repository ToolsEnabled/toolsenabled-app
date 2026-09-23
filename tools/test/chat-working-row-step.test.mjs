import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { WORKING_CANCEL } from '../../src/chat-copy.js'

class Classes {
  constructor(node) { this.node = node }
  values() { return String(this.node.className || '').split(/\s+/).filter(Boolean) }
  contains(value) { return this.values().includes(value) }
  add(...values) { this.node.className = [...new Set([...this.values(), ...values])].join(' ') }
  remove(...values) { this.node.className = this.values().filter(value => !values.includes(value)).join(' ') }
  toggle(value, force) { const enabled = force === undefined ? !this.contains(value) : force; enabled ? this.add(value) : this.remove(value); return enabled }
}

class NodeDouble {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.nodeType = 1; this.children = []; this.parentNode = null
    this.attributes = new Map(); this.listeners = new Map(); this.className = ''; this.hidden = false
    this.value = ''; this.textContent = ''; this.style = {}; this.dataset = {}; this.scrollTop = 0
    this.scrollHeight = 100; this.clientHeight = 100; this.classList = new Classes(this)
  }
  appendChild(node) { node.parentNode = this; this.children.push(node); return node }
  append(...nodes) { for (const node of nodes) this.appendChild(typeof node === 'string' ? Object.assign(new NodeDouble('span'), { textContent: node }) : node) }
  prepend(node) { node.parentNode = this; this.children.unshift(node) }
  insertBefore(node, at) { const index = this.children.indexOf(at); node.parentNode = this; this.children.splice(index < 0 ? this.children.length : index, 0, node); return node }
  remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null }
  replaceWith(node) { if (!this.parentNode) return; const index = this.parentNode.children.indexOf(this); this.parentNode.children[index] = node; node.parentNode = this.parentNode; this.parentNode = null }
  get childElementCount() { return this.children.length }
  get lastElementChild() { return this.children.at(-1) || null }
  setAttribute(key, value) { this.attributes.set(key, String(value)); if (key === 'class') this.className = String(value); if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value) }
  getAttribute(key) { return key === 'class' ? this.className : this.attributes.get(key) ?? null }
  removeAttribute(key) { this.attributes.delete(key) }
  addEventListener(type, listener) { const listeners = this.listeners.get(type) || []; listeners.push(listener); this.listeners.set(type, listeners) }
  removeEventListener() {}
  dispatch(type, init = {}) { const event = { target: this, key: '', preventDefault() {}, stopPropagation() {}, ...init }; for (const listener of this.listeners.get(type) || []) listener(event); return event }
  focus() { document.activeElement = this }
  contains(node) { for (let at = node; at; at = at.parentNode) if (at === this) return true; return false }
  matches(selector) { if (selector.startsWith('.')) return this.classList.contains(selector.slice(1)); if (selector.startsWith('[')) return this.attributes.has(selector.slice(1, -1).split('=')[0]); const [tag, className] = selector.split('.'); return (!tag || this.tagName === tag.toUpperCase()) && (!className || this.classList.contains(className)) }
  querySelectorAll(selector) { const parts = selector.trim().split(/\s+/); const found = []; const walk = node => { for (const child of node.children) { if (child.matches(parts.at(-1)) && (parts.length === 1 || child.parentNode?.matches(parts[0]))) found.push(child); walk(child) } }; walk(this); return found }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
  scrollIntoView() {}
  set innerHTML(markup) { this.children = []; parse(markup, this) }
}

function parse(markup, host) {
  const stack = [host]
  for (const token of String(markup).match(/<[^>]+>|[^<]+/g) || []) {
    if (token.startsWith('</')) { if (stack.length > 1) stack.pop(); continue }
    if (!token.startsWith('<')) { const words = token.trim(); if (words) stack.at(-1).textContent += words; continue }
    if (/^<!/.test(token)) continue
    const match = token.match(/^<([\w-]+)/); if (!match) continue
    const node = new NodeDouble(match[1])
    for (const attribute of token.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) if (attribute[1] !== match[1]) node.setAttribute(attribute[1], attribute[2] ?? '')
    if (/\shidden(?:\s|>|\/)/.test(token)) node.hidden = true
    stack.at(-1).appendChild(node)
    if (!/\/>$/.test(token) && !/^(input|img|path|rect)$/i.test(match[1])) stack.push(node)
  }
}

const documentRoot = new NodeDouble('html')
globalThis.document = {
  documentElement: documentRoot, body: new NodeDouble('body'), activeElement: null,
  fonts: { ready: Promise.resolve(), addEventListener() {}, removeEventListener() {} },
  createElement(tag) {
    if (tag !== 'template') return new NodeDouble(tag)
    const content = { firstElementChild: null }
    return { content, set innerHTML(markup) { const host = new NodeDouble('host'); parse(markup, host); content.firstElementChild = host.children[0] } }
  },
  addEventListener() {}, removeEventListener() {},
}
globalThis.window = { matchMedia: () => ({ matches: true }) }
globalThis.ResizeObserver = class { observe() {} disconnect() {} }
globalThis.MutationObserver = class { observe() {} disconnect() {} }
globalThis.requestAnimationFrame = callback => { callback(); return 1 }
globalThis.cancelAnimationFrame = () => {}

async function requireWorkingRow(buildChat) {
  let cancelCalls = 0
  let notifyStatus = () => {}
  let busy = false
  let step = ''
  const chat = buildChat({
    title: 'Researcher',
    onSend() {},
    onStop: () => { cancelCalls += 1 },
    status: {
      busy: () => busy,
      step: () => step,
      subscribe(listener) { notifyStatus = listener; return () => {} },
    },
  })
  const row = chat.querySelector('.working-step')
  assert.equal(row.hidden, true, 'an idle turn must not claim that work is running')

  busy = true
  step = 'Reading the deployment notes'
  notifyStatus()
  assert.equal(row.hidden, false, 'the working row must appear while the turn runs')
  assert.equal(row.querySelector('span').textContent, step, 'the working row must name the current step supplied by status.step()')
  assert.equal(row.querySelector('button').textContent, WORKING_CANCEL, 'the running step must offer the visible cancel action, worded by chat-copy WORKING_CANCEL')
  row.querySelector('button').dispatch('click')
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(cancelCalls, 1, 'Cancel must invoke the turn stop handler')
}

test('the working row names the current step and offers Cancel while a turn runs (mutation checked)', async () => {
  const componentUrl = new URL('../../src/components.js', import.meta.url)
  const { buildChat } = await import(componentUrl.href)
  await requireWorkingRow(buildChat)

  /* Prove the assertions measure the behavior rather than merely traversing
     the mounted shape: run the same value-driven contract against a scratch
     module whose visibility decision is inverted. The scratch module lives
     beside the original only so its relative imports remain the real ones. */
  const source = await readFile(componentUrl, 'utf8')
  const original = 'working.hidden = !step'
  assert.equal(source.split(original).length - 1, 1, 'the mutation seam must remain unique')
  const scratchPath = fileURLToPath(new URL(`../../src/.chat-working-row-step-${process.pid}.mutation.mjs`, import.meta.url))
  await writeFile(scratchPath, source.replace(original, 'working.hidden = Boolean(step)'))
  try {
    const mutated = await import(`${pathToFileURL(scratchPath).href}?mutation=${Date.now()}`)
    await assert.rejects(requireWorkingRow(mutated.buildChat),
      'inverting working-row visibility must make this behavior test red')
  } finally {
    await unlink(scratchPath).catch(() => {})
  }
})

test('a busy agent without a step still shows thinking and clears when idle', async () => {
  const { buildChat } = await import('../../src/components.js')
  let busy = true, notify
  const chat = buildChat({ title: 'Researcher', onSend() {}, status: {
    busy: () => busy, step: () => ' ', subscribe(listener) { notify = listener; return () => {} },
  } })
  const row = chat.querySelector('.working-step')
  assert.equal(row.hidden, false)
  assert.equal(row.querySelector('[data-chat-working-step]').textContent, 'Thinking')
  assert.equal(row.querySelector('button'), null, 'no stop control is invented without a stop handler')
  busy = false
  notify()
  assert.equal(row.hidden, true)
  chat.dispose()
})

test('a stream without a status provider transitions from thinking to writing to idle', async () => {
  const { buildChat } = await import('../../src/components.js')
  const chat = buildChat({ title: 'Researcher', onSend() {} })
  const row = chat.querySelector('.working-step')
  const stream = chat.openStream()
  assert.equal(row.hidden, false)
  assert.equal(row.querySelector('[data-chat-working-step]').textContent, 'Thinking')
  stream.push('The result is ready.')
  assert.equal(row.querySelector('[data-chat-working-step]').textContent, 'Writing a reply')
  stream.close()
  assert.equal(row.hidden, true)
  const count = chat.querySelectorAll('.msg').length
  const silent = chat.openStream()
  silent.close(' ')
  assert.equal(chat.querySelectorAll('.msg').length, count, 'a turn without reply text leaves no empty bubble')
  chat.dispose()
})

test('pending approval pauses the activity indication and resolution restores the observed turn phase', async () => {
  const { buildChat } = await import('../../src/components.js')
  const chat = buildChat({ title: 'Researcher', onSend() {}, onApprovalDecision() {} })
  const row = chat.querySelector('.working-step')
  const stream = chat.openStream()
  stream.push('I found the requested change.')
  chat.showApproval({ id: 'permission-1', summary: 'Run the requested checks', badges: [] })
  assert.equal(row.hidden, false)
  assert.equal(row.querySelector('[data-chat-working-step]').textContent, 'Waiting for your approval')
  assert.equal(row.getAttribute('data-activity-phase'), 'waiting')
  chat.resolveApproval('permission-1')
  assert.equal(row.getAttribute('data-activity-phase'), 'responding')
  stream.close()
  assert.equal(row.hidden, true)
  chat.showApproval({ id: 'permission-2', summary: 'Approve the next action', badges: [] })
  assert.equal(row.hidden, false, 'a pending source approval remains visible without a busy feed')
  chat.resolveApproval('permission-2')
  assert.equal(row.hidden, true)
  chat.dispose()
})
