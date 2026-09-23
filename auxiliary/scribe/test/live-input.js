'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function isAtOrBelow(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function currentProfile() {
  return path.resolve(process.env.USERPROFILE || os.homedir());
}

function assertAccountBoundary(candidate, label) {
  const profile = currentProfile();
  const profilesRoot = path.dirname(profile);
  if (isAtOrBelow(candidate, profilesRoot) && !isAtOrBelow(candidate, profile)) {
    throw new Error(`${label} points into a different user profile.`);
  }
}

function requiredLiveFile(envName) {
  const raw = String(process.env[envName] || '').trim();
  if (!raw) throw new Error(`${envName} is required; no live test input is selected by default.`);
  if (process.platform === 'win32' && /^[\\/]{2}/.test(raw)) {
    throw new Error(`${envName} must not use a UNC or device namespace.`);
  }
  if (!path.isAbsolute(raw)) throw new Error(`${envName} must be an absolute path.`);
  const lexical = path.resolve(raw);
  assertAccountBoundary(lexical, envName);
  const resolved = fs.realpathSync.native(lexical);
  assertAccountBoundary(resolved, envName);
  if (!fs.statSync(resolved).isFile()) throw new Error(`${envName} must name a file.`);
  return resolved;
}

function resolveExecutable(envName, executableNames) {
  if (String(process.env[envName] || '').trim()) return requiredLiveFile(envName);
  for (const directory of String(process.env.PATH || '').split(path.delimiter)) {
    if (!directory) continue;
    for (const name of executableNames) {
      const candidate = path.resolve(directory.replace(/^"|"$/g, ''), name);
      try {
        assertAccountBoundary(candidate, 'PATH executable');
      } catch (_) {
        continue;
      }
      try {
        if (fs.statSync(candidate).isFile()) {
          const resolved = fs.realpathSync.native(candidate);
          assertAccountBoundary(resolved, 'PATH executable');
          return resolved;
        }
      } catch (_) {}
    }
  }
  throw new Error(`${envName} is not set and no matching executable is on PATH.`);
}

module.exports = { requiredLiveFile, resolveExecutable };
