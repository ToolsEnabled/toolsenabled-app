// Proof for tools/code-signing/ (Windows): the Azure Artifact Signing gate,
// the electron-builder sign hook, and the owner's preflight.
//
// The product has always shipped unsigned and says so. These tests pin the
// three states the gate allows and nothing else:
//   OFF          nothing configured -> signExecutable:false, nothing signs,
//                not even a stray CSC_LINK;
//   REFUSED      partly configured  -> the build stops and names what is missing;
//   ON           fully configured   -> every file goes through the hook, which
//                runs Microsoft's documented SignTool + dlib command and reads
//                the signature back before the build may continue.
// Nothing here can reach Microsoft: the SignTool/PowerShell runner is injected.
// A real signature needs the publisher's validated Artifact Signing account and is
// NOT proved by this file (see tools/code-signing/README.md, "What is not
// proved").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { ownedFixtureTempRoot } from './lib/owned-fixture-temp.mjs';
import { preflight } from '../code-signing/artifact-signing-preflight.mjs';

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const signing = require('../code-signing/windows-signing.cjs');
const { createSigner } = require('../code-signing/artifact-signing-sign.cjs');
const gate = require('../code-signing/electron-builder-signing.cjs');

const COMPLETE = Object.freeze({
  TOOLSENABLED_ARTIFACT_SIGNING_ENDPOINT: 'https://wus2.codesigning.azure.net',
  TOOLSENABLED_ARTIFACT_SIGNING_ACCOUNT: 'example-signing-account',
  TOOLSENABLED_ARTIFACT_SIGNING_PROFILE: 'toolsenabled-public-trust',
  TOOLSENABLED_ARTIFACT_SIGNING_PUBLISHER: 'ToolsEnabled, Inc.',
  TOOLSENABLED_ARTIFACT_SIGNING_AUTH: 'azure-cli',
  TOOLSENABLED_ARTIFACT_SIGNING_SIGNTOOL: 'C:\\SigningTools\\bin\\x64\\signtool.exe',
  TOOLSENABLED_ARTIFACT_SIGNING_DLIB: 'C:\\SigningTools\\dlib\\x64\\Azure.CodeSigning.Dlib.dll',
});
const SIGNING_NAMES = [...Object.values(signing.ENV), 'AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET',
  'AZURE_CLIENT_CERTIFICATE_PATH', 'CSC_LINK', 'WIN_CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_KEY_PASSWORD'];
// Synthetic build-output paths. Their drive is interpolated because the
// owner-data gate reads a drive-rooted path that reaches a file or folder named
// after the product as a builder checkout path; none of these is a real one.
const DRIVE = 'C:';

