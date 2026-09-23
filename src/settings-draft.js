// Pending settings are private to one Settings visit. Failed writes stay
// pending; successful writes are removed so retry does not repeat them.
import { auditReceiptDisposition } from './mission-bridge.js'

/* WHAT A SAVED SETTING'S RECORD ANSWER ESTABLISHES (T782; M10's receipt
   contract, read through the one classifier every consumer shares). The host
   records each saved setting as action 'settings.set' on that setting's id.
   With auditing off (Basic) it answers the exact not-required object --
   { ok: true, disposition: 'not-required', required: false, recorded: false,
   durable: false, anchored: false, signed: false, sequence: null,
   eventId: null, eventHash: null, action, target } and nothing else; with
   auditing on it answers { ok: true, sequence, eventHash }. Anything else is
   NOT quiet: ok: false, a contradictory mixture such as ok: false beside
   disposition 'not-required', a field missing or added, a 'not-required'
   claim made for another setting. The setting was saved either way; what
   cannot be confirmed is its record, and that is what is said. An answer
   with no record field at all is an older host that never reported one. */
export const SETTING_RECORD_ACTION = 'settings.set'
export function settingRecordDisposition(recorded, settingId) {
  if (recorded === undefined) return 'absent'
  return auditReceiptDisposition(recorded, SETTING_RECORD_ACTION, String(settingId)) || 'unconfirmed'
}

/* A product row's draft key is 'product:<id>' (draftSettingsBridge below); the
   host records the row as 'settings.set' on <id> alone. The classifier is
   handed the id, never the key (Controller review of v3, F4: the prefixed key
   made every real save read as unconfirmed). Keys of the other writers --
   transcripts, permission profiles -- are not product rows and answer null. */
export const PRODUCT_KEY_PREFIX = 'product:'
export function productSettingId(key) {
  return typeof key === 'string' && key.startsWith(PRODUCT_KEY_PREFIX) && key.length > PRODUCT_KEY_PREFIX.length ? key.slice(PRODUCT_KEY_PREFIX.length) : null
}

