/* THE NEW AGENT TABS THAT ARE OPEN, WRITTEN DOWN (B4, 1.0.48).
 *
 * The rule is that a New agent tab comes back after ToolsEnabled is
 * closed and reopened. Until now the only record of an open tab
 * was a WeakMap keyed by the page's document (src/tree-workspace.js), which a
 * restart or a reload empties, and nothing on disk could tell an open tab from
 * one the person closed after sending: both keep a seat and a saved
 * conversation. This list is that record.
 *
 * WHERE IT LIVES. One ordinary settings key per tree computer,
 * `mc.fleet.standalone-tabs.v1:<computer id>`. Ordinary keys are written
 * synchronously (public/durable-storage.js onto shell/renderer-prefs.cjs), so a
 * crash right after a tab opens still brings it back. The prefix sits in the
 * `mc.fleet.*.v1:` family so the privacy cleanup that removes saved trees and
 * conversations removes this list with them.
 *
 * WHAT A ROW HOLDS. Only what a restart cannot learn anywhere else: the seat
 * id, the tab's name, the program and effort it was set to, when it opened,
 * and the last session it confirmed (so a page reload can close a session the
 * old page left running). Array order is tab order. A row that fails a check
 * is dropped on its own; one bad row never costs the others.
 *
 * DAMAGE IS NOT EMPTINESS. Bytes that do not parse, or a version this copy does
 * not know, read as unreadable, and ids() then answers null. The seat sweep
 * refuses on null rather than reading it as "no tab is open", because releasing
 * the seat of a tab that is about to come back is the loss this list exists to
 * prevent. */
import { STANDALONE_SEAT_ID } from './orphaned-node-seat-sweep.js'

export const STANDALONE_TABS_PREFIX = 'mc.fleet.standalone-tabs.v1:'
export const STANDALONE_TABS_LIMIT = 64
const NAME_LIMIT = 80
const TEXT_LIMIT = 128
const UNREADABLE = Object.freeze({ ok: false, code: 'STANDALONE_TABS_UNREADABLE', tabs: Object.freeze([]) })

// undefined means "fails the check"; null means "not set".
const optionalText = value => value === undefined || value === null ? null
  : typeof value === 'string' && value.length <= TEXT_LIMIT ? value : undefined

function cleanTab(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null
  if (typeof row.id !== 'string' || !STANDALONE_SEAT_ID.test(row.id)) return null
  if (typeof row.name !== 'string' || row.name.length < 1 || row.name.length > NAME_LIMIT) return null
  const tier = optionalText(row.tier), effort = optionalText(row.effort), sessionId = optionalText(row.sessionId)
  if (tier === undefined || effort === undefined || sessionId === undefined) return null
  const openedAt = row.openedAt === undefined || row.openedAt === null ? null
    : Number.isFinite(row.openedAt) ? row.openedAt : undefined
  if (openedAt === undefined) return null
  return { id: row.id, name: row.name, tier, effort, openedAt, sessionId }
}

function cleanTabs(rows) {
  const seen = new Set(), tabs = []
  for (const row of rows) {
    const tab = cleanTab(row)
    if (!tab || seen.has(tab.id)) continue
    seen.add(tab.id)
    tabs.push(tab)
    if (tabs.length >= STANDALONE_TABS_LIMIT) break
  }
  return tabs
}

function readList(storage, key) {
  let raw
  try { raw = storage.getItem(key) } catch { return UNREADABLE }
  if (raw === null || raw === undefined) return { ok: true, tabs: [] }
  let parsed
  try { parsed = JSON.parse(raw) } catch { return UNREADABLE }
  if (!parsed || typeof parsed !== 'object' || parsed.v !== 1 || !Array.isArray(parsed.tabs)) return UNREADABLE
  return { ok: true, tabs: cleanTabs(parsed.tabs) }
}

export const standaloneTabsKey = computerId => STANDALONE_TABS_PREFIX + computerId

/* Null when there is nowhere to write (no storage, or no computer to key it by):
   the caller then keeps the tab for this run only, exactly as before 1.0.48. */
