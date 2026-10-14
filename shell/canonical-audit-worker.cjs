'use strict'

/* THE THREAD THAT PAYS THE LEDGER'S PRICE, SO THE WINDOW DOES NOT.
 *
 * WHAT THIS IS FOR, measured rather than reasoned. shell/canonical-audit.cjs
 * loads the capability payload's src/lib/audit.js INTO the Electron main
 * process and calls requireRecord() with no injected dependencies. The payload
 * then reaches its default secret plane, which is src/lib/runtime.js, and every
 * one of those reads and writes is
 * execFileSync('powershell.exe', ... tools/secrets.ps1 ...) -- a whole
 * interpreter start, synchronous, on the thread that pumps the window's message
 * queue. Idle on this machine that is 145-153 ms per start. The shipped code's
 * own measurement under the load the owner actually runs
 * (shell/vault-presence.cjs, "~100 agents running") records six consecutive
 * vault reads at 15031, 13099, 15035, 15034, 15028 and 5372 ms. One of those,
 * on the main thread, is a window that stops answering Windows for fifteen
 * seconds -- which is exactly what the machine recorded as AppHangB1
 * ("stopped interacting with Windows and was closed") and what the owner
 * reported as "it keeps crashing".
 *
 * SO THE WORK MOVES, AND NOTHING ELSE DOES. This worker loads the SAME module,
 * from the same payload root, with the same TOOLSENABLED_STATE_ROOT set before
 * the require -- the order that file calls load bearing, for the reason it
 * gives: audit-store.js resolves its database path at module load. It calls the
 * same requireRecord(). The vault spawns still happen, they still block a
 * thread, and they still take as long as they took; they simply block THIS
 * thread, which owns no window and pumps no message queue.
 *
 * WHAT IS DELIBERATELY NOT WEAKENED. requireRecord throws unless the event was
 * durably appended AND covered by the monotonic head anchor, and the caller in
 * the main process still refuses the action when it does. Moving the call to
 * another thread changes when the answer arrives, never what the answer means.
 * There is no fire-and-forget path here: every record posted to this worker is
 * answered, and the answer is the receipt or the refusal.
 *
 * IT HOLDS NO ELECTRON AND NO WINDOW. Its whole world is workerData: two
 * absolute paths and a module name. It is therefore drivable in a plain node
 * test against a payload directory a test wrote, which is how
 * tools/test/canonical-audit-worker.test.mjs drives it.
 */

const path = require('node:path')
const { parentPort, workerData } = require('node:worker_threads')

function failure(code, reason) {
  return { ok: false, code, reason }
}

/* The module is loaded on the first record rather than at thread start, and the
 * failure rules are copied from shell/canonical-audit.cjs deliberately, because
 * a caller must not be able to tell which side of the boundary answered:
 *   * MODULE_NOT_FOUND is the one code that means the payload does not carry
 *     the writer. It is remembered.
 *   * Anything else -- EMFILE, EAGAIN, EIO, EBUSY -- says this ATTEMPT could
 *     not read a writer that is sitting healthy on the disk. It is answered and
 *     NOT remembered, so the next record gets a fresh look. */
let loaded = null

function loadAudit() {
  if (loaded && loaded.ok) return loaded
  if (loaded && loaded.ok === false && loaded.code === 'AUDIT_MODULE_ABSENT') return loaded

  const stateRoot = workerData ? workerData.stateRoot : null
  const payloadRoot = workerData ? workerData.payloadRoot : null
  const auditModule = workerData ? workerData.auditModule : null
  if (typeof stateRoot !== 'string' || !path.isAbsolute(stateRoot)) {
    return failure('AUDIT_STATE_ROOT_INVALID', 'An absolute capability state root is required to address this installation’s ledger.')
  }
  if (typeof payloadRoot !== 'string' || payloadRoot.length === 0) {
    return failure('AUDIT_PAYLOAD_ABSENT', 'No capability payload is present, so this copy carries no canonical ledger writer.')
  }

  /* BEFORE the require, for the reason shell/canonical-audit.cjs states: the
   * payload's audit-store.js resolves its default database path at module load,
   * so a value set afterwards silently addresses a different file. */
  process.env.TOOLSENABLED_STATE_ROOT = stateRoot

  let audit
  try {
    audit = require(path.join(payloadRoot, auditModule))
  } catch (error) {
    const cause = (error && (error.message || error.code)) || 'no reason given'
    if (error && error.code === 'MODULE_NOT_FOUND') {
      loaded = failure(
        'AUDIT_MODULE_ABSENT',
        `The capability payload does not carry its ledger writer (${cause}). It is staged by tools/capability-manifest.json under hostModules.`,
      )
      return loaded
    }
    return failure(
      'AUDIT_MODULE_UNREADABLE',
      `The capability payload's ledger writer could not be read on this attempt (${cause}). This does not say the writer is missing, and the next attempt is not answered from a cache.`,
    )
  }
  if (!audit || typeof audit.requireRecord !== 'function' || typeof audit.verify !== 'function') {
    loaded = failure('AUDIT_MODULE_UNRECOGNIZED', 'The capability payload carries a ledger writer this shell does not recognize.')
    return loaded
  }
  loaded = { ok: true, audit }
  return loaded
}

