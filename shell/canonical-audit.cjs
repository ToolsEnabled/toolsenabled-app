'use strict'

/* THE SHELL'S DOOR INTO THE CANONICAL, SIGNED, TAMPER-EVIDENT LEDGER.
 *
 * ToolsEnabled sells two sentences: a policy kernel decides what is allowed
 * before anything happens, and a tamper-evident ledger records what happened.
 * The second one was false for everything this window does. Measured on this
 * machine on 2026-08-12: creating an account, signing in, and failing a sign-in
 * wrote ZERO rows to <userData>/capability/state/audit.sqlite3, whose last
 * entry was two days old and came entirely from the capability layer's own MCP
 * tools. The ledger was honest about what it held. Nothing was asking it to
 * hold anything.
 *
 * WHY NOTHING WAS: the capability layer -- a separate child process -- owns
 * src/lib/audit.js, and every action that reaches it through the bridge gets a
 * durable receipt (see durableReceipt() in the payload's
 * src/lib/mission-bridge/actions.js). The Electron main process grew a SECOND
 * action surface beside it, the mc-account:* / mc-agent:* IPC channels, and
 * that surface never had a recorder at all. shell/product-account.cjs
 * require()s exactly node:crypto, node:fs and node:path.
 *
 * THE PREMISE THAT KEPT IT THAT WAY WAS TESTED AND IS FALSE.
 * shell/spawn-record.cjs states, as the reason it exists as a separate
 * non-canonical chain: "The canonical writer cannot close it here: the shipped
 * payload has no vault (AUDIT_SIGNING_KEY_UNAVAILABLE)". That was true when it
 * was written and stopped being true the first time the capability layer
 * booted. The installed vault at <userData>/capability/vault/secrets.json holds
 * exactly two keys, and they are the two this ledger needs:
 * toolsenabled_audit_head_v1 and toolsenabled_audit_signing_key_v1. The layer
 * creates them on first run -- which is why the app's own ledger already had 20
 * correctly signed entries under them.
 *
 * Measured, not reasoned: a plain host process pointed at the installed state
 * root appended to that ledger and audit.verify() returned valid afterwards.
 * So this module does not need a new key, a new chain, or a new format. It
 * needs to call the writer that was already there.
 *
 * WHAT THIS IS NOT. It is not a second ledger. shell/spawn-record.cjs is one,
 * deliberately and honestly labelled; it stays, because it needs only the OS
 * keystore and therefore still works on an installation whose capability
 * payload is absent. This module is the canonical path, and where both run the
 * canonical one is the record that counts.
 *
 * IT SETS TOOLSENABLED_STATE_ROOT BEFORE THE REQUIRE, AND THAT ORDER IS LOAD
 * BEARING. The payload's audit-store.js resolves its default database path at
 * MODULE LOAD (`const DEFAULT_AUDIT_DB = rootPath('state','audit.sqlite3')`).
 * Setting the variable after the first require() would silently address a
 * different file -- in a packaged build, one inside the read-only install
 * directory. The value is the same one shell/capability-layer.cjs hands the
 * child, so the window and the layer cannot end up describing two ledgers.
 *
 * IT NEVER RECORDS A SECRET. Callers pass an outcome code and an identifier.
 * No password, verifier, salt, session token or vault value reaches this file,
 * and the redaction the payload applies is a second line of defence, not the
 * first.
 */

const path = require('node:path')
const { resolveCapabilityRoot } = require('./capability-layer.cjs')
const { createCanonicalAuditQueue } = require('./canonical-audit-queue.cjs')

/* Declared in tools/capability-manifest.json under `hostModules`, which is what
 * puts it in the payload and what tools/check-asar-manifest.mjs gates. The
 * duplicated path is unavoidable -- the manifest is a build input and this is a
 * runtime read -- so a miss below names the manifest instead of reporting a
 * bare MODULE_NOT_FOUND. */
const AUDIT_MODULE = 'src/lib/audit.js'

/* The audit module caches its database handle and its resolved paths, so it is
 * loaded once per process and reused. A failure is cached too: a copy with no
 * payload should not pay a module resolution on every keystroke. */
let cached = null

function failure(code, reason) {
  return { ok: false, code, reason }
}

/**
 * Load the canonical writer out of the capability payload.
 *
 * @param {object} options
 * @param {string} options.stateRoot  <userData>/capability -- the SAME value
 *   shell/main.cjs passes to shell/capability-layer.cjs. Required and absolute;
 *   a relative value is refused rather than resolved against a cwd nobody chose.
 */
