'use strict'

/* OPENING A FILE AN AGENT LEFT BEHIND, AND READING A REPORT WITHOUT LEAVING.
 *
 * WHY THIS FILE EXISTS. Measured on this tree before it was written:
 * `shell.openPath` and `shell.showItemInFolder` appear ZERO times in the whole
 * product, and the only hand-off to the operating system anywhere is
 * `shell.openExternal` for one sign-in URL (shell/google-signin.cjs). So an
 * assistant could write a document, a drawing or a report into the person's own
 * folder and the person had no way to open it from the application that put it
 * there. The owner asked for both halves in one sentence: "pdf and files need to
 * be openable both in mobile and in the app", and "they also need to be able to
 * view reports etc that the agent sends".
 *
 * THIS FILE IS THE DESKTOP HALF. Mobile is a different lane.
 *
 * IT NEVER IMPORTS ELECTRON, exactly like shell/agent-command-surface.cjs, and
 * for the same reason: the two calls that reach the operating system arrive
 * through `deps` so they can be driven by a test that opens nothing, and so the
 * refusals below can be proven rather than described.
 *
 * -------------------------------------------------------------------------
 * THE FENCE, WHICH IS THE WHOLE SAFETY DESIGN.
 *
 * `openPath` hands a path to whatever program Windows has registered for that
 * extension, and that program then runs with the person's full rights. So the
 * question "may this path be opened" is not a convenience check; it is the only
 * thing standing between a renderer and an arbitrary local file.
 *
 * IT IS NOT ANSWERED HERE. src/lib/workspace-boundary.js in the payload already
 * answers "is this path inside what the person granted", and it answers it
 * against eight bypasses that a hand-written check gets wrong -- `..`, Windows
 * case folding, 8.3 short names, junctions, UNC and `\\?\` device paths,
 * alternate data streams, prefix collision (`C:\workspace-evil` versus
 * `C:\workspace`), and a target that does not exist yet. A second boundary
 * written in this file would be a second answer to one question, and the first
 * time the two disagreed the weaker one would be the one that admitted
 * something. This repository has a one-path-per-thing rule; that rule applies
 * hardest to fences.
 *
 * IT IS THEREFORE A REQUIREMENT, NOT A PREFERENCE. A copy of the product with
 * no payload cannot judge a path, so it refuses every verb here with a code the
 * screen turns into a sentence, and the screen disables its controls and says
 * why. Nothing degrades to "allowed" -- absence of the fence is absence of the
 * feature. (FENCE_CODES below is that set of codes, exported so the screen
 * cannot hold a hand-typed copy of it and fall behind a new one.)
 *
 * -------------------------------------------------------------------------
 * THE FENCE ANSWERS "WHERE IS THIS FILE". IT DOES NOT ANSWER "WHAT HAPPENS
 * WHEN WINDOWS OPENS IT", AND THAT IS A SECOND QUESTION.
 *
 * A first cut of this file asked only the first one, and it was wrong: driven
 * on the real surface, `open` admitted `.lnk`, `.scr`, `.url`, `.hta`, `.ps1`,
 * `.exe` and `.bat` -- every one of them a file whose registered program is an
 * interpreter, running with the person's full rights. The reachability is what
 * makes that serious, and this panel's own second sentence establishes it:
 * nothing records which files an agent wrote, so all of them are shown. An
 * agent that read a poisoned page writes `cleanup.bat` into the workspace, it
 * is listed beside the person's own files, and one press runs it.
 *
 * WORSE, A SHORTCUT IS OPAQUE TO THE FENCE. `fs.realpathSync.native` does not
 * resolve a `.lnk`, so a shortcut sitting inside the folder is contained by
 * every measurement the boundary can take, while `ShellExecute` follows it to
 * whatever it points at. Proven with a real `WScript.Shell` shortcut whose
 * target was notepad.exe and whose argument was the hosts file: the fence
 * admitted it. No containment check can be made to see through that, so the
 * only safe answer is that the kind is never admitted.
 *
 * SO WHAT MAY BE HANDED OVER IS AN ALLOWLIST, NOT A DENYLIST. A denylist of
 * dangerous extensions fails open on the one nobody thought of, and Windows has
 * a long tail of them. OPENABLE_EXTENSIONS below is the whole list, and adding
 * to it is a decision with a reason, never a default.
 *
 * WHAT REFUSING COSTS, SAID PLAINLY. Nothing is hidden and nothing else is
 * taken away: a file of any kind is still listed, `reveal` still shows it in
 * the file manager -- which selects a file and starts no program -- and a
 * script kind is readable IN THIS WINDOW, which is the only way to see what an
 * agent wrote before deciding to run it. Exactly one control is refused.
 *
 * -------------------------------------------------------------------------
 * WHICH FOLDERS COUNT AS "SOMEWHERE THE PERSON ALREADY CHOSE".
 *
 * Exactly the folders an agent session on this computer can run in, read from
 * the same records the start reads:
 *
 *   chosen   the workspace roots in the machine record -- the folder the
 *            first-run walkthrough asked for. shell/setup-record.cjs owns it.
 *   profile  a folder picked in the native folder dialog when a session
 *            profile was created. shell/session-profiles.cjs owns it, and a
 *            person standing at this keyboard is the only way one is added.
 *   product  <userData>\workspace, where an agent that names no folder runs.
 *            Its name never crosses to the screen (see NO INSTALLATION PATH
 *            CROSSES below); the screen prints its own label for it.
 *
 * Nothing else. A folder that is not one of these has no id, and every verb
 * takes a folder id -- so a caller cannot name a path at all, which is a
 * stronger property than refusing a bad one.
 *
 * -------------------------------------------------------------------------
 * NO INSTALLATION PATH CROSSES, and one kind of path does.
 *
 * shell/setup-record.cjs states the rule this follows: the services root, the
 * install root and the runtime never reach a reply, and the person's own
 * workspace folder does, because a question about which folder your assistant
 * may use cannot be asked without naming it. Same split here. A folder reply
 * carries the person's own folder NAME (its last segment) and never the
 * product's own workspace path; a file reply carries the file's name inside
 * that folder. No reply carries an absolute path.
 *
 * The one exception is `reason`, which is a diagnostic string for this
 * process's log and for a support conversation. It is returned rather than
 * discarded -- an error thrown away is a person told nothing -- and the screen
 * never renders it. src/agent-files-copy.js turns the CODE into the sentence.
 */

