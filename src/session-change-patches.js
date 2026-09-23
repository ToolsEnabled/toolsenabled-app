// File contents come from structured change events, never from chat prose.
export const CHANGE_LIMITS = Object.freeze({ files: 100, events: 200, patchChars: 131072, totalPatchChars: 1048576, previewLines: 2000 })

// Codex supplies patches on item/started, then the actual outcome on
// item/completed. An attempted edit is not a session change until that result.
/* THE ORIGINAL, READ OFF DISK AT THE MOMENT THE EDIT IS ANNOUNCED.
 *
 * Every other route to a left pane is a RECONSTRUCTION, and each one can
 * refuse: a unified patch the Claude stream never sends, or an old_string
 * anchor that replace_all / an empty new_string / a moved-on file all make
 * unusable. A Write refuses ALWAYS -- it never sends the previous contents --
 * so for the commonest edit in a Claude session there was nothing to rebuild
 * from and the left pane stayed empty. Measured 2026-09-17: one file, every
 * file, every session.
 *
 * A recorded fact cannot refuse. The tool_use event arrives BEFORE the CLI
 * performs the write, so reading the file then is reading the file as it was.
 *
 * ONLY THE FIRST EDIT TO A PATH IS RECORDED. The second edit's "before" is the
 * first edit's "after", and presenting that as the session's original would
 * show a version the person never had.
 *
 * THE READ IS NOT TRUSTED BLIND. Our read and the CLI's write are two
 * processes racing, and a read that lost the race returns the file as it is
 * AFTER the edit -- the exact wrong original this window must never show. The
 * file's modification stamp travels with the text so the point of use can tell
 * the two apart: a stamp that has moved since the capture proves the write
 * landed after the read. See loadChange() in src/diff-editor.js. */
export function boundedChangeOriginals(records, files, maxRecords = CHANGE_LIMITS.files) {
  if (!Array.isArray(records)) return []
  const paths = new Set(files.map(file => file.path))
  const result = []
  let remaining = CHANGE_LIMITS.totalPatchChars
  for (const record of records.slice(0, maxRecords)) {
    if (!record || !paths.has(record.path) || typeof record.text !== 'string') continue
    if (record.text.length > remaining) continue
    result.push({
      path: record.path,
      text: record.text,
      modifiedMs: Number.isFinite(record.modifiedMs) ? record.modifiedMs : null,
      existed: record.existed === true,
    })
    remaining -= record.text.length
  }
  return result
}

/**
 * @param captureOriginal - reads a path as it stands right now, resolving to
 *   {ok, text, modifiedMs, exists}. Absent means no capture, which leaves every
 *   existing reconstruction route exactly as it was.
 */