function loadCanonicalAudit({ stateRoot, root = resolveCapabilityRoot(), load = require, env = process.env } = {}) {
  if (typeof stateRoot !== 'string' || stateRoot.length === 0 || !path.isAbsolute(stateRoot)) {
    return failure(
      'AUDIT_STATE_ROOT_INVALID',
      'An absolute capability state root is required to address this installation’s ledger.',
    )
  }
  if (!root) {
    return failure(
      'AUDIT_PAYLOAD_ABSENT',
      'No capability payload is present, so this copy carries no canonical ledger writer.',
    )
  }

  /* BEFORE the require. See the module comment. */
  env.TOOLSENABLED_STATE_ROOT = stateRoot

  let audit
  try {
    audit = load(path.join(root, AUDIT_MODULE))
  } catch (error) {
    const cause = error?.message || error?.code || 'no reason given'
    /* COULD NOT READ IT IS NOT DOES NOT HAVE IT.
     * Every throw here used to answer AUDIT_MODULE_ABSENT -- 'the payload does
     * not carry its ledger writer' -- and that answer is CACHED for the life of
     * the process. Driven 2026-08-27 with an injected loader: MODULE_NOT_FOUND,
     * EMFILE, EAGAIN, EIO and EBUSY all produced that one sentence, and four of
     * the five are false. The writer is staged; the machine could not read it at
     * that instant. On a box already carrying a hundred node processes EMFILE is
     * ordinary, and both callers in shell/main.cjs refuse the action for any code
     * but AUDIT_PAYLOAD_ABSENT -- so one blip refused every audited action for
     * the whole run while the payload sat healthy on disk.
     * MODULE_NOT_FOUND is the one code that genuinely means absent, and it stays
     * cached. Anything else is answered as unreadable and NOT cached, so the next
     * action gets a fresh look. The keystroke cost the cache exists to avoid is
     * untouched: a copy with no payload is refused ABOVE this, before any module
     * resolution, and still caches. */
    if (error?.code === 'MODULE_NOT_FOUND') {
      return failure(
        'AUDIT_MODULE_ABSENT',
        `The capability payload does not carry its ledger writer (${cause}). It is staged by tools/capability-manifest.json under hostModules.`,
      )
    }
    return failure(
      'AUDIT_MODULE_UNREADABLE',
      `The capability payload's ledger writer could not be read on this attempt (${cause}). This does not say the writer is missing, and the next attempt is not answered from a cache.`,
    )
  }
  if (typeof audit?.requireRecord !== 'function' || typeof audit?.verify !== 'function') {
    return failure('AUDIT_MODULE_UNRECOGNIZED', 'The capability payload carries a ledger writer this shell does not recognize.')
  }
  return { ok: true, audit }
}

function canonicalAudit(options = {}) {
  if (options.load || options.root || options.fresh) return loadCanonicalAudit(options)
  if (!cached) {
    const loaded = loadCanonicalAudit(options)
    /* AUDIT_STATE_ROOT_INVALID is a statement about the CALLER, never about
     * this installation's ledger, so it is answered but NOT cached. Measured
     * on a packaged build 2026-08-18: one handler calling with no state root
     * as the first ledger-touching act poisoned this cache for the process,
     * and every correctly-addressed record after it -- settings, accounts,
     * agent launches -- returned this failure while the ledger sat healthy on
     * disk. Genuine load outcomes (a real open, a missing payload, a missing
     * module) stay cached exactly as the comment above promises. */
    /* AUDIT_MODULE_UNREADABLE joins it for the same reason one branch down: it
     * is a statement about this ATTEMPT, not about the installation. Caching
     * either one turns a moment into a permanent fact. */
    if (loaded.ok === false && (loaded.code === 'AUDIT_STATE_ROOT_INVALID' || loaded.code === 'AUDIT_MODULE_UNREADABLE')) return loaded
    cached = loaded
  }
  return cached
}

function resetForTests() {
  retirementFailure = null
  cached = null
  if (lane) { void lane.queue.close() }
  lane = null
}