const nodeFs = require('node:fs')
const path = require('node:path')

/* The payload module that answers every containment question below. Declared in
   tools/capability-manifest.json under `hostModules`, which is what stages it;
   the copy of the path here is unavoidable (the manifest is a build input and
   this is a runtime read), so the refusal names the manifest rather than
   reporting a bare module-not-found. */
const BOUNDARY_MODULE = 'src/lib/workspace-boundary.js'

/* A file name is a NAME. Separators, drive letters, `.` and `..` are refused
   before the fence ever sees them -- not because the fence would admit them,
   but because a verb whose argument can only be a name has a smaller surface
   than one that refuses bad paths. */
const MAX_NAME_LENGTH = 260
const MAX_FOLDER_ID_LENGTH = 128
const FOLDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/* How many rows the screen is given. A folder with ten thousand files must not
   turn into a ten-thousand-row list nobody can read or a reply nobody can
   send, so the newest are kept and the screen is TOLD it is seeing a slice. */
const MAX_FILES = 200

/* How many files are asked about at once below. Bounded rather than one big
   Promise.all so a folder with tens of thousands of entries cannot open tens of
   thousands of file handles at the same moment. */
const STAT_BATCH = 64

/* What may be shown in the application's own reading pane. The cap is on the
   file, checked before it is read, so an enormous log cannot be pulled into
   this process's memory to find out it was too big. */
const MAX_READ_BYTES = 512 * 1024

/* Notes and reports: text a person writes and reads. */
const TEXT_EXTENSIONS = Object.freeze(['.md', '.txt', '.log', '.json', '.csv', '.yml', '.yaml'])

/* TEXT A COMPUTER RUNS. Shown in the reading pane on purpose, and never handed
   to the operating system: being able to read `cleanup.bat` in this window,
   without running it, is the whole difference between a person who can see what
   an agent wrote and one who can only guess. The list does not have to be
   exhaustive to be safe -- an extension nobody listed here is `other`, and
   `other` is refused by OPENABLE_EXTENSIONS anyway -- so it holds the ones an
   agent on Windows actually writes. */
const SCRIPT_EXTENSIONS = Object.freeze([
  '.bat', '.cmd', '.ps1', '.psm1', '.sh', '.py', '.js', '.mjs', '.cjs',
  '.vbs', '.vbe', '.wsf', '.hta', '.reg', '.url', '.htm', '.html', '.svg', '.xml',
])

