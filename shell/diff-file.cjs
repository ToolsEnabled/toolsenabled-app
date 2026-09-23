'use strict'

/* THE ONE FILE VERB THE SPLIT COMPARE WINDOW WRITES THROUGH.
 *
 * WHAT WAS ALREADY HERE, MEASURED BEFORE THIS FILE WAS WRITTEN. The brief for
 * the compare window said the save must go through "the same main-process file
 * verb the rest of the product uses". There is no such verb. Every ipcMain
 * channel in shell/main.cjs was listed and read: the agent channels start and
 * drive a child process, `mc-fleet-profile:export-file` writes exactly one
 * exported profile to a path a native dialog just returned, `mc-prefs:write`
 * writes into the settings record, and nothing else writes bytes anywhere on
 * behalf of the window. The renderer has never been able to write a file of a
 * person's choosing. So this is the FIRST such verb rather than a second copy
 * of one, and the whole compare window -- both panes, both save controls --
 * goes through it. If a second write path ever appears, one of the two is
 * wrong; this is the one with the fence.
 *
 * THE FENCE IS THE SAME FOLDER AN AGENT RUNS IN, and that is the entire point.
 * The person is overriding what an agent produced, by hand, so the window may
 * reach exactly what the agent could reach and not one directory further:
 * `chosenWorkspaceCwd()` -- the folder answered in setup -- and WORKSPACE_ROOT,
 * the folder this product creates and owns. Both are handed in by shell/main.cjs
 * from the very functions the agent start uses, so the two cannot drift.
 *
 * THE FENCE IS APPLIED TO THE REAL PATH, NOT THE TYPED ONE. On Windows a
 * junction or a symbolic link inside the work folder points anywhere on the
 * disk, and a check that compared the string a caller supplied would wave that
 * through. Every root and every candidate is resolved through realpath first;
 * for a file that does not exist yet the DIRECTORY is resolved and the name is
 * put back on the end, because a link cannot be traversed through a name that
 * is not there.
 *
 * IT ANSWERS WITH A CODE, NEVER A SENTENCE AND NEVER A PATH. That is the rule
 * rendererSafeAgentError() states in shell/main.cjs: an error message is the
 * one field that may name an absolute path, and data that is not sent cannot be
 * rendered by the next person who forgets. src/diff-editor.js owns the
 * sentences, one per code, and shows nothing it cannot find in its own table.
 *
 * THAT WAS TRUE OF THIS FILE AND NOT OF THE CHANNEL AROUND IT. Every function
 * below answers with a code, and none of them throws -- but the wrapper in
 * shell/main.cjs, `withFleetProfileSender`, catches a throw and answers
 * `{ ok:false, error:{ code, message } }`, and an fs message names an absolute
 * path. A throw out of `dialog.showOpenDialog` went straight through it.
 * `diffAnswer()` below is the catch that runs INSIDE that wrapper, and every
 * mc-diff channel goes through it; the invariant is now held where it was
 * previously only stated.
 */

/* WHY A MEGABYTE. This is a hand editing surface, and the honest limit is the
   one the window can actually carry rather than the one the disk can. A 1 MiB
   file is about 25,000 lines of source; past that a person is not reviewing a
   change by eye, and a textarea is the wrong instrument. Stated in the window
   before a file is opened, and enforced here so the statement is true. */
const MAX_FILE_BYTES = 1024 * 1024

/* A Windows replace fails at random while another process holds a transient
   handle on a file created a millisecond ago -- Defender and the search indexer
   are the usual pair. shell/renderer-prefs.cjs measured this (two EPERM in 512
   writes) and answers it with the same four waits; this is the same mitigation
   at the same numbers rather than a second opinion about them. */
const WRITE_ATTEMPTS = 5
const WRITE_BACKOFF_MS = Object.freeze([1, 2, 4, 8])
const RETRYABLE_WRITE_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY', 'EEXIST'])

function refusal(code) {
  return { ok: false, code }
}

