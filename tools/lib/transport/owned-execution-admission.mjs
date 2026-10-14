import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEV, TEMP, fencedPath, unlinkedPath, lstat, fstat, captureBytes } from './owned-job-files.mjs';

// Outside TEMP: an interrupted session must not become eligible merely because
// a new caller picks another evidence directory or temporary files are swept.
const EXECUTION_SCOPE = process.platform === 'linux'
  ? path.join(DEV, '.local', 'state', 'ToolsEnabledQualification', 'owned-execution')
  : `${DEV}\\AppData\\Local\\ToolsEnabledQualification\\owned-execution`;

export function cleanupError(message, scopePath, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = 'OWNED_EXECUTION_QUARANTINED';
  error.cleanupUnconfirmed = true;
  error.executionScope = scopePath;
  return error;
}

function ensurePrivateDirectory(input) {
  const directory = fencedPath(input);
  const parent = path.dirname(directory);
  if (parent !== directory) {
    try { unlinkedPath(parent, { directory: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; ensurePrivateDirectory(parent); }
  }
  try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  return unlinkedPath(directory, { directory: true });
}

function assertNativeAdmissionDirectory(directory) {
  if (process.platform !== 'linux') return;
  const owner = BigInt(process.getuid()), selected = lstat(unlinkedPath(directory, { directory: true }));
  if (selected.uid !== owner || selected.mode & 0o077n) throw new Error('Linux admission directory must be private to its owning account');
  for (let current = directory; ; current = path.dirname(current)) {
    const info = lstat(unlinkedPath(current, { directory: true }));
    // A root-owned sticky temporary ancestor cannot remove this account's
    // private child directory. Other writable ancestors do not preserve it.
    const stickyRoot = info.uid === 0n && Boolean(info.mode & 0o1000n);
    if (![0n, owner].includes(info.uid) || info.mode & 0o022n && !stickyRoot)
      throw new Error('Linux admission has an untrusted or writable ancestor');
    if (path.dirname(current) === current) break;
  }
}

// The production instance is private and has one fixed account-wide root.
// No PID/reuse, age, stale-session or caller-supplied cleanup claim clears it.
function executionScope(directory) {
  directory = fencedPath(directory);
  const ledger = path.join(directory, 'active-or-uncertain.json');
  return Object.freeze({
    acquire(details) {
      ensurePrivateDirectory(directory);
      assertNativeAdmissionDirectory(directory);
      let fd;
      try { fd = fs.openSync(ledger, 'wx+', 0o600); }
      catch (cause) { throw cleanupError('another owned execution is active or its cleanup remains unconfirmed; no new execution is admitted', ledger, cause); }
      const opened = fstat(fd);
      const record = { schema: 'toolsenabled.owned-execution-admission', schemaVersion: 1, id: randomUUID(),
        state: 'active', startedAt: new Date().toISOString(), ...details };
      let closed = false, quarantined = false;
      const store = () => {
        const bytes = Buffer.from(JSON.stringify(record) + '\n');
        fs.writeSync(fd, bytes, 0, bytes.length, 0); fs.ftruncateSync(fd, bytes.length); fs.fsyncSync(fd);
      };
      try { store(); } catch (cause) { fs.closeSync(fd); throw cleanupError('execution admission could not be durably recorded', ledger, cause); }
      const owns = () => {
        assertNativeAdmissionDirectory(directory);
        const current = lstat(unlinkedPath(ledger));
        if (current.dev !== opened.dev || current.ino !== opened.ino || captureBytes(ledger, 65536).data.toString('utf8') !== JSON.stringify(record) + '\n') throw cleanupError('execution admission ownership changed; refusing to remove it', ledger);
      };
      return Object.freeze({
        path: ledger,
        annotate(values) { if (closed || quarantined) throw cleanupError('execution admission is no longer writable', ledger); owns(); Object.assign(record, values); store(); },
        quarantine(cause) {
          if (!closed) {
            quarantined = true;
            try { owns(); record.state = 'cleanup-unconfirmed'; record.finishedAt = new Date().toISOString(); record.reason = String(cause?.code || 'UNCONFIRMED'); store(); }
            finally { fs.closeSync(fd); closed = true; }
          }
          return cleanupError('owned process cleanup is unconfirmed; evidence and durable admission are retained', ledger, cause);
        },
        confirmedCleanup() {
          if (closed || quarantined) throw cleanupError('quarantined execution requires explicit external cleanup review', ledger);
          try { owns(); fs.unlinkSync(ledger); }
          catch (cause) { throw cleanupError('confirmed processes could not release their exact execution admission', ledger, cause); }
          finally { fs.closeSync(fd); closed = true; }
        },
      });
    },
  });
}
const PRODUCTION_SCOPE = executionScope(EXECUTION_SCOPE);

// Both native transports acquire this one private, durable admission. Export
// acquisition, never the scope path selector or a cleanup override.
export function acquireOwnedExecution(details) { return PRODUCTION_SCOPE.acquire(details); }

// Inert ledger fixture only. It cannot launch processes or replace the private
// production scope, and cannot address the real account-wide admission root.
export function createInertExecutionScopeFixture(directory) {
  directory = unlinkedPath(directory, { directory: true });
  if (!directory.toLowerCase().startsWith(`${TEMP.toLowerCase()}${path.sep}qualification-job-test-`)) throw new Error('execution-scope fixtures require an owned Dev temporary test directory');
  return executionScope(path.join(directory, 'inert-admission'));
}

