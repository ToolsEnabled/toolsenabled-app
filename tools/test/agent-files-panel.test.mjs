/* THE FILES-AND-REPORTS PANEL, DRIVEN -- INCLUDING THE STATES A SCREENSHOT
 * NEVER CATCHES.
 *
 * Everything interesting about this panel is an EMPTY STATE or a REFUSAL: an
 * empty folder, a folder nobody has set up, a file this window cannot show, a
 * page with no shell behind it. Those are exactly the states a person reaches
 * on a fresh install and exactly the ones nobody screenshots, so they are
 * driven here rather than looked at.
 *
 * THE LAST TEST IN THIS FILE IS THE ONE THAT MATTERS MOST. It wires the panel
 * to the REAL shell/agent-files.cjs, over a REAL folder, with the REAL
 * workspace boundary staged out of a payload on disk, and presses Open on a
 * row. The path that arrives at the recorder standing in for shell.openPath is
 * asserted. Everything between a press and the operating system is therefore
 * real code, and the only thing faked is Electron itself.
 *
 * THE FAKE DOM IS SMALL ON PURPOSE, in the idiom of
 * tools/test/agent-compose-panel.test.mjs: it supports exactly what the panel
 * uses, so a call to anything else fails loudly instead of being absorbed by a
 * permissive stub. It implements event BUBBLING, because the panel delegates
 * every press from its root, and it implements `querySelectorAll` for ONE
 * selector -- the panel's own FOCUSABLE -- so the focus trap is driven rather
 * than described.
 *
 * WHAT IT CANNOT SEE: a real focus ring, a real tab order in a real browser,
 * and whether the view mounts this panel at all. The first two belong to
 * tools/a11y-keyboard-qa.mjs, which drives the packaged window; the third is
 * asserted against the view's source at the end of this file.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { FOCUSABLE, mountAgentFilesPanel } from '../../src/agent-files-panel.js'
import {
  FENCE_REFUSAL_CODES, FILES_PANEL, FILES_REFUSAL, fileRefusalSentence,
} from '../../src/agent-files-copy.js'
import { findingsInText } from '../check-plain-language.mjs'

const require_ = createRequire(import.meta.url)
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const { createAgentFileSurface, BOUNDARY_MODULE, FENCE_CODES } = require_(path.join(REPO, 'shell', 'agent-files.cjs'))
const { resolveCapabilityRoot } = require_(path.join(REPO, 'shell', 'capability-layer.cjs'))
const FENCE_FIXTURE = path.join(REPO, 'tools', 'test', 'fixtures', 'workspace-fence', BOUNDARY_MODULE)

/* ---------------- the fake DOM ---------------- */

const FOCUSABLE_TAGS = new Set(['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA'])

class FakeElement {
  constructor(doc, tagName) {
    this.ownerDocument = doc
    this.tagName = String(tagName).toUpperCase()
    this.children = []
    this.parentNode = null
    this.attributes = new Map()
    this.listeners = new Map()
    this.className = ''
    this.value = ''
    this.disabled = false
    this.hidden = false
    this._text = ''
  }

  set textContent(value) {
    this._text = String(value)
    for (const child of this.children) child.parentNode = null
    this.children = []
  }

  get textContent() {
    return this.children.length ? this.children.map(child => child.textContent).join('') : this._text
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)) }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null }
  removeAttribute(name) { this.attributes.delete(name) }
  hasAttribute(name) { return this.attributes.has(name) }
  toggleAttribute(name, force) {
    const on = force === undefined ? !this.attributes.has(name) : Boolean(force)
    if (on) this.attributes.set(name, '')
    else this.attributes.delete(name)
    return on
  }

  appendChild(child) {
    child.parentNode = this
    this.children.push(child)
    this._text = ''
    return child
  }

  removeChild(child) {
    this.children = this.children.filter(entry => entry !== child)
    child.parentNode = null
    return child
  }

  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, [])
    this.listeners.get(name).push(listener)
  }

  removeEventListener(name, listener) {
    const found = this.listeners.get(name)
    if (found) this.listeners.set(name, found.filter(entry => entry !== listener))
  }

  /* Fires on this node and then on every ancestor, which is what a real event
     does and what the panel's delegated click handler depends on. */
  dispatch(name, event = {}) {
    const packet = { target: this, preventDefault() { packet.defaultPrevented = true }, ...event }
    if (!packet.target) packet.target = this
    let node = this
    while (node) {
      for (const listener of [...(node.listeners.get(name) || [])]) listener(packet)
      node = node.parentNode
    }
    return packet
  }

  focus() { if (this.disabled) return; this.ownerDocument.activeElement = this }

  /* ONE SELECTOR, and it must be the panel's own. Anything else is a call this
     fake cannot honestly answer, so it fails rather than returning nothing --
     a focus trap tested against an empty list is a focus trap not tested. */
  querySelectorAll(selector) {
    assert.equal(selector, FOCUSABLE, 'the fake DOM only answers the panel’s own focusable selector')
    return this.findAll(node => node !== this
      && (FOCUSABLE_TAGS.has(node.tagName) || (node.getAttribute('tabindex') || '-1') !== '-1')
      && !node.disabled
      && node.hidden !== true)
  }

  find(predicate) {
    if (predicate(this)) return this
    for (const child of this.children) {
      const hit = child.find(predicate)
      if (hit) return hit
    }
    return null
  }

  findAll(predicate, into = []) {
    if (predicate(this)) into.push(this)
    for (const child of this.children) child.findAll(predicate, into)
    return into
  }
}

