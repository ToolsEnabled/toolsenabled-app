'use strict'

/* THE FILESYSTEM WORK THE MAIN THREAD USED TO DO WITH THE LOOP HELD SHUT.
 *
 * Every mc-* ipcMain.handle body runs on Electron's main thread, and so does
 * the shell's own HTTP server. A readFileSync/statSync/writeFileSync there is
 * not "a millisecond" -- it is a millisecond during which no other session's
 * IPC reply, no window paint and no tree timer can run, on a machine whose
 * disk is shared with every agent this application starts.
 *
 * MEASURED 2026-09-03 (node v22.14.0, Windows 10, 8 cores, this machine under
 * its normal agent load; tools/ipc-sync-io-bench.mjs, three runs, main-thread
 * block per call, average and p99, worst and best run):
 *
 *                                  BEFORE avg    AFTER avg   BEFORE p99   AFTER p99
 *   fleet-profile durable write   3.30-4.31 ms  0.07-0.51 ms  14.2-83.1   1.4-8.1
 *   accounts usage cache read     1.50-2.64 ms  0.05-0.09 ms  17.6-33.9   0.3-1.4
 *   accounts usage cache write    1.44-3.73 ms  0.10-0.28 ms  14.0-73.1   0.7-2.1
 *   fleet record read (/data/*)   1.86-5.55 ms  0.05-0.07 ms  21.0-43.9   0.3-0.7
 *   purchase-list stat            0.10-0.13 ms  0.05-0.07 ms   0.5-0.7    0.2-0.7
 *
 * The awaited call takes LONGER end to end (the durable write went from
 * 3.3-4.3 ms to 14.0-25.9 ms, because the syscall now waits its turn on
 * libuv's four-thread pool alongside every other agent on this machine). That
 * is the trade and it is the right one: the one person who pressed Save waits,
 * and every other session on the machine keeps running while they do.
 *
 * WHY THE GATE. The shipped code was synchronous, so a handler ran to
 * completion before the next one could start. Awaiting each syscall gives that
 * ordering away unless it is put back deliberately: two saves would each build
 * their own temp file and race to rename, and the rename that finished last
 * would win rather than the one requested last. A save that landed after a
 * reset would resurrect the very profile somebody had just erased, which is
 * the one thing the reset tombstone exists to prevent. `serialQueue` restores
 * exactly the shipped ordering -- one operation on a file at a time, in the
 * order the handlers asked for them -- and nothing more.
 *
 * The atomic rename is unchanged, so no reader ever sees a half-written file;
 * the queue is about the ORDER OF CALLS, not about torn reads.
 *
 * ON WINDOWS THE QUEUE IS ALSO WHAT KEEPS THE WRITE FROM FAILING. MEASURED
 * 2026-09-03, node v22.14.0, Windows 10, by tools/test/ipc-handler-sync-io:
 * an ungated read of a file while its replacement was renaming did not merely
 * see an older copy, it made the replacement fail --
 *   EPERM: operation not permitted, rename '...json.tmp-8672' -> '...json'
 * because Windows refuses to rename over a path another handle has open. The
 * synchronous code could never reach that state, because it held the thread.
 * Sharing one queue per file is what keeps an allowance read from throwing
 * away the very write that was meant to record it.
 */

const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const { randomUUID } = require('crypto')

/* Results are deliberately code-shaped rather than thrown, and deliberately
 * neutral: the caller keeps its own error vocabulary (MC_FLEET_PROFILE_*,
 * the checkout surface's sentences) so converting a body to async cannot
 * quietly change one word the person reads. */
const ABSENT = 'absent'
const NOT_FILE = 'not-file'
const TOO_LARGE = 'too-large'
const READ_FAILED = 'read-failed'
const PRESENT = 'present'

function statVerdict(stat, maxBytes) {
  if (!stat.isFile()) return { state: NOT_FILE, size: stat.size }
  if (typeof maxBytes === 'number' && stat.size > maxBytes) return { state: TOO_LARGE, size: stat.size }
  return { state: PRESENT, size: stat.size }
}

