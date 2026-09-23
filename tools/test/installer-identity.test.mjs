// Proof for tools/installer-identity.mjs.
//
// The defect this guards against was measured, not supposed: on 2026-08-12 the
// build machine carried a real install registered under the exact GUID that
// package.json pinned for every build --
//
//   HKCU\...\Uninstall\21cb002d-a6ac-5e62-b88d-ba3c87d67396
//     DisplayName = ToolsEnabled, DisplayVersion = 1.0.3
//
// so a test build shared the real copy's uninstall entry, install directory,
// and %APPDATA% profile directory. These tests assert the three properties
// that make that impossible, and one property that keeps upgrade working.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import {
  ELECTRON_BUILDER_NS_UUID,
  RELEASE_CHANNEL,
  RELEASE_GUID,
  assertReleasePinAgrees,
  builderOverrides,
  deriveInstallIdentity,
  normalizeChannel,
  resolveChannel,
  uuidV5,
} from '../installer-identity.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);

const APP_ID = 'com.toolsenabled.desktop';
const PRODUCT = 'ToolsEnabled';

const identity = (channel, version = '1.0.6') =>
  deriveInstallIdentity({ appId: APP_ID, productName: PRODUCT, version, channel });

// --- the derivation itself ------------------------------------------------

test('uuidV5 matches electron-builder\'s own UUID.v5 byte for byte', () => {
  // Rather than trusting a comment that says "this is standard v5", compare
  // against the implementation electron-builder will actually use.
  const { UUID } = require('builder-util-runtime');
  const namespace = UUID.parse(ELECTRON_BUILDER_NS_UUID);
  for (const name of [APP_ID, `${APP_ID}#test`, `${APP_ID}#rc`, 'x']) {
    assert.equal(uuidV5(name), String(UUID.v5(name, namespace)), `mismatch for ${name}`);
  }
});