class FakeDocument {
  constructor() {
    this.body = new FakeElement(this, 'body')
    this.activeElement = null
    this.listeners = new Map()
  }

  createElement(tagName) { return new FakeElement(this, tagName) }
  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, [])
    this.listeners.get(name).push(listener)
  }

  removeEventListener(name, listener) {
    const found = this.listeners.get(name)
    if (found) this.listeners.set(name, found.filter(entry => entry !== listener))
  }

  /* A key press the document hears, which is where the panel puts its trap. */
  key(key, extra = {}) {
    const packet = { key, preventDefault() { packet.defaultPrevented = true }, ...extra }
    for (const listener of [...(this.listeners.get('keydown') || [])]) listener(packet)
    return packet
  }
}

/* ---------------- helpers ---------------- */

/* THREE ROWS, AND EACH ONE IS A DIFFERENT PAIR OF ANSWERS FROM THE SHELL. A
   report this window can show and this computer can open; a PDF it can only
   open; and a file it can show and must never hand over, which is the row the
   whole kind rule exists for. */
const SAMPLE_FILES = Object.freeze([
  Object.freeze({ name: 'REPORT-the-run.md', bytes: 42, changedAt: '2026-08-26T10:00:00.000Z', kind: 'report', readable: true, openable: true }),
  Object.freeze({ name: 'invoice.pdf', bytes: 900, changedAt: '2026-08-25T10:00:00.000Z', kind: 'other', readable: false, openable: true }),
  Object.freeze({ name: 'cleanup.bat', bytes: 120, changedAt: '2026-08-24T10:00:00.000Z', kind: 'script', readable: true, openable: false }),
])

function recordingBridge(overrides = {}) {
  const calls = []
  const bridge = {
    folders: async () => { calls.push(['folders']); return overrides.folders || { ok: true, folders: [{ id: 'chosen-0', kind: 'chosen', name: 'Work' }] } },
    list: async request => { calls.push(['list', request]); return overrides.list || { ok: true, folderId: request.folderId, total: SAMPLE_FILES.length, truncated: false, files: [...SAMPLE_FILES] } },
    open: async request => { calls.push(['open', request]); return overrides.open || { ok: true, name: request.name } },
    reveal: async request => { calls.push(['reveal', request]); return overrides.reveal || { ok: true, name: request.name } },
    read: async request => { calls.push(['read', request]); return overrides.read || { ok: true, name: request.name, kind: 'report', text: '# What I did\nline two\n' } },
  }
  return { bridge, calls }
}

async function open(options = {}) {
  const doc = new FakeDocument()
  const container = doc.createElement('div')
  doc.body.appendChild(container)
  const handle = mountAgentFilesPanel({ doc, container, locale: 'en-GB', ...options })
  await handle.ready()
  return { doc, container, handle }
}

const at = (container, attribute, value) =>
  container.find(node => node.getAttribute(attribute) === value)
const statusOf = container => at(container, 'data-files-status', 'panel')
const emptyOf = container => at(container, 'data-files-empty', 'panel')
const rowOf = (container, name) => at(container, 'data-files-row', name)
const buttonIn = (row, action) => row.find(node => node.getAttribute('data-files-action') === action)
const wordsOnScreen = container => container
  .findAll(node => node.children.length === 0)
  .map(node => node.textContent.trim())
  .filter(Boolean)
/* How many places on the screen carry this sentence. One condition belongs in
   one slot; two is the finding tools/check-composed-output.mjs was built for. */
const saidOnScreen = (container, sentence) =>
  wordsOnScreen(container).filter(said => said === sentence).length

/* ---------------- what it says ---------------- */

