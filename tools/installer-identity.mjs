#!/usr/bin/env node

// Per-channel Windows installer identity.
//
// WHY THIS FILE EXISTS
// --------------------
// package.json pins one constant:
//
//     "nsis": { "guid": "21cb002d-a6ac-5e62-b88d-ba3c87d67396" }
//
// That GUID is the Windows uninstall-registry key name. Measured live on the
// build machine on 2026-08-12:
//
//     HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\
//         21cb002d-a6ac-5e62-b88d-ba3c87d67396
//         DisplayName    = ToolsEnabled
//         DisplayVersion = 1.0.3
//         Publisher      = ToolsEnabled, Inc. in formation
//
// The pin itself is CORRECT and must stay. tools/test/installer-product-identity.test.mjs
// records why: that GUID is UUID.v5('com.toolsenabled.missioncontrol'), the
// identity every shipped build up to 1.0.5 used. When the product was renamed,
// the unpinned GUID floated to UUID.v5('com.toolsenabled.desktop'), the new
// installer could not see the existing install, and it landed a SECOND product
// beside the customer's copy. Pinning is what makes an upgrade an upgrade.
//
// The defect this file fixes is narrower and different: EVERY build claimed
// that one identity, including a throwaway test build. Installing a test build
// took over the real copy's uninstall entry, and uninstalling the test build
// ran the real copy's uninstaller. That is why install and upgrade have never
// been testable on the owner's own machine.
//
// So: the release channel keeps the pinned identity, unchanged and still
// committed in package.json, so a bare `electron-builder --win nsis` remains
// fail-safe. Only a non-release channel derives a different one, and only when
// this wrapper is asked for it explicitly.
//
// A DIFFERENT GUID ALONE DOES NOT FIX IT
// --------------------------------------
// The GUID only names the registry key. Two other things are derived from
// productName, not from the GUID (verified in the installed app-builder-lib
// 26.15.3 templates):
//
//     templates/nsis/multiUser.nsh:47    StrCpy $INSTDIR "$0\${APP_FILENAME}"
//     templates/nsis/uninstaller.nsh:237 RMDir /r "$APPDATA\${APP_FILENAME}"
//
// and out/targets/nsis/NsisTarget.js:166 sets APP_FILENAME from
// getWindowsInstallationDirName(appInfo), i.e. from productName.
//
// With productName shared, a test build installs over
// %LOCALAPPDATA%\Programs\ToolsEnabled (337 files as measured) and its
// uninstaller deletes %APPDATA%\ToolsEnabled -- the live user profile
// (94 files as measured). So channel isolation has to move productName too.
// This module moves both together and refuses to emit an identity where they
// disagree.
//
// WHAT IS STABLE AND WHAT VARIES
// ------------------------------
// Stable per CHANNEL, deliberately NOT per version. An installer upgrades an
// existing install by finding the same uninstall key; if the GUID changed per
// version, 1.0.6 -> 1.0.7 would leave two installed copies and two uninstall
// entries on every customer's machine. Per-version identity would make upgrade
// permanently broken rather than merely untested. See RELEASE_GUID below for
// why the release channel's value is a fixed compatibility constant.

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

// app-builder-lib's own namespace, from
// node_modules/app-builder-lib/out/targets/nsis/NsisTarget.js:28
export const ELECTRON_BUILDER_NS_UUID = '50e065bc-3134-11e6-9bab-38c9862bdaf3';

export const RELEASE_CHANNEL = 'release';

// The release channel's GUID is pinned, and that is correct: a product's
// installed identity must never move, or already-installed copies stop
// receiving upgrades and accumulate duplicate entries. This exact value is
// already in the field (see the registry reading above), so it is a
// compatibility constant, not a placeholder. Do not "derive" this one.
// It must stay equal to package.json build.nsis.guid; assertReleasePinAgrees()
// below is what makes a drift between the two loud instead of silent.
export const RELEASE_GUID = '21cb002d-a6ac-5e62-b88d-ba3c87d67396';

// NSIS uses productName as the installation directory name only if it matches
// this set; otherwise app-builder-lib falls back to appInfo.sanitizedName,
// which is channel-independent and would silently re-collide the install dir.
// getWindowsInstallationDirName(), app-builder-lib/out/targets/targetUtil.js:41
const NSIS_DIR_SAFE = /^[-_+0-9a-zA-Z .]+$/;

const CHANNEL_SYNTAX = /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/;