function readVerdictFromError(error) {
  /* ENOENT from either the stat or the read is "there is none", exactly as the
   * one try/catch around both syscalls answered it before. */
  if (error && error.code === 'ENOENT') return { state: ABSENT, errorCode: 'ENOENT' }
  return { state: READ_FAILED, errorCode: (error && error.code) || null }
}

/* ---------- bounded reads ---------- */

async function readBoundedFile(file, maxBytes) {
  try {
    const verdict = statVerdict(await fsp.stat(file), maxBytes)
    if (verdict.state !== PRESENT) return verdict
    return { state: PRESENT, size: verdict.size, text: await fsp.readFile(file, 'utf8') }
  } catch (error) {
    return readVerdictFromError(error)
  }
}

/* The same answer without yielding, for the two sendSync channels that cannot
 * await one: shell/fleet-profile-preload.cjs reads the durable profile at
 * preload time and src/fleet-profile.js migrates a legacy browser copy at
 * module init, both strictly before the settings form that issues a save can
 * exist. Neither is a per-call path. */
function readBoundedFileSync(file, maxBytes) {
  try {
    const verdict = statVerdict(fs.statSync(file), maxBytes)
    if (verdict.state !== PRESENT) return verdict
    return { state: PRESENT, size: verdict.size, text: fs.readFileSync(file, 'utf8') }
  } catch (error) {
    return readVerdictFromError(error)
  }
}

async function statBoundedFile(file, maxBytes) {
  try {
    return statVerdict(await fsp.stat(file), maxBytes)
  } catch (error) {
    return readVerdictFromError(error)
  }
}

/* ---------- replacements ---------- */

function temporaryNeighbour(file, prefix) {
  const directory = path.dirname(file)
  return path.join(directory, `${prefix}-${process.pid}-${randomUUID()}.tmp`)
}

/* Create-exclusive temp, write, fsync, close, rename. fsync is what makes this
 * DURABLE rather than merely atomic: without it the rename can be visible
 * while the bytes it names are still in the cache, and a power cut leaves a
 * present, empty file where a configured fleet used to be. */
async function replaceFileDurably(file, text, { tempPrefix = '.durable' } = {}) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const temp = temporaryNeighbour(file, tempPrefix)
  let handle
  try {
    handle = await fsp.open(temp, 'wx')
    await handle.writeFile(text, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await fsp.rename(temp, file)
  } finally {
    if (handle !== undefined) {
      try { await handle.close() } catch {}
    }
    try { await fsp.unlink(temp) } catch {}
  }
}

function replaceFileDurablySync(file, text, { tempPrefix = '.durable' } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = temporaryNeighbour(file, tempPrefix)
  let descriptor
  try {
    descriptor = fs.openSync(temp, 'wx')
    fs.writeFileSync(descriptor, text, 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.renameSync(temp, file)
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor) } catch {}
    }
    try { fs.unlinkSync(temp) } catch {}
  }
}

/* A cache, not a record: no directory creation and no fsync, because losing
 * the last allowance read to a power cut costs the next menu a few seconds and
 * nothing else. The rename still makes it all-or-nothing, so a reader never
 * parses half a file. This is the shape mc-accounts:usage already wrote. */
async function replaceFileAtomically(file, text, { tempSuffix = `.tmp-${process.pid}` } = {}) {
  const temp = `${file}${tempSuffix}`
  await fsp.writeFile(temp, text)
  await fsp.rename(temp, file)
}

/* ---------- ordering ---------- */

/* One operation at a time, in the order asked for. Tasks are chained on a
 * promise that never rejects, so one failed write cannot wedge the queue for
 * every later caller -- each caller still receives its own outcome. */
function serialQueue() {
  let tail = Promise.resolve()
  return function runInOrder(task) {
    const result = tail.then(task)
    tail = result.then(() => undefined, () => undefined)
    return result
  }
}

module.exports = {
  ABSENT,
  NOT_FILE,
  PRESENT,
  READ_FAILED,
  TOO_LARGE,
  readBoundedFile,
  readBoundedFileSync,
  replaceFileAtomically,
  replaceFileDurably,
  replaceFileDurablySync,
  serialQueue,
  statBoundedFile,
}
