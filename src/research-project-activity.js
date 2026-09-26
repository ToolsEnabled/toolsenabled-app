import { desktopTreeBridge, readDesktopTreeSnapshot } from './desktop-tree-authority.js'
import { fleetTreesStorageKey, parseFleetTrees } from './fleet-trees.js'
import { THIS_COMPUTER_ID } from './declared-fleet.js'

// Saved links identify a project. Only a current session read establishes work.
export function activeResearchProjectIds({ snapshot = null, sessions = [], assignments = [] } = {}) {
  const live = new Map(sessions.filter(row => row && typeof row.sessionId === 'string'
    && row.busy === true && row.closing !== true
    && (snapshot?.computerId == null || row.computerId == null || row.computerId === snapshot.computerId)).map(row => [row.sessionId, row]))
  const active = new Set()
  const projects = new Map((snapshot?.trees || []).filter(tree => typeof tree.researchProjectId === 'string'
    && tree.researchProjectId).map(tree => [tree.id, tree.researchProjectId]))
  for (const node of snapshot?.nodes || []) {
    const row = live.get(node.sessionId), projectId = projects.get(node.treeId)
    if (!row || !projectId || (row.nodeId != null && row.nodeId !== node.id)
      || (row.computerId != null && row.computerId !== snapshot.computerId)) continue
    active.add(projectId)
  }
  // These are confirmed service rows from the same destination as the read,
  // never the browser's pending assignment outbox or an assign-all rule.
  for (const row of assignments) if (row?.kind === 'observed' && row.active !== false
    && row.pending !== true && typeof row.projectId === 'string' && row.projectId && live.has(row.ref)) active.add(row.projectId)
  return active
}

export async function readResearchProjectActivity({ source, destination = null, assignments = [] } = {}, scope = globalThis.window) {
  if (!['local', 'relay'].includes(source)) return new Set()
  const scoped = source === 'relay'
  const capture = scope?.mcShell?.captureResearchAssignmentDestination
  const matches = async () => {
    if (!scoped) return true
    if (typeof capture !== 'function' || typeof destination !== 'string' || !destination) return false
    const current = await capture.call(scope.mcShell)
    return current?.ok === true && current.key === destination
  }
  if (!await matches()) return new Set()
  const native = desktopTreeBridge(scope)
  if (native) {
    const snapshot = await readDesktopTreeSnapshot(native)
    if (!await matches()) return new Set()
    return activeResearchProjectIds({ snapshot, sessions: snapshot.sessions, assignments })
  }
  if (source !== 'local' || typeof scope?.mcAgent?.sessionActivity !== 'function') return new Set()
  const bridge = scope.mcAgent
  const parsed = parseFleetTrees(scope.localStorage?.getItem(fleetTreesStorageKey(THIS_COMPUTER_ID)), { computerId: THIS_COMPUTER_ID })
  const snapshot = parsed.computerId === THIS_COMPUTER_ID ? parsed : null
  const trees = new Set((snapshot?.trees || []).filter(tree => tree.researchProjectId).map(tree => tree.id))
  const ids = new Set((snapshot?.nodes || []).filter(node => trees.has(node.treeId) && node.sessionId).map(node => node.sessionId))
  for (const row of assignments) if (row?.kind === 'observed' && row.active !== false
    && row.pending !== true && typeof row.ref === 'string' && row.ref) ids.add(row.ref)
  const sessions = (await Promise.all([...ids].map(async sessionId => {
    try {
      const activity = await bridge.sessionActivity({ sessionId })
      return activity?.ok === true ? { sessionId, busy: activity.busy, closing: activity.closing } : null
    } catch { return null }
  }))).filter(Boolean)
  if (scope.mcAgent !== bridge) return new Set()
  return activeResearchProjectIds({ snapshot, sessions, assignments })
}

