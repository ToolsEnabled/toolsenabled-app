import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

// These are custody counterexamples using synthetic files and controlled stat
// observations. They do not constitute native account or filesystem evidence.
const require = createRequire(import.meta.url)
const { readCredential, prepareProviderAccount, finalizeProviderAccount } = require('../lib/page2-native-provider-account.cjs')
const runtime = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const HIGH = 9570149216456724n
const hash = value => crypto.createHash('sha256').update(value).digest('hex')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-identity-fixture-'))
  const accountHome = process.platform === 'win32' ? os.userInfo().homedir : root
  const sourceHome = path.join(root, 'source')
  const qaRoot = path.join(root, 'evidence', 'page2-fixture')
  const userData = path.join(qaRoot, 'ToolsEnabled-Page2-QA')
  fs.mkdirSync(sourceHome)
  fs.mkdirSync(qaRoot, { recursive: true })
  const file = path.join(sourceHome, 'auth.json')
  fs.writeFileSync(file, JSON.stringify({ auth_mode: 'chatgpt', tokens: {
    account_id: 'synthetic-inode-account', access_token: 'synthetic-not-a-credential',
  } }), { mode: 0o600 })
  const guard = { accountHome, platform: process.platform, uid: process.getuid?.() }
  let prepared
  t.after(() => {
    if (prepared?.receipt?.staged?.profileHome) fs.rmSync(prepared.receipt.staged.profileHome, { recursive: true, force: true })
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { root, file, sourceHome, qaRoot, userData, guard,
    read: () => readCredential(sourceHome, guard),
    prepare() {
      prepared = prepareProviderAccount({ options: { realProvider: true, codexProfileHome: sourceHome,
        codexAccountIdSha256: hash('synthetic-inode-account') }, accountHome, qaRoot, userData, runtime,
      environment: { LOCALAPPDATA: path.join(qaRoot, 'profile', 'localappdata') } })
      return prepared
    },
    finalize: receipt => finalizeProviderAccount(receipt, { qaRoot, accountHome, processesClosed: true }),
  }
}

function altered(stat, options, fields) {
  const copy = Object.assign(Object.create(Object.getPrototypeOf(stat)), stat)
  for (const [name, value] of Object.entries(fields)) copy[name] = options?.bigint ? value : Number(value)
  return copy
}

function withStats(hooks, action) {
  const lstat = fs.lstatSync, fstat = fs.fstatSync
  fs.lstatSync = (file, options) => hooks.lstat?.(file, options, lstat(file, options)) ?? lstat(file, options)
  fs.fstatSync = (fd, options) => hooks.fstat?.(fd, options, fstat(fd, options)) ?? fstat(fd, options)
  try { return action() } finally { fs.lstatSync = lstat; fs.fstatSync = fstat }
}

test('real credential and temporary-directory identities serialize exact BigInt stat values as decimal strings', t => {
  const f = fixture(t), receipt = f.prepare().receipt
  for (const [file, identity] of [[receipt.source.file, receipt.source.identity],
    [receipt.staged.file, receipt.staged.identity], [receipt.staged.profileHome, receipt.staged.directoryIdentity]]) {
    const stat = fs.lstatSync(file, { bigint: true })
    assert.equal(identity.dev, stat.dev.toString())
    assert.equal(identity.ino, stat.ino.toString())
    assert.match(identity.dev, /^(?:0|[1-9]\d*)$/)
    assert.match(identity.ino, /^(?:0|[1-9]\d*)$/)
  }
  assert.equal(Number.isSafeInteger(receipt.source.identity.uid), true)
  assert.equal(Number.isSafeInteger(receipt.source.identity.mode), true)
  assert.deepEqual(f.finalize(receipt).errors, [])
})

test('credential read retains an inode above Number precision without rounding', t => {
  const f = fixture(t), original = fs.lstatSync(f.file, { bigint: true })
  const matches = stat => BigInt(stat.dev) === original.dev && BigInt(stat.ino) === original.ino
  withStats({
    lstat: (file, options, stat) => file === f.file ? altered(stat, options, { ino: HIGH + 1n }) : stat,
    fstat: (fd, options, stat) => matches(stat) ? altered(stat, options, { ino: HIGH + 1n }) : stat,
  }, () => {
    const read = f.read()
    assert.equal(read.receipt.identity.ino, (HIGH + 1n).toString())
    read.bytes.fill(0)
  })
})

test('adjacent large path and descriptor inodes cannot masquerade as the same credential', t => {
  const f = fixture(t), original = fs.lstatSync(f.file, { bigint: true })
  assert.equal(Number(HIGH), Number(HIGH + 1n), 'The control must reproduce a real numeric collision')
  const matches = stat => BigInt(stat.dev) === original.dev && BigInt(stat.ino) === original.ino
  withStats({
    lstat: (file, options, stat) => file === f.file ? altered(stat, options, { ino: HIGH }) : stat,
    fstat: (fd, options, stat) => matches(stat) ? altered(stat, options, { ino: HIGH + 1n }) : stat,
  }, () => assert.throws(() => f.read(), /changed before its owned read/))
})

test('a sub-millisecond descriptor timestamp change is retained by the guarded credential read', t => {
  const f = fixture(t), original = fs.lstatSync(f.file, { bigint: true })
  let reads = 0
  withStats({ fstat: (fd, options, stat) => {
    if (BigInt(stat.dev) !== original.dev || BigInt(stat.ino) !== original.ino) return stat
    reads++
    if (reads < 2 || !options?.bigint) return stat
    return altered(stat, options, { ctimeNs: stat.ctimeNs + 1n })
  } }, () => assert.throws(() => f.read(), /changed during its owned read/))
})

test('different source and private-copy inodes remain distinct when their Number representations collide', t => {
  const f = fixture(t), identities = new Map()
  const key = stat => `${stat.dev}:${stat.ino}`
  withStats({
    lstat: (file, options, stat) => {
      if (path.basename(String(file)) !== 'auth.json' || !stat.isFile()) return stat
      const value = file === f.file ? HIGH : HIGH + 1n
      identities.set(key(stat), value)
      return altered(stat, options, { ino: value })
    },
    fstat: (fd, options, stat) => identities.has(key(stat)) ? altered(stat, options, { ino: identities.get(key(stat)) }) : stat,
  }, () => {
    const receipt = f.prepare().receipt
    assert.equal(receipt.source.identity.ino, HIGH.toString())
    assert.equal(receipt.staged.identity.ino, (HIGH + 1n).toString())
    assert.deepEqual(f.finalize(receipt).errors, [])
  })
})

test('a changed large temporary-directory inode refuses removal despite colliding numeric values', t => {
  const f = fixture(t)
  let substitute = false
  withStats({ lstat: (file, options, stat) => {
    if (!path.basename(String(file)).startsWith('toolsenabled-native-account-')) return stat
    return altered(stat, options, { ino: HIGH + (substitute ? 1n : 0n) })
  } }, () => {
    const receipt = f.prepare().receipt
    substitute = true
    assert.throws(() => f.finalize(receipt), /directory changed identity/)
    assert.equal(fs.existsSync(receipt.staged.file), true)
    assert.equal(fs.existsSync(f.file), true)
  })
})

test('noncanonical or numeric custody identities never authorize temporary-directory removal', t => {
  const f = fixture(t), receipt = f.prepare().receipt
  for (const value of [Number(receipt.staged.directoryIdentity.ino), '', '00', '-1', '+1', '1.0', '1e3', ' 1', '18446744073709551616']) {
    const malformed = structuredClone(receipt)
    malformed.staged.directoryIdentity.ino = value
    assert.throws(() => f.finalize(malformed))
    assert.equal(fs.existsSync(receipt.staged.file), true)
  }
})

test('a byte-identical replacement of the protected source still refuses identity proof', t => {
  const f = fixture(t), prepared = f.prepare(), receipt = prepared.receipt
  const original = fs.readFileSync(f.file)
  const retained = path.join(f.sourceHome, 'retained-original.json')
  fs.renameSync(f.file, retained)
  fs.writeFileSync(f.file, original, { mode: 0o600 })
  assert.throws(() => prepared.finish(), /original provider credential changed inode/)
  const proof = f.finalize(receipt)
  assert.equal(proof.sourceUnchanged, false)
  assert.match(proof.errors.join('\n'), /original provider credential changed/)
  assert.equal(proof.stagedProfileRemoved, true)
  assert.deepEqual(fs.readFileSync(f.file), original)
  assert.deepEqual(fs.readFileSync(retained), original)
})
