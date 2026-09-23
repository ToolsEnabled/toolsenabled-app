/* THE SENTENCE A PERSON READS WHEN THEIR SETTINGS DID NOT LOAD.
 *
 * shell/renderer-prefs.cjs stopped an unreadable settings file from being
 * replaced, and tools/test/renderer-prefs.test.mjs proves the bytes survive.
 * That is only half the fix. The other half is that somebody is TOLD -- because
 * a preserved file nobody mentions produces exactly the experience the silent
 * factory reset produced: an application wearing none of your choices, no
 * error, and the only available conclusion being that the software threw your
 * settings away.
 *
 * These tests are over the copy and the mounting. THEY CANNOT SEE WHETHER THE
 * NOTICE IS ACTUALLY ON SCREEN in the shipped application -- a module can be
 * perfect here and never be mounted, which is this codebase's most repeated
 * near miss. The damaged-record scenario in tools/prefs-origin-proof.mjs reads
 * the notice out of the running packaged application's real DOM over CDP, and
 * that is the assertion that decides whether the person is told.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { mountSettingsRecoveryNotice, settingsRecoveryNotice } from '../../src/settings-recovery-notice.js'

/* A DOM small enough to read in one sitting. It supports exactly what the
   module uses, so a call to anything else fails loudly instead of being
   silently absorbed by a permissive stub. */
class FakeElement {
  constructor(doc, tagName) {
    this.ownerDocument = doc
    this.tagName = String(tagName).toUpperCase()
    this.children = []
    this.parentNode = null
    this.attributes = new Map()
    this.listeners = new Map()
    this.className = ''
    this.type = ''
    this._text = ''
  }

  set textContent(value) {
    this._text = String(value)
    this.children = []
  }

  get textContent() {
    return this.children.length ? this.children.map((child) => child.textContent).join('') : this._text
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)) }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null }

  appendChild(child) {
    child.parentNode = this
    this.children.push(child)
    return child
  }

  removeChild(child) {
    this.children = this.children.filter((entry) => entry !== child)
    child.parentNode = null
    return child
  }

  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, [])
    this.listeners.get(name).push(listener)
  }

  dispatch(name) { for (const listener of this.listeners.get(name) || []) listener() }

  find(predicate) {
    if (predicate(this)) return this
    for (const child of this.children) {
      const hit = child.find(predicate)
      if (hit) return hit
    }
    return null
  }
}

class FakeDocument {
  constructor() { this.body = new FakeElement(this, 'body') }
  createElement(tagName) { return new FakeElement(this, tagName) }
}

/* Stands in for window.mcPrefsNotice, which public/durable-storage.js exposes.
   `announce` is how the late arrival of preservedAt is simulated: the file is
   only moved when a write happens, so the page is told after boot. */
function noticeSource(initial) {
  let state = initial
  const listeners = []
  return {
    read: () => state,
    subscribe(listener) {
      listeners.push(listener)
      return () => {
        const at = listeners.indexOf(listener)
        if (at >= 0) listeners.splice(at, 1)
      }
    },
    announce(next) {
      state = next
      for (const listener of listeners.slice()) listener(state)
    },
  }
}

const RECORD = 'C:\\Users\\someone\\AppData\\Roaming\\ToolsEnabled\\renderer-prefs.json'
const MOVED = 'C:\\Users\\someone\\AppData\\Roaming\\ToolsEnabled\\renderer-prefs.damaged-2026-03-04T05-06-07-008Z.json'

/* ---------- what it says ---------- */

test('a settings file that loaded fine says nothing at all', () => {
  assert.equal(settingsRecoveryNotice({ damaged: null, file: RECORD, preservedAt: null }), null)
  assert.equal(settingsRecoveryNotice(null), null)
  assert.equal(settingsRecoveryNotice({}), null)
})

