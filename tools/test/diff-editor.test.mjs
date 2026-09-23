/* THE SPLIT COMPARE WINDOW, DRIVEN.
 *
 * The controller in src/diff-editor.js takes its file verb and its settings
 * store as arguments precisely so this file does not have to read its source
 * and guess. Every test below presses the real controls through a DOM, against
 * an in-memory disk, and then reads that disk to see what actually landed --
 * the sweep of this repository that found twenty-one suites pinning an
 * implementation's SPELLING is the reason this one is shaped this way.
 *
 * THE DOM HERE IS SMALL AND REAL ENOUGH TO BE HONEST. The controller sets
 * innerHTML and then queries what came out, so a stub that recorded the string
 * would test nothing about the wiring. The parser below is about eighty lines
 * and understands exactly the markup this module writes; if the module ever
 * emits something it cannot read, the queries return null and the tests fail,
 * which is the correct direction.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  MAX_FILE_BYTES,
  SIDES,
  WARNING_PREFERENCE_KEY,
  createCompareFilesDoor,
  createDiffEditor,
  diffEditorMarkup,
  dominantLineEnding,
  emptyDiffEditorState,
  paneIsDirty,
  refusalSentence,
  saveBlockedReason,
  stateIsDirty,
  warningLines,
} from '../../src/diff-editor.js'
import { sessionActivityEvent } from '../../src/agent-session-events.js'
import { CHANGE_LIMITS, createConfirmedFileChangeBuffer } from '../../src/session-change-patches.js'
import { createSessionChangeStore } from '../../src/chat-session-changes.js'

test('unknown session counts are explicit instead of displaying zero deltas', () => {
  const state = emptyDiffEditorState()
  state.change = { path: '/work/changed.js', added: 0, removed: 0, edits: 1, unmeasuredEdits: 1, patches: [] }
  const markup = diffEditorMarkup(state)
  assert.match(markup, /Line counts unavailable/)
  assert.doesNotMatch(markup, /diff-total-added/)
  assert.doesNotMatch(markup, /0 recorded lines added/)
  state.change = { ...state.change, added: 7, removed: 2, edits: 2 }
  const partial = diffEditorMarkup(state)
  assert.match(partial, /\+7\*/)
  assert.match(partial, /−2\*/)
  assert.match(partial, /additional line counts unavailable/)
})

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const require = createRequire(import.meta.url)

/* ------------------------------------------------------------------
   A DOM the size of what this module uses, and no larger.
   ------------------------------------------------------------------ */

const VOID_TAGS = new Set(['input', 'br', 'img', 'hr', 'meta', 'link'])
const FOCUSABLE_TAGS = new Set(['button', 'input', 'select', 'textarea', 'a'])

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
    this.hidden = false
    this.checked = false
    this._value = ''
  }

  /* A <textarea>'s `value` GETTER RETURNS THE API VALUE, NOT WHAT WAS STORED.
     Per HTML ("the textarea element"), the API value is the raw value with
     every CRLF pair and every lone CR replaced by a single LF; the setter keeps
     what it was given. A stand-in with a plain `value` field cannot see a
     module that reads a file's bytes back out of a box that never held them --
     and the first draft of this suite could not: a Windows file lost every line
     ending on its first keystroke while the window said the file on disk now
     matched. Getting this one accessor right is what makes the tests below able
     to fail. */
  set value(next) { this._value = String(next) }
  get value() {
    const raw = this._value
    /* The scan before the rewrite is not an optimisation of the browser's
       behaviour, it is what keeps this stand-in from dominating the keystroke
       measurement below: a file with no carriage return in it needs no rewrite,
       and every file in that test is one. */
    if (this.tagName !== 'textarea' || raw.indexOf('\r') === -1) return raw
    return raw.replace(/\r\n?/g, '\n')
  }

  get className() { return this.attributes.get('class') || '' }
  get isConnected() { return true }

  get tabIndex() {
    if (this.attributes.has('tabindex')) return Number(this.attributes.get('tabindex'))
    return FOCUSABLE_TAGS.has(this.tagName) ? 0 : -1
  }

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

  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node) } }
  appendChild(node) { this.append(node); return node }
  remove() {
    if (!this.parent) return
    this.parent.children = this.parent.children.filter(child => child !== this)
    this.parent = null
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)) }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(listener)
  }
  removeEventListener(type, listener) {
    const list = this.listeners.get(type) || []
    this.listeners.set(type, list.filter(entry => entry !== listener))
  }

  focus() { activeDocument.activeElement = this }

  walk(visit) { visit(this); for (const child of this.children) child.walk(visit) }

  matches(selector) {
    return selector.split(',').map(part => part.trim()).filter(Boolean).some(part => matchesCompound(this, part))
  }

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

/* tag, .class, [attr], [attr="value"] and :not(<one of those>), which is every
   shape src/diff-editor.js asks for -- including its FOCUSABLE list. */
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

function parseMarkup(markup) {
  const roots = []
  const stack = []
  const pattern = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^<>"']+(?:="[^"]*")?)*)\s*\/?>/g
  let cursor = 0
  let match
  /* Text is decoded exactly as attribute values are, and for the same reason: a
     real DOM's textContent hands back the characters, not the entities the
     markup spelled them with. Without this an assertion cannot tell a name that
     was correctly escaped from one that was mangled. */
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
      if (name === 'hidden') node.hidden = true
      if (name === 'checked') node.checked = true
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

function decodeEntities(value) {
  return value
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/* Text nodes are stored on `_text` by the parser, and this module renders its
   copy as the only text inside its elements, so textContent reads back what
   was written. Entities are decoded above so an assertion can compare a
   sentence to the sentence. */
const activeDocument = {
  activeElement: null,
  listeners: new Map(),
  /* Enough of a document for the door below: it makes a host node, puts it on
     the body, and has to be able to take it off again. The node it hands back
     is the same one `newHost()` builds, so a test can fire events at a window
     the door mounted without reaching inside it. */
  body: new Node('body'),
  createElement(tagName) {
    const node = newHost()
    node.tagName = tagName
    return node
  },
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(listener)
  },
  removeEventListener(type, listener) {
    const list = this.listeners.get(type) || []
    this.listeners.set(type, list.filter(entry => entry !== listener))
  },
  press(key, options = {}) {
    let prevented = false
    const event = { key, ...options, preventDefault: () => { prevented = true } }
    for (const listener of [...(this.listeners.get('keydown') || [])]) listener(event)
    return prevented
  },
}

function newHost() {
  const host = new Node('div')
  host.fire = (type, target, extra = {}) => {
    const event = { type, target, ...extra, preventDefault: () => {} }
    for (const listener of [...(host.listeners.get(type) || [])]) listener(event)
  }
  return host
}

/* ------------------------------------------------------------------
   An in-memory disk behind the same three verbs the bridge exposes.
   ------------------------------------------------------------------ */

function fakeFiles({ disk = new Map(), queue = [], stampRefuses = false } = {}) {
  const calls = []
  let clock = 1000
  return {
    calls,
    disk,
    queue,
    async pick(side) {
      calls.push(['pick', side])
      const next = queue.shift()
      if (!next) return { ok: true, canceled: true }
      if (next.refuse) return next.refuse
      disk.set(next.path, next.text)
      return { ok: true, canceled: false, path: next.path, text: next.text, bytes: next.text.length, modifiedMs: next.modifiedMs ?? 500 }
    },
    async stamp(filePath) {
      calls.push(['stamp', filePath])
      if (stampRefuses) return { ok: false, code: 'MC_DIFF_READ_FAILED' }
      return { ok: true, path: filePath, exists: disk.has(filePath), modifiedMs: disk.has(filePath) ? (disk.get(`${filePath}::mtime`) ?? 500) : null, bytes: null }
    },
    async save(filePath, text) {
      calls.push(['save', filePath, text])
      if (this.refuseSave) return this.refuseSave
      disk.set(filePath, text)
      clock += 1
      disk.set(`${filePath}::mtime`, clock)
      return { ok: true, path: filePath, modifiedMs: clock, bytes: text.length }
    },
  }
}

function fakePrefs(initial = null) {
  let stored = initial
  return { read: () => stored, write: value => { stored = value }, current: () => stored }
}

function mount(options = {}) {
  const host = newHost()
  const files = options.files || fakeFiles(options.disk ? { disk: options.disk } : {})
  const prefs = options.prefs || fakePrefs()
  let closed = 0
  const controller = createDiffEditor({
    documentRef: activeDocument,
    files,
    prefs,
    onClose: () => { closed += 1 },
  })
  controller.open(host)
  return { host, files, prefs, controller, closedCount: () => closed }
}

