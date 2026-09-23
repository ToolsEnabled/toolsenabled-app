import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import startupFatal from '../../shell/startup-fatal.cjs'

const {
  STARTUP_ERROR_LOG,
  createFatalStartupHandler,
  fullErrorText,
} = startupFatal

test('fullErrorText retains an Error stack and safely formats non-Errors', () => {
  const error = Object.assign(
    new Error('startup exploded', { cause: new Error('socket refused') }),
    { code: 'MC_STARTUP_EXPLODED' },
  )
  assert.match(fullErrorText(error), /Error: startup exploded/)
  assert.match(fullErrorText(error), /startup-fatal\.test\.mjs/)
  assert.match(fullErrorText(error), /MC_STARTUP_EXPLODED/)
  assert.match(fullErrorText(error), /socket refused/)
  assert.equal(fullErrorText('plain rejection'), 'plain rejection')

  const longDiagnostic = `request failed after ${'x'.repeat(32_768)}`
  assert.match(fullErrorText({ diagnostic: longDiagnostic }), /x{32768}/)
})

test('fatal startup is visible, durable, logged in full, and exits non-zero', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-fatal-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  let stderr = ''
  let dialogCall
  let exitCode = null
  let processExitCode = null
  const fatal = createFatalStartupHandler({
    app: {
      getPath: () => directory,
      exit: (code) => { exitCode = code },
    },
    dialog: {
      showErrorBox: (title, detail) => { dialogCall = { title, detail } },
    },
    detailForError: (error) => `Actionable detail: ${error.message}`,
    stderr: { write: (text) => { stderr += text } },
    now: () => new Date('2026-08-09T12:34:56.000Z'),
    setExitCode: (code) => { processExitCode = code },
    hardExit: () => assert.fail('app.exit must be used when it succeeds'),
  })

  const error = new Error('deliberate createWindow failure')
  fatal(error, 'Application startup rejected')

  assert.equal(processExitCode, 1)
  assert.equal(exitCode, 1)
  assert.match(stderr, /Error: deliberate createWindow failure/)
  assert.match(stderr, /startup-fatal\.test\.mjs/)
  assert.deepEqual(dialogCall && Object.keys(dialogCall), ['title', 'detail'])
  assert.equal(dialogCall.title, 'ToolsEnabled could not start')
  assert.match(dialogCall.detail, /Actionable detail: deliberate createWindow failure/)
  assert.match(dialogCall.detail, new RegExp(STARTUP_ERROR_LOG.replace('.', '\\.')))

  const durable = fs.readFileSync(path.join(directory, STARTUP_ERROR_LOG), 'utf8')
  assert.match(durable, /2026-08-09T12:34:56\.000Z/)
  assert.match(durable, /Error: deliberate createWindow failure/)
})

test('reporting failures cannot turn a fatal error into exit zero', () => {
  let stderr = ''
  let exitCode = null
  let processExitCode = null
  const fatal = createFatalStartupHandler({
    app: {
      getPath: () => { throw new Error('userData unavailable') },
      exit: (code) => { exitCode = code },
    },
    dialog: {
      showErrorBox: () => { throw new Error('dialog unavailable') },
    },
    stderr: { write: (text) => { stderr += text } },
    setExitCode: (code) => { processExitCode = code },
    hardExit: () => assert.fail('app.exit must be used when it succeeds'),
  })

  fatal(new Error('primary failure'))

  assert.equal(processExitCode, 1)
  assert.equal(exitCode, 1)
  assert.match(stderr, /primary failure/)
  assert.match(stderr, /userData unavailable/)
  assert.match(stderr, /dialog unavailable/)
})

test('a failed log write is reported and is not advertised as durable', () => {
  let dialogDetail = ''
  let exitCode = null
  const fatal = createFatalStartupHandler({
    app: {
      getPath: () => 'unused-test-user-data',
      exit: (code) => { exitCode = code },
    },
    dialog: {
      showErrorBox: (_title, detail) => { dialogDetail = detail },
    },
    stderr: { write: () => {} },
    mkdirSync: () => {},
    writeFileSync: () => { throw new Error('disk full') },
    setExitCode: () => {},
    hardExit: () => assert.fail('app.exit must be used when it succeeds'),
  })

  fatal(new Error('primary failure'))

  assert.equal(exitCode, 1)
  assert.match(dialogDetail, /Copy this error/)
  assert.doesNotMatch(dialogDetail, /startup-error\.log/)
})
