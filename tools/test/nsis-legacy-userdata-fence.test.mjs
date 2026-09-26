// A TEST BUILD MUST NOT BE ABLE TO DELETE THE REAL PRODUCT'S PRE-RENAME DATA.
//
// Measured 2026-08-23 during the install/uninstall lifecycle pass, and it is the
// reason that pass refused to exercise the remove-everything branch at all:
//
//   build/installer.nsh set $R1 to the literal "$APPDATA\Mission Control" for
//   every product and every channel, and TE_RemoveAllUserData then did
//   RMDir /r on it. tools/installer-identity.mjs changes the GUID and the
//   product name for a test channel -- it does not and cannot change a literal
//   path. So an isolated lifecycle build choosing "remove everything" would
//   delete the OWNER'S OWN %APPDATA%\Mission Control, which archived upgrade
//   evidence identifies as the real predecessor data directory on this machine.
//
// The isolation mechanism was therefore isolated in two of its three namespaces
// and not the third, while reading as though it were isolated in all of them.
//
// The fix makes the predecessor name belong to a SUCCESSOR rather than to every
// build, and this file holds the three places that name agrees with in lockstep:
// installer.nsh's pair, package.json's productName, and LEGACY_USER_DATA_NAMES
// in shell/userdata-adoption.cjs. A rename that updates one and not the others
// either orphans the old data forever or re-opens this defect, and both are
// silent without these assertions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const nsh = readFileSync(new URL('../../build/installer.nsh', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const { LEGACY_USER_DATA_NAMES } = require('../../shell/userdata-adoption.cjs');

/* The predecessor name is discussed at length in the comments both here and
   there, so every assertion about CODE runs against a comment-stripped copy. */
const code = nsh.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');

/* Parsed rather than matched with a regex: the escaping needed to write NSIS
   paths inside a JavaScript pattern is its own source of quiet mistakes, and a
   test that silently stops matching is worse here than no test. */
function defineValue(name) {
  const line = code.split('\n').find((l) => l.trim().startsWith(`!define ${name} `));
  assert.ok(line, `${name} must be defined in build/installer.nsh`);
  const open = line.indexOf('"');
  const close = line.lastIndexOf('"');
  assert.ok(close > open, `${name} must be defined as a quoted string`);
  return line.slice(open + 1, close);
}

test('the rename declares different predecessor and successor products', () => {
  assert.notEqual(defineValue('TE_LEGACY_USER_DATA_NAME'), defineValue('TE_LEGACY_SUCCESSOR_NAME'),
    'the predecessor and successor must be different products for this to be a rename');
});

test('the successor named in the installer is the product this package builds', () => {
  const productName = pkg.build?.productName ?? pkg.productName;
  assert.equal(defineValue('TE_LEGACY_SUCCESSOR_NAME'), productName,
    'a rename that misses this leaves the fence permanently closed and the old data orphaned');
});

test('the predecessor named in the installer is one the application adopts from', () => {
  assert.ok(LEGACY_USER_DATA_NAMES.includes(defineValue('TE_LEGACY_USER_DATA_NAME')),
    `the installer would delete a directory the app never adopts from: ${JSON.stringify(LEGACY_USER_DATA_NAMES)}`);
});

test('a build that is not the successor claims no predecessor path', () => {
  /* The fence itself. Compile-time, because PRODUCT_NAME is fixed when the
     installer is built -- there is no runtime in which it could change. */
  const open = code.indexOf('!if "${PRODUCT_NAME}" == "${TE_LEGACY_SUCCESSOR_NAME}"');
  assert.ok(open > -1, 'the predecessor path must be assigned inside a PRODUCT_NAME guard');
  const guard = code.slice(open, code.indexOf('!endif', open));
  const [taken, notTaken] = guard.split('!else');
  assert.ok(notTaken !== undefined, 'the guard must have an else branch; a missing one is an unset $R1');
  assert.ok(taken.includes('StrCpy $R1 "$APPDATA\\${TE_LEGACY_USER_DATA_NAME}"'),
    'the successor must claim the predecessor through the define, not through a fresh literal');
  assert.ok(/StrCpy\s+\$R1\s+""/.test(notTaken),
    'a non-successor build must end up with an EMPTY legacy path, not a shorter one');
});

test('the pre-rename path is never written out literally in code', () => {
  assert.ok(!code.includes('$APPDATA\\Mission Control'),
    'a literal here is what made a test build able to delete the real product data');
});