const paneText = (host, side) => host.querySelector(`[data-diff-pane="${side}"]`)
const saveButton = (host, side) => host.querySelector(`.diff-save[data-diff-side="${side}"]`)
const blockedNote = (host, side) => host.querySelector(`[data-diff-blocked="${side}"]`)

test('T57 comparing editable versions displays a live diff', async () => {
  const h = mount()
  await openBothSides(h, 'first\nold\nlast\n', 'first\nnew\nlast\n')
  assert.ok(h.host.querySelector('[data-live-diff]'), 'The comparison must show the changes between the editable versions')
  assert.match(h.host.querySelector('[data-live-diff]').textContent, /old/)
  assert.match(h.host.querySelector('[data-live-diff]').textContent, /new/)
  const box=paneText(h.host,'proposed'), renders=h.controller.renderCount()
  box.value='first\nmy correction\nlast\n';h.host.fire('input',box)
  await new Promise(resolve=>setTimeout(resolve,200))
  assert.equal(paneText(h.host,'proposed'),box,'Typing must not replace the textarea')
  assert.equal(h.controller.renderCount(),renders)
  assert.match(h.host.querySelector('[data-live-diff]').textContent,/my correction/)
  h.controller.close()
})

test('T57 session context follows the exact pane through stamp and save', async () => {
  const calls=[]
  const files={readChange:async()=>({ok:true,path:'/registered/file.txt',text:'after\n',exists:true}),
    stamp:async(...args)=>{calls.push(['stamp',...args]);return {ok:true,exists:true}},
    save:async(...args)=>{calls.push(['save',...args]);return {ok:true}}}
  const h=mount({files})
  await h.controller.loadChange({path:'/registered/file.txt',sessionId:'session-one',complete:true,added:1,removed:1,patches:[{diff:'@@ -1 +1 @@\n-before\n+after\n'}]})
  const box=paneText(h.host,'proposed');box.value='my edit\n';h.host.fire('input',box)
  await h.controller.requestSave('proposed');await h.controller.commitSave('proposed')
  assert.deepEqual(calls,[['stamp','/registered/file.txt',{sessionId:'session-one'}],['save','/registered/file.txt','my edit\n',{sessionId:'session-one'}]])
  h.controller.close()
})

async function openBothSides(harness, left = 'left one\n', right = 'right one\n') {
  harness.files.queue.push({ path: 'W/a.txt', text: left })
  harness.files.queue.push({ path: 'W/b.txt', text: right })
  await harness.controller.pick('original')
  await harness.controller.pick('proposed')
}

function type(harness, side, text) {
  const box = paneText(harness.host, side)
  box.value = text
  harness.host.fire('input', box)
}

/* ------------------------------------------------------------------
   1. THE SHAPE THE OWNER ASKED FOR
   ------------------------------------------------------------------ */

test('the window is two labelled panes with a save under each', () => {
  const host = newHost()
  host.innerHTML = diffEditorMarkup(emptyDiffEditorState())
  const panes = host.querySelectorAll('.diff-pane')
  assert.equal(panes.length, 2, 'the window did not draw two panes')
  assert.deepEqual(panes.map(pane => pane.dataset.diffSide), ['original', 'proposed'],
    'the original must be on the left and the changed version on the right')
  assert.equal(panes[0].querySelector('.diff-pane-title').textContent, 'Original file')
  assert.equal(panes[1].querySelector('.diff-pane-title').textContent, 'Changed file')
  for (const side of SIDES) {
    assert.ok(host.querySelector(`[data-diff-pane="${side}"]`), `${side} has no box to type in`)
    assert.equal(saveButton(host, side).textContent, 'Save this version',
      `${side} has no "save this version" control, which is the owner's own wording`)
  }
  const dialog = host.querySelector('.diff-dialog')
  assert.equal(dialog.getAttribute('role'), 'dialog')
  assert.equal(dialog.getAttribute('aria-modal'), 'true')
})

test('neither box is typeable until a file is open on that side, and each says so', () => {
  const host = newHost()
  host.innerHTML = diffEditorMarkup(emptyDiffEditorState())
  for (const side of SIDES) {
    assert.equal(paneText(host, side).disabled, true, `${side} offers an empty box with no file behind it`)
    assert.equal(saveButton(host, side).disabled, true)
    assert.equal(blockedNote(host, side).hidden, false)
    assert.equal(blockedNote(host, side).textContent, 'Choose a file for this side first.')
    assert.equal(saveButton(host, side).getAttribute('aria-describedby'), blockedNote(host, side).getAttribute('id'),
      'the disabled control does not point at the reason beside it')
  }
})

test('every state that blocks a save says why, and none of them is silence', () => {
  const state = emptyDiffEditorState()
  assert.equal(saveBlockedReason(state, 'original'), 'Choose a file for this side first.')

  state.sides.original.path = 'W/a.txt'
  state.sides.original.text = 'same'
  state.sides.original.savedText = 'same'
  assert.equal(saveBlockedReason(state, 'original'), 'This side already matches the file on disk.')

  state.sides.original.text = 'edited'
  assert.equal(saveBlockedReason(state, 'original'), null, 'an edited side with a file behind it must be saveable')

  state.busy = 'save:proposed'
  assert.ok(saveBlockedReason(state, 'original'))
  state.busy = null

  state.warning = { side: 'proposed', moved: false, remember: false }
  assert.equal(saveBlockedReason(state, 'original'), 'Answer the question below first.')
})

/* ------------------------------------------------------------------
   2. IT ACTUALLY SAVES, UNDER EACH PANE, THROUGH ONE VERB
   ------------------------------------------------------------------ */

test('the right-hand save writes the edited text to the right-hand file', async () => {
  const harness = mount()
  await openBothSides(harness)
  type(harness, 'proposed', 'corrected by hand\n')

  const button = saveButton(harness.host, 'proposed')
  assert.equal(button.disabled, false, 'an edited side must offer its save')
  harness.host.fire('click', button)
  await new Promise(resolve => setImmediate(resolve))

  assert.ok(harness.host.querySelector('[data-diff-warning]'), 'the save wrote without warning anybody')
  assert.equal(harness.files.disk.get('W/b.txt'), 'right one\n', 'the file changed before the warning was answered')

  harness.host.fire('click', harness.host.querySelector('[data-diff-action="confirm-save"]'))
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(harness.files.disk.get('W/b.txt'), 'corrected by hand\n')
  assert.equal(harness.files.disk.get('W/a.txt'), 'left one\n', 'the other side was written too')
  assert.equal(harness.host.querySelector('[data-diff-state="proposed"]').textContent,
    'Saved. The file on disk now matches this side.')
})

test('the left-hand save writes the original file, through the same one verb', async () => {
  const harness = mount()
  await openBothSides(harness)
  type(harness, 'original', 'the original, corrected\n')
  await harness.controller.requestSave('original')
  await harness.controller.commitSave('original')

  assert.equal(harness.files.disk.get('W/a.txt'), 'the original, corrected\n')
  const writes = harness.files.calls.filter(call => call[0] === 'save')
  assert.deepEqual(writes.map(call => call[1]), ['W/a.txt'],
    'the left pane reached the disk by some path other than the one save verb')
})

test('a save while the person keeps typing marks saved only what was actually sent', async () => {
  /* The write is held open on purpose, so the typing really does land in the
     middle of it. Marking those later characters as saved would be a lie the
     unsaved indicator then repeats, and the person would close the window
     believing them written. */
  const harness = mount({ prefs: fakePrefs('off') })
  await openBothSides(harness)
  type(harness, 'proposed', 'first version\n')

  let release = null
  const held = new Promise(resolve => { release = resolve })
  const write = harness.files.save.bind(harness.files)
  harness.files.save = async (filePath, text) => { await held; return write(filePath, text) }

  const saving = harness.controller.commitSave('proposed')
  type(harness, 'proposed', 'first version\nand more typed while it wrote\n')
  release()
  await saving

  assert.equal(harness.files.disk.get('W/b.txt'), 'first version\n')
  assert.equal(harness.controller.state.sides.proposed.savedText, 'first version\n',
    'the characters typed during the write were marked as saved, which they are not')
  assert.equal(harness.host.querySelector('[data-diff-state="proposed"]').textContent, 'Edited here, not yet saved.')
  assert.equal(paneText(harness.host, 'proposed').value, 'first version\nand more typed while it wrote\n',
    'the characters typed during the write were thrown away by the redraw that followed it')
})

