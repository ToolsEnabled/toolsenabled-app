/* public/durable-storage.js replaces what `localStorage` MEANS in this
   application, so it is load-bearing for every setting the product has. These
   tests evaluate the real shipped file -- not a copy of its logic -- in a
   controlled scope, and then assert the one invariant the design depends on:
   that nothing in src/ reaches a stored value by named property access, which
   the replacement deliberately does not provide. */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = path.join(REPO_ROOT, 'public', 'durable-storage.js')
const SOURCE = fs.readFileSync(SCRIPT, 'utf8')

/* A stand-in for the browser store this origin already had, shaped like the
   real Storage so the migration path exercises length/key/getItem the way the
   shipped file does. `unreadable` reproduces a storage object that throws on
   access, which is the case that must NOT mark the origin migrated. */
function browserStore(entries, { unreadable = false } = {}) {
  const map = new Map(Object.entries(entries))
  return {
    marker: 'the untouched browser store',
    get length() {
      if (unreadable) throw new Error('Access is denied for this document')
      return map.size
    },
    key: (index) => Array.from(map.keys())[index] ?? null,
    getItem: (name) => (map.has(name) ? map.get(name) : null),
  }
}

function install({
  values = {},
  failWrites = false,
  available = true,
  bridge = undefined,
  legacy = {},
  legacyUnreadable = false,
  drainRequired = false,
  drainResult = undefined,
} = {}) {
  const calls = []
  const store = new Map(Object.entries(values))
  const ok = { ok: true }
  const failure = { ok: false, error: { code: 'MC_PREFS_WRITE_FAILED', message: 'the disk is full' } }
  const realLocalStorage = browserStore(legacy, { unreadable: legacyUnreadable })
  const window = {
    localStorage: realLocalStorage,
    mcPrefs: bridge === undefined ? {
      available,
      values,
      drainRequired,
      drain(entries) {
        calls.push(['drain', entries])
        return drainResult !== undefined
          ? drainResult
          : { ok: true, values: { ...Object.fromEntries(entries), ...values } }
      },
      write(key, value) {
        calls.push(['write', key, value])
        if (failWrites) return failure
        store.set(key, value)
        return ok
      },
      remove(key) {
        calls.push(['remove', key])
        if (failWrites) return failure
        store.delete(key)
        return ok
      },
      clear() {
        calls.push(['clear'])
        if (failWrites) return failure
        store.clear()
        return ok
      },
    } : bridge,
  }
  vm.runInNewContext(SOURCE, { window })
  return { window, calls, store, realLocalStorage }
}

test('a seeded setting is readable through the replaced store', () => {
  const { window } = install({ values: { 'mc.theme': 'black' } })

  assert.equal(window.localStorage.getItem('mc.theme'), 'black')
})

test('an unset key reads as null, exactly as the platform does', () => {
  const { window } = install()

  assert.equal(window.localStorage.getItem('mc.nothing'), null)
})

test('setItem reaches the host and is readable back without a round trip', () => {
  const { window, calls } = install()

  window.localStorage.setItem('mc.text', '1.12')

  assert.deepEqual(calls, [['write', 'mc.text', '1.12']])
  assert.equal(window.localStorage.getItem('mc.text'), '1.12')
})

test('keys and values are coerced to strings, as Storage does', () => {
  const { window, calls } = install()

  window.localStorage.setItem('mc.count', 7)

  assert.deepEqual(calls, [['write', 'mc.count', '7']])
  assert.equal(window.localStorage.getItem('mc.count'), '7')
})

test('removeItem clears the value locally and on the host', () => {
  const { window, calls } = install({ values: { 'mc.theme': 'black' } })

  window.localStorage.removeItem('mc.theme')

  assert.deepEqual(calls, [['remove', 'mc.theme']])
  assert.equal(window.localStorage.getItem('mc.theme'), null)
})

