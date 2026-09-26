#!/usr/bin/env node
/* LINUX PACKAGE SIGNING: a signed apt repository and a detached signature per
 * .deb, with the owner's OpenPGP key. OFF until a key is configured.
 *
 *   TOOLSENABLED_LINUX_SIGNING_KEY=<40-hex fingerprint of the signing (sub)key> \
 *   node tools/code-signing/linux-apt-repository.mjs --repo <dir> --deb <file.deb> [--deb ...]
 *
 * WHAT IT PRODUCES, in <dir> (created if absent; an existing repository is
 * extended, never rewritten -- a pool file whose name exists with different
 * bytes is refused):
 *   pool/<component>/<p>/<package>/<file>.deb        the package, byte-identical to the input
 *   pool/<component>/<p>/<package>/<file>.deb.asc    detached, armored signature over it
 *   dists/<suite>/<component>/binary-<arch>/Packages[.gz]
 *   dists/<suite>/Release, InRelease, Release.gpg     InRelease clearsigned, Release.gpg detached
 *   toolsenabled-archive-keyring.pgp                  binary public key, for apt's Signed-By
 *   toolsenabled-archive-keyring.asc                  the same key, armored, for people
 * and then VERIFIES all of it with gpgv against only that exported keyring.
 *
 * WHY THIS SHAPE. apt authenticates repositories, not packages: "apt-secure
 * does not review signatures at a package level" (apt-secure(8)); it refuses
 * an unsigned Release by default. So the customer-facing guarantee is the
 * signed InRelease/Release.gpg, which binds Packages, which binds each .deb by
 * SHA-256. The detached .asc is for people who download the .deb directly.
 * The .deb itself is not modified: no dpkg-sig member is embedded, so its
 * SHA-256 still matches the release notes, and the Linux cutter's
 * "no embedded package signature" check stays true.
 *
 * THE KEY IS THE OWNER'S. This script never creates one; see
 * linux-signing-key-owner.sh and README.md for how the owner generates an
 * offline primary key with a signing subkey and where to keep each part.
 *
 * Environment:
 *   TOOLSENABLED_LINUX_SIGNING_KEY              required to sign; unset means OFF
 *   TOOLSENABLED_LINUX_SIGNING_GNUPGHOME        GnuPG home holding the secret subkey (default: gpg's own)
 *   TOOLSENABLED_LINUX_SIGNING_PASSPHRASE_FILE  unattended passphrase (loopback pinentry); otherwise gpg-agent asks
 * Exit: 0 signed and verified, or OFF; 1 refused; 2 OFF but --require-signing was given. */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

export const LINUX_ENV = Object.freeze({
  key: 'TOOLSENABLED_LINUX_SIGNING_KEY',
  home: 'TOOLSENABLED_LINUX_SIGNING_GNUPGHOME',
  passphraseFile: 'TOOLSENABLED_LINUX_SIGNING_PASSPHRASE_FILE',
})
export const KEYRING_NAME = 'toolsenabled-archive-keyring'
const REQUIRED_TOOLS = Object.freeze([['gpg', 'gnupg'], ['gpgv', 'gpgv'], ['apt-ftparchive', 'apt-utils'], ['dpkg-deb', 'dpkg']])
const NAME = /^[a-z0-9][a-z0-9.+-]*$/

const present = (value) => typeof value === 'string' && value.trim() !== ''
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

export class LinuxSigningError extends Error {
  constructor(message) { super(message); this.name = 'LinuxSigningError' }
}

export function resolveLinuxSigning(env = process.env) {
  if (!present(env[LINUX_ENV.key])) {
    for (const name of [LINUX_ENV.home, LINUX_ENV.passphraseFile]) {
      if (present(env[name])) throw new LinuxSigningError(`${name} is set but ${LINUX_ENV.key} is not; configure the key or nothing`)
    }
    return Object.freeze({ enabled: false, reason: `${LINUX_ENV.key} is not set` })
  }
  const fingerprint = env[LINUX_ENV.key].replace(/\s+/g, '').toUpperCase()
  if (!/^[0-9A-F]{40}$/.test(fingerprint) && !/^[0-9A-F]{64}$/.test(fingerprint)) {
    throw new LinuxSigningError(`${LINUX_ENV.key} must be a full key fingerprint (40 hex digits, or 64 for a v5 key), not a short or long key ID`)
  }
  const home = present(env[LINUX_ENV.home]) ? env[LINUX_ENV.home] : null
  if (home && (!path.isAbsolute(home) || !existsSync(home) || !statSync(home).isDirectory())) {
    throw new LinuxSigningError(`${LINUX_ENV.home} must be an existing absolute directory`)
  }
  const passphraseFile = present(env[LINUX_ENV.passphraseFile]) ? env[LINUX_ENV.passphraseFile] : null
  if (passphraseFile && (!path.isAbsolute(passphraseFile) || !existsSync(passphraseFile))) {
    throw new LinuxSigningError(`${LINUX_ENV.passphraseFile} must be an existing absolute file`)
  }
  return Object.freeze({ enabled: true, fingerprint, home, passphraseFile })
}

