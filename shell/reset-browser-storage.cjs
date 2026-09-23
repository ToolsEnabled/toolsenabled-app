'use strict'

const fsDefault = require('node:fs')
const pathDefault = require('node:path')
const { execFileSync } = require('node:child_process')
const { performance } = require('node:perf_hooks')
const { guardRoot: guardDirectory } = require('./local-data-reset.cjs')

const CLEAR_TIMEOUT_MS = 8000
const INSPECTION_TIMEOUT_MS = 8000
// A deadline is not cancellation of Chromium's operation. Retain its actual
// Session and promise until it settles; a late result cannot undo a refusal.
const pendingClears = new Set()
const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }

function windowsDirectoryAttributes(chain, { requireDirectory = true, timeoutMs = 5000 } = {}) {
  const script = `$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
$request=[Console]::In.ReadToEnd() | ConvertFrom-Json
foreach ($component in $request.paths) {
 $attributes=[IO.File]::GetAttributes($component)
 if (($attributes -band [IO.FileAttributes]::ReparsePoint) -or ($request.requireDirectory -and -not ($attributes -band [IO.FileAttributes]::Directory))) { throw 'Browser storage path is linked or invalid' }
}
'reset-browser-storage-path-ok'`
  const executable = pathDefault.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const result = execFileSync(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    input: JSON.stringify({ paths: chain, requireDirectory }),
    encoding: 'utf8', windowsHide: true, timeout: Math.min(5000, timeoutMs), maxBuffer: 4096, stdio: ['pipe', 'pipe', 'pipe'],
  })
  if (result.trim() !== 'reset-browser-storage-path-ok') fail('RESET_BROWSER_ROOT_UNCONFIRMED', 'Browser storage ownership could not be checked.')
}

