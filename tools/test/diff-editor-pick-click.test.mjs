/* THE "CHOOSE A FILE" CONTROL, PRESSED -- NOT CALLED.
 *
 * diff-editor.test.mjs drives every pick in its 1247 lines through
 * `controller.pick(side)` directly -- fifteen call sites, none of them a
 * fired click. That proves the state machine pick() implements, but it
 * never once exercises src/diff-editor.js:637-648's onClick delegate for
 * `data-diff-action="pick"` (the branch at line 643), and it never proves
 * the button's own `disabled` attribute (src/diff-editor.js:351,
 * `${state.busy ? ' disabled' : ''}`) actually stops anything -- onClick
 * has no disabled check of its own; the whole of that enforcement is
 * pick()'s own `if (!state.sides[side] || state.busy) return`
 * (src/diff-editor.js:514). A markup change that renders `disabled` while
 * the click delegate still dispatches unconditionally would pass every
 * existing test in this suite and silently let a person queue a second
 * pick underneath the first.
 *
 * doctrine-02's spirit: press the control, not the function it happens to
 * call. This file fires real `click` events at the real button nodes
 * `diffEditorMarkup()` renders, routed through the real delegated
 * `onClick` listener `open()` registers on `root`, and reads what actually
 * ran off `files.calls` -- never a spy on `controller.pick` itself, which
 * would only prove the harness called what it meant to call.
 *
 * THE DOM HERE IS THE SAME SHAPE diff-editor.test.mjs ALREADY PROVED
 * CORRECT, duplicated rather than imported: this lane's brief is one new
 * test file, not a refactor of the existing 1247-line suite to export
 * shared infrastructure, and every other *.test.mjs in this tree that
 * needs a DOM carries its own (see tree-graph.js's tests in
 * drag-cannot-get-stuck.test.mjs). Only `host.fire()`'s click path is new
 * here in spirit -- diff-editor.test.mjs already builds it (newHost()) and
 * has simply never called it.
 *
 * Scope: this file only. No src/diff-editor.js edits -- a defect found
 * while writing this was reported, not fixed here.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { SIDES, createDiffEditor, diffEditorMarkup } from '../../src/diff-editor.js'

/* ------------------------------------------------------------------
   A DOM the size of what this module uses -- copied from
   diff-editor.test.mjs's own stand-in, which diffEditorMarkup()'s output
   is already proven against there. Not re-derived here.
   ------------------------------------------------------------------ */

const VOID_TAGS = new Set(['input', 'br', 'img', 'hr', 'meta', 'link'])

class Node {
  constructor(tagName) {
    this.tagName = tagName
    this.attributes = new Map()
    this.dataset = {}
    this.children = []
    this.parent = null
    this.listeners = new Map()
    this._text = ''
    this.disabled = false
  }

  get className() { return this.attributes.get('class') || '' }
  get isConnected() { return true }

  set textContent(value) { this._text = String(value); this.children = [] }
  get textContent() {
    return this.children.length ? this.children.map(child => child.textContent).join('') : this._text
  }

  set innerHTML(markup) {
    this.children = []
    this._text = ''
    for (const child of parseMarkup(String(markup))) {
      child.parent = this
      this.children.push(child)
    }
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)) }
  appendChild(node) { node.parent = this; this.children.push(node); return node }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(listener)
  }
  removeEventListener(type, listener) {
    const list = this.listeners.get(type) || []
    this.listeners.set(type, list.filter(entry => entry !== listener))
  }

  focus() {}

  walk(visit) { visit(this); for (const child of this.children) child.walk(visit) }

  matches(selector) {
    return selector.split(',').map(part => part.trim()).filter(Boolean).some(part => matchesCompound(this, part))
  }

  // THE EXACT METHOD src/diff-editor.js's onClick calls on event.target
  // (`event.target.closest('[data-diff-action]')`, line 638). If this
  // returns the wrong node, or none, the delegate this file is proving
  // would silently do nothing in a real browser too -- so this must walk
  // ancestors precisely the way a real DOM does.
  closest(selector) {
    let node = this
    while (node) {
      if (node.matches(selector)) return node
      node = node.parent
    }
    return null
  }

  querySelector(selector) {
    let hit = null
    this.walk(node => { if (!hit && node !== this && node.matches(selector)) hit = node })
    return hit
  }

  querySelectorAll(selector) {
    const out = []
    this.walk(node => { if (node !== this && node.matches(selector)) out.push(node) })
    return out
  }
}