test('the panel says where its list comes from, and does not claim an agent made it', async () => {
  const { bridge } = recordingBridge()
  const { container } = await open({ bridge })
  const words = wordsOnScreen(container)
  assert.ok(words.includes(FILES_PANEL.source))
  assert.ok(words.includes(FILES_PANEL.honesty),
    'the panel must say that nothing records which files an agent wrote')
  for (const said of words) {
    assert.doesNotMatch(said, /your agent (made|wrote|produced)/i,
      'nothing on this computer records that, so the screen must not say it')
  }
})

test('every word this panel puts on screen is plain enough for the copy gate', async () => {
  const { bridge } = recordingBridge()
  const { container } = await open({ bridge })
  for (const said of wordsOnScreen(container)) {
    assert.deepEqual(findingsInText(said), [], `“${said}” would fail tools/check-plain-language.mjs`)
  }
})

/* ---------------- the empty states ---------------- */

test('an empty folder is a sentence, not an empty box', async () => {
  const { bridge } = recordingBridge({ list: { ok: true, total: 0, truncated: false, files: [] } })
  const { container } = await open({ bridge })
  assert.equal(emptyOf(container).textContent, FILES_PANEL.emptyFolder)
  assert.equal(container.findAll(node => node.getAttribute('data-files-row')).length, 0)
})

test('no folder set up says so ONCE, and disables the chooser with the reason on it', async () => {
  const { bridge } = recordingBridge({ folders: { ok: true, folders: [] } })
  const { container } = await open({ bridge })
  const chooser = at(container, 'data-files-folder', 'chooser')
  assert.equal(chooser.disabled, true)
  assert.equal(chooser.getAttribute('title'), FILES_PANEL.noFolders)
  assert.equal(at(container, 'data-files-notice', 'panel').textContent, FILES_PANEL.noFolders)
  /* AND NOWHERE ELSE. This panel used to publish this one condition into the
     notice AND into the list at the same moment -- the exact shape
     tools/check-composed-output.mjs was written for, in two boxes, one above
     the other. The list is not what failed, so the list says nothing. */
  assert.equal(emptyOf(container), null, 'the sentence belongs in one slot, not in two')
  assert.equal(saidOnScreen(container, FILES_PANEL.noFolders), 1)
  /* Refresh stays live, because the sentence sends a person to Settings and
     back, and a control that refuses to notice they did as they were told is
     worse than no sentence at all. */
  assert.equal(at(container, 'data-files-action', 'refresh').disabled, false)
})

test('no shell behind the page leaves every control drawn, disabled, and explained', async () => {
  const { container } = await open({ bridge: null })
  const controls = container.findAll(node => node.getAttribute('data-files-action'))
  assert.ok(controls.length >= 1, 'the controls must still be drawn')
  for (const control of controls) {
    assert.equal(control.disabled, true)
    assert.equal(control.getAttribute('title'), FILES_PANEL.needsApp,
      'a control that cannot succeed must carry the reason it cannot')
  }
  assert.equal(at(container, 'data-files-notice', 'panel').textContent, FILES_PANEL.needsApp)
})

/* ---------------- the rows ---------------- */

test('a row offers Open and Show in folder, and disables Read with the reason beside it', async () => {
  const { bridge } = recordingBridge()
  const { container } = await open({ bridge })

  const report = rowOf(container, 'REPORT-the-run.md')
  assert.equal(buttonIn(report, 'open').disabled, false)
  assert.equal(buttonIn(report, 'reveal').disabled, false)
  assert.equal(buttonIn(report, 'read').disabled, false)
  assert.equal(report.find(node => node.getAttribute('data-files-why') === 'REPORT-the-run.md'), null)

  const other = rowOf(container, 'invoice.pdf')
  const read = buttonIn(other, 'read')
  assert.equal(read.disabled, true, 'a file this window cannot show must not offer a live Read')
  assert.equal(read.getAttribute('title'), FILES_PANEL.openInstead)
  const beside = other.find(node => node.getAttribute('data-files-why') === 'invoice.pdf')
  assert.ok(beside, 'the reason must be BESIDE the control, not only in a tooltip')
  assert.equal(beside.textContent, FILES_PANEL.openInstead)
  /* And Open, which is what a person should press for that file, is live. */
  assert.equal(buttonIn(other, 'open').disabled, false)
})