const READABLE_EXTENSIONS = Object.freeze(new Set([...TEXT_EXTENSIONS, ...SCRIPT_EXTENSIONS]))

/* THE WHOLE LIST OF WHAT MAY BE HANDED TO THIS COMPUTER, and the reason each
   family is on it. Everything else is refused, including every extension nobody
   has thought of yet, which is the property a denylist cannot have.

     notes and reports  the kinds this window can already show. Their registered
                        programs are viewers and editors, not interpreters.
     .pdf               the owner asked for this one by name: "pdf and files
                        need to be openable both in mobile and in the app".
     pictures           raster only.

   DELIBERATELY ABSENT, so the next reader does not think they were forgotten:
   `.lnk` and `.url`, because a shortcut is opaque to the fence (see the header);
   `.svg`, `.htm` and `.html`, because markup can carry script and Windows opens
   it in a browser; `.docx`, `.xlsx` and the rest of the office kinds, because
   their handlers fetch remote templates and run macros, so admitting them is a
   decision with a measurement behind it rather than a convenience. Show in
   folder still reaches every one of them. */
const OPENABLE_EXTENSIONS = Object.freeze(new Set([
  ...TEXT_EXTENSIONS,
  '.pdf',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp',
]))

/* The refusals that mean THE FENCE ITSELF IS NOT HERE, as opposed to a fence
   that answered no. The screen turns these three into one sentence and switches
   its controls off, because no press can succeed until this copy of the program
   is put back. Exported so that screen cannot hold a hand-typed copy of the list
   and fall behind a fourth one. */
const FENCE_CODES = Object.freeze(['FILES_PAYLOAD_ABSENT', 'FILES_FENCE_ABSENT', 'FILES_FENCE_UNRECOGNIZED'])

/* A report is a markdown file whose name says so. Both shapes this product's
   own agents actually write are covered -- `REPORT-<subject>.md` and
   `<lane>-REPORT.md` -- and so is the name the audited report form already
   defaults to, `P5-REPORT.md` (src/write-surfaces.js). */
const REPORT_NAME_RE = /report/i

function failure(code, reason) {
  return { ok: false, code, reason }
}

function boundedName(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_NAME_LENGTH) return null
  if (value.includes('\u0000')) return null
  if (value !== path.basename(value)) return null
  if (value === '.' || value === '..') return null
  /* path.basename() leaves a Windows drive-relative name such as `C:file`
     alone, and it leaves a stream name alone too. Neither is a file in a
     folder, so neither is a name this surface accepts. */
  if (/[\\/:]/.test(value)) return null
  return value
}

/* When a file last changed, or an empty string when this computer will not say.
   Never throws: see the note at its call site. */
function stampOf(milliseconds) {
  const at = new Date(milliseconds)
  return Number.isNaN(at.getTime()) ? '' : at.toISOString()
}

function extensionOf(name) {
  return path.extname(typeof name === 'string' ? name : '').toLowerCase()
}

function fileKind(name) {
  const extension = extensionOf(name)
  if (extension === '.md' && REPORT_NAME_RE.test(name)) return 'report'
  if (SCRIPT_EXTENSIONS.includes(extension)) return 'script'
  if (READABLE_EXTENSIONS.has(extension)) return 'text'
  return 'other'
}

/**
 * May this file be handed to the operating system?
 *
 * ON THE EXTENSION AND NOTHING ELSE, because the extension is the only thing
 * `ShellExecute` consults when it decides which program to start. Not on the
 * file's contents, which would answer a question nobody asked; not on a
 * denylist, which fails open. `path.extname` takes the LAST extension, so
 * `Report.md.lnk` is a `.lnk`.
 */
function canOpen(name) {
  return OPENABLE_EXTENSIONS.has(extensionOf(name))
}

/**
 * The fence, loaded from the payload.
 *
 * Fails closed on every unknown: no payload, no module, a module that does not
 * export the contract. The caller turns each into a stated refusal; none of
 * them becomes an open.
 */
