'use strict'

/* AN INSTALLED APPLICATION MUST NEVER WRITE INTO ITS OWN INSTALL DIRECTORY.
 *
 * MEASURED, and it stopped a release cut: launching the packaged build left
 * `release\win-unpacked\debug.log` -- 157 bytes, one Chromium line --
 *
 *   [0907/071328.555:ERROR:...\crashpad\util\win\registration_protocol_win.cc:108]
 *   CreateFile: The system cannot find the file specified. (0x2)
 *
 * and `seal-artifact --verify` refused, in these words: "THE BUILD CHAIN
 * MODIFIED THE ARTIFACT IT HAD ALREADY CERTIFIED." / "ADDED (1): debug.log".
 * That refusal is right. An artefact that changes after it has been certified
 * is not the artefact that was certified, and the check re-runs on every cut,
 * so this blocks the chain until the writing stops.
 *
 * THE CRASHPAD MESSAGE IS A SYMPTOM, NOT THE DEFECT. Chromium's log file
 * defaults to the directory the executable lives in, and for an installed
 * application that is the install directory. Whatever Chromium logs -- that
 * crashpad line today, something else after the next upgrade -- lands inside
 * the artefact. Silencing one message would leave the next one to be found by
 * the same failed seal. So this moves the DESTINATION.
 *
 * WHY A SWITCH AND NOT A LOG API. Chromium reads `--log-file` when it
 * initialises logging, which happens before `app` is ready and before any
 * JavaScript log call could redirect anything. It has to be set on the command
 * line, early, which is why applying it late is refused outright below rather
 * than quietly doing nothing.
 *
 * MEASURED on the shipped runtime (Electron 43.3.0, Node 24.18.1): with
 * `--log-file=<path>` the log is created at exactly that path and nothing is
 * created beside the executable.
 *
 * NOT SILENCED. `--disable-logging` would also stop the file appearing and
 * would throw away the diagnostics with it. The log still exists; it lives with
 * the person's other data, where support can ask for it and where writing to it
 * cannot invalidate a signed artefact.
 */

const pathDefault = require('node:path')
const osDefault = require('node:os')

const LOG_FILE_NAME = 'chromium-debug.log'

/* Is `child` inside `parent`? Windows paths are compared case-insensitively by
   path.relative on Windows, which is the only platform this defends. A path
   equal to the parent is NOT inside it. */
function isInside(child, parent, path) {
  if (typeof child !== 'string' || typeof parent !== 'string' || !child || !parent) return false
  let relative
  try { relative = path.relative(parent, child) } catch { return false }
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function usableDirectory(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/**
 * Where Chromium's log file should go for this installation.
 *
 * Normally beside the person's other data. Two cases deliberately do not:
 * a userData folder that itself sits inside the install tree (a portable or
 * development layout), and no usable userData path at all. Both fall back to
 * the OS temporary directory, because the ONE outcome that must never happen is
 * writing inside the install tree -- so every degraded path leads away from it,
 * never back to it.
 */
function chromiumLogTarget({ execPath, userDataPath, path = pathDefault, os = osDefault } = {}) {
  const installDirectory = typeof execPath === 'string' && execPath ? path.dirname(execPath) : null
  const userData = usableDirectory(userDataPath)

  if (userData && !(installDirectory && isInside(userData, installDirectory, path))
    && !(installDirectory && path.resolve(userData) === path.resolve(installDirectory))) {
    return path.join(userData, LOG_FILE_NAME)
  }

  const fallback = path.join(os.tmpdir(), LOG_FILE_NAME)
  /* Even the fallback is checked: a temporary directory configured inside the
     install tree is unlikely, and "unlikely" is not the standard this file is
     held to. */
  if (installDirectory && isInside(fallback, installDirectory, path)) {
    return path.join(path.dirname(installDirectory), LOG_FILE_NAME)
  }
  return fallback
}

/**
 * Point Chromium's logging at that target. Must be called before the app is
 * ready; Chromium has already read the switch by then, so a late call would
 * change nothing while looking like it had worked.
 *
 * Returns the path it chose, so a caller can report it.
 */
function applyChromiumLogRedirect({ app, execPath, userDataPath, path = pathDefault, os = osDefault } = {}) {
  if (!app || !app.commandLine || typeof app.commandLine.appendSwitch !== 'function') {
    throw new TypeError('applyChromiumLogRedirect requires the Electron app')
  }
  if (typeof app.isReady === 'function' && app.isReady()) {
    throw new Error('The Chromium log redirect must be applied before the app is ready; it is too late once logging has initialised.')
  }
  const target = chromiumLogTarget({ execPath, userDataPath, path, os })
  app.commandLine.appendSwitch('log-file', target)
  return target
}

module.exports = {
  LOG_FILE_NAME,
  applyChromiumLogRedirect,
  chromiumLogTarget,
}