async function withProcessSigningEnv(values, fn) {
  const saved = new Map(SIGNING_NAMES.map((name) => [name, process.env[name]]));
  try {
    for (const name of SIGNING_NAMES) delete process.env[name];
    Object.assign(process.env, values);
    return await fn();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function quietBuilder(fn) {
  const { log } = require('builder-util/out/log.js');
  const stream = log.stream;
  log.stream = { write: () => true };
  try { return await fn(); } finally { log.stream = stream; }
}

function scratch(t) {
  const directory = mkdtempSync(path.join(ownedFixtureTempRoot(), 'te-code-signing-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

// --- resolution: off, refused, on -------------------------------------------

test('nothing configured is OFF, and OFF is exactly signExecutable:false', () => {
  for (const env of [{}, { PATH: '/usr/bin', CSC_LINK: 'C:\\stray.pfx', WIN_CSC_LINK: 'C:\\stray.pfx', AZURE_CLIENT_ID: 'x' }]) {
    const resolution = signing.resolveWindowsSigning(env);
    assert.equal(resolution.enabled, false);
    assert.deepEqual(signing.electronBuilderWindowsConfig(resolution), { signExecutable: false });
  }
  // Whitespace is not configuration.
  assert.equal(signing.resolveWindowsSigning({ TOOLSENABLED_ARTIFACT_SIGNING_ENDPOINT: '  ' }).enabled, false);
});

test('a complete configuration is ON and normalises the endpoint', () => {
  const resolution = signing.resolveWindowsSigning({ ...COMPLETE, TOOLSENABLED_ARTIFACT_SIGNING_ENDPOINT: 'https://WUS2.codesigning.azure.net/' });
  assert.equal(resolution.enabled, true);
  assert.deepEqual({ ...resolution.settings }, {
    endpoint: 'https://wus2.codesigning.azure.net',
    account: 'example-signing-account',
    profile: 'toolsenabled-public-trust',
    publisher: 'ToolsEnabled, Inc.',
    auth: 'azure-cli',
    signtool: COMPLETE.TOOLSENABLED_ARTIFACT_SIGNING_SIGNTOOL,
    dlib: COMPLETE.TOOLSENABLED_ARTIFACT_SIGNING_DLIB,
  });
  assert.deepEqual(signing.electronBuilderWindowsConfig(resolution), {
    signExecutable: true,
    forceCodeSigning: true,
    signtoolOptions: { sign: './tools/code-signing/artifact-signing-sign.cjs', publisherName: 'ToolsEnabled, Inc.', signingHashAlgorithms: ['sha256'] },
  });
});

test('any partial configuration refuses and names every missing value', () => {
  for (const missing of Object.keys(COMPLETE)) {
    const env = { ...COMPLETE };
    delete env[missing];
    assert.throws(() => signing.resolveWindowsSigning(env), (error) =>
      error instanceof signing.SigningConfigurationError && error.problems.length === 1 && error.problems[0].startsWith(missing));
  }
  assert.throws(() => signing.resolveWindowsSigning({ TOOLSENABLED_ARTIFACT_SIGNING_PROFILE: 'toolsenabled-public-trust' }),
    (error) => error.problems.length === 6);
});

test('values that would fail at signing time are refused before a build starts', () => {
  const cases = [
    [{ TOOLSENABLED_ARTIFACT_SIGNING_ENDPOINT: 'https://example.codesigning.azure.net' }, /documented Artifact Signing region endpoints/],
    [{ TOOLSENABLED_ARTIFACT_SIGNING_ENDPOINT: 'http://wus2.codesigning.azure.net' }, /documented Artifact Signing region endpoints/],
    [{ TOOLSENABLED_ARTIFACT_SIGNING_ACCOUNT: '1abc' }, /account naming rules/],
    [{ TOOLSENABLED_ARTIFACT_SIGNING_ACCOUNT: 'a--b' }, /account naming rules/],
    [{ TOOLSENABLED_ARTIFACT_SIGNING_ACCOUNT: 'a'.repeat(25) }, /account naming rules/],
    [{ TOOLSENABLED_ARTIFACT_SIGNING_PROFILE: 'abc' }, /profile naming rules/],
    [{ TOOLSENABLED_ARTIFACT_SIGNING_AUTH: 'interactive' }, /auth mode/],
    [{ TOOLSENABLED_ARTIFACT_SIGNING_PUBLISHER: 'ToolsEnabled\n, Inc.' }, /control characters/],
    [{ TOOLSENABLED_ARTIFACT_SIGNING_SIGNTOOL: 'signtool.exe' }, /absolute path/],
    [{ TOOLSENABLED_ARTIFACT_SIGNING_SIGNTOOL: 'C:\\x\\osslsigncode.exe' }, /must name signtool\.exe/],
    [{ TOOLSENABLED_ARTIFACT_SIGNING_DLIB: 'C:\\x\\Azure.CodeSigning.Other.dll' }, /must name Azure\.CodeSigning\.Dlib\.dll/],
  ];
  for (const [override, pattern] of cases) {
    assert.throws(() => signing.resolveWindowsSigning({ ...COMPLETE, ...override }), pattern, JSON.stringify(override));
  }
});

test('service-principal authentication needs the standard AZURE_* environment, and prefers a certificate', () => {
  const principal = { ...COMPLETE, TOOLSENABLED_ARTIFACT_SIGNING_AUTH: 'service-principal' };
  assert.throws(() => signing.resolveWindowsSigning(principal), (error) =>
    ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_CERTIFICATE_PATH'].every((name) => error.problems.some((p) => p.includes(name))));
  const ids = { AZURE_TENANT_ID: '00000000-0000-0000-0000-000000000001', AZURE_CLIENT_ID: '00000000-0000-0000-0000-000000000002' };
  assert.equal(signing.resolveWindowsSigning({ ...principal, ...ids, AZURE_CLIENT_CERTIFICATE_PATH: 'C:\\keys\\ci.pem' }).enabled, true);
  assert.equal(signing.resolveWindowsSigning({ ...principal, ...ids, AZURE_CLIENT_SECRET: 's' }).enabled, true);
});

test('the optional configuration file carries non-secret values only, and the environment overrides it', (t) => {
  const directory = scratch(t);
  const file = path.join(directory, 'artifact-signing.json');
  const values = {
    endpoint: 'https://eus.codesigning.azure.net',
    codeSigningAccountName: 'example-signing-account',
    certificateProfileName: 'toolsenabled-public-trust',
    publisherName: 'ToolsEnabled, Inc.',
    auth: 'azure-cli',
    signtoolPath: 'C:\\SigningTools\\bin\\x64\\signtool.exe',
    dlibPath: 'C:\\SigningTools\\dlib\\x64\\Azure.CodeSigning.Dlib.dll',
  };
  writeFileSync(file, JSON.stringify(values));
  const fromFile = signing.resolveWindowsSigning({ TOOLSENABLED_ARTIFACT_SIGNING_CONFIG: file });
  assert.equal(fromFile.enabled, true);
  assert.equal(fromFile.settings.endpoint, 'https://eus.codesigning.azure.net');
  const overridden = signing.resolveWindowsSigning({ TOOLSENABLED_ARTIFACT_SIGNING_CONFIG: file, TOOLSENABLED_ARTIFACT_SIGNING_PROFILE: 'toolsenabled-test-profile' });
  assert.equal(overridden.settings.profile, 'toolsenabled-test-profile');

  writeFileSync(file, JSON.stringify({ ...values, clientSecret: 'do-not-store' }));
  assert.throws(() => signing.resolveWindowsSigning({ TOOLSENABLED_ARTIFACT_SIGNING_CONFIG: file }), /secrets do not belong/);
  writeFileSync(file, JSON.stringify({ ...values, region: 'westus2' }));
  assert.throws(() => signing.resolveWindowsSigning({ TOOLSENABLED_ARTIFACT_SIGNING_CONFIG: file }), /unknown key "region"/);
  writeFileSync(file, '{ not json');
  assert.throws(() => signing.resolveWindowsSigning({ TOOLSENABLED_ARTIFACT_SIGNING_CONFIG: file }), /could not be read as JSON/);
  assert.throws(() => signing.resolveWindowsSigning({ TOOLSENABLED_ARTIFACT_SIGNING_CONFIG: 'artifact-signing.json' }), /absolute path/);
  assert.throws(() => signing.resolveWindowsSigning({ TOOLSENABLED_ARTIFACT_SIGNING_CONFIG: path.join(directory, 'absent.json') }), /could not be read/);
});

// --- whose name is on the certificate is configuration, not code -------------
//
// The owner validates as an INDIVIDUAL first (the certificate's CN is the
// validated legal name) and moves to the ToolsEnabled, Inc. organization
// later. On the Basic tier that is a replacement of the one Public Trust
// certificate profile, so the switch must be a configuration change only.

test('the publisher is taken from configuration: the individual path today, the organization later', () => {
  const individual = { ...COMPLETE, TOOLSENABLED_ARTIFACT_SIGNING_PUBLISHER: 'Joshua Pinckard', TOOLSENABLED_ARTIFACT_SIGNING_PROFILE: 'individual-public-trust' };
  const organization = { ...COMPLETE, TOOLSENABLED_ARTIFACT_SIGNING_PUBLISHER: 'ToolsEnabled, Inc.', TOOLSENABLED_ARTIFACT_SIGNING_PROFILE: 'organization-public-trust' };
  const now = signing.resolveWindowsSigning(individual);
  const later = signing.resolveWindowsSigning(organization);
  assert.equal(signing.electronBuilderWindowsConfig(now).signtoolOptions.publisherName, 'Joshua Pinckard');
  assert.equal(signing.electronBuilderWindowsConfig(later).signtoolOptions.publisherName, 'ToolsEnabled, Inc.');
  assert.equal(signing.signingMetadata(now.settings).CertificateProfileName, 'individual-public-trust');
  // The read-back holds each build to the identity it was configured for, so
  // a stale profile after the switch is caught on the first file, not by a customer.
  const readback = (signer) => JSON.stringify({ status: 'Valid', signer, issuer: 'Microsoft ID Verified CS EOC CA 01', timestamped: true });
  assert.equal(signing.interpretSignatureReadback(readback('Joshua Pinckard'), now.settings).signer, 'Joshua Pinckard');
  assert.throws(() => signing.interpretSignatureReadback(readback('Joshua Pinckard'), later.settings), /expected "ToolsEnabled, Inc\."/);
  assert.throws(() => signing.interpretSignatureReadback(readback('ToolsEnabled, Inc.'), now.settings), /expected "Joshua Pinckard"/);
});

test('no signing identity, account or endpoint is hard-coded in the signing code or the committed build config', async () => {
  const sources = ['windows-signing.cjs', 'artifact-signing-sign.cjs', 'electron-builder-signing.cjs', 'artifact-signing-preflight.mjs']
    .map((name) => readFileSync(path.join(REPO_ROOT, 'tools', 'code-signing', name), 'utf8'));
  const pkg = await readFile(path.join(REPO_ROOT, 'package.json'), 'utf8');
  // `copyright` legitimately names the author; it is not a signing input.
  const { copyright, ...buildWithoutCopyright } = JSON.parse(pkg).build;
  assert.ok(copyright);
  const build = JSON.stringify(buildWithoutCopyright);
  for (const text of [...sources, build]) {
    for (const identity of ['Joshua Pinckard', 'ToolsEnabled, Inc.']) {
      assert.ok(!text.includes(identity), `"${identity}" is hard-coded; the publisher must come from configuration`);
    }
  }
  for (const setting of ['codesigning.azure.net', 'publisherName', 'certificateProfileName', 'Azure.CodeSigning.Dlib']) {
    assert.ok(!build.includes(setting), `package.json build carries ${setting}; signing settings live outside the repository`);
  }
});

// --- the command and metadata Microsoft documents ----------------------------

test('SignTool is invoked exactly as the Artifact Signing integration page documents', () => {
  const { settings } = signing.resolveWindowsSigning(COMPLETE);
  const signed = `${DRIVE}\\out\\ToolsEnabled.exe`;
  assert.deepEqual(signing.signtoolSignArgs(settings, 'C:\\t\\metadata.json', signed), [
    'sign', '/v', '/fd', 'SHA256', '/tr', 'http://timestamp.acs.microsoft.com', '/td', 'SHA256',
    '/dlib', 'C:\\SigningTools\\dlib\\x64\\Azure.CodeSigning.Dlib.dll', '/dmdf', 'C:\\t\\metadata.json', signed,
  ]);
});

test('metadata.json names the account and keeps exactly one credential per auth mode', () => {
  const { settings } = signing.resolveWindowsSigning(COMPLETE);
  const cli = signing.signingMetadata(settings, { correlationId: 'ToolsEnabled 1.0.46 ToolsEnabled.exe' });
  assert.deepEqual(Object.keys(cli), ['Endpoint', 'CodeSigningAccountName', 'CertificateProfileName', 'CorrelationId', 'ExcludeCredentials']);
  assert.equal(cli.Endpoint, 'https://wus2.codesigning.azure.net');
  assert.deepEqual(signing.CREDENTIAL_CHAIN.filter((name) => !cli.ExcludeCredentials.includes(name)), ['AzureCliCredential']);
  const principal = signing.signingMetadata({ ...settings, auth: 'service-principal' });
  assert.equal(principal.CorrelationId, undefined);
  assert.deepEqual(signing.CREDENTIAL_CHAIN.filter((name) => !principal.ExcludeCredentials.includes(name)), ['EnvironmentCredential']);
});

test('manifest-pinned vendor binaries keep their bytes; everything else of ours is signed', async () => {
  const pkg = JSON.parse(await readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  // The rule is tied to where package.json actually packs the speech bundle.
  const bundle = pkg.build.win.extraResources.find((entry) => entry.from === 'voice-runtime/bundle');
  assert.equal(bundle?.to, 'voice-runtime/bundle', 'the speech bundle moved; update VENDOR_PINNED_TREES with it');
  for (const file of [
    `C:\\b\\release\\win-unpacked\\resources\\${bundle.to.replace(/\//g, '\\')}\\python\\python.exe`,
    '/b/release/win-unpacked/resources/voice-runtime/bundle/python/python.exe',
    'C:\\b\\release\\win-unpacked\\Resources\\Voice-Runtime\\Bundle\\Lib\\site-packages\\x\\helper.exe',
  ]) assert.equal(signing.classifyFileForSigning(file).sign, false, file);
  for (const file of [
    `${DRIVE}\\b\\release\\win-unpacked\\ToolsEnabled.exe`,
    `${DRIVE}\\b\\release\\ToolsEnabled Setup 1.0.46.exe`,
    'C:\\Temp\\t-abc\\__uninstaller-nsis-toolsenabled.exe',
    'C:\\b\\release\\win-unpacked\\resources\\voice-runtime\\bundle',
    'C:\\b\\voice-runtime\\bundle\\python\\python.exe',
  ]) assert.equal(signing.classifyFileForSigning(file).sign, true, file);
});

test('the read-back accepts only Valid, the configured publisher, and a timestamp', () => {
  const { settings } = signing.resolveWindowsSigning(COMPLETE);
  const good = { status: 'Valid', signer: 'ToolsEnabled, Inc.', issuer: 'Microsoft ID Verified CS EOC CA 01', timestamped: true };
  assert.deepEqual({ ...signing.interpretSignatureReadback('noise\r\n' + JSON.stringify(good), settings) }, good);
  for (const [bad, pattern] of [
    [{ ...good, status: 'NotSigned', signer: null }, /status is "NotSigned"/],
    [{ ...good, status: 'HashMismatch' }, /status is "HashMismatch"/],
    [{ ...good, signer: 'Someone Else LLC' }, /expected "ToolsEnabled, Inc\."/],
    [{ ...good, timestamped: false }, /no timestamp/],
  ]) assert.throws(() => signing.interpretSignatureReadback(JSON.stringify(bad), settings, 'C:\\x\\a.exe'), pattern);
  assert.throws(() => signing.interpretSignatureReadback('', settings), /could not be read back/);
});

// --- the hook, with SignTool and PowerShell replaced ------------------------

function recordingRunner({ signtoolCode = 0, readback = { status: 'Valid', signer: 'ToolsEnabled, Inc.', issuer: 'Microsoft ID Verified CS EOC CA 01', timestamped: true }, readbackCode = 0 } = {}) {
  const calls = [];
  const run = async (command, args, options) => {
    const call = { command, args: [...args], env: options.env };
    if (args.includes('/dmdf')) {
      const metadataPath = args[args.indexOf('/dmdf') + 1];
      call.metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
      call.metadataPath = metadataPath;
      calls.push(call);
      return { code: signtoolCode, signal: null, output: signtoolCode === 0 ? 'Successfully signed' : 'SignTool Error: 403 Forbidden' };
    }
    calls.push(call);
    return { code: readbackCode, signal: null, output: JSON.stringify(readback) };
  };
  return { calls, run };
}

test('the hook signs one file with the documented command, reads it back, and removes its metadata', async (t) => {
  const tmp = scratch(t);
  const { calls, run } = recordingRunner();
  const lines = [];
  const sign = createSigner({ env: { ...COMPLETE, SystemRoot: 'C:\\Windows' }, platform: 'win32', run, exists: () => true, tmpdir: () => tmp, log: (line) => lines.push(line) });
  await sign({ path: `${DRIVE}\\b\\release\\win-unpacked\\ToolsEnabled.exe`, hash: 'sha256' }, { appInfo: { version: '1.0.46' } });
  assert.equal(calls.length, 2);
  const [signtool, readback] = calls;
  assert.equal(signtool.command, COMPLETE.TOOLSENABLED_ARTIFACT_SIGNING_SIGNTOOL);
  assert.deepEqual(signtool.args, signing.signtoolSignArgs(signing.resolveWindowsSigning(COMPLETE).settings, signtool.metadataPath, `${DRIVE}\\b\\release\\win-unpacked\\ToolsEnabled.exe`));
  assert.equal(signtool.metadata.CodeSigningAccountName, 'example-signing-account');
  assert.equal(signtool.metadata.CertificateProfileName, 'toolsenabled-public-trust');
  assert.equal(signtool.metadata.CorrelationId, 'ToolsEnabled 1.0.46 ToolsEnabled.exe');
  assert.equal(readback.command, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(readback.args, ['-NoProfile', '-NonInteractive', '-Command', signing.VERIFY_SCRIPT]);
  assert.equal(readback.env[signing.VERIFY_FILE_VARIABLE], `${DRIVE}\\b\\release\\win-unpacked\\ToolsEnabled.exe`);
  assert.deepEqual(readdirSync(tmp), [], 'metadata.json and its directory must not outlive the signature');
  assert.ok(lines.some((line) => /ToolsEnabled\.exe: Valid, signed by ToolsEnabled, Inc\./.test(line)));
});

test('the hook refuses, and still cleans up, when SignTool or the read-back says no', async (t) => {
  const tmp = scratch(t);
  const file = { path: `${DRIVE}\\b\\release\\ToolsEnabled Setup 1.0.46.exe`, hash: 'sha256' };
  const base = { env: { ...COMPLETE }, platform: 'win32', exists: () => true, tmpdir: () => tmp, log: () => {} };
  for (const [runner, pattern] of [
    [recordingRunner({ signtoolCode: 1 }), /SignTool exited 1[\s\S]*403 Forbidden/],
    [recordingRunner({ readbackCode: 1 }), /could not be read back/],
    [recordingRunner({ readback: { status: 'NotSigned', signer: null, timestamped: false } }), /status is "NotSigned"/],
    [recordingRunner({ readback: { status: 'Valid', signer: 'Contoso', timestamped: true } }), /expected "ToolsEnabled, Inc\."/],
    [recordingRunner({ readback: { status: 'Valid', signer: 'ToolsEnabled, Inc.', timestamped: false } }), /no timestamp/],
  ]) {
    await assert.rejects(createSigner({ ...base, run: runner.run })(file, {}), pattern);
    assert.deepEqual(readdirSync(tmp), []);
  }
});

test('the hook never signs outside its lane', async (t) => {
  const tmp = scratch(t);
  const { calls, run } = recordingRunner();
  const base = { env: { ...COMPLETE }, platform: 'win32', run, exists: () => true, tmpdir: () => tmp, log: () => {} };
  // Vendor bytes stay put, without a single SignTool call.
  await createSigner(base)({ path: 'C:\\b\\win-unpacked\\resources\\voice-runtime\\bundle\\python\\python.exe', hash: 'sha256' }, {});
  assert.equal(calls.length, 0);
  const exe = { path: `${DRIVE}\\b\\win-unpacked\\ToolsEnabled.exe`, hash: 'sha256' };
  await assert.rejects(createSigner({ ...base, env: {} })(exe, {}), /no Artifact Signing configuration/);
  await assert.rejects(createSigner({ ...base, env: { TOOLSENABLED_ARTIFACT_SIGNING_ACCOUNT: 'x' } })(exe, {}), /partly configured/);
  await assert.rejects(createSigner({ ...base, platform: 'linux' })(exe, {}), /runs on Windows/);
  await assert.rejects(createSigner(base)({ ...exe, hash: 'sha1' }, {}), /SHA-256 only/);
  await assert.rejects(createSigner({ ...base, exists: (file) => !file.endsWith('.dll') })(exe, {}), /Artifact Signing dlib not found/);
  assert.equal(calls.length, 0, 'every refusal happened before SignTool ran');
});

// --- electron-builder's own code, not a description of it --------------------

test('electron-builder 26 honours OFF: signIf returns before any signer is consulted', async () => {
  const { WinPackager } = require('app-builder-lib');
  const effective = await withProcessSigningEnv({ CSC_LINK: 'C:\\stray.pfx' }, () => gate());
  assert.deepEqual(effective, { win: { signExecutable: false } });
  const packager = {
    platformSpecificBuildOptions: effective.win,
    shouldSignFile: WinPackager.prototype.shouldSignFile,
    signingQueue: Promise.resolve(true),
    _sign: async () => assert.fail('electron-builder tried to sign with signing OFF'),
  };
  for (const file of [`${DRIVE}\\b\\win-unpacked\\ToolsEnabled.exe`, `${DRIVE}\\b\\ToolsEnabled Setup 1.0.46.exe`]) {
    assert.equal(await quietBuilder(() => WinPackager.prototype.signIf.call(packager, file)), false);
  }
});

test('electron-builder 26 resolves the configured hook and asks it for one SHA-256 signature', async () => {
  const { WindowsSignToolManager } = require('app-builder-lib');
  const cwd = process.cwd();
  process.chdir(REPO_ROOT); // electron-builder resolves "./" hook paths from the working directory, as npm run dist does
  try {
    await withProcessSigningEnv(COMPLETE, async () => {
      const { win } = gate();
      const manager = new WindowsSignToolManager({
        platformSpecificBuildOptions: win,
        appInfo: { productName: 'ToolsEnabled', version: '9.9.9', type: 'module', computePackageUrl: async () => null },
        info: { getWorkspaceRoot: async () => REPO_ROOT },
        getCscLink: () => null,
        getCscPassword: () => null,
      });
      // Only the hook can produce these messages. It checks the requested hash
      // first, so reaching the platform/tool check proves electron-builder asked
      // for sha256 (not its default sha1+sha256 pair) through the resolved path.
      const expected = process.platform === 'win32' ? /SignTool not found at C:\\SigningTools/ : /runs on Windows/;
      await assert.rejects(quietBuilder(() => manager.signFile({ path: path.join(REPO_ROOT, 'no-such.exe'), options: win })), expected);
    });
  } finally {
    process.chdir(cwd);
  }
});

// --- what the release cut records ---------------------------------------------

test('the release cut records the effective setting: false with nothing configured, true when configured', async () => {
  const pkg = JSON.parse(await readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.equal(signing.effectiveSignExecutable(pkg, {}), false, 'an unconfigured cut must still declare "This build is unsigned"');
  assert.equal(signing.effectiveSignExecutable(pkg, COMPLETE), true);
  assert.throws(() => signing.effectiveSignExecutable(pkg, { TOOLSENABLED_ARTIFACT_SIGNING_ACCOUNT: 'x' }), /partly configured/);
  // electron-builder's merge order: package.json's own value beats the gate.
  assert.equal(signing.effectiveSignExecutable({ build: { extends: signing.GATE, win: { signExecutable: false } } }, COMPLETE), false);
  assert.equal(signing.effectiveSignExecutable({ build: { win: {} } }, COMPLETE), null, 'without the gate nothing here decides');
  const cut = await readFile(path.join(REPO_ROOT, 'tools', 'release-packager', 'cut-release-candidate.mjs'), 'utf8');
  assert.match(cut, /unsigned: \{ signExecutable: effectiveSignExecutable\(packageJsonBuilt, buildEnv\) \}/);
});

// --- the owner's preflight ----------------------------------------------------

test('preflight: OFF is a valid state, partial is refused, and non-Windows is not ready', async () => {
  const run = (lines) => (line) => lines.push(line);
  const off = [];
  assert.equal(await preflight({ env: {}, platform: 'win32', log: run(off) }), 0);
  assert.match(off.join('\n'), /Windows code signing: OFF/);
  const partial = [];
  assert.equal(await preflight({ env: { TOOLSENABLED_ARTIFACT_SIGNING_ACCOUNT: 'example-signing-account' }, platform: 'win32', log: run(partial) }), 1);
  assert.match(partial.join('\n'), /MISCONFIGURED[\s\S]*TOOLSENABLED_ARTIFACT_SIGNING_ENDPOINT/);
  const elsewhere = [];
  assert.equal(await preflight({ env: { ...COMPLETE }, platform: 'linux', log: run(elsewhere) }), 2);
  assert.match(elsewhere.join('\n'), /CONFIGURED[\s\S]*runs on Windows/);
  const missingTools = [];
  const az = () => ({ status: 1, stdout: '', stderr: 'Please run az login' });
  assert.equal(await preflight({ env: { ...COMPLETE }, platform: 'win32', log: run(missingTools), run: az }), 2);
  assert.match(missingTools.join('\n'), /SignTool not found[\s\S]*az login/);
  assert.ok(!existsSync(COMPLETE.TOOLSENABLED_ARTIFACT_SIGNING_SIGNTOOL));
});