/* ------------------------------------------------------------------
   2b. THE LINE ENDINGS THE BOX CANNOT HOLD

   A <textarea> hands back an API value: every CRLF pair and every lone CR
   comes out as one LF, whatever was put in. So the window CANNOT carry a
   Windows file's bytes, and the only honest answer is to know what the file
   uses and put it back at the write. Every test here drives the real
   controller through the spec-conformant box above and reads the disk.
   ------------------------------------------------------------------ */

test('a Windows file is written back with the line endings it arrived with', async () => {
  const harness = mount({ prefs: fakePrefs('off') })
  harness.files.queue.push({ path: 'W/win.txt', text: 'first line\r\nsecond line\r\nthird line\r\n' })
  await harness.controller.pick('original')

  assert.equal(paneText(harness.host, 'original').value, 'first line\nsecond line\nthird line\n',
    'the box did not hold what a real textarea holds, so nothing below is testing the real shape')

  type(harness, 'original', 'first line\nsecond line, corrected\nthird line\n')
  await harness.controller.commitSave('original')

  assert.equal(harness.files.disk.get('W/win.txt'), 'first line\r\nsecond line, corrected\r\nthird line\r\n',
    'one correction in a Windows file rewrote every line ending in it, and the window said the file on disk matched')
})

test('a file of plain line endings is not handed Windows ones, and a typed line follows the file', async () => {
  const harness = mount({ prefs: fakePrefs('off') })
  harness.files.queue.push({ path: 'W/plain.txt', text: 'one\ntwo\n' })
  harness.files.queue.push({ path: 'W/win.txt', text: 'one\r\ntwo\r\n' })
  await harness.controller.pick('original')
  await harness.controller.pick('proposed')

  type(harness, 'original', 'one\ntwo\nthree\n')
  await harness.controller.commitSave('original')
  assert.equal(harness.files.disk.get('W/plain.txt'), 'one\ntwo\nthree\n',
    'a plain file was given carriage returns it never had')

  type(harness, 'proposed', 'one\ntwo\nthree\n')
  await harness.controller.commitSave('proposed')
  assert.equal(harness.files.disk.get('W/win.txt'), 'one\r\ntwo\r\nthree\r\n',
    'the line the person typed into a Windows file was written as a plain one')
})

test('typing a character and taking it out again leaves a Windows file with nothing to save', async () => {
  const harness = mount()
  harness.files.queue.push({ path: 'W/win.txt', text: 'alpha\r\nbeta\r\n' })
  await harness.controller.pick('original')
  assert.equal(saveBlockedReason(harness.controller.state, 'original'),
    'This side already matches the file on disk.',
    'a file that was only just read is already reported as edited')

  type(harness, 'original', 'alpha\nbeta\nx')
  assert.equal(harness.host.querySelector('[data-diff-state="original"]').textContent, 'Edited here, not yet saved.')

  type(harness, 'original', 'alpha\nbeta\n')
  assert.equal(harness.host.querySelector('[data-diff-state="original"]').textContent, '',
    'the window says a file it has not changed is edited, and offers to save it')
  assert.equal(saveButton(harness.host, 'original').disabled, true)
  assert.equal(paneIsDirty(harness.controller.state.sides.original), false)
})

test('a file of old Macintosh line endings keeps them too', async () => {
  /* The box normalises a lone CR to LF exactly as it normalises a pair, so a
     file of them is destroyed by the same mechanism and has to be answered by
     the same one. */
  const harness = mount({ prefs: fakePrefs('off') })
  harness.files.queue.push({ path: 'W/classic.txt', text: 'one\rtwo\r' })
  await harness.controller.pick('original')
  assert.equal(paneText(harness.host, 'original').value, 'one\ntwo\n')
  type(harness, 'original', 'one\ntwo, corrected\n')
  await harness.controller.commitSave('original')
  assert.equal(harness.files.disk.get('W/classic.txt'), 'one\rtwo, corrected\r')
})

test('the ending a file is written back with is the one most of its lines use', () => {
  assert.equal(dominantLineEnding('a\r\nb\r\n'), '\r\n')
  assert.equal(dominantLineEnding('a\nb\n'), '\n')
  assert.equal(dominantLineEnding('a\rb\r'), '\r')
  assert.equal(dominantLineEnding('a\r\nb\r\nc\nd\r\n'), '\r\n', 'one stray plain line outvoted three Windows ones')
  assert.equal(dominantLineEnding('a\r\nb\nc\nd\n'), '\n', 'one stray Windows line outvoted three plain ones')
  /* A file with no line ending at all has nothing to preserve, and a plain one
     is what this product writes everywhere else. */
  assert.equal(dominantLineEnding('no ending here'), '\n')
  assert.equal(dominantLineEnding(''), '\n')
})

test('a file whose line endings disagree with each other says so in its own pane', async () => {
  /* The restore puts the DOMINANT ending on every line, which changes bytes the
     person did not type. That is the least-wrong answer available -- a box that
     hands back one kind of ending cannot be asked which line had which -- but
     it is a change, so the pane states it rather than making it quietly. */
  const harness = mount({ prefs: fakePrefs('off') })
  harness.files.queue.push({ path: 'W/mixed.txt', text: 'one\r\ntwo\nthree\r\n' })
  harness.files.queue.push({ path: 'W/tidy.txt', text: 'one\r\ntwo\r\n' })
  await harness.controller.pick('original')
  await harness.controller.pick('proposed')

  const note = harness.host.querySelector('[data-diff-note="original"]')
  assert.ok(note, 'the pane says nothing about a file whose endings it is about to make uniform')
  assert.match(note.textContent, /end in two different ways/i, 'the note does not say what is odd about this file')
  assert.match(note.textContent, /the Windows way/i,
    'the note does not say which way the save will write them, which is the only part that is actionable')
  assert.equal(/MC_DIFF/.test(note.textContent), false, 'the note prints a machine code')
  assert.equal(harness.host.querySelector('[data-diff-note="proposed"]'), null,
    'a file with one kind of line ending was given a note about mixed ones')

  type(harness, 'original', 'one\ntwo\nthree, corrected\n')
  await harness.controller.commitSave('original')
  assert.equal(harness.files.disk.get('W/mixed.txt'), 'one\r\ntwo\r\nthree, corrected\r\n')
  /* AND THE NOTE GOES WITH THE SAVE THAT MADE IT FALSE. The lines on disk now
     all end the same way; a sentence saying they do not is the close warning's
     defect in a quieter place. */
  assert.equal(harness.host.querySelector('[data-diff-note="original"]'), null,
    'the pane still says the file mixes its line endings after the save that made them uniform')
})

/* ------------------------------------------------------------------
   3. THE WARNING, THE CHECKBOX, AND THE PREFERENCE
   ------------------------------------------------------------------ */

test('the warning says the staleness point every time, and what it just measured', () => {
  for (const moved of [true, false, null]) {
    const lines = warningLines({ side: 'proposed', moved, remember: false })
    assert.match(lines[0], /may have changed since the agent produced this version/i)
    assert.match(lines[0], /Saving replaces/i)
    assert.equal(lines.length, 3)
  }
  assert.match(warningLines({ moved: true }).join(' '), /has changed on disk since you opened it/i)
  assert.match(warningLines({ moved: false }).join(' '), /has not changed on disk since you opened it/i)
  assert.match(warningLines({ moved: null }).join(' '), /could not be read/i)
})

test('the warning reads the file again rather than repeating what it knew at open', async () => {
  const harness = mount()
  await openBothSides(harness)
  type(harness, 'proposed', 'edited\n')

  await harness.controller.requestSave('proposed')
  assert.equal(harness.controller.state.warning.moved, false, 'an untouched file was reported as changed')

  harness.controller.cancelSave()
  harness.files.disk.set('W/b.txt::mtime', 9999)
  await harness.controller.requestSave('proposed')
  assert.equal(harness.controller.state.warning.moved, true,
    'the file moved on disk and the warning still said it had not')
})

test('a reading that refuses produces the third answer, not a guess either way', async () => {
  const harness = mount({ files: fakeFiles({ stampRefuses: true }) })
  await openBothSides(harness)
  type(harness, 'proposed', 'edited\n')
  await harness.controller.requestSave('proposed')
  assert.equal(harness.controller.state.warning.moved, null)
  assert.match(harness.host.querySelector('.diff-warning').textContent, /could not be read/i)
})

