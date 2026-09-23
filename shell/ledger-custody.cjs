'use strict'

const path = require('node:path')
const PAYLOAD_OWNER_REQUEST_STORE_MODULE = 'src/lib/owner-request-store.js'
const REASONS = Object.freeze({
  AGENT_LEDGER_CUSTODY_UNAVAILABLE: 'Ledger history recovery is unavailable in this copy. Update ToolsEnabled and try again.',
  AGENT_LEDGER_CUSTODY_PERSON_REQUIRED: 'Only the person using this app window can adopt Ledger history.',
  AGENT_LEDGER_CUSTODY_INVALID: 'Review the Ledger history warning before confirming adoption.',
  R_LEDGER_ADOPTION_STALE: 'The Ledger changed. Review its history again before adopting it.',
  R_LEDGER_CHAIN_BROKEN: 'The saved Ledger history is damaged. Restore a preserved history copy before continuing.',
  R_LEDGER_CHAIN_UNAVAILABLE: 'The saved Ledger history could not be read. Check access to its files and try again.',
  R_LEDGER_CHAIN_RESERVATION_LOST: 'The Ledger history has lost previously recorded identities. Restore a preserved history copy before continuing.',
  R_LEDGER_CHAIN_APPEND_UNCONFIRMED: 'The Ledger history could not be adopted. Review it again before continuing.',
})
const refusal = code => ({ ok: false, code, reason: REASONS[code] || REASONS.AGENT_LEDGER_CUSTODY_UNAVAILABLE })
const validRevision = value => Number.isSafeInteger(value) && value >= 0
const validToken = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
/* WHICH RECORDS THE ADOPTION COVERS (T1548), as the store names them: an id,
   its kind, the start of its words and when it last changed. Bounded and
   checked here, so the window never receives more than the dialog shows. */
const previewRecords = value => (Array.isArray(value) ? value : [])
  .slice(0, 200)
  .filter(row => row && typeof row === 'object' && typeof row.id === 'string' && /^[RTAP]\d+(?:\.\d+)*$/.test(row.id))
  .map(row => Object.freeze({
    id: row.id,
    kind: ['R', 'T', 'A', 'P'].includes(row.kind) ? row.kind : row.id[0],
    words: typeof row.words === 'string' ? row.words.slice(0, 160) : '',
    changedAt: typeof row.changedAt === 'string' && row.changedAt.length <= 40 ? row.changedAt : null,
  }))

// The installed payload is loaded directly; no unshipped CLI or agent session
// is involved. Actor, store location and operation names never come from IPC.
function createLedgerCustody({ resolveCapabilityRoot, requireModule = require } = {}) {
  return Object.freeze({
    async run(operation, value, principal) {
      if (principal?.kind !== 'window' || principal.mayWrite !== true || !principal.owner) {
        return refusal('AGENT_LEDGER_CUSTODY_PERSON_REQUIRED')
      }
      if (!['preview', 'confirm'].includes(operation) || !value || typeof value !== 'object' || Array.isArray(value)) {
        return refusal('AGENT_LEDGER_CUSTODY_INVALID')
      }
      const keys = operation === 'preview' ? [] : ['revision', 'token']
      if (Object.keys(value).some(key => !keys.includes(key)) || (operation === 'confirm'
          && (!validRevision(value.revision) || !validToken(value.token)))) return refusal('AGENT_LEDGER_CUSTODY_INVALID')
      try {
        const root = resolveCapabilityRoot?.()
        if (!root) return refusal('AGENT_LEDGER_CUSTODY_UNAVAILABLE')
        const store = requireModule(path.join(root, PAYLOAD_OWNER_REQUEST_STORE_MODULE))
        if (typeof store?.previewUnconfirmedHistory !== 'function' || typeof store?.adoptUnconfirmedHistory !== 'function') {
          return refusal('AGENT_LEDGER_CUSTODY_UNAVAILABLE')
        }
        if (operation === 'preview') {
          const result = await store.previewUnconfirmedHistory({ actor: 'owner' })
          if (!validRevision(result?.revision) || !validRevision(result?.count) || !validToken(result?.token)) {
            return refusal('AGENT_LEDGER_CUSTODY_UNAVAILABLE')
          }
          return { ok: true, count: result.count, revision: result.revision, token: result.token, records: previewRecords(result.records) }
        }
        const result = await store.adoptUnconfirmedHistory({ actor: 'owner', revision: value.revision, token: value.token })
        if (!validRevision(result?.revision) || !Array.isArray(result?.adopted)) return refusal('AGENT_LEDGER_CUSTODY_UNAVAILABLE')
        return { ok: true, count: result.adopted.length, revision: result.revision }
      } catch (error) {
        return refusal(Object.hasOwn(REASONS, error?.code) ? error.code : 'AGENT_LEDGER_CUSTODY_UNAVAILABLE')
      }
    },
  })
}
module.exports = { createLedgerCustody, PAYLOAD_OWNER_REQUEST_STORE_MODULE }
