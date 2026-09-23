// Session ↔ project assignment, the app side. The DURABLE record is the
// research service's table, written through the research-session-assign
// action; what this module owns is the local cache of that record plus the
// outbox for writes made while the service was unreachable, so the person's
// intent survives a bridge outage instead of silently vanishing.
//
// Storage — localStorage mc.research.assignments,
// { v: 1, rows: [...], removals?: [...], revision?: string }. Pending rows retain assignments;
// removals retain the exact service assignmentId until its removal is confirmed.
// flushPending() retries guarded writes on the next
// mount and the render layer says so in a sentence rather than pretending the
// service agreed.

import { postBridgeAction } from './mission-bridge.js'

export const ASSIGNMENTS_ROW_KEY = 'mc.research.assignments'
export const ASSIGNMENTS_EVENT = 'mc:research-assignments-changed'
export const ASSIGNMENTS_READ_UNAVAILABLE = 'ASSIGNMENTS_READ_UNAVAILABLE'

const MAX_ROWS = 200
const KINDS = new Set(['launch', 'presence', 'observed', 'all'])
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 100
const rowKey = row => `${row.projectId}\0${row.kind}\0${row.ref}`
const operationId = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
const sameMembership = (left, right) => rowKey(left) === rowKey(right) && left.assignmentId === right.assignmentId
const pendingRemovalSentence = 'Removal saved in this browser; the research service has not confirmed it yet. This browser will retry when the service is available.'

function safeStorage(storage) {
  return {
    get() {
      try { return { ok: true, value: storage?.getItem(ASSIGNMENTS_ROW_KEY) ?? null } } catch (cause) {
        return { ok: false, cause }
      }
    },
    /* ANSWERS, LIKE get() ABOVE. A write is the half of this seam that a
       screen makes a promise about -- "Saved in this browser" -- so it may not
       be the half that cannot say it failed. A full quota, a private window and
       a browser with site data switched off all throw here. */
    set(value) {
      try {
        if (value === null) storage?.removeItem(ASSIGNMENTS_ROW_KEY)
        else storage?.setItem(ASSIGNMENTS_ROW_KEY, value)
        return { ok: true }
      } catch (cause) {
        return { ok: false, cause }
      }
    },
  }
}

export function parseAssignmentsRow(raw) {
  const empty = { rows: [], removals: [], damaged: false }
  if (raw === null || raw === undefined || raw === '') return empty
  let parsed
  try { parsed = JSON.parse(raw) } catch { return { ...empty, damaged: true } }
  if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.rows)) return { ...empty, damaged: true }
  const validRow = row => row && typeof row === 'object' && typeof row.projectId === 'string'
    && KINDS.has(row.kind) && typeof row.ref === 'string' && row.ref.length > 0
  const normalize = row => ({ projectId: row.projectId, kind: row.kind, ref: row.ref,
    ...(validId(row.assignmentId) ? { assignmentId: row.assignmentId } : {}),
    ...(validId(row.operationId) ? { operationId: row.operationId } : {}) })
  const rawRemovals = Array.isArray(parsed.removals) ? parsed.removals : []
  const removals = rawRemovals.filter(row => validRow(row) && validId(row.assignmentId) && validId(row.operationId))
    .slice(0, MAX_ROWS).map(normalize)
  const rows = parsed.rows.filter(validRow).slice(0, MAX_ROWS - removals.length)
    .map(row => ({ ...normalize(row), pending: row.pending === true }))
  return { rows, removals, ...(validId(parsed.revision) ? { revision: parsed.revision } : {}),
    damaged: parsed.removals !== undefined && !Array.isArray(parsed.removals)
    || removals.length !== rawRemovals.length }
}

export function serializeAssignmentsRow(rows, removals = [], revision = null) {
  if (rows.length === 0 && removals.length === 0 && !validId(revision)) return null
  return JSON.stringify({ v: 1, rows: rows.slice(0, MAX_ROWS - removals.length),
    ...(removals.length ? { removals: removals.slice(0, MAX_ROWS) } : {}),
    ...(validId(revision) ? { revision } : {}) })
}
const versionOf = state => state.revision ?? serializeAssignmentsRow(state.rows, state.removals)

function announce() {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(ASSIGNMENTS_EVENT))
}


