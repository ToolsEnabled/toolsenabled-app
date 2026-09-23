import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Executable approval is source policy, never an environment variable or a
// hash supplied by a qualification context. Relocation does not approve bytes.
// Node 22.19.0 is the already reviewed Windows x64 distribution. The additional
// system binaries were measured on 2026-09-10 after Windows Authenticode
// verification returned Valid: Python 3.13.5, Python Software Foundation;
// PowerShell 10.0.26100.8457, Microsoft Windows. Prior reviewed bytes remain
// supported. A future OS/tool update requires a new explicit review.
const APPROVED = Object.freeze({
  node: Object.freeze(['995a3fb3cefad590cd3f4b321532a4b9582fb9c6575320ed2e3e894caac3e362']),
  python: Object.freeze([
    'd87063e5597f257004c731b66c59c56c91038861c6877b1a3dca6b8c4e919125',
    '5341746f92483a93e44c313de830f2fba2956f0759094404a16b2fed06c9a2ed',
  ]),
  powershell: Object.freeze([
    '9785001b0dcf755eddb8af294a373c0b87b2498660f724e76c4d53f9c217c7a3',
    '0ff6f2c94bc7e2833a5f7e16de1622e5dba70396f31c7d5f56381870317e8c46',
  ]),
});
const PATHS = Object.freeze({
  node: process.execPath,
  python: 'C:\\Python313\\python.exe',
  powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
});
const MODULE = fileURLToPath(import.meta.url);
const loadedBytes = fs.readFileSync(MODULE);
const LOADED_POLICY = Object.freeze({ path: MODULE,
  sha256: createHash('sha256').update(loadedBytes).digest('hex'), bytes: loadedBytes.length });

function fail(message) { throw new Error(`Registered qualification toolchain blocked: ${message}`); }
export function registeredToolPaths() {
  if (arguments.length) fail('tool paths accept no caller overrides');
  return PATHS;
}

// A comparison helper is not an execution admission. Actual measurement below
// always reads the fixed selected files; no caller can supply those identities.
export function assertRegisteredToolIdentity(role, measured) {
  if (arguments.length !== 2 || !Object.hasOwn(APPROVED, role)) fail('unknown tool role or caller policy override');
  if (!measured || measured.path !== PATHS[role] || !Number.isSafeInteger(measured.bytes) || measured.bytes <= 0 ||
      !APPROVED[role].includes(measured.sha256)) fail(`unapproved ${role} path or executable bytes`);
}

export function registeredToolchainPolicyIdentity() {
  if (arguments.length) fail('loaded policy identity accepts no caller inputs');
  return LOADED_POLICY;
}

export function registeredToolSearchPath() {
  if (arguments.length) fail('tool search path accepts no caller overrides');
  return [path.dirname(PATHS.node), 'C:\\Python313', 'C:\\Program Files\\Git\\cmd',
    'C:\\Windows\\System32', 'C:\\Windows', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0'].join(';');
}