export function createResearchProjectActivity({
  scope = globalThis.window, document = globalThis.document,
  read = context => readResearchProjectActivity(context, scope), onChange = () => {},
  intervalMs = 15000, staleMs = 30000, now = Date.now,
  schedule = setTimeout, cancel = clearTimeout,
} = {}) {
  let context = null, revision = 0, disposed = false, flight = null, queued = false
  let timer = null, timerAt = Infinity, expiry = null, unsubscribe = null, lastRead = -Infinity
  let active = new Set()
  const emit = next => {
    if (next.size === active.size && [...next].every(id => active.has(id))) return
    active = new Set(next); onChange(new Set(active))
  }
  const clearTimers = () => {
    if (timer !== null) cancel(timer)
    if (expiry !== null) cancel(expiry)
    timer = expiry = null; timerAt = Infinity
  }
  const visible = () => document?.visibilityState !== 'hidden' && scope?.navigator?.onLine !== false
  const enabled = () => !disposed && context && ['local', 'relay'].includes(context.source) && visible()
  function invalidate() {
    revision++; flight = null; queued = false; clearTimers(); emit(new Set())
  }
  function soon(delay) {
    if (!enabled()) return
    const at = now() + delay
    if (timer !== null && timerAt <= at) return
    if (timer !== null) cancel(timer)
    timerAt = at
    timer = schedule(() => { timer = null; timerAt = Infinity; void refresh() }, delay)
  }
  async function refresh() {
    if (!enabled()) { invalidate(); return }
    if (flight) { queued = true; return }
    if (timer !== null) cancel(timer)
    timer = null; timerAt = Infinity
    const ticket = { revision, context }
    flight = ticket; lastRead = now()
    try {
      const result = await read(ticket.context)
      if (disposed || flight !== ticket || ticket.revision !== revision || !enabled()) return
      if (ticket.context !== context) { queued = true; return }
      emit(result instanceof Set ? result : new Set())
      if (expiry !== null) cancel(expiry)
      expiry = active.size ? schedule(() => { expiry = null; emit(new Set()) }, staleMs) : null
    } catch {
      if (flight === ticket && ticket.revision === revision) emit(new Set())
    } finally {
      if (flight === ticket) {
        flight = null
        const delay = queued ? 0 : intervalMs
        queued = false; soon(delay)
      }
    }
  }
  function onSessionEvent(packet) {
    if (!enabled()) return
    if (['turn_completed', 'session_ended'].includes(packet?.event?.type)) {
      invalidate(); soon(0)
    } else soon(Math.max(0, lastRead + 1000 - now()))
  }
  const onWake = () => { if (enabled()) soon(0); else invalidate() }
  const onOffline = () => { invalidate() }
  const onStorage = event => {
    if (event.key == null || event.key === fleetTreesStorageKey(THIS_COMPUTER_ID)) soon(0)
  }
  for (const name of ['focus', 'online']) scope?.addEventListener?.(name, onWake)
  scope?.addEventListener?.('offline', onOffline)
  scope?.addEventListener?.('storage', onStorage)
  document?.addEventListener?.('visibilitychange', onWake)
  return {
    setContext(next) {
      const sameScope = context && next && context.source === next.source
        && context.epoch === next.epoch && context.destination === next.destination
      context = next
      if (!sameScope) {
        invalidate(); unsubscribe?.(); unsubscribe = null
        if (enabled() && typeof scope?.mcAgent?.onEvent === 'function') unsubscribe = scope.mcAgent.onEvent(onSessionEvent)
      }
      if (enabled()) soon(0)
    },
    refresh,
    destroy() {
      if (disposed) return
      disposed = true; context = null; invalidate(); unsubscribe?.(); unsubscribe = null
      for (const name of ['focus', 'online']) scope?.removeEventListener?.(name, onWake)
      scope?.removeEventListener?.('offline', onOffline)
      scope?.removeEventListener?.('storage', onStorage)
      document?.removeEventListener?.('visibilitychange', onWake)
    },
  }
}