function defaultRun(command, args, { cwd, env, input } = {}) {
  const result = spawnSync(command, args, { cwd, env, input, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 })
  if (result.error) throw new LinuxSigningError(`${command} could not run: ${result.error.message}`)
  return { code: result.status, stdout: result.stdout, stderr: result.stderr.toString('utf8') }
}

function must(result, what) {
  if (result.code !== 0) throw new LinuxSigningError(`${what} failed (exit ${result.code}): ${result.stderr.trim().split('\n').slice(-6).join(' | ')}`)
  return result
}

/* Colon listing of secret keys -> the record for `fingerprint`, or a refusal
 * that says why that key cannot sign. */
export function assertSigningKey(colons, fingerprint) {
  const lines = String(colons).split('\n').map((line) => line.split(':'))
  for (let index = 0; index < lines.length; index += 1) {
    const record = lines[index]
    if (record[0] !== 'sec' && record[0] !== 'ssb') continue
    const fpr = lines.slice(index + 1).find((line) => line[0] === 'fpr' || line[0] === 'sec' || line[0] === 'ssb')
    if (!fpr || fpr[0] !== 'fpr' || fpr[9] !== fingerprint) continue
    const validity = record[1]
    if (['e', 'r', 'd', 'i', 'n'].includes(validity)) throw new LinuxSigningError(`key ${fingerprint} is not usable (validity "${validity}": expired, revoked, disabled or invalid)`)
    if (!String(record[11] ?? '').includes('s')) throw new LinuxSigningError(`key ${fingerprint} has no signing capability; name the signing subkey's fingerprint`)
    if (record[14] === '#') throw new LinuxSigningError(`the secret part of ${fingerprint} is not in this keyring (only a stub); import the signing subkey`)
    return Object.freeze({ fingerprint, kind: record[0] === 'sec' ? 'primary' : 'subkey', algorithm: record[3], expires: record[6] || null })
  }
  throw new LinuxSigningError(`no secret key with fingerprint ${fingerprint} in this keyring`)
}

function poolDirectory(component, pkg) {
  const prefix = pkg.startsWith('lib') && pkg.length > 3 ? pkg.slice(0, 4) : pkg[0]
  return path.posix.join('pool', component, prefix, pkg)
}

/* Parse a Packages stanza list into { Filename -> SHA256 }. */
export function packagesDigests(text) {
  const digests = new Map()
  for (const stanza of String(text).split(/\n\n+/)) {
    const filename = /^Filename: (.+)$/m.exec(stanza)?.[1]
    const digest = /^SHA256: ([0-9a-f]{64})$/m.exec(stanza)?.[1]
    if (filename && digest) digests.set(filename.trim(), digest)
  }
  return digests
}

/* Parse the SHA256 section of a Release file into { path -> [digest, size] }. */
export function releaseDigests(text) {
  const section = /^SHA256:\n((?:[ \t].*\n?)*)/m.exec(String(text))?.[1] ?? ''
  const digests = new Map()
  for (const line of section.split('\n')) {
    const match = /^\s+([0-9a-f]{64})\s+(\d+)\s+(\S+)$/.exec(line)
    if (match) digests.set(match[3], [match[1], Number(match[2])])
  }
  return digests
}

function gpgvValid(run, keyring, args, fingerprint, what) {
  const result = run('gpgv', ['--status-fd', '1', '--keyring', keyring, ...args])
  const status = result.stdout.toString('utf8')
  const valid = /^\[GNUPG:\] VALIDSIG (\S+)(?: \S+)* (\S+)$/m.exec(status)
  if (result.code !== 0 || !valid) throw new LinuxSigningError(`${what}: gpgv did not accept the signature (exit ${result.code}): ${result.stderr.trim().split('\n').slice(-3).join(' | ')}`)
  const signer = valid[1].toUpperCase()
  const primary = valid[2].toUpperCase()
  if (signer !== fingerprint && primary !== fingerprint) throw new LinuxSigningError(`${what}: signed by ${signer}, not the configured ${fingerprint}`)
  return signer
}