/* ---------- THE LEDGER'S OWN THREAD ----------
 *
 * WHY THERE IS ONE AT ALL, and this is the whole of the reason. Everything
 * above loads the payload's writer INTO THIS PROCESS, and this process is the
 * Electron main process -- the one that pumps the window's message queue. The
 * writer's default secret plane (the payload's src/lib/runtime.js) reads and
 * writes the head anchor with execFileSync('powershell.exe', ...
 * tools/secrets.ps1 ...): a whole interpreter start, synchronous, per anchored
 * admission. Idle on this machine that is 145-153 ms. The shipped code's own
 * measurement under the load the owner actually runs
 * (shell/vault-presence.cjs, "~100 agents running") records consecutive vault
 * reads at 5,372 to 15,035 ms. One of those on this thread is a window that
 * stops answering Windows for fifteen seconds, which the machine recorded as
 * AppHangB1 and the owner reported as the application crashing.
 *
 * So recordCanonical() no longer calls requireRecord here. It posts the record
 * to shell/canonical-audit-worker.cjs -- the same module, the same state root,
 * the same requireRecord, the same vault -- and awaits the same answer.
 *
 * WHAT DOES NOT MOVE. The two refusals that can be decided without opening
 * anything are still decided here, before a thread is ever started: a state
 * root that is not absolute is a statement about the CALLER, and a copy with no
 * capability payload has no ledger at all. Both were already answered above
 * without a module resolution, and they still are, so the keystroke cost the
 * cache exists to avoid stays avoided.
 *
 * Canonical reads also verify the chain and refresh the protected head;
 * findEvents is not merely a SQLite lookup. The permission-consent read
 * blocked the LIVE main thread for 6.2 seconds. findCanonicalEvents therefore
 * uses the same worker and queue as writes, keeping their order and every
 * verification. The synchronous loader remains for existing internal callers.
 */

let lane = null
const retiringLanes = new Set()
let retirementFailure = null
let canonicalClosing = null

function trackRetirement(finished) {
  retiringLanes.add(finished)
  finished.then(result => {
    retiringLanes.delete(finished)
    if (result?.ok === false) retirementFailure = result
  }, error => {
    retiringLanes.delete(finished)
    retirementFailure = failure('AUDIT_CLOSE_FAILED', error?.message || 'Idle audit retirement failed.')
  })
  return finished
}

function retireLane(stateRoot) {
  const retiring = lane
  if (!retiring || retiring.stateRoot !== stateRoot) return Promise.resolve()
  lane = null
  return trackRetirement(retiring.queue.retireWhenIdle())
}

function retireCanonicalWhenDisabled(options = {}) {
  const loaded = canonicalAudit(options)
  const operation = loaded.ok && loaded.audit.operationAudit
  if (!operation?.auditEnabledNow || operation.auditEnabledNow(options) !== false) return Promise.resolve()
  return Promise.all([operation.retireIfDisabled(options), retireLane(options.stateRoot)]).catch(error => {
    try { console.warn(`[audit] idle writer retirement failed: ${error?.code || error?.message || 'unknown'}`) } catch {}
  })
}

function laneFor(stateRoot, options = {}) {
  if (typeof stateRoot !== 'string' || stateRoot.length === 0 || !path.isAbsolute(stateRoot)) {
    return failure(
      'AUDIT_STATE_ROOT_INVALID',
      'An absolute capability state root is required to address this installation’s ledger.',
    )
  }
  /* The payload is looked for ONCE per lane, not once per record: a running
     lane already proves the answer, and this is on the path of every audited
     action in the window. */
  if (lane && lane.stateRoot === stateRoot && options.root === undefined) return { ok: true, queue: lane.queue }
  const root = options.root === undefined ? resolveCapabilityRoot() : options.root
  if (!root) {
    return failure(
      'AUDIT_PAYLOAD_ABSENT',
      'No capability payload is present, so this copy carries no canonical ledger writer.',
    )
  }
  if (lane && lane.stateRoot === stateRoot && lane.root === root) return { ok: true, queue: lane.queue }
  if (lane) trackRetirement(lane.queue.close())
  lane = {
    stateRoot,
    root,
    queue: createCanonicalAuditQueue({
      workerData: { stateRoot, payloadRoot: root, auditModule: AUDIT_MODULE },
      timeoutMs: options.timeoutMs,
      flushMs: options.flushMs,
      WorkerClass: options.WorkerClass,
    }),
  }
  return { ok: true, queue: lane.queue }
}

