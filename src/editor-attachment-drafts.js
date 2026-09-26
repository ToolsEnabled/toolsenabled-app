import { EDITOR_ATTACHMENT_REFUSALS } from './editor-attachment-copy.js'
import { offeredEffort } from './orchestration-controls.js'

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TOKEN = /^[A-Za-z0-9_-]{43}$/
const refusal = code => ({ ok: false, code, reason: EDITOR_ATTACHMENT_REFUSALS[code] })

// Persist only the fact that a draft requires a source. Expiring authority
// stays in this window's memory and is checked again by the shell at Start.
export function normalizePendingEditorFork(value) {
  if (value === null || value === undefined) return null
  if (!value || typeof value !== 'object' || Array.isArray(value) || !['codex', 'claude'].includes(value.provider)
      || !ID.test(value.sourceSessionId || '') || typeof value.workspace !== 'string' || value.workspace.length > 160
      || /[\r\n\0]/.test(value.workspace)) return Object.freeze({ invalid: true })
  return Object.freeze({ provider: value.provider, sourceSessionId: value.sourceSessionId,
    workspace: value.workspace, model: typeof value.model === 'string' ? value.model.slice(0, 64) : null,
    ...(['current-model-context', 'saved-conversation'].includes(value.historyScope) ? { historyScope: value.historyScope } : {}) })
}

const DATED_MODEL = /-\d{8}$/
export function editorForkTier(tiers, pending) {
  const model = typeof pending?.model === 'string' ? pending.model.trim() : ''
  if (!model) return null
  const undated = model.replace(DATED_MODEL, '')
  return (Array.isArray(tiers) ? tiers : []).find(row => row?.provider === pending.provider
    && [model, undated].some(name => name && (row.model === name || row.cliModel === name))) || null
}

export function createEditorAttachmentDrafts({ now = Date.now } = {}) {
  let pending = null
  const bound = new Map()
  const keyOf = (computerId, nodeId) => `${computerId}\0${nodeId}`
  function queue(prepared) {
    const source = normalizePendingEditorFork(prepared)
    if (!source || source.invalid || !TOKEN.test(prepared.forkReceipt || '') || !(prepared.expiresAt > now())) return refusal('EDITOR_RECEIPT_UNAVAILABLE')
    pending = { ...prepared, source }
    return { ok: true }
  }
  function install(store, { computerId, local, tiers = [] } = {}) {
    if (!pending) return null
    if (!local) return refusal('EDITOR_FORK_LOCAL_ONLY')
    if (pending.expiresAt <= now()) { pending = null; return refusal('EDITOR_RECEIPT_UNAVAILABLE') }
    /* THE ROW THAT RUNS THE EDITOR'S OWN MODEL, OR NONE (1.0.48, D8). The
       editor records the model's raw id -- Claude Code writes
       `claude-opus-5-5`, never `claude/claude-opus-5-5` -- so a row matches on
       its CLI name as well as its model, and on the dated form Claude serves
       (`claude-haiku-4-5-20251001`). A copy whose model no row runs is
       REFUSED: it used to fall to the provider's first row, which put an Opus
       5.5 conversation on Fable without a word. */
    /* NO MODEL SEEN IS NOT AN UNKNOWN MODEL (review P17). The editor source
       reports model null when no model id was observed in the window it
       scanned; "Update ToolsEnabled" could not help that person. */
    if (typeof pending.model !== 'string' || !pending.model.trim()) return refusal('EDITOR_FORK_MODEL_UNREAD')
    const tier = editorForkTier(tiers, pending)
    if (!tier) return refusal(tiers.some(row => row.provider === pending.provider)
      ? 'EDITOR_FORK_MODEL_UNAVAILABLE' : 'EDITOR_FORK_PROVIDER_MISMATCH')
    let node = store.snapshot().nodes.find(row => row.status === 'draft'
      && row.pendingEditorFork?.sourceSessionId === pending.sourceSessionId && row.pendingEditorFork?.provider === pending.provider)
    if (!node) {
      const added = store.addNode({ tier: tier.id,
        /* The editor's depth, only where that model takes it (D4). */
        effort: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(pending.effort) ? offeredEffort(tier, pending.effort) : '',
        pendingEditorFork: pending.source,
        role: typeof pending.role === 'string' ? pending.role : '',
        message: typeof pending.message === 'string' ? pending.message : 'This is a separate copy of my editor conversation. Wait for my next request.' })
      if (added?.ok !== true || added.snapshot?.persistenceFailed) return { ok: false,
        reason: added?.snapshot?.persistenceProblem || added?.problems?.[0] || 'The editor copy draft could not be saved.' }
      node = added.node
    }
    bound.set(keyOf(computerId, node.id), pending)
    pending = null
    return { ok: true, node }
  }
  function forNode(node, computerId) {
    if (!node?.pendingEditorFork) return { ok: true, receipt: null }
    const prepared = bound.get(keyOf(computerId, node.id))
    if (!prepared || prepared.expiresAt <= now() || node.pendingEditorFork.invalid
        || prepared.sourceSessionId !== node.pendingEditorFork.sourceSessionId
        || prepared.provider !== node.pendingEditorFork.provider) return refusal('EDITOR_RECEIPT_UNAVAILABLE')
    return { ok: true, receipt: prepared.forkReceipt }
  }
  function forget(nodeId, computerId) { bound.delete(keyOf(computerId, nodeId)) }
  return Object.freeze({ queue, install, forNode, forget })
}

export const editorAttachmentDrafts = createEditorAttachmentDrafts()
