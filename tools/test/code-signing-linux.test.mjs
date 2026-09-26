// Proof for tools/code-signing/linux-apt-repository.mjs and
// tools/code-signing/linux-signing-key-owner.sh.
//
// OFF by default: no key configured means nothing is signed or written. ON:
// a signed apt repository plus a detached signature per .deb, verified with
// nothing but the exported public key -- and then accepted by apt itself, run
// unprivileged against a sandboxed root, which is what a customer's machine
// does. The negative control is apt REFUSING the same repository under a
// different key.
//
// KEYS. The end-to-end test generates a THROWAWAY key inside its own temporary
// GnuPG home, valid for one day, and deletes it afterwards. It is a fixture,
// not the owner's key: the owner's key is created only by the owner, with
// linux-signing-key-owner.sh, which this file runs in --print-plan mode only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ownedFixtureTempRoot } from './lib/owned-fixture-temp.mjs';
import {
  LINUX_ENV, assertSigningKey, buildSignedRepository, main, packagesDigests, releaseDigests, resolveLinuxSigning,
} from '../code-signing/linux-apt-repository.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OWNER_SCRIPT = path.join(REPO_ROOT, 'tools', 'code-signing', 'linux-signing-key-owner.sh');
const LINUX_ONLY = process.platform !== 'linux' ? 'gpg, apt-ftparchive, dpkg-deb and apt-get are the Linux release host\'s tools' : false;

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

