import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { guardWindowsPath, guardWindowsTree } = require('../lib/page2-native-paths.cjs')
const accountHome = 'C:\\Users\\AuditOwner'
const qa = `${accountHome}\\AppData\\Local\\Temp\\qa`
const directory = { isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false, nlink: 1 }
const file = { isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true, nlink: 1 }
const link = { isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false, nlink: 1 }
function fixture(overrides = {}) {
  const calls = []
  const fsImpl = {
    lstatSync(value) { calls.push(value); if (value in overrides) { const item = overrides[value]; if (item instanceof Error) throw item; return item } return directory },
    realpathSync() { assert.fail('The guard must not resolve a link target') },
    readlinkSync() { assert.fail('The guard must not inspect a link target') },
  }
  return { calls, options: { accountHome, platform: 'win32', fsImpl } }
}

test('foreign conventional and redirected profiles are refused before any filesystem probe', () => {
  for (const [selected, profile] of [['C:\\Users\\Unowned\\source', accountHome], ['D:\\Profiles\\Unowned\\source', 'D:\\Profiles\\AuditOwner']]) {
    const f = fixture()
    assert.throws(() => guardWindowsPath(selected, { ...f.options, accountHome: profile }), { code: 'QA_PATH_FOREIGN_PROFILE' })
    assert.deepEqual(f.calls, [])
  }
})

test('UNC, devices, streams and ambiguous profile aliases are refused without probes', () => {
  for (const selected of ['\\\\server\\share', '\\\\?\\C:\\Users\\Unowned', `${qa}:stream`, 'C:\\Users\\UNOWNE~1\\app', 'C:\\Users\\Unowned.\\app', `${qa}\\..\\sibling`, `${qa}\\NUL.txt`]) {
    const f = fixture()
    assert.throws(() => guardWindowsPath(selected, f.options), /Native audit paths/)
    assert.deepEqual(f.calls, [])
  }
})

test('an input junction stops traversal before any target child is probed', () => {
  for (const parent of [accountHome, `${accountHome}\\AppData`, qa]) {
    const f = fixture({ [parent]: link })
    assert.throws(() => guardWindowsPath(`${qa}\\source\\package.json`, f.options), { code: 'QA_PATH_LINK' })
    assert.equal(f.calls.at(-1), parent)
    assert.equal(f.calls.some(value => value.startsWith(`${parent}\\`)), false)
  }
})

test('missing output descendants are accepted only after ordinary ancestors are validated', () => {
  const missing = Object.assign(new Error('absent'), { code: 'ENOENT' })
  const f = fixture({ [qa]: missing })
  assert.equal(guardWindowsPath(`${qa}\\new run`, { ...f.options, allowMissing: true, requireProfile: true }), `${qa}\\new run`)
  assert.equal(f.calls.at(-1), qa)
  assert.throws(() => guardWindowsPath(`${qa}\\new run`, f.options), { code: 'ENOENT' })
})

test('output outside the owner profile is rejected before any probe', () => {
  const f = fixture()
  assert.throws(() => guardWindowsPath('C:\\Temp\\qa', { ...f.options, requireProfile: true, allowMissing: true }), { code: 'QA_PATH_OUTSIDE_PROFILE' })
  assert.deepEqual(f.calls, [])
})

test('regular executable files work and hard links or wrong input types are refused', () => {
  const executable = `${qa}\\electron.exe`
  const f = fixture({ [executable]: file })
  assert.equal(guardWindowsPath(executable, { ...f.options, expectedType: 'file' }), executable)
  assert.throws(() => guardWindowsPath(executable, { ...f.options, expectedType: 'directory' }), { code: 'QA_PATH_TYPE' })
  const hard = fixture({ [executable]: { ...file, nlink: 2 } })
  assert.throws(() => guardWindowsPath(executable, hard.options), { code: 'QA_PATH_HARDLINK' })
})

test('module inventory stops at a nested junction before reading its directory', () => {
  const root = `${qa}\\modules`
  const nested = `${root}\\package`
  const f = fixture({ [nested]: link })
  const reads = []
  f.options.fsImpl.readdirSync = value => { reads.push(value); assert.equal(value, root); return [{ name: 'package' }] }
  assert.throws(() => guardWindowsTree(root, f.options), { code: 'QA_PATH_LINK' })
  assert.deepEqual(reads, [root])
})

test('dependency inventory is bounded', () => {
  const root = `${qa}\\modules`
  const f = fixture({ [`${root}\\a.js`]: file, [`${root}\\b.js`]: file })
  f.options.fsImpl.readdirSync = () => [{ name: 'a.js' }, { name: 'b.js' }]
  assert.throws(() => guardWindowsTree(root, { ...f.options, maximumEntries: 1 }), { code: 'QA_PATH_TREE_LIMIT' })
})

test('native Windows junction cannot redirect input traversal', { skip: process.platform !== 'win32' && 'Requires native Windows junctions' }, t => {
  const profile = os.homedir()
  const parent = guardWindowsPath(path.join(profile, 'AppData', 'Local', 'Temp'), { accountHome: profile, expectedType: 'directory', requireProfile: true })
  const root = fs.mkdtempSync(path.join(parent, 'page2-path-contract-'))
  const ownedTarget = path.join(root, 'owned target')
  const redirected = path.join(root, 'redirected')
  fs.mkdirSync(ownedTarget)
  fs.writeFileSync(path.join(ownedTarget, 'canary.txt'), 'owned fixture only\n')
  fs.symlinkSync(ownedTarget, redirected, 'junction')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const visited = []
  assert.throws(() => guardWindowsPath(path.join(redirected, 'canary.txt'), {
    accountHome: profile, fsImpl: { lstatSync(value) { visited.push(value); return fs.lstatSync(value) } },
  }), { code: 'QA_PATH_LINK' })
  assert.equal(visited.at(-1), redirected)
  assert.equal(visited.includes(path.join(redirected, 'canary.txt')), false)
})