test('clear empties the store', () => {
  const { window } = install({ values: { 'mc.theme': 'black', 'mc.text': '1.12' } })

  window.localStorage.clear()

  assert.equal(window.localStorage.length, 0)
  assert.equal(window.localStorage.getItem('mc.theme'), null)
})

test('length and key() track the live contents', () => {
  const { window } = install({ values: { 'mc.theme': 'black' } })

  assert.equal(window.localStorage.length, 1)
  assert.equal(window.localStorage.key(0), 'mc.theme')
  assert.equal(window.localStorage.key(1), null)

  window.localStorage.setItem('mc.text', '1.12')

  assert.equal(window.localStorage.length, 2)
})

/* THE FAILURE PATH IS THE ONE THAT MATTERS. A write that silently does nothing
   puts the product straight back into the defect: the person changes a
   setting, nothing complains, and it is not there next time. */
test('a failed write throws instead of pretending it saved', () => {
  const { window } = install({ failWrites: true })

  assert.throws(
    () => window.localStorage.setItem('mc.theme', 'black'),
    /Could not save setting "mc\.theme".*disk is full/,
  )
})

test('a value is not cached locally when the host refused it', () => {
  const { window } = install({ failWrites: true })

  try { window.localStorage.setItem('mc.theme', 'black') } catch { /* asserted above */ }

  assert.equal(window.localStorage.getItem('mc.theme'), null)
})

test('a failed removal throws rather than reporting a deletion that did not happen', () => {
  const { window } = install({ values: { 'mc.theme': 'black' }, failWrites: true })

  assert.throws(() => window.localStorage.removeItem('mc.theme'), /Could not remove setting/)
  assert.equal(window.localStorage.getItem('mc.theme'), 'black')
})

/* IN A PLAIN BROWSER THIS FILE MUST DO NOTHING. Under vite dev or preview
   there is no shell to be durable against, and replacing the store with one
   backed by a bridge that is not there would break the app rather than fix it. */
test('without the shell bridge the real browser store is left untouched', () => {
  const { window, realLocalStorage } = install({ bridge: null })

  assert.equal(window.localStorage, realLocalStorage)
})

test('a shell that reports its settings file unavailable leaves the browser store alone', () => {
  const { window, realLocalStorage } = install({ available: false })

  assert.equal(window.localStorage, realLocalStorage)
})

test('the replacement cannot be silently overwritten by a stray assignment', () => {
  const { window } = install({ values: { 'mc.theme': 'black' } })

  // Non-writable on purpose: an assignment that quietly restored the
  // origin-scoped store would resurrect the defect with no sign of it.
  assert.throws(() => { 'use strict'; window.localStorage = { getItem: () => 'hijacked' } })
  assert.equal(window.localStorage.getItem('mc.theme'), 'black')
})

/* ---------- migrating an install that predates the durable store ----------
 *
 * These cover a defect that reached a packaged build and was caught only by
 * running the real upgrade: the migration was performed in the PRELOAD, which
 * executes against the initial empty document rather than the app origin. It
 * read a legacy install's two real settings as zero entries and then told the
 * host the origin had been migrated -- stranding them permanently. */

test('the browser copy is handed over before the global is replaced', () => {
  const { window, calls } = install({
    drainRequired: true,
    legacy: { 'mc.theme': 'black', 'mc.text': '1.12' },
  })

  /* Compared through JSON because the entries array is built inside the vm
     realm, so its prototype is not this realm's Array and a strict deep
     comparison rejects an identical structure. That is an artifact of how this
     test runs the real file, not a difference the product would ever see. */
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'drain')
  assert.deepEqual(
    JSON.parse(JSON.stringify(calls[0][1])),
    [['mc.theme', 'black'], ['mc.text', '1.12']],
  )
  assert.equal(window.localStorage.getItem('mc.theme'), 'black')
})

test('a durable value already held wins over the legacy copy', () => {
  const { window } = install({
    drainRequired: true,
    values: { 'mc.theme': 'tan' },
    legacy: { 'mc.theme': 'black' },
  })

  assert.equal(window.localStorage.getItem('mc.theme'), 'tan')
})

