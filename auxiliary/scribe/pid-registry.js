'use strict';

/**
 * Small, identity-checked process registry for Windows child cleanup.
 *
 * A PID alone is not ownership: Windows reuses them. Every new record carries
 * its parent server PID and a command fingerprint. Legacy records are accepted
 * only when their role maps to a Scribe-specific command path.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function read(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return value;
  } catch (_) {
    return {};
  }
}

function writeAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw error;
  }
}

function recordPid(file, name, pid, options = {}) {
  if (!name || !Number.isSafeInteger(Number(pid)) || Number(pid) <= 0) return false;
  const ownerPid = options.ownerPid == null ? process.pid : Number(options.ownerPid);
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) return false;
  const records = read(file);
  records[name] = {
    pid: Number(pid),
    ownerPid,
    commandIncludes: options.commandIncludes ? String(options.commandIncludes) : null,
    at: new Date().toISOString(),
  };
  writeAtomic(file, records);
  return true;
}

/** Remove a role only when it still points at the child that actually exited. */
function clearPid(file, name, pid) {
  const records = read(file);
  const current = records[name];
  if (!current || Number(current.pid) !== Number(pid)) return false;
  delete records[name];
  writeAtomic(file, records);
  return true;
}

function normalize(value) {
  return String(value || '').replace(/\//g, '\\').toLowerCase();
}

function legacyFingerprint(name, root) {
  const known = {
    dochost: path.join(root, 'engine', 'dochost.py'),
    research: path.join(root, 'engine', 'research.py'),
    stt: path.join(root, 'engine', 'stt.py'),
    agent: path.join(root, 'data', 'agent', 'mcp.json'),
    'watch-agent': path.join(root, 'data', 'agent-watch', 'mcp.json'),
  };
  return known[name] || null;
}

function inspectWindowsPid(pid) {
  if (process.platform !== 'win32') return null;
  const script =
    `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}";` +
    'if($p){[pscustomobject]@{' +
    'pid=[int]$p.ProcessId;parentPid=[int]$p.ParentProcessId;' +
    'executablePath=[string]$p.ExecutablePath;commandLine=[string]$p.CommandLine' +
    '}|ConvertTo-Json -Compress}';
  try {
    const raw = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', script,
    ], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function terminateWindowsTree(pid) {
  execFileSync('taskkill', ['/PID', String(pid), '/F', '/T'], {
    stdio: 'ignore',
    windowsHide: true,
  });
}

/**
 * Inspect every previous-run record once, terminate only proven Scribe
 * children, then clear the old registry regardless of whether a process was
 * found. The current server records itself and its children immediately after.
 */
function sweepStalePids(file, options = {}) {
  const root = options.root || __dirname;
  const inspectPid = options.inspectPid || inspectWindowsPid;
  const terminatePid = options.terminatePid || terminateWindowsTree;
  const records = read(file);
  const result = { swept: 0, skipped: 0, gone: 0 };

  for (const [name, record] of Object.entries(records)) {
    const pid = Number(record && record.pid);
    // A successfully bound replacement never needs to kill the prior server.
    if (name === 'server' || !Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) {
      result.skipped++;
      continue;
    }

    const info = inspectPid(pid);
    if (!info) {
      result.gone++;
      continue;
    }
    if (info.pid != null && Number(info.pid) !== pid) {
      result.skipped++;
      continue;
    }

    const fingerprint = record.commandIncludes || legacyFingerprint(name, root);
    const command = normalize(`${info.executablePath || ''} ${info.commandLine || ''}`);
    const parentMatches = record.ownerPid == null ||
      Number(info.parentPid) === Number(record.ownerPid);
    const commandMatches = !!fingerprint && command.includes(normalize(fingerprint));
    if (!parentMatches || !commandMatches) {
      result.skipped++;
      continue;
    }

    try {
      terminatePid(pid);
      result.swept++;
    } catch (_) {
      result.gone++;
    }
  }

  // Never leave a dead PID armed for a later boot after Windows may reuse it.
  writeAtomic(file, {});
  return result;
}

module.exports = {
  read,
  recordPid,
  clearPid,
  sweepStalePids,
  legacyFingerprint,
};
