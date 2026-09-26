'use strict'

/* Find and reap a process's descendants on Windows.
 *
 * This exists because `taskkill /PID <pid> /T /F` is not a tree kill in the
 * case that actually matters here. /T walks LIVE parent->child links. If the
 * middle process has already exited -- which is exactly what happens when an
 * Electron app exits while its crashpad handler and spawned bridge outlive it
 * -- the walk ends at the dead parent and the orphans survive. Worse, taskkill
 * against an already-dead pid fails outright ("process not found") and reaps
 * nothing at all.
 *
 * Measured, not assumed. A first check of /T used a LIVE middle and appeared
 * to prove it reached grandchildren; re-run against a DEAD middle with a
 * detached grandchild, /T left the orphan running. The precondition assertion
 * in the test is what makes that distinction -- without it the test can pass
 * because the grandchild died on its own, proving nothing.
 *
 * So the reap has to run from the parent, while the links are still intact.
 *
 * Deliberately free of any Electron dependency so it can be tested directly.
 */

const { execFileSync } = require('node:child_process')

const SNAPSHOT_TIMEOUT_MS = 20_000
const KILL_TIMEOUT_MS = 10_000

function snapshotUnavailable(cause) {
  const error = new Error(
    'Process snapshot unavailable; this does not claim that the process tree is empty.',
    { cause },
  )
  error.code = 'PROCESS_SNAPSHOT_UNAVAILABLE'
  return error
}

/** One snapshot of every pid and its parent. Untrusted and bounded. */
function processSnapshot({ run = execFileSync, platform = process.platform } = {}) {
  let raw
  try {
    if (platform === 'linux' || platform === 'darwin') {
      raw = run('ps', ['-e', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: SNAPSHOT_TIMEOUT_MS })
      return String(raw).trim().split('\n').filter(Boolean).map(line => {
        const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
        if (!match) throw new Error('Malformed native process snapshot')
        return { ProcessId: Number(match[1]), ParentProcessId: Number(match[2]) }
      })
    }
    if (platform !== 'win32') throw new Error(`Process snapshots are unavailable on ${platform}`)
    raw = run('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      '@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId) | ConvertTo-Json -Compress',
    ], { encoding: 'utf8', timeout: SNAPSHOT_TIMEOUT_MS, windowsHide: true })
  } catch (error) {
    throw snapshotUnavailable(error)
  }
  let rows
  try { rows = JSON.parse(raw) } catch (error) { throw snapshotUnavailable(error) }
  return Array.isArray(rows) ? rows : [rows]
}

/**
 * Every descendant pid of rootPid, breadth-first. rootPid itself is excluded:
 * the caller is usually that process and must not kill itself before it has
 * reported its result.
 */
function descendantPids(rootPid, { snapshot = processSnapshot } = {}) {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) return []
  const children = new Map()
  for (const row of snapshot()) {
    if (!row) continue
    const parent = Number(row.ParentProcessId)
    const pid = Number(row.ProcessId)
    if (!Number.isSafeInteger(parent) || !Number.isSafeInteger(pid)) continue
    if (!children.has(parent)) children.set(parent, [])
    children.get(parent).push(pid)
  }
  const found = []
  const seen = new Set([rootPid])
  const queue = [rootPid]
  while (queue.length > 0) {
    for (const pid of children.get(queue.shift()) || []) {
      /* A cycle cannot happen in a real process table, but pid reuse can make
         the snapshot look like one, and an unguarded walk would hang. */
      if (seen.has(pid)) continue
      seen.add(pid)
      found.push(pid)
      queue.push(pid)
    }
  }
  return found
}

/** Kill the given pids. Already-gone is the normal case, not a failure. */
function reapPids(pids, { run = execFileSync, platform = process.platform, kill = process.kill } = {}) {
  let reaped = 0
  for (const pid of pids) {
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) continue
    try {
      if (platform === 'linux' || platform === 'darwin') kill(pid, 'SIGKILL')
      else if (platform === 'win32') run('taskkill', ['/PID', String(pid), '/F'], {
          stdio: 'ignore', timeout: KILL_TIMEOUT_MS, windowsHide: true,
        })
      else continue
      reaped += 1
    } catch { /* already exited between snapshot and kill */ }
  }
  return reaped
}

/** Convenience: snapshot descendants of rootPid and kill them. */
function reapDescendants(rootPid, options = {}) {
  return reapPids(descendantPids(rootPid, options), options)
}

module.exports = { processSnapshot, descendantPids, reapPids, reapDescendants }