function matchesSimple(node, token) {
  if (token.startsWith('.')) return node.className.split(/\s+/).includes(token.slice(1))
  if (token.startsWith('[')) {
    const inner = token.slice(1, -1)
    const equals = inner.indexOf('=')
    if (equals === -1) {
      if (inner === 'disabled') return node.disabled === true
      return node.attributes.has(inner)
    }
    const name = inner.slice(0, equals)
    const value = inner.slice(equals + 1).replace(/^["']|["']$/g, '')
    return node.attributes.get(name) === value
  }
  return node.tagName === token
}

function matchesCompound(node, selector) {
  const tokens = selector.match(/:not\([^)]*\)|\[[^\]]*\]|\.[A-Za-z0-9_-]+|[A-Za-z][A-Za-z0-9-]*/g) || []
  return tokens.every(token => (token.startsWith(':not(')
    ? !matchesSimple(node, token.slice(5, -1))
    : matchesSimple(node, token)))
}

function decodeEntities(value) {
  return value
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

function parseMarkup(markup) {
  const roots = []
  const stack = []
  const pattern = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^<>"']+(?:="[^"]*")?)*)\s*\/?>/g
  let cursor = 0
  let match
  const addText = text => {
    if (!text.trim()) return
    const parent = stack[stack.length - 1]
    if (parent) parent._text += decodeEntities(text)
  }
  while ((match = pattern.exec(markup)) !== null) {
    addText(markup.slice(cursor, match.index))
    cursor = match.index + match[0].length
    const tag = match[1].toLowerCase()
    if (match[0].startsWith('</')) {
      const closed = stack.pop()
      assert.equal(closed?.tagName, tag, `the markup closed <${tag}> while inside <${closed?.tagName}>`)
      continue
    }
    const node = new Node(tag)
    for (const attribute of match[2].matchAll(/([a-zA-Z][a-zA-Z0-9:-]*)(?:="([^"]*)")?/g)) {
      const name = attribute[1]
      if (!name) continue
      const value = attribute[2] === undefined ? '' : decodeEntities(attribute[2])
      node.attributes.set(name, value)
      if (name === 'disabled') node.disabled = true
      if (name.startsWith('data-')) {
        const key = name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
        node.dataset[key] = value
      }
    }
    const parent = stack[stack.length - 1]
    if (parent) { node.parent = parent; parent.children.push(node) } else roots.push(node)
    if (!VOID_TAGS.has(tag) && !match[0].endsWith('/>')) stack.push(node)
  }
  addText(markup.slice(cursor))
  assert.equal(stack.length, 0, 'the markup left an element open')
  return roots
}

const activeDocument = {
  createElement: tag => new Node(tag),
  activeElement: null,
  addEventListener() {},
  removeEventListener() {},
}

function newHost() {
  const host = new Node('div')
  // THE CLICK ITSELF. A real browser builds this MouseEvent for us; here it
  // is built by hand and handed to whatever `root.addEventListener('click',
  // onClick)` registered -- the exact call src/diff-editor.js's open()
  // makes (line 686). No stopPropagation/bubbling model is needed because
  // the delegate lives on root itself, matching the module's own listener
  // placement.
  host.fire = (type, target, extra = {}) => {
    const event = { type, target, ...extra, preventDefault: () => {} }
    for (const listener of [...(host.listeners.get(type) || [])]) listener(event)
  }
  return host
}

function fakeFiles({ queue = [] } = {}) {
  const calls = []
  return {
    calls,
    queue,
    async pick(side) {
      calls.push(['pick', side])
      const next = queue.shift()
      if (!next) return { ok: true, canceled: true }
      return { ok: true, canceled: false, path: next.path, text: next.text, bytes: next.text.length, modifiedMs: 500 }
    },
    async stamp() { return { ok: true, exists: false, modifiedMs: null, bytes: null } },
    async save() { return { ok: true, modifiedMs: 500, bytes: 0 } },
  }
}

function mount(options = {}) {
  const host = newHost()
  const files = options.files || fakeFiles()
  const controller = createDiffEditor({
    documentRef: activeDocument,
    files,
    prefs: { read: () => null, write: () => {} },
    onClose: () => {},
  })
  controller.open(host)
  return { host, files, controller }
}

const pickButton = (host, side) => host.querySelector(`.diff-choose[data-diff-side="${side}"]`)

