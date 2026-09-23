'use strict'

const path = require('node:path')
const { spawn } = require('node:child_process')

const OPEN_TIMEOUT_MS = 15000
const launchErrors = Object.freeze({
  1: 'The system file opener rejected the request.',
  2: 'The file no longer exists.',
  3: 'A program needed to open this file is not installed.',
  4: 'The system file opener could not open this file.',
})

/* Electron 43.3.0's Linux OpenPath starts xdg-open without waiting, then drops
   its callback. The viewer opens, but the IPC awaiting openPath never replies.
   Use the same system launcher here and observe its exit ourselves. This is
   called only after agent-files has checked the workspace and file kind.
   A slow launcher may already have opened a viewer: report uncertainty without
   killing that program, retrying the request, or claiming that it failed. */
function createDesktopFileOpener({ electronOpenPath, platform = process.platform,
  spawnProcess = spawn, timeoutMs = OPEN_TIMEOUT_MS } = {}) {
  if (typeof electronOpenPath !== 'function' || typeof spawnProcess !== 'function'
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('Invalid file opener')
  if (platform !== 'linux') return target => electronOpenPath(target)

  return target => new Promise((resolve, reject) => {
    if (typeof target !== 'string' || !path.isAbsolute(target)) {
      reject(new Error('An absolute file path is required.'))
      return
    }
    let child
    try {
      child = spawnProcess('xdg-open', [target], {
        cwd: path.dirname(target), shell: false, stdio: 'ignore', windowsHide: true,
      })
    } catch {
      reject(new Error('The system file opener could not be started.'))
      return
    }
    let settled = false
    let timer
    const finish = (message, error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(message)
    }
    child.once('error', () => finish(null, new Error('The system file opener could not be started.')))
    child.once('exit', (code, signal) => {
      if (signal) finish(null, new Error('The system file opener stopped before confirming the request.'))
      else finish(code === 0 ? '' : launchErrors[code] || 'The system file opener could not open this file.')
    })
    timer = setTimeout(() => finish(null, new Error(
      'The system file opener has not confirmed the request. Check whether the file opened before trying again.',
    )), timeoutMs)
    child.unref()
  })
}

module.exports = { createDesktopFileOpener, OPEN_TIMEOUT_MS }
