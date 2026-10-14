'use strict'

/* SESSION PROFILES — the main process's own record of the working folders a
 * person has chosen for their agents.
 *
 * The owner's ask (iteration 5, W6): different trees run agents under
 * different "profiles" — at minimum a working folder — because one
 * onboarding polluting non-ToolsEnabled work is a real, daily pain. Codex
 * discovers its instructions from the directory it runs in, so per-tree cwd
 * IS per-tree onboarding.
 *
 * WHY THIS LIVES IN THE MAIN PROCESS, AND NOT IN RENDERER STORAGE. The
 * boundary is the point: a session's working directory decides what an agent
 * can read and which instructions it wakes into, and normalizeCwd in
 * agent-host.cjs validates existence only — no containment. So the renderer
 * NEVER sends a raw path for a session. It sends a profileId; this store —
 * which only ever holds folders the person picked through the OS folder
 * dialog — resolves it. A hand-built IPC payload can name a profile that
 * exists or be refused; it cannot smuggle a path.
 *
 * Storage: <userData>/session-profiles.json, atomic replace. A damaged file
 * degrades to an empty list AND SAYS SO — that is the research-queue-store
 * doctrine in full (src/research-queue-store.js:34-35), and this comment used
 * to quote only the first half of it, as "absence and damage are the same
 * honest answer". They are not, and the store it cited never said they were.
 * The damaged bytes are copied to <file>.damaged before anything can replace
 * them; see readAll for what the silent version cost.
 */

const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const MAX_PROFILES = 16
const MAX_NAME_LENGTH = 64
const MAX_CWD_LENGTH = 1024
const FILE_VERSION = 1
/* Generous against the real ceiling -- 16 profiles of a 64-character name and a
   1024-character path cannot approach it -- so anything larger is not a profile
   file that grew, it is a file that went wrong. */
const MAX_STORE_BYTES = 256 * 1024