export function createConfirmedFileChangeBuffer({ captureOriginal = null } = {}) {
  const pending = new Map()
  /* sessionId + path -> {path, text, modifiedMs, existed}, first capture only.
     Held until the session ends, because the person opens the compare window
     long after the edit that filled this. */
  const originals = new Map()
  const capturing = new Map()
  const originalKey = (sessionId, path) => JSON.stringify([sessionId, path])
  const captureOnce = (sessionId, path) => {
    const key = originalKey(sessionId, path)
    if (originals.has(key) || capturing.has(key)) return capturing.get(key) || Promise.resolve()
    if (typeof captureOriginal !== 'function') return Promise.resolve()
    /* Claimed BEFORE the await, so a second edit to this path in the same tick
       cannot start a second read and overwrite the first edit's original. */
    const run = (async () => {
      let result = null
      try { result = await captureOriginal(path) } catch { result = null }
      if (result && result.ok === true && typeof result.text === 'string'
          && result.text.length <= CHANGE_LIMITS.totalPatchChars) {
        originals.set(key, {
          path,
          text: result.text,
          modifiedMs: Number.isFinite(result.modifiedMs) ? result.modifiedMs : null,
          existed: result.exists !== false,
        })
      }
      capturing.delete(key)
    })()
    capturing.set(key, run)
    return run
  }
  const capturedFor = (sessionId, paths) => paths
    .map(path => originals.get(originalKey(sessionId, path)))
    .filter(entry => entry !== undefined)
  const forgetSession = sessionId => {
    for (const key of [...originals.keys()]) {
      if (!sessionId || JSON.parse(key)[0] === sessionId) originals.delete(key)
    }
  }
  const clear = sessionId => {
    for (const [key, value] of pending) if (!sessionId || value.sessionId === sessionId) pending.delete(key)
    forgetSession(sessionId)
  }
  return {
    clear,
    add(packet, activity) {
      const sessionId = packet?.sessionId
      const event = packet?.event
      if (typeof sessionId !== 'string' || !sessionId || !event) return null
      if (event.type === 'session_ended' || event.type === 'turn_completed') {
        for (const [key, value] of pending) {
          if (value.sessionId === sessionId && (event.type === 'session_ended'
              || !event.turnId || value.turnId === event.turnId)) pending.delete(key)
        }
        /* A finished turn keeps its originals: the compare window is opened
           after the turn, not during it. Only a finished SESSION forgets. */
        if (event.type === 'session_ended') forgetSession(sessionId)
        return null
      }
      if (!activity?.toolCallId) return null
      const turnId = typeof event.turnId === 'string' ? event.turnId : ''
      const key = JSON.stringify([sessionId, turnId, activity.toolCallId])
      if (activity.kind === 'call') {
        if (!['fileChange', 'Write', 'Edit'].includes(activity.tool)) return null
        if (!Array.isArray(activity.fileChanges) || !activity.fileChanges.length) return null
        /* THE READ STARTS HERE, on the announcement, not on the result. By the
           time the result arrives the file has already been overwritten. Only
           the tools that cannot supply their own before-text are captured;
           Codex's fileChange carries a real unified patch and reverses exactly,
           and re-reading disk for it would buy nothing. */
        const captures = ['Write', 'Edit'].includes(activity.tool)
          ? activity.fileChanges.map(file => captureOnce(sessionId, file.path))
          : []
        pending.set(key, { sessionId, turnId, captures, activity: {
          ...activity,
          fileChanges: activity.fileChanges.map(file => ({ ...file })),
          filePatches: boundedChangePatches(activity.filePatches, activity.fileChanges),
          fileEdits: boundedChangeEdits(activity.fileEdits, activity.fileChanges),
        } })
        while (pending.size > CHANGE_LIMITS.events) pending.delete(pending.keys().next().value)
        let remaining = CHANGE_LIMITS.totalPatchChars
        for (const value of [...pending.values()].reverse()) {
          value.activity.filePatches = value.activity.filePatches.filter(patch => {
            if (patch.diff.length > remaining) return false
            remaining -= patch.diff.length
            return true
          })
        }
        return null
      }
      if (activity.kind !== 'result') return null
      const held = pending.get(key)
      pending.delete(key)
      // Claude's result omits the tool name. Only a retained Write/Edit call
      // with this exact session/turn/id may supply it; a conflicting name fails.
      if (!held || (activity.tool && activity.tool !== held.activity.tool)
          || (held.activity.tool === 'fileChange' && activity.tool !== 'fileChange')) return null
      // Only explicit provider success is evidence. Missing, declined, failed,
      // cancelled, and conflicting result fields cannot publish a change.
      const successful = ['completed', 'success', 'ok']
      const rawStatuses = [event.status, event.payload?.status]
        .filter(status => status !== undefined && status !== null && status !== '')
      if (!successful.includes(activity.status)
          || rawStatuses.some(status => !successful.includes(status))
          || (Number.isFinite(activity.exitCode) && activity.exitCode !== 0)
          || event.payload?.success === false || event.payload?.error) return null
    /* `fileOriginals` is what had been read by now; `originalsReady` settles
       when every read for this change has landed. The caller awaits it before
       publishing, so a change never reaches the compare window claiming there
       is no original merely because its read was still in flight. */
      const paths = held.activity.fileChanges.map(file => file.path)
      return {
        ...held.activity,
        changeId: key,
        fileOriginals: boundedChangeOriginals(capturedFor(sessionId, paths), held.activity.fileChanges),
        originalsReady: Promise.all(held.captures || []).then(
          () => boundedChangeOriginals(capturedFor(sessionId, paths), held.activity.fileChanges)),
      }
    },
  }
}

// Claude's CLI reports the target and successful outcome, but its stream does
// not supply whole-file before contents or measured line deltas. Substring
// replacement inputs cannot establish those figures (especially replace_all).
// Null counts and C = Changed retain that uncertainty through every surface.
export function unmeasuredFileChange(tool, payload) {
  if (!['Write', 'Edit'].includes(tool) || !payload || typeof payload !== 'object') return null
  const filePath = payload.file_path
  if (typeof filePath !== 'string' || filePath.length > 4096 || filePath.includes('\0')
      || !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(filePath)) return null
  if (tool === 'Write' && typeof payload.content !== 'string') return null
  if (tool === 'Edit' && (typeof payload.old_string !== 'string' || typeof payload.new_string !== 'string'
      || payload.old_string === payload.new_string)) return null
  return { path: filePath, status: 'C', added: null, removed: null }
}