/**
 * THE CATCH THAT RUNS INSIDE THE CHANNEL WRAPPER, so a throw never becomes a
 * message.
 *
 * `withFleetProfileSender` in shell/main.cjs turns an exception into
 * `{ ok: false, error: { code, message } }`, and `error.message` for anything
 * out of fs carries an absolute path -- the one field rendererSafeAgentError()
 * says may not cross. Nothing in this module throws, but `dialog.showOpenDialog`
 * can and so can whatever a later channel calls on its way here, so every
 * mc-diff channel wraps its work in this before the outer wrapper ever sees it.
 * Data that is not sent cannot be rendered by the next person who forgets.
 *
 * An answer is handed straight back, refusal or not: this is a catch, not a
 * second opinion about what a refusal is.
 */
function diffAnswer(code, action) {
  try {
    const answer = action()
    if (answer && typeof answer.then === 'function') return answer.then(value => value, () => refusal(code))
    return answer
  } catch {
    return refusal(code)
  }
}

/* Synchronous, for the reason shell/renderer-prefs.cjs is: handing control back
   to the event loop between attempts lets a second write interleave with this
   one, and the whole promise of the save is that it either replaced the file or
   did not. */
function pauseSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

/**
 * The real location of `target`, as far as the disk can be asked.
 *
 * A path that exists is resolved outright. A path that does not is resolved
 * through its PARENT, which is what closes the link hole for a file about to be
 * created: `<work>\link\new.txt` where `link` is a junction must resolve to the
 * junction's real target before the fence looks at it. A parent that cannot be
 * resolved either is returned unchanged and will fail the fence, which is the
 * safe direction.
 */
function realLocation(target, { fs, path }) {
  const resolveReal = typeof fs.realpathSync.native === 'function' ? fs.realpathSync.native : fs.realpathSync
  try {
    return resolveReal(target)
  } catch { /* not on disk yet: resolve the folder it would go in */ }
  const parent = path.dirname(target)
  if (parent === target) return target
  try {
    return path.join(resolveReal(parent), path.basename(target))
  } catch {
    return target
  }
}

/**
 * Is `resolved` inside `root`?
 *
 * `path.relative` does the case-folding this needs on Windows and does not do
 * it elsewhere, which is exactly right on both. The two tests afterwards are
 * the ones a naive `startsWith('..')` gets wrong: a sibling directory literally
 * named `..config` produces a relative path starting with two dots and IS
 * inside the root, while a different drive letter produces an absolute one.
 */
function contains(root, resolved, { path }) {
  const relative = path.relative(root, resolved)
  if (relative === '') return false
  if (path.isAbsolute(relative)) return false
  return relative !== '..' && !relative.startsWith(`..${path.sep}`)
}

/**
 * @param {object} options
 * @param {object} options.fs    node:fs, injected so the suites drive the real
 *                               module against a real temporary directory and
 *                               can also hand it a failing disk.
 * @param {object} options.path  node:path.
 * @param {Function} options.workspaceRoots  called per request, not captured:
 *   a person who changes their work folder in Settings must be fenced to the
 *   new one on the next save rather than on the next launch. Same reason
 *   relayPrincipal() in shell/main.cjs re-reads its switch per call.
 */
