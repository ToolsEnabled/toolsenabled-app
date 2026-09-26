'use strict'
/* electron-builder parent configuration: the Windows signing gate.
 *
 * package.json `build.extends` names this file, so EVERY electron-builder run
 * from this checkout -- `npm run dist`, `npm run dist:test` through
 * tools/installer-identity.mjs, the Linux cutter's direct cli.js call -- passes
 * through the same decision without any change to those command lines.
 * electron-builder merges parent configurations beneath package.json's own
 * `build`, so this file may only ADD `win.signExecutable` and, when signing is
 * configured, the Artifact Signing hook; it cannot override anything
 * package.json states. That is also why package.json must not state
 * `win.signExecutable` itself: the child value would silently win.
 *
 * With no configuration this returns `{ win: { signExecutable: false } }` --
 * byte-for-byte the unsigned build this project has always shipped. With a
 * partial configuration it throws, and electron-builder stops before
 * packaging. See windows-signing.cjs for the rules and
 * tools/test/code-signing-windows.test.mjs for their proof against
 * electron-builder's own configuration loader. */

const { resolveWindowsSigning, electronBuilderWindowsConfig } = require('./windows-signing.cjs')

module.exports = function windowsSigningGate() {
  return { win: electronBuilderWindowsConfig(resolveWindowsSigning(process.env)) }
}