/* THE EDIT'S OWN BEFORE/AFTER TEXT, CARRIED BESIDE THE CHANGE, NEVER ON IT.
 *
 * Two contracts meet here and both are load-bearing. A file change record is
 * exactly {path, status, added, removed} and suites deep-compare it, so this
 * cannot become a fifth field. And filePatches is for real unified diffs --
 * "substring inputs never become fabricated whole-file patches" -- so a
 * synthesized @@ hunk cannot go there either, and would be a lie about line
 * numbers this module has no way to know. A third, clearly-named channel keeps
 * both promises: it says what the text was, never where it sat. */
export function unmeasuredEditText(tool, payload, path) {
  if (tool !== 'Edit' || !payload || typeof path !== 'string') return null
  const { old_string: oldString, new_string: newString } = payload
  if (typeof oldString !== 'string' || typeof newString !== 'string') return null
  // Oversized anchors are dropped whole, never truncated: half an anchor would
  // match the wrong place and reconstruct a file that never existed.
  if (oldString.length > CHANGE_LIMITS.patchChars || newString.length > CHANGE_LIMITS.patchChars) return null
  return { path, oldString, newString, replaceAll: payload.replace_all === true }
}

export function boundedChangeEdits(records, files, maxRecords = CHANGE_LIMITS.files) {
  if (!Array.isArray(records)) return []
  const paths = new Set(files.map(file => file.path))
  const result = []
  let remaining = CHANGE_LIMITS.totalPatchChars
  for (const record of records.slice(0, maxRecords)) {
    if (!record || !paths.has(record.path)) continue
    const size = record.oldString.length + record.newString.length
    if (size > remaining) continue
    result.push({ path: record.path, oldString: record.oldString, newString: record.newString, replaceAll: record.replaceAll === true })
    remaining -= size
  }
  return result
}

export function parseUnifiedPatch(diff) {
  if (typeof diff !== 'string' || diff.length > CHANGE_LIMITS.patchChars) return null
  const hunks = []
  let hunk = null
  for (const line of diff.replace(/\r\n/g, '\n').split('\n')) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (header) {
      hunk = { oldStart: +header[1], oldCount: +(header[2] ?? 1), newStart: +header[3], newCount: +(header[4] ?? 1), lines: [] }
      hunks.push(hunk)
    } else if (hunk && /^[ +\-]/.test(line)) {
      hunk.lines.push({ kind: line[0], text: `${line.slice(1)}\n` })
    } else if (hunk && line === '\\ No newline at end of file') {
      const previous = hunk.lines.at(-1)
      if (!previous) return null
      previous.text = previous.text.replace(/\n$/, '')
    } else if (hunk && line !== '') return null
  }
  if (!hunks.length) return null
  for (const entry of hunks) {
    if (entry.lines.filter(line => line.kind !== '+').length !== entry.oldCount
      || entry.lines.filter(line => line.kind !== '-').length !== entry.newCount) return null
  }
  return hunks
}

export function patchCounts(diff) {
  const hunks = parseUnifiedPatch(diff)
  if (!hunks) return null
  let added = 0, removed = 0
  for (const hunk of hunks) for (const line of hunk.lines) {
    if (line.kind === '+') added++
    if (line.kind === '-') removed++
  }
  return { added, removed }
}

// A reverse patch is used only when every changed/context line matches disk.
// If the file moved on, the editor can still edit disk and show the recorded
// patch, but must not invent an original file.
export function reverseSessionPatches(currentText, patches) {
  if (!Array.isArray(patches) || !patches.length) return null
  let text = currentText.replace(/\r\n/g, '\n')
  for (const patch of [...patches].reverse()) {
    const hunks = parseUnifiedPatch(patch.diff)
    if (!hunks) return null
    const source = text.match(/[^\n]*\n|[^\n]+$/g) || []
    const output = []
    let cursor = 0
    for (const hunk of hunks) {
      const start = hunk.newCount === 0 ? hunk.newStart : hunk.newStart - 1
      if (start < cursor || start > source.length) return null
      output.push(...source.slice(cursor, start))
      const before = hunk.lines.filter(line => line.kind !== '+').map(line => line.text)
      const after = hunk.lines.filter(line => line.kind !== '-').map(line => line.text)
      if (source.slice(start, start + after.length).join('') !== after.join('')) return null
      output.push(...before)
      cursor = start + after.length
    }
    output.push(...source.slice(cursor))
    text = output.join('')
    if (text.length > CHANGE_LIMITS.totalPatchChars) return null
  }
  return text
}

