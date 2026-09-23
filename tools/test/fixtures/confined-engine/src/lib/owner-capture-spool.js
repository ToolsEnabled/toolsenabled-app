'use strict';

// FIXTURE: a verbatim copy of the ENGINE's src/lib/owner-capture-spool.js
// (the write-ahead spool under the owner's directives, and under the
// r-ledger proposals), with two test hooks wrapped around it at the bottom:
// MC_TEST_SPOOL_THROW makes writeAhead throw, so the host's fail-open
// promise can be measured, and `calls` records what the host asked for. The
// spool's own durability is proved by the engine suite; what the host tests
// prove against this copy is WHEN it is written and how a record settles.
// If the engine module changes, refresh this copy.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SPOOL_DIRECTORY_NAME = 'owner-capture-spool';
const PENDING = 'pending';
const RECONCILED = 'reconciled';
const RECORD_VERSION = 1;

class OwnerCaptureSpoolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// The spool follows the ledger it is a write-ahead log FOR. Deriving it from the
// ledger path rather than a fixed root means a test ledger, an archived ledger
// and the live ledger each keep their own spool, and a --ledger override can
// never spool into the wrong file's queue.
function spoolDirectory(ledgerFile) {
  if (typeof ledgerFile !== 'string' || !ledgerFile.trim()) {
    throw new OwnerCaptureSpoolError('OWNER_CAPTURE_SPOOL_TARGET_INVALID', 'A ledger file path is required to locate its spool.');
  }
  return path.join(path.dirname(path.resolve(ledgerFile)), SPOOL_DIRECTORY_NAME);
}

function pendingDirectory(ledgerFile) {
  return path.join(spoolDirectory(ledgerFile), PENDING);
}

function reconciledDirectory(ledgerFile) {
  return path.join(spoolDirectory(ledgerFile), RECONCILED);
}

// Sortable first, unique second. The leading timestamp means a plain directory
// listing is in capture order, so the oldest unreconciled directive is the first
// line of `ls` -- no parsing required to answer "what did we lose?".
function recordName(now, pid) {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return `${stamp}--pid${pid}--${crypto.randomUUID()}.json`;
}

// Write-then-rename within the same directory. The temp name is unique, so this
// cannot collide even with every other lane spooling at the same moment, and a
// reader of pending/ never observes a partially written record: it sees the file
// either not at all or complete.
function atomicWriteJson(file, payload) {
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, serialized, 'utf8');
    // fsync before the rename: without it the rename can be visible while the
    // contents are still only in the page cache, which after a power loss is a
    // zero-length file where a directive used to be.
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, file);
  } finally {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch { /* already closed */ }
    }
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* best effort */ }
  }
}

/**
 * Make a capture durable BEFORE anything is attempted against the ledger.
 *
 * Returns a handle carrying the record's own path. Callers must treat a
 * successful return as "the owner's words now survive this process dying" and
 * nothing more -- it says nothing about the ledger.
 */
function writeAhead(ledgerFile, { mode, id, text, interpretation, actor, source, gates, status, scope, threadId, provenanceClass, proposal, now = new Date() }) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new OwnerCaptureSpoolError('OWNER_CAPTURE_SPOOL_EMPTY', 'Refusing to spool an empty capture; there are no words to protect.');
  }
  const directory = pendingDirectory(ledgerFile);
  fs.mkdirSync(directory, { recursive: true });
  const name = recordName(now, process.pid);
  const file = path.join(directory, name);
  const record = {
    version: RECORD_VERSION,
    name,
    spooledAt: now.toISOString(),
    spooledByPid: process.pid,
    ledgerFile: path.resolve(ledgerFile),
    mode,
    id,
    // The owner's words, stored exactly as given. This field is the entire
    // reason the file exists; everything else is replay metadata.
    text,
    interpretation: interpretation ?? null,
    actor,
    source: source ?? null,
    gates: Array.isArray(gates) ? gates : [],
    status: status ?? null,
    scope: scope ?? null,
    threadId: threadId ?? null,
    provenanceClass: provenanceClass ?? null,
    proposal: proposal ?? null,
    ledgerOutcome: 'pending'
  };
  atomicWriteJson(file, record);
  return { name, file, directory, record };
}