function scratch(t) {
  const directory = mkdtempSync(path.join(ownedFixtureTempRoot(), 'te-linux-signing-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function sh(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

// --- OFF, and configuration refusals (no tools needed) ------------------------

test('Linux signing is OFF without a key, writes nothing, and --require-signing makes OFF an error', (t) => {
  const directory = scratch(t);
  const repo = path.join(directory, 'repo');
  const lines = [];
  assert.equal(main(['--repo', repo, '--deb', path.join(directory, 'absent.deb')], { env: {}, log: (l) => lines.push(l), error: (l) => lines.push(l) }), 0);
  assert.match(lines.join('\n'), /Linux package signing: OFF/);
  assert.equal(existsSync(repo), false, 'OFF must not create a repository');
  assert.equal(main(['--repo', repo, '--require-signing'], { env: {}, log: () => {}, error: () => {} }), 2);
  assert.deepEqual(buildSignedRepository({ repo, debs: [], env: {} }), { signed: false, reason: `${LINUX_ENV.key} is not set` });
});

test('Linux signing refuses a partial or ambiguous key configuration', (t) => {
  const directory = scratch(t);
  const refuse = (env, pattern) => {
    const errors = [];
    assert.equal(main(['--repo', path.join(directory, 'repo'), '--deb', path.join(directory, 'x.deb')], { env, log: () => {}, error: (l) => errors.push(l) }), 1);
    assert.match(errors.join('\n'), pattern);
  };
  refuse({ [LINUX_ENV.home]: directory }, /is set but TOOLSENABLED_LINUX_SIGNING_KEY is not/);
  refuse({ [LINUX_ENV.key]: 'ECDE32E53EA1B1CE' }, /full key fingerprint/);
  refuse({ [LINUX_ENV.key]: 'A'.repeat(40), [LINUX_ENV.home]: 'relative/home' }, /existing absolute directory/);
  refuse({ [LINUX_ENV.key]: 'A'.repeat(40), [LINUX_ENV.passphraseFile]: path.join(directory, 'absent') }, /existing absolute file/);
  assert.equal(resolveLinuxSigning({ [LINUX_ENV.key]: 'ab cd '.repeat(10) }).fingerprint, 'ABCD'.repeat(10), 'spaced fingerprints as gpg prints them are accepted');
});

test('only a present, unexpired, signing-capable secret key is accepted', () => {
  const fpr = 'B'.repeat(40);
  const listing = (record) => [`sec:u:255:22:1111111111111111:1:1790308866::u:::cC:::+:::ed25519:::0:`, `fpr:::::::::${'C'.repeat(40)}:`,
    record, `fpr:::::::::${fpr}:`].join('\n');
  assert.equal(assertSigningKey(listing('ssb:u:255:22:2222222222222222:1:1790308866:::::s:::+:::ed25519::'), fpr).kind, 'subkey');
  assert.throws(() => assertSigningKey(listing('ssb:e:255:22:2222222222222222:1:1:::::s:::+:::ed25519::'), fpr), /not usable/);
  assert.throws(() => assertSigningKey(listing('ssb:u:255:18:2222222222222222:1:1790308866:::::e:::+:::cv25519::'), fpr), /no signing capability/);
  assert.throws(() => assertSigningKey(listing('ssb:u:255:22:2222222222222222:1:1790308866:::::s:::#:::ed25519::'), fpr), /only a stub/);
  assert.throws(() => assertSigningKey(listing('ssb:u:255:22:2222222222222222:1:1790308866:::::s:::+:::ed25519::'), 'D'.repeat(40)), /no secret key/);
});

test('Packages and Release parsing reads the SHA-256 bindings apt relies on', () => {
  const digest = 'a'.repeat(64);
  assert.equal(packagesDigests(`Package: toolsenabled\nFilename: pool/main/t/toolsenabled/t.deb\nSHA256: ${digest}\n\nPackage: x\n`).get('pool/main/t/toolsenabled/t.deb'), digest);
  const release = `Suite: stable\nMD5Sum:\n ${'b'.repeat(32)} 10 main/binary-amd64/Packages\nSHA256:\n ${digest}              483 main/binary-amd64/Packages\n`;
  assert.deepEqual(releaseDigests(release).get('main/binary-amd64/Packages'), [digest, 483]);
});

// --- ON, end to end, judged by gpgv and by apt itself -------------------------

function throwawayKey(t, directory) {
  const home = path.join(directory, 'gnupg');
  mkdirSync(home, { mode: 0o700 });
  t.after(() => spawnSync('gpgconf', ['--homedir', home, '--kill', 'all']));
  const env = { ...process.env, GNUPGHOME: home };
  sh('gpg', ['--batch', '--quiet', '--passphrase', '', '--quick-generate-key', 'ToolsEnabled test fixture (throwaway) <fixture@invalid>', 'ed25519', 'cert', '1d'], { env });
  const primary = /^fpr:+([0-9A-F]{40}):/m.exec(sh('gpg', ['--batch', '--with-colons', '--list-keys'], { env }))[1];
  sh('gpg', ['--batch', '--quiet', '--passphrase', '', '--quick-add-key', primary, 'ed25519', 'sign', '1d'], { env });
  const colons = sh('gpg', ['--batch', '--with-colons', '--fingerprint', '--fingerprint', '--list-secret-keys', primary], { env });
  const subkey = /^ssb:[\s\S]*?^fpr:+([0-9A-F]{40}):/m.exec(colons)[1];
  return { home, primary, subkey };
}

function fixtureDeb(directory, version = '9.9.9', payload = 'fixture') {
  const root = path.join(directory, `pkg-${version}-${payload}`);
  mkdirSync(path.join(root, 'DEBIAN'), { recursive: true });
  mkdirSync(path.join(root, 'usr', 'share', 'doc', 'toolsenabled'), { recursive: true });
  writeFileSync(path.join(root, 'DEBIAN', 'control'),
    `Package: toolsenabled\nVersion: ${version}\nArchitecture: amd64\nMaintainer: Fixture <fixture@invalid>\nDescription: signing fixture\n`);
  writeFileSync(path.join(root, 'usr', 'share', 'doc', 'toolsenabled', 'README'), payload + '\n');
  const out = path.join(directory, payload, `toolsenabled_${version}_amd64.deb`);
  mkdirSync(path.dirname(out), { recursive: true });
  sh('dpkg-deb', ['--root-owner-group', '--build', root, out]);
  return out;
}

// apt-get, unprivileged, against a private root: reads only the sources and
// keyring given here, never the machine's own /etc/apt lists or trust.
function aptSandbox(directory, repo, keyring) {
  const root = path.join(directory, `apt-${path.basename(keyring)}`);
  for (const sub of ['etc/apt/sources.list.d', 'etc/apt/apt.conf.d', 'etc/apt/preferences.d', 'etc/apt/trusted.gpg.d',
    'var/lib/apt/lists/partial', 'var/cache/apt/archives/partial', 'var/lib/dpkg', 'download']) mkdirSync(path.join(root, sub), { recursive: true });
  writeFileSync(path.join(root, 'var/lib/dpkg/status'), '');
  writeFileSync(path.join(root, 'etc/apt/sources.list.d/toolsenabled.sources'),
    `Types: deb\nURIs: file:${repo}\nSuites: stable\nComponents: main\nArchitectures: amd64\nSigned-By: ${keyring}\n`);
  const conf = path.join(root, 'apt.conf');
  writeFileSync(conf, [
    `Dir "${root}/";`, `Dir::State::status "${root}/var/lib/dpkg/status";`, 'Dir::Etc::SourceList "/dev/null";',
    `Dir::Etc::SourceParts "${root}/etc/apt/sources.list.d";`, `Dir::Etc::Parts "${root}/etc/apt/apt.conf.d";`,
    'Dir::Etc::Preferences "/dev/null";', `Dir::Etc::PreferencesParts "${root}/etc/apt/preferences.d";`,
    'Dir::Etc::Trusted "/dev/null";', `Dir::Etc::TrustedParts "${root}/etc/apt/trusted.gpg.d";`,
    'Debug::NoLocking "true";', `APT::Sandbox::User "${os.userInfo().username}";`, '',
  ].join('\n'));
  const env = { ...process.env, APT_CONFIG: conf, LC_ALL: 'C' };
  return {
    update: () => spawnSync('apt-get', ['update'], { env, encoding: 'utf8' }),
    download: () => spawnSync('apt-get', ['download', 'toolsenabled'], { env, encoding: 'utf8', cwd: path.join(root, 'download') }),
    downloaded: () => path.join(root, 'download', readdirSync(path.join(root, 'download'))[0] ?? 'none'),
  };
}

test('a configured key produces a signed repository that gpgv and apt both accept, and apt refuses under another key', { skip: LINUX_ONLY }, (t) => {
  const directory = scratch(t);
  const key = throwawayKey(t, directory);
  const deb = fixtureDeb(directory);
  const before = sha256(deb);
  const repo = path.join(directory, 'repo');
  const env = { [LINUX_ENV.key]: key.subkey, [LINUX_ENV.home]: key.home, PATH: process.env.PATH };

  const result = buildSignedRepository({ repo, debs: [deb], env, log: () => {} });
  assert.equal(result.signed, true);
  assert.equal(result.key.kind, 'subkey');
  assert.equal(sha256(deb), before, 'the input .deb is never modified');
  const pooled = path.join(repo, 'pool/main/t/toolsenabled/toolsenabled_9.9.9_amd64.deb');
  assert.equal(sha256(pooled), before, 'the published .deb is byte-identical: no embedded signature, same SHA-256 as the release notes');
  assert.ok(!/^_gpg/m.test(sh('ar', ['t', pooled])), 'no dpkg-sig member');
  for (const file of ['dists/stable/InRelease', 'dists/stable/Release', 'dists/stable/Release.gpg', 'toolsenabled-archive-keyring.pgp',
    'toolsenabled-archive-keyring.asc', 'pool/main/t/toolsenabled/toolsenabled_9.9.9_amd64.deb.asc']) {
    assert.ok(existsSync(path.join(repo, file)), file);
  }
  assert.match(readFileSync(path.join(repo, 'dists/stable/InRelease'), 'utf8'), /^-----BEGIN PGP SIGNED MESSAGE-----/);
  const keyring = path.join(repo, 'toolsenabled-archive-keyring.pgp');
  // A customer checking a directly downloaded .deb.
  const detached = spawnSync('gpgv', ['--keyring', keyring, `${pooled}.asc`, pooled], { encoding: 'utf8' });
  assert.equal(detached.status, 0, detached.stderr);
  // The exported keyring carries no secret material.
  mkdirSync(path.join(directory, 'empty-home'), { mode: 0o700 });
  t.after(() => spawnSync('gpgconf', ['--homedir', path.join(directory, 'empty-home'), '--kill', 'all']));
  assert.doesNotMatch(sh('gpg', ['--batch', '--show-keys', '--with-colons', keyring], { env: { ...process.env, GNUPGHOME: path.join(directory, 'empty-home') } }), /^(sec|ssb):/m);

  // apt, as a customer's machine runs it.
  const apt = aptSandbox(directory, repo, keyring);
  const update = apt.update();
  assert.equal(update.status, 0, update.stdout + update.stderr);
  assert.doesNotMatch(update.stdout + update.stderr, /^(W|E): /m, 'apt accepted the repository without a warning');
  const download = apt.download();
  assert.equal(download.status, 0, download.stdout + download.stderr);
  assert.equal(sha256(apt.downloaded()), before, 'apt fetched exactly the signed bytes');

  // Negative control: the same repository under a key apt was not told to trust.
  const other = path.join(directory, 'other');
  mkdirSync(other, { mode: 0o700 });
  t.after(() => spawnSync('gpgconf', ['--homedir', other, '--kill', 'all']));
  sh('gpg', ['--batch', '--quiet', '--passphrase', '', '--quick-generate-key', 'Unrelated fixture <other@invalid>', 'ed25519', 'sign', '1d'], { env: { ...process.env, GNUPGHOME: other } });
  const otherKeyring = path.join(directory, 'other-keyring.pgp');
  writeFileSync(otherKeyring, spawnSync('gpg', ['--batch', '--export'], { env: { ...process.env, GNUPGHOME: other } }).stdout);
  const refused = aptSandbox(directory, repo, otherKeyring).update();
  assert.equal(refused.status, 100, refused.stdout + refused.stderr);
  assert.match(refused.stdout + refused.stderr, /NO_PUBKEY|is not signed/);

  // Extending the repository keeps published files immutable.
  const second = fixtureDeb(directory, '9.9.10', 'second');
  assert.equal(buildSignedRepository({ repo, debs: [deb, second], env, log: () => {} }).packages.length, 2);
  assert.equal(sha256(pooled), before);
  const impostor = fixtureDeb(directory, '9.9.9', 'impostor');
  assert.throws(() => buildSignedRepository({ repo, debs: [impostor], env, log: () => {} }), /already exists with different bytes/);
});

// --- the owner's key script: planned here, never run for real ------------------

test('the owner key script plans an offline primary and a signing subkey, and creates nothing in plan mode', { skip: LINUX_ONLY }, (t) => {
  const directory = scratch(t);
  sh('bash', ['-n', OWNER_SCRIPT]);
  const home = path.join(directory, 'offline-key');
  const plan = sh('bash', [OWNER_SCRIPT, '--gnupghome', home, '--print-plan']);
  assert.match(plan, /--quick-generate-key .* ed25519 cert 5y/);
  assert.match(plan, /--quick-add-key <PRIMARY-FINGERPRINT> ed25519 sign 2y/);
  assert.match(plan, /--export-secret-subkeys <SUBKEY-FINGERPRINT>! > .*signing-subkey-only\.asc/);
  assert.match(plan, /REVOCATION-CERTIFICATE\.rev/);
  assert.equal(existsSync(home), false, '--print-plan must not create the key home');
  const refused = spawnSync('bash', [OWNER_SCRIPT, '--print-plan'], { encoding: 'utf8' });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /--gnupghome <new empty directory> is required/);
  writeFileSync(path.join(directory, 'occupied'), 'x');
  const occupied = spawnSync('bash', [OWNER_SCRIPT, '--gnupghome', directory, '--print-plan'], { encoding: 'utf8' });
  assert.equal(occupied.status, 1);
  assert.match(occupied.stderr, /is not empty/);
});
