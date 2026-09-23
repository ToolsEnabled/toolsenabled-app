/* THE INSTALLER HAS TO RECOGNISE THE INSTALL IT IS REPLACING.
 *
 * Measured on Machine A, 2026-08-11, after installing ToolsEnabled Setup 1.0.3
 * over an existing Mission Control 1.0.5:
 *
 *   %LOCALAPPDATA%\Programs\mission-control   AND  ...\Programs\toolsenabled
 *   HKCU\...\Uninstall\{21cb002d-...} "Mission Control" 1.0.5
 *   HKCU\...\Uninstall\{1de271ec-...} "ToolsEnabled"    1.0.3
 *   two Start Menu shortcuts, two Desktop shortcuts
 *   %APPDATA%\Mission Control (populated)  AND  %APPDATA%\ToolsEnabled (empty)
 *
 * Not an upgrade -- a second product, installed alongside, at a LOWER version
 * number, with the person's data left in a directory the new build never reads.
 *
 * THE CAUSE. electron-builder keys a Windows installation on a GUID:
 *
 *   NsisTarget.js:157  const guid = options.guid || UUID.v5(appInfo.id, NS)
 *   multiUser.nsh:8    INSTALL_REGISTRY_KEY   "Software\${APP_GUID}"
 *   multiUser.nsh:9    UNINSTALL_REGISTRY_KEY "...\Uninstall\${UNINSTALL_APP_KEY}"
 *   multiUser.nsh:26   ReadRegStr $perUserInstallationFolder HKCU
 *                        "${INSTALL_REGISTRY_KEY}" InstallLocation
 *
 * That last line is how an installer finds the install it must replace. With no
 * `guid` set, the GUID is a hash of appId -- so renaming the product from
 * com.toolsenabled.missioncontrol to com.toolsenabled.desktop pointed the new
 * installer at a registry key that had never existed. It read no prior
 * InstallLocation, concluded there was nothing to upgrade, and installed a
 * second copy. Verified bit-exactly: UUID.v5 of the OLD appId is the GUID on the
 * Mission Control uninstall entry, and UUID.v5 of the NEW appId is the GUID on
 * the ToolsEnabled one.
 *
 * WHAT THIS SUITE PROTECTS. Not "the string is in package.json" -- a grep cannot
 * tell a live setting from a dead one. It resolves the GUID through
 * electron-builder's OWN UUID implementation, the same call the build makes, and
 * asserts the identity the resulting installer will own. The load-bearing test
 * is `identity is pinned, not derived`: it re-resolves with a DIFFERENT appId and
 * requires the answer not to move. That is the property whose absence caused
 * this, and it cannot be satisfied by any amount of source text.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { validatePublishedReleaseLedger } from '../release-packager/lib/published-releases.mjs'

const require = createRequire(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const packageJson = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'))
const { LEGACY_USER_DATA_NAMES } = require('../../shell/userdata-adoption.cjs')

/* electron-builder's own namespace and hash, not a reimplementation. */
const { UUID } = require('builder-util-runtime')
const ELECTRON_BUILDER_NS_UUID = UUID.parse('50e065bc-3134-11e6-9bab-38c9862bdaf3')

/* The identity the installed base already carries. This is an external fact
   about customers' machines, not a value derived from this repo, which is why
   it is written out rather than computed: it is the thing package.json must
   keep agreeing with. It is UUID.v5('com.toolsenabled.missioncontrol'), the
   appId every shipped build up to and including 1.0.5 used. */
const SHIPPED_PRODUCT_GUID = '21cb002d-a6ac-5e62-b88d-ba3c87d67396'