function createSessionProfileStore({ file }) {
  if (typeof file !== 'string' || !file) throw new Error('session-profile store needs its file path')

  /* DAMAGE WAS INDISTINGUISHABLE FROM HAVING NO PROFILES, AND THE NEXT WRITE
   * MADE IT PERMANENT.
   *
   * The header above cites "the research-queue-store doctrine: absence and
   * damage are the same honest answer -- nothing". That is a misquote, and the
   * source says the opposite. src/research-queue-store.js:34-35: "A damaged row
   * degrades to empty rather than hiding the shipped queue behind a parse error
   * -- BUT SAYS SO VIA `damaged`." Distinguishing the two is the whole point of
   * the doctrine; only the first half of it was implemented here.
   *
   * What that cost: a truncated write -- the realistic damage, a process killed
   * mid-save -- made every working folder the person had chosen disappear, with
   * the screen showing exactly what it shows for someone who has never made
   * one. Then `create()` reads [], writes a file holding only the new profile,
   * and renames it over the damaged original. The recoverable bytes are gone
   * for good, and nothing ever said a word.
   *
   * So: the damaged bytes are copied aside BEFORE anything can overwrite them,
   * and the damage is remembered so a caller can say so. It still degrades to
   * an empty list -- that part was right, and it is what keeps a bad file from
   * bricking the panel. Deliberately NOT a throw: every caller wraps this in
   * `.catch(() => null)` and disables Create and Remove on failure, so throwing
   * would turn one bad write into session folders that cannot be used again
   * until somebody hand-deletes a file in %APPDATA%.
   */
  let readWasDamaged = false

  function preserveDamagedBytes(contents) {
    const sidecar = `${file}.damaged`
    try {
      /* Keep the FIRST damaged copy. A second damage event is usually this same
         empty-file state coming back around, and overwriting would trade the
         recoverable bytes for worthless ones. */
      if (fs.existsSync(sidecar)) return
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(sidecar, contents)
    } catch {
      /* Best effort by design: preserving a copy must never be the reason a
         read fails. If this cannot be written, the read still degrades safely. */
    }
  }

  function readAll() {
    let contents
    try {
      /* A size check before the read, because readFileSync on a file that grew
         wrong has no upper bound and this runs in the main process. */
      const stat = fs.statSync(file)
      if (stat.size > MAX_STORE_BYTES) {
        readWasDamaged = true
        return []
      }
      contents = fs.readFileSync(file, 'utf8')
    } catch (error) {
      if (error && error.code === 'ENOENT') return []
      throw refusal('PROFILE_STORE_UNREADABLE', 'The session profiles could not be read. Try again.')
    }
    try {
      const parsed = JSON.parse(contents)
      if (!parsed || parsed.v !== FILE_VERSION || !Array.isArray(parsed.profiles)) {
        readWasDamaged = true
        preserveDamagedBytes(contents)
        return []
      }
      const usable = parsed.profiles.filter(entry =>
        entry && typeof entry.id === 'string' && typeof entry.name === 'string' && typeof entry.cwd === 'string')
      /* A file that parsed but lost entries is damage too, and it is the case
         most likely to go unnoticed: the list still has profiles in it, so
         nothing looks wrong to anyone who is not counting. */
      if (usable.length !== parsed.profiles.length) {
        readWasDamaged = true
        preserveDamagedBytes(contents)
      }
      return usable
    } catch {
      readWasDamaged = true
      preserveDamagedBytes(contents)
      return []
    }
  }

  function writeAll(profiles) {
    const temp = `${file}.tmp-${process.pid}`
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(temp, JSON.stringify({ v: FILE_VERSION, profiles }, null, 2))
    fs.renameSync(temp, file)
  }

  function assertUsableFolder(cwd) {
    if (typeof cwd !== 'string' || !cwd || cwd.length > MAX_CWD_LENGTH || cwd.includes('\0')) {
      throw refusal('PROFILE_FOLDER_INVALID', 'The chosen folder path is not usable.')
    }
    let stat
    try { stat = fs.statSync(cwd) } catch {
      throw refusal('PROFILE_FOLDER_MISSING', 'That folder does not exist any more. Pick it again.')
    }
    if (!stat.isDirectory()) throw refusal('PROFILE_FOLDER_NOT_DIRECTORY', 'That path is a file, not a folder.')
    if (cwd.includes('.asar')) throw refusal('PROFILE_FOLDER_INVALID', 'That folder is inside the application package.')
  }

  function refusal(code, message) {
    const error = new Error(message)
    error.code = code
    return error
  }

  return {
    list() {
      return readAll().map(entry => ({ id: entry.id, name: entry.name, cwd: entry.cwd }))
    },

    /* Whether anything has been lost to damage since this store was created.
       Separate from list() on purpose: list() answers "what have you got", and
       a caller that only asks that cannot tell an empty answer apart from a
       destroyed one. Nothing in the renderer reads this yet -- when a surface
       is ready to say so, the fact is here rather than needing to be recovered
       from a file that has by then been overwritten. */
    damaged() {
      return readWasDamaged
    },

    create({ name, cwd }) {
      const cleanName = typeof name === 'string' ? name.trim().slice(0, MAX_NAME_LENGTH) : ''
      if (!cleanName) throw refusal('PROFILE_NAME_MISSING', 'Give the profile a name.')
      assertUsableFolder(cwd)
      const profiles = readAll()
      if (profiles.length >= MAX_PROFILES) {
        throw refusal('PROFILE_LIMIT', `This computer holds ${MAX_PROFILES} profiles already. Remove one to add another.`)
      }
      if (profiles.some(entry => entry.name.toLowerCase() === cleanName.toLowerCase())) {
        throw refusal('PROFILE_NAME_TAKEN', 'A profile with that name already exists.')
      }
      const profile = { id: `profile-${randomUUID()}`, name: cleanName, cwd, createdAt: new Date().toISOString() }
      writeAll([...profiles, profile])
      return { id: profile.id, name: profile.name, cwd: profile.cwd }
    },

    remove(id) {
      const profiles = readAll()
      const next = profiles.filter(entry => entry.id !== id)
      if (next.length === profiles.length) return false
      writeAll(next)
      return true
    },

    /* The start path's resolver: id in, validated folder out. Refuses an
       unknown id and a folder that vanished since it was picked — a stale
       profile must fail the START loudly, not spawn an agent somewhere the
       person did not choose. */
    resolveCwd(id) {
      const entry = readAll().find(profile => profile.id === id)
      if (!entry) throw refusal('PROFILE_UNKNOWN', 'That session profile is not on this computer.')
      assertUsableFolder(entry.cwd)
      return entry.cwd
    },
  }
}

module.exports = { createSessionProfileStore, MAX_PROFILES, MAX_NAME_LENGTH }
