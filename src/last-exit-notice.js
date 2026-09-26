/* THE APP DID NOT CLOSE NORMALLY LAST TIME, AND NOBODY WAS TOLD.
 *
 * Observed: after the main process is killed the application reopens on Home
 * with every setting and tree in place and says nothing. Agents that were in
 * the middle of a turn simply read idle (a saved `running` node is loaded as
 * restart-stale on purpose, see src/tree-session-liveness.js). A person who
 * left work running comes back to a quiet screen with no reason on it.
 *
 * NOTHING NEW IS RECORDED FOR THIS. Two records already exist:
 *   - the product diagnostic files (engine src/lib/diagnostic-retention.js).
 *     Every run opens a `main-lag` file at startup, and every orderly way out
 *     (before-quit, will-quit, window-all-closed, each app.quit() call site)
 *     writes an `exit-record` file through shell/exit-record.cjs. A run that
 *     was killed has the first and not the second. The page can already list
 *     those files -- kind, process id, creation time, still-active -- through
 *     mcSettings.diagnosticsInspect, the bridge the Settings diagnostics panel
 *     uses. No file content is read here; the listing is enough.
 *   - the saved trees. A node saved `running` with an open `runStartedAt` was
 *     mid-turn at its last write. Only nodes whose run began DURING the run that
 *     died are named, so an old phantom `running` record cannot be blamed on it.
 *
 * IT SAYS NOTHING UNLESS THE RECORD IS CERTAIN. An unreadable listing, a busy
 * listing, a managed file without readable metadata, an unfinished scan, a
 * record held by some other live process, or no record at all each end in no
 * notice -- which is what the application did before this file existed. A
 * wrong "it crashed" is worse than the silence it replaces.
 *
 * WHAT IT CANNOT SEE: a quit that started (so an exit record exists) and then
 * died before finishing reads as orderly, because the listing carries no file
 * content. That errs toward silence.
 *
 * IT IS SHOWN THROUGH THE EXISTING WINDOW NOTICE (src/settings-recovery-notice.js),
 * below every settings problem: one bar, one dismissal, no second surface.
 */
import { fleetTreesStorageKey, nodeDisplayName, parseFleetTrees } from './fleet-trees.js'

const KINDS = new Set(['main-lag', 'main-heap', 'exit-record', 'native-decisions', 'native-stream', 'startup-fatal'])
const MAX_PAGES = 8
const MAX_NAMED = 3

const validRow = row => row && typeof row === 'object' && KINDS.has(row.kind)
  && Number.isSafeInteger(row.pid) && row.pid > 0 && Number.isSafeInteger(row.createdAt) && typeof row.active === 'boolean'

/** What the diagnostic listing says about the run before this one. Pure. */
export function previousExit(files, ownPid) {
  if (!Number.isSafeInteger(ownPid) || ownPid <= 0) return { known: false, reason: 'own-process-unknown' }
  if (!Array.isArray(files) || !files.every(validRow)) return { known: false, reason: 'listing-unreadable' }
  const others = files.filter(row => row.pid !== ownPid)
  if (!others.length) return { known: true, firstRun: true, ungraceful: false }
  /* A record another live process still holds is not a finished run. It may be
     a second profile instance, or the dead run's process id given to something
     else; either way this page cannot tell, so it does not guess. */
  if (others.some(row => row.active)) return { known: false, reason: 'another-process-active' }
  const ordered = [...others].sort((a, b) => a.createdAt - b.createdAt || (a.kind === 'exit-record') - (b.kind === 'exit-record'))
  const last = ordered.at(-1)
  let first = ordered.length - 1
  while (first > 0 && ordered[first - 1].pid === last.pid) first -= 1
  const run = ordered.slice(first)
  return { known: true, firstRun: false, ungraceful: !run.some(row => row.kind === 'exit-record'),
    pid: last.pid, startedAt: run[0].createdAt, lastRecordAt: last.createdAt }
}

/** Page through the existing listing, bounded. Null means "cannot tell". */
export async function readDiagnosticRows(bridge, { maxPages = MAX_PAGES } = {}) {
  if (typeof bridge?.diagnosticsInspect !== 'function') return null
  const rows = []
  let ownPid = null
  for (let page = 0; page < maxPages; page += 1) {
    const result = await bridge.diagnosticsInspect({ next: page > 0 })
    if (!result || typeof result !== 'object' || result.ok !== true || !Array.isArray(result.files)) return null
    const writer = Array.isArray(result.writers) ? result.writers.find(entry => Number.isSafeInteger(entry?.pid)) : null
    if (writer) ownPid = writer.pid
    rows.push(...result.files)
    if (result.scanComplete === true) return { rows, ownPid }
  }
  return null
}

/** Every agent whose saved record says a turn was running, with the instant
 *  that run began. Read from the RAW record, because the parser deliberately
 *  loads `running` back as `starting` with the clock shut. */