/** Keep a website view and its durable outbox on the destination of its first
 * successful snapshot. A picker change requires a new view; a reconnect to the
 * same registration may acquire a fresh ticket. Legacy global rows are retained
 * untouched, never guessed to belong to the currently selected computer. */
export function createAssignmentStore({
  storage = null, postAction = postBridgeAction,
  requireDestination = typeof globalThis.window?.mcShell?.getBridgeTransport === 'function',
  captureDestination = () => globalThis.window?.mcShell?.captureResearchAssignmentDestination?.(),
} = {}) {
  if (!requireDestination) {
    const local = createUnscopedAssignmentStore({ storage, postAction })
    local.readServiceSnapshot = async read => {
      let readVersion, assignmentReadFailure = null
      try { readVersion = local.readVersion() }
      catch (error) { assignmentReadFailure = error.message }
      return { ...await read(), assignmentReadVersion: readVersion, assignmentReadFailure }
    }
    return local
  }
  let destination = null
  let scoped = null
  let readEpoch = 0
  const unavailable = () => ({
    ok: false, code: 'RESEARCH_DESTINATION_UNAVAILABLE',
    reason: 'Research assignments are waiting for a verified connection to the selected computer. Older unbound changes remain saved and will not be retried here.',
    sentence: 'Research assignments are waiting for a verified connection to the selected computer. Older unbound changes remain saved and will not be retried here.',
  })
  async function capture() {
    try {
      const context = await captureDestination()
      if (context?.ok !== true || typeof context.key !== 'string' || !context.key || context.key.length > 1024
        || typeof context.request !== 'function') return unavailable()
      if (destination !== null && context.key !== destination) return unavailable()
      return context
    } catch { return unavailable() }
  }
  function pendingUnavailable() {
    const error = new Error(unavailable().sentence)
    error.code = 'RESEARCH_DESTINATION_UNAVAILABLE'
    throw error
  }
  function legacyUnbound() {
    try {
      const legacy = parseAssignmentsRow(storage?.getItem(ASSIGNMENTS_ROW_KEY) ?? null)
      return legacy.rows.some(row => row.pending) || legacy.removals.length > 0 || legacy.damaged
    } catch { return true }
  }
  function makeScoped(context) {
    const key = ASSIGNMENTS_ROW_KEY + '.destination.v1.' + encodeURIComponent(context.key)
    return createUnscopedAssignmentStore({
      storage: {
        getItem: () => storage?.getItem(key) ?? null,
        setItem: (_key, value) => { if (!storage) throw new Error('Assignment storage unavailable'); storage.setItem(key, value) },
        removeItem: () => { if (!storage) throw new Error('Assignment storage unavailable'); storage.removeItem(key) },
      },
      postAction: async (action, body) => {
        const attempt = await capture()
        if (attempt.ok !== true || attempt.key !== context.key) return unavailable()
        return attempt.request(action, body)
      },
    })
  }
  return {
    async readServiceSnapshot(read) {
      const epoch = ++readEpoch
      const context = await capture()
      if (context.ok !== true || epoch !== readEpoch) return unavailable()
      // Fix the namespace before awaiting the snapshot; concurrent reads and
      // controls cannot silently retarget a store to another computer.
      if (destination === null) { destination = context.key; scoped = makeScoped(context) }
      let version, assignmentReadFailure = null
      try { version = scoped.readVersion() }
      catch (error) { assignmentReadFailure = error.message }
      const result = await read({ snapshot: () => context.request('research-snapshot', {}) })
      if (epoch !== readEpoch) return unavailable()
      return { ...result, assignmentReadVersion: version, assignmentDestination: destination, assignmentReadFailure }
    },
    readVersion() { return scoped ? scoped.readVersion() : pendingUnavailable() },
    snapshot() {
      if (!scoped) return pendingUnavailable()
      return { ...scoped.snapshot(), unboundLegacy: legacyUnbound() }
    },
    projectsOfSession(...args) { return scoped ? scoped.projectsOfSession(...args) : [] },
    sessionsOfProject(...args) { return scoped ? scoped.sessionsOfProject(...args) : [] },
    async assign(...args) {
      if (!scoped || (await capture()).ok !== true) return unavailable()
      return scoped.assign(...args)
    },
    async unassign(...args) {
      if (!scoped || (await capture()).ok !== true) return unavailable()
      return scoped.unassign(...args)
    },
    adoptServiceRows(rows, options = {}) {
      if (!scoped || options.assignmentDestination !== destination) return unavailable()
      return scoped.adoptServiceRows(rows, options)
    },
    async flushPending() {
      if (!scoped) return { ...unavailable(), accepted: 0, remaining: null }
      return scoped.flushPending()
    },
  }
}

