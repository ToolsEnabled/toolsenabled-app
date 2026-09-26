import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const commandUrl = new URL('../session-end-record-drive.mjs', import.meta.url)
const command = readFileSync(commandUrl, 'utf8')

function functionSource(name, nextMarker) {
  let start = command.indexOf(`function ${name}`)
  if (command.slice(start - 6, start) === 'async ') start -= 6
  const end = command.indexOf(nextMarker, start)
  assert.notEqual(start, -1, `${name} remains in the command`)
  assert.notEqual(end, -1, `${name} has a readable boundary`)
  return command.slice(start, end)
}

const readOrThrowSource = functionSource('readOrThrow', '\n\nconst freshProfile')
const sessionIdSource = functionSource('sessionIdOfNode', '\n\n/* --------------------------------------------------------------- ledger')
const { readOrThrow, sessionIdOfNode } = Function(`${readOrThrowSource}\n${sessionIdSource}\nreturn { readOrThrow, sessionIdOfNode }`)()
const ledgerLinesSource = functionSource('ledgerLines', '\n\n/* The run for one session')

function browserWindow(getItem) {
  let reads = 0
  return {
    reads: () => reads,
    evaluate(expression) {
      return Function('localStorage', `return ${expression}`)({
        getItem(key) {
          reads += 1
          return getItem(key)
        },
      })
    },
  }
}

test('session-id reads distinguish absence from could-not-tell and never latch either answer', async () => {
  for (const thrown of [Object.assign(new Error('busy'), { code: 'EMFILE' }), 'not an Error']) {
    const window = browserWindow(() => { throw thrown })
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await assert.rejects(
        sessionIdOfNode(window, 'computer-1', 'node-1'),
        error => error.code === 'SESSION_ID_READ_INDETERMINATE'
          && error.message.includes(thrown.code || 'UNCLASSIFIED_THROW')
          && error.message.includes('NOT claiming the session id is absent'),
      )
      assert.equal(window.reads(), attempt, 'an indeterminate read is retried rather than cached')
    }
  }

  // Control: a successful read that genuinely finds no saved tree still has
  // the old absent answer, and the command has never cached that answer.
  const absent = browserWindow(() => null)
  assert.equal(await sessionIdOfNode(absent, 'computer-1', 'node-1'), null)
  assert.equal(await sessionIdOfNode(absent, 'computer-1', 'node-1'), null)
  assert.equal(absent.reads(), 2, 'legitimate absence remains uncached too')

  for (const sourceCode of ['EAGAIN', 'EIO', 'EBUSY', 'UNCLASSIFIED_THROW']) {
    assert.throws(
      () => readOrThrow({ __couldNotCheckAvailability: true, sourceCode }, 'the agent availability probe'),
      error => error.code === 'ENGINE_AVAILABILITY_INDETERMINATE'
        && error.message.includes(sourceCode)
        && error.message.includes('NOT claiming the engine is unavailable'),
    )
  }

  let diskReads = 0
  let diskFailure = Object.assign(new Error('busy'), { code: 'EMFILE' })
  const ledgerLines = Function('path', 'userDataFor', 'LEDGER_FILE', 'readFileSync', `${ledgerLinesSource}; return ledgerLines`)(
    { join: (...parts) => parts.join('/') },
    profile => profile,
    'agent-spawn-records.jsonl',
    () => { diskReads += 1; throw diskFailure },
  )
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    assert.throws(
      () => ledgerLines('profile'),
      error => error.code === 'SESSION_LEDGER_READ_INDETERMINATE'
        && error.message.includes('EMFILE')
        && error.message.includes('NOT claiming the ledger is absent or empty'),
    )
    assert.equal(diskReads, attempt, 'an indeterminate ledger read is never cached')
  }
  diskFailure = Object.assign(new Error('missing'), { code: 'ENOENT' })
  assert.deepEqual(ledgerLines('profile'), [], 'ENOENT alone retains the legitimate absent answer')
  assert.deepEqual(ledgerLines('profile'), [], 'the legitimate absent answer is not cached')
  assert.equal(diskReads, 4)
})
