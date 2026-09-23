'use strict'

/* T180: pid 44348 wrote its last main-lag.log entry at 19:28:38.757Z and never
 * wrote another. No surviving record said WHY the process went away -- not
 * which quit path ran, not what asked for it, not what was still open. This
 * writes that sentence down, from every place in this file that can end the
 * process, before the process has finished ending.
 *
 * SYNCHRONOUS AND BEST-EFFORT, for the same reason main-lag.cjs's append() is:
 * a diagnostic that can throw or that waits on an async write is a worse
 * defect than the one it exists to catch, and the whole point is to survive
 * exactly the teardown that would otherwise discard it. */

const fsDefault = require('node:fs')
const pathDefault = require('node:path')

const MAX_LABEL_LENGTH = 120

function safeLabel(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const printable = Array.from(trimmed, character => (character.codePointAt(0) < 0x20 || character.codePointAt(0) === 0x7f ? ' ' : character)).join('')
  return printable.slice(0, MAX_LABEL_LENGTH)
}

function safeCount(fn) {
  if (typeof fn !== 'function') return null
  try {
    const value = fn()
    return Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

function createExitRecordWriter({
  file,
  appendSink = null,
  fs = fsDefault,
  path = pathDefault,
  now = () => Date.now(),
  pid = process.pid,
  getOpenWindowCount = null,
  getInFlightContinuationCount = null,
} = {}) {
  if (typeof file !== 'string' || !file) throw new TypeError('createExitRecordWriter requires a file path')

  /* trigger: which hook fired (will-quit, before-quit, window-all-closed, or
     the name of the app.quit()/app.exit() call site itself).
     initiator: why that hook or call site fired, in the caller's own words. */
  function writeExitRecord(trigger, initiator) {
    const line = `${JSON.stringify({
      at: new Date(now()).toISOString(),
      pid,
      trigger: safeLabel(trigger) || 'unknown',
      initiator: safeLabel(initiator),
      openWindows: safeCount(getOpenWindowCount),
      inFlightContinuations: safeCount(getInFlightContinuationCount),
    })}\n`
    try {
      if (appendSink) return appendSink(line)?.written === true
      try { fs.mkdirSync(path.dirname(file), { recursive: true }) } catch { /* already there */ }
      fs.appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 })
      return true
    } catch {
      /* A quit that cannot write its own record must not be blocked by the write. */
      return false
    }
  }

  return Object.freeze({ file, writeExitRecord })
}

module.exports = Object.freeze({ createExitRecordWriter })