export function buildSignedRepository({
  repo, debs, suite = 'stable', component = 'main', origin = 'ToolsEnabled', label = 'ToolsEnabled',
  description = 'ToolsEnabled desktop packages', env = process.env, run = defaultRun, log = console.log, now = () => new Date(),
} = {}) {
  const signingConfig = resolveLinuxSigning(env)
  if (!signingConfig.enabled) return Object.freeze({ signed: false, reason: signingConfig.reason })
  if (!present(repo) || !path.isAbsolute(repo)) throw new LinuxSigningError('--repo must be an absolute directory')
  if (!Array.isArray(debs) || debs.length === 0) throw new LinuxSigningError('at least one --deb is required')
  for (const [value, what] of [[suite, 'suite'], [component, 'component']]) {
    if (!NAME.test(value)) throw new LinuxSigningError(`${what} ${JSON.stringify(value)} is not a valid archive name`)
  }
  for (const [tool, pkg] of REQUIRED_TOOLS) {
    if (spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).status !== 0 && run === defaultRun) {
      throw new LinuxSigningError(`${tool} is required (Ubuntu package ${pkg})`)
    }
  }
  const { fingerprint } = signingConfig
  const gpgEnv = { ...env, ...(signingConfig.home ? { GNUPGHOME: signingConfig.home } : {}), LC_ALL: 'C' }
  const gpg = (args, what, options = {}) => must(run('gpg', ['--batch', ...args], { env: gpgEnv, ...options }), what)
  const key = assertSigningKey(gpg(['--with-colons', '--fingerprint', '--fingerprint', '--list-secret-keys', fingerprint], 'listing the signing key').stdout.toString('utf8'), fingerprint)
  const passphrase = signingConfig.passphraseFile ? ['--pinentry-mode', 'loopback', '--passphrase-file', signingConfig.passphraseFile] : []
  const signArgs = ['--yes', '--local-user', `${fingerprint}!`, '--digest-algo', 'SHA512', ...passphrase]

  mkdirSync(repo, { recursive: true })
  const architectures = new Set()
  const pooled = []
  for (const deb of debs) {
    if (!path.isAbsolute(deb) || !existsSync(deb)) throw new LinuxSigningError(`--deb ${deb} must be an existing absolute path`)
    const fields = must(run('dpkg-deb', ['--field', deb, 'Package', 'Version', 'Architecture'], { env: gpgEnv }), `reading ${path.basename(deb)}`).stdout.toString('utf8')
    const field = (name) => new RegExp(`^${name}: (.+)$`, 'm').exec(fields)?.[1]?.trim()
    const pkg = field('Package')
    const architecture = field('Architecture')
    if (!pkg || !NAME.test(pkg) || !field('Version') || !architecture) throw new LinuxSigningError(`${path.basename(deb)} has no usable Package/Version/Architecture`)
    if (architecture !== 'all') architectures.add(architecture)
    const relative = path.posix.join(poolDirectory(component, pkg), path.basename(deb))
    const target = path.join(repo, ...relative.split('/'))
    const digest = sha256(deb)
    if (existsSync(target)) {
      if (sha256(target) !== digest) throw new LinuxSigningError(`${relative} already exists with different bytes; a published package file is never replaced`)
    } else {
      mkdirSync(path.dirname(target), { recursive: true })
      copyFileSync(deb, target)
      if (sha256(target) !== digest) throw new LinuxSigningError(`${relative} changed while it was copied`)
    }
    gpg([...signArgs, '--armor', '--detach-sign', '--output', `${target}.asc`, target], `signing ${path.basename(deb)}`)
    pooled.push({ relative, target, digest, bytes: statSync(target).size, package: pkg, architecture })
  }
  if (architectures.size === 0) architectures.add('amd64')

  const dists = path.join(repo, 'dists', suite)
  for (const name of ['Release', 'InRelease', 'Release.gpg']) rmSync(path.join(dists, name), { force: true })
  for (const architecture of [...architectures].sort()) {
    const directory = path.join(dists, component, `binary-${architecture}`)
    mkdirSync(directory, { recursive: true })
    const packages = must(run('apt-ftparchive', ['--arch', architecture, 'packages', path.posix.join('pool', component)], { cwd: repo, env: gpgEnv }), 'apt-ftparchive packages').stdout
    writeFileSync(path.join(directory, 'Packages'), packages)
    writeFileSync(path.join(directory, 'Packages.gz'), gzipSync(packages, { level: 9 }))
  }
  const option = (name, value) => ['-o', `APT::FTPArchive::Release::${name}=${value}`]
  const release = must(run('apt-ftparchive', [
    ...option('Origin', origin), ...option('Label', label), ...option('Suite', suite), ...option('Codename', suite),
    ...option('Architectures', [...architectures].sort().join(' ')), ...option('Components', component),
    ...option('Description', description), 'release', path.posix.join('dists', suite),
  ], { cwd: repo, env: gpgEnv }), 'apt-ftparchive release').stdout
  const staged = path.join(dists, '.Release.new')
  writeFileSync(staged, release)
  renameSync(staged, path.join(dists, 'Release'))
  gpg([...signArgs, '--clearsign', '--output', path.join(dists, 'InRelease'), path.join(dists, 'Release')], 'clearsigning InRelease')
  gpg([...signArgs, '--armor', '--detach-sign', '--output', path.join(dists, 'Release.gpg'), path.join(dists, 'Release')], 'signing Release.gpg')

  const keyring = path.join(repo, `${KEYRING_NAME}.pgp`)
  writeFileSync(keyring, gpg(['--export', '--export-options', 'export-minimal', fingerprint], 'exporting the public key').stdout)
  writeFileSync(path.join(repo, `${KEYRING_NAME}.asc`), gpg(['--armor', '--export', '--export-options', 'export-minimal', fingerprint], 'exporting the armored public key').stdout)

  // VERIFY with nothing but the exported public key -- what a customer has.
  gpgvValid(run, keyring, [path.join(dists, 'InRelease')], fingerprint, 'InRelease')
  gpgvValid(run, keyring, [path.join(dists, 'Release.gpg'), path.join(dists, 'Release')], fingerprint, 'Release.gpg')
  const releaseText = readFileSync(path.join(dists, 'Release'), 'utf8')
  const releaseSums = releaseDigests(releaseText)
  for (const architecture of architectures) {
    for (const name of ['Packages', 'Packages.gz']) {
      const relative = `${component}/binary-${architecture}/${name}`
      const file = path.join(dists, ...relative.split('/'))
      const [digest, bytes] = releaseSums.get(relative) ?? []
      if (digest !== sha256(file) || bytes !== statSync(file).size) throw new LinuxSigningError(`Release does not bind ${relative}`)
    }
    const listed = packagesDigests(readFileSync(path.join(dists, component, `binary-${architecture}`, 'Packages'), 'utf8'))
    for (const item of pooled.filter((entry) => entry.architecture === architecture || entry.architecture === 'all')) {
      if (listed.get(item.relative) !== item.digest) throw new LinuxSigningError(`Packages does not bind ${item.relative} to its SHA-256`)
    }
  }
  for (const item of pooled) gpgvValid(run, keyring, [`${item.target}.asc`, item.target], fingerprint, path.basename(item.target))

  const result = Object.freeze({
    signed: true,
    fingerprint,
    key,
    suite,
    component,
    architectures: [...architectures].sort(),
    date: /^Date: (.+)$/m.exec(releaseText)?.[1] ?? now().toUTCString(),
    packages: pooled.map(({ relative, digest, bytes }) => ({ file: relative, sha256: digest, bytes })),
    keyring: `${KEYRING_NAME}.pgp`,
  })
  log(`[linux-signing] signed and verified ${pooled.length} package(s) into ${suite}/${component} with ${key.kind} ${fingerprint}`)
  return result
}

function parseArgs(argv) {
  const args = { debs: [], requireSigning: false }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = () => {
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) throw new LinuxSigningError(`${flag} needs a value`)
      index += 1
      return next
    }
    if (flag === '--repo') args.repo = path.resolve(value())
    else if (flag === '--deb') args.debs.push(path.resolve(value()))
    else if (flag === '--suite') args.suite = value()
    else if (flag === '--component') args.component = value()
    else if (flag === '--require-signing') args.requireSigning = true
    else throw new LinuxSigningError(`unknown argument ${flag}`)
  }
  return args
}

export function main(argv = process.argv.slice(2), { env = process.env, log = console.log, error = console.error } = {}) {
  try {
    const args = parseArgs(argv)
    const result = buildSignedRepository({ ...args, env, log })
    if (!result.signed) {
      log(`Linux package signing: OFF (${result.reason}). Nothing was signed or written.`)
      return args.requireSigning ? 2 : 0
    }
    log(JSON.stringify(result, null, 2))
    return 0
  } catch (caught) {
    error(`Linux package signing refused: ${caught.message}`)
    return 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main()
}