function loadBoundary({ resolveCapabilityRoot, requireModule }) {
  let root = null
  try { root = resolveCapabilityRoot() } catch { root = null }
  if (!root) {
    return failure('FILES_PAYLOAD_ABSENT',
      'No capability payload is present, so this copy cannot judge whether a file is inside a folder you chose.')
  }
  let boundary
  try {
    boundary = requireModule(path.join(root, ...BOUNDARY_MODULE.split('/')))
  } catch (error) {
    return failure('FILES_FENCE_ABSENT',
      `The capability payload does not carry ${BOUNDARY_MODULE} (${error.message}). It is staged by tools/capability-manifest.json under hostModules.`)
  }
  if (typeof boundary?.assertInsideRoots !== 'function'
    || typeof boundary.resolveRoots !== 'function'
    || typeof boundary.realResolve !== 'function') {
    return failure('FILES_FENCE_UNRECOGNIZED',
      'The capability payload carries a workspace boundary this shell does not recognize.')
  }
  return { ok: true, boundary }
}

function createAgentFileSurface(deps = {}) {
  const {
    fs = nodeFs,
    resolveCapabilityRoot,
    requireModule,
    readWorkspaceState,
    listSessionProfiles,
    productWorkspaceRoot = null,
    openPath,
    showItemInFolder,
    log = () => {},
  } = deps

  for (const [name, value] of Object.entries({
    resolveCapabilityRoot, requireModule, readWorkspaceState, listSessionProfiles, openPath, showItemInFolder,
  })) {
    /* CONSTRUCTION FAILS CLOSED, the rule shell/agent-command-surface.cjs sets:
       a dependency that is absent must refuse the surface here, never a verb
       later, because a verb that fails later has already been offered. */
    if (typeof value !== 'function') throw new TypeError(`agent file surface requires ${name}`)
  }
  /* THE SAME RULE FOR THE FILE SYSTEM ITSELF. The listing reads through
     `fs.promises` so it does not block the main process, and a file system
     handed in without it would throw inside a verb -- which crosses the channel
     as an error rather than as a refusal anybody can read. */
  if (typeof fs?.promises?.readdir !== 'function' || typeof fs.promises.stat !== 'function') {
    throw new TypeError('agent file surface requires fs.promises')
  }

  /* THE ONE PLACE THE FOLDER LIST IS BUILT. Both the screen's list and every
     verb's "which folder is this id" resolve from this same call, because two
     builders is how a folder comes to be listed and then refused, or refused
     and then opened. Never throws: a record that cannot be read contributes no
     folders, and the screen renders the honest short list. */
  function discover() {
    const found = []
    const seen = new Set()
    const add = (entry) => {
      const resolved = path.resolve(entry.root)
      const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved
      if (seen.has(key)) return
      seen.add(key)
      found.push(entry)
    }

    let state = null
    try { state = readWorkspaceState() } catch { state = null }
    const roots = Array.isArray(state?.roots) ? state.roots : []
    roots.forEach((root, index) => {
      if (typeof root !== 'string' || root.trim() === '') return
      /* `|| null`, NEVER `|| root`. A workspace root of `C:\` has no last
         segment, and falling back to the root itself would put an absolute path
         on the screen through the one field this reply is allowed to carry --
         breaking the rule stated at the top of this file in the exact case
         nobody writes a test for. A folder with no name is a folder the screen
         names itself, the same way it names the product's own workspace. */
      add({ id: `chosen-${index}`, kind: 'chosen', name: path.basename(root) || null, root })
    })

    let profiles = []
    try { profiles = listSessionProfiles() } catch { profiles = [] }
    for (const profile of Array.isArray(profiles) ? profiles : []) {
      if (!profile || typeof profile.id !== 'string' || typeof profile.cwd !== 'string') continue
      if (!FOLDER_ID_RE.test(profile.id) || profile.id.length > MAX_FOLDER_ID_LENGTH) continue
      if (profile.cwd.trim() === '') continue
      /* Same fallback rule as the chosen roots above, and for the same reason:
         a profile whose folder is a drive root has no last segment, and the
         path is not what stands in for one. */
      const label = typeof profile.name === 'string' && profile.name.trim() !== ''
        ? profile.name
        : path.basename(profile.cwd) || null
      add({ id: profile.id, kind: 'profile', name: label, root: profile.cwd })
    }

    if (typeof productWorkspaceRoot === 'string' && productWorkspaceRoot.trim() !== '') {
      /* `name: null` IS THE RULE, not an omission. This one is an installation
         path, so the screen prints its own label for it and no reply ever
         carries where it is. */
      add({ id: 'product', kind: 'product', name: null, root: productWorkspaceRoot })
    }

    return found
  }

  function folders() {
    return {
      ok: true,
      folders: discover().map(entry => Object.freeze({ id: entry.id, kind: entry.kind, name: entry.name })),
    }
  }

  function rootFor(folderId) {
    if (typeof folderId !== 'string' || !FOLDER_ID_RE.test(folderId) || folderId.length > MAX_FOLDER_ID_LENGTH) {
      return failure('FILES_FOLDER_UNKNOWN', 'The folder asked for is not one this computer has.')
    }
    const entry = discover().find(candidate => candidate.id === folderId)
    if (!entry) return failure('FILES_FOLDER_UNKNOWN', 'The folder asked for is not one this computer has.')
    return { ok: true, root: entry.root }
  }

  /**
   * Resolve a folder id and a file name into a path this surface is willing to
   * act on, or a refusal.
   *
   * THE ORDER IS THE DESIGN. The name is checked first (cheapest, and it closes
   * the whole separator shape), then the folder is resolved, then the FENCE
   * runs against the payload's boundary with the folder as the only root, and
   * only then does anything touch the file. A candidate that never reaches the
   * last step never reaches the operating system.
   */
  function locate(folderId, name, { needFile = true } = {}) {
    const safeName = boundedName(name)
    if (!safeName) {
      return failure('FILES_NAME_REFUSED', 'That is not a file name inside a folder, so nothing was opened.')
    }
    const folder = rootFor(folderId)
    if (!folder.ok) return folder

    const fence = loadBoundary({ resolveCapabilityRoot, requireModule })
    if (!fence.ok) return fence

    const candidate = path.join(folder.root, safeName)
    try {
      fence.boundary.assertInsideRoots(candidate, [folder.root], { label: safeName, tool: 'this window' })
    } catch (error) {
      /* The payload's own refusal sentence names the argument and the tool and
         deliberately carries no resolved path -- but it is still written for
         whoever holds the repository, so it travels as `reason` and the screen
         says its own sentence. A refusal of ANY kind here is a refusal: an
         unreadable root, a missing root, a junction leading out, a name that
         resolves outside. None of them is an open. */
      return failure('FILES_OUTSIDE_FOLDER', error?.message || 'The file is not inside the folder it was asked for.')
    }

    if (!needFile) return { ok: true, path: candidate, name: safeName }
    let stats
    try {
      stats = fs.statSync(candidate)
    } catch (error) {
      return failure('FILES_NOT_THERE', `The file could not be found in that folder (${error?.code || 'unreadable'}).`)
    }
    if (!stats.isFile()) {
      return failure('FILES_NOT_A_FILE', 'That name is a folder on this computer, not a file.')
    }
    return { ok: true, path: candidate, name: safeName, bytes: stats.size }
  }

  return Object.freeze({
    folders,

    /**
     * What is in one of those folders, newest first.
     *
     * NAMES ONLY. No path leaves this function, and neither does a folder's
     * contents beyond its own top level: a listing that walked into
     * sub-folders would be describing a tree the person did not ask about, and
     * the screen has one list.
     */
    async list(request = {}) {
      const folder = rootFor(request.folderId)
      if (!folder.ok) return folder
      /* THE FENCE RUNS ON A LISTING TOO, and what it catches here is a RECORDED
         ROOT that cannot be trusted: one that is not an absolute path, one that
         is not on this computer, one that is a file rather than a folder, one
         that names a share or a stream. `readdirSync` catches some of those and
         not the others -- a relative root it happily reads against whatever
         directory this process is sitting in -- so this is not a duplicate of
         the read below.
         WHAT IT DOES NOT CATCH, stated because the comment here used to claim
         it did: a root that IS a junction is resolved to its target and
         admitted, by resolveRoots and by assertInsideRoots alike. A junction
         the person chose as their workspace is a folder they chose. */
      const fence = loadBoundary({ resolveCapabilityRoot, requireModule })
      if (!fence.ok) return fence
      try {
        fence.boundary.resolveRoots([folder.root])
      } catch (error) {
        return failure('FILES_FOLDER_UNREADABLE', error?.message || 'That folder could not be read.')
      }

      /* THE WORK IS OFF THE MAIN THREAD, and that is not tidiness either. This
         runs in the Electron main process, where a synchronous stat per entry
         blocks every window, every channel and every timer until the last one
         comes back. MEASURED on 20,000 real files on a local SSD: the same walk
         with readdirSync and statSync took 760 ms, all of it blocked; this one
         takes about 360 ms and the longest single moment nothing else in the
         process could run is 25 ms.
         AND THE CAP BELOW DOES NOT HELP WITH THIS, which is why it is not the
         answer to it: it bounds the REPLY, and the newest 200 files cannot be
         known without asking about all of them. */
      let entries
      try {
        entries = await fs.promises.readdir(folder.root, { withFileTypes: true })
      } catch (error) {
        return failure('FILES_FOLDER_UNREADABLE', `That folder could not be read (${error?.code || 'unknown'}).`)
      }

      const names = []
      for (const entry of entries) {
        if (!entry.isFile()) continue
        /* A name from readdir is normally a name. It is filtered anyway,
           because a long-path name on NTFS is not one this surface will accept
           later, and a row a person can press that every verb then refuses is
           worse than a row that was never drawn. */
        const name = boundedName(entry.name)
        if (name) names.push(name)
      }

      const files = []
      for (let start = 0; start < names.length; start += STAT_BATCH) {
        const batch = await Promise.all(names.slice(start, start + STAT_BATCH).map(async (name) => {
          /* A STAT THAT FAILED IS NOT A FILE THAT IS NOT THERE, and this used
             to drop the row -- the same mistake the date rule below is written
             to prevent, made one measurement earlier. readdir has ALREADY said
             this name is a file in this folder; a stat can still fail after it
             for reasons that say nothing about existence: EBUSY or EACCES on a
             file another process holds open (a log the running agent is
             writing is the ordinary case), a network share that answers late,
             or ENOENT for a file deleted in the microseconds between the two
             calls. Returning null for all of those took the row out of the
             listing AND out of `total`, so the panel stated a count that
             disagreed with the folder the person can see in Explorer, and the
             file they came to open was simply absent with nothing said.
             The failure is carried instead, so the row survives and only what
             the stat would have told us is missing. */
          try { return { name, stats: await fs.promises.stat(path.join(folder.root, name)), unmeasured: null } }
          catch (error) { return { name, stats: null, unmeasured: error?.code || 'unknown' } }
        }))
        for (const found of batch) {
          if (!found) continue
          if (found.unmeasured) log(`file details unreadable: ${found.name} (${found.unmeasured})`)
          /* A TIME THIS COMPUTER CANNOT STATE IS NOT A ROW THAT DISAPPEARS.
             `new Date(NaN).toISOString()` THROWS, and a throw in here is not a
             refusal a person can read -- it is a rejected promise crossing the
             channel as an error. Some network shares really do hand back a
             timestamp out of range, so the file keeps its row and loses only
             its date. The screen already drops a date it cannot parse. */
          const stamp = found.stats ? stampOf(found.stats.mtimeMs) : ''
          const kind = fileKind(found.name)
          files.push({
            name: found.name,
            /* Null, not zero. `formatBytes` is reached only for a finite
               number (src/agent-files-copy.js), so an unmeasured size prints
               nothing at all rather than the false statement "0 bytes". */
            bytes: found.stats ? found.stats.size : null,
            changedAt: stamp,
            kind,
            /* Whether THIS window can show it, decided here where the cap and
               the extension list live, so the screen does not have to hold a
               second copy of the rule to know which control to disable. read()
               below applies the same two tests to the same file.
               NO STAT MEANS NOT READABLE, and that is the same guarantee, not
               a weaker one: the cap is a test on a measured size, and a size
               nobody measured cannot pass it. read() re-applies both tests to
               the file itself, so a row offered here is never the authority. */
            readable: Boolean(found.stats) && READABLE_EXTENSIONS.has(extensionOf(found.name))
              && found.stats.size <= MAX_READ_BYTES,
            /* And whether it may be handed to the operating system, from the
               same one list open() refuses by. A row whose Open cannot succeed
               is drawn disabled with the reason beside it, never offered.
               This one asks the extension and nothing else -- see canOpen --
               so a missing stat changes nothing about it, and open() states
               its own refusal if the file really has gone. */
            openable: canOpen(found.name),
          })
        }
      }
      files.sort((a, b) => (a.changedAt < b.changedAt ? 1 : a.changedAt > b.changedAt ? -1 : (a.name < b.name ? -1 : 1)))
      const truncated = files.length > MAX_FILES
      return {
        ok: true,
        folderId: request.folderId,
        total: files.length,
        truncated,
        files: files.slice(0, MAX_FILES).map(file => Object.freeze(file)),
      }
    },

    /**
     * Hand the file to whatever program this computer opens that kind with.
     *
     * `shell.openPath` RESOLVES WITH AN ERROR STRING rather than throwing, and
     * an empty string is the success. That is the whole reason this is not a
     * fire-and-forget: a person who presses Open and gets silence cannot tell
     * "it opened behind the window" from "nothing on this computer can open
     * it". The string is kept and returned as `reason`; the screen says its own
     * sentence and the string reaches the log.
     */
    async open(request = {}) {
      const target = locate(request.folderId, request.name)
      if (!target.ok) return target
      /* THE SECOND QUESTION, ASKED HERE AND NOWHERE ELSE. The fence above has
         established WHERE this file is; this establishes what starting it would
         mean. Both must pass, and a kind that is not on the list is refused
         even though the file is exactly where the person put it. list() puts
         the same answer on the row as `openable`, so the screen disables that
         one control instead of offering a press that cannot be allowed. */
      if (!canOpen(target.name)) {
        return failure('FILES_NOT_OPENABLE',
          `${extensionOf(target.name) || 'a file with no extension'} is not a kind this window hands to the operating system.`)
      }
      let message
      try {
        message = await openPath(target.path)
      } catch (error) {
        /* Documented to resolve rather than throw -- but a throw here must not
           become an unhandled rejection in the main process. */
        return failure('FILES_OPEN_FAILED', error?.message || 'The file could not be handed to this computer.')
      }
      if (typeof message === 'string' && message !== '') {
        log(`open refused by the operating system: ${message}`)
        return failure('FILES_NO_PROGRAM', message)
      }
      return { ok: true, name: target.name }
    },

    /**
     * Show the file where it lives, selected, in the computer's file manager.
     *
     * `shell.showItemInFolder` RETURNS NOTHING AND REPORTS NOTHING, so the only
     * honest way to answer "did that work" is to establish the file is there
     * before asking -- which locate() already does. After the call this replies
     * ok because the request was made, and that is the strongest true claim
     * available.
     */
    reveal(request = {}) {
      const target = locate(request.folderId, request.name)
      if (!target.ok) return target
      try {
        showItemInFolder(target.path)
      } catch (error) {
        return failure('FILES_REVEAL_FAILED', error?.message || 'The folder could not be shown.')
      }
      return { ok: true, name: target.name }
    },

    /**
     * The words in the file, for the reading pane.
     *
     * THE SIZE IS CHECKED BEFORE THE READ, from the stat locate() already took,
     * so an enormous file is refused rather than pulled into this process to
     * discover it was enormous. A NUL byte means this is not text, and a
     * reading pane full of replacement characters is worse than being told
     * plainly to open it with the program that understands it.
     */
    read(request = {}) {
      const target = locate(request.folderId, request.name)
      if (!target.ok) return target
      const extension = path.extname(target.name).toLowerCase()
      if (!READABLE_EXTENSIONS.has(extension)) {
        return failure('FILES_NOT_TEXT', 'This window shows written notes and reports; this file is another kind.')
      }
      if (target.bytes > MAX_READ_BYTES) {
        return failure('FILES_TOO_BIG', `The file is ${target.bytes} bytes and this window shows up to ${MAX_READ_BYTES}.`)
      }
      let text
      try {
        text = fs.readFileSync(target.path, 'utf8')
      } catch (error) {
        return failure('FILES_READ_FAILED', `The file could not be read (${error?.code || 'unknown'}).`)
      }
      if (text.includes('\u0000')) {
        return failure('FILES_NOT_TEXT', 'This window shows written notes and reports; this file is another kind.')
      }
      return { ok: true, name: target.name, kind: fileKind(target.name), text }
    },
  })
}

module.exports = {
  createAgentFileSurface,
  BOUNDARY_MODULE,
  FENCE_CODES,
  MAX_FILES,
  MAX_NAME_LENGTH,
  MAX_READ_BYTES,
  OPENABLE_EXTENSIONS,
  READABLE_EXTENSIONS,
  REPORT_NAME_RE,
  SCRIPT_EXTENSIONS,
  TEXT_EXTENSIONS,
  boundedName,
  canOpen,
  fileKind,
}