/**
 * Let go of the ledger's database file.
 *
 * WHY THE SHELL NEEDS THIS AT ALL. This process does not merely talk to the
 * ledger through the capability layer -- it loads the payload's writer INTO
 * ITSELF (see the module comment) and that writer keeps its database handle
 * open for the life of the process, deliberately, so a keystroke does not pay a
 * file open. On Windows an open handle is a file that cannot be deleted.
 *
 * MEASURED, 2026-08-18, and this is the whole reason the function exists: the
 * in-app data removal stopped the capability layer, swept, and reported the
 * credential vault, its access log and the signed ledger still on the disk. The
 * layer was not the holder. THIS process was -- it had recorded the account
 * creation a minute earlier through recordCanonical() above, and Node's
 * recursive delete stops at the first entry it cannot unlink, so one locked
 * database sheltered every sibling underneath the same directory. A reproduction
 * with a real open handle showed exactly that: the vault and its access log
 * survived a delete of their grandparent, untouched, because the sqlite file
 * three directories over was busy.
 *
 * `resetForTests` IS THE PAYLOAD'S ONLY CLOSE, AND IT IS USED ON PURPOSE. The
 * capability payload is derived from a pinned engine source, so this shell
 * cannot add a better-named export to it; what it can do is call the one that
 * exists and say why. The function closes the cached store and drops the cached
 * signer and anchors, which is precisely what has to happen here, and the next
 * recordCanonical() re-opens from scratch -- so a reset that is cancelled or
 * that leaves the window running has cost nothing but one file open.
 *
 * IT REPORTS RATHER THAN THROWS. A caller here is about to delete somebody's
 * data at their request, and a ledger that would not close must not stop that;
 * it must be named in what the person is shown afterwards.
 */
/* TWO HOLDERS, NOT ONE, SINCE THE WRITER MOVED TO ITS OWN THREAD. The reader
 * this process still loads for findEvents is closed here as it always was; the
 * writer thread is drained (bounded -- see canonical-audit-queue.cjs) and
 * stopped, which drops its handle with it. A thread that will not answer is
 * still stopped, because the caller of this is either quitting or deleting
 * somebody's data and neither may be blocked by a sick ledger. */
function closeCanonical() {
  if (canonicalClosing) return canonicalClosing
  // Capture the owners before yielding. A new lane admitted while these
  // owners stop belongs to its own later close, not to this old operation.
  const loaded = cached
  cached = null
  const dying = lane
  lane = null
  const retiring = [...retiringLanes]
  const closing = (async () => {
    await Promise.allSettled(retiring)
    let threadClosed = retirementFailure || { ok: true, closed: false }
    if (dying) {
      try { threadClosed = await dying.queue.close() } catch (error) {
        threadClosed = failure('AUDIT_CLOSE_FAILED', `The signed record's writer thread did not stop (${error?.code || error?.message || 'no reason given'}).`)
      }
    }
    if (retirementFailure) threadClosed = retirementFailure
    if (!loaded || !loaded.ok) {
      if (threadClosed.ok === false) return threadClosed
      if (threadClosed.closed === true) return { ok: true, closed: true }
      return { ok: true, closed: false, reason: 'This copy had not opened its signed record.' }
    }
    if (typeof loaded.audit.resetForTests !== 'function') {
      return failure('AUDIT_CLOSE_UNSUPPORTED', 'This copy of the ledger writer offers no way to close its database.')
    }
    try {
      if (typeof loaded.audit.close === 'function') await loaded.audit.close()
      else loaded.audit.resetForTests()
      if (threadClosed.ok === false) return threadClosed
      return { ok: true, closed: true }
    } catch (error) {
      return failure('AUDIT_CLOSE_FAILED', `The signed record's database did not close (${error?.code || error?.message || 'no reason given'}).`)
    }
  })()
  canonicalClosing = closing
  closing.then(result => {
    if (result?.ok === false) retirementFailure = result
    if (canonicalClosing === closing) canonicalClosing = null
  }, error => {
    retirementFailure = failure('AUDIT_CLOSE_FAILED', error?.message || 'Canonical audit closure failed.')
    if (canonicalClosing === closing) canonicalClosing = null
  })
  return closing
}

