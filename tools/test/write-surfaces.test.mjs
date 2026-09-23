import assert from 'node:assert/strict'
import test, { afterEach, beforeEach } from 'node:test'

import { setBridgeTransport } from '../../src/mission-bridge.js'
import { mountAgentWriteSurface, mountLedgerWriteSurface } from '../../src/write-surfaces.js'

class Storage {
  values = new Map()
  getItem(key) { return this.values.get(key) ?? null }
  setItem(key, value) { this.values.set(key, String(value)) }
}

class Node {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null
    this.attributes = new Map(); this.dataset = {}; this.listeners = new Map()
    this.disabled = false; this.hidden = false; this.value = ''; this._text = ''
  }
  set textContent(value) { this._text = String(value); this.children = [] }
  get textContent() { return this.children.length ? this.children.map(node => node.textContent).join('') : this._text }
  set className(value) { this.setAttribute('class', value) }
  get className() { return this.getAttribute('class') || '' }
  set type(value) { this.setAttribute('type', value) }
  set name(value) { this.setAttribute('name', value) }
  set required(value) { this.toggleAttribute('required', value) }
  set readOnly(value) { this.toggleAttribute('readonly', value) }
  setAttribute(name, value) {
    const text = String(value); this.attributes.set(name, text)
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = text
    if (name === 'value') this.value = text
    if (name === 'hidden') this.hidden = true
  }
  getAttribute(name) { return this.attributes.get(name) ?? null }
  hasAttribute(name) { return this.attributes.has(name) }
  removeAttribute(name) { this.attributes.delete(name); if (name === 'hidden') this.hidden = false }
  toggleAttribute(name, force) { force ? this.setAttribute(name, '') : this.removeAttribute(name) }
  appendChild(child) {
    if (this._text) { const existing = Object.assign(new Node('#text'), { _text: this._text, parentNode: this }); this.children.push(existing); this._text = '' }
    child.parentNode = this; this.children.push(child); return child
  }
  append(...values) { for (const value of values) this.appendChild(value instanceof Node ? value : Object.assign(new Node('#text'), { _text: String(value) })) }
  replaceChildren(...children) { this.children = []; children.forEach(child => this.appendChild(child)) }
  insertAdjacentElement(_where, child) { if (!this.parentNode) return; const at = this.parentNode.children.indexOf(this); child.parentNode = this.parentNode; this.parentNode.children.splice(at + 1, 0, child) }
  addEventListener(type, listener) { this.listeners.set(type, [...(this.listeners.get(type) || []), listener]) }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this) }
  matches(selector) {
    const tag = selector.match(/^[a-z]+/i)?.[0]
    if (tag && this.tagName !== tag.toUpperCase()) return false
    for (const name of [...selector.matchAll(/\[([^\]=]+)(?:=["']?([^\]"']+)["']?)?\]/g)]) {
      if (!this.hasAttribute(name[1]) || (name[2] !== undefined && this.getAttribute(name[1]) !== name[2])) return false
    }
    const klass = selector.match(/\.([\w-]+)/)?.[1]
    return !klass || this.className.split(/\s+/).includes(klass)
  }
  querySelectorAll(selector) {
    const choices = selector.split(',').map(value => value.trim()); const found = []
    const visit = node => { for (const child of node.children) { if (choices.some(choice => child.matches(choice))) found.push(child); visit(child) } }
    visit(this); return found
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
  get elements() {
    const fields = this.querySelectorAll('input, textarea, select'); const result = {}
    for (const field of fields) if (field.getAttribute('name')) result[field.getAttribute('name')] = field
    return result
  }
}

function parse(html) {
  const decode = value => value.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&')
  const holder = new Node('holder'); const stack = [holder]
  for (const token of html.match(/<!--[\s\S]*?-->|<[^>]+>|[^<]+/g) || []) {
    if (token.startsWith('<!--')) continue
    if (token.startsWith('</')) { stack.pop(); continue }
    if (token.startsWith('<')) {
      const tag = token.match(/^<\s*([\w-]+)/)?.[1]; if (!tag) continue
      const node = new Node(tag)
      for (const attr of token.matchAll(/([:\w-]+)(?:="([^"]*)")?/g)) if (attr[1] !== tag) node.setAttribute(attr[1], decode(attr[2] ?? ''))
      stack.at(-1).appendChild(node)
      if (!/\/>$/.test(token) && !/^(input|br|hr)$/i.test(tag)) stack.push(node)
    } else if (token.trim()) stack.at(-1).append(token)
  }
  return holder.children[0]
}

const flush = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve() }
const rootWith = klass => { const root = new Node('main'); const anchor = new Node('div'); anchor.className = klass; root.appendChild(anchor); return root }
const controls = surface => surface.querySelectorAll('button, input, textarea, select')