function createUnscopedAssignmentStore({ storage = null, postAction = postBridgeAction } = {}) {
  const store = safeStorage(storage)
  let state = null

  function readState() {
    const read = store.get()
    if (read.ok) {
      state = parseAssignmentsRow(read.value)
      return state
    }
    const error = new Error('The session assignments could not be read; this is not claiming that no assignments exist.', { cause: read.cause })
    error.code = ASSIGNMENTS_READ_UNAVAILABLE
    throw error
  }

  // A successful read (including genuine absence) is the cache. A failed read
  // is deliberately not state: the next operation gets another chance once a
  // busy or temporarily unavailable storage implementation recovers.
  try { readState() } catch {}

  function currentState() {
    return state ?? readState()
  }

  /** Whether the browser kept it. Callers that PROMISE it was kept must ask. */
  function persist() {
    currentState()
    // Keep a revision even after the last row is removed. Returning to an
    // empty cache must not make an older empty-cache snapshot current again.
    const revision = operationId()
    const kept = store.set(serializeAssignmentsRow(state.rows, state.removals, revision)).ok === true
    if (kept) state.revision = revision
    return kept
  }

  const inFlight = new Map()

  // Settling an old view's request reads the latest browser outbox first. Its
  // operationId may have been retired or replaced while the bridge was awaited.
  function reloadForSettlement() {
    try { readState(); return true } catch { return false }
  }

  async function mirror(projectId, { assign = [], unassign = [] }) {
    try { return await postAction('research-session-assign', { projectId, assign, unassign }) }
    catch { return null }
  }

  function assignedIdentity(result, row) {
    if (result?.ok !== true || result.receipt?.projectId !== row.projectId) return null
    if (!Array.isArray(result.receipt.assigned)) return null
    return result.receipt.assigned.find(entry => entry.kind === row.kind && entry.ref === row.ref
      && validId(entry.assignmentId)) || null
  }

  function removalConfirmed(result, removal) {
    if (result?.ok !== true) return result?.ok === false && result.code === 'RESEARCH_ASSIGNMENT_NOT_FOUND'
    const receipt = result.receipt
    return receipt?.projectId === removal.projectId && Array.isArray(receipt.assigned) && receipt.assigned.length === 0
      && Array.isArray(receipt.unassigned) && receipt.unassigned.length === 1 && receipt.unassigned.some(entry => entry.projectId === removal.projectId
        && sameMembership(entry, removal))
  }

  async function deliverRemoval(removal, kept = true) {
    if (inFlight.has(removal.operationId)) return inFlight.get(removal.operationId)
    const work = (async () => {
      const result = await mirror(removal.projectId, { unassign: [{
        assignmentId: removal.assignmentId, kind: removal.kind, ref: removal.ref,
      }] })
      const confirmed = removalConfirmed(result, removal)
      if (confirmed && reloadForSettlement()) {
        if (kept && !state.removals.some(entry => entry.operationId === removal.operationId)) return confirmed
        state.removals = state.removals.filter(entry => entry.operationId !== removal.operationId)
        // A successor assignment with the same logical reference has another
        // assignmentId and is not removed by this acknowledgement.
        state.rows = state.rows.filter(entry => !sameMembership(entry, removal))
        persist(); announce()
      }
      return confirmed
    })()
    inFlight.set(removal.operationId, work)
    try { return await work }
    finally { if (inFlight.get(removal.operationId) === work) inFlight.delete(removal.operationId) }
  }

  return {
    // The caller takes this before awaiting a service snapshot. A later
    // snapshot cannot overwrite an assignment change made during that read.
    readVersion() {
      readState()
      return versionOf(state)
    },

    snapshot() {
      currentState()
      return { rows: state.rows.map(row => ({ ...row })), removals: state.removals.map(row => ({ ...row })), damaged: state.damaged }
    },

    /** All projects a session reference is filed under, locally known. */
    projectsOfSession(kind, ref) {
      currentState()
      const direct = state.rows.filter(row => row.kind === kind && row.ref === ref).map(row => row.projectId)
      const viaAll = state.rows.filter(row => row.kind === 'all').map(row => row.projectId)
      return [...new Set([...direct, ...viaAll])]
    },

    sessionsOfProject(projectId) {
      currentState()
      return state.rows.filter(row => row.projectId === projectId).slice()
    },

    /** Assign one reference (or the live 'all' rule with ref '*'). */
    async assign(projectId, kind, ref) {
      try { readState() } catch (error) { return { ok: false, sentence: error.message } }
      if (!KINDS.has(kind)) return { ok: false, sentence: 'That is not a way of naming a session.' }
      const finalRef = kind === 'all' ? '*' : ref
      if (typeof finalRef !== 'string' || finalRef.length === 0) {
        return { ok: false, sentence: 'The session reference is missing, so nothing was assigned.' }
      }
      if (state.removals.some(row => rowKey(row) === rowKey({ projectId, kind, ref: finalRef }))) {
        return { ok: false, sentence: 'The previous removal is still waiting for service confirmation. Retry it before filing this session again.' }
      }
      const row = { projectId, kind, ref: finalRef, pending: true, operationId: operationId() }
      if (state.rows.some(existing => rowKey(existing) === rowKey(row))) {
        return { ok: true, alreadyAssigned: true }
      }
      if (state.rows.length + state.removals.length >= MAX_ROWS) {
        const removable = state.rows.findIndex(row => !row.pending)
        if (removable < 0) return { ok: false, sentence: 'This browser has too many pending assignment changes. Reconnect and retry them before filing another session.' }
        state.rows = state.rows.filter((_, index) => index !== removable)
      }
      state.rows = [...state.rows, row]
      const kept = persist()
      announce()
      const result = await mirror(projectId, { assign: [kind === 'all' ? { kind } : { kind, ref: finalRef }] })
      const heard = result?.ok === true
      if (heard && reloadForSettlement()) {
        const identity = assignedIdentity(result, row)
        state.rows = state.rows.map(existing => existing.operationId === row.operationId
          ? { ...existing, ...(identity ? { assignmentId: identity.assignmentId } : {}), pending: false } : existing)
        persist()
        announce()
        return { ok: true }
      }
      /* NEITHER STORE HAS IT, SO NOBODY MAY BE TOLD IT WAS FILED.
         The pending sentence below is a promise about THIS BROWSER, and the
         retry that redeems it (flushPending, next visit) reads the row back out
         of this same storage -- so a local write that failed leaves the
         assignment nowhere, with nothing that will ever retry it. Saying
         "Saved in this browser" then is simply false, and its caller in
         src/views/computers.js counts every ok result into the "N sessions
         filed." line a person reads. The optimistic row is taken back out for
         the same reason: snapshot() must not show one either. */
      if (heard) return { ok: true }
      if (!kept) {
        state.rows = state.rows.filter(existing => existing.operationId !== row.operationId)
        announce()
        return {
          ok: false,
          sentence: 'This browser would not keep it and the research service has not heard it, so it was not filed anywhere. Free some space in this browser, or leave a private window, and try again.',
        }
      }
      return {
        ok: true,
        pending: true,
        sentence: 'Saved in this browser; the research service has not heard it yet and will on the next visit.',
      }
    },

    async unassign(projectId, kind, ref, expectedAssignmentId = null) {
      try { readState() } catch (error) { return { ok: false, sentence: error.message } }
      if (arguments.length > 3 && !validId(expectedAssignmentId)) {
        return { ok: false, sentence: 'Read the service’s current assignments before removing this session. Its displayed assignment could not be identified, so no removal was sent.' }
      }
      const finalRef = kind === 'all' ? '*' : ref
      const previous = state.rows.find(row => row.projectId === projectId && row.kind === kind && row.ref === finalRef)
      if (validId(expectedAssignmentId) && previous?.assignmentId !== expectedAssignmentId) {
        return { ok: false, sentence: 'That assignment changed while this view was open. Read the service’s current assignments before removing it.' }
      }
      if (!previous) return { ok: false, sentence: 'That session is not filed under this project.' }
      if (!validId(previous.assignmentId)) {
        return { ok: false, sentence: 'Read the service’s current assignments before removing this session. Its saved assignment could not be identified, so no removal was sent.' }
      }
      const removal = { projectId, kind, ref: finalRef, assignmentId: previous.assignmentId, operationId: operationId() }
      state.rows = state.rows.filter(row => row !== previous)
      state.removals = [...state.removals, removal]
      const kept = persist()
      announce()
      const heard = await deliverRemoval(removal, kept)
      if (heard) return { ok: true }
      if (!kept) {
        state.removals = state.removals.filter(row => row.operationId !== removal.operationId)
        if (!state.rows.some(row => rowKey(row) === rowKey(previous))) state.rows.push(previous)
        announce()
        return {
          ok: false,
          sentence: 'This browser would not keep the removal and the research service has not confirmed it, so the session is still shown as filed. Free some space in this browser, or leave a private window, and try again.',
        }
      }
      return { ok: true, pending: true, sentence: pendingRemovalSentence }
    },

    /** Adopt the service's truth wholesale (from the snapshot read). */
    adoptServiceRows(assignments, options = {}) {
      // Local pending operations take priority over an older service snapshot.
      // Absence in this array never proves removal: the caller can normalize
      // an unreadable/missing assignment list to an empty array.
      try { readState() } catch (error) {
        return { ok: false, code: error.code, sentence: error.message }
      }
      if (Object.hasOwn(options, 'readVersion')
        && options.readVersion !== versionOf(state)) {
        return { ok: true, stale: true }
      }
      const pendingRows = state.rows.filter(row => row.pending)
      const serviceRows = (Array.isArray(assignments) ? assignments : [])
        .filter(entry => entry && entry.active !== false && KINDS.has(entry.kind))
        .map(entry => ({ projectId: entry.projectId, kind: entry.kind, ref: entry.ref,
          ...(validId(entry.assignmentId) ? { assignmentId: entry.assignmentId } : {}), pending: false }))
        .filter(row => !state.removals.some(removal => sameMembership(row, removal)))
      const keys = new Set(serviceRows.map(rowKey))
      const unheard = pendingRows.filter(row => !keys.has(rowKey(row)))
      state.rows = [...unheard, ...serviceRows].slice(0, MAX_ROWS - state.removals.length)
      state.damaged = false
      persist()
      announce()
      return { ok: true }
    },

    /** Retry every pending write; returns how many the service accepted. */
    async flushPending() {
      try { readState() } catch (error) {
        // A retry must first read the current outbox. A cached count is not a
        // claim about work another view may have added while this read failed.
        return { ok: false, accepted: 0, remaining: null, code: error.code, sentence: error.message }
      }
      const pendingRemovals = state.removals.slice()
      let accepted = 0
      for (const removal of pendingRemovals) if (await deliverRemoval(removal)) accepted += 1
      const pendingRows = state.rows.filter(row => row.pending)
      for (const candidate of pendingRows) {
        // An earlier request was awaited. Another view may since have
        // confirmed and removed this assignment, so admission must use the
        // latest operation as well as settlement checking its operationId.
        try { readState() } catch (error) {
          return { ok: false, accepted, remaining: null, code: error.code, sentence: error.message }
        }
        const row = state.rows.find(entry => entry.pending && rowKey(entry) === rowKey(candidate)
          && entry.operationId === candidate.operationId)
        if (!row) continue
        if (!row.operationId) { row.operationId = operationId(); persist() }
        if (state.removals.some(removal => rowKey(removal) === rowKey(row))) continue
        const result = await mirror(row.projectId, { assign: [row.kind === 'all' ? { kind: row.kind } : { kind: row.kind, ref: row.ref }] })
        if (result?.ok === true && reloadForSettlement()) {
          const identity = assignedIdentity(result, row)
          state.rows = state.rows.map(existing => existing.operationId === row.operationId
            ? { ...existing, ...(identity ? { assignmentId: identity.assignmentId } : {}), pending: false } : existing)
          accepted += 1
          persist(); announce()
        }
      }
      return { accepted, remaining: state.rows.filter(row => row.pending).length + state.removals.length }
    },
  }
}