test('T347 real stamp failures remain visible while the manual save stays available', async () => {
  const { createDiffFiles, diffAnswer } = require('../../shell/diff-file.cjs')
  const root=path.resolve('compare-stamp-fixture'), target=path.join(root,'changed.txt')
  for (const cause of ['ENOENT','EACCES','EIO','unexpected']) {
    const disk={realpathSync:candidate=>candidate,statSync:candidate=>{
      if(candidate===root)return {isDirectory:()=>true}
      if(cause==='unexpected')return {isFile:()=>{throw Error('fixture-internal-details')}}
      const error=new Error('fixture-internal-details');error.code=cause;throw error
    }}
    const surface=createDiffFiles({fs:disk,path,workspaceRoots:()=>[root]})
    const files=fakeFiles()
    files.queue.push({path:target,text:'before\n'})
    files.stamp=candidate=>diffAnswer('MC_DIFF_HANDLER_FAILED',()=>surface.stamp(candidate))
    const harness=mount({files})
    try {
      await harness.controller.pick('proposed')
      type(harness,'proposed','retained edits\n')
      await harness.controller.requestSave('proposed')
      assert.equal(harness.controller.state.warning.moved,null)
      assert.match(harness.host.querySelector('.diff-warning').textContent,/could not be read/i)
      const refusal=harness.host.querySelector('.diff-refusal')
      if(cause==='ENOENT')assert.equal(refusal,null)
      else {
        assert.ok(refusal)
        assert.equal(refusal.getAttribute('data-refusal-code'),cause==='unexpected'?'MC_DIFF_HANDLER_FAILED':'MC_DIFF_STAT_FAILED')
        assert.match(refusal.textContent,cause==='unexpected'?/unexpected error/i:/details could not be checked/i)
        assert.doesNotMatch(refusal.textContent,/fixture-internal-details|MC_DIFF/)
      }
      assert.equal(paneText(harness.host,'proposed').value,'retained edits\n')
      const confirm=harness.host.querySelector('[data-diff-action="confirm-save"]')
      assert.ok(confirm)
      assert.equal(confirm.disabled,false)
      await harness.controller.commitSave('proposed')
      assert.equal(files.disk.get(target),'retained edits\n','a diagnostic must not remove the manual save override')
    } finally { harness.controller.close() }
  }
})

test('the checkbox remembers the choice, and the next save goes straight through', async () => {
  const prefs = fakePrefs()
  const harness = mount({ prefs })
  await openBothSides(harness)
  type(harness, 'proposed', 'one\n')
  await harness.controller.requestSave('proposed')

  const box = harness.host.querySelector('[data-diff-remember]')
  assert.ok(box, 'the warning offered no way to stop being warned')
  box.checked = true
  harness.host.fire('change', box)
  harness.host.fire('click', harness.host.querySelector('[data-diff-action="confirm-save"]'))
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(prefs.current(), 'off', 'the choice was not written where this person keeps their settings')
  assert.equal(harness.files.disk.get('W/b.txt'), 'one\n')

  type(harness, 'proposed', 'two\n')
  await harness.controller.requestSave('proposed')
  assert.equal(harness.controller.state.warning, null, 'the warning came back after being told not to')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(harness.files.disk.get('W/b.txt'), 'two\n', 'the save did not go through on its own')
})

test('a window opened by somebody who already answered is not warned again', async () => {
  const harness = mount({ prefs: fakePrefs('off') })
  await openBothSides(harness)
  type(harness, 'proposed', 'straight through\n')
  await harness.controller.requestSave('proposed')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(harness.files.disk.get('W/b.txt'), 'straight through\n')
  assert.equal(harness.files.calls.some(call => call[0] === 'stamp'), false,
    'a window that must not warn still read the file to build a warning nobody sees')
})

test('leaving the checkbox alone keeps the warning for next time', async () => {
  const prefs = fakePrefs()
  const harness = mount({ prefs })
  await openBothSides(harness)
  type(harness, 'proposed', 'one\n')
  await harness.controller.requestSave('proposed')
  await harness.controller.commitSave('proposed')
  assert.equal(prefs.current(), null, 'the preference was written without anybody asking for it')
  type(harness, 'proposed', 'two\n')
  await harness.controller.requestSave('proposed')
  assert.ok(harness.controller.state.warning, 'the warning stopped without being told to')
})

test('cancelling the warning saves nothing and leaves the edit in the box', async () => {
  const harness = mount()
  await openBothSides(harness)
  type(harness, 'proposed', 'not yet\n')
  await harness.controller.requestSave('proposed')
  harness.host.fire('click', harness.host.querySelector('[data-diff-action="cancel-save"]'))
  assert.equal(harness.files.disk.get('W/b.txt'), 'right one\n')
  assert.equal(harness.controller.state.sides.proposed.text, 'not yet\n')
  assert.equal(paneText(harness.host, 'proposed').value, 'not yet\n', 'the edit was lost from the box')
})

/* ------------------------------------------------------------------
   3b. THE DOOR: WHAT IT MOUNTS, WHAT IT HANDS THE WINDOW, AND WHEN IT
       TAKES IT DOWN AGAIN

   Driven rather than read. The page that opens this window can only be
   asserted from its source -- it needs a live document -- but everything the
   door itself does is exercised here with values, which is where the
   regressions actually are.
   ------------------------------------------------------------------ */

function fakeStorage(initial = {}) {
  const kept = new Map(Object.entries(initial))
  return {
    kept,
    getItem: key => (kept.has(key) ? kept.get(key) : null),
    setItem: (key, value) => { kept.set(key, String(value)) },
  }
}

function newDoor(options = {}) {
  activeDocument.body.children = []
  return createCompareFilesDoor({
    documentRef: activeDocument,
    bridge: options.bridge || (() => fakeFiles()),
    storage: options.storage || (() => fakeStorage()),
  })
}

test('the door hands the window the bridge the installed application put there', () => {
  /* THE ONE LINE THAT CONNECTS THIS WINDOW TO THE MAIN PROCESS. Nothing else in
     this suite touches it: every other test injects its own verb. Cut it and
     the window opens with two panes that cannot open a file. */
  const bridge = fakeFiles()
  let handed = null
  const door = createCompareFilesDoor({
    documentRef: activeDocument,
    bridge: () => bridge,
    storage: () => fakeStorage(),
    create: options => { handed = options; return createDiffEditor(options) },
  })
  activeDocument.body.children = []
  door.open()
  assert.equal(handed.files, bridge, 'the window was opened with something other than the bridge')
  assert.equal(handed.documentRef, activeDocument)
  door.close()
})

test('the door reads and writes the warning answer under this product\'s own key', async () => {
  const storage = fakeStorage()
  const door = newDoor({ storage: () => storage })
  const editor = door.open()
  assert.equal(editor.state.warningSuppressed, false)

  editor.state.warning = { side: 'original', moved: false, remember: true }
  editor.state.sides.original.path = 'W/a.txt'
  await editor.commitSave('original')
  assert.equal(storage.getItem(WARNING_PREFERENCE_KEY), 'off',
    'the answer was not kept where this person keeps their settings')
  assert.equal(WARNING_PREFERENCE_KEY, 'mc.diff.stale-warning')
  door.close()

  /* And it is read back on the next open, which is what "remembered" means. */
  const again = newDoor({ storage: () => storage }).open()
  assert.equal(again.state.warningSuppressed, true, 'the answer was written and never read')
})

test('a storage that throws does not stop the window opening', () => {
  const angry = { getItem: () => { throw new Error('no') }, setItem: () => { throw new Error('no') } }
  const door = newDoor({ storage: () => angry })
  const editor = door.open()
  assert.equal(editor.state.warningSuppressed, false)
  assert.equal(activeDocument.body.children.length, 1)
  door.close()
})

test('the door opens one window, not a second one over the first', () => {
  const door = newDoor()
  const first = door.open()
  const second = door.open()
  assert.equal(second, first, 'the row opened a second window on top of the one already up')
  assert.equal(activeDocument.body.children.length, 1,
    `${activeDocument.body.children.length} host nodes are on the body`)
  door.close()
})

test('closing the door takes the host node off the body and stops the keyboard', () => {
  const door = newDoor()
  door.open()
  assert.equal(activeDocument.body.children.length, 1)
  assert.equal(door.isOpen(), true)
  door.close()
  assert.equal(activeDocument.body.children.length, 0,
    'the window was closed and its host node stayed in the document')
  assert.equal(door.isOpen(), false)
  /* And the door is usable again afterwards rather than stuck. */
  door.open()
  assert.equal(activeDocument.body.children.length, 1)
  door.close()
})

test('the window closing itself leaves the door able to open a new one', () => {
  const door = newDoor()
  const editor = door.open()
  editor.requestClose()
  assert.equal(door.isOpen(), false, 'the door still believes a closed window is open, so the row does nothing')
  assert.equal(activeDocument.body.children.length, 0)
  door.open()
  assert.equal(activeDocument.body.children.length, 1)
  door.close()
})