export function createSettingsDraft({ onChange = () => {} } = {}) {
  const pending = new Map()
  const errors = new Map()
  let saving = false
  let reloadRequired = false
  let warning = ''
  let lastSave = null
  function orderedEntries() {
    const remaining = new Map(pending)
    const ordered = []
    while (remaining.size) {
      const ready = [...remaining].find(([, entry]) => entry.after.every(key => !remaining.has(key)))
      if (!ready) throw new Error('These settings have conflicting save dependencies. Discard the changes and try again.')
      ordered.push(ready)
      remaining.delete(ready[0])
    }
    return ordered
  }
  /* AUDIT OFF IS NOT A FAILED RECORD (owner direction 2026-09-20, T782). The
     host answers an intentional audit-off save with the exact not-required
     object (settingRecordDisposition above): optional auditing was not
     requested, which is neither a signed-ledger success nor a save that
     failed, and it is quiet. A recorded receipt is quiet. Everything else
     present -- refused, contradictory, malformed -- warns: the setting was
     saved, its record could not be confirmed. The saved setting is
     acknowledged (removed from pending, counted as saved) whatever the record
     said. The policy is captured per operation, so a result is read as it
     came back, never relabelled from the latest toggle. */
  function acknowledge(key, result) {
    // Some writers answer { ok: false, error: { code, message } } (the transcript
    // store through the main process); their sentence is the reason (T1489).
    if (result?.ok === false) throw new Error(result.reason || result.message || (typeof result.error?.message === 'string' && result.error.message) || 'A setting could not be saved.')
    if (result?.reloadRequired === true) reloadRequired = true
    /* Product rows are read against the host's contract on the row's own id.
       The other writers keep their own record contracts; for them only an
       explicit ok: false record is a record that could not be confirmed. */
    const id = productSettingId(key)
    const unconfirmed = id !== null ? settingRecordDisposition(result?.recorded, id) === 'unconfirmed' : result?.recorded?.ok === false
    if (unconfirmed) warning = 'Settings were saved, but their activity record could not be confirmed.'
    pending.delete(key)
    lastSave.savedKeys.push(key)
  }
  return {
    get dirty() { return pending.size > 0 || errors.size > 0 },
    get size() { return pending.size },
    get errors() { return [...errors].map(([key, message]) => ({ key, message })) },
    get valid() { return errors.size === 0 },
    get saving() { return saving },
    get reloadRequired() { return reloadRequired },
    get warning() { return warning },
    get saveResult() { return lastSave ? { ...lastSave, savedKeys: [...lastSave.savedKeys], currentKeys: [...lastSave.currentKeys] } : null },
    value(key, fallback) { return pending.has(key) ? pending.get(key).value : fallback },
    has(key) { return pending.has(key) },
    unstage(key) {
      if (saving) return
      pending.delete(key)
      errors.delete(key)
      onChange()
    },
    setError(key, message) {
      if (saving) return
      if (message) errors.set(key, String(message))
      else errors.delete(key)
      onChange()
    },
    stage(key, value, write, { batchWrite = null, after = [] } = {}) {
      if (saving) throw new Error('Wait for settings to finish saving.')
      if (!Array.isArray(after) || after.length > 16 || after.some(dependency => typeof dependency !== 'string' || dependency === key)) {
        throw new Error('A setting has invalid save dependencies.')
      }
      errors.delete(key)
      pending.delete(key)
      pending.set(key, { value, write, batchWrite: typeof batchWrite === 'function' ? batchWrite : null, after: [...new Set(after)] })
      onChange()
      return value
    },
    discard() { if (!saving) { pending.clear(); errors.clear(); warning = ''; onChange() } },
    async save() {
      if (saving) return false
      // Count acknowledged writes in this attempt, not changes inferred from
      // the remaining draft. A writer can save before a later writer refuses.
      lastSave = { total: pending.size, savedKeys: [], currentKeys: [], complete: false }
      warning = ''
      if (errors.size) throw new Error([...errors.values()][0])
      const ordered = orderedEntries()
      saving = true
      onChange()
      try {
        for (let index = 0; index < ordered.length;) {
          const [key, entry] = ordered[index]
          const group = [ordered[index]]
          if (entry.batchWrite) {
            while (group.length < 64 && ordered[index + group.length]?.[1].batchWrite === entry.batchWrite) group.push(ordered[index + group.length])
          }
          lastSave.currentKeys = group.map(([key]) => key)
          if (group.length > 1 || entry.batchWrite?.alwaysBatch) {
            const result = await entry.batchWrite(group.map(([key, item]) => ({ key, value: item.value })))
            const replies = Array.isArray(result?.results) ? result.results : []
            if (replies.length > group.length || replies.some((reply, position) => reply?.key !== group[position][0] || typeof reply.ok !== 'boolean')) {
              throw new Error('The application did not identify which settings were saved. Your changes remain pending.')
            }
            for (let position = 0; position < replies.length; position += 1) acknowledge(group[position][0], replies[position])
            if (result?.ok !== true || replies.length !== group.length) throw new Error(result?.reason || 'Some settings could not be saved. Your remaining changes are still pending.')
          } else acknowledge(key, await entry.write(entry.value))
          index += group.length
        }
        lastSave.complete = true
        lastSave.currentKeys = []
        return true
      } finally { saving = false; onChange() }
    },
  }
}

export function settingsSaveFailureMessage(error, draft) {
  const result = draft.saveResult
  const saved = result?.savedKeys.length || 0
  const allSaved = saved > 0 && saved === result.total
  const summary = allSaved ? 'Your changes were saved.'
    : saved ? 'Some changes were saved before Save stopped.'
      : 'No changes were confirmed saved in this attempt.'
  const remaining = draft.dirty ? 'Unsaved changes remain. Retry saves only the remaining changes.' : ''
  // Keep the writer's original reason, explicitly scoped to the interrupted
  // operation. Its "No setting was changed" cannot describe the whole Save.
  const keys = result?.currentKeys || []
  const context = result?.complete ? 'The check after saving reported'
    : !keys.length ? 'The check before saving reported'
      : keys.every(key => key.startsWith('product:')) ? 'The product settings save reported'
        : keys.every(key => key.startsWith('resources:')) ? 'The Resources save reported'
          : 'The interrupted save step reported'
  const reason = error?.message || String(error || 'The application could not finish saving.')
  return [summary, remaining, draft.warning, `${context}: “${reason}”`].filter(Boolean).join(' ')
}

/* validate(id, value) answers '' or the sentence that holds Save for a value
   the page can tell is unusable before it is staged (T1403: a service address
   without http:// used to stage as a normal change and fail the whole Save). */