export function midTurnRecords({ storage, computerIds = [] } = {}) {
  const records = []
  if (!storage || typeof storage.getItem !== 'function') return records
  for (const computerId of computerIds) {
    try {
      const text = storage.getItem(fleetTreesStorageKey(computerId))
      if (typeof text !== 'string' || !text) continue
      const raw = JSON.parse(text)
      const running = new Map((Array.isArray(raw?.nodes) ? raw.nodes : [])
        .filter(node => node && node.status === 'running' && node.sessionId != null && Number.isFinite(Date.parse(node.runStartedAt)))
        .map(node => [node.id, Date.parse(node.runStartedAt)]))
      if (!running.size) continue
      const { nodes } = parseFleetTrees(raw, { computerId })
      for (const node of nodes) {
        if (running.has(node.id)) records.push({ name: nodeDisplayName(node, nodes) || 'An unnamed agent', runStartedAt: running.get(node.id) })
      }
    } catch { /* an unreadable tree names nobody; the notice still stands */ }
  }
  return records
}

/** Only a run that BEGAN during the run that died is named, so an old phantom
 *  `running` record is never blamed on it. */
export function agentsMidTurn(records, since) {
  if (!Array.isArray(records) || !Number.isFinite(since)) return []
  return records.filter(record => record.runStartedAt >= since).map(record => record.name)
}

function nameList(names) {
  const shown = names.slice(0, MAX_NAMED)
  const more = names.length - shown.length
  if (more > 0) return `${shown.join(', ')} and ${more} more`
  return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}` : shown[0]
}

/** The sentence. `lastExit` is `{ agents: string[] }`; anything else is no notice. */
export function lastExitNotice(lastExit) {
  if (!lastExit || typeof lastExit !== 'object' || !Array.isArray(lastExit.agents)) return null
  const agents = lastExit.agents.filter(name => typeof name === 'string' && name)
  const kept = 'Nothing was deleted. Your settings, trees and conversations remain as last saved. Work from the last moments before the app stopped may be missing.'
  const body = agents.length
    ? `The previous run left no shutdown record, so it was closed by force, by a crash or by the computer shutting down. ${nameList(agents)} ${agents.length === 1 ? 'was' : 'were'} in the middle of a turn, and that turn was cut off: send ${agents.length === 1 ? 'it' : 'them'} a message to carry on from the saved conversation. ${kept}`
    : `The previous run left no shutdown record, so it was closed by force, by a crash or by the computer shutting down. No agent is recorded as mid-turn. ${kept}`
  return { kind: 'last-exit', code: 'LAST_EXIT_NOT_RECORDED',
    heading: 'The app did not close normally last time', body,
    pathLabel: null, path: null, dismissLabel: 'Dismiss this notice for this window' }
}

/**
 * The window notice's source with the previous exit folded in. With no shell
 * (a plain browser) this is null and nothing mounts, exactly as before; with
 * only the settings source it behaves exactly as that source does.
 */
export function lastExitNoticeSource({
  prefsNotice = typeof window === 'undefined' ? null : window.mcPrefsNotice,
  bridge = typeof window === 'undefined' ? null : window.mcSettings,
  storage = typeof window === 'undefined' ? null : window.localStorage,
  computerIds = [],
} = {}) {
  const hasPrefs = typeof prefsNotice?.read === 'function'
  if (!hasPrefs && typeof bridge?.diagnosticsInspect !== 'function') return null
  let lastExit = null
  const listeners = new Set()
  const fold = state => (lastExit ? { ...(state && typeof state === 'object' ? state : {}), lastExit } : state)
  const read = () => fold(hasPrefs ? prefsNotice.read() : null)
  const emit = state => { for (const listener of [...listeners]) { try { listener(fold(state)) } catch { /* a notice is not worth a throw */ } } }
  let unsubscribePrefs = () => {}
  if (hasPrefs && typeof prefsNotice.subscribe === 'function') {
    try { unsubscribePrefs = prefsNotice.subscribe(emit) || (() => {}) } catch { unsubscribePrefs = () => {} }
  }
  /* The saved trees are read NOW, before any store in this window rewrites a
     record and closes the clocks this looks at; the listing is asked after. */
  const records = midTurnRecords({ storage, computerIds })
  const settled = (async () => {
    try {
      const listing = await readDiagnosticRows(bridge)
      if (!listing) return null
      const exit = previousExit(listing.rows, listing.ownPid)
      if (!exit.known || !exit.ungraceful) return exit
      lastExit = { agents: agentsMidTurn(records, exit.startedAt) }
      let state = null
      try { state = hasPrefs ? prefsNotice.read() : null } catch { return exit }
      emit(state)
      return exit
    } catch { return null }
  })()
  return { read,
    subscribe(listener) { if (typeof listener !== 'function') return () => {}; listeners.add(listener); return () => listeners.delete(listener) },
    settled, destroy() { listeners.clear(); try { unsubscribePrefs() } catch { /* already gone */ } } }
}