test('before the file is moved, the person is told it is still there', () => {
  const notice = settingsRecoveryNotice({
    damaged: 'the settings file contains malformed JSON',
    file: RECORD,
    preservedAt: null,
  })

  assert.equal(notice.kind, 'damaged')
  // The three facts, each one load-bearing: why the defaults are showing, that
  // nothing was destroyed, and where the file is.
  assert.match(notice.body, /malformed JSON/)
  assert.match(notice.body, /default settings/)
  assert.match(notice.body, /Nothing has been deleted/)
  assert.equal(notice.path, RECORD)
})

test('once the file has been moved, the person is told where it went', () => {
  const notice = settingsRecoveryNotice({
    damaged: 'the settings file contains malformed JSON',
    file: RECORD,
    preservedAt: MOVED,
  })

  assert.equal(notice.kind, 'preserved')
  assert.equal(notice.path, MOVED, 'the dated copy is the file they can actually go and get')
  assert.match(notice.body, /Nothing was deleted/)
  // Past tense, because by the time this renders the move has happened and has
  // been confirmed by the write that caused it. A notice that says where a file
  // WILL go is making a claim about the future.
  assert.doesNotMatch(notice.body, /will/)
})

test('a preserved copy is still announced if the reason for it went missing', () => {
  // Defensive: preservedAt without damaged should not be reachable, because the
  // store latches damaged before it can ever move a file. If it happens anyway,
  // going silent would strand a real file nobody knows about.
  const notice = settingsRecoveryNotice({ damaged: null, file: RECORD, preservedAt: MOVED })

  assert.equal(notice.kind, 'preserved')
  assert.equal(notice.path, MOVED)
  assert.match(notice.body, /could not be read/)
})

test('the message survives a store that reported no reason and no path', () => {
  const notice = settingsRecoveryNotice({ damaged: 'the settings file could not be read (EBUSY)', file: null, preservedAt: null })

  assert.equal(notice.kind, 'damaged')
  assert.equal(notice.path, null)
  assert.equal(notice.pathLabel, null, 'no label without a path, rather than "it is at: undefined"')
  assert.match(notice.body, /EBUSY/)
})

/* ---------- putting it on the page ---------- */

test('nothing is mounted when the settings file loaded fine', () => {
  const doc = new FakeDocument()
  const handle = mountSettingsRecoveryNotice({ doc, source: noticeSource({ damaged: null, file: RECORD, preservedAt: null }) })

  assert.equal(handle.element(), null)
  assert.equal(doc.body.children.length, 0)
})

test('a plain browser mounts nothing, because there is no settings file to report on', () => {
  const doc = new FakeDocument()

  // window.mcPrefsNotice does not exist under `vite dev`: there is no shell, no
  // durable file, and therefore no state to invent.
  assert.equal(mountSettingsRecoveryNotice({ doc, source: undefined }), null)
  assert.equal(doc.body.children.length, 0)
})

test('the notice appears on the page and names the file', () => {
  const doc = new FakeDocument()
  mountSettingsRecoveryNotice({ doc, source: noticeSource({ damaged: 'the settings file contains malformed JSON', file: RECORD, preservedAt: null }) })

  assert.equal(doc.body.children.length, 1)
  const root = doc.body.children[0]
  assert.equal(root.getAttribute('data-settings-recovery'), 'damaged')
  assert.equal(root.getAttribute('role'), 'status')
  assert.match(root.textContent, /Nothing has been deleted/)
  assert.ok(root.textContent.includes(RECORD), 'the path is on the page, not merely in the model')
})

test('the notice updates itself when the file is finally moved', () => {
  const doc = new FakeDocument()
  const source = noticeSource({ damaged: 'the settings file contains malformed JSON', file: RECORD, preservedAt: null })
  mountSettingsRecoveryNotice({ doc, source })
  assert.ok(doc.body.children[0].textContent.includes(RECORD))

  // The write that moves the file is what tells the page. Before this, saying
  // the file had moved would have been false.
  source.announce({ damaged: 'the settings file contains malformed JSON', file: RECORD, preservedAt: MOVED })

  assert.equal(doc.body.children.length, 1, 'the notice is replaced, not duplicated')
  const root = doc.body.children[0]
  assert.equal(root.getAttribute('data-settings-recovery'), 'preserved')
  assert.ok(root.textContent.includes(MOVED))
})

