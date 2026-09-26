import assert from 'node:assert/strict'
import net from 'node:net'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { inspect } from 'node:util'

/* WHAT THIS PINS.
 *
 * When every shell port is held, the one sentence that says what happened and
 * what to do about it was composed only for dialog.showErrorBox(). stderr and
 * the startup-error.log a person is asked to keep carried util.inspect() of the
 * scan error instead -- nine EADDRINUSE records and a raw cause, with no remedy
 * anywhere in it. A launch from a terminal, over SSH, or on a machine whose
 * dialog cannot draw therefore ended in a cascade with nothing to act on.
 *
 * The suite reads main.cjs rather than importing it: the shell touches Electron
 * and the profile long before it reaches this helper. The helper's own source
 * is executed, so the assertions stay causal -- a main.cjs that stopped
 * composing the refusal, or stopped routing the scan's rejection through it,
 * fails here.
 *
 * The exhaustion error is produced by the REAL port scan against a port this
 * process holds, not by a hand-built fixture, so the shape under test cannot
 * drift away from the shape port-scan.cjs actually throws. */

const MAIN_FILE = fileURLToPath(new URL('../../shell/main.cjs', import.meta.url))
const requireFromMain = createRequire(MAIN_FILE)
const { startupFailureDetail } = requireFromMain('./startup-failure-message.cjs')
const { SHELL_HOST, SHELL_PORT_MIN, SHELL_PORT_MAX, listenOnFirstFreePort } = requireFromMain('./port-scan.cjs')

const RANGE = { min: SHELL_PORT_MIN, max: SHELL_PORT_MAX }

/* One extractor, asked two questions. A declaration is brace-matched; the scan
 * call is paren-matched, because its settle handlers ARE braces and a brace
 * match would stop inside the first one without ever reaching the rejection
 * arm. Both skip string literals, so quoted punctuation cannot end a slice
 * early and leave an assertion passing against half an expression. */
function balanced(source, anchor, open, close) {
  const start = source.indexOf(anchor)
  assert.notEqual(start, -1, `main.cjs no longer contains ${anchor}`)
  let depth = 0
  let quote = null
  let escaped = false
  for (let index = source.indexOf(open, start + anchor.length); index < source.length; index++) {
    const character = source[index]
    if (quote) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === quote) quote = null
      continue
    }
    if (character === "'" || character === '"' || character === '`') { quote = character; continue }
    if (character === open) depth++
    else if (character === close && --depth === 0) return source.slice(start, index + 1)
  }
  assert.fail(`unterminated ${anchor} in main.cjs`)
}

const braces = (source, anchor) => balanced(source, anchor, '{', '}')
const parens = (source, anchor) => balanced(source, anchor, '(', ')')

function actualRefusal() {
  const body = braces(readFileSync(MAIN_FILE, 'utf8'), 'function statedShellPortRefusal(')
  return new Function(
    'startupFailureDetail', 'SHELL_PORT_MIN', 'SHELL_PORT_MAX',
    `${body}; return statedShellPortRefusal;`,
  )(startupFailureDetail, SHELL_PORT_MIN, SHELL_PORT_MAX)
}

/* A real SHELL_PORT_RANGE_EXHAUSTED, from the real scan. The held port is an
 * ephemeral one the operating system hands out, never 4601-4609: a suite that
 * competed for the product's own range would fail whenever a shell was open. */
async function exhaustedScan() {
  const held = net.createServer(() => {})
  await new Promise((resolve, reject) => {
    held.once('error', reject)
    held.listen({ host: SHELL_HOST, port: 0, exclusive: true }, resolve)
  })
  const taken = held.address().port
  try {
    await listenOnFirstFreePort(net.createServer(() => {}), [taken], SHELL_HOST)
    assert.fail(`the scan bound ${taken}, which this suite is holding`)
  } catch (error) {
    assert.equal(error.code, 'SHELL_PORT_RANGE_EXHAUSTED')
    return error
  } finally {
    await new Promise((resolve) => held.close(resolve))
  }
}

test('the exhausted-range refusal is the error message, so stderr and the startup log carry it', async () => {
  const stated = actualRefusal()(await exhaustedScan())

  /* These inspect options are startup-fatal.cjs's own, so this string is what
     that handler writes to stderr and to startup-error.log -- the text a person
     is actually left holding when the dialog is not there to be read. */
  const report = inspect(stated, { breakLength: 120, customInspect: false, depth: 6, getters: false })
  /* The range is read from port-scan.cjs rather than written out here: what
     this suite is about is the remedy reaching the log, and the declared range
     itself is already pinned by the shell-port-scan contract suites. */
  assert.match(report, new RegExp(`All shell ports ${SHELL_PORT_MIN}-${SHELL_PORT_MAX} are in use`))
  assert.match(report, /Close them and relaunch\./)
})

test('the dialog text is unchanged, because the scan facts and its cause ride across', async () => {
  const scan = await exhaustedScan()
  const stated = actualRefusal()(scan)

  assert.equal(startupFailureDetail(stated, RANGE), startupFailureDetail(scan, RANGE))
  assert.equal(stated.code, scan.code)
  assert.equal(stated.host, scan.host)
  assert.deepEqual(stated.ports, scan.ports)
  assert.deepEqual(stated.failures, scan.failures)
  assert.equal(stated.cause, scan.cause)
})

test('a failure that is not an exhausted scan is passed through untouched', () => {
  const refuse = actualRefusal()
  const refused = Object.assign(new Error('listen EACCES 127.0.0.1:4601'), { code: 'EACCES' })

  assert.equal(refuse(refused), refused)
  assert.equal(refuse(undefined), undefined)
})

test('the shell port scan rejects through the refusal rather than raw', () => {
  const scan = parens(readFileSync(MAIN_FILE, 'utf8'), 'listenOnFirstFreePort(server, ports, SHELL_HOST).then')

  assert.match(scan, /statedShellPortRefusal/)
})
