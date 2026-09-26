// The writable half of the research queue.
//
// The shipped catalog (/data/research-queue.json) is authored data: the app
// renders it but never edits it. What a researcher adds at the bench lives in
// ONE bounded account-settings row instead — `research_queue`, a JSON string
// `{ v: 1, items: [...], statusOverrides: { <authoredId>: status } }` — so
// their notes belong to their account, survive reinstalls with it, and stay
// inside the 64 KiB value bound the settings store already enforces.
//
// `items` are the researcher's own notes, validated with the SAME field caps
// the shipped schema uses (a note the shipped validator would reject has no
// business being rendered beside items it accepted). `statusOverrides` is how
// an authored item's lifecycle finally means something: advancing a shipped
// item stores its new status here, and the merge applies it at render.
//
// Every refusal is a sentence a person can act on, never a code.

export const RESEARCH_QUEUE_ROW_KEY = 'research_queue'
export const OWN_PROVENANCE = 'written-here'
export const QUEUE_STATUS_ORDER = Object.freeze(['queued', 'in-progress', 'complete'])

const MAX_OWN_ITEMS = 100
const MAX_SERIALIZED = 60_000

const CAPS = Object.freeze({ title: 240, observation: 2000, researchQuestion: 1000 })

function cleanText(value, cap) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > cap) return null
  return trimmed
}

/** Parse the stored row. A damaged row degrades to empty rather than hiding
 *  the shipped queue behind a parse error — but says so via `damaged`. */
export function parseQueueRow(raw) {
  const empty = { items: [], statusOverrides: {}, damaged: false }
  if (raw === null || raw === undefined || raw === '') return empty
  let parsed
  try { parsed = JSON.parse(raw) } catch { return { ...empty, damaged: true } }
  if (!parsed || parsed.v !== 1 || typeof parsed !== 'object') return { ...empty, damaged: true }
  const items = Array.isArray(parsed.items)
    ? parsed.items.filter(item => item && typeof item === 'object'
        && typeof item.id === 'string' && QUEUE_STATUS_ORDER.includes(item.status)
        && cleanText(item.title, CAPS.title) && cleanText(item.observation, CAPS.observation)
        && cleanText(item.researchQuestion, CAPS.researchQuestion))
    : []
  const statusOverrides = {}
  if (parsed.statusOverrides && typeof parsed.statusOverrides === 'object' && !Array.isArray(parsed.statusOverrides)) {
    for (const [id, status] of Object.entries(parsed.statusOverrides)) {
      if (typeof id === 'string' && id.length <= 120 && QUEUE_STATUS_ORDER.includes(status)) {
        statusOverrides[id] = status
      }
    }
  }
  return { items, statusOverrides, damaged: false }
}

export function serializeQueueRow({ items, statusOverrides }) {
  if (items.length === 0 && Object.keys(statusOverrides).length === 0) return null
  return JSON.stringify({ v: 1, items, statusOverrides })
}

/** Build a new own-item, or answer the sentence that refuses it. */
export function buildOwnItem({ title, observation, researchQuestion }, existing) {
  const cleanTitle = cleanText(title, CAPS.title)
  if (!cleanTitle) return { ok: false, sentence: `Write a title first — up to ${CAPS.title} characters.` }
  const cleanObservation = cleanText(observation, CAPS.observation)
  if (!cleanObservation) return { ok: false, sentence: `Write what you noticed first — up to ${CAPS.observation} characters.` }
  const cleanQuestion = cleanText(researchQuestion, CAPS.researchQuestion)
  if (!cleanQuestion) return { ok: false, sentence: `Write the research question first — up to ${CAPS.researchQuestion} characters.` }
  if (existing.items.length >= MAX_OWN_ITEMS) {
    return { ok: false, sentence: `This queue holds at most ${MAX_OWN_ITEMS} of your own notes. Complete or remove one first.` }
  }
  const item = {
    id: `own-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${existing.items.length}`}`,
    title: cleanTitle,
    status: 'queued',
    provenance: OWN_PROVENANCE,
    observation: cleanObservation,
    researchQuestion: cleanQuestion,
  }
  const next = { items: [...existing.items, item], statusOverrides: existing.statusOverrides }
  const serialized = serializeQueueRow(next)
  if (serialized && serialized.length > MAX_SERIALIZED) {
    return { ok: false, sentence: 'Your notes have filled the space this account file gives them. Complete or remove one first.' }
  }
  return { ok: true, item, next, serialized }
}

/** The next status in the lifecycle, or null at the end of it. */
export function nextStatus(status) {
  const at = QUEUE_STATUS_ORDER.indexOf(status)
  return at >= 0 && at < QUEUE_STATUS_ORDER.length - 1 ? QUEUE_STATUS_ORDER[at + 1] : null
}

/** Advance one item — own items in place, authored items via override. */
export function advanceItem(state, { id, own, currentStatus }) {
  const to = nextStatus(currentStatus)
  if (!to) return { ok: false, sentence: 'This item is already complete.' }
  const next = own
    ? {
        items: state.items.map(item => item.id === id ? { ...item, status: to } : item),
        statusOverrides: state.statusOverrides,
      }
    : {
        items: state.items,
        statusOverrides: { ...state.statusOverrides, [id]: to },
      }
  const serialized = serializeQueueRow(next)
  if (serialized && serialized.length > MAX_SERIALIZED) {
    return { ok: false, sentence: 'Your notes have filled the space this account file gives them. Complete or remove one first.' }
  }
  return { ok: true, to, next, serialized }
}

/** Remove one OWN item. Authored items are shipped data and cannot be removed. */
export function removeOwnItem(state, id) {
  const remaining = state.items.filter(item => item.id !== id)
  if (remaining.length === state.items.length) {
    return { ok: false, sentence: 'That note is not yours to remove — shipped items stay in the catalog.' }
  }
  const next = { items: remaining, statusOverrides: state.statusOverrides }
  return { ok: true, next, serialized: serializeQueueRow(next) }
}

/** Merge for render: the researcher's own notes first (newest last), then the
 *  authored catalog with overrides applied. */
export function mergeQueueForRender(authoredItems, state) {
  const authored = authoredItems.map(item => Object.prototype.hasOwnProperty.call(state.statusOverrides, item.id)
    ? { ...item, status: state.statusOverrides[item.id] }
    : item)
  return [...state.items.map(item => ({ ...item, own: true })), ...authored]
}
