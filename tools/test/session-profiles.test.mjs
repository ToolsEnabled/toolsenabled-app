import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { createSessionProfileStore, MAX_PROFILES, MAX_NAME_LENGTH } = require('../../shell/session-profiles.cjs')

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'session-profiles-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const file = join(root, 'state', 'session-profiles.json')
  return { root, workspace, file, store: createSessionProfileStore({ file }) }
}

function refusal(action, code) {
  assert.throws(action, error => {
    assert.equal(error?.code, code)
    assert.equal(typeof error?.message, 'string')
    assert.notEqual(error.message.trim(), '', `${code} must explain the refusal`)
    return true
  })
}

function directoryWithPathLength(root, length) {
  const remaining = length - root.length
  const componentCount = Math.ceil(remaining / 201)
  const characterCount = remaining - componentCount
  let allocated = 0
  const components = Array.from({ length: componentCount }, (_, index) => {
    const componentsLeft = componentCount - index
    const size = Math.ceil((characterCount - allocated) / componentsLeft)
    allocated += size
    return 'x'.repeat(size)
  })
  const directory = join(root, ...components)
  assert.equal(directory.length, length)
  mkdirSync(directory, { recursive: true })
  return directory
}

test('create returns and persists the caller-visible profile identity and chosen folder', t => {
  const { file, workspace, store } = fixture(t)
  const created = store.create({ name: `  ${'A'.repeat(MAX_NAME_LENGTH + 8)}  `, cwd: workspace })

  assert.match(created.id, /^profile-./)
  assert.deepEqual(created, { id: created.id, name: 'A'.repeat(MAX_NAME_LENGTH), cwd: workspace })
  assert.deepEqual(createSessionProfileStore({ file }).list(), [created])

  const stored = JSON.parse(readFileSync(file, 'utf8')).profiles[0]
  assert.equal(typeof stored.createdAt, 'string')
  assert.equal(Number.isNaN(Date.parse(stored.createdAt)), false)
})

test('create accepts a usable directory but refuses unusable choices with reasons', t => {
  const { root, workspace, store } = fixture(t)
  assert.equal(store.create({ name: 'Work', cwd: workspace }).cwd, workspace)

  refusal(() => store.create({ name: '   ', cwd: workspace }), 'PROFILE_NAME_MISSING')
  refusal(() => store.create({ name: 'Missing', cwd: join(root, 'absent') }), 'PROFILE_FOLDER_MISSING')
  const ordinaryFile = join(root, 'ordinary-file')
  writeFileSync(ordinaryFile, 'not a directory')
  refusal(() => store.create({ name: 'File', cwd: ordinaryFile }), 'PROFILE_FOLDER_NOT_DIRECTORY')
})

test('create enforces folder anti-smuggling boundaries without refusing their legitimate edges', t => {
  const { root, store } = fixture(t)
  const longestUsableFolder = directoryWithPathLength(root, 1024)
  assert.equal(store.create({ name: 'Longest usable path', cwd: longestUsableFolder }).cwd, longestUsableFolder)

  refusal(() => store.create({ name: 'Too long', cwd: `${longestUsableFolder}x` }), 'PROFILE_FOLDER_INVALID')
  refusal(() => store.create({ name: 'NUL byte', cwd: `${root}\0smuggled` }), 'PROFILE_FOLDER_INVALID')

  const ordinaryNamedFolder = join(root, 'asar', 'workspace')
  mkdirSync(ordinaryNamedFolder, { recursive: true })
  assert.equal(store.create({ name: 'Ordinary folder', cwd: ordinaryNamedFolder }).cwd, ordinaryNamedFolder)

  const packagedFolder = join(root, 'application.asar', 'workspace')
  mkdirSync(packagedFolder, { recursive: true })
  refusal(() => store.create({ name: 'Packaged folder', cwd: packagedFolder }), 'PROFILE_FOLDER_INVALID')
})

test('duplicate names and the capacity boundary refuse additions without losing existing profiles', t => {
  const { file, workspace, store } = fixture(t)
  const profiles = Array.from({ length: MAX_PROFILES }, (_, index) => ({
    id: `profile-${index}`,
    name: `Workspace ${index}`,
    cwd: workspace,
    createdAt: new Date(0).toISOString(),
  }))
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify({ v: 1, profiles }))

  refusal(() => store.create({ name: 'workspace 0', cwd: workspace }), 'PROFILE_LIMIT')
  assert.equal(store.list().length, MAX_PROFILES)

  writeFileSync(file, JSON.stringify({ v: 1, profiles: profiles.slice(0, 2) }))
  refusal(() => store.create({ name: '  WORKSPACE 0  ', cwd: workspace }), 'PROFILE_NAME_TAKEN')
  assert.deepEqual(store.list().map(profile => profile.id), ['profile-0', 'profile-1'])
})

test('resolve returns only a recorded, still-usable folder and explains both refusal paths', t => {
  const { workspace, store } = fixture(t)
  const created = store.create({ name: 'Work', cwd: workspace })
  assert.equal(store.resolveCwd(created.id), workspace)

  refusal(() => store.resolveCwd('profile-not-recorded'), 'PROFILE_UNKNOWN')
  rmSync(workspace, { recursive: true })
  refusal(() => store.resolveCwd(created.id), 'PROFILE_FOLDER_MISSING')
})

test('remove distinguishes a removed record from an unknown id and preserves other records', t => {
  const { workspace, store } = fixture(t)
  const first = store.create({ name: 'First', cwd: workspace })
  const second = store.create({ name: 'Second', cwd: workspace })

  assert.equal(store.remove(first.id), true)
  assert.equal(store.remove(first.id), false)
  assert.deepEqual(store.list(), [second])
})

test('an unreadable store is reported rather than collapsed into a definite empty answer', t => {
  const { file, store } = fixture(t)
  mkdirSync(file, { recursive: true })
  refusal(() => store.list(), 'PROFILE_STORE_UNREADABLE')
})