test('the page taking the window down does not stop to ask, and that is the trade', async () => {
  /* WRITTEN DOWN SO IT IS A DECISION RATHER THAN A SURPRISE. The × and Escape
     ask once when a pane is unsaved. A page being destroyed cannot ask -- there
     would be nothing for the second press to land on -- and a window that
     refused to go is the defect the door exists to prevent, left over whatever
     page came next. So this loses unsaved edits, on purpose. If somebody makes
     close() ask, this fails and they have to face what the refusing window
     does instead. */
  const files = fakeFiles()
  const door = newDoor({ bridge: () => files })
  const editor = door.open()
  files.queue.push({ path: 'W/a.txt', text: 'on disk\n' })
  await editor.pick('original')
  editor.state.sides.original.text = 'an hour of hand editing\n'
  assert.equal(stateIsDirty(editor.state), true)

  door.close()
  assert.equal(door.isOpen(), false, 'the page could not take its own window down')
  assert.equal(activeDocument.body.children.length, 0)
  assert.equal(files.disk.get('W/a.txt'), 'on disk\n', 'the window saved on its way out, which nobody asked for')
})

test('closing a door that was never opened does nothing and does not throw', () => {
  const door = newDoor()
  door.close()
  assert.equal(door.isOpen(), false)
  assert.equal(activeDocument.body.children.length, 0)
})

test('the page that opens the compare window takes it down when it leaves', () => {
  /* THE HALF THAT CANNOT BE DRIVEN HERE. settingsView() needs a live document,
     so this reads the source for the two lines that bind the window to the
     page: the door is built once for the view, and the view's destroy() closes
     it. The mirror dialog's own note two lines above it records what happens
     otherwise -- a modal left over whatever page came next. Everything the
     close itself does is driven above. */
  const settings = readFileSync(path.join(REPO, 'src', 'views', 'settings.js'), 'utf8')
  assert.match(settings, /const compareFiles = createCompareFilesDoor\(\)/,
    'the settings page no longer builds the compare window through its door')
  const destroy = settings.slice(settings.indexOf('    destroy() {'))
  assert.ok(destroy.length > 0, 'the settings view has no destroy()')
  assert.match(destroy.slice(0, destroy.indexOf('\n  }')), /compareFiles\.close\(\)/,
    'leaving Settings leaves the compare window mounted over whatever page comes next')
})

/* ------------------------------------------------------------------
   4. REFUSALS
   ------------------------------------------------------------------ */

const readRefusals = [
  ['MC_DIFF_NO_WORKSPACE', /could not find the folder/i],
  ['MC_DIFF_OUTSIDE_WORKSPACE', /outside the folder/i],
  ['MC_DIFF_STAT_FAILED', /details could not be checked/i],
  ['MC_DIFF_READ_FAILED', /file could not be read/i],
  ['MC_DIFF_HANDLER_FAILED', /unexpected error/i],
]

for (const action of ['pick', 'readChange']) {
  for (const [code, explanation] of readRefusals) {
    test(`T347 ${action} visibly explains ${code} and ignores raw failure details`, async () => {
      const files = fakeFiles()
      files[action] = async () => ({ ok: false, code, message: 'fixture-internal-details',
        path: 'fixture-private-path', text: 'fixture-private-content' })
      const harness = mount({ files })
      try {
        if (action === 'pick') await harness.controller.pick('proposed')
        else await harness.controller.loadChange({ path: 'changed.txt', complete: true, patches: [] })
        const refusal = harness.host.querySelector('.diff-refusal')
        assert.ok(refusal, 'the refused read must be visible')
        assert.equal(refusal.getAttribute('role'), 'alert')
        assert.equal(refusal.getAttribute('data-refusal-code'), code)
        assert.match(refusal.textContent, explanation)
        assert.doesNotMatch(refusal.textContent, /MC_DIFF|fixture-internal-details|fixture-private/)
        assert.equal(saveButton(harness.host, 'proposed').disabled, true)
      } finally { harness.controller.close() }
    })
  }

  test(`T347 a rejected ${action} bridge call names an unexpected failure`, async () => {
    const files = fakeFiles()
    files[action] = async () => { throw new Error('fixture-internal-details') }
    const harness = mount({ files })
    try {
      if (action === 'pick') await harness.controller.pick('proposed')
      else await harness.controller.loadChange({ path: 'changed.txt', complete: true, patches: [] })
      const refusal = harness.host.querySelector('.diff-refusal')
      assert.ok(refusal)
      assert.equal(refusal.getAttribute('data-refusal-code'), 'MC_DIFF_HANDLER_FAILED')
      assert.match(refusal.textContent, /unexpected error/i)
      assert.doesNotMatch(refusal.textContent, /fixture-internal-details|MC_DIFF/)
    } finally { harness.controller.close() }
  })
}

test('T347 the five read failure sentences remain distinguishable', () => {
  assert.equal(new Set(readRefusals.map(([code]) => refusalSentence({ ok: false, code }))).size, 5)
})

test('a refused save shows its sentence, carries its code, and leaves the side unsaved', async () => {
  const harness = mount()
  await openBothSides(harness)
  harness.files.refuseSave = { ok: false, code: 'MC_DIFF_OUTSIDE_WORKSPACE' }
  type(harness, 'proposed', 'refused\n')
  await harness.controller.requestSave('proposed')
  await harness.controller.commitSave('proposed')

  const refusal = harness.host.querySelector('.diff-refusal')
  assert.ok(refusal, 'a refused save said nothing at all')
  assert.match(refusal.textContent, /outside the folder your assistants work in/i)
  assert.equal(refusal.getAttribute('data-refusal-code'), 'MC_DIFF_OUTSIDE_WORKSPACE')
  assert.equal(/MC_DIFF/.test(refusal.textContent), false, 'the machine code was printed at the person')
  assert.equal(harness.host.querySelector('[data-diff-state="proposed"]').textContent, 'Edited here, not yet saved.')
})

test('every refusal code the main process can send has a sentence here', () => {
  /* THE DRIFT LOCK. A code added to shell/diff-file.cjs with no sentence would
     otherwise reach a person as the unknown fallback, which is exactly the
     defect src/agent-availability-copy.js exists to have ended. */
  const source = readFileSync(path.join(REPO, 'shell', 'diff-file.cjs'), 'utf8')
  const codes = [...source.matchAll(/refusal\('([A-Z_]+)'\)/g)].map(match => match[1])
  assert.ok(codes.length >= 8, `only ${codes.length} refusal codes were found in the shell module; the scan has gone blind`)
  for (const code of new Set(codes)) {
    const sentence = refusalSentence({ ok: false, code })
    assert.notEqual(sentence, refusalSentence({ ok: false, code: 'NOT_A_REAL_CODE' }),
      `${code} falls through to the unknown sentence instead of having its own`)
    assert.equal(/[A-Z]{2,}_[A-Z]/.test(sentence), false, `${code}'s sentence prints a machine code`)
  }
})

test('a reply with no code at all still says what to assume about the file', () => {
  for (const answer of [null, undefined, {}, { ok: false }, { ok: false, error: {} }]) {
    const sentence = refusalSentence(answer)
    assert.match(sentence, /treat the file as unchanged/i)
  }
  /* The shell wraps a refused sender check as { ok:false, error:{ code } },
     which is a different shape from the module's own { ok:false, code }.
     Both have to resolve, or a sender refusal reads as a successful save. */
  assert.match(refusalSentence({ ok: false, error: { code: 'MC_DIFF_NO_WORKSPACE' } }),
    /could not find the folder your assistants work in/i)
})

test('a refusal and a warning each say which of the two files they are about', async () => {
  /* WITH TWO FILES OPEN, "the file" NAMES NEITHER. Both of these are one
     paragraph at the top of a dialog holding two panes, and the sentence under
     the warning's own checkbox says this window "still says which file it is
     about" -- which it did not. */
  const harness = mount()
  await openBothSides(harness)

  type(harness, 'proposed', 'edited\n')
  await harness.controller.requestSave('proposed')
  const where = harness.host.querySelector('[data-diff-warning-side]')
  assert.ok(where, 'the warning does not say which of the two files it is about')
  assert.equal(where.dataset.diffWarningSide, 'proposed')
  assert.match(where.textContent, /^Changed file: /, 'the warning names the side in words a person can match to a pane')
  assert.match(where.textContent, /W\/b\.txt/, 'the warning does not name the file it is about')
  harness.controller.cancelSave()

  harness.files.refuseSave = { ok: false, code: 'MC_DIFF_OUTSIDE_WORKSPACE' }
  await harness.controller.commitSave('proposed')
  const refusal = harness.host.querySelector('.diff-refusal')
  assert.equal(refusal.getAttribute('data-refusal-side'), 'proposed')
  assert.match(refusal.textContent, /^Changed file: /,
    'the refusal over two open files says nothing about which one it refused')
  assert.match(refusal.textContent, /outside the folder your assistants work in/i)

  /* And the other side, so this is the side and not a constant. */
  harness.files.refuseSave = null
  type(harness, 'original', 'edited too\n')
  await harness.controller.requestSave('original')
  assert.match(harness.host.querySelector('[data-diff-warning-side]').textContent, /^Original file: /)
  assert.match(harness.host.querySelector('[data-diff-warning-side]').textContent, /W\/a\.txt/)
})