test('a file this computer would RUN keeps every control but Open, and says why beside it', async () => {
  const { bridge, calls } = recordingBridge()
  const { container } = await open({ bridge })
  const row = rowOf(container, 'cleanup.bat')
  assert.ok(row, 'a file this window will not open must still be on the list')

  const openControl = buttonIn(row, 'open')
  assert.equal(openControl.disabled, true, 'a kind that can start a program must not offer a live Open')
  assert.equal(openControl.getAttribute('title'), FILES_PANEL.openRefused)
  const beside = row.find(node => node.getAttribute('data-files-why-action') === 'open')
  assert.ok(beside, 'the reason must be BESIDE the control, not only in a tooltip')
  assert.equal(beside.textContent, FILES_PANEL.openRefused)
  assert.equal(beside.getAttribute('data-files-why'), 'cleanup.bat')

  /* THE TWO WAYS LEFT ARE BOTH LIVE. Show in folder starts no program, and
     reading it here is the only way to see what it would do. */
  assert.equal(buttonIn(row, 'reveal').disabled, false)
  assert.equal(buttonIn(row, 'read').disabled, false)

  /* AND A PRESS ON THE SWITCHED-OFF CONTROL REACHES NOTHING. A real browser
     fires no click on a disabled button; a driver and an assistive technology
     both can, and the whole point of the refusal is that no press gets past it. */
  const before = calls.length
  openControl.dispatch('click')
  for (let turn = 0; turn < 4; turn += 1) await Promise.resolve()
  assert.equal(calls.length, before, 'a press on a refused Open reached the bridge')
})

test('a file that can neither be shown here nor handed over is not told to open it instead', async () => {
  const files = [{ name: 'installer.exe', bytes: 900, changedAt: '2026-08-26T10:00:00.000Z', kind: 'other', readable: false, openable: false }]
  const { bridge } = recordingBridge({ list: { ok: true, total: 1, truncated: false, files } })
  const { container } = await open({ bridge })
  const row = rowOf(container, 'installer.exe')
  assert.equal(buttonIn(row, 'read').getAttribute('title'), FILES_PANEL.showInstead,
    '“Open it instead” points at a control this row has switched off')
  assert.equal(buttonIn(row, 'open').getAttribute('title'), FILES_PANEL.openRefused)
  assert.equal(buttonIn(row, 'reveal').disabled, false, 'the one way left must stay live')
})

test('pressing Open asks for that file in that folder, and says what happened', async () => {
  const { bridge, calls } = recordingBridge()
  const { container } = await open({ bridge })
  buttonIn(rowOf(container, 'invoice.pdf'), 'open').dispatch('click')
  await Promise.resolve(); await Promise.resolve()
  assert.deepEqual(calls.at(-1), ['open', { folderId: 'chosen-0', name: 'invoice.pdf' }])
  assert.equal(statusOf(container).textContent, FILES_PANEL.opened)
})

test('pressing Show in folder asks for the same file, and says what happened', async () => {
  const { bridge, calls } = recordingBridge()
  const { container } = await open({ bridge })
  buttonIn(rowOf(container, 'invoice.pdf'), 'reveal').dispatch('click')
  await Promise.resolve(); await Promise.resolve()
  assert.deepEqual(calls.at(-1), ['reveal', { folderId: 'chosen-0', name: 'invoice.pdf' }])
  assert.equal(statusOf(container).textContent, FILES_PANEL.revealed)
})

/* ---------------- refusals ---------------- */

test('a refusal is shown as a sentence, and the code is carried where nobody reads it', async () => {
  const refusals = [
    ['FILES_NO_PROGRAM', 'Failed to open path C:\\Users\\somebody\\invoice.pdf'],
    ['FILES_OUTSIDE_FOLDER', "'x' was asked to reach outside this installation's workspace folder"],
    ['FILES_NOT_THERE', 'The file could not be found in that folder (ENOENT).'],
  ]
  for (const [code, reason] of refusals) {
    const { bridge } = recordingBridge({ open: { ok: false, code, reason } })
    const { container } = await open({ bridge })
    buttonIn(rowOf(container, 'invoice.pdf'), 'open').dispatch('click')
    await Promise.resolve(); await Promise.resolve()
    const status = statusOf(container)
    assert.equal(status.textContent, fileRefusalSentence({ code }))
    assert.equal(status.getAttribute('data-refusal-code'), code)
    /* THE TWO THINGS THAT MUST NEVER BE ON THE GLASS. The identifier, and the
       shell's own `reason` -- which here carries a person's full path and a
       sentence written for whoever holds the repository. */
    for (const said of wordsOnScreen(container)) {
      assert.doesNotMatch(said, /FILES_[A-Z_]+/, 'a machine code reached the screen')
      assert.ok(!said.includes(reason), 'the shell’s own reason reached the screen')
      assert.doesNotMatch(said, /[A-Za-z]:\\/, 'a full path reached the screen')
    }
  }
})

