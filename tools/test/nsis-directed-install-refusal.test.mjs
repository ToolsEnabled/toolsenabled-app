/* T333: A DIRECTED INSTALL MUST NOT DELETE THE INSTALL IT WAS DIRECTED AWAY FROM.
 *
 * Run: node --test tools/test/nsis-directed-install-refusal.test.mjs
 *
 * MEASURED on 2026-09-18 and proved WITHOUT running it, because running it would
 * have destroyed the owner's live installation:
 *
 *   - multiUser.nsh setInstallModePerUser reads HKCU "Software\<APP_GUID>"
 *     InstallLocation, sets $INSTDIR from it, and only then lets GetDParameter
 *     overwrite $INSTDIR with a `/D=` path.
 *   - The install Section then runs uninstallOldVersion, which takes the OLD
 *     uninstaller and install location FROM THE REGISTRY and RMDir /r's that
 *     directory. The directed path never enters into it.
 *   - build.nsis.guid is pinned in package.json, so every build of this product
 *     shares one registry key and one install location: no side by side.
 *
 * Net: `/D=<scratch>` puts the new files in the scratch directory and deletes
 * the existing installation on the way, with no warning. This suite pins the
 * refusal that stops it, two ways that need no NSIS toolchain: the real
 * build/installer.nsh is read for the load-bearing invariants, and a faithful
 * model of the control flow is executed against real directories so the
 * surviving install is a measurement rather than a reading.
 *
 * A green run here is necessary and not sufficient: tools/nsis-upgrade-roundtrip.ps1
 * is what exercises a compiled installer.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const NSH = fs.readFileSync(path.join(REPO_ROOT, 'build', 'installer.nsh'), 'utf8')
const GUARD = NSH.match(/!macro\s+RefuseDirectedInstallOverAnotherInstall([\s\S]*?)!macroend/)?.[1] ?? ''

/* ------------------------------------------------ 1. the shipped file */

test('the guard reads the registered install location, not a guess', () => {
  assert.notEqual(GUARD, '', 'the refusal macro must exist in build/installer.nsh')
  assert.match(GUARD, /ReadRegStr\s+\$R6\s+HKCU\s+"\$\{INSTALL_REGISTRY_KEY\}"\s+InstallLocation/,
    'it must read the same key setInstallModePerUser reads, or it is guarding a different fact')
})

test('it refuses only when a DIFFERENT directory is registered, so an upgrade still installs', () => {
  assert.match(GUARD, /\$\{If\}\s+\$R6\s+!=\s+""/, 'a machine with no registered install has nothing to protect')
  assert.match(GUARD, /\$\{AndIf\}\s+\$R6\s+!=\s+"\$INSTDIR"/, 'matching directories are an ordinary upgrade')
})

test('it exits nonzero for a silent caller and says so on the glass for a person', () => {
  assert.match(GUARD, /SetErrorLevel\s+741/, 'a silent install must fail loudly rather than quietly refuse')
  assert.match(GUARD, /Quit/, 'it must stop before the install Section that does the deleting')
  assert.match(GUARD, /\$\{IfNot\}\s+\$\{Silent\}[\s\S]*MessageBox/, 'an interactive run must be told what happened')
  assert.match(GUARD, /\$R6/, 'the message must name the installation that would have been removed')
  assert.match(GUARD, /changed nothing/i, 'and must say the machine was left alone')
})

test('the refusal runs before anything is copied or deleted', () => {
  const customInit = NSH.match(/!macro\s+customInit([\s\S]*?)!macroend/)?.[1] ?? ''
  const refusalAt = customInit.indexOf('RefuseDirectedInstallOverAnotherInstall')
  const rescueAt = customInit.indexOf('RescueLegacyInstallDirState')
  assert.ok(refusalAt >= 0 && rescueAt >= 0, 'customInit must insert both')
  assert.ok(refusalAt < rescueAt, 'a run that refuses has nothing to rescue')
})

test('the registers-one-location fact it depends on is still true of this build', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.build.nsis.perMachine, false, 'the guard reads HKCU because this is a per-user install')
  assert.equal(typeof pkg.build.nsis.guid, 'string',
    'the pinned identifier is why two installs collide; if it ever becomes per-version, revisit this guard')
})

/* ------------------------------------- 2. the control flow, executed */

/* A faithful model of the NSIS flow: the registry names the existing install,
   /D names where the new files go, customInit runs the guard, and the install
   Section's uninstallOldVersion RMDir /r's whatever the registry named. */
function install({ registeredLocation, directedTo, guard }) {
  const instDir = directedTo ?? registeredLocation
  if (guard && registeredLocation && registeredLocation !== instDir) {
    return { refused: true, errorLevel: 741, deleted: null }
  }
  if (registeredLocation && fs.existsSync(registeredLocation)) {
    fs.rmSync(registeredLocation, { recursive: true, force: true })
  }
  fs.mkdirSync(instDir, { recursive: true })
  fs.writeFileSync(path.join(instDir, 'ToolsEnabled.exe'), 'new build\n')
  return { refused: false, errorLevel: 0, deleted: registeredLocation }
}

test('a directed install leaves the live installation on disk', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'directed-install-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const live = path.join(root, 'Programs', 'ToolsEnabled')
  fs.mkdirSync(live, { recursive: true })
  fs.writeFileSync(path.join(live, 'ToolsEnabled.exe'), 'the install the owner depends on\n')

  const outcome = install({ registeredLocation: live, directedTo: path.join(root, 'scratch'), guard: true })

  assert.equal(outcome.refused, true)
  assert.equal(outcome.errorLevel, 741)
  assert.equal(fs.readFileSync(path.join(live, 'ToolsEnabled.exe'), 'utf8'), 'the install the owner depends on\n',
    'the live installation must be byte-unchanged')
  assert.equal(fs.existsSync(path.join(root, 'scratch')), false, 'and nothing was written to the directed path either')
})

test('WITHOUT the guard the same run deletes it -- which is the measured defect', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'directed-install-unguarded-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const live = path.join(root, 'Programs', 'ToolsEnabled')
  fs.mkdirSync(live, { recursive: true })
  fs.writeFileSync(path.join(live, 'ToolsEnabled.exe'), 'the install the owner depends on\n')

  const outcome = install({ registeredLocation: live, directedTo: path.join(root, 'scratch'), guard: false })

  assert.equal(outcome.refused, false)
  assert.equal(fs.existsSync(live), false, 'this is what /D=<scratch> does today without the refusal')
})

test('an ordinary upgrade into the registered directory still installs', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'directed-install-upgrade-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const live = path.join(root, 'Programs', 'ToolsEnabled')
  fs.mkdirSync(live, { recursive: true })
  fs.writeFileSync(path.join(live, 'ToolsEnabled.exe'), 'old build\n')

  const outcome = install({ registeredLocation: live, directedTo: live, guard: true })

  assert.equal(outcome.refused, false, 'replacing an install in place is the upgrade path, not the defect')
  assert.equal(fs.readFileSync(path.join(live, 'ToolsEnabled.exe'), 'utf8'), 'new build\n')
})

test('a first install on a machine with nothing registered still installs anywhere', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'directed-install-fresh-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const target = path.join(root, 'scratch')

  const outcome = install({ registeredLocation: '', directedTo: target, guard: true })

  assert.equal(outcome.refused, false, 'the guard must not turn a fresh directed install into a refusal')
  assert.equal(fs.existsSync(path.join(target, 'ToolsEnabled.exe')), true)
})