test('an empty legacy path can never reach a filesystem call', () => {
  /* The blunt half, and the reason the ORDER of the two checks is asserted
     rather than assumed: "" joined with the wildcard suffix is the root of the
     current drive. A fence that turned into a recursive delete of a drive root
     would be far worse than the defect it replaced. */
  const macro = code.slice(code.indexOf('!macro TE_RemoveAllUserData'));
  const body = macro.slice(0, macro.indexOf('!macroend'));
  const emptyCheck = body.indexOf('${If} "${Legacy}" != ""');
  const existsCheck = body.indexOf('${FileExists} "${Legacy}');
  assert.ok(emptyCheck > -1, 'TE_RemoveAllUserData must reject an empty legacy path');
  assert.ok(existsCheck > -1, 'the existence guard must still be there');
  assert.ok(emptyCheck < existsCheck, 'the empty check must come FIRST -- see above');
});

// --- and the same thing asked of NSIS itself, not of a regex ----------------
//
// Everything above reads the file the way a person reads it. That is worth
// having and it is not the same as knowing how the PREPROCESSOR resolves the
// guard -- and the preprocessor is what decides whether a real uninstaller
// carries the path or not. So when the toolchain is on this machine, the real
// build/installer.nsh is preprocessed under both product names and the surviving
// assignment is read out of the output.
//
// Locating makensis is not guesswork: electron-builder downloads it into its own
// cache on the first Windows build, which is the same cache
// tools/nsis-upgrade-roundtrip.ps1 uses. A machine that has never built an
// installer will not have it, and cannot ship one either, so the check reports
// itself absent rather than failing -- but it says so out loud, because a check
// that quietly excuses itself is worth less than no check.

function findMakensis() {
  const local = process.env.LOCALAPPDATA;
  if (!local) return null;
  const cache = path.join(local, 'electron-builder', 'Cache');
  if (!existsSync(cache)) return null;
  for (const entry of readdirSync(cache)) {
    if (!entry.startsWith('nsis-')) continue;
    const versionDir = path.join(cache, entry);
    for (const inner of readdirSync(versionDir)) {
      const exe = path.join(versionDir, inner, 'makensis.exe');
      if (existsSync(exe)) return exe;
    }
  }
  return null;
}

/* -PPO runs the preprocessor and prints the resulting script WITHOUT compiling,
   so the !if is resolved and no installer is produced. The harness supplies the
   two things electron-builder normally defines around this include -- the
   product name and the isUpdated condition -- and includes the REAL file. */
function resolveLegacyAssignment(makensis, productName) {
  const dir = mkdtempSync(path.join(tmpdir(), 'te-nsh-ppo-'));
  const nshPath = fileURLToPath(new URL('../../build/installer.nsh', import.meta.url));
  const harness = path.join(dir, 'fence-harness.nsi');
  writeFileSync(harness, [
    '!include LogicLib.nsh',
    '!include FileFunc.nsh',
    `!define PRODUCT_NAME "${productName}"`,
    '!define isUpdated `$0 == "1"`',
    'Name "fence-harness"',
    'OutFile "fence-harness.exe"',
    `!include "${nshPath}"`,
    'Section',
    '  !insertmacro customUnInstall',
    'SectionEnd',
    '',
  ].join('\r\n'));
  const out = execFileSync(makensis, ['-PPO', harness], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const lines = out.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('StrCpy $R1 '));
  assert.equal(lines.length, 1, `expected exactly one $R1 assignment after preprocessing, got ${JSON.stringify(lines)}`);
  return lines[0];
}

test('NSIS itself resolves the fence the way the source reads', (t) => {
  const makensis = findMakensis();
  if (!makensis) {
    t.diagnostic('makensis is not in the electron-builder cache on this machine, so the preprocessor half of this fence was NOT verified here. It is verified on any machine that has built an installer.');
    return;
  }
  assert.equal(resolveLegacyAssignment(makensis, 'ToolsEnabled'),
    'StrCpy $R1 "$APPDATA\\Mission Control"',
    'the shipping product must still clean up its own predecessor');
  assert.equal(resolveLegacyAssignment(makensis, 'ToolsEnabled Test'),
    'StrCpy $R1 ""',
    'a renamed build must claim no predecessor at all -- this is the defect');
});
