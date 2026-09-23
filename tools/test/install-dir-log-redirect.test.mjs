// AN INSTALLED APPLICATION MUST NEVER WRITE INTO ITS OWN INSTALL DIRECTORY.
//
// MEASURED, and it stopped a release: launching the packaged build left
// `release\win-unpacked\debug.log`, 157 bytes, holding one Chromium line --
//
//   [0907/071328.555:ERROR:...\crashpad\util\win\registration_protocol_win.cc:108]
//   CreateFile: The system cannot find the file specified. (0x2)
//
// -- and `seal-artifact --verify` then refused, correctly: "THE BUILD CHAIN
// MODIFIED THE ARTIFACT IT HAD ALREADY CERTIFIED. ADDED (1): debug.log".
// An artefact that changes after it is certified cannot be shipped, and the
// same step re-runs on every cut, so this blocks the chain until it is fixed.
//
// WHAT IS ACTUALLY WRONG is not the crashpad message -- that is one symptom.
// It is that Chromium's log file defaults to the directory the executable lives
// in, which for an installed application is the install directory. ANY line
// Chromium ever logs lands there. So this fixes the destination, not the
// message: nothing Chromium logs may be written inside the install tree.
//
// Measured on the shipped runtime (Electron 43.3.0 / Node 24.18.1) before this
// was written: passing `--log-file=<path>` creates the log at exactly that path
// and nothing appears beside the executable. That is the lever these cases pin.
//
// Asserted by CALLING WITH VALUES -- install directories, userData directories,
// and the awkward pairing where they are nested -- never by reading source.
//
//   node --test tools/test/install-dir-log-redirect.test.mjs

import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const { chromiumLogTarget, applyChromiumLogRedirect } =
  require_(path.join(ROOT, 'shell/install-dir-log-redirect.cjs'))

/* Windows path comparison is case-insensitive, and this question is only ever
   asked about real directories on this machine. */
function isInside(child, parent) {
  const relative = path.relative(parent, child)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/* Enough of Electron's `app` to observe what was asked of Chromium, and to be
   able to say WHEN it was asked. */
function fakeApp({ ready = false } = {}) {
  const switches = []
  return {
    switches,
    isReady: () => ready,
    commandLine: { appendSwitch: (name, value) => switches.push({ name, value }) },
  }
}

const INSTALL_DIR = path.join('C:', 'Program Files', 'ToolsEnabled')
const EXEC_PATH = path.join(INSTALL_DIR, 'ToolsEnabled.exe')
const USER_DATA = path.join('C:', 'Users', 'someone', 'AppData', 'Roaming', 'ToolsEnabled')

test('the Chromium log never lands inside the install directory', () => {
  const target = chromiumLogTarget({ execPath: EXEC_PATH, userDataPath: USER_DATA })
  assert.equal(isInside(target, INSTALL_DIR), false,
    `the log target is inside the install directory: ${target}`)
  assert.equal(isInside(target, USER_DATA), true,
    `the log should go with the person's other data, saw ${target}`)
})

test('a portable install whose data folder sits INSIDE the install tree still writes outside it', () => {
  /* The awkward pairing, and the one a naive "just use userData" would get
     wrong: a portable or dev layout can put userData under the install
     directory, and then the redirect would still be writing into the artefact
     it exists to protect. */
  const nestedUserData = path.join(INSTALL_DIR, 'data')
  const target = chromiumLogTarget({ execPath: EXEC_PATH, userDataPath: nestedUserData })
  assert.equal(isInside(target, INSTALL_DIR), false,
    `a userData path inside the install tree was used anyway: ${target}`)
})

test('with no usable userData path it still refuses the install directory, rather than falling back to it', () => {
  /* FAIL CLOSED. The failure that matters is writing into the artefact, so
     every degraded path must land somewhere else -- never "we could not work
     out where to put it, so leave it beside the executable". */
  for (const userDataPath of [null, undefined, '', '   ']) {
    const target = chromiumLogTarget({ execPath: EXEC_PATH, userDataPath })
    assert.equal(typeof target, 'string', 'a target must always be chosen')
    assert.ok(target.length > 0, 'a target must always be chosen')
    assert.equal(isInside(target, INSTALL_DIR), false,
      `userDataPath ${JSON.stringify(userDataPath)} fell back into the install directory: ${target}`)
  }
})

test('the redirect is handed to Chromium as its own log-file switch', () => {
  /* The switch NAME is Chromium's interface, not our spelling -- the same kind
     of contract as an HTTP header -- so it is named here on purpose. What is
     asserted is the behaviour: Chromium is told to log somewhere outside the
     install tree. */
  const app = fakeApp()
  const target = applyChromiumLogRedirect({ app, execPath: EXEC_PATH, userDataPath: USER_DATA })
  const logSwitch = app.switches.find(entry => entry.name === 'log-file')
  assert.ok(logSwitch, 'Chromium was never told where to put its log file')
  assert.equal(logSwitch.value, target, 'the switch and the reported target disagree')
  assert.equal(isInside(logSwitch.value, INSTALL_DIR), false,
    `Chromium was pointed inside the install directory: ${logSwitch.value}`)
})

test('a redirect asked for too late is refused rather than reported as done', () => {
  /* Chromium reads this when it initialises logging, which happens before the
     app is ready. Appending the switch afterwards changes nothing, and
     returning a path anyway would be a fix that only looks applied. */
  const app = fakeApp({ ready: true })
  assert.throws(() => applyChromiumLogRedirect({ app, execPath: EXEC_PATH, userDataPath: USER_DATA }),
    /ready|late/i,
    'a redirect applied after Chromium initialised logging must not report success')
})

test('the real install directory of this checkout is never chosen', () => {
  /* Called with this machine's own values rather than fixtures, so the case
     still means something if the fixtures above drift from reality. */
  const target = chromiumLogTarget({ execPath: process.execPath, userDataPath: os.tmpdir() })
  assert.equal(isInside(target, path.dirname(process.execPath)), false,
    `the log target sits beside the running executable: ${target}`)
})
