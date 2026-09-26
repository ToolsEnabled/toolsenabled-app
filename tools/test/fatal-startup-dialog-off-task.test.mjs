import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/* WHY THIS IS A TEST ABOUT A TASK BOUNDARY AND NOT ABOUT A MESSAGE.
 *
 * shell/startup-fatal.cjs already has its own suite for what the fatal dialog
 * says, where it writes the log and what it exits with, and all of that stayed
 * the same. What this suite guards is the one thing that cannot be asserted
 * there: WHEN main.cjs is allowed to open it. `dialog.showErrorBox` blocks in a
 * nested message loop, and nesting that loop on top of the browser-thread task
 * that just failed leaves Chromium's pump polling X11 with a zero timeout for as
 * long as the dialog waits -- a whole core, measured 2026-09-24 at 501 CPU ticks
 * per 5 seconds on a launch that could not take a shell port, against 0 once the
 * dialog is opened from the next turn of the loop.
 *
 * main.cjs cannot be imported here (it destructures the real electron module at
 * module scope, and getPath('userData') throws outside a browser process), so
 * its own suites read it as text. This one goes one step further and RUNS the
 * declaration it is about, against stubs, so the assertions are about behaviour
 * rather than about the spelling of a line. */
const main = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')

const DECLARATION = 'const fatalStartup = (error, origin) => {'

function fatalStartupDeclaration() {
  const opening = main.indexOf(DECLARATION)
  assert.notEqual(opening, -1,
    'shell/main.cjs no longer declares a fatalStartup that can defer the blocking dialog')
  const closing = main.indexOf('\n}\n', opening)
  assert.notEqual(closing, -1, 'the fatalStartup declaration is not closed where this suite can read it')
  return main.slice(opening, closing + 2)
}

function buildFatalStartup({ reportFatalStartup, setImmediate: defer, process: fakeProcess }) {
  const build = new Function(
    'reportFatalStartup', 'setImmediate', 'process',
    `${fatalStartupDeclaration()}\nreturn fatalStartup`,
  )
  return build(reportFatalStartup, defer, fakeProcess)
}

test('a failed startup opens its dialog from the next turn of the loop, not from the task that failed', () => {
  const opened = []
  const deferred = []
  const processStub = { exitCode: 0 }
  const fatalStartup = buildFatalStartup({
    reportFatalStartup: (...args) => opened.push(args),
    setImmediate: (callback) => { deferred.push(callback); return { unref: () => {} } },
    process: processStub,
  })

  const error = Object.assign(
    new Error('No shell port is available on 127.0.0.1; attempted 4601-4609'),
    { code: 'SHELL_PORT_RANGE_EXHAUSTED' },
  )
  fatalStartup(error, 'Application startup rejected')

  assert.deepEqual(opened, [],
    'the blocking dialog was opened inside the failing task, which spins the message pump')
  assert.equal(deferred.length, 1, 'the fatal report was not handed to the next turn of the loop')

  deferred[0]()
  assert.deepEqual(opened, [[error, 'Application startup rejected']],
    'the deferred report must reach the handler with the same error and origin')
})

test('a failed startup is exit code 1 before the loop is yielded', () => {
  const processStub = { exitCode: 0 }
  const fatalStartup = buildFatalStartup({
    reportFatalStartup: () => assert.fail('the dialog must not open synchronously'),
    setImmediate: () => ({ unref: () => {} }),
    process: processStub,
  })

  fatalStartup(new Error('deliberate createWindow failure'), 'Application startup rejected')

  /* The turn of the loop this now yields is a turn in which something else could
     quit the app. A launch that failed and exited 0 tells its caller -- an
     installer check, a smoke harness, a person's shell -- the opposite of what
     happened. */
  assert.equal(processStub.exitCode, 1)
})

test('an origin the caller left out still reaches the handler as given', () => {
  const opened = []
  const deferred = []
  const fatalStartup = buildFatalStartup({
    reportFatalStartup: (...args) => opened.push(args),
    setImmediate: (callback) => { deferred.push(callback); return { unref: () => {} } },
    process: { exitCode: 0 },
  })

  const error = new Error('uncaught during launch')
  fatalStartup(error)
  deferred[0]()

  // startup-fatal.cjs supplies its own default; the wrapper must not invent one.
  assert.deepEqual(opened, [[error, undefined]])
})

test('no fatal startup call site reaches the constructed handler directly', () => {
  /* The handler createFatalStartupHandler returns is the thing that blocks. It
     is named exactly twice: once where it is built, once inside the deferring
     wrapper above. A third mention would be a call site that spins again. */
  assert.match(main, /const reportFatalStartup = createFatalStartupHandler\(\{/)
  assert.equal([...main.matchAll(/\breportFatalStartup\b/g)].length, 2,
    'a caller reaches the blocking fatal handler without going through fatalStartup')

  assert.equal([...main.matchAll(/\breportFatalStartup\(/g)].length, 1,
    'the blocking handler is called from somewhere other than the deferring wrapper')

  const callSites = [...main.matchAll(/(?<![\w.])fatalStartup\(/g)]
  assert.ok(callSites.length >= 4,
    `expected the known fatal startup call sites (onStartFailure, the shell server, and the two process-wide handlers), saw ${callSites.length}`)
})
