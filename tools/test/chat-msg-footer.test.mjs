/* THE EVIDENCE ABOUT A MESSAGE IS NOT A WORD IN ITS LAST SENTENCE.
 *
 * Every shared chat surface -- the agent page, the tree node popup, the
 * computers page -- draws its rows through buildChat's makeMsg. The clock and
 * the execution stamp used to be appended straight onto the row, as siblings
 * of the body, so they became the row's own last inline content: a turn that
 * ended in a list or a fenced block had a timestamp hanging off the end of it,
 * and a turn that ended in prose had the stamp joining the sentence. They are
 * evidence ABOUT the turn, so they now sit together in one quiet footer
 * beneath it and the words end where the writer ended them.
 *
 * WHAT THIS PINS, and why each half is load-bearing:
 *
 *   THE FOOTER IS A CHILD OF THE ROW, AFTER THE BODY. Not inside the body --
 *     that is the defect itself, an element of chrome inside the words -- and
 *     not before it. src/styles.css dresses `.chat-msg-footer` and
 *     `.chat-msg-footer > *` at exactly that depth.
 *
 *   IT HOLDS BOTH STAMPS. The clock and the execution stamp are one band, so
 *     a row carrying both spends one line on them rather than two.
 *
 *   IT DOES NOT EXIST WHEN THERE IS NOTHING TO PUT IN IT. A product note
 *     carries neither, and an empty footer is a blank band of margin under a
 *     row -- the visible defect this whole change is against.
 *
 * DRIVEN, NOT READ. buildChat is called through its public doors (a restored
 * history, and openStream/close for a live turn) and the DOM it builds is
 * observed. Nothing here inspects components.js source text, and nothing here
 * finds the stamps by a depth-agnostic selector: `[data-chat-message-time]`
 * anywhere in the row passes whether or not the wrapper exists, which is
 * exactly the gap this file closes.
 *
 * RUN IT:
 *   node tools/test/chat-msg-footer.test.mjs
 */
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

const AT = Date.UTC(2026, 0, 15, 18, 42, 5, 250)
const LATER = AT + 20_000

/* The one structural question, asked of a row rather than of the document:
   which of the row's OWN children is the footer, and where does it sit. */
const footerOf = (row) => row.children.filter(child => child.classList.contains('chat-msg-footer'))
const bodyOf = (row) => row.children.find(child => child.classList.contains('chat-msg-text'))

function mount(options) {
  const chat = buildChat({ title: 'Lane', seed: 0, composerReason: 'Read only', ...options })
  docRoot.appendChild(chat)
  return chat
}

test('a restored spoken row keeps its clock in a footer beneath the words', () => {
  const chat = mount({ history: [{ who: 'you', text: 'the message body', at: AT }] })
  try {
    const row = chat.querySelectorAll('.msg').at(-1)
    assert.ok(row, 'the fixture must put a row on the glass or nothing below is exercised')
    const footers = footerOf(row)
    assert.equal(footers.length, 1, `the row must own exactly one footer; children: ${row.children.map(c => `${c.tagName}.${c.className}`).join(' | ')}`)

    const body = bodyOf(row)
    assert.ok(body, 'the row must still own its body')
    assert.ok(row.children.indexOf(footers[0]) > row.children.indexOf(body),
      'the evidence sits BENEATH the words, never above them')

    const time = row.querySelector('[data-chat-message-time]')
    assert.ok(time, 'the clock must still be drawn')
    assert.equal(time.parentNode, footers[0],
      `the clock belongs to the footer, not to the row; it hung off ${time.parentNode?.className}`)
    assert.equal(body.querySelectorAll('[data-chat-message-time]').length, 0,
      'a clock inside the words is the defect this footer exists against')
  } finally { chat.dispose() }
})