test('a bridge that throws is a sentence too, never a blank panel', async () => {
  const { bridge } = recordingBridge()
  bridge.open = async () => { throw new Error('the shell went away') }
  const { container } = await open({ bridge })
  buttonIn(rowOf(container, 'invoice.pdf'), 'open').dispatch('click')
  await Promise.resolve(); await Promise.resolve()
  const said = statusOf(container).textContent
  assert.ok(said.length > 0, 'a throw must not leave the panel silent')
  assert.doesNotMatch(said, /went away/, 'an Error’s own words are not customer copy')
})

test('a read that came back with nothing is a sentence, not an empty panel', async () => {
  /* NOTHING IS NOT AN ANSWER, and it is not "there are no folders" either. A
     panel that renders a read it never got as an empty state is this codebase's
     signature defect wearing its other costume: absence shown as a value. */
  for (const [verb, where] of [['folders', 'data-files-notice'], ['list', 'data-files-empty']]) {
    const { bridge } = recordingBridge()
    bridge[verb] = async () => { throw new Error('the shell went away') }
    const { container } = await open({ bridge })
    const said = at(container, where, 'panel')
    assert.ok(said, `a ${verb} that threw left the panel with nothing on it`)
    assert.ok(said.textContent.length > 0)
    assert.notEqual(said.textContent, FILES_PANEL.noFolders,
      'a read that failed must not be reported as a computer with no folders on it')
    assert.notEqual(said.textContent, FILES_PANEL.emptyFolder,
      'a read that failed must not be reported as a folder with nothing in it')
    for (const word of wordsOnScreen(container)) {
      assert.doesNotMatch(word, /went away/, 'an Error’s own words are not customer copy')
    }
  }
})

/* ---------------- the reading pane ---------------- */

async function openReport() {
  const { bridge } = recordingBridge()
  const opened = await open({ bridge })
  buttonIn(rowOf(opened.container, 'REPORT-the-run.md'), 'read').dispatch('click')
  await Promise.resolve(); await Promise.resolve()
  return opened
}

test('Read here shows the report’s own words, in a pane a keyboard can scroll', async () => {
  const { container } = await openReport()
  const pane = at(container, 'data-files-report', 'REPORT-the-run.md')
  assert.ok(pane, 'the reading pane did not open')
  assert.equal(pane.tagName, 'PRE', 'a report is shown as written, with no markdown library added')
  assert.equal(pane.textContent, '# What I did\nline two\n')
  assert.equal(pane.getAttribute('tabindex'), '0')
})

test('the reading pane takes focus, switches the panel off behind it, and gives focus back', async () => {
  const { doc, container } = await openReport()
  const dialog = at(container, 'data-files-dialog', 'REPORT-the-run.md')
  assert.equal(dialog.getAttribute('role'), 'dialog')
  assert.equal(dialog.getAttribute('aria-modal'), 'true')
  assert.equal(doc.activeElement.getAttribute('data-files-action'), 'close',
    'focus must land inside the pane, not stay on the row behind it')

  const panel = at(container, 'data-files-panel', 'agent')
  assert.equal(panel.hasAttribute('inert'), true, 'the list behind the pane must be switched off')
  assert.equal(dialog.parentNode.parentNode.getAttribute('data-files-viewer-root'), 'panel')
  assert.notEqual(dialog.find(node => node === panel), panel)

  doc.key('Escape')
  assert.equal(at(container, 'data-files-report', 'REPORT-the-run.md'), null, 'Escape must close the pane')
  assert.equal(panel.hasAttribute('inert'), false, 'the panel must come back on')
  assert.equal(doc.activeElement.getAttribute('data-files-action'), 'read',
    'focus must return to the control that opened the pane')
})

test('Tab cannot walk out of the reading pane', async () => {
  const { doc, container } = await openReport()
  const dialog = at(container, 'data-files-dialog', 'REPORT-the-run.md')
  const stops = dialog.querySelectorAll(FOCUSABLE)
  assert.ok(stops.length >= 2, 'the pane must have at least the Close control and the readable pane')

  doc.activeElement = stops[stops.length - 1]
  const forward = doc.key('Tab')
  assert.equal(forward.defaultPrevented, true)
  assert.equal(doc.activeElement, stops[0], 'Tab off the last stop must return to the first')

  const back = doc.key('Tab', { shiftKey: true })
  assert.equal(back.defaultPrevented, true)
  assert.equal(doc.activeElement, stops[stops.length - 1])
})

test('Close closes the pane', async () => {
  const { container } = await openReport()
  at(container, 'data-files-action', 'close').dispatch('click')
  assert.equal(at(container, 'data-files-report', 'REPORT-the-run.md'), null)
})

/* ---------------- the whole chain, for real ---------------- */