test('nothing is migrated once this origin has already been drained', () => {
  const { calls } = install({
    drainRequired: false,
    legacy: { 'mc.theme': 'black' },
  })

  assert.deepEqual(calls, [], 'a settled install must not re-read the browser store on every launch')
})

/* THE ONE THAT MATTERS. Marking an origin migrated on a read that did not
   happen is worse than not migrating at all: it is irreversible, and the
   settings are then invisible to every future launch. */
test('a browser store that cannot be read does not report a migration', () => {
  const { calls } = install({
    drainRequired: true,
    legacy: { 'mc.theme': 'black' },
    legacyUnreadable: true,
  })

  assert.deepEqual(
    calls,
    [],
    'The host marks an origin drained when drain() is called. Calling it after a failed read would '
    + 'record settings as rescued that were never read, stranding them for good.',
  )
})

test('a refused migration leaves the durable values the shell already had', () => {
  const { window } = install({
    drainRequired: true,
    values: { 'mc.theme': 'tan' },
    legacy: { 'mc.text': '1.12' },
    drainResult: { ok: false, error: { code: 'MC_PREFS_WRITE_FAILED', message: 'the disk is full' } },
  })

  assert.equal(window.localStorage.getItem('mc.theme'), 'tan')
})

/* ---------- where the install has to sit in the document ----------
 *
 * WHY A SOURCE-ORDER ASSERTION AND NOT A BEHAVIOUR ONE. The packaged proof
 * reads document.documentElement.dataset.theme, and that is the SETTLED theme:
 * src/main.js applies the stored theme when it evaluates, so by the time
 * anything can be observed the page has already corrected itself. Measured --
 * moving the install below the inline theme read and rebuilding the packaged
 * app did NOT fail the proof. What breaks in that build is the first paint: a
 * black-theme user gets a white flash, which is a frame, not a state, and the
 * gate cannot see it. Document order is the property that actually matters
 * here, so it is asserted directly rather than hoped for. */
function indexHtmlWithoutComments() {
  return fs.readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '')
}

test('the settings store is installed before anything in the document reads a setting', () => {
  const html = indexHtmlWithoutComments()
  const install = html.indexOf('/durable-storage.js')
  const firstRead = html.indexOf('localStorage')

  assert.notEqual(install, -1, 'index.html must load public/durable-storage.js')
  assert.ok(
    firstRead === -1 || install < firstRead,
    'The inline pre-paint theme read runs before any module, so the durable store must be installed '
    + 'above it. Below it, the theme is read from the origin-scoped store -- empty after a port '
    + 'change -- and a black-theme user gets a white flash that no assertion in the packaged proof '
    + 'can see, because src/main.js corrects the theme before anything can observe it.',
  )
})

test('the install is a classic script, because a module would be deferred', () => {
  const html = indexHtmlWithoutComments()
  const tag = /<script([^>]*)src="\/durable-storage\.js"([^>]*)>/.exec(html)

  assert.notEqual(tag, null)
  assert.equal(
    /type\s*=\s*"module"/.test(tag[1] + tag[2]),
    false,
    'A module script is deferred to after document parsing, which would put the install after the '
    + 'inline theme read no matter where the tag sits.',
  )
})

/* ---------- the invariant the design rests on ---------- */

function sourceFiles(directory) {
  const found = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) found.push(...sourceFiles(full))
    else if (entry.name.endsWith('.js')) found.push(full)
  }
  return found
}

/* COMMENTS AND STRINGS ARE NOT CODE, and this scan is worthless until it knows
   the difference. The first version of this test failed on
   src/checkout-principal.js, whose comment reads "...could write a different
   name into localStorage. The gate below is a real guard...". It reported
   `localStorage.The` as a violation. That is the instrument inventing a
   finding, and it is the same class of mistake as every source-text assertion
   that cannot see what it is looking at.

   A `/` is treated as starting a comment only when the next character is `/` or
   `*`. A regular expression literal containing `//` would therefore truncate
   its line; that costs a false negative on one line, never a false alarm, and
   no such literal exists in src/ today. */