test('a file whose name carries markup does not become markup', async () => {
  /* THE SECOND CHANNEL INTO THE SAME MARKUP. The suite pinned "file contents
     never travel through the markup" and the PATH does -- in the pane, and now
     in the warning as well. A folder is free to be called
     `</p><img onerror=...>`, and on Windows a file chooser will hand one back. */
  const nasty = 'W/</p><img src=x onerror="stealEverything()">.txt'
  const harness = mount()
  harness.files.queue.push({ path: nasty, text: 'ordinary\n' })
  await harness.controller.pick('original')

  const markup = diffEditorMarkup(harness.controller.state)
  /* The name IS drawn -- a person has to be able to read which file this is --
     so what must not survive is the markup in it. */
  assert.equal(markup.includes('<img'), false, 'the file name was written into the markup as markup')
  assert.equal(markup.includes('</p><img'), false)
  assert.equal(harness.host.querySelectorAll('img').length, 0, 'the file name became a live node in this window')
  assert.equal(harness.host.querySelector('.diff-pane-where').textContent, nasty,
    'the file name is not shown to the person as the name it is')

  /* And through the warning, which draws the same path a second time. */
  type(harness, 'original', 'edited\n')
  await harness.controller.requestSave('original')
  assert.equal(harness.host.querySelectorAll('img').length, 0, 'the warning put the file name into the window as markup')
  assert.match(harness.host.querySelector('[data-diff-warning-side]').textContent, /stealEverything/,
    'the warning does not show the file name it is about')
})

test('a save that would be over the limit is refused before the work, not after it', async () => {
  /* A file may be READ at a byte under the limit and then typed past it. The
     control that cannot succeed says so beside itself rather than going live
     and refusing after an hour of editing. */
  const harness = mount()
  const nearly = 'x'.repeat(MAX_FILE_BYTES)
  harness.files.queue.push({ path: 'W/big.txt', text: nearly })
  await harness.controller.pick('original')
  assert.equal(saveBlockedReason(harness.controller.state, 'original'), 'This side already matches the file on disk.')

  type(harness, 'original', `${nearly}and then some more`)
  const blocked = saveBlockedReason(harness.controller.state, 'original')
  assert.match(blocked || '', /one megabyte/i, 'a side typed past the limit still offers a save that cannot succeed')
  assert.match(blocked || '', /take some of it out/i, 'the reason does not say what to do about it')
  assert.equal(saveButton(harness.host, 'original').disabled, true)
  assert.equal(blockedNote(harness.host, 'original').textContent, blocked)

  /* And back under the limit the save is live again. */
  type(harness, 'original', `${nearly.slice(0, 100)}edited`)
  assert.equal(saveBlockedReason(harness.controller.state, 'original'), null)
})

test('the refusal for a file too big to open is not the refusal for a side too big to save', () => {
  /* Two sentences because the advice differs: one is about a file nobody has
     opened, the other is said over a box holding the only copy of an hour's
     work. "Open this one in your usual editor instead" is a dead end there. */
  const opening = refusalSentence({ ok: false, code: 'MC_DIFF_TOO_LARGE' })
  const saving = refusalSentence({ ok: false, code: 'MC_DIFF_TOO_LARGE_TO_SAVE' })
  assert.notEqual(opening, saving)
  assert.match(saving, /still in the box/i, 'the refusal after the editing does not say the edits survived it')
  assert.match(saving, /take some of it out|copy it into/i)

  const shell = require('../../shell/diff-file.cjs')
  const files = shell.createDiffFiles({
    fs: { realpathSync: target => target, statSync: () => { throw new Error('none') } },
    path,
    workspaceRoots: () => [path.resolve('W')],
  })
  assert.equal(files.write(path.join(path.resolve('W'), 'big.txt'), 'y'.repeat(MAX_FILE_BYTES + 1)).code,
    'MC_DIFF_TOO_LARGE_TO_SAVE',
    'the main process still answers a too-large save with the sentence about opening it elsewhere')
})

test('tab is held inside this window, in both directions', () => {
  /* A modal that lets focus walk out puts the keyboard on the page underneath,
     where the person cannot see what they are pressing and the window over it
     still owns Escape. Untested until now: short-circuiting onKeydown before
     the Tab branch was green. */
  const harness = mount()
  const dialog = harness.host.querySelector('.diff-dialog')
  const stops = [...dialog.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter(node => !node.disabled && node.tabIndex !== -1)
  assert.ok(stops.length >= 2, `the dialog offers ${stops.length} places to land, so there is nothing to wrap`)
  const first = stops[0]
  const last = stops[stops.length - 1]

  activeDocument.activeElement = last
  assert.equal(activeDocument.press('Tab'), true, 'tab at the last control was left to the page underneath')
  assert.equal(activeDocument.activeElement, first, 'tab at the last control did not come back to the first')

  activeDocument.activeElement = first
  assert.equal(activeDocument.press('Tab', { shiftKey: true }), true, 'shift-tab at the first control walked out of the window')
  assert.equal(activeDocument.activeElement, last)

  /* In the middle it is the browser's business, and this must not take it. */
  activeDocument.activeElement = stops[1]
  assert.equal(activeDocument.press('Tab'), false, 'tab in the middle of the window was taken over')
  assert.equal(activeDocument.activeElement, stops[1])

  harness.controller.close()
})

test('a cancelled file choice is not a refusal', async () => {
  const harness = mount()
  await harness.controller.pick('original')
  assert.equal(harness.controller.state.refusal, null)
  assert.equal(harness.host.querySelector('.diff-refusal'), null)
  assert.equal(harness.controller.state.sides.original.path, null)
})

/* ------------------------------------------------------------------
   5. THE THING THAT MUST NOT LAG, AND THE THING THAT MUST NOT ESCAPE
   ------------------------------------------------------------------ */

test('typing never redraws the window, however long the file is', async (t) => {
  const harness = mount()
  /* Eight characters under the limit, so appending a keystroke's worth of index
     below does not trip the "this side is longer than a megabyte" block and
     turn a timing test into a coverage test of something else. */
  const big = 'x'.repeat(MAX_FILE_BYTES - 8)
  harness.files.queue.push({ path: 'W/a.txt', text: 'small\n' })
  harness.files.queue.push({ path: 'W/b.txt', text: big })
  await harness.controller.pick('original')
  await harness.controller.pick('proposed')

  const before = harness.controller.renderCount()
  const box = paneText(harness.host, 'proposed')

  /* HOW OFTEN THE HANDLER READS THE FILE, which is the part of "does not do
     work proportional to the file" that can be answered exactly rather than by
     a clock. A textarea's value getter is where the megabyte is: reading it
     twice doubles the cost of every keystroke, and reading it in a loop is how
     the mirror dialog's redraw-per-character got written. Exactly one read per
     keystroke, counted. */
  let reads = 0
  const meter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(box), 'value')
  Object.defineProperty(box, 'value', {
    configurable: true,
    set(next) { meter.set.call(this, next) },
    get() { reads += 1; return meter.get.call(this) },
  })

  /* THE STAND-IN'S OWN COST IS MEASURED AND TAKEN OFF, because it is now the
     expensive half and it is not the thing under test. A spec-conformant
     textarea hands back an API value, so every keystroke materialises a
     distinct megabyte string and scans it -- ~0.6ms a time on this machine,
     ~250ms over the loop, whatever the module does. A browser pays the same
     kind of cost in C++ and this suite cannot speak to that. What it CAN answer
     is the module's own share, so the same 400 assignments and the same 400
     reads are timed with no handler attached and the difference is taken.
     Minimum of three rounds each: the mean of a megabyte memcpy on a shared
     machine swings by 150ms, and the minimum does not. */
  const round = handler => {
    const started = process.hrtime.bigint()
    for (let index = 0; index < 400; index += 1) {
      box.value = `${big}${index}`
      if (handler) harness.host.fire('input', box)
      else assert.ok(box.value.length > 0)
    }
    return Number(process.hrtime.bigint() - started) / 1e6
  }
  let baselineMs = Infinity
  let elapsedMs = Infinity
  for (let attempt = 0; attempt < 3; attempt += 1) {
    baselineMs = Math.min(baselineMs, round(false))
    elapsedMs = Math.min(elapsedMs, round(true))
  }
  const moduleShareMs = elapsedMs - baselineMs

  assert.equal(harness.controller.renderCount(), before,
    'a keystroke redrew the window; at a megabyte that is an escape and a parse per character')
  assert.equal(reads, 400 * 6,
    `the box was read ${reads} times over 2400 keystrokes; a keystroke must read the megabyte once and no more`)
  t.diagnostic(`400 keystrokes over a ${big.length}-character file: ${elapsedMs.toFixed(1)}ms best, ${baselineMs.toFixed(1)}ms of it the stand-in, ${moduleShareMs.toFixed(1)}ms the module`)
  /* Keep the established 200ms absolute ceiling and also limit the module's
     share to a quarter of the measured stand-in cost. A slow or noisy baseline
     must not raise the absolute allowance. The read count and render count
     above protect against extra reads and redraws independently of the clock. */
  assert.ok(moduleShareMs < Math.min(200, baselineMs * 0.25),
    `400 keystrokes cost the module ${moduleShareMs.toFixed(1)}ms over a ${big.length}-character file (the stand-in's own share was ${baselineMs.toFixed(1)}ms)`)

  /* And the two things a keystroke IS allowed to move actually moved. */
  assert.equal(harness.host.querySelector('[data-diff-state="proposed"]').textContent, 'Edited here, not yet saved.')
  assert.equal(saveButton(harness.host, 'proposed').disabled, false)
  assert.equal(blockedNote(harness.host, 'proposed').hidden, true)
})