function createDiffFiles({ fs, path, workspaceRoots, pid = process.pid, randomUUID }) {
  if (typeof workspaceRoots !== 'function') throw new TypeError('createDiffFiles requires a workspaceRoots function')

  function roots() {
    let listed
    try { listed = workspaceRoots() } catch { return [] }
    if (!Array.isArray(listed)) return []
    const out = []
    for (const entry of listed) {
      if (typeof entry !== 'string' || entry.trim() === '') continue
      const resolved = realLocation(path.resolve(entry), { fs, path })
      /* A ROOT THAT IS NOT A DIRECTORY ON THE DISK FENCES NOTHING, and keeping
         it in the list is worse than dropping it. `contains()` below is a
         string comparison: a work folder that was never created, or was
         deleted after it was recorded, still "contains" every path a caller
         types under it, so the save passes the fence and fails at the disk
         with "check that it is still there" -- advice about the file, when the
         thing that is missing is the folder. Dropped here instead, which is
         what makes MC_DIFF_NO_WORKSPACE a state a person can actually reach
         and its sentence the right one to read. shell/main.cjs cannot produce
         an empty list on its own: ensureWorkspaceRoot() returns WORKSPACE_ROOT
         whatever happens to its mkdirSync, and chosenWorkspaceCwd() answers
         null rather than throwing. This is the check that gives that
         unconditional answer a way to be wrong. */
      let onDisk = false
      try { onDisk = fs.statSync(resolved).isDirectory() } catch { onDisk = false }
      if (!onDisk) continue
      if (!out.includes(resolved)) out.push(resolved)
    }
    return out
  }

  /** The fence. `{ ok, path }` or a refusal code, and never a sentence. */
  function fenced(candidate) {
    if (typeof candidate !== 'string' || candidate.trim() === '' || candidate.includes('\0')) {
      return refusal('MC_DIFF_PATH_MISSING')
    }
    /* A bound on the path itself, before it reaches the disk. Windows refuses
       these anyway; refusing here means the answer is a code this window has a
       sentence for rather than whatever the platform threw. */
    if (candidate.length > 32768) return refusal('MC_DIFF_PATH_MISSING')
    const available = roots()
    if (available.length === 0) return refusal('MC_DIFF_NO_WORKSPACE')
    const resolved = realLocation(path.resolve(candidate), { fs, path })
    for (const root of available) {
      if (contains(root, resolved, { path })) return { ok: true, path: resolved }
    }
    return refusal('MC_DIFF_OUTSIDE_WORKSPACE')
  }

  /**
   * Read one file for a pane.
   *
   * `modifiedMs` travels back so the window can say, at save time, that the
   * file on disk has moved since it was opened. That is a STATEMENT, not a
   * lock: the owner ruled that this surface warns and then lets the person
   * save. Nothing here refuses a save because of it.
   */
  function read(candidate) {
    const allowed = fenced(candidate)
    if (!allowed.ok) return allowed
    let stat
    try { stat = fs.statSync(allowed.path) } catch { return refusal('MC_DIFF_STAT_FAILED') }
    if (!stat.isFile()) return refusal('MC_DIFF_NOT_A_FILE')
    if (stat.size > MAX_FILE_BYTES) return refusal('MC_DIFF_TOO_LARGE')
    let buffer
    try { buffer = fs.readFileSync(allowed.path) } catch { return refusal('MC_DIFF_READ_FAILED') }
    if (buffer.length > MAX_FILE_BYTES) return refusal('MC_DIFF_TOO_LARGE')
    /* A NUL byte is the cheap, reliable tell for "this is not text". Opening a
       compiled binary in a textarea and saving it back would destroy it
       silently, which is the one outcome this window must never produce. */
    if (buffer.includes(0)) return refusal('MC_DIFF_NOT_TEXT')
    return {
      ok: true,
      path: allowed.path,
      text: buffer.toString('utf8'),
      bytes: stat.size,
      modifiedMs: Math.trunc(stat.mtimeMs),
    }
  }

  /**
   * What the file on disk looks like NOW, without carrying its contents back.
   *
   * The window asks this the moment before it writes, so its warning can say
   * whether the file really has moved rather than only that it might have. It
   * deliberately returns no text: the warning is about whether to proceed, and
   * a second copy of the bytes on the wire would be a second answer to a
   * question the read above already answered.
   */
  function stamp(candidate) {
    const allowed = fenced(candidate)
    if (!allowed.ok) return allowed
    let stat
    try { stat = fs.statSync(allowed.path) } catch (error) {
      if (error?.code !== 'ENOENT') return refusal('MC_DIFF_STAT_FAILED')
      return { ok: true, path: allowed.path, exists: false, modifiedMs: null, bytes: null }
    }
    if (!stat.isFile()) return refusal('MC_DIFF_NOT_A_FILE')
    return { ok: true, path: allowed.path, exists: true, modifiedMs: Math.trunc(stat.mtimeMs), bytes: stat.size }
  }

  /**
   * Replace one file with what is in one pane.
   *
   * THE DELIBERATE MANUAL OVERRIDE. The owner: "warn the user about the
   * staleness possibility ... then let them do it themselves - this is their
   * manual override of the agent." So there is no freshness token here and no
   * compare-and-swap. The window warns; this writes.
   *
   * IT IS STILL ATOMIC. Temporary file, fsync, rename -- the same three steps
   * shell/renderer-prefs.cjs and the durable fleet profile take, for the same
   * reason: a half-written source file is worse than an unwritten one, and a
   * power cut in the middle of a hand edit must leave the original intact.
   */
  function write(candidate, text) {
    if (typeof text !== 'string') return refusal('MC_DIFF_TEXT_MISSING')
    if (text.includes('\0')) return refusal('MC_DIFF_NOT_TEXT')
    /* A DIFFERENT CODE FROM THE READ'S, on purpose. The read's refusal tells a
       person to open the file somewhere else, which is right for a file they
       have not opened yet and wrong after they have spent an hour editing one:
       at that point the only copy of the work is in the box, and "open it
       elsewhere" is a dead end. src/diff-editor.js has the two sentences. */
    if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) return refusal('MC_DIFF_TOO_LARGE_TO_SAVE')
    const allowed = fenced(candidate)
    if (!allowed.ok) return allowed

    /* The temporary lands BESIDE the file, never in a system temp folder: a
       rename across volumes is a copy, and a copy is not atomic. */
    const directory = path.dirname(allowed.path)
    const unique = typeof randomUUID === 'function' ? randomUUID() : String(Math.random()).slice(2)
    const temporary = path.join(directory, `.diff-save-${pid}-${unique}.tmp`)

    let lastError = null
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
      let descriptor
      try {
        descriptor = fs.openSync(temporary, 'wx')
        fs.writeFileSync(descriptor, text, 'utf8')
        fs.fsyncSync(descriptor)
        fs.closeSync(descriptor)
        descriptor = undefined
        fs.renameSync(temporary, allowed.path)
        lastError = null
        break
      } catch (error) {
        lastError = error
      } finally {
        if (descriptor !== undefined) {
          try { fs.closeSync(descriptor) } catch { /* closing a handle that already failed */ }
        }
        try { fs.unlinkSync(temporary) } catch { /* already renamed away, or never created */ }
      }
      if (!RETRYABLE_WRITE_ERRORS.has(lastError && lastError.code)) break
      if (attempt < WRITE_ATTEMPTS - 1) pauseSync(WRITE_BACKOFF_MS[attempt])
    }
    if (lastError) return refusal('MC_DIFF_WRITE_FAILED')

    let modifiedMs = null
    let bytes = null
    try {
      const stat = fs.statSync(allowed.path)
      modifiedMs = Math.trunc(stat.mtimeMs)
      bytes = stat.size
    } catch { /* written; the stamp is a convenience, not the receipt */ }
    return { ok: true, path: allowed.path, modifiedMs, bytes }
  }

  function readChange(candidate) {
    if (typeof candidate !== 'string' || !candidate.trim()) return refusal('MC_DIFF_PATH_MISSING')
    // Older history may have a relative path without its session's folder.
    // Guessing against today's folder can open an unrelated same-named file.
    if (!path.isAbsolute(candidate)) return refusal('MC_DIFF_PATH_UNBOUND')
    const allowed = fenced(candidate)
    if (!allowed.ok) return allowed
    try { fs.statSync(allowed.path) } catch (error) {
      if (error?.code !== 'ENOENT') return refusal('MC_DIFF_STAT_FAILED')
      return { ok: true, path: allowed.path, exists: false, modifiedMs: null, bytes: null, text: '' }
    }
    return { ...read(allowed.path), exists: true }
  }

  return { read, readChange, stamp, write, fenced }
}

module.exports = {
  MAX_FILE_BYTES,
  WRITE_ATTEMPTS,
  createDiffFiles,
  diffAnswer,
}