test('dismissing it clears it for this window and it does not come back on an update', () => {
  const doc = new FakeDocument()
  const source = noticeSource({ damaged: 'the settings file contains malformed JSON', file: RECORD, preservedAt: null })
  mountSettingsRecoveryNotice({ doc, source })

  const dismiss = doc.body.children[0].find((node) => node.tagName === 'BUTTON')
  dismiss.dispatch('click')
  assert.equal(doc.body.children.length, 0)

  // The dismissal is not saved anywhere -- it cannot honestly be, since the
  // only place to save it is the settings file that could not be read. It holds
  // for this window and the notice returns next launch while the fault does.
  source.announce({ damaged: 'the settings file contains malformed JSON', file: RECORD, preservedAt: MOVED })
  assert.equal(doc.body.children.length, 0)
})

test('a path is put on the page as text, never as markup', () => {
  const doc = new FakeDocument()
  const hostile = 'C:\\Users\\<img src=x onerror=alert(1)>\\renderer-prefs.json'
  mountSettingsRecoveryNotice({ doc, source: noticeSource({ damaged: 'the settings file contains malformed JSON', file: hostile, preservedAt: null }) })

  // A filesystem path is chosen by nobody on this team. The notice builds
  // elements and assigns textContent rather than concatenating markup, so the
  // characters below are characters.
  const code = doc.body.children[0].find((node) => node.tagName === 'CODE')
  assert.equal(code.textContent, hostile)
  assert.equal(code.children.length, 0)
})

test('destroying the notice unsubscribes it', () => {
  const doc = new FakeDocument()
  const source = noticeSource({ damaged: 'the settings file contains malformed JSON', file: RECORD, preservedAt: null })
  const handle = mountSettingsRecoveryNotice({ doc, source })

  handle.destroy()
  source.announce({ damaged: 'the settings file contains malformed JSON', file: RECORD, preservedAt: MOVED })

  assert.equal(doc.body.children.length, 0)
})

test('a read failure is not absence, is not latched, and dismissal remains window-scoped', () => {
  const doc = new FakeDocument()
  let reads = 0
  const busy = Object.assign(new Error('the bridge is busy'), { code: 'EBUSY' })
  const source = {
    read() {
      reads += 1
      if (reads === 1) throw busy
      return { damaged: null, file: RECORD, preservedAt: null }
    },
    subscribe: () => () => {},
  }

  // This module is an explanation. Failing loudly here would cost the person
  // the whole application on top of their settings. Going silent would turn
  // "could not check" into the equally false definite answer "nothing wrong".
  const handle = mountSettingsRecoveryNotice({ doc, source })

  assert.equal(handle.element().getAttribute('data-settings-recovery'), 'unavailable')
  assert.match(handle.element().textContent, /EBUSY/)
  assert.match(handle.element().textContent, /does not mean the settings file is absent/)

  handle.refresh()
  assert.equal(reads, 2, 'a transient read failure is retried rather than cached')
  assert.equal(handle.element(), null, 'the successful retry replaces the could-not-tell answer')
  assert.equal(doc.body.children.length, 0)

  // CONTROL: the intentional window-scoped latch still exists. This prevents
  // a blanket "never retain state" change from passing while breaking dismiss.
  const damaged = noticeSource({ damaged: 'the settings file contains malformed JSON', file: RECORD, preservedAt: null })
  const dismissed = mountSettingsRecoveryNotice({ doc, source: damaged })
  dismissed.element().find((node) => node.tagName === 'BUTTON').dispatch('click')
  damaged.announce({ damaged: 'the settings file contains malformed JSON', file: RECORD, preservedAt: MOVED })

  assert.equal(dismissed.element(), null, 'dismissal remains latched for this window')
  assert.equal(doc.body.children.length, 0)
})