// Lets every pending microtask from an un-awaited `void pick(side)` drain
// (fakeFiles.pick() has no internal await, so `await files.pick(side)`
// resolves after one microtask tick, and pick()'s own continuation after
// that needs a second) before the test reads state that only settles once
// the whole chain has run. A macrotask boundary drains all of them at once.
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

/* ------------------------------------------------------------------
   1. THE PRESS REACHES THE RIGHT VERB WITH THE RIGHT SIDE
   ------------------------------------------------------------------ */

test('a fired click on the Choose control invokes files.pick through the real onClick delegate', async () => {
  const harness = mount({ files: fakeFiles({ queue: [{ path: 'W/original.txt', text: 'hello\n' }] }) })
  const button = pickButton(harness.host, 'original')
  assert.ok(button, 'the original side\'s Choose control was not found in the rendered markup')
  assert.equal(button.disabled, false, 'the control must not start disabled')

  harness.host.fire('click', button)
  await settle()

  assert.deepEqual(harness.files.calls, [['pick', 'original']],
    'the click must reach files.pick exactly once, for the side the button was rendered for')
  assert.equal(harness.controller.state.sides.original.path, 'W/original.txt',
    'the pressed control must actually land the picked file in state, the same as a direct call would')
})

test('the two Choose controls route to their own side, never the other one\'s', async () => {
  const harness = mount({
    files: fakeFiles({ queue: [{ path: 'W/original.txt', text: 'left\n' }, { path: 'W/proposed.txt', text: 'right\n' }] }),
  })
  harness.host.fire('click', pickButton(harness.host, 'original'))
  await settle()
  harness.host.fire('click', pickButton(harness.host, 'proposed'))
  await settle()

  assert.deepEqual(harness.files.calls, [['pick', 'original'], ['pick', 'proposed']],
    'clicking the proposed side\'s control must not repeat or swap the original side\'s pick')
  assert.equal(harness.controller.state.sides.original.path, 'W/original.txt')
  assert.equal(harness.controller.state.sides.proposed.path, 'W/proposed.txt',
    'the proposed pane must hold the file its OWN control picked, not the original pane\'s file')
})

/* ------------------------------------------------------------------
   2. THE DISABLED CONTROL GENUINELY BLOCKS A PRESS, BOTH DIRECTIONS
   ------------------------------------------------------------------ */

test('a press on an enabled Choose control is accepted, and the same control renders disabled while the pick is in flight', async () => {
  const harness = mount({ files: fakeFiles({ queue: [{ path: 'W/original.txt', text: 'hello\n' }] }) })

  // pick() sets state.busy and calls render() SYNCHRONOUSLY before its first
  // await (src/diff-editor.js:514-519), so by the time fire() returns, the
  // freshly re-rendered button already carries `disabled`.
  harness.host.fire('click', pickButton(harness.host, 'original'))
  const midFlight = pickButton(harness.host, 'original')
  assert.equal(midFlight.disabled, true,
    'the control must render disabled the instant a pick starts, before the file dialog result is even back')

  await settle()
  assert.equal(harness.files.calls.length, 1, 'the in-flight pick itself must still have fired exactly once')
  assert.equal(pickButton(harness.host, 'original').disabled, false,
    'the control must return to enabled once the pick actually finishes')
})

test('a fired click on a disabled Choose control does nothing -- the busy guard actually blocks it, not just the markup', async () => {
  const harness = mount({
    files: fakeFiles({ queue: [{ path: 'W/original.txt', text: 'first\n' }, { path: 'W/second.txt', text: 'second\n' }] }),
  })

  // First press: accepted, and leaves the control disabled mid-flight.
  harness.host.fire('click', pickButton(harness.host, 'original'))
  const disabledButton = pickButton(harness.host, 'original')
  assert.equal(disabledButton.disabled, true, 'setup: the control must be disabled before the second press is attempted')

  // Second press, fired at the SAME node onClick would see if a real browser
  // let a disabled button's click through (it would not; this proves the
  // code does not depend on that browser behaviour to stay safe). onClick
  // has no disabled check of its own (src/diff-editor.js:637-648) -- the
  // only thing that can stop this is pick()'s own busy guard.
  harness.host.fire('click', disabledButton)
  await settle()

  assert.deepEqual(harness.files.calls, [['pick', 'original']],
    'a second press while the first pick was still in flight must not reach files.pick at all -- got a second call, so the busy guard did not hold')
  assert.equal(harness.controller.state.sides.original.path, 'W/original.txt',
    'the side must still hold the FIRST picked file -- a leaked second pick would have overwritten it with the queued second file')
})