test('file contents never travel through the markup', () => {
  /* A file holding the closing tag would end the element and put the rest of
     the file into this window as live nodes. The markup emits empty boxes and
     the controller sets `.value`, so there is nothing to escape. */
  const state = emptyDiffEditorState()
  state.sides.proposed.path = 'W/b.txt'
  state.sides.proposed.text = '</textarea><img src=x onerror="stealEverything()">'
  state.sides.proposed.savedText = ''
  const markup = diffEditorMarkup(state)
  assert.equal(markup.includes('stealEverything'), false, 'the file contents were written into the markup')
  assert.equal(markup.includes('</textarea><img'), false)
  assert.match(markup, /<textarea[^>]*data-diff-pane="proposed"[^>]*><\/textarea>/,
    'the box was not emitted empty')

  const host = newHost()
  host.innerHTML = markup
  assert.equal(host.querySelectorAll('img').length, 0)
})

test('a file is put into the box through its value, so a redraw does not lose it', async () => {
  const harness = mount()
  await openBothSides(harness, 'the left file\n', 'the right file\n')
  assert.equal(paneText(harness.host, 'original').value, 'the left file\n')
  assert.equal(paneText(harness.host, 'proposed').value, 'the right file\n')
  type(harness, 'original', 'edited on the left\n')
  /* A structural redraw -- picking a file on the OTHER side -- must not throw
     away the edit in this one. */
  harness.files.queue.push({ path: 'W/c.txt', text: 'a third file\n' })
  await harness.controller.pick('proposed')
  assert.equal(paneText(harness.host, 'original').value, 'edited on the left\n')
})

test('closing with unsaved edits asks once, and the second press goes through', async () => {
  const harness = mount()
  await openBothSides(harness)
  type(harness, 'proposed', 'unsaved work\n')

  harness.host.fire('click', harness.host.querySelector('[data-diff-action="close"]'))
  assert.equal(harness.closedCount(), 0, 'an hour of hand editing was thrown away on one press')
  assert.match(harness.host.querySelector('.diff-closing').textContent, /not saved/i)

  harness.host.fire('click', harness.host.querySelector('[data-diff-action="close"]'))
  assert.equal(harness.closedCount(), 1)
})

test('the close warning does not outlive the edit it is about', async () => {
  const harness = mount({ prefs: fakePrefs('off') })
  await openBothSides(harness)
  type(harness, 'proposed', 'unsaved work\n')
  harness.host.fire('click', harness.host.querySelector('[data-diff-action="close"]'))
  assert.ok(harness.host.querySelector('.diff-closing'))

  await harness.controller.commitSave('proposed')
  assert.equal(harness.host.querySelector('.diff-closing'), null,
    'the window still says there are unsaved edits after the save that wrote them')
  assert.equal(harness.controller.state.confirmingClose, false)

  /* And the other way back: typing the edit out again rather than saving it. */
  type(harness, 'proposed', 'changed once more\n')
  harness.host.fire('click', harness.host.querySelector('[data-diff-action="close"]'))
  assert.ok(harness.host.querySelector('.diff-closing'))
  type(harness, 'proposed', 'unsaved work\n')
  assert.equal(harness.host.querySelector('.diff-closing'), null,
    'the warning stayed up after the edit it names was typed back out')
  assert.equal(harness.closedCount(), 0)
})

test('escape closes a window with nothing unsaved, and only dismisses the warning while it is up', async () => {
  const clean = mount()
  await openBothSides(clean)
  assert.equal(activeDocument.press('Escape'), true, 'escape was not handled')
  assert.equal(clean.closedCount(), 1)

  const dirty = mount()
  await openBothSides(dirty)
  type(dirty, 'proposed', 'edited\n')
  await dirty.controller.requestSave('proposed')
  activeDocument.press('Escape')
  assert.equal(dirty.controller.state.warning, null, 'escape did not dismiss the warning')
  assert.equal(dirty.closedCount(), 0, 'escape dismissed the warning AND closed the window')
  dirty.controller.close()
})

test('a closed window stops listening to the keyboard', async () => {
  const harness = mount()
  await openBothSides(harness)
  harness.controller.close()
  assert.equal(harness.closedCount(), 1)
  activeDocument.press('Escape')
  assert.equal(harness.closedCount(), 1, 'a window that is gone answered a key press')
})

/* ------------------------------------------------------------------
   6. THE TWO NUMBERS AND THE ONE LAYOUT RULE THAT MUST NOT DRIFT
   ------------------------------------------------------------------ */

test('the size limit this window states is the size limit the main process applies', () => {
  const shell = require('../../shell/diff-file.cjs')
  assert.equal(MAX_FILE_BYTES, shell.MAX_FILE_BYTES,
    'the window promises one limit and the file verb enforces another')
  assert.equal(MAX_FILE_BYTES, 1024 * 1024)
  assert.match(diffEditorMarkup(emptyDiffEditorState()), /one megabyte/i,
    'the limit is enforced and never said out loud')
})

test('below 700px the panes stack instead of shrinking into two unreadable columns', () => {
  const sheet = readFileSync(path.join(REPO, 'src', 'diff-editor.css'), 'utf8')
  const wide = sheet.match(/\.diff-panes\s*\{[^}]*\}/)
  assert.ok(wide, 'the panes have no layout rule at all')
  assert.match(wide[0], /grid-template-columns:\s*1fr 1fr/, 'the two panes are not two columns to begin with')

  const narrow = sheet.match(/@media \(max-width: 700px\)\s*\{([\s\S]*?)\n\}/)
  assert.ok(narrow, 'there is no rule for a window narrower than 700px')
  assert.match(narrow[1], /\.diff-panes\s*\{[^}]*grid-template-columns:\s*1fr\s*;/,
    'below 700px the panes do not collapse to one column')
  assert.equal(/@media[^{]*\{[^}]*\.diff-panes[^}]*grid-template-columns:\s*1fr 1fr/.test(sheet), false,
    'a later rule puts the two columns back')

  /* THE PHONE CANVAS IS NOT TOUCHED. src/phone-canvas.css states that it holds
     no media query and that no width may reach its rules; a sheet that reached
     into its attribute would be the same violation from the other side. */
  assert.equal(sheet.includes('data-phone-canvas'), false,
    'this sheet reaches into the phone canvas, which owns that attribute alone')
  /* THE CLAIM IS THE ORDER, NOT THE SPELLING. This used to require the exact
     characters `--phone-canvas-h, 100vh`, which failed the moment the fallback
     learned to divide by --zoom for the Text size setting (see :root in
     src/styles.css) -- a strictly better fallback failing a gate that meant to
     protect the property in front of it. Both halves are still asserted: the
     height READS the visual-viewport property first, and what it falls back to
     when there is none is the viewport, so a desktop still gets a full window. */
  assert.match(sheet, /height:[^;]*var\(--phone-canvas-h,/,
    'the dialog is sized to the viewport rather than to the visual viewport the phone canvas measures')
  assert.match(sheet, /var\(--phone-canvas-h,[^)]*100vh/,
    'the fallback for a window with no phone canvas must still be the viewport')
})

