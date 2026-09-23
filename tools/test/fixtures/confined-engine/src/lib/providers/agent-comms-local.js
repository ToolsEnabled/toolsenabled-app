'use strict'

/* Inbox-only half of the host seam fixture. The real provider's addressing,
 * authentication and durable broker behavior are exercised in the engine
 * repository. Here a test can place one already-routed record into an inbox
 * and then observe whether the application host delivers it. */
const inboxes = new Map()
const floors = new Map()
const nextPages = new Map()
let sequence = 0

/* A READ THAT NEVER ANSWERS, ON DEMAND. MEASURED 2026-09-04 on the owner's
 * fourth tree: every circle's heartbeat stopped within 132 ms of every other's
 * and never resumed, which is the shape of the courier's one shared read
 * hanging inside the engine. While reads are held, inbox() waits on a promise
 * the test releases; the records placed meanwhile stay in the inbox so the
 * test can prove they are delivered exactly once when the read finally
 * answers. */
let held = null
let reads = 0

async function inbox({ agentId, cursor = 0, limit = 25 } = {}) {
  reads += 1
  if (held) await held.promise
  if (nextPages.has(agentId)) {
    const records = nextPages.get(agentId)
    nextPages.delete(agentId)
    return { page: { records } }
  }
  const floorSequence = floors.get(agentId) || 1
  if (cursor < floorSequence - 1) return { page: { status: 'TRUNCATED', floorSequence,
    headSequence: sequence, cursor, records: [] } }
  const records = (inboxes.get(agentId) || [])
    .filter(record => record.sequence > cursor)
    .slice(0, limit)
  return Object.freeze({ page: Object.freeze({ records: Object.freeze(records) }) })
}

function holdReads() {
  if (held) return
  let release = null
  const promise = new Promise(resolve => { release = resolve })
  held = { promise, release }
}

function releaseReads() {
  if (!held) return
  const { release } = held
  held = null
  release()
}

function readCount() {
  return reads
}

function deliver({ recipientAgentId, senderAgentId, body } = {}) {
  sequence += 1
  /* id and audience are what the REAL provider puts on an envelope, and what
     the host's own receipt paths read off it (acknowledgeTreeBatch keys on
     `message.envelope.audience.agent.agentId`, and acknowledgeTreeReads on the
     id as well). Omitting them here made this fixture quietly un-testable for
     anything that has to address the message back to its stream. */
  const record = Object.freeze({
    sequence,
    message: Object.freeze({
      id: `fixture-message-${sequence}`,
      sender: Object.freeze({ agentId: senderAgentId }),
      audience: Object.freeze({ type: 'direct', agent: Object.freeze({ agentId: recipientAgentId }) }),
      body,
    }),
  })
  const records = inboxes.get(recipientAgentId) || []
  records.push(record)
  inboxes.set(recipientAgentId, records)
  return record
}

/* THE READ RECEIPT DOOR, mirrored from the real provider's acknowledgeRead so
   the courier's call is observable here. Records what it was asked, and can be
   told to refuse or to throw, because "best effort" is only a claim until the
   failing paths are driven. */
const readReceipts = []
let readReceiptMode = 'accept'
function acknowledgeRead({ agentId, message, sequence } = {}) {
  readReceipts.push({ agentId, messageId: message?.id, sequence })
  if (readReceiptMode === 'throw') return Promise.reject(new Error('read receipt storage refused'))
  return Promise.resolve({ accepted: readReceiptMode === 'accept' })
}
function readReceiptsSeen() { return readReceipts.map(entry => ({ ...entry })) }
function setReadReceiptMode(mode) { readReceiptMode = mode }

function reset() {
  readReceipts.length = 0
  readReceiptMode = 'accept'
  inboxes.clear()
  floors.clear()
  nextPages.clear()
  sequence = 0
  reads = 0
  /* A read a previous test left held would otherwise hold that test's host
     round open for ever. */
  releaseReads()
}

function expireBefore(agentId, floorSequence) {
  floors.set(agentId, floorSequence)
  inboxes.set(agentId, (inboxes.get(agentId) || []).filter(record => record.sequence >= floorSequence))
}

function nextPage(agentId, records) { nextPages.set(agentId, records) }
module.exports = Object.freeze({ deliver, inbox, reset, holdReads, releaseReads, readCount, expireBefore, nextPage,
  acknowledgeRead, readReceiptsSeen, setReadReceiptMode })
