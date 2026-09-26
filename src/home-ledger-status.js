import { kindOf } from './ledger-live.js'

const CLOSED = new Set(['done', 'answered', 'approved', 'recorded', 'declined', 'removed', 'superseded', 'not-possible-as-asked', 'cancelled'])
const BLOCKED = new Set(['blocked-external', 'blocked'])
const ACTIVE = new Set(['open', 'in-progress', 'partial', 'recurring', 'proposed', ...BLOCKED])

/* WHICH OF THE OWNER'S TWO WAITING COLOURS A SINGLE RECORD EARNS, and null
   for every record that earns neither. This is the rule homeLedgerStatus has
   always applied inside its own loop; it is a function now because the Ledger
   register needs the SAME answer per row that Home's circle reaches for the
   whole ledger, and two copies of a classification are two things to get
   wrong. The loop below is its only other caller and calls it -- it does not
   restate it.

   The return words are the picker's own status names (src/home-status-colors.js
   HOME_STATUS_COLOR_SETTINGS), not new ones, so a caller can go straight from
   this answer to `--home-ledger-<answer>` with nothing to translate.

   'blocked' beats 'attention' the same way it does in the aggregate: a record
   cannot be both, and the one the owner is stuck on is the one that shows. */
export function ownerWaitingStatus(record) {
  if (!record || typeof record.id !== 'string' || record.id === '') return null
  if (record.removed || record.removedAt || CLOSED.has(record.status)) return null
  if (BLOCKED.has(record.status)) return 'blocked'
  if (record.status === 'proposed') return 'attention'
  if (['A', 'P'].includes(kindOf(record)) && record.status === 'open') return 'attention'
  return null
}

// Read the same canonical records as Ledger. Do not infer owner blockers
// from machine health, a tool failure, prose, age, or an unfinished task.
export function homeLedgerStatus({ ledger, prompts, nowMs = Date.now() } = {}) {
  /* NOT ASKED YET IS NOT A FAILURE (T1478). Home starts every visit with this
     empty summary and replaces it when the two reads return; on a busy app
     that took seconds, and all that time the row said the ledger could not be
     read. Until a read has answered, the row says it is still checking; a read
     that answered badly still says it could not read the ledger. */
  if (ledger === undefined && prompts === undefined) {
    return { status: 'unknown', label: 'Checking the ledger', title: 'Open Ledger', asks: 0, blockers: 0, complete: false, checking: true }
  }
  const ledgerKnown = ledger?.ok === true && Array.isArray(ledger.records) && ledger.chain?.ok !== false
  const promptsKnown = prompts?.ok === true && Array.isArray(prompts.prompts)
  const asks = new Set(), blockers = new Set()
  let recordsKnown = ledgerKnown
  if (ledgerKnown) {
    for (const record of ledger.records) {
      if (record?.removed || record?.removedAt || CLOSED.has(record?.status)) continue
      if (!record || typeof record.id !== 'string' || !record.id || !ACTIVE.has(record.status)) { recordsKnown = false; continue }
      const waiting = ownerWaitingStatus(record)
      if (waiting === 'blocked') blockers.add(record.id)
      else if (waiting === 'attention') asks.add(record.id)
    }
  }
  if (promptsKnown) {
    for (const prompt of prompts.prompts) {
      if (!prompt || prompt.state !== 'pending' || !['confirmation', 'purchase_batch'].includes(prompt.kind)) continue
      if (!Number.isFinite(Date.parse(prompt.expiresAt)) || Date.parse(prompt.expiresAt) <= nowMs) continue
      asks.add(prompt.id)
    }
  }
  const complete = recordsKnown && promptsKnown
  const status = blockers.size ? 'blocked' : asks.size ? 'attention' : complete ? 'clear' : 'unknown'
  const label = status === 'blocked'
    ? `${blockers.size} blocked ${blockers.size === 1 ? 'ledger item' : 'ledger items'}`
    : status === 'attention'
      ? `${asks.size} owner ${asks.size === 1 ? 'request' : 'requests'} to review`
      /* `unknown` is not "nothing is waiting", it is "we could not read the
         records" -- ledger.ok was false, the chain did not verify, or a record
         came back malformed. The old label said only that something was
         unavailable, which tells a person what failed and nothing they can do
         about it. The row is the control that opens Ledger, so that is the
         next step and it belongs in the words. */
      : status === 'clear' ? 'No owner requests waiting' : 'Could not read the ledger. Open Ledger to check.'
  const title = complete ? 'Open Ledger' : `${label}. Some ledger information could not be read.`
  return { status, label, title, asks: asks.size, blockers: blockers.size, complete, checking: false }
}

/* WHERE HOME'S LEDGER LINE LEADS (T1344): to the records it counts. "103
   blocked ledger items" used to open the Ledger on whatever tab was last
   used, unfiltered, with most of the 103 on another tab. The Ledger reads
   `waiting` and lists exactly the records this module counts, across kinds. */
export function ledgerStatusHref(status) {
  return status === 'blocked' || status === 'attention' ? `#/ledger?waiting=${status}` : '#/ledger'
}

export async function readHomeLedger(agent = globalThis.mcAgent) {
  if (typeof agent?.ledger !== 'function') return { ok: false }
  try { return await agent.ledger({ scope: 'all', key: null, removed: false }) }
  catch { return { ok: false } }
}