/**
 * The ledger write succeeded, so this record is no longer outstanding. The bytes
 * are KEPT -- moved, never removed -- so the spool doubles as an independent
 * verbatim history that does not depend on the big JSON file staying intact.
 */
function markReconciled(handle, { revision = null, now = new Date() } = {}) {
  const target = reconciledDirectory(handle.record.ledgerFile);
  fs.mkdirSync(target, { recursive: true });
  const destination = path.join(target, handle.name);
  const settled = { ...handle.record, ledgerOutcome: 'in-ledger', reconciledAt: now.toISOString(), ledgerRevision: revision };
  atomicWriteJson(destination, settled);
  // Only after the reconciled copy is safely on disk does the pending copy go.
  // The reverse order would leave a window in which the record exists nowhere.
  try { fs.unlinkSync(handle.file); } catch { /* a concurrent reconcile already moved it */ }
  return { file: destination };
}

/**
 * A turn ended over this record and nothing was filed. NOT a settlement: the
 * record stays pending, because nobody decided anything about it. It only gains
 * the note saying so.
 */
function markUnfiled(handle, { reason, actor = null, now = new Date() } = {}) {
  const normalizedReason = typeof reason === 'string' ? reason.trim() : '';
  if (!normalizedReason) {
    throw new OwnerCaptureSpoolError(
      'OWNER_CAPTURE_SPOOL_UNFILED_REASON_REQUIRED',
      'Recording that a turn filed nothing requires a reason; the person reads it to decide what to do with the words.'
    );
  }
  const marked = {
    ...handle.record,
    ledgerOutcome: 'unfiled',
    unfiledAt: now.toISOString(),
    unfiledBy: actor,
    unfiledReason: normalizedReason
  };
  try {
    atomicWriteJson(handle.file, marked);
  } catch (error) {
    return { file: handle.file, marked: false, error };
  }
  return { file: handle.file, marked: true, record: marked };
}

// A discard is the PERSON'S verdict on the person's own words, so the caller
// has to say that a person gave it; nothing infers this from the actor name.
const DISCARD_DECIDED_BY = 'person';

/**
 * Settle an ingress record that the PERSON classified as noise rather than a
 * request of theirs. The record and the reason are retained permanently;
 * "discard" means "do not promote to the request ledger", never delete bytes.
 */
function markDiscarded(handle, { reason, actor = null, decidedBy = null, now = new Date() } = {}) {
  const normalizedReason = typeof reason === 'string' ? reason.trim() : '';
  if (!normalizedReason) {
    throw new OwnerCaptureSpoolError(
      'OWNER_CAPTURE_SPOOL_DISCARD_REASON_REQUIRED',
      'Discarding a spooled owner turn requires a reason.'
    );
  }
  if (decidedBy !== DISCARD_DECIDED_BY) {
    throw new OwnerCaptureSpoolError(
      'OWNER_CAPTURE_SPOOL_DISCARD_NOT_A_PERSON',
      'Only the person may discard their own words, and this call did not say one did. '
        + `Pass decidedBy: "${DISCARD_DECIDED_BY}" from the surface the person acted on (Decline, or owner-spool-review --discard). `
        + 'A turn that ended with the agent filing nothing is markUnfiled() instead: it keeps the record pending, where the person can still read it and file it.'
    );
  }
  const target = reconciledDirectory(handle.record.ledgerFile);
  fs.mkdirSync(target, { recursive: true });
  const destination = path.join(target, handle.name);
  const settled = {
    ...handle.record,
    ledgerOutcome: 'discarded',
    discardedAt: now.toISOString(),
    discardedBy: actor,
    discardReason: normalizedReason
  };
  atomicWriteJson(destination, settled);
  try { fs.unlinkSync(handle.file); } catch { /* a concurrent review already settled it */ }
  return { file: destination };
}

