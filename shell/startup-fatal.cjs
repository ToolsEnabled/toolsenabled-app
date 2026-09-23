'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { inspect } = require('node:util')

const STARTUP_ERROR_LOG = 'startup-error.log'

function safeString(value) {
  try {
    return String(value)
  } catch {
    return 'Unknown fatal error'
  }
}

function safeProperty(value, key) {
  try {
    return value && (typeof value === 'object' || typeof value === 'function')
      ? value[key]
      : undefined
  } catch {
    return undefined
  }
}

function fullErrorText(error) {
  if (error && (typeof error === 'object' || typeof error === 'function')) {
    try {
      return inspect(error, {
        breakLength: 120,
        customInspect: false,
        depth: 6,
        getters: false,
        maxArrayLength: 100,
        maxStringLength: Infinity,
      })
    } catch {}
  }
  const stack = safeProperty(error, 'stack')
  return typeof stack === 'string' && stack.length > 0 ? stack : safeString(error)
}

function createFatalStartupHandler({
  app,
  dialog,
  detailForError = safeString,
  stderr = process.stderr,
  now = () => new Date(),
  mkdirSync = fs.mkdirSync,
  writeFileSync = fs.writeFileSync,
  userDataPath = () => app.getPath('userData'),
  setExitCode = (code) => { process.exitCode = code },
  hardExit = (code) => process.exit(code),
} = {}) {
  let handling = false

  const writeStderr = (text) => {
    try { stderr.write(text) } catch { /* the dialog and exit code remain authoritative */ }
  }

  return function fatalStartup(error, origin = 'Application startup failure') {
    try { setExitCode(1) } catch { /* app.exit(1) remains authoritative */ }

    if (handling) {
      try { app.exit(1) } catch { hardExit(1) }
      return
    }
    handling = true

    const stack = fullErrorText(error)
    let detail
    try { detail = safeString(detailForError(error)) } catch { detail = safeString(error) }

    let timestamp = 'unknown time'
    try { timestamp = now().toISOString() } catch {}
    const report = `[${timestamp}] ${safeString(origin)}\n${stack}\n`
    writeStderr(report)

    let logPath = ''
    try {
      const directory = userDataPath()
      mkdirSync(directory, { recursive: true })
      const candidate = path.join(directory, STARTUP_ERROR_LOG)
      writeFileSync(candidate, report, 'utf8')
      logPath = candidate
    } catch (logError) {
      writeStderr(`ToolsEnabled could not write its startup error log: ${fullErrorText(logError)}\n`)
    }

    const action = logPath
      ? `A diagnostic log was written to:\n${logPath}\n\nKeep that file if the problem repeats.`
      : 'Copy this error before closing the dialog so it can be diagnosed.'
    try {
      dialog.showErrorBox(
        'ToolsEnabled could not start',
        `${safeString(origin)}\n\n${detail}\n\n${action}`,
      )
    } catch (dialogError) {
      writeStderr(`ToolsEnabled could not show its fatal error dialog: ${fullErrorText(dialogError)}\n`)
    }

    try {
      app.exit(1)
    } catch (exitError) {
      writeStderr(`ToolsEnabled app.exit(1) failed: ${fullErrorText(exitError)}\n`)
      hardExit(1)
    }
  }
}

module.exports = {
  STARTUP_ERROR_LOG,
  createFatalStartupHandler,
  fullErrorText,
}