beforeEach(() => {
  globalThis.localStorage = new Storage()
  globalThis.document = { createElement: tag => {
    const node = new Node(tag)
    if (tag === 'template') {
      node.content = { firstElementChild: null }
      Object.defineProperty(node, 'innerHTML', { set(value) { node.content.firstElementChild = parse(value) } })
    }
    return node
  } }
  globalThis.window = {}
})
afterEach(() => setBridgeTransport(null))

test('the agent page example fence cannot mount audited controls', () => {
  localStorage.setItem('mc.write.dispatch', 'enabled')
  const root = rootWith('agent-strip')
  const destroy = mountAgentWriteSurface(root, { agentId: 'sol', live: false })
  assert.equal(typeof destroy, 'function', 'the fenced caller still receives a safe destroy function')
  assert.equal(root.querySelector('.write-surface'), null, 'an example agent page must not acquire audited write controls')
})

test('real agent inputs are rendered as data and the visible assistant choices explain effort', async () => {
  localStorage.setItem('mc.write.dispatch', 'enabled')
  setBridgeTransport(async pathname => pathname === '/v1/runtime'
    ? { ok: true }
    : { ok: true, roots: ['owner/repo'], queues: {} })
  const root = rootWith('agent-strip')
  mountAgentWriteSurface(root, { agentId: 'nova"><script>bad()</script>', live: true })
  await flush()
  const surface = root.querySelector('.agent-write-surface')
  assert.ok(surface, 'a live agent page with dispatch enabled mounts its audited surface')
  assert.equal(surface.querySelector('[name="objectiveRef"]').value, 'agent-nova"><script>bad()</script>', 'caller-supplied agent ids stay data inside the objective field')
  assert.equal(surface.querySelector('script'), null, 'caller-supplied agent ids cannot create markup')
  const tier = surface.querySelector('[name="tier"]')
  const providers = tier.querySelectorAll('optgroup').map(group => group.getAttribute('label'))
  assert.deepEqual(providers, ['From OpenAI', 'From Anthropic'], 'assistant choices identify who provides them')
  const choices = tier.textContent
  assert.match(choices, /thinks (?:a little|harder|hardest)/, 'assistant choices explain the effort a user pays for')
  assert.ok(tier.querySelectorAll('optgroup')[0].children.every(option => /thinks\s+\S+/.test(option.textContent)), 'every assistant with an effort setting explains that effort')
})

test('an unreadable request register remains unknown and keeps decisions off', async () => {
  localStorage.setItem('mc.write.decision', 'enabled')
  setBridgeTransport(async pathname => pathname === '/v1/runtime'
    ? { ok: true }
    : { ok: true, roots: ['owner/repo'], queues: {} })
  const root = rootWith('ledger-toolbar'); let api
  mountLedgerWriteSurface(root, { onMount(value) { api = value } })
  api.showRegister({ kind: 'unreadable', items: [] })
  await flush()
  const surface = root.querySelector('.ledger-write-surface')
  const hint = surface.querySelector('[data-decision-hint]')
  assert.match(hint.textContent, /cannot check|until .* can be read/, 'a could-not-read register must say that its answer is still unknown')
  assert.ok(controls(surface.querySelector('[data-decision-form]')).every(control => control.disabled), 'an unreadable register must keep every decision control disabled after the bridge becomes ready')
  assert.doesNotMatch(hint.textContent, /nothing to approve/i, 'read failure must not collapse into a definite empty-register answer')
})

test('a status read refusal leaves the whole surface off and gives a retry path', async () => {
  localStorage.setItem('mc.write.decision', 'enabled')
  setBridgeTransport(async pathname => pathname === '/v1/runtime'
    ? { ok: true }
    : { ok: false, code: 'BRIDGE_STATUS_UNREADABLE', reason: 'the status snapshot could not be read' })
  const root = rootWith('ledger-toolbar')
  mountLedgerWriteSurface(root)
  await flush()
  const surface = root.querySelector('.ledger-write-surface')
  assert.equal(surface.dataset.bridgeState, 'unavailable', 'a failed status read must not mark the write surface ready')
  assert.ok(controls(surface.querySelector('[data-decision-form]')).every(control => control.disabled), 'a failed status read must leave every write control disabled')
  assert.equal(surface.querySelector('.write-status-retry').disabled, false, 'the retry remains available when ordinary write controls are off')
  assert.match(surface.querySelector('[data-write-status]').textContent, /could not be read[\s\S]*(?:Try|Retry|again)/i, 'the refusal keeps the diagnosis and supplies an actionable retry')
})

/* THE MOUNT HANDS BACK THE SAME SHAPE FROM EVERY WAY OUT OF THE FUNCTION.
 *
 * The default install has BOTH audited write flags off -- isWriteEnabled reads
 * localStorage and answers false when nothing is stored -- so the branch below
 * is the one every stranger's browser takes. It called `onMount` with the
 * SECTION ELEMENT while the branch with forms called it with `{ showRegister }`,
 * and src/views/ledger.js keeps `api.showRegister` from whatever arrives. What
 * it kept was `undefined`, and the first render threw "n is not a function" out
 * of renderRegister() before the loading state could be replaced: measured on
 * the served build 2026-08-28 in Chromium and WebKit alike, /app/#/ledger
 * stopped at "Reading your requests…" for good, every total reading
 * "— · unavailable", on first load and on hash navigation. A page that says it
 * is reading while nothing is reading is the worst of the states it could be
 * in, and one mismatched argument was the whole of it.
 *
 * This asserts the shape from BOTH exits, because a contract kept by one of two
 * branches is not a contract. */