test('uuidV5 emits a well-formed version-5 variant-1 UUID', () => {
  const value = uuidV5(`${APP_ID}#test`);
  assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

// --- stability ------------------------------------------------------------

test('a channel derives the same GUID every time it is computed', () => {
  for (const channel of [RELEASE_CHANNEL, 'test', 'rc', 'beta']) {
    const runs = new Set(Array.from({ length: 25 }, () => identity(channel).guid));
    assert.equal(runs.size, 1, `${channel} was not stable across repeated derivation`);
  }
});

test('a channel keeps one identity across versions, so upgrades still find it', () => {
  // This is the property that makes upgrade testable at all. If identity moved
  // per version, 1.0.6 -> 1.0.7 would leave two installs and two uninstall
  // entries on every customer machine.
  const versions = ['1.0.3', '1.0.6', '1.0.7', '2.4.11'];
  for (const channel of [RELEASE_CHANNEL, 'test']) {
    const guids = new Set(versions.map((version) => identity(channel, version).guid));
    const names = new Set(versions.map((version) => identity(channel, version).productName));
    assert.equal(guids.size, 1, `${channel} GUID drifted across versions`);
    assert.equal(names.size, 1, `${channel} productName drifted across versions`);
  }
});

test('the release identity is exactly what is already installed in the field', () => {
  const release = identity(RELEASE_CHANNEL);
  assert.equal(release.guid, RELEASE_GUID);
  assert.equal(release.guid, '21cb002d-a6ac-5e62-b88d-ba3c87d67396');
  assert.equal(release.productName, PRODUCT);
  assert.equal(release.isRelease, true);
});

// --- isolation ------------------------------------------------------------

test('every non-release channel is distinct from release and from each other', () => {
  const channels = [RELEASE_CHANNEL, 'test', 'rc', 'beta', 'nightly', 'qa'];
  const rows = channels.map((channel) => identity(channel));

  const guids = rows.map((row) => row.guid);
  assert.equal(new Set(guids).size, channels.length, 'two channels share an uninstall registry key');

  const dirs = rows.map((row) => row.installDirName);
  assert.equal(new Set(dirs).size, channels.length, 'two channels share an install directory');

  const caches = rows.map((row) => row.updaterCacheDirName);
  assert.equal(new Set(caches).size, channels.length, 'two channels share an updater cache');

  for (const row of rows.filter((r) => !r.isRelease)) {
    assert.notEqual(row.guid, RELEASE_GUID, `${row.channel} collides with the shipped release GUID`);
    assert.notEqual(row.installDirName, PRODUCT, `${row.channel} installs over the real copy`);
  }
});

test('a test channel cannot address the real copy through any of the three paths', () => {
  const release = identity(RELEASE_CHANNEL);
  const testing = identity('test');
  // registry key, install directory, and the %APPDATA% tree the uninstaller
  // deletes (templates/nsis/uninstaller.nsh:237) must all differ.
  assert.notEqual(testing.guid, release.guid);
  assert.notEqual(testing.installDirName, release.installDirName);
  assert.notEqual(testing.userDataDirName, release.userDataDirName);
});

test('a derived productName stays usable as an NSIS install directory name', () => {
  // If it is not, app-builder-lib falls back to the channel-independent
  // sanitizedName and the isolation silently disappears.
  const NSIS_DIR_SAFE = /^[-_+0-9a-zA-Z .]+$/;
  for (const channel of ['test', 'rc', 'beta', 'nightly', 'release-candidate', 'qa2']) {
    assert.match(identity(channel).productName, NSIS_DIR_SAFE);
  }
});

// --- channel resolution ---------------------------------------------------

test('channel resolution: env wins, then a prerelease tag, then release', () => {
  assert.equal(resolveChannel({ env: {}, version: '1.0.6' }), 'release');
  assert.equal(resolveChannel({ env: {}, version: '1.0.7-rc.1' }), 'rc');
  assert.equal(resolveChannel({ env: {}, version: '1.0.7-test' }), 'test');
  assert.equal(resolveChannel({ env: { TE_INSTALL_CHANNEL: 'test' }, version: '1.0.6' }), 'test');
  assert.equal(resolveChannel({ env: { TE_INSTALL_CHANNEL: 'TEST' }, version: '1.0.6' }), 'test');
  // an explicit channel overrides even a prerelease version
  assert.equal(resolveChannel({ env: { TE_INSTALL_CHANNEL: 'qa' }, version: '1.0.7-rc.1' }), 'qa');
});

test('a malformed channel is refused rather than silently sanitised', () => {
  for (const bad of ['', ' ', '-test', 'test-', 'te st', 'test/prod', 'a'.repeat(25), 'ünicode']) {
    assert.throws(() => normalizeChannel(bad), /invalid channel/, `accepted ${JSON.stringify(bad)}`);
  }
});

test('deriveInstallIdentity refuses incomplete input', () => {
  assert.throws(() => deriveInstallIdentity({ productName: PRODUCT }), /appId/);
  assert.throws(() => deriveInstallIdentity({ appId: APP_ID }), /productName/);
});

// --- the overrides handed to electron-builder -----------------------------

test('a release build emits no identity override at all', () => {
  // The committed config is already correct for release. Re-stating it in the
  // wrapper would give the installed base's identity a second home to drift in.
  const args = builderOverrides(identity(RELEASE_CHANNEL));
  assert.deepEqual(args, []);
});

test('a non-release build overrides every field that could reach the real copy', () => {
  const args = builderOverrides(identity('test'));
  assert.ok(args.includes('-c.nsis.guid=bcf2eb9a-404d-5a33-91d2-441f04bcf924'));
  assert.ok(args.includes('-c.productName=ToolsEnabled Test'));
  assert.ok(args.some((a) => a.startsWith('-c.nsis.uninstallDisplayName=')));
});

/* THIS ASSERTION USED TO PIN THE DEFECT, so it is worth saying what changed.
 *
 * It read `assert.ok(args.includes('-c.publish.channel=test'))` -- requiring the
 * very override that made every isolated build fail. package.json deliberately
 * declares no build.publish block (this product ships no auto-updater;
 * electron-updater is not a dependency), so dot-notation synthesised one and
 * electron-builder 26.15.3 refused it:
 *
 *   configuration.publish should be array | null | string
 *
 * The suite passed throughout, because it only ever checked that the argument
 * STRINGS were present -- it never ran the wrapper against the schema. A green
 * test over a command that cannot run is the shape this codebase has shipped
 * before, and it is why `npm run dist:test` was broken while nothing said so.
 *
 * What is asserted now is the property that actually matters: a non-release
 * build must not emit publish.* at all. */
test('a non-release build emits no publish override', () => {
  const args = builderOverrides(identity('test'));
  assert.ok(!args.some((a) => a.startsWith('-c.publish.')),
    'there is no build.publish block to merge into; electron-builder rejects the synthesised object');
});

test('a feed URL is refused loudly rather than emitted invalidly', () => {
  assert.ok(!builderOverrides(identity('test')).some((a) => a.startsWith('-c.publish.url=')));
  /* -c.publish.url synthesises the same invalid object as the two overrides
     removed above, so emitting it would fail identically -- but opaquely,
     several steps inside electron-builder and far from the cause. Refusing at
     the seam names the reason and the remedy. */
  assert.throws(
    () => builderOverrides(identity('test'), { updateFeedUrl: 'https://example.invalid/u/' }),
    /build\.publish/,
  );
});

// --- the committed config -------------------------------------------------

test('package.json still pins the identity the installed base already carries', async () => {
  // Removing this pin is NOT the fix. tools/test/installer-product-identity.test.mjs
  // records the measured defect it prevents: unpinned, the GUID floats with
  // appId, and the 1.0.5 -> renamed build installed a second product beside the
  // customer's copy instead of upgrading it. The pin stays; only non-release
  // channels move off it.
  const pkg = JSON.parse(await readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.build?.nsis?.guid, RELEASE_GUID);
  assert.equal(pkg.build?.appId, APP_ID, 'appId moved; RELEASE_GUID continuity needs re-checking');
  assert.equal(pkg.productName, PRODUCT, 'productName moved; channel derivation assumes this base');
});

test('a drift between the committed pin and RELEASE_GUID is refused, not averaged', () => {
  assert.equal(assertReleasePinAgrees({ build: { nsis: { guid: RELEASE_GUID } } }), RELEASE_GUID);
  assert.throws(() => assertReleasePinAgrees({ build: { nsis: {} } }), /missing/);
  assert.throws(() => assertReleasePinAgrees({ build: {} }), /missing/);
  assert.throws(
    () => assertReleasePinAgrees({ build: { nsis: { guid: '1de271ec-9b43-59e5-b4aa-0fd300d862cb' } } }),
    /disagrees with RELEASE_GUID/,
  );
});

test('the shipping chain still runs electron-builder directly, so it is fail-safe', async () => {
  // A release installer must be buildable without this wrapper: if the ship
  // path depended on it, a bare `electron-builder --win nsis` would silently
  // produce a build with a derived GUID and orphan the installed base.
  const pkg = JSON.parse(await readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.dist, /(?:^|\s)electron-builder(?=\s|$).*?--win\s+nsis(?=\s|$)/);
  assert.ok(!pkg.scripts.dist.includes('installer-identity'), 'the release ship path must not route through the channel wrapper');
  assert.match(pkg.scripts['dist:test'], /installer-identity\.mjs --channel test --exec --win nsis/);
});

test('package.json declares no update feed; the way to ship a fix is the application’s own check', async () => {
  /* This test used to require a `publish` block, on the reasoning that without
     latest.yml "there is no way to ship a fix". The block made electron-builder
     write resources/app-update.yml into every installed copy -- a file that
     described an updater the product did not have (electron-updater was never a
     dependency, nothing called autoUpdater). The way to ship a fix is now
     shell/update-check.cjs, which reads the site's own download manifest and
     installs only what it has hashed; so the block is gone, and this pins that
     it stays gone and that the replacement is present. */
  const pkg = JSON.parse(await readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.build?.publish, undefined, 'a publish block ships an app-update.yml describing a mechanism this product does not have');
  assert.equal(pkg.dependencies?.['electron-updater'], undefined);
  assert.equal(pkg.devDependencies?.['electron-updater'], undefined);
  const checker = await readFile(path.join(REPO_ROOT, 'shell', 'update-check.cjs'), 'utf8');
  assert.match(checker, /download\/download\.json/, 'the update check reads the download manifest the release step writes');
});

test('code signing is still honestly declared as absent', async () => {
  // Guard against a future edit that "fixes" the SmartScreen warning by
  // asserting a certificate this project does not have.
  const pkg = JSON.parse(await readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const win = pkg.build?.win ?? {};
  for (const key of ['certificateFile', 'certificateSubjectName', 'certificateSha1', 'signtoolOptions', 'azureSignOptions']) {
    assert.equal(win[key], undefined, `${key} is set but no certificate has been purchased`);
  }
  assert.equal(win.forceCodeSigning, undefined, 'forceCodeSigning would fail the build with no certificate');
});

// --- the overrides are checked against electron-builder, not against prose ---
//
// WHY THIS EXISTS. Everything above asserts what the argument STRINGS say. None
// of it asserted that electron-builder would accept them, and for eleven days it
// would not: `npm run dist:test` -- the only supported way to build an installer
// that does not collide with the release identity -- exited before compilation
// with
//
//   configuration.publish should be array | null | string
//
// while this suite stayed green. Worse, the green came from a file that already
// held the contradiction: `assert.equal(pkg.build?.publish, undefined)` a few
// tests up is TRUE, and `-c.publish.channel=` was emitted anyway, so the wrapper
// synthesised a `publish` object out of nothing. Two assertions, both passing,
// describing incompatible worlds -- because neither one ever put the two halves
// together.
//
// So this gate does not re-state a rule in the test's own words. It applies the
// overrides the way electron-builder's dot-notation applies them and validates
// the result against `app-builder-lib/scheme.json` -- electron-builder's OWN
// schema, the exact instrument that did the rejecting. It therefore keeps
// telling the truth when electron-builder changes its mind, which a hand-copied
// rule would not.

/* electron-builder resolves `-c.a.b=v` by dot-notation onto the config object,
   creating intermediate objects that were not there. That creation is the whole
   defect, so it is reproduced faithfully rather than approximated. */
function applyDotOverride(config, arg) {
  const eq = arg.indexOf('=');
  assert.ok(arg.startsWith('-c.') && eq > 3, `not a -c override: ${arg}`);
  const segments = arg.slice(3, eq).split('.');
  let node = config;
  for (const key of segments.slice(0, -1)) {
    if (typeof node[key] !== 'object' || node[key] === null) node[key] = {};
    node = node[key];
  }
  node[segments.at(-1)] = arg.slice(eq + 1);
}

async function validatorAndBuild() {
  /* Both of these arrive WITH electron-builder. If either is missing then
     `node_modules/electron-builder/cli.js` is missing too and dist:test cannot
     run at all -- so this fails loudly instead of skipping. A gate that quietly
     excuses itself is the shape that let the defect above live. */
  let Ajv;
  let scheme;
  try {
    Ajv = require('ajv');
    scheme = require('app-builder-lib/scheme.json');
  } catch (err) {
    assert.fail(`cannot validate installer overrides: ${err.message}. electron-builder must be installed for dist:test to mean anything.`);
  }
  const ajv = new Ajv({ allErrors: true, strict: false });
  const pkg = JSON.parse(await readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  return { validate: ajv.compile(scheme), build: pkg.build };
}

const withOverrides = (build, args) => {
  const config = structuredClone(build);
  for (const arg of args) applyDotOverride(config, arg);
  return config;
};

test('a non-release build produces a configuration electron-builder accepts', async () => {
  const { validate, build } = await validatorAndBuild();
  const config = withOverrides(build, builderOverrides(identity('test')));
  const ok = validate(config);
  assert.ok(ok, `dist:test cannot build: ${JSON.stringify(validate.errors?.slice(0, 4))}`);
});

test('the release configuration is accepted with no overrides at all', async () => {
  const { validate, build } = await validatorAndBuild();
  assert.deepEqual(builderOverrides(identity(RELEASE_CHANNEL)), []);
  assert.ok(validate(structuredClone(build)), `the committed config is invalid: ${JSON.stringify(validate.errors?.slice(0, 4))}`);
});

test('the gate has teeth: the overrides that broke dist:test are rejected', async () => {
  /* The mutation check, kept as an assertion rather than performed once by hand
     and written up in a comment. If a later edit re-adds a publish override --
     for an updater, a channel, a cache directory -- the test above turns red,
     and this one proves it turns red for the right reason. */
  const { validate, build } = await validatorAndBuild();
  const config = withOverrides(build, [
    ...builderOverrides(identity('test')),
    '-c.publish.channel=test',
    '-c.publish.updaterCacheDirName=ToolsEnabled-Test',
  ]);
  assert.equal(validate(config), false, 'publish.* is only valid on a real publish provider, and this package declares none');
  assert.ok(validate.errors.some((e) => String(e.instancePath).startsWith('/publish')),
    'the rejection must be about publish, not something incidental');
});