function uuidBytes(uuid) {
  const hex = String(uuid).replace(/-/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error(`not a UUID: ${uuid}`);
  return Buffer.from(hex, 'hex');
}

// Standard RFC 4122 v5. Byte-for-byte the same construction as
// builder-util-runtime's UUID.v5 (out/uuid.js: sha1 over namespace then name,
// version nibble 0x50, variant 0x80). installer-identity.test.mjs asserts that
// equivalence against the installed package rather than trusting this comment.
export function uuidV5(name, namespace = ELECTRON_BUILDER_NS_UUID) {
  if (typeof name !== 'string' || name.length === 0) throw new Error('uuidV5 needs a non-empty name');
  const digest = createHash('sha1').update(uuidBytes(namespace)).update(name, 'utf8').digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Explicit env wins; otherwise a semver prerelease tag names the channel
// (1.0.7-rc.1 -> "rc"), so a prerelease build can never be mistaken for the
// shipping product. Everything else is the release channel.
export function resolveChannel({ env = {}, version = '' } = {}) {
  const explicit = (env.TE_INSTALL_CHANNEL ?? '').trim();
  if (explicit) return normalizeChannel(explicit);
  const prerelease = /^\d+\.\d+\.\d+-([0-9A-Za-z.-]+)$/.exec(String(version));
  if (prerelease) return normalizeChannel(prerelease[1].split('.')[0]);
  return RELEASE_CHANNEL;
}

export function normalizeChannel(raw) {
  const channel = String(raw).trim().toLowerCase();
  if (!CHANNEL_SYNTAX.test(channel)) {
    throw new Error(`invalid channel ${JSON.stringify(raw)}: use 1-24 chars of a-z, 0-9 and '-', not starting or ending with '-'`);
  }
  return channel;
}

function channelLabel(channel) {
  return channel.split('-').filter(Boolean).map((word) => word[0].toUpperCase() + word.slice(1)).join(' ');
}

export function deriveInstallIdentity({ appId, productName, version, channel } = {}) {
  if (!appId) throw new Error('deriveInstallIdentity needs appId');
  if (!productName) throw new Error('deriveInstallIdentity needs productName');
  const resolved = normalizeChannel(channel ?? RELEASE_CHANNEL);
  const isRelease = resolved === RELEASE_CHANNEL;

  const guid = isRelease ? RELEASE_GUID : uuidV5(`${appId}#${resolved}`, ELECTRON_BUILDER_NS_UUID);
  const channelProductName = isRelease ? productName : `${productName} ${channelLabel(resolved)}`;

  if (!NSIS_DIR_SAFE.test(channelProductName)) {
    // Refusing here is the point: a productName NSIS cannot use as a directory
    // name silently collapses to the shared sanitizedName and the test build
    // installs over the real one again.
    throw new Error(`productName ${JSON.stringify(channelProductName)} is not usable as an NSIS install directory name; channel isolation would silently collapse`);
  }
  if (!isRelease && guid === RELEASE_GUID) throw new Error('derived a non-release channel onto the release GUID');

  return {
    channel: resolved,
    isRelease,
    appId,
    version: version ?? null,
    guid,
    productName: channelProductName,
    installDirName: channelProductName,
    userDataDirName: channelProductName,
    uninstallDisplayName: isRelease ? '${productName}' : '${productName} ${version}',
    updaterCacheDirName: isRelease ? 'toolsenabled-updater' : `toolsenabled-updater-${resolved}`,
  };
}

// The committed pin and RELEASE_GUID are two copies of one external fact about
// customers' machines. If they ever disagree, one of them is silently wrong and
// a release build would orphan the installed base again -- so refuse.
export function assertReleasePinAgrees(packageJson) {
  const pinned = packageJson?.build?.nsis?.guid;
  if (!pinned) {
    throw new Error('package.json build.nsis.guid is missing; a release build would derive a GUID from appId and install beside the existing base instead of upgrading it');
  }
  if (String(pinned).toLowerCase() !== RELEASE_GUID) {
    throw new Error(`package.json build.nsis.guid (${pinned}) disagrees with RELEASE_GUID (${RELEASE_GUID}); one of them no longer describes the installed base`);
  }
  return String(pinned).toLowerCase();
}

// electron-builder deep-merges --config dot-notation over the package.json
// "build" block (app-builder-lib/out/util/config/config.js:23), so these are
// overrides on top of the committed config, not a replacement for it.
//
// A release build emits NO identity overrides at all. The committed config is
// already correct for release, and re-stating it here would create a second
// place for it to drift.
/* NO publish.* OVERRIDES, AND THAT IS THE FIX FOR A BROKEN COMMAND.
 *
 * This used to emit `-c.publish.channel` and `-c.publish.updaterCacheDirName`
 * for every non-release build. Both are auto-updater settings, and this product
 * has NO auto-updater: electron-updater is not a dependency, and the `publish`
 * block was deliberately taken out of package.json so the installer would stop
 * shipping an inert resources/app-update.yml describing a mechanism the app
 * does not have.
 *
 * With no base block to merge into, dot-notation SYNTHESISES one, and
 * electron-builder 26.15.3 rejects the shape it produces:
 *
 *   configuration.publish should be array | null | string
 *   configuration.publish.channel should be string | null
 *
 * So every isolated build exited non-zero before compiling, which meant
 * `npm run dist:test` was broken and there was no supported way to build an
 * installer that does not carry the release identity. That matters more than a
 * broken script: the release GUID is deliberately the same identity as an
 * installed copy, and electron-builder's initMultiUser reads that identity's
 * existing InstallLocation, so `/D=<scratch>` is NOT a fence. Without this
 * command there is no safe way to exercise the installer on a machine that has
 * the product installed.
 *
 * The isolation that actually isolates is untouched: guid, productName and
 * uninstallDisplayName. Channel and updater cache name isolated an updater that
 * is not there.
 *
 * A REAL publish configuration would need the block to exist in package.json
 * first, in the array-or-string shape the schema names -- which is a decision
 * about shipping an updater, not something to smuggle in through an override. */
export function builderOverrides(identity, { updateFeedUrl } = {}) {
  const args = [];
  if (!identity.isRelease) {
    args.push(
      `-c.nsis.guid=${identity.guid}`,
      `-c.productName=${identity.productName}`,
      `-c.nsis.uninstallDisplayName=${identity.uninstallDisplayName}`,
    );
  }
  if (updateFeedUrl) {
    /* Refused rather than emitted. `-c.publish.url` synthesises the same
       invalid object as the two above, so passing it would fail identically --
       but opaquely, inside electron-builder, several steps from the cause. */
    throw new Error(
      'TE_UPDATE_FEED_URL is set, but this package declares no build.publish block and ships no '
      + 'auto-updater (electron-updater is not a dependency). A -c.publish.url override would '
      + 'synthesise a configuration electron-builder rejects: "configuration.publish should be '
      + 'array | null | string". Add a real publish block to package.json first.',
    );
  }
  return args;
}

function readEnvFeedUrl(env) {
  const raw = (env.TE_UPDATE_FEED_URL ?? '').trim();
  if (!raw) return null;
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error(`TE_UPDATE_FEED_URL is not a URL: ${raw}`); }
  if (parsed.protocol !== 'https:') throw new Error(`TE_UPDATE_FEED_URL must be https, got ${parsed.protocol}`);
  return raw;
}

// =============================================================================
// THE REGISTRATION CHECK -- because /D= IS NOT A FENCE
// =============================================================================
//
// MEASURED 2026-08-23, on this machine, by an agent that walked into it: stale
// `ToolsEnabled Test 1.0.20` registry records were sitting in HKCU with their
// InstallLocation pointing at THE OWNER'S REAL RELEASE INSTALL ROOT. They were
// left behind by an older lifecycle build.
//
// Why that is dangerous rather than untidy: electron-builder's `initMultiUser`
// resolves $INSTDIR from the EXISTING registration for the GUID before the
// install section runs, and it gives that registration precedence over `/D=`.
// So a test-identity installer would have installed into the real product's
// directory, and its uninstaller's `RMDir /r $INSTDIR` would have deleted it.
//
// THIS IS THE THIRD SEPARATE WAY THIS ISOLATION MECHANISM HAS BEEN FOUND TO
// LEAK, and the three fail differently, which is why none of them caught the
// others: the GUID could collide (fixed by deriving it), the pre-rename data
// path was literal for every product (fixed by the successor fence in
// build/installer.nsh), and now the registry state UNDER a correctly derived
// GUID can point anywhere at all. The first two are properties of the build.
// This one is a property of the machine, so no test over the source can see it
// and it has to be asked at the moment of use.
//
// It is deliberately NOT wired into --exec. Building an installer is safe; it
// is INSTALLING that follows the registration, and this tool does not install.
// A check bolted to the wrong verb would read as protection and provide none.

const INSTALL_IDENTITY_KEY = 'HKCU\\Software';
const nodeRequire = createRequire(import.meta.url);

/* Reads the install-identity key electron-builder writes for a GUID.
 *
 * THREE ANSWERS, NOT TWO, AND THE THIRD IS WHY THIS COMMENT EXISTS. The first
 * version of this function had two: a registration, or null meaning "no
 * registration". An unparseable answer took the null path, so it read as
 * ABSENT -- and absent is the path that lets an install proceed. A localized
 * `reg` output, a truncated read, an access-denied, or any future change to the
 * tool's format would therefore WAVE THE INSTALL THROUGH while looking like a
 * clean result. That is fail-open on the exact question this fence exists to
 * answer, and the test written alongside it pinned the behaviour rather than
 * the property, which is how it survived review.
 *
 * So: `registration` is a real reading, `null` means the key genuinely is not
 * there (the tool ran and said so), and `unreadable` means we could not tell.
 * The caller must treat unreadable as a refusal -- "could not look" is not
 * "nothing there", and this codebase already holds that line elsewhere for the
 * vault's presence check.
 *
 * `runner` is injected so this is testable without a real registry: it returns
 * the tool's stdout, or null when the tool itself reported the key is absent. */
export function readInstallRegistration(guid, { runner, platform = process.platform } = {}) {
  if (platform !== 'win32') return { supported: false, registration: null, unreadable: false };
  const query = runner || defaultRegQuery;
  const raw = query(`${INSTALL_IDENTITY_KEY}\\${guid}`);
  /* The tool answered "no such key". That is a fact, not a failure. */
  if (raw == null) return { supported: true, registration: null, unreadable: false };
  const value = /^\s*InstallLocation\s+REG_SZ\s+(.+?)\s*$/m.exec(raw);
  if (!value) {
    return {
      supported: true,
      registration: null,
      unreadable: true,
      detail: String(raw).trim().split('\n')[0].slice(0, 120),
    };
  }
  return { supported: true, registration: { installLocation: value[1] }, unreadable: false };
}

function defaultRegQuery(key) {
  /* Resolved here rather than at module top: `reg` is a Windows program, and
     these unit tests are loaded on any platform. Keeping the lookup lazy keeps
     the import side of this module platform-free. */
  const { spawnSync } = nodeRequire('node:child_process');
  const result = spawnSync('reg', ['query', key, '/v', 'InstallLocation'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  return result.stdout;
}

/* True containment, not a prefix match: "C:\\Temp\\foo" must not be judged to
   contain "C:\\Temp\\foobar". Case-insensitive, because Windows paths are. */
export function pathIsWithin(child, parent, pathModule) {
  const rel = pathModule.relative(pathModule.resolve(parent), pathModule.resolve(child));
  if (rel === '') return true;
  if (pathModule.isAbsolute(rel)) return false;
  return !rel.split(pathModule.sep).includes('..');
}

/* The verdict. `expectUnder` is REQUIRED and that is on purpose: without a
   stated intended root there is nothing to compare against, and answering
   "registered somewhere" would be an inspection dressed as a check. */
export function registrationVerdict(identity, { expectUnder, runner, platform, pathModule }) {
  if (identity.isRelease) {
    return {
      ok: false,
      code: 'RELEASE_CHANNEL_NOT_CHECKABLE',
      message: 'This check protects the real install from a NON-release build. On the release channel '
        + 'an existing InstallLocation is the real install, and finding it is correct, not a warning.',
    };
  }
  if (!expectUnder) {
    return {
      ok: false,
      code: 'EXPECTED_ROOT_REQUIRED',
      message: 'Pass --expect-under <dir> naming the directory you intend to install into. '
        + 'Without it there is nothing to compare the registration against.',
    };
  }
  const { supported, registration, unreadable, detail } = readInstallRegistration(identity.guid, { runner, platform });
  if (!supported) {
    return { ok: false, code: 'PLATFORM_UNSUPPORTED', message: 'Windows installer registrations can only be read on Windows.' };
  }
  /* COULD NOT LOOK IS NOT NOTHING THERE, and this branch is the whole reason
     readInstallRegistration returns three answers. Before it existed, an answer
     this parser did not recognise fell through to NOT_REGISTERED and the install
     was allowed -- fail-open on the one question the fence is for. */
  if (unreadable) {
    return {
      ok: false,
      code: 'REGISTRATION_UNREADABLE',
      message: 'REFUSING: the registry answered for this identity in a form this check does not '
        + `recognise, so whether the machine is already registered is UNKNOWN, not absent. Got: "${detail}". `
        + 'Read the key by hand before installing; an unrecognised answer is exactly what a stale '
        + 'registration pointing at the real install would look like if the tool output ever changes.',
    };
  }
  if (!registration) {
    return { ok: true, code: 'NOT_REGISTERED', message: `No registration for ${identity.guid}. /D= will decide the directory.`, registration: null };
  }
  const within = pathIsWithin(registration.installLocation, expectUnder, pathModule);
  if (within) {
    return { ok: true, code: 'REGISTERED_WITHIN_EXPECTED', message: `Registered at ${registration.installLocation}, inside the intended root.`, registration };
  }
  return {
    ok: false,
    code: 'REGISTERED_OUTSIDE_EXPECTED',
    registration,
    message: `REFUSING: ${identity.productName} is already registered with InstallLocation `
      + `${registration.installLocation}, which is OUTSIDE ${expectUnder}. initMultiUser gives that `
      + 'registration precedence over /D=, so installing would land there and uninstalling would '
      + 'delete it. Remove that registration first, and check what it points at before you do.',
  };
}

export async function identityFromPackageJson(packageJsonPath, env = process.env, channelOverride = null) {
  const { readFile } = await import('node:fs/promises');
  const pkg = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  assertReleasePinAgrees(pkg);
  const appId = pkg.build?.appId;
  const productName = pkg.build?.productName ?? pkg.productName;
  const channel = channelOverride ? normalizeChannel(channelOverride) : resolveChannel({ env, version: pkg.version });
  return {
    identity: deriveInstallIdentity({ appId, productName, version: pkg.version, channel }),
    updateFeedUrl: readEnvFeedUrl(env),
  };
}

async function main(argv) {
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const packageJsonPath = path.join(repoRoot, 'package.json');

  // Only our own flags, never the electron-builder passthrough after --exec.
  const ownArgs = argv.includes('--exec') ? argv.slice(0, argv.indexOf('--exec')) : argv;
  const channelIndex = ownArgs.indexOf('--channel');
  if (channelIndex !== -1 && !ownArgs[channelIndex + 1]) throw new Error('--channel needs a value');
  const channelOverride = channelIndex === -1 ? null : ownArgs[channelIndex + 1];

  const { identity, updateFeedUrl } = await identityFromPackageJson(packageJsonPath, process.env, channelOverride);
  const overrides = builderOverrides(identity, { updateFeedUrl });

  const execIndex = argv.indexOf('--exec');
  if (execIndex === -1) {
    // Note: not `--channel`, which is the value-taking override flag above.
    if (argv.includes('--guid')) { console.log(identity.guid); return 0; }
    if (argv.includes('--print-channel')) { console.log(identity.channel); return 0; }
    if (argv.includes('--builder-args')) { console.log(overrides.join('\n')); return 0; }
    if (argv.includes('--check-registration')) {
      const at = argv.indexOf('--expect-under');
      const verdict = registrationVerdict(identity, {
        expectUnder: at === -1 ? null : argv[at + 1],
        pathModule: path,
      });
      /* The refusal goes to stderr and the exit code is 2, so a lifecycle script
         that forgets to read the output still stops. A guard whose only signal
         is a printed line is a guard somebody will run and ignore. */
      (verdict.ok ? console.log : console.error)(`[installer-identity] ${verdict.code}: ${verdict.message}`);
      return verdict.ok ? 0 : 2;
    }
    console.log(JSON.stringify({ ...identity, updateFeedUrl, builderArgs: overrides }, null, 2));
    return 0;
  }

  const passthrough = argv.slice(execIndex + 1);
  const { spawnSync } = await import('node:child_process');
  // The package's declared bin, not the inner module: node_modules/electron-builder/package.json
  // maps "electron-builder" -> "./cli.js".
  const cli = path.join(repoRoot, 'node_modules', 'electron-builder', 'cli.js');
  const args = [cli, ...passthrough, ...overrides];
  console.log(`[installer-identity] channel=${identity.channel} guid=${identity.guid} productName=${JSON.stringify(identity.productName)}`);
  console.log(identity.isRelease
    ? '[installer-identity] release channel: no identity override; the committed package.json config is used verbatim'
    : `[installer-identity] non-release channel: installs to its own directory and uninstall entry, leaving the release install untouched`);
  /* There is no committed publish.url to fall back to, and saying there was is
     what this line used to do. package.json declares no build.publish block on
     purpose -- the product ships no electron-updater and checks for updates by
     reading the download manifest instead -- so the honest report is that the
     installer carries no feed at all. */
  console.log('[installer-identity] no update feed: this package declares no build.publish and the installer ships no app-update.yml');
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: repoRoot });
  if (result.error) { console.error(`[installer-identity] failed to start electron-builder: ${result.error.message}`); return 1; }
  return result.status ?? 1;
}

if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL((await import('node:path')).resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