function codeOnly(text) {
  let out = ''
  let index = 0
  while (index < text.length) {
    const char = text[index]
    const next = text[index + 1]
    if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index += 1
      continue
    }
    if (char === '/' && next === '*') {
      index += 2
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1
      index += 2
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      index += 1
      while (index < text.length && text[index] !== char) {
        if (text[index] === '\\') index += 1
        index += 1
      }
      index += 1
      continue
    }
    out += char
    index += 1
  }
  return out
}

test('the source scanner reads code and ignores prose', () => {
  // Measured against the exact comment that produced a false finding.
  const stripped = codeOnly('// write a name into localStorage. The gate below\nlocalStorage.getItem("k")')

  assert.equal(stripped.includes('localStorage.The'), false)
  assert.equal(stripped.includes('localStorage.getItem'), true)
})

test('nothing in src/ reaches a setting by named property access', () => {
  const permitted = new Set(['getItem', 'setItem', 'removeItem', 'clear', 'key', 'length'])
  const offenders = []

  for (const file of sourceFiles(path.join(REPO_ROOT, 'src'))) {
    const text = codeOnly(fs.readFileSync(file, 'utf8'))
    for (const match of text.matchAll(/localStorage\s*(?:\?\.)?\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[)/g)) {
      const property = match[1]
      // A bracket access has no captured name and is equally unsupported.
      if (property === undefined || !permitted.has(property)) {
        offenders.push(`${path.relative(REPO_ROOT, file)}: localStorage${property ? '.' + property : '[...]'}`)
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'public/durable-storage.js provides the Storage METHODS only. A module reading a setting as a '
    + 'property would silently get undefined against the durable store while still working in a '
    + 'plain browser, which is the hardest possible version of this bug to see. Use getItem.',
  )
})

/* ---------------------------------------------------------------------------
 * CARRYING THE NEWS THAT THE SETTINGS FILE COULD NOT BE READ.
 *
 * The store beneath this preserves an unreadable settings file rather than
 * replacing it. That closes the data loss and, on its own, changes nothing a
 * person experiences: the app still opens wearing none of their choices, with
 * no error at all. So the three facts travel through here to the notice module
 * -- WHY the defaults are showing, THAT nothing was deleted, and WHERE the file
 * went -- and the last of those arrives LATE, on the result of the write that
 * moves the file, because the file is deliberately not moved until then.
 *
 * The paths are built with path.win32 rather than written as literals. They are
 * Windows paths, a Windows path is mostly backslashes, and a backslash in a
 * hand-written string literal is an escape waiting to eat a character.
 * ------------------------------------------------------------------------- */

const USER_DATA = 'C:/Users/someone/AppData/Roaming/ToolsEnabled'
const RECORD_PATH = path.win32.join(USER_DATA, 'renderer-prefs.json')
const MOVED_PATH = path.win32.join(USER_DATA, 'renderer-prefs.damaged-2026-03-04T05-06-07-008Z.json')

/* A bridge in the state the shell reports when the settings file did not load.
   Everything the notice needs is on it, and preservedAt starts null because
   nothing has moved the file yet. */
function damagedBridge({ write, damaged = 'the settings file contains malformed JSON', file = RECORD_PATH } = {}) {
  return {
    available: true,
    values: {},
    drainRequired: false,
    damaged,
    file,
    preservedAt: null,
    write: write || (() => ({ ok: true })),
    remove: () => ({ ok: true }),
    clear: () => ({ ok: true }),
    drain: () => ({ ok: true, values: {} }),
  }
}

test('the reason the settings did not load is readable by the page', () => {
  const { window } = install({ bridge: damagedBridge() })

  /* Field by field rather than deepEqual: the shipped file is evaluated in its
     own vm realm, so the object it hands back carries THAT realm's
     Object.prototype and a structural comparison fails on the prototype alone.
     The failure looks like a value mismatch and is not one. */
  const notice = window.mcPrefsNotice.read()
  assert.equal(notice.damaged, 'the settings file contains malformed JSON')
  assert.equal(notice.file, RECORD_PATH)
  assert.equal(notice.preservedAt, null)
})

test('the page learns where the unreadable file went from the write that moved it', () => {
  const { window } = install({ bridge: damagedBridge({ write: () => ({ ok: true, preservedAt: MOVED_PATH }) }) })
  const seen = []
  window.mcPrefsNotice.subscribe((state) => seen.push(state.preservedAt))

  // At boot the file is still in place and the notice says so. It is only moved
  // when something writes, which is what the line below is.
  assert.equal(window.mcPrefsNotice.read().preservedAt, null)
  window.localStorage.setItem('mc.theme', 'white')

  assert.equal(window.mcPrefsNotice.read().preservedAt, MOVED_PATH)
  assert.deepEqual(seen, [MOVED_PATH], 'the surface showing the notice is told once, when the fact changes')
})

test('the news is announced once, not on every subsequent write', () => {
  const { window } = install({ bridge: damagedBridge({ write: () => ({ ok: true, preservedAt: MOVED_PATH }) }) })
  const seen = []
  window.mcPrefsNotice.subscribe((state) => seen.push(state.preservedAt))

  window.localStorage.setItem('mc.theme', 'white')
  window.localStorage.setItem('mc.text', '1.12')
  window.localStorage.setItem('mc.live.fleet', 'live')

  // A banner that redraws on every settings click is a banner that steals
  // focus and flickers at somebody who has already read it.
  assert.deepEqual(seen, [MOVED_PATH])
})

test('a drain that sets the record aside reports it, because it is usually the first write', () => {
  const { window } = install({
    drainRequired: true,
    legacy: { 'mc.theme': 'black' },
    drainResult: { ok: true, values: { 'mc.theme': 'black' }, preservedAt: MOVED_PATH },
  })

  assert.equal(window.mcPrefsNotice.read().preservedAt, MOVED_PATH)
})

test('a refused write still delivers the explanation it was refused with', () => {
  const { window } = install({
    bridge: damagedBridge({
      /* The store refuses rather than destroying a record it could not move
         aside. That is the case a person most needs explained, so the notice
         must not be collected only on the happy path. */
      write: () => ({ ok: false, error: { code: 'MC_PREFS_DAMAGED', message: 'Refusing to overwrite settings that could not be read' } }),
    }),
  })

  assert.throws(() => window.localStorage.setItem('mc.theme', 'white'), /Refusing to overwrite/)
  assert.equal(window.mcPrefsNotice.read().damaged, 'the settings file contains malformed JSON')
})

test('a listener that throws does not take the save down with it', () => {
  const { window } = install({
    bridge: damagedBridge({
      damaged: 'the settings file could not be read (EBUSY)',
      write: () => ({ ok: true, preservedAt: MOVED_PATH }),
    }),
  })
  window.mcPrefsNotice.subscribe(() => { throw new Error('the notice surface is broken') })

  // A broken explanation is not worth failing a save over: that would cost the
  // person the setting as well as the message.
  window.localStorage.setItem('mc.theme', 'white')

  assert.equal(window.localStorage.getItem('mc.theme'), 'white')
})

test('unsubscribing stops the updates', () => {
  const { window } = install({ bridge: damagedBridge({ write: () => ({ ok: true, preservedAt: MOVED_PATH }) }) })
  const seen = []
  const stop = window.mcPrefsNotice.subscribe((state) => seen.push(state))
  stop()

  window.localStorage.setItem('mc.theme', 'white')

  assert.deepEqual(seen, [])
})

test('a plain browser has no notice global, because there is no settings file to report on', () => {
  const { window } = install({ available: false })

  assert.equal(window.mcPrefsNotice, undefined)
})