test('a press on a row reaches the operating system hand-off with the real path', async () => {
  const resources = mkdtempSync(path.join(tmpdir(), 'mc-files-panel-'))
  const payload = path.join(resources, 'capability')
  mkdirSync(path.join(payload, 'src', 'lib'), { recursive: true })
  writeFileSync(path.join(payload, 'PAYLOAD.json'), JSON.stringify({ bridgeEntrypoint: 'tools/mission-bridge.js' }))
  writeFileSync(path.join(payload, 'package.json'), JSON.stringify({ name: 'payload', private: true, type: 'commonjs' }))
  copyFileSync(FENCE_FIXTURE, path.join(payload, ...BOUNDARY_MODULE.split('/')))

  const folder = path.join(resources, 'work')
  mkdirSync(folder, { recursive: true })
  writeFileSync(path.join(folder, 'REPORT-the-run.md'), '# What I did\n')
  writeFileSync(path.join(folder, 'invoice.pdf'), '%PDF-1.7')
  utimesSync(path.join(folder, 'invoice.pdf'), new Date('2026-08-27T10:00:00Z'), new Date('2026-08-27T10:00:00Z'))

  const opened = []
  const revealed = []
  const surface = createAgentFileSurface({
    resolveCapabilityRoot: () => resolveCapabilityRoot({ resourcesPath: resources, repoRoot: resources }),
    requireModule: require_,
    readWorkspaceState: () => ({ ok: true, available: true, roots: [folder] }),
    listSessionProfiles: () => [],
    openPath: async target => { opened.push(target); return '' },
    showItemInFolder: target => { revealed.push(target) },
  })
  /* The bridge the preload exposes, in the shape it exposes it. */
  const bridge = {
    folders: () => Promise.resolve(surface.folders()),
    list: request => Promise.resolve(surface.list(request)),
    open: request => Promise.resolve(surface.open(request)),
    reveal: request => Promise.resolve(surface.reveal(request)),
    read: request => Promise.resolve(surface.read(request)),
  }

  const { container } = await open({ bridge })
  assert.ok(rowOf(container, 'invoice.pdf'), 'the real folder did not reach the screen')
  assert.ok(rowOf(container, 'REPORT-the-run.md'))

  buttonIn(rowOf(container, 'invoice.pdf'), 'open').dispatch('click')
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
  assert.deepEqual(opened, [path.join(folder, 'invoice.pdf')],
    'the press did not reach the operating system hand-off with the file it named')
  assert.equal(statusOf(container).textContent, FILES_PANEL.opened)

  buttonIn(rowOf(container, 'REPORT-the-run.md'), 'read').dispatch('click')
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
  assert.equal(at(container, 'data-files-report', 'REPORT-the-run.md').textContent, '# What I did\n',
    'the report read back through the real reader did not reach the pane')
})

/* ---------------- and the view mounts it ---------------- */