export function draftSettingsBridge(shell, draft, { confirmWrite = async () => undefined, validate = () => '' } = {}) {
  if (!shell) return shell
  const saved = new Map()
  let writeGeneration = 0, readSequence = 0, latestRead = null
  function settledWrite(ids) {
    // A failed reply may follow a successful disk write. Reads begun before
    // either outcome cannot establish the values used to discard a new edit.
    writeGeneration += 1
    latestRead = null
    // The pre-write comparison is also unknown until a valid acknowledgement
    // or fresh read establishes it. Preserve comparisons for untouched keys.
    for (const id of ids) saved.delete(id)
  }
  async function readSaved() {
    const generation = writeGeneration, sequence = ++readSequence
    let result
    try { result = await shell.read() }
    catch (error) {
      if (generation !== writeGeneration) return latestRead?.result ?? readSaved()
      if (latestRead && sequence < latestRead.sequence) return latestRead.result
      throw error
    }
    if (generation !== writeGeneration) return latestRead?.result ?? readSaved()
    if (latestRead && sequence < latestRead.sequence) return latestRead.result
    if (!result?.ok || !Array.isArray(result.rows)) return result
    latestRead = { sequence, result }
    for (const row of result.rows) saved.set(row.id, row.value)
    return result
  }
  const batchWrite = typeof shell.setMany === 'function' ? async (entries, profile = null) => {
    const changes = entries.map(({ key, value }) => ({ id: key.slice('product:'.length), value }))
    let result
    try { result = await shell.setMany(changes, profile ? { workingProfile: profile } : undefined) }
    finally { settledWrite(changes.map(change => change.id)) }
    const replies = Array.isArray(result?.results) ? result.results : []
    if (replies.length > changes.length || replies.some((reply, index) => reply?.id !== changes[index].id || typeof reply.ok !== 'boolean')) {
      throw new Error('The application did not identify which settings were saved. Your changes remain pending.')
    }
    for (let index = 0; index < replies.length; index += 1) {
      if (replies[index].ok !== true) break
      saved.set(replies[index].id, replies[index].value ?? changes[index].value)
    }
    return { ...result, results: replies.map(reply => ({ ...reply, key: `product:${reply.id}` })) }
  } : null
  /* One writer per profile, remembered: the draft groups a run of pending
     rows into one batch only while they share the SAME writer, so the rows a
     working profile staged are written together, with that profile's receipt,
     and a row the person changed by hand in the same visit stays out of it. */
  const profileWriters = new Map()
  function writerFor(profile) {
    if (!profile || !batchWrite) return batchWrite
    if (!profileWriters.has(profile)) {
      const writer = entries => batchWrite(entries, profile)
      /* A profile application is ONE receipted write even when the profile
         changes exactly one row. Without this the single-row save would take
         the plain writer, leave no receipt, and the row it just wrote would
         read afterwards as a choice the person had made themselves. */
      writer.alwaysBatch = true
      profileWriters.set(profile, writer)
    }
    return profileWriters.get(profile)
  }
  return {
    ...shell,
    stagesWrites: true,
    async read() {
      const result = await readSaved()
      if (!result?.ok || !Array.isArray(result.rows)) return result
      return { ...result, rows: result.rows.map(row => ({ ...row,
        savedValue: row.value,
        value: draft.value(`product:${row.id}`, row.value),
        pending: draft.has(`product:${row.id}`),
      })) }
    },
    ...(typeof shell.set === 'function' ? { async set(id, value, { profile = null } = {}) {
      const invalid = validate(id, value)
      if (invalid) {
        draft.setError(`product:${id}`, invalid)
        return { ok: false, reason: invalid }
      }
      if (saved.has(id) && Object.is(saved.get(id), value)) draft.unstage(`product:${id}`)
      else draft.stage(`product:${id}`, value, async next => {
        const confirmation = await confirmWrite(id, next)
        let result
        try { result = await shell.set(id, next, confirmation) }
        finally { settledWrite([id]) }
        if (typeof result?.ok !== 'boolean') throw new Error('The application did not confirm whether this setting was saved. Your change remains pending.')
        if (result.ok) saved.set(id, result.value ?? next)
        return result
      }, { batchWrite: id === 'purchases.require_owner_approval' && value === false ? null : writerFor(profile) })
      return { ok: true, value, draft: true, pending: draft.has(`product:${id}`) }
    } } : {}),
    setValidationError(id, message) { draft.setError(`product:${id}`, message) },
  }
}