/* The shipped-version floor used to come from every build/<semver> tag. Those
   tags are candidate provenance: the cutter creates one before anything is
   published so its detached build commit remains reachable. Treating every
   candidate as shipped silently moved the customer downgrade floor without a
   publication. The reviewed config/shipped-releases.json ledger is the only
   publication record now; every row pins its candidate tag to one immutable
   commit and the exact public artifact hash.

   WHY THIS MATTERS ONLY NOW. Before the GUID was pinned, the renamed build
   wrote a SECOND uninstall entry, so its 1.0.3 sat beside Mission Control's
   1.0.5 rather than replacing it. Pinning the GUID is correct and is what
   makes an upgrade an upgrade -- and it is exactly what makes the version
   visible as a regression: one entry in Programs and Features whose
   DisplayVersion now moves 1.0.5 -> 1.0.3. Windows and every update channel
   read that as a downgrade, and so does the person looking at the list. */
function resolveCandidateTag(tag) {
  const resolved = execFileSync('git', ['rev-parse', `${tag}^{commit}`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim()
  return resolved
}

function packageVersionAtRef(ref) {
  const raw = execFileSync('git', ['show', `${ref}:package.json`], { cwd: REPO_ROOT, encoding: 'utf8' })
  return JSON.parse(raw).version
}

const publishedLedger = JSON.parse(readFileSync(path.join(REPO_ROOT, 'config', 'shipped-releases.json'), 'utf8'))
const PUBLISHED_RELEASES = validatePublishedReleaseLedger(publishedLedger, { resolveCandidateTag, packageVersionAtRef })
const shippedVersions = () => PUBLISHED_RELEASES.map((release) => release.version)

/* Numeric compare, so "1.0.10" beats "1.0.9" -- a string compare would not, and
   this product will reach two digits. Returns >0 when a is newer than b. */
function compareVersions(a, b) {
  const parse = (v) => String(v).split('.').map((n) => Number.parseInt(n, 10))
  const left = parse(a)
  const right = parse(b)
  assert.ok(left.every(Number.isInteger), `unparseable version ${a}`)
  assert.ok(right.every(Number.isInteger), `unparseable version ${b}`)
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

function highestVersion(versions) {
  return versions.reduce((highest, candidate) => (
    compareVersions(candidate, highest) > 0 ? candidate : highest
  ))
}

const HIGHEST_SHIPPED_VERSION = highestVersion(shippedVersions())

/* Mirrors NsisTarget.js:157. `nsisDriftGuard` below fails if that line changes
   shape, so this cannot quietly stop describing what the build does. */
function resolveInstallerGuid({ nsisOptions, appId }) {
  return nsisOptions.guid || UUID.v5(appId, ELECTRON_BUILDER_NS_UUID).toString()
}

test('the installer owns the registry key the installed base already uses', () => {
  const guid = resolveInstallerGuid({
    nsisOptions: packageJson.build.nsis,
    appId: packageJson.build.appId,
  })

  assert.equal(
    String(guid).toLowerCase(),
    SHIPPED_PRODUCT_GUID,
    'a build with a different GUID cannot see the existing install and will install beside it',
  )
})

test('identity is pinned, not derived — appId can change without forking the install', () => {
  const asShipped = resolveInstallerGuid({
    nsisOptions: packageJson.build.nsis,
    appId: packageJson.build.appId,
  })
  const afterAnotherRename = resolveInstallerGuid({
    nsisOptions: packageJson.build.nsis,
    appId: 'com.toolsenabled.some-future-rename',
  })

  assert.equal(
    String(afterAnotherRename).toLowerCase(),
    String(asShipped).toLowerCase(),
    'product identity still floats with appId; the next rename orphans every install again',
  )
})

test('the uninstall entry is a single entry, keyed on that identity', () => {
  /* UNINSTALL_APP_KEY is the guid with backslashes replaced; a guid containing
     one would split the registry path and leave a second stray entry, which is
     the shape of the defect this suite exists for. */
  const guid = resolveInstallerGuid({
    nsisOptions: packageJson.build.nsis,
    appId: packageJson.build.appId,
  })

  assert.match(String(guid), /^[0-9a-fA-F-]{36}$/)
})

test('every product name this app has shipped under can still be found', () => {
  /* The GUID pin keeps the INSTALL together. Electron keys userData on
     productName instead, so a rename also has to leave a trail for
     shell/userdata-adoption.cjs -- otherwise the install upgrades correctly and
     the person's data is still stranded. */
  const current = packageJson.productName

  assert.ok(
    LEGACY_USER_DATA_NAMES.includes('Mission Control'),
    'Mission Control shipped to real machines; dropping it strands their userData',
  )
  assert.equal(
    LEGACY_USER_DATA_NAMES.includes(current),
    false,
    'the current productName is the destination, not a source to adopt from',
  )
})

test('the build never lowers the version below an already shipped release', () => {
  /* One entry in Programs and Features, and its number has to go up. This is
     the other half of owning the installed base's registry key: taking the
     entry over is only an upgrade if what lands in DisplayVersion is newer
     than what was there. The release tag for this exact version may already
     be the current published row when this suite runs, so equality is valid; only a lower version is
     the downgrade this assertion forbids. The original 1.0.3-over-1.0.5 case
     remains pinned explicitly in compareVersions' tests below. */
  assert.ok(
    compareVersions(packageJson.version, HIGHEST_SHIPPED_VERSION) >= 0,
    `version ${packageJson.version} is lower than ${HIGHEST_SHIPPED_VERSION}, already shipped under the same GUID; `
    + 'upgrading would move Programs and Features backwards and read as a downgrade',
  )
})

test('the shipped floor comes from the published ledger, not the candidate-tag inventory', () => {
  assert.equal(HIGHEST_SHIPPED_VERSION, highestVersion(shippedVersions()))
  assert.ok(
    shippedVersions().every((version) => compareVersions(HIGHEST_SHIPPED_VERSION, version) >= 0),
    'the derived floor must not sit below any published ledger row',
  )
  assert.ok(PUBLISHED_RELEASES.every((release) => release.candidateTag === `build/${release.version}`))
  assert.ok(PUBLISHED_RELEASES.every((release) => resolveCandidateTag(release.candidateTag) === release.buildRef))
})

test('compareVersions orders releases numerically, not as text', () => {
  /* The guard above is only as good as this comparison. A string compare puts
     1.0.10 BELOW 1.0.9 and would wave through a real regression once the patch
     number reaches two digits. */
  assert.ok(compareVersions('1.0.10', '1.0.9') > 0, '1.0.10 must count as newer than 1.0.9')
  assert.ok(compareVersions('1.0.6', '1.0.5') > 0)
  assert.ok(compareVersions('1.0.3', '1.0.5') < 0)
  assert.equal(compareVersions('1.0.5', '1.0.5'), 0)
  assert.ok(compareVersions('1.1.0', '1.0.99') > 0)
})

test('nsisDriftGuard: electron-builder still resolves the guid the way this suite mirrors', () => {
  /* Secondary, and deliberately so: it does not prove the product's behaviour,
     it proves this file is still describing the dependency correctly. If
     electron-builder changes how a GUID is chosen, the assertions above could
     go on passing while the shipped installer does something else. */
  const source = readFileSync(
    path.join(REPO_ROOT, 'node_modules', 'app-builder-lib', 'out', 'targets', 'nsis', 'NsisTarget.js'),
    'utf8',
  )

  assert.match(
    source,
    /const guid = options\.guid \|\| \w+\.UUID\.v5\(appInfo\.id, ELECTRON_BUILDER_NS_UUID\)/,
    'NsisTarget no longer picks the GUID as mirrored here; re-derive resolveInstallerGuid()',
  )
  assert.match(
    source,
    /UUID\.parse\("50e065bc-3134-11e6-9bab-38c9862bdaf3"\)/,
    'the electron-builder UUID namespace moved; SHIPPED_PRODUCT_GUID must be re-checked',
  )
})
