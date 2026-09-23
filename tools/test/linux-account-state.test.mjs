import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { prepareLinuxAccountState } = require('../../shell/linux-account-state.cjs')
const linux = process.platform === 'linux'
const mode = p => fs.statSync(p).mode & 0o7777
const refused = fn => assert.throws(fn, { code: 'MC_ACCOUNT_STATE_UNSAFE' })
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'te-private-profile-'))
  fs.chmodSync(root, 0o700)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { root, profile: path.join(root, 'profile') }
}

test('Windows keeps its native profile/DPAPI path without Linux filesystem work', () => {
  assert.deepEqual(prepareLinuxAccountState(null, { platform: 'win32' }), { prepared: false })
})

test('fresh Linux account directories are private under a permissive umask', { skip: !linux }, t => {
  const { root, profile } = fixture(t), before = process.umask(0o002)
  t.after(() => process.umask(before))
  const result = prepareLinuxAccountState(profile)
  assert.equal(result.prepared, true)
  for (const name of ['', 'capability', 'capability/vault']) assert.equal(mode(path.join(profile, name)), 0o700)
  assert.equal(mode(root), 0o700)
})

test('previous permissive account directories are narrowed without reading records or visiting siblings', { skip: !linux }, t => {
  const { root, profile } = fixture(t)
  const vault = path.join(profile, 'capability/vault'), sibling = path.join(root, 'sibling')
  fs.mkdirSync(vault, { recursive: true }); fs.mkdirSync(sibling)
  for (const directory of [profile, path.dirname(vault), vault, sibling]) fs.chmodSync(directory, 0o775)
  const data = path.join(vault, 'synthetic-record')
  fs.writeFileSync(data, 'disposable fixture only'); fs.chmodSync(data, 0o400)
  const before = fs.statSync(data)
  prepareLinuxAccountState(profile)
  for (const directory of [profile, path.dirname(vault), vault]) assert.equal(mode(directory), 0o700)
  assert.equal(mode(sibling), 0o775)
  const after = fs.statSync(data)
  for (const key of ['ino', 'size', 'mtimeMs', 'atimeMs', 'mode']) assert.equal(after[key], before[key], key)
})

test('an unsafe ancestor outside the profile is refused without changing it', { skip: !linux }, t => {
  const { root, profile } = fixture(t)
  fs.chmodSync(root, 0o775)
  refused(() => prepareLinuxAccountState(profile))
  assert.equal(mode(root), 0o775)
  assert.equal(fs.existsSync(profile), false)
})

test('a symlink at any private directory is refused without touching its target', { skip: !linux }, t => {
  const { root } = fixture(t)
  for (const suffix of ['', 'capability', 'capability/vault']) {
    const profile = path.join(root, 'profile-' + suffix.replaceAll('/', '-'))
    const target = path.join(root, 'target-' + suffix.replaceAll('/', '-'))
    fs.mkdirSync(target); fs.chmodSync(target, 0o755)
    const link = path.join(profile, suffix)
    fs.mkdirSync(path.dirname(link), { recursive: true, mode: 0o700 })
    fs.symlinkSync(target, link, 'dir')
    refused(() => prepareLinuxAccountState(profile))
    assert.equal(mode(target), 0o755)
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true)
  }
})

test('missing owner access is not silently granted', { skip: !linux }, t => {
  const { profile } = fixture(t)
  fs.mkdirSync(profile, { mode: 0o500 })
  refused(() => prepareLinuxAccountState(profile))
  assert.equal(mode(profile), 0o500)
  fs.chmodSync(profile, 0o700)
})

test('broad or ambiguous storage roots are refused before mutation', { skip: !linux }, () => {
  for (const value of ['/', os.homedir(), path.dirname(os.homedir()), '', 'relative', '/tmp/../tmp/profile', '/tmp/profile/', '/tmp/profile\n']) {
    refused(() => prepareLinuxAccountState(value))
  }
})

test('a replaced directory is refused after open and its replacement is not chmodded', { skip: !linux }, t => {
  const { root, profile } = fixture(t)
  fs.mkdirSync(profile); fs.chmodSync(profile, 0o775)
  const moved = path.join(root, 'moved'), original = fs.openSync
  fs.openSync = function (...args) {
    const fd = original(...args)
    if (String(args[0]).endsWith('/profile')) {
      fs.renameSync(profile, moved)
      fs.mkdirSync(profile); fs.chmodSync(profile, 0o775)
    }
    return fd
  }
  try { refused(() => prepareLinuxAccountState(profile)) }
  finally { fs.openSync = original }
  assert.equal(mode(profile), 0o775)
  assert.equal(mode(moved), 0o775)
})