test('every way out of the ledger mount hands the caller a callable showRegister', () => {
  for (const flags of [[], ['mc.write.decision'], ['mc.write.queue'], ['mc.write.decision', 'mc.write.queue']]) {
    globalThis.localStorage = new Storage()
    for (const flag of flags) localStorage.setItem(flag, 'enabled')
    const root = rootWith('ledger-toolbar')
    let api
    const destroy = mountLedgerWriteSurface(root, { onMount(value) { api = value } })
    const named = flags.length ? flags.join(' and ') : 'neither flag (the default install)'
    assert.equal(typeof destroy, 'function', `${named}: the caller is owed a destroy function`)
    assert.equal(typeof api?.showRegister, 'function',
      `${named}: onMount must be handed an object carrying showRegister, never an element — the ledger view keeps this value and calls it on every render`)
    /* And it survives the four register states the ledger view sends. The
       row-bearing call is deliberately left to the tests above: it swaps the
       target field for a picker through replaceWith, which this file's DOM
       stand-in does not implement, and a stand-in grown to satisfy a gate is a
       gate measuring the stand-in. */
    for (const kind of ['loading', 'unreadable', 'empty', 'live']) {
      api.showRegister({ kind, items: [] })
    }
    destroy()
  }
})

/* A DECISION THE FORM RECORDED CHANGES A ROW ON THE LIST BESIDE IT (T1278).
   The form used to say "Approved, with your reason, on the permanent record"
   while the row it approved kept reading "proposed" with Approve and Decline,
   so a Decline pressed there next declined the rule just approved. The form
   now tells its page after an accepted decision, and only then. */
test('the Approve or Decline form tells the Ledger to re-read after a recorded decision, and not after a refusal', async () => {
  localStorage.setItem('mc.write.decision', 'enabled')
  const replies = [{ ok: true, receipt: { revision: 7 } }, { ok: false, code: 'BRIDGE_DECISION_REFUSED', reason: 'refused' }]
  const posted = []
  setBridgeTransport(async (pathname, options = {}) => {
    if (pathname === '/v1/runtime') return { ok: true }
    if (options.method === 'POST') { posted.push({ pathname, body: options.body }); return replies.shift() }
    return { ok: true, roots: ['owner/repo'], queues: {} }
  })
  const FormDataBefore = globalThis.FormData
  globalThis.FormData = class { constructor(form) { this.form = form } get(name) { return this.form.elements[name]?.value ?? null } }
  try {
    const root = rootWith('ledger-toolbar')
    const changed = []
    mountLedgerWriteSurface(root, { onMount() {}, onChanged: change => changed.push(change) })
    await flush()
    const form = root.querySelector('[data-decision-form]')
    form.reportValidity = () => true
    form.elements.target.value = 'R15'
    form.elements.reason.value = 'Yes, this is what I meant.'
    const approve = form.querySelectorAll('button').find(button => button.dataset.decision === 'approve')
    const press = async () => { for (const listener of form.listeners.get('click') || []) await listener({ target: { closest: () => approve } }) }
    await press()
    await flush()
    assert.equal(posted.length, 1, 'the decision was not posted')
    assert.deepEqual(changed, [{ id: 'R15', decision: 'approve' }], 'a recorded decision did not tell the Ledger to re-read')
    await press()
    await flush()
    assert.equal(posted.length, 2)
    assert.equal(changed.length, 1, 'a refused decision told the Ledger something changed')
  } finally {
    if (FormDataBefore) globalThis.FormData = FormDataBefore
    else delete globalThis.FormData
    setBridgeTransport(null)
  }
})

/* THE QUEUE FORM ON AN INSTALL WITH ONE FOLDER AND NO WORK LIST (T1472). */
test('with one folder whose work list cannot be read, the queue line points at nothing that is not there', async () => {
  localStorage.setItem('mc.write.queue', 'enabled')
  setBridgeTransport(async pathname => pathname === '/v1/runtime'
    ? { ok: true }
    : { ok: true, roots: ['main'], queues: { main: { ok: false, reason: 'The root queue could not be read' } } })
  try {
    const root = rootWith('ledger-toolbar')
    mountLedgerWriteSurface(root, { onMount() {} })
    await flush()
    const form = root.querySelector('[data-queue-form]')
    const line = form.querySelector('[data-action-output]').textContent
    assert.match(line, /Claim and Close are off/)
    assert.doesNotMatch(line, /Choose another folder|press Retry above/, `advice that cannot be followed: ${line}`)
  } finally { setBridgeTransport(null) }
})