export function createStandaloneTabLedger({ storage = null, computerId = null } = {}) {
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') return null
  if (typeof computerId !== 'string' || !computerId) return null
  const key = standaloneTabsKey(computerId)
  const read = () => readList(storage, key)
  // Durable storage THROWS on a refused write; every write answers false instead.
  const write = tabs => {
    try {
      if (tabs.length === 0 && typeof storage.removeItem === 'function') storage.removeItem(key)
      else storage.setItem(key, JSON.stringify({ v: 1, tabs }))
      return true
    } catch { return false }
  }
  return {
    key,
    read,
    ids() {
      const list = read()
      return list.ok ? new Set(list.tabs.map(tab => tab.id)) : null
    },
    /* Adds a tab at the end, or replaces the row with the same id in place.
       A damaged list is started again with this tab: what it held could not be
       reopened anyway (the page said so when it loaded), and leaving it damaged
       would stop every later tab from being remembered. */
    remember(entry) {
      const tab = cleanTab(entry)
      if (!tab) return false
      const list = read()
      const tabs = list.ok ? list.tabs : []
      const index = tabs.findIndex(row => row.id === tab.id)
      if (index >= 0) tabs[index] = tab
      else if (tabs.length >= STANDALONE_TABS_LIMIT) return false
      else tabs.push(tab)
      return write(tabs)
    },
    /* Changes a tab the list already holds; never creates one. */
    update(id, patch = {}) {
      const list = read()
      if (!list.ok || !patch || typeof patch !== 'object') return false
      const index = list.tabs.findIndex(row => row.id === id)
      if (index < 0) return false
      const changes = Object.fromEntries(['name', 'tier', 'effort', 'sessionId']
        .filter(field => Object.hasOwn(patch, field)).map(field => [field, patch[field]]))
      const tab = cleanTab({ ...list.tabs[index], ...changes })
      if (!tab) return false
      list.tabs[index] = tab
      return write(list.tabs)
    },
    forget(id) {
      const list = read()
      if (!list.ok) return false
      if (!list.tabs.some(row => row.id === id)) return true
      return write(list.tabs.filter(row => row.id !== id))
    },
  }
}

/* EVERY COMPUTER'S OPEN TABS, for the seat sweep. Seats belong to one
 * organisation per install while these lists are per tree computer, so a seat
 * held by a tab on a computer that is not on screen this load must still count
 * as held. Null when any list is damaged. Storage that cannot list its keys
 * falls back to the current computer's own list. */
export function standaloneTabIdsEverywhere(storage, current = null) {
  const fallback = () => current ? current.ids() : new Set()
  let count
  try { count = storage?.length } catch { return fallback() }
  if (typeof storage?.key !== 'function' || typeof storage.getItem !== 'function'
    || !Number.isSafeInteger(count) || count < 0) return fallback()
  const keys = []
  try {
    for (let index = 0; index < count; index++) {
      const key = storage.key(index)
      if (typeof key === 'string' && key.startsWith(STANDALONE_TABS_PREFIX)) keys.push(key)
    }
  } catch { return fallback() }
  const ids = new Set()
  for (const key of keys) {
    const list = readList(storage, key)
    if (!list.ok) return null
    for (const tab of list.tabs) ids.add(tab.id)
  }
  return ids
}

/* WHAT A RUNNING TAB IS CALLED, FOR SURFACES OUTSIDE THE WORKSPACE (B28).
 *
 * Home's voice card is handed running sessions as { sessionId, agentId } and
 * names them through the tree's saved session roles. A New agent tab is not
 * on the tree, so that lookup misses and the card showed the seat id
 * ("standalone-<uuid>"). This list already holds the tab's name, keyed
 * by its seat, with the last session it confirmed. Every computer's list is
 * read; a damaged list costs only its own names, and storage that cannot be
 * read answers no names at all (the caller then says a plain word). */
export function readStandaloneTabNames(storage) {
  const bySeat = new Map(), bySession = new Map()
  const names = { bySeat, bySession }
  let count
  try { count = storage?.length } catch { return names }
  if (typeof storage?.key !== 'function' || typeof storage.getItem !== 'function'
    || !Number.isSafeInteger(count) || count < 0) return names
  const keys = []
  try {
    for (let index = 0; index < count; index++) {
      const key = storage.key(index)
      if (typeof key === 'string' && key.startsWith(STANDALONE_TABS_PREFIX)) keys.push(key)
    }
  } catch { return names }
  for (const key of keys) {
    const list = readList(storage, key)
    if (!list.ok) continue
    for (const tab of list.tabs) {
      bySeat.set(tab.id, tab.name)
      if (tab.sessionId) bySession.set(tab.sessionId, tab.name)
    }
  }
  return names
}

/* A running session's tab name from readStandaloneTabNames, or ''. The seat
   is the tab's identity; the session is the fallback for a row that carries
   no seat. */
export function standaloneTabNameFor(row, names) {
  const bySeat = names?.bySeat?.get?.(row?.agentId)
  if (bySeat) return bySeat
  return (typeof row?.sessionId === 'string' && names?.bySession?.get?.(row.sessionId)) || ''
}

/* THE PLAIN WORD FOR A RUNNING AGENT NOTHING NAMES. Never its id: a seat id or
   a node id means nothing to the person choosing who to talk to or who may use
   the mouse. A + agent's seat reads as the kind of thing it is. */
export const UNNAMED_TAB_LABEL = 'New agent tab'
export const UNNAMED_AGENT_LABEL = 'Agent'
export function unnamedAgentLabel(agentId) {
  return typeof agentId === 'string' && /^standalone-/i.test(agentId) ? UNNAMED_TAB_LABEL : UNNAMED_AGENT_LABEL
}
