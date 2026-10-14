#!/usr/bin/env node

/* THE SUPPORTED WAY TO INSTALL AN ISOLATED BUILD, WITH THE FENCE ON THE PATH.
 *
 * WHY THIS EXISTS. tools/installer-identity.mjs grew a --check-registration
 * fence after a measured near-miss: stale `ToolsEnabled Test 1.0.20` registry
 * records were found on the build machine with their InstallLocation pointing at
 * THE REAL RELEASE INSTALL ROOT. electron-builder's initMultiUser resolves
 * $INSTDIR from that registration BEFORE the install section runs and gives it
 * precedence over /D=, so a test-identity installer would have installed into
 * the real product's directory and its uninstaller's `RMDir /r $INSTDIR` would
 * have deleted it.
 *
 * AND THEN NOTHING CALLED THE FENCE. An adversarial pass found it: the flag
 * existed, a unit test turned red when the function broke, and no command in the
 * repository ever supplied it. `dist:test` builds an installer and never
 * installs one, so the protected operation -- installation -- had no checked
 * path at all. A green test over a guard the real operation never runs is this
 * project's most repeated failure, and the fence had become an instance of it.
 *
 * The fence is not bolted onto the build verb, deliberately: building is safe,
 * and a check on the wrong verb reads as protection while providing none. So the
 * install gets its own command, and that command cannot skip the check.
 *
 *   node tools/install-isolated.mjs --installer <path.exe> --into <dir> [--channel test]
 *
 * Exit 0 installed, 1 refused or failed, 2 could not run. Distinct on purpose:
 * "could not check" must never be reported as "checked and fine".
 */

import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { identityFromPackageJson, registrationVerdict } from './installer-identity.mjs';

function fail(code, message) {
  process.stderr.write(`install-isolated: ${message}\n`);
  process.exit(code);
}

function flag(argv, name) {
  const at = argv.indexOf(name);
  return at === -1 ? null : argv[at + 1] || null;
}

const argv = process.argv.slice(2);
const installer = flag(argv, '--installer');
const into = flag(argv, '--into');
const channel = flag(argv, '--channel') || 'test';

if (!installer || !into) {
  fail(2, 'usage: --installer <path to the built .exe> --into <scratch directory> [--channel test]');
}
if (process.platform !== 'win32') fail(2, 'a Windows installer can only be installed on Windows.');
if (!existsSync(installer)) fail(2, `no installer at ${installer}`);

const target = path.resolve(into);

/* THE RELEASE IDENTITY IS REFUSED OUTRIGHT, and this is the sharpest guard here.
   The release GUID is the identity the owner's own installed copy carries, so
   installing it "somewhere else" is exactly the operation that cannot be fenced
   -- initMultiUser will find the real InstallLocation and use it. A lifecycle
   test must use a non-release channel; that is what installer-identity is for. */
if (channel === 'release') {
  fail(1, 'refusing the release channel. Its GUID is the installed base\'s identity, so /D= cannot '
    + 'fence it: initMultiUser resolves the real InstallLocation first. Build a non-release channel.');
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { identity } = await identityFromPackageJson(path.join(repoRoot, 'package.json'), process.env, channel);

const verdict = registrationVerdict(identity, { expectUnder: target, pathModule: path });
process.stdout.write(`  identity   ${identity.productName}  ${identity.guid}\n`);
process.stdout.write(`  ${verdict.ok ? 'ok  ' : 'STOP'}       ${verdict.code}: ${verdict.message}\n`);
if (!verdict.ok) {
  fail(1, 'the registration fence refused. Nothing was installed.');
}

mkdirSync(target, { recursive: true });

/* /D= must be last and unquoted -- an NSIS convention, not a preference. */
const result = spawnSync(installer, ['/S', `/D=${target}`], { stdio: 'inherit' });
if (result.error) fail(2, `could not start the installer: ${result.error.message}`);
if (result.status !== 0) fail(1, `the installer exited ${result.status}`);

process.stdout.write(`  installed  ${target}\n`);
