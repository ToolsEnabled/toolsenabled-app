// "REMOVE EVERYTHING" HAS TO REACH THE DIRECTORY THAT MAKES A REINSTALL FRESH.
//
// The defect this exists to catch shipped in 1.0.30 and is not a crash either.
// TE_RemoveAllUserData named %APPDATA%\<PRODUCT_NAME> and the pre-rename
// %APPDATA%\Mission Control, and never named %LOCALAPPDATA%\<PRODUCT_NAME>.
// That is where the installation-owned service root lives -- machine.json (the
// permission level the person chose), machine-record.key, settings.json and
// agent-home.
//
// shell/local-data-reset.cjs already states the consequence in its own words:
// leaving that root behind brings the program back ALREADY CONFIGURED, "the
// opposite of a reset". So a person who explicitly chose remove-everything and
// then reinstalled skipped first run and inherited their old permission level.
// They got neither everything removed nor a real first run, which is precisely
// the half-configured machine that looks configured.
//
// WHY THE ASSERTION IS ON ${PRODUCT_NAME} AND REFUSES A LITERAL. The
// application resolves that root from a literal "ToolsEnabled". A literal in
// the installer would therefore be correct for the shipping product and
// destructive for any other: tools/installer-identity.mjs exists so a lifecycle
// test can install under a different name, and such a build uninstalling a
// literal ToolsEnabled would delete the REAL product's credentials and signed
// record. Keying on PRODUCT_NAME removes the right directory when this is the
// product and nothing when it is not, so the safety property is pinned here
// rather than left to whoever edits the macro next.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const nsh = readFileSync(new URL('../../build/installer.nsh', import.meta.url), 'utf8');

/* The macro body, isolated, so an assertion cannot be satisfied by the path
   appearing somewhere else in the file -- a comment, or a different macro. */
function removeAllUserDataBody() {
  const start = nsh.indexOf('!macro TE_RemoveAllUserData');
  assert.ok(start > -1, 'TE_RemoveAllUserData must exist');
  const end = nsh.indexOf('!macroend', start);
  assert.ok(end > start, 'TE_RemoveAllUserData must be closed');
  return nsh.slice(start, end);
}

/* Comments in this file legitimately discuss the literal path and the reasons
   for not using it, so prose is stripped before matching code. */
function codeOnly(body) {
  return body
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
}

test('remove-everything deletes the installation-owned service root', () => {
  const code = codeOnly(removeAllUserDataBody());
  assert.match(code, /RMDir\s+\/r\s+"\$LOCALAPPDATA\\\$\{PRODUCT_NAME\}"/,
    'without this a reinstall comes back already configured, which is the opposite of a reset');
});

test('the service-root removal is guarded on existence', () => {
  const code = codeOnly(removeAllUserDataBody());
  assert.match(code, /\$\{If\}\s+\$\{FileExists\}\s+"\$LOCALAPPDATA\\\$\{PRODUCT_NAME\}\\\*\.\*"/,
    'a fresh install must remove nothing extra');
});

test('the service root is never removed by a hardcoded product name', () => {
  /* The safety half. A renamed build must not be able to delete the real
     product's data, so the macro may not name ToolsEnabled literally. */
  const code = codeOnly(removeAllUserDataBody());
  assert.doesNotMatch(code, /\$LOCALAPPDATA\\ToolsEnabled/,
    'a renamed lifecycle build would delete the real product credentials and signed record');
});