test('the window invents no colour, radius or spacing of its own', () => {
  const sheet = readFileSync(path.join(REPO, 'src', 'diff-editor.css'), 'utf8')
  const declarations = sheet.replace(/\/\*[\s\S]*?\*\//g, '')
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(declarations), false, 'a hex colour was written into this sheet')
  assert.equal(/rgba?\(/.test(declarations), false, 'a raw colour was written into this sheet')
  const radii = [...declarations.matchAll(/border-radius:\s*([^;]+);/g)].map(match => match[1].trim())
  for (const radius of radii) {
    assert.match(radius, /^var\(--r-(sm|md|lg)\)$/, `border-radius: ${radius} is not one of this product's three radii`)
  }
})

/* ------------------------------------------------------------------
   THE PROVIDER PIPELINE, END TO END -- the gap that hid this defect.
   ------------------------------------------------------------------

   Every case above hands loadChange() a selection built BY HAND, and a
   hand-built selection always said `complete: true` with a unified patch
   attached. Real sessions do not all look like that. The Claude CLI sends
   Write/Edit with no patch and no line counts at all, so the only route to an
   original never ran, and the Compare window showed ONE file for every
   Claude-driven edit -- every file, every session. Fifty tests stayed green
   through it because none of them started where a session starts.

   These cases start at the provider event and run the real reader, the real
   confirmed-change buffer and the real store into the real controller, so the
   thing under test is the wiring rather than a fixture's opinion of it.

   Half of them assert a REFUSAL, and those are the ones to keep. The window may
   only show an original it can prove; a plausible-looking wrong "before" is
   worse than an empty pane, because a person would edit it and save it. */

const PIPE_SESSION = 'session-under-test'
const PIPE_PATH = '/registered/note.txt'
const PIPE_DISK = 'line one\nafter\nline three\n'

function providerSession() {
  const store = createSessionChangeStore()
  const buffer = createConfirmedFileChangeBuffer()
  let calls = 0
  return {
    run(tool, payload) {
      const toolCallId = `call-${++calls}`
      const started = { sessionId: PIPE_SESSION, event: { type: 'tool_call', tool, toolCallId, turnId: 'turn-1', payload } }
      buffer.add(started, sessionActivityEvent(started, PIPE_SESSION))
      const finished = { sessionId: PIPE_SESSION, event: { type: 'tool_result', tool, toolCallId, turnId: 'turn-1', status: 'ok', payload: { status: 'ok' } } }
      const confirmed = buffer.add(finished, sessionActivityEvent(finished, PIPE_SESSION))
      assert.ok(confirmed, 'the provider pair must publish a confirmed change')
      store.add({ id: confirmed.changeId, files: confirmed.fileChanges, patches: confirmed.filePatches,
        edits: confirmed.fileEdits, limited: confirmed.fileChangesLimited })
      return confirmed
    },
    selection: () => store.read().files.find(file => file.path === PIPE_PATH) || null,
  }
}

async function compareVersionsOnScreen(selection, disk = PIPE_DISK) {
  const h = mount({ files: {
    readChange: async () => ({ ok: true, path: PIPE_PATH, text: disk, exists: true }),
    stamp: async () => ({ ok: true, exists: true }),
    save: async () => ({ ok: true }),
  } })
  await h.controller.loadChange({ ...selection, sessionId: PIPE_SESSION })
  const left = paneText(h.host, 'original'), right = paneText(h.host, 'proposed')
  const shown = {
    original: left ? String(left.value ?? '') : '',
    changed: right ? String(right.value ?? '') : '',
    stillAskingForAnOriginal: h.host.textContent.includes('No original file is open yet.'),
    currentFileFallback: h.host.textContent.includes('The original version could not be established:')
      && h.host.textContent.includes('BOTH PANES SHOW THE CURRENT FILE'),
  }
  h.controller.close()
  return shown
}

test('a Claude edit opens both versions, and the original is the file as it actually was', async () => {
  const session = providerSession()
  session.run('Edit', { file_path: PIPE_PATH, old_string: 'before', new_string: 'after' })
  const shown = await compareVersionsOnScreen(session.selection())
  assert.equal(shown.changed, PIPE_DISK)
  assert.equal(shown.original, 'line one\nbefore\nline three\n',
    'the left pane must hold the file as it stood before the session edited it')
  assert.equal(shown.stillAskingForAnOriginal, false, 'the original pane must not still be asking for a file')
})

test('a run of Claude edits rewinds through every step, newest first', async () => {
  const session = providerSession()
  session.run('Edit', { file_path: PIPE_PATH, old_string: 'before', new_string: 'middle' })
  session.run('Edit', { file_path: PIPE_PATH, old_string: 'middle', new_string: 'after' })
  const shown = await compareVersionsOnScreen(session.selection())
  assert.equal(shown.original, 'line one\nbefore\nline three\n',
    'two edits must rewind to the text before the FIRST of them, not the second')
})

test('a Claude write cannot invent an original, because it never carried one', async () => {
  const session = providerSession()
  session.run('Write', { file_path: PIPE_PATH, content: PIPE_DISK })
  const shown = await compareVersionsOnScreen(session.selection())
  assert.equal(shown.changed, PIPE_DISK, 'the current file is still editable')
  assert.equal(shown.original, PIPE_DISK, 'without a previous version, both editable panes contain the current file')
  assert.equal(shown.currentFileFallback, true, 'the window must explicitly say this is the current file and the original could not be established')
  assert.equal(shown.stillAskingForAnOriginal, false, 'both panes are already open for the requested comparison workflow')
})

test('a write after an edit refuses the whole rewind rather than a partial one', async () => {
  const session = providerSession()
  session.run('Edit', { file_path: PIPE_PATH, old_string: 'before', new_string: 'after' })
  session.run('Write', { file_path: PIPE_PATH, content: PIPE_DISK })
  const shown = await compareVersionsOnScreen(session.selection())
  assert.equal(shown.original, PIPE_DISK,
    'one unrewindable step must retain the current file, never a partial rewind that did not exist')
  assert.equal(shown.currentFileFallback, true, 'the current-file fallback must be explicit')
})

test('the compare window refuses an original it cannot locate exactly', async () => {
  for (const [why, payload, disk] of [
    ['replace_all cannot know which matches the original had',
      { file_path: PIPE_PATH, old_string: 'x', new_string: 'after', replace_all: true }, PIPE_DISK],
    ['the after-text is no longer on disk, so the file moved on',
      { file_path: PIPE_PATH, old_string: 'before', new_string: 'vanished' }, PIPE_DISK],
    ['the after-text appears twice, so the right place is unknowable',
      { file_path: PIPE_PATH, old_string: 'before', new_string: 'twice' }, 'twice\nkeep\ntwice\n'],
  ]) {
    const session = providerSession()
    session.run('Edit', payload)
    const shown = await compareVersionsOnScreen(session.selection(), disk)
    assert.equal(shown.original, disk, `showed a reconstructed original when ${why}`)
    assert.equal(shown.currentFileFallback, true, `did not identify the current-file fallback when ${why}`)
    assert.equal(shown.changed, disk, 'the current file stays editable even when the original is refused')
  }
})

test('losing old history stops only the files that were in it', async () => {
  const store = createSessionChangeStore()
  /* Overrun the event bound so old batches are evicted. That loss is real, and
     the files those batches carried genuinely cannot be rewound any more. */
  for (let index = 0; index < CHANGE_LIMITS.events + 1; index++) {
    store.add({ id: `filler-${index}`, files: [{ path: `/filler-${index}.txt`, status: 'M', added: 1, removed: 0 }], patches: [] })
  }
  /* This file arrives AFTER that eviction with its whole chain intact, so
     nothing about it was lost. A single global "history was truncated" flag
     refused it anyway, which is what turned one busy session into a
     permanently single-pane Compare window for files it had full patches for. */
  store.add({ id: 'kept', files: [{ path: '/kept.txt', status: 'M', added: 1, removed: 1 }],
    patches: [{ path: '/kept.txt', diff: '@@ -1 +1 @@\n-before\n+after\n' }] })
  assert.equal(store.read().files.find(file => file.path === '/kept.txt').complete, true,
    'a file whose own history is intact must stay rewindable after an unrelated batch is evicted')
  /* The promise still holds in the other direction: an evicted batch leaves no
     file behind for the window to reconstruct from a chain it no longer has. */
  assert.equal(store.read().files.find(file => file.path === '/filler-0.txt'), undefined,
    'an evicted batch must not leave a file that could be wrongly reconstructed')
})