/**
 * Record an action in the canonical chain, refusing to report success unless it
 * is durably appended AND covered by the monotonic head anchor.
 *
 * requireRecord, not record: `record` reports a status object that a caller can
 * ignore, and a caller that ignores it is exactly how a ledger ends up empty
 * while everybody believes it is full. requireRecord throws, so a caller has to
 * decide, in code, what happens when the action cannot be recorded.
 *
 * Returns a plain result rather than throwing, because every caller here is an
 * IPC handler whose job is to turn this into a refusal the screen can show.
 *
 * IT IS ASYNCHRONOUS, AND THAT IS THE FIX. The body below used to run on the
 * calling thread, which is the Electron main thread, and the payload's anchor
 * read and anchor write are each a synchronous powershell.exe. See the thread
 * section above for the measured cost. The contract is otherwise identical: the
 * SAME shape resolves, success still means durably appended AND anchored, and
 * a caller that cannot record still refuses its action.
 *
 * @returns {Promise<{ok: true, sequence: number, eventHash: string}
 *          |{ok: false, code: string, reason: string}>}
 */
function captureAuditPolicy(options = {}) {
  const loaded = canonicalAudit(options)
  if (!loaded.ok) return { ok: false, ...loaded }
  const operation = loaded.audit.operationAudit
  if (!operation) return { ok: true, required: true, legacy: true }
  try {
    const decision = operation.capturePolicy(options)
    if (!decision.required) void retireLane(options.stateRoot)
    return { ok: true, decision, operation }
  }
  catch (error) { return failure('AUDIT_POLICY_INVALID', error.message) }
}

function optionalReceipt(action, target, options) {
  const policy = captureAuditPolicy(options)
  if (!policy.ok) return policy
  return policy.decision?.required === false ? policy.operation.skippedStatus(action, target) : null
}

async function recordCanonical(action, target, details = {}, options = {}) {
  try {
    const skipped = optionalReceipt(action, target, options)
    if (skipped) return skipped
    /* An injected loader, payload root or fresh flag is a TEST asking this
       process to record with a writer it supplied. There is no thread to hand a
       closure to, so that path records here, exactly as it always did, and
       answers in the same shape. Production never passes any of the three. */
    if (options.load || options.root || options.fresh) return recordCanonicalHere(action, target, details, options)
    const chosen = laneFor(options.stateRoot, options)
    if (!chosen.ok) return chosen
    return await chosen.queue.record(action, target, details)
  } finally { void retireCanonicalWhenDisabled(options) }
}

// One explicit batch retains a distinct event and receipt for each change.
// It shares the protected-head update, not the individual event history.
async function recordCanonicalBatch(items, options = {}) {
  try {
    if (!Array.isArray(items) || !items.length || items.length > 128
        || items.some(item => !item || typeof item.action !== 'string' || typeof item.target !== 'string')) return failure('AUDIT_BATCH_INVALID', 'The audit batch is invalid.')
    const policy = captureAuditPolicy(options)
    if (!policy.ok) return policy
    if (policy.decision?.required === false) return { ok: true,
      results: items.map(item => policy.operation.skippedStatus(item.action, item.target)) }
  
    const chosen = laneFor(options.stateRoot, options)
    if (!chosen.ok) return chosen
    return await chosen.queue.recordBatch(items)
  } finally { void retireCanonicalWhenDisabled(options) }
}

async function findCanonicalEvents(selector, options = {}) {
  const chosen = laneFor(options.stateRoot, options)
  if (!chosen.ok) return chosen
  const result = await chosen.queue.findEvents(selector)
  if (result?.ok === false) return failure(result.code, 'The signed record could not be read.')
  return result
}

/**
 * The record, made on THIS thread. Kept because the injected-writer test seam
 * needs it and because the measurement that justifies the thread has to be able
 * to run both sides against the same input.
 *
 * @returns {{ok: true, sequence: number, eventHash: string}
 *          |{ok: false, code: string, reason: string}}
 */
function recordCanonicalHere(action, target, details = {}, options = {}) {
  const skipped = optionalReceipt(action, target, options)
  if (skipped) return skipped
  const loaded = canonicalAudit(options)
  if (!loaded.ok) return loaded
  try {
    const receipt = loaded.audit.requireRecord(action, target, details)
    return { ok: true, sequence: receipt.sequence, eventHash: receipt.eventHash }
  } catch (error) {
    return failure(
      typeof error?.code === 'string' ? error.code : 'AUDIT_UNAVAILABLE',
      'The action was not recorded in the signed ledger, so it was not performed.',
    )
  }
}

module.exports = {
  captureAuditPolicy,
  retireCanonicalWhenDisabled,
  AUDIT_MODULE,
  canonicalAudit,
  closeCanonical,
  findCanonicalEvents,
  loadCanonicalAudit,
  recordCanonical,
  recordCanonicalBatch,
  recordCanonicalHere,
  resetForTests,
}