test('the clock and the execution stamp share one band', () => {
  const chat = mount({ history: [] })
  try {
    const stream = chat.openStream({ at: AT, turnStamp: 'gpt-5.6-sol · xhigh' })
    stream.push('answering')
    stream.close('the finished answer')

    const row = chat.querySelectorAll('.msg').at(-1)
    const footers = footerOf(row)
    assert.equal(footers.length, 1, 'two stamps must not become two bands')

    const time = footers[0].querySelector('[data-chat-message-time]')
    const stamp = footers[0].querySelector('.turn-stamp')
    assert.ok(time, `the clock must be in the footer; footer held: ${footers[0].children.map(c => c.tagName).join(' | ')}`)
    assert.ok(stamp, `the execution stamp must be in the footer; footer held: ${footers[0].children.map(c => c.tagName).join(' | ')}`)
    assert.equal(stamp.textContent, 'gpt-5.6-sol · xhigh', 'and it is the stamp the caller supplied')

    const body = bodyOf(row)
    assert.equal(body.querySelectorAll('.turn-stamp').length, 0,
      'the stamp is evidence about the turn, not the turn\'s own last words')
    assert.ok(row.children.indexOf(footers[0]) > row.children.indexOf(body))
  } finally { chat.dispose() }
})

test('a turn with no execution stamp still gets a footer for its clock alone', () => {
  const chat = mount({ history: [] })
  try {
    const stream = chat.openStream({ at: AT })
    stream.close('an answer from a source that named no model')

    const row = chat.querySelectorAll('.msg').at(-1)
    const footers = footerOf(row)
    assert.equal(footers.length, 1, 'the clock alone is still evidence and still gets its band')
    assert.equal(footers[0].querySelectorAll('.turn-stamp').length, 0,
      'and no stamp is invented for a source that supplied none')
    assert.ok(footers[0].querySelector('[data-chat-message-time]'), 'the clock is in it')
  } finally { chat.dispose() }
})

test("a row with nothing to say about itself grows no empty band", () => {
  /* A product note carries neither a spoken clock nor an execution stamp
     (tools/test/chat-message-timestamps.test.mjs pins the first half of that
     rule). An empty footer would still spend its margin, which is a blank
     strip under the note -- visible, and the opposite of the point. */
  const chat = mount({ history: [{ who: 'note', text: 'the product said something about the run', at: AT }] })
  try {
    const note = chat.querySelectorAll('.msg').find(row => row.classList.contains('note'))
    assert.ok(note, 'the fixture must put a note on the glass')
    assert.equal(footerOf(note).length, 0,
      `a row with no evidence must own no footer; children: ${note.children.map(c => `${c.tagName}.${c.className}`).join(' | ')}`)
    assert.equal(note.querySelectorAll('.chat-msg-footer').length, 0, 'and none anywhere inside it')
  } finally { chat.dispose() }
})

test('every spoken row in a restored conversation is built the same way', () => {
  /* One row proves the wrapper exists; the conversation proves it is how the
     component builds rows rather than a special case on one path. */
  const chat = mount({
    history: [
      { who: 'you', text: 'the question', at: AT },
      { who: 'agent', text: '## A heading\n\n- and a list item', at: LATER, turnStamp: 'claude-opus · high' },
    ],
  })
  try {
    const rows = chat.querySelectorAll('.msg').filter(row => row.classList.contains('me') || row.classList.contains('them'))
    assert.equal(rows.length, 2, `both spoken rows must be drawn; drew ${rows.length}`)
    for (const row of rows) {
      const footers = footerOf(row)
      assert.equal(footers.length, 1, `every spoken row owns one footer; ${row.className} owned ${footers.length}`)
      assert.ok(row.children.indexOf(footers[0]) > row.children.indexOf(bodyOf(row)),
        `${row.className} put its evidence above its words`)
    }
    /* The agent's row is the one that ends in block markup, which is the shape
       the old layout broke on: a timestamp appended after a list. */
    const agentRow = rows.find(row => row.classList.contains('them'))
    assert.ok(bodyOf(agentRow).querySelectorAll('li').length > 0, 'the agent turn really does end in a list here')
    assert.equal(bodyOf(agentRow).querySelectorAll('.chat-msg-footer').length, 0,
      'and the footer is not swept into the list it follows')
  } finally { chat.dispose() }
})