/* A CLAUDE Edit ALREADY CARRIES ITS OWN BEFORE AND AFTER TEXT.
 *
 * unmeasuredFileChange() above is right that old_string/new_string cannot
 * establish LINE COUNTS -- that is why added/removed stay null and the status
 * stays C. Rebuilding the original TEXT is a different question, and the answer
 * is yes whenever the after-text can still be found in exactly one place: put
 * old_string back where new_string is and the result is the file as it was,
 * character for character, not an approximation of it.
 *
 * MEASURED, 2026-09-17: with no reconstruction the Compare window showed ONE
 * file for every Claude-driven edit -- every file, every session -- because the
 * only path to an original ran through a unified patch the Claude stream never
 * sends. The left pane said "No original file is open yet."
 *
 * THE REFUSALS ARE THE POINT, and each one is a case where a reconstruction
 * would be a GUESS. Never relax one to widen the green path:
 *   - replace_all: the reverse cannot know which matches the original already
 *     had, so putting old_string in all of them invents a file.
 *   - an empty new_string: a deletion leaves no anchor, and an empty needle
 *     "matches" at every index.
 *   - no occurrence: the file moved on after the edit; its original is gone.
 *   - two or more occurrences: the right one is unknowable, and picking the
 *     first is exactly the wrong original this window must never show.
 * Edits reverse newest-first; one refusal anywhere in the chain refuses the
 * whole reconstruction, because a partly-reversed file is not a version that
 * ever existed. */
export function reverseSubstringEdits(currentText, edits) {
  if (typeof currentText !== 'string' || !Array.isArray(edits) || !edits.length) return null
  if (edits.length > CHANGE_LIMITS.events) return null
  let text = currentText.replace(/\r\n/g, '\n')
  for (const edit of [...edits].reverse()) {
    if (!edit || typeof edit.oldString !== 'string' || typeof edit.newString !== 'string') return null
    if (edit.replaceAll === true) return null
    const oldString = edit.oldString.replace(/\r\n/g, '\n')
    const newString = edit.newString.replace(/\r\n/g, '\n')
    if (newString === '' || newString === oldString) return null
    const first = text.indexOf(newString)
    if (first < 0 || text.indexOf(newString, first + newString.length) !== -1) return null
    text = text.slice(0, first) + oldString + text.slice(first + newString.length)
    if (text.length > CHANGE_LIMITS.totalPatchChars) return null
  }
  return text
}

export function boundedChangePatches(records, files, maxRecords = CHANGE_LIMITS.files) {
  if (!Array.isArray(records)) return []
  const paths = new Set(files.map(file => file.path))
  const result = []
  let remaining = CHANGE_LIMITS.totalPatchChars
  for (const record of records.slice(0, maxRecords)) {
    if (!record || !paths.has(record.path) || typeof record.diff !== 'string') continue
    if (record.diff.length > CHANGE_LIMITS.patchChars || record.diff.length > remaining) continue
    result.push({ path: record.path, diff: record.diff })
    remaining -= record.diff.length
  }
  return result
}

// Codex emits {path, kind: {type}, diff}; older adapters emit measured counts.
// Keep counts separate so the existing four-field chat protocol stays stable.
export function nativeFileChange(candidate) {
  if (!candidate || typeof candidate !== 'object' || typeof candidate.path !== 'string'
    || !candidate.path.trim() || candidate.path.length > 4096) return null
  const type = typeof candidate.kind === 'string' ? candidate.kind : candidate.kind?.type
  const status = { add: 'A', update: 'M', delete: 'D' }[type]
  // An empty file or a pure move has no changed lines, but is still a file
  // change when the structured provider result confirms it succeeded.
  const counts = candidate.diff === '' ? { added: 0, removed: 0 } : patchCounts(candidate.diff)
  if (!status || !counts) return null
  const movePath = candidate.kind?.move_path ?? candidate.kind?.movePath
  const moved = type === 'update' && typeof movePath === 'string' && movePath.trim() && movePath.length <= 4096
  return { path: moved ? movePath : candidate.path, status: moved ? 'R' : status, ...counts }
}