test('the agent view CALLS this panel, on a live page only, and takes it down again', () => {
  /* WHAT THIS TEST USED TO BE, AND WHY THAT WAS NOT A TEST. It matched the
     identifier `mountAgentFilesPanel` anywhere in the view -- which the IMPORT
     LINE satisfies. Measured: replacing the call with an inline no-op stub and
     leaving the import in place kept the whole suite green, on a test whose own
     failure message calls the thing it guards "the defect this product has
     shipped three times". So this reads the call, the gate around it and the
     teardown, each of which a mutation can remove on its own. */
  const view = readFileSync(path.join(REPO, 'src', 'views', 'agent.js'), 'utf8')
  assert.match(view, /import \{ mountAgentFilesPanel \} from '\.\.\/agent-files-panel\.js'/,
    'the view must import the real panel, not a stand-in')
  assert.match(view, /agent-files-panel\.css/,
    'the panel’s styles are imported by the view, because the module cannot import them and stay testable')

  const from = view.indexOf('const destroyFilesPanel')
  assert.ok(from !== -1, 'the view no longer mounts the files panel at all')
  const mount = view.slice(from, view.indexOf('\n  const ', from + 1))
  assert.match(mount, /mountAgentFilesPanel\(\{/,
    'the identifier is imported and never called, which is a panel nothing renders')
  assert.match(mount, /container:/)
  assert.match(mount, /bridge:/)
  /* THE GATE THE EXAMPLE PAGE DEPENDS ON. Directly beneath a banner reading "no
     control on this page reaches a real session", this panel would reach the
     person's own documents. Dropping `live` mounted it there and every suite
     stayed green. */
  assert.match(mount, /^const destroyFilesPanel\s*=\s*live\s*\?/,
    'the panel must be gated on a live session, like the three surfaces above it')
  assert.match(mount, /:\s*\(\)\s*=>\s*\{\}/, 'a page with no live session must get a teardown that does nothing')
  /* AND THE TEARDOWN IS CALLED. The panel puts a keydown handler on the
     document; one left attached swallows Escape on every page after this one. */
  assert.match(view, /\n\s*destroyFilesPanel\(\)/,
    'leaving this page must close the reading pane and detach its key handler')
})

test('the files panel keyboard ring consumes the defined theme focus token', () => {
  const css = readFileSync(path.join(REPO, 'src', 'agent-files-panel.css'), 'utf8')
  assert.match(
    css,
    /\.agent-files-action:focus-visible,[\s\S]*?outline:\s*2px solid var\(--focus-ring\)/,
    'the files controls need a resolvable outline; the packaged keyboard driver found var(--accent) computed to none',
  )
  assert.doesNotMatch(css, /var\(--accent\)/,
    'styles.css defines --focus-ring and --accent-2, not --accent')
})

/* ---------------- switching folders, refreshing, and a long folder ---------------- */

test('picking another folder lists that folder', async () => {
  const { bridge, calls } = recordingBridge({
    folders: {
      ok: true,
      folders: [
        { id: 'chosen-0', kind: 'chosen', name: 'Work' },
        { id: 'profile-abc', kind: 'profile', name: 'Invoices' },
        { id: 'product', kind: 'product', name: null },
      ],
    },
  })
  const { container } = await open({ bridge })
  const chooser = at(container, 'data-files-folder', 'chooser')
  assert.deepEqual(chooser.children.map(option => option.textContent),
    ['Work', 'Invoices', FILES_PANEL.productFolder],
    'the product’s own workspace is named by the panel, because its path never crosses')

  chooser.value = 'profile-abc'
  chooser.dispatch('change')
  await Promise.resolve(); await Promise.resolve()
  assert.deepEqual(calls.at(-1), ['list', { folderId: 'profile-abc' }])

  /* AND A PRESS AFTERWARDS GOES TO THE FOLDER ON SCREEN. Every other press in
     this file happens with the first folder selected, so a verb that read the
     folder once and kept it would pass all of them and open a file out of the
     wrong folder the moment somebody switched. */
  buttonIn(rowOf(container, 'invoice.pdf'), 'open').dispatch('click')
  for (let turn = 0; turn < 4; turn += 1) await Promise.resolve()
  assert.deepEqual(calls.at(-1), ['open', { folderId: 'profile-abc', name: 'invoice.pdf' }])

  buttonIn(rowOf(container, 'REPORT-the-run.md'), 'read').dispatch('click')
  for (let turn = 0; turn < 4; turn += 1) await Promise.resolve()
  assert.deepEqual(calls.at(-1), ['read', { folderId: 'profile-abc', name: 'REPORT-the-run.md' }])
})

test('a copy of the program with no fence switches this panel off and says why once', async () => {
  /* THE CLAIM THIS PANEL MADE AND DID NOT KEEP. shell/agent-files.cjs states
     that a copy with no fence "refuses every verb here ... and the screen
     disables its controls and says why". Measured before this test existed: the
     chooser and Refresh stayed live over a surface that refused everything,
     because folders() answers from records and needs no fence. */
  for (const code of FENCE_REFUSAL_CODES) {
    const { bridge } = recordingBridge({ list: { ok: false, code, reason: 'the shell’s own words' } })
    const { container } = await open({ bridge })
    const sentence = fileRefusalSentence({ code })
    assert.equal(at(container, 'data-files-notice', 'panel').textContent, sentence)
    assert.equal(saidOnScreen(container, sentence), 1, `${code} was said in more than one place`)
    assert.equal(at(container, 'data-files-action', 'refresh').disabled, true,
      'no press can succeed until the program is put back, so none is offered')
    assert.equal(at(container, 'data-files-action', 'refresh').getAttribute('title'), sentence)
    assert.equal(at(container, 'data-files-folder', 'chooser').disabled, true)
    assert.equal(statusOf(container).getAttribute('data-refusal-code'), code)
  }
})

test('the codes that mean the fence is gone are the shell’s own list', () => {
  /* Two lists in two modules, and the renderer's may not import the shell's:
     the panel must stay loadable without one. So they are compared here. A
     fourth cause of "there is no fence in this copy" added to the shell and not
     to the panel is a panel that leaves its controls live over a surface that
     refuses everything. */
  assert.deepEqual([...FENCE_REFUSAL_CODES], [...FENCE_CODES])
  for (const code of FENCE_REFUSAL_CODES) {
    assert.ok(Object.hasOwn(FILES_REFUSAL, code), `${code} has no sentence of its own`)
  }
})

test('a folder of the person’s own with no name is not offered as the product’s own', async () => {
  /* THE TWO NAMELESS CASES ARE NOT THE SAME CASE. The product's workspace has
     no name because its path must never cross; a folder the person chose can
     have no name because a drive root has no last segment. One label for both
     tells somebody their own drive is ours. */
  const { bridge } = recordingBridge({
    folders: {
      ok: true,
      folders: [
        { id: 'chosen-0', kind: 'chosen', name: null },
        { id: 'product', kind: 'product', name: null },
      ],
    },
  })
  const { container } = await open({ bridge })
  const chooser = at(container, 'data-files-folder', 'chooser')
  assert.deepEqual(chooser.children.map(option => option.textContent),
    [FILES_PANEL.folderUnnamed, FILES_PANEL.productFolder])
  assert.notEqual(FILES_PANEL.folderUnnamed, FILES_PANEL.productFolder)
})

test('Refresh asks again, from the folder list down', async () => {
  const { bridge, calls } = recordingBridge()
  const { container } = await open({ bridge })
  const before = calls.length
  at(container, 'data-files-action', 'refresh').dispatch('click')
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  assert.deepEqual(calls.slice(before).map(call => call[0]), ['folders', 'list'])
})

test('a folder with more files than fit says so, in figures', async () => {
  const files = Array.from({ length: 3 }, (unused, index) => ({
    name: `note-${index}.txt`, bytes: 10, changedAt: '2026-08-26T10:00:00.000Z', kind: 'text', readable: true,
  }))
  const { bridge } = recordingBridge({ list: { ok: true, total: 900, truncated: true, files } })
  const { container } = await open({ bridge })
  const note = at(container, 'data-files-note', 'list')
  assert.equal(note.hidden, false)
  assert.equal(note.textContent, 'Showing the newest 3 files of 900.')
})

test('a folder that cannot be read replaces the list with a sentence', async () => {
  const { bridge } = recordingBridge({
    list: { ok: false, code: 'FILES_FOLDER_UNREADABLE', reason: 'That folder could not be read (EPERM).' },
  })
  const { container } = await open({ bridge })
  assert.equal(emptyOf(container).textContent, fileRefusalSentence({ code: 'FILES_FOLDER_UNREADABLE' }))
  assert.equal(statusOf(container).getAttribute('data-refusal-code'), 'FILES_FOLDER_UNREADABLE')
})

/* ---------------- the whole refusal vocabulary ---------------- */

test('every refusal this bridge can return is a plain sentence with something to do in it', () => {
  const codes = Object.keys(FILES_REFUSAL)
  assert.ok(codes.length >= 15, 'the refusal table shrank; a code with no sentence falls back to a generic one')
  for (const code of codes) {
    const said = FILES_REFUSAL[code]
    assert.deepEqual(findingsInText(said), [], `“${said}” would fail tools/check-plain-language.mjs`)
    assert.doesNotMatch(said, /FILES_[A-Z_]+/, 'a refusal sentence must not carry its own code')
    assert.match(said, /\b(press|use|pick|open|check|try|reinstall|choose|show)\b/i,
      'a refusal that names nothing to do is a dead end')
  }
})

test('a folder set up after the panel said there were none comes back on Refresh', async () => {
  /* The sentence on the empty state sends a person to Settings and back. If the
     chooser stayed switched off after they did it, the panel would be telling
     them to do something it then refused to notice. */
  let answers = [{ ok: true, folders: [] }, { ok: true, folders: [{ id: 'chosen-0', kind: 'chosen', name: 'Work' }] }]
  const bridge = {
    folders: async () => answers.shift() || { ok: true, folders: [] },
    list: async request => ({ ok: true, folderId: request.folderId, total: 2, truncated: false, files: [...SAMPLE_FILES] }),
    open: async request => ({ ok: true, name: request.name }),
    reveal: async request => ({ ok: true, name: request.name }),
    read: async request => ({ ok: true, name: request.name, kind: 'report', text: 'x' }),
  }
  const { container } = await open({ bridge })
  const chooser = at(container, 'data-files-folder', 'chooser')
  assert.equal(chooser.disabled, true)

  at(container, 'data-files-action', 'refresh').dispatch('click')
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
  assert.equal(chooser.disabled, false, 'the chooser stayed switched off after a folder appeared')
  assert.equal(chooser.getAttribute('title'), null, 'the reason it was switched off is no longer true')
  assert.ok(rowOf(container, 'invoice.pdf'), 'the folder that appeared was never listed')
  assert.equal(at(container, 'data-files-notice', 'panel').hidden, true)
})