// The caller captures this Session from an already trusted main-frame sender.
// No default Session, partition name, renderer-supplied path or fallback exists.
function captureResetBrowserStorage({ session, userData, plan, measurePlan, fs = fsDefault, path = pathDefault,
  platform = process.platform, checkWindowsAttributes = windowsDirectoryAttributes,
  guard = guardDirectory, timeoutMs = CLEAR_TIMEOUT_MS, now = () => performance.now() } = {}) {
  const normalized = value => {
    if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) return null
    if (platform === 'win32' && (!/^[a-z]:[\\/]/i.test(value) || value.slice(2).includes(':'))) return null
    // Resolving a lexical "link/../folder" first would discard a component
    // whose actual filesystem traversal could lead outside the guarded tree.
    if (value.split(platform === 'win32' ? /[\\/]/ : /\//).some(part => part === '.' || part === '..')) return null
    const resolved = path.resolve(value)
    return platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  const root = normalized(userData)
  if (!root || root === normalized(path.parse(userData).root)) fail('RESET_BROWSER_ROOT_UNCONFIRMED', 'The application data directory is not a guarded folder.')
  if (!session || normalized(session.storagePath) !== root || typeof session.clearStorageData !== 'function') {
    fail('RESET_BROWSER_SESSION_UNCONFIRMED', 'The requesting window does not own this application storage directory.')
  }
  const guarded = guard(userData)
  if (guarded?.ok !== true || normalized(guarded.resolved) !== root) fail('RESET_BROWSER_ROOT_UNCONFIRMED', 'The application storage directory could not be guarded.')
  const planIdentity = value => {
    if (value?.ok !== true || !Array.isArray(value.roots)) fail('RESET_BROWSER_PLAN_UNCONFIRMED', 'The local-data removal plan could not be confirmed.')
    const owned = value.roots.filter(entry => entry.kind === 'user-data' && normalized(entry.directory) === root)
    if (owned.length !== 1 || owned[0].guarded !== true || owned[0].present !== true) {
      fail('RESET_BROWSER_PLAN_UNCONFIRMED', 'The application storage directory was not guarded by the removal plan.')
    }
    return JSON.stringify(value.roots.map(entry => [entry.kind, normalized(entry.directory), entry.guarded === true]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
  }
  // A supplied record can be checked without IO. Main instead supplies the
  // real measurement callback: its recursive inventory must not run until the
  // actual Session directory has passed the root-first checks below.
  let plannedRoots = typeof measurePlan === 'function' ? null : planIdentity(plan)
  const resolvedRoot = path.resolve(userData)
  const chain = [path.parse(resolvedRoot).root]
  for (const part of path.relative(chain[0], resolvedRoot).split(path.sep).filter(Boolean)) chain.push(path.join(chain.at(-1), part))
  function inspectLocalStorage(checkBudget, windowsAttributes) {
    checkBudget()
    const localStorage = path.join(resolvedRoot, 'Local Storage')
    let initial
    try { initial = fs.lstatSync(localStorage, { bigint: true }) }
    catch (error) {
      if (error?.code === 'ENOENT') return // A missing browser store is empty.
      throw error
    }
    let entriesSeen = 0
    function walk(directory, stat, depth) {
      checkBudget()
      if (stat.isSymbolicLink() || !stat.isDirectory() || depth > 32) fail('RESET_BROWSER_ROOT_UNCONFIRMED', 'The browser storage directory contains an unsafe path.')
      if (platform === 'win32') windowsAttributes([directory])
      if (normalized(fs.realpathSync(directory)) !== normalized(directory)) fail('RESET_BROWSER_ROOT_UNCONFIRMED', 'The browser storage directory resolves through an alias.')
      const names = fs.readdirSync(directory)
      entriesSeen += names.length
      if (entriesSeen > 10000) fail('RESET_BROWSER_ROOT_UNCONFIRMED', 'The browser storage directory could not be checked within its entry limit.')
      const children = names.map(name => {
        if (name !== path.basename(name) || name === '.' || name === '..') fail('RESET_BROWSER_ROOT_UNCONFIRMED', 'The browser storage directory contains an invalid entry.')
        return path.join(directory, name)
      })
      // The parent is already checked. Reject every child reparse tag before
      // Node can descend; stdin keeps long/non-ASCII paths out of shell code.
      if (platform === 'win32' && children.length) windowsAttributes(children, { requireDirectory: false })
      for (const child of children) {
        checkBudget()
        const childStat = fs.lstatSync(child, { bigint: true })
        if (childStat.isSymbolicLink()) fail('RESET_BROWSER_ROOT_UNCONFIRMED', 'The browser storage directory contains a link.')
        if (childStat.isDirectory()) walk(child, childStat, depth + 1)
        else {
          // Unlike unlinking a file, a native LevelDB write could change an
          // external hardlink. Do not let browser cleanup acquire that reach.
          if (!childStat.isFile() || String(childStat.nlink) !== '1') fail('RESET_BROWSER_ROOT_UNCONFIRMED', 'The browser storage directory contains a shared or invalid file.')
          if (normalized(fs.realpathSync(child)) !== normalized(child)) fail('RESET_BROWSER_ROOT_UNCONFIRMED', 'A browser storage file resolves through an alias.')
        }
      }
    }
    walk(localStorage, initial, 0)
  }
  function inspect() {
    const deadline = now() + INSPECTION_TIMEOUT_MS
    const checkBudget = () => {
      const remaining = deadline - now()
      if (!(remaining > 0)) fail('RESET_BROWSER_INSPECTION_TIMEOUT', 'Browser storage ownership could not be checked before its deadline.')
      return Math.max(1, Math.floor(remaining))
    }
    const windowsAttributes = (paths, options = {}) => {
      checkWindowsAttributes(paths, { ...options, timeoutMs: checkBudget() })
      checkBudget()
    }
    // Windows exposes additional reparse tags that Node's symbolic-link bit
    // does not report. Check each parent before any child, with no enumeration.
    if (platform === 'win32') windowsAttributes(chain)
    const identities = chain.map(directory => {
      checkBudget()
      const stat = fs.lstatSync(directory, { bigint: true })
      if (stat.isSymbolicLink() || !stat.isDirectory()) fail('RESET_BROWSER_ROOT_UNCONFIRMED', 'The application storage path contains a link or invalid directory.')
      if (normalized(fs.realpathSync(directory)) !== normalized(directory)) fail('RESET_BROWSER_ROOT_UNCONFIRMED', 'The application storage path resolves through an alias.')
      if (!['number', 'bigint'].includes(typeof stat.dev) || !['number', 'bigint'].includes(typeof stat.ino)) fail('RESET_BROWSER_ROOT_UNCONFIRMED', 'The application directory identity is unavailable.')
      return { directory, device: String(stat.dev), inode: String(stat.ino) }
    })
    inspectLocalStorage(checkBudget, windowsAttributes)
    checkBudget()
    return identities
  }
  const identities = inspect()
  if (typeof measurePlan === 'function') plannedRoots = planIdentity(measurePlan())
  let attempted = false, cleared = false, reason = null, flight = null
  function revalidate({ session: currentSession, userData: currentUserData } = {}) {
    // Compare syntax and Session identity before looking up any filesystem path.
    if (currentSession !== session || normalized(currentUserData) !== root || normalized(session.storagePath) !== root) {
      fail('RESET_BROWSER_SESSION_CHANGED', 'The window or its application storage directory changed during removal.')
    }
    if (JSON.stringify(inspect()) !== JSON.stringify(identities)) fail('RESET_BROWSER_ROOT_CHANGED', 'The application storage directory was replaced during removal.')
    return true
  }
  function validatePlan(value) {
    if (planIdentity(value) !== plannedRoots) fail('RESET_BROWSER_PLAN_CHANGED', 'The local-data removal roots changed during browser cleanup.')
    return true
  }
  function snapshot() { return Object.freeze({ attempted, cleared, ...(reason ? { reason } : {}) }) }
  function clear() {
    if (flight) return flight
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > CLEAR_TIMEOUT_MS) fail('RESET_BROWSER_DEADLINE_INVALID', 'Browser cleanup has no valid deadline.')
    revalidate({ session, userData })
    const deadline = now() + timeoutMs
    flight = new Promise((resolve, reject) => {
      let done = false, timer
      const finish = error => {
        if (done) return
        done = true
        clearTimeout(timer)
        if (error) { reason = error.message; reject(error) }
        else { cleared = true; resolve(snapshot()) }
      }
      const timeout = () => finish(Object.assign(new Error('Browser settings cleanup did not finish before its deadline.'), { code: 'RESET_BROWSER_CLEAR_TIMEOUT' }))
      timer = setTimeout(timeout, timeoutMs)
      attempted = true
      let operation
      try {
        // Omitting origin clears legacy copies from every former loopback port.
        operation = session.clearStorageData({ storages: ['localstorage'] })
        if (!operation || typeof operation.then !== 'function') throw new Error('Browser settings cleanup did not return a completion promise.')
      } catch {
        finish(Object.assign(new Error('Browser settings cleanup could not be confirmed.'), { code: 'RESET_BROWSER_CLEAR_FAILED' }))
        return
      }
      const owned = { session, operation }
      pendingClears.add(owned)
      Promise.resolve(operation).then(() => {
        pendingClears.delete(owned)
        if (now() >= deadline) timeout()
        else finish()
      }, () => {
        pendingClears.delete(owned)
        finish(Object.assign(new Error('Browser settings cleanup could not be confirmed.'), { code: 'RESET_BROWSER_CLEAR_FAILED' }))
      })
    })
    return flight
  }
  return Object.freeze({ clear, revalidate, validatePlan, snapshot })
}

module.exports = { captureResetBrowserStorage, CLEAR_TIMEOUT_MS, INSPECTION_TIMEOUT_MS }
