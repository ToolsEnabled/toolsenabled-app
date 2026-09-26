'use strict'

const fs = require('node:fs')

/* Early account/profile refusals happen before the normal startup-fatal
 * handler exists. An unattended QA launch must never block inside a native
 * error box that its hidden window cannot expose: stderr is the harness's
 * observable surface, and the caller exits immediately after this returns.
 * Interactive launches retain the existing modal refusal. */
function reportStartupRefusal({
  code,
  message,
  environment = process.env,
  dialog,
  stderr = process.stderr,
  writeSync = fs.writeSync,
} = {}) {
  const line = `${String(code || 'STARTUP_REFUSED')}: ${String(message || 'ToolsEnabled could not start.')}`
  const writeStderr = () => {
    try {
      /* process.exit(1) follows immediately in main.cjs. A stream write to the
         harness's pipe may still be queued and can be truncated by that exit;
         fd 2 is synchronous, so the diagnostic is present before control
         returns to the caller. Injected streams without an fd retain the
         ordinary write seam used by tests. */
      if (Number.isInteger(stderr?.fd)) {
        const bytes = Buffer.from(`${line}\n`, 'utf8')
        let offset = 0
        while (offset < bytes.length) {
          const written = writeSync(stderr.fd, bytes, offset, bytes.length - offset)
          /* A zero/invalid answer made no progress. Stop rather than spinning
             forever inside the refusal path; the caller still exits non-zero. */
          if (!Number.isInteger(written) || written <= 0) break
          offset += Math.min(written, bytes.length - offset)
        }
      } else stderr.write(`${line}\n`)
    } catch { /* the caller's immediate exit is authoritative */ }
  }

  if (environment && environment.MC_SMOKE_HEADLESS === '1') {
    writeStderr()
    return Object.freeze({ headless: true, surface: 'stderr' })
  }

  try {
    dialog.showErrorBox('ToolsEnabled could not start', String(message || 'ToolsEnabled could not start.'))
    return Object.freeze({ headless: false, surface: 'dialog' })
  } catch {
    writeStderr()
    return Object.freeze({ headless: false, surface: 'stderr' })
  }
}

module.exports = Object.freeze({ reportStartupRefusal })
