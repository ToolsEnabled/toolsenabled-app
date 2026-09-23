import { liveContextSize, TREE_CONTEXT_SIZES as CARD_SIZES, TREE_CONTEXT_SIZE_KEY } from './tree-box-layout.js'

export const TREE_CONTEXT_CARDS_KEY = 'mc.tree.context-cards.v1'
export const TREE_CONTEXT_BOX_SIZE_KEY = 'mc.tree.context-box-size.v1'
export const TREE_CONTEXT_CARDS_EVENT = 'tree-context-cards-change'
export const DEFAULT_TREE_CONTEXT_SIZE = 'medium'
// Every size keeps its own content budget; Mini retains one line of actual context.
const CONTEXT_LINES = Object.freeze({
  mini: Object.freeze({ chatLines: 1, thinkingLines: 0 }),
  small: Object.freeze({ chatLines: 2, thinkingLines: 0 }),
  medium: Object.freeze({ chatLines: 3, thinkingLines: 1 }),
  large: Object.freeze({ chatLines: 6, thinkingLines: 2 }),
})
export const TREE_CONTEXT_SIZES = Object.freeze([
  ...Object.entries(CARD_SIZES).map(([value, profile]) => Object.freeze({
    value, label: profile.label, ...profile.card, currentLines: 1, ...CONTEXT_LINES[value],
  })),
  Object.freeze({ value: 'off', label: 'Off', width: 0, height: 0, currentLines: 0, chatLines: 0, thinkingLines: 0 }),
])
const validSize = value => TREE_CONTEXT_SIZES.some(row => row.value === value)
const liveSize = value => (value === 'off' ? 'off' : liveContextSize(value))
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
const defaultRecord = (size = DEFAULT_TREE_CONTEXT_SIZE) => ({ version: 1, defaultSize: validSize(size) ? size : DEFAULT_TREE_CONTEXT_SIZE, trees: {} })
export const treeContextKey = (computerId, treeId = 'organisation') => JSON.stringify([String(computerId || 'local'), String(treeId || 'organisation')])
export const agentTreeContextKey = (computerId, agent) => treeContextKey(computerId, agent?.treeNode?.treeId || agent?.treeId)
export function agentTreeContextKeys(computerId, agent, scope = null) {
  if (!agent?.treeScope?.group || !scope?.groups?.has(agent.id)) return [agentTreeContextKey(computerId, agent)]
  return [...new Set(scope.branch(agent.id).map(id => scope.byId.get(id)).filter(Boolean)
    .map(member => agentTreeContextKey(computerId, member)))]
}
function validKey(value) {
  try { const key = JSON.parse(value); return Array.isArray(key) && key.length === 2 && key.every(part => typeof part === 'string' && part.length > 0 && part.length <= 200) } catch { return false }
}
function parseRecord(raw, maxLength = 30000) {
  if (typeof raw !== 'string' || raw.length > maxLength) throw new Error('Record too large')
  const record = JSON.parse(raw)
  if (!plain(record) || record.version !== 1 || !liveSize(record.defaultSize) || !plain(record.trees)
    || Object.keys(record).some(key => !['version', 'defaultSize', 'trees'].includes(key))
    || Object.entries(record.trees).some(([key, value]) => !validKey(key) || !liveSize(value)) || Object.keys(record.trees).length > 512) throw new Error('Invalid record')
  return { version: 1, defaultSize: liveSize(record.defaultSize),
    trees: Object.fromEntries(Object.entries(record.trees).map(([key, value]) => [key, liveSize(value)])) }
}
function readBoxMemories(storage) {
  const raw = storage.getItem(TREE_CONTEXT_BOX_SIZE_KEY)
  if (raw == null) return []
  // Two bounded policy objects fit the native preference's 64 KiB value cap.
  if (typeof raw !== 'string' || raw.length > 65536) throw new Error('Box memory too large')
  const value = JSON.parse(raw)
  if (!plain(value) || value.version !== 1 || Object.keys(value).some(key => !['version', 'entries'].includes(key))
    || !Array.isArray(value.entries) || value.entries.length > 2
    || value.entries.some(entry => !plain(entry) || Object.keys(entry).some(key => !['policy', 'size'].includes(key))
      // Preserve bounded per-tree policy records.
      || typeof entry.size !== 'string' || !Object.hasOwn(CARD_SIZES, entry.size) || parseRecord(JSON.stringify(entry.policy), 30512).defaultSize !== 'off')
    || new Set(value.entries.map(entry => JSON.stringify(entry.policy))).size !== value.entries.length) throw new Error('Invalid box memory')
  return value.entries
}
export function readTreeContextCards(storage, fallbackSize = DEFAULT_TREE_CONTEXT_SIZE) {
  try {
    if (storage === undefined) storage = globalThis.localStorage
    if (typeof storage?.getItem !== 'function') throw new Error('Storage unavailable')
    const raw = storage.getItem(TREE_CONTEXT_CARDS_KEY)
    const legacySize = () => {
      try { return liveContextSize(storage.getItem(TREE_CONTEXT_SIZE_KEY)) }
      catch { return null }
    }
    // Keep the strict v1 record unchanged for older readers. Off remembers its
    // box geometry in a separate versioned preference bound to canonical v1 content.
    // A downgrade's different policy cannot accidentally inherit stale memory.
    const record = raw == null ? defaultRecord(legacySize() || fallbackSize) : parseRecord(raw)
    const memories = readBoxMemories(storage)
    const boxSize = liveContextSize(record.defaultSize) || memories.find(entry => JSON.stringify(entry.policy) === JSON.stringify(record))?.size
      || legacySize() || DEFAULT_TREE_CONTEXT_SIZE
    // Reading never rewrites saved preferences.
    return { ok: true, record, boxSize }
  } catch { return { ok: false, record: defaultRecord(), reason: 'Saved context-card settings could not be read. Your saved choices have not been replaced.' } }
}
export function treeContextProfile(record, key = null) {
  const size = key && record?.trees?.[key] || record?.defaultSize || DEFAULT_TREE_CONTEXT_SIZE
  return TREE_CONTEXT_SIZES.find(row => row.value === size) || TREE_CONTEXT_SIZES.find(row => row.value === DEFAULT_TREE_CONTEXT_SIZE)
}
export function updateTreeContextCards(change, { storage, eventTarget = globalThis.window } = {}) {
  try { if (storage === undefined) storage = globalThis.localStorage } catch { return readTreeContextCards(null) }
  const existing = readTreeContextCards(storage)
  if (!existing.ok) return existing
  if (!plain(change) || Object.keys(change).some(key => !['defaultSize', 'treeKeys', 'size', 'resetTrees'].includes(key))
    || Object.hasOwn(change, 'defaultSize') && !validSize(change.defaultSize)
    || Object.hasOwn(change, 'resetTrees') && typeof change.resetTrees !== 'boolean'
    || Object.hasOwn(change, 'size') && !Object.hasOwn(change, 'treeKeys')
    || Object.hasOwn(change, 'treeKeys') && (!Array.isArray(change.treeKeys) || !change.treeKeys.length || change.treeKeys.some(key => !validKey(key)) || !validSize(change.size) && change.size !== 'default')) return { ok: false, reason: 'Choose Mini, Small, Medium, Large, or Off.' }
  const record = { ...existing.record, ...(change.defaultSize ? { defaultSize: change.defaultSize } : {}), trees: change.resetTrees ? {} : { ...existing.record.trees } }
  for (const key of change.treeKeys || []) {
    if (change.size === 'default') delete record.trees[key]
    else record.trees[key] = change.size
  }
  const serialized = JSON.stringify(record)
  const boxSize = liveContextSize(record.defaultSize) || existing.boxSize
  if (serialized === JSON.stringify(existing.record)) return { ok: true, record: existing.record, boxSize }
  if (Object.keys(record.trees).length > 512 || serialized.length > 30000) return { ok: false, reason: 'Too many tree-specific card settings. Reset tree overrides in Settings before adding more.' }
  try {
    if (typeof storage?.setItem !== 'function') throw new Error('Storage unavailable')
    if (record.defaultSize === 'off') {
      // Prepare next memory before committing v1. Keep the previous Off entry
      // too: failure of the second write must leave the active sizes unchanged.
      // Cross-window storage events also see only a matching committed entry.
      const entries = existing.record.defaultSize === 'off'
        ? [{ policy: existing.record, size: existing.boxSize }] : []
      entries.push({ policy: record, size: boxSize })
      storage.setItem(TREE_CONTEXT_BOX_SIZE_KEY, JSON.stringify({ version: 1, entries }))
    }
    storage.setItem(TREE_CONTEXT_CARDS_KEY, serialized)
  } catch { return { ok: false, reason: 'Context-card settings could not be saved. The previous sizes are still active.' } }
  if (typeof eventTarget?.dispatchEvent === 'function') {
    const EventClass = eventTarget.CustomEvent || globalThis.CustomEvent
    if (EventClass) eventTarget.dispatchEvent(new EventClass(TREE_CONTEXT_CARDS_EVENT, { detail: { record, boxSize } }))
  }
  return { ok: true, record, boxSize }
}