/**
 * The ledger write did NOT happen. The record STAYS pending -- the words are the
 * point and they keep their place in the queue -- but it records why, so the
 * pending queue explains itself instead of being an undifferentiated pile.
 *
 * Deliberately keeps records that failed on a caller mistake (a wrong flag, a
 * duplicate id) rather than discarding them. Those records still contain text
 * somebody typed as the owner's words, and the whole failure being fixed here is
 * an agent deciding on its own that some words were not worth keeping.
 */
function annotatePending(handle, { code, message, now = new Date() } = {}) {
  const annotated = {
    ...handle.record,
    ledgerOutcome: 'not-in-ledger',
    lastAttemptAt: now.toISOString(),
    lastAttemptError: { code: code ?? null, message: typeof message === 'string' ? message.slice(0, 2000) : null }
  };
  try {
    atomicWriteJson(handle.file, annotated);
  } catch {
    // The original pending record is already on disk and already holds the
    // words. Failing to add an explanation must never escalate into losing them.
  }
  return { file: handle.file };
}

function readRecord(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? { ...parsed, file } : null;
  } catch {
    return null;
  }
}

/**
 * Every capture whose words are durable but which never reached the ledger.
 * This is the answer to "what did the fleet lose today?", and it is a directory
 * listing rather than a claim.
 */
function listPending(ledgerFile) {
  const directory = pendingDirectory(ledgerFile);
  let names;
  try {
    names = fs.readdirSync(directory).filter((n) => n.endsWith('.json') && !n.endsWith('.tmp'));
  } catch {
    return [];
  }
  return names.sort()
    .map((name) => readRecord(path.join(directory, name)))
    .filter(Boolean);
}

const real = {
  OwnerCaptureSpoolError,
  SPOOL_DIRECTORY_NAME,
  RECORD_VERSION,
  DISCARD_DECIDED_BY,
  spoolDirectory,
  pendingDirectory,
  reconciledDirectory,
  writeAhead,
  markReconciled,
  markUnfiled,
  markDiscarded,
  annotatePending,
  listPending
};

const calls = [];

/* Wrapped under OTHER names: a second `function writeAhead` declaration in
   this module would replace the original above (declarations hoist, the last
   wins) and the wrapper would call itself. */
function loggedWriteAhead(ledgerFile, record) {
  calls.push({ method: 'writeAhead', ledgerFile, mode: record && record.mode, source: record && record.source, scope: record && record.scope, threadId: record && record.threadId });
  if (process.env.MC_TEST_SPOOL_THROW) throw new OwnerCaptureSpoolError('OWNER_CAPTURE_SPOOL_FIXTURE_THROW', 'the fixture spool was asked to throw');
  return real.writeAhead(ledgerFile, record);
}

function loggedMarkReconciled(handle, options) {
  calls.push({ method: 'markReconciled', name: handle && handle.name, revision: options && options.revision });
  return real.markReconciled(handle, options);
}

function loggedMarkUnfiled(handle, options) {
  calls.push({ method: 'markUnfiled', name: handle && handle.name, reason: options && options.reason, actor: options && options.actor });
  return real.markUnfiled(handle, options);
}

function loggedMarkDiscarded(handle, options) {
  calls.push({ method: 'markDiscarded', name: handle && handle.name, reason: options && options.reason, actor: options && options.actor, decidedBy: options && options.decidedBy });
  return real.markDiscarded(handle, options);
}

module.exports = {
  ...real,
  writeAhead: loggedWriteAhead,
  markReconciled: loggedMarkReconciled,
  markUnfiled: loggedMarkUnfiled,
  markDiscarded: loggedMarkDiscarded,
  calls
};