function record(message) {
  const ready = loadAudit()
  if (!ready.ok) return ready
  try {
    const receipt = ready.audit.requireRecord(message.action, message.target, message.details || {})
    return receipt.disposition === 'not-required' ? receipt : { ok: true, sequence: receipt.sequence, eventHash: receipt.eventHash }
  } catch (error) {
    return failure(
      error && typeof error.code === 'string' ? error.code : 'AUDIT_UNAVAILABLE',
      'The action was not recorded in the signed ledger, so it was not performed.',
    )
  }
}

function recordBatch(message) {
  const ready = loadAudit()
  if (!ready.ok) return ready
  const items = message.items
  if (!Array.isArray(items) || items.length < 1 || items.length > 128
      || items.some(item => !item || typeof item.action !== 'string' || typeof item.target !== 'string')) {
    return failure('AUDIT_BATCH_INVALID', 'The audit batch is invalid.')
  }
  if (typeof ready.audit.recordBatch !== 'function' || typeof ready.audit.requireDurableStatus !== 'function') {
    return failure('AUDIT_BATCH_UNSUPPORTED', 'This copy cannot record a settings batch in the signed ledger.')
  }
  try {
    const statuses = ready.audit.recordBatch(items.map(item => ({ ...item, anchorRequired: true })))
    if (!Array.isArray(statuses) || statuses.length !== items.length) throw new Error('Invalid audit batch result')
    const results = statuses.map(status => {
      try {
        const receipt = ready.audit.requireDurableStatus(status)
        return receipt.disposition === 'not-required' ? receipt : { ok: true, sequence: receipt.sequence, eventHash: receipt.eventHash }
      } catch (error) {
        return failure(typeof error?.code === 'string' ? error.code : 'AUDIT_UNAVAILABLE', 'This change could not be recorded in the signed ledger.')
      }
    })
    return { ok: results.every(result => result.ok), results }
  } catch (error) {
    return failure(typeof error?.code === 'string' ? error.code : 'AUDIT_UNAVAILABLE', 'The changes could not be recorded in the signed ledger.')
  }
}

function findEvents(message) {
  const ready = loadAudit()
  if (!ready.ok) return ready
  try {
    // The canonical reader verifies the chain and refreshes its protected
    // head. Those synchronous operations belong on this thread too.
    const events = ready.audit.findEvents({ action: message.action, target: message.target, limit: message.limit })
    if (!Array.isArray(events)) return failure('AUDIT_UNAVAILABLE', 'The signed record could not be read.')
    return { ok: true, events }
  } catch (error) {
    return failure(typeof error?.code === 'string' ? error.code : 'AUDIT_UNAVAILABLE', 'The signed record could not be read.')
  }
}

/* THE SAME CLOSE shell/canonical-audit.cjs DOCUMENTS, AND FOR ITS REASON: this
 * thread holds the ledger's sqlite handle open for its life, and on Windows an
 * open handle is a file that cannot be deleted. resetForTests is the payload's
 * only close; it is called here by that name, on purpose, because a shell
 * cannot add a better-named export to a pinned engine source. */
async function close() {
  const ready = loaded
  loaded = null
  if (!ready || !ready.ok) return { ok: true, closed: false, reason: 'This thread had not opened the signed record.' }
  if (typeof ready.audit.resetForTests !== 'function') {
    return failure('AUDIT_CLOSE_UNSUPPORTED', 'This copy of the ledger writer offers no way to close its database.')
  }
  try {
    if (typeof ready.audit.close === 'function') await ready.audit.close()
    else ready.audit.resetForTests()
    return { ok: true, closed: true }
  } catch (error) {
    return failure('AUDIT_CLOSE_FAILED', `The signed record's database did not close (${(error && (error.code || error.message)) || 'no reason given'}).`)
  }
}

if (parentPort) {
  parentPort.on('message', async (message) => {
    if (!message || typeof message !== 'object') return
    const id = message.id
    if (message.kind === 'close') {
      parentPort.postMessage({ id, result: await close() })
      return
    }
    if (message.kind === 'record') {
      parentPort.postMessage({ id, result: record(message) })
    }
    if (message.kind === 'record-batch') {
      parentPort.postMessage({ id, result: recordBatch(message) })
    }
    if (message.kind === 'find-events') {
      parentPort.postMessage({ id, result: findEvents(message) })
    }
  })
  parentPort.postMessage({ kind: 'ready' })
}

module.exports = { close, findEvents, loadAudit, record, recordBatch }
