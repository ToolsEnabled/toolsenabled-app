import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  GATE_FIXTURE_ENV_KEYS,
  GATE_FIXTURE_MANIFEST,
  GATE_FIXTURE_PARENT_MARKER,
  MAX_GATE_FIXTURE_LIMIT,
  MAX_GATE_FIXTURE_METADATA_BYTES,
  parseGateFixtureContract,
  prepareRetainedGateFixture,
} from './lib/retained-gate-fixture-root.mjs'

class MemoryFilesystem {
  constructor(platform = 'linux') {
    this.platform = platform
    this.uid = platform === 'win32' ? null : 1000
    this.paths = platform === 'win32' ? path.win32 : path.posix
    const root = this.paths.parse(platform === 'win32' ? 'C:\\' : '/').root
    this.dirs = new Set([root])
    this.files = new Map()
    this.owners = new Map([[root, this.uid]])
    this.identities = new Map([[root, { dev: 1, ino: 1 }]])
    this.nextInode = 2
    this.symlinks = new Set()
    this.aliases = new Map()
    this.removals = []
    this.onWrite = null
    this.realpathSync = { native: file => this.aliases.get(file) || file }
  }

  ensureDirectoryChain(directory) {
    const root = this.paths.parse(directory).root
    this.dirs.add(root)
    if (!this.owners.has(root)) this.owners.set(root, this.uid)
    if (!this.identities.has(root)) {
      this.identities.set(root, { dev: 1, ino: this.nextInode++ })
    }
    const relative = this.paths.relative(root, directory)
    let cursor = root
    for (const segment of relative ? relative.split(this.paths.sep) : []) {
      cursor = this.paths.join(cursor, segment)
      this.dirs.add(cursor)
      if (!this.owners.has(cursor)) this.owners.set(cursor, this.uid)
      if (!this.identities.has(cursor)) {
        this.identities.set(cursor, { dev: 1, ino: this.nextInode++ })
      }
    }
    return directory
  }

  addDirectory(directory, { uid = this.uid } = {}) {
    this.ensureDirectoryChain(directory)
    this.owners.set(directory, uid)
    return directory
  }

  addFile(file, content = '', { uid = this.uid } = {}) {
    this.ensureDirectoryChain(this.paths.dirname(file))
    this.files.set(file, String(content))
    this.owners.set(file, uid)
    if (!this.identities.has(file)) {
      this.identities.set(file, { dev: 1, ino: this.nextInode++ })
    }
    return file
  }

  lstatSync(file) {
    const uid = this.owners.has(file) ? this.owners.get(file) : this.uid
    const identity = this.identities.get(file) || { dev: 1, ino: 0 }
    if (this.symlinks.has(file)) {
      return {
        ...identity,
        isDirectory: () => true,
        isFile: () => false,
        isSymbolicLink: () => true,
        uid,
        size: 0,
      }
    }
    if (this.dirs.has(file)) {
      return {
        ...identity,
        isDirectory: () => true,
        isFile: () => false,
        isSymbolicLink: () => false,
        uid,
        size: 0,
      }
    }
    if (this.files.has(file)) {
      return {
        ...identity,
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false,
        uid,
        size: Buffer.byteLength(this.files.get(file), 'utf8'),
      }
    }
    const error = new Error('missing')
    error.code = 'ENOENT'
    throw error
  }

  mkdirSync(directory) {
    if (this.dirs.has(directory) || this.files.has(directory) || this.symlinks.has(directory)) {
      const error = new Error('exists')
      error.code = 'EEXIST'
      throw error
    }
    const parent = this.paths.dirname(directory)
    if (!this.dirs.has(parent)) {
      const error = new Error('missing parent')
      error.code = 'ENOENT'
      throw error
    }
    this.dirs.add(directory)
    this.owners.set(directory, this.uid)
    this.identities.set(directory, { dev: 1, ino: this.nextInode++ })
  }

  readdirSync(directory) {
    const names = []
    for (const file of [...this.dirs, ...this.files.keys(), ...this.symlinks]) {
      if (file === directory) continue
      const relative = this.paths.relative(directory, file)
      if (!relative || relative.startsWith('..') || this.paths.isAbsolute(relative) ||
          relative.includes(this.paths.sep)) continue
      const name = this.paths.basename(file)
      if (!names.includes(name)) names.push(name)
    }
    return names
  }

  readFileSync(file) {
    if (!this.files.has(file)) {
      const error = new Error('missing')
      error.code = 'ENOENT'
      throw error
    }
    return this.files.get(file)
  }

  writeFileSync(file, content, options = {}) {
    if (options.flag === 'wx' && (this.files.has(file) || this.dirs.has(file) ||
        this.symlinks.has(file))) {
      const error = new Error('exists')
      error.code = 'EEXIST'
      throw error
    }
    this.ensureDirectoryChain(this.paths.dirname(file))
    this.files.set(file, String(content))
    this.owners.set(file, this.uid)
    if (!this.identities.has(file)) {
      this.identities.set(file, { dev: 1, ino: this.nextInode++ })
    }
    this.onWrite?.(file)
  }

  rmSync(file) {
    this.removals.push(file)
  }
}

function fixture(platform = 'linux') {
  const paths = platform === 'win32' ? path.win32 : path.posix
  const accountHome = platform === 'win32'
    ? 'C:\\Users\\redacted-profile'
    : '/home/redacted-profile'
  const parent = paths.join(accountHome, 'te-gate-fixtures')
  const filesystem = new MemoryFilesystem(platform)
  filesystem.ensureDirectoryChain(accountHome)
  return { filesystem, platform, paths, accountHome, parent }
}

function options(fixtureState, overrides = {}) {
  return {
    filesystem: fixtureState.filesystem,
    platform: fixtureState.platform,
    accountHome: fixtureState.accountHome,
    accountIdentity: fixtureState.platform === 'win32'
      ? { platform: 'win32', mode: 'windows-profile-acl' }
      : { platform: 'linux', uid: fixtureState.filesystem.uid },
    parent: fixtureState.parent,
    limit: 2,
    runId: 'run-20260922',
    suite: 'source-suite.mjs',
    now: () => '2026-09-22T11:00:00.000Z',
    ...overrides,
  }
}

function env(overrides = {}) {
  return {
    TOOLSENABLED_TEST_STRICT: '1',
    [GATE_FIXTURE_ENV_KEYS.parent]: '/home/redacted-profile/te-gate-fixtures',
    [GATE_FIXTURE_ENV_KEYS.limit]: '256',
    [GATE_FIXTURE_ENV_KEYS.runId]: 'run-20260922',
    [GATE_FIXTURE_ENV_KEYS.suite]: 'source-suite.mjs',
    ...overrides,
  }
}

function parseLinuxGateFixtureContract(environment) {
  return parseGateFixtureContract(environment, { platform: 'linux' })
}

function runPreloadSandbox({ environment = {}, isMainThread = true } = {}) {
  const preloadPath = new URL('./lib/isolate-native-state-root.mjs', import.meta.url)
  const preloadSource = readFileSync(preloadPath, 'utf8')
  const calls = {
    gate: [],
    legacy: 0,
    mkdtemp: [],
    mkdir: [],
    writes: [],
    removals: [],
    exits: [],
    logs: [],
  }
  const filesystem = {
    mkdtempSync(prefix) {
      calls.mkdtemp.push(prefix)
      return prefix + 'sandbox-root'
    },
    mkdirSync(directory, options) {
      calls.mkdir.push({ directory, options })
    },
    writeFileSync(file, content, options) {
      calls.writes.push({ file, content, options })
    },
    rmSync(file, options) {
      calls.removals.push({ file, options })
    },
  }
  const processRef = {
    env: { ...environment },
    execPath: '/usr/bin/node',
    once(event, callback) {
      calls.exits.push({ event, callback })
    },
  }
  const legacyFixture = Object.freeze({
    root: '/legacy-root',
    environment: Object.freeze({
      TMPDIR: '/legacy-root',
      TEMP: '/legacy-root',
      TMP: '/legacy-root',
    }),
  })
  const gateFixture = Object.freeze({
    root: '/home/redacted-profile/te-gate-fixtures/te-source-fixture-000001',
    environment: Object.freeze({
      TMPDIR: '/home/redacted-profile/te-gate-fixtures/te-source-fixture-000001',
      TEMP: '/home/redacted-profile/te-gate-fixtures/te-source-fixture-000001',
      TMP: '/home/redacted-profile/te-gate-fixtures/te-source-fixture-000001',
    }),
    ownership: Object.freeze({
      schemaVersion: 1,
      kind: 'tools-enabled-retained-fixture',
      status: 'ALLOCATED',
      parent: '/home/redacted-profile/te-gate-fixtures',
      root: '/home/redacted-profile/te-gate-fixtures/te-source-fixture-000001',
      slot: 1,
      runId: 'run-20260922',
      suite: 'source-suite.mjs',
      limit: 256,
      allocatedAt: '2026-09-22T11:00:00.000Z',
      manifest: '/home/redacted-profile/te-gate-fixtures/te-source-fixture-000001/manifest.json',
    }),
  })
  const processEnv = processRef.env
  const context = {
    Buffer,
    URL,
    console: { log: value => calls.logs.push(String(value)) },
    fs: filesystem,
    os: {
      tmpdir: () => '/tmp',
      userInfo: () => ({ homedir: '/home/redacted-profile' }),
    },
    path: path.posix,
    isMainThread,
    fileURLToPath: () => '/app',
    canonicalRootForTests: () => '/engine',
    parseGateFixtureContract: parseLinuxGateFixtureContract,
    prepareRetainedGateFixture: options => {
      calls.gate.push(options)
      return gateFixture
    },
    prepareRetainedSourceFixture: () => {
      calls.legacy += 1
      return legacyFixture
    },
    process: processRef,
    importMeta: { url: 'file:///sandbox/tools/test/lib/isolate-native-state-root.mjs' },
  }
  const executable = preloadSource
    .replace(/^import[^\n]*\n/gm, '')
    .replaceAll('import.meta.url', 'importMeta.url')
  let error = null
  try {
    vm.runInNewContext(executable, context, { filename: preloadPath.pathname })
  } catch (caught) {
    error = caught
  }
  return { calls, env: processEnv, gateFixture, legacyFixture, error }
}

test('actual preload sandbox preserves legacy strict setup without gate fields', () => {
  const state = runPreloadSandbox({
    environment: { TOOLSENABLED_TEST_STRICT: '1' },
  })
  assert.equal(state.error, null)
  assert.equal(state.calls.legacy, 1)
  assert.deepEqual(state.calls.gate, [])
  assert.deepEqual(state.calls.mkdtemp, [])
  const signal = JSON.parse(state.calls.logs[0].replace('RETAINED_SOURCE_FIXTURE ', ''))
  assert.equal(signal.root, '/legacy-root')
  assert.deepEqual(signal.environment, state.legacyFixture.environment)
  assert.equal('ownership' in signal, false)
})

test('actual preload sandbox selects full gate contract and emits complete ownership without environment', () => {
  const state = runPreloadSandbox({ environment: env() })
  assert.equal(state.error, null)
  assert.equal(state.calls.legacy, 0)
  assert.equal(state.calls.gate.length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(state.calls.gate[0])), {
    parent: '/home/redacted-profile/te-gate-fixtures',
    limit: 256,
    runId: 'run-20260922',
    suite: 'source-suite.mjs',
    accountHome: '/home/redacted-profile',
  })
  assert.deepEqual(state.calls.mkdtemp, [])
  const signal = JSON.parse(state.calls.logs[0].replace('RETAINED_SOURCE_FIXTURE ', ''))
  assert.deepEqual(Object.keys(signal).sort(), [
    'allocatedAt', 'appRoot', 'canonicalRoot', 'kind', 'limit', 'manifest',
    'node', 'parent', 'root', 'runId', 'schemaVersion', 'slot', 'status', 'suite',
  ].sort())
  assert.equal(signal.environment, undefined)
  assert.equal(signal.root, state.gateFixture.root)
  assert.equal(signal.slot, 1)
  assert.equal(signal.limit, 256)
  assert.equal(signal.runId, 'run-20260922')
  assert.equal(signal.suite, 'source-suite.mjs')
  assert.equal(signal.appRoot, '/app')
  assert.equal(signal.canonicalRoot, '/engine')
  assert.equal(signal.node, '/usr/bin/node')
})

test('actual preload sandbox refuses partial or non-strict declared contracts before mkdir', () => {
  for (const environment of [
    env({ [GATE_FIXTURE_ENV_KEYS.suite]: undefined }),
    { ...env(), TOOLSENABLED_TEST_STRICT: '0' },
  ]) {
    const state = runPreloadSandbox({ environment })
    assert.ok(state.error instanceof Error)
    assert.deepEqual(state.calls.gate, [])
    assert.equal(state.calls.legacy, 0)
    assert.deepEqual(state.calls.mkdtemp, [])
    assert.deepEqual(state.calls.mkdir, [])
  }
})

test('actual preload sandbox is a no-op in Worker threads', () => {
  const state = runPreloadSandbox({ environment: env(), isMainThread: false })
  assert.equal(state.error, null)
  assert.deepEqual(state.calls.gate, [])
  assert.equal(state.calls.legacy, 0)
  assert.deepEqual(state.calls.mkdtemp, [])
  assert.deepEqual(state.calls.mkdir, [])
  assert.deepEqual(state.calls.logs, [])
})

test('absent gate contract preserves legacy parsing while full own fields parse canonically', () => {
  assert.equal(parseLinuxGateFixtureContract({ TOOLSENABLED_TEST_STRICT: '1' }), null)
  assert.deepEqual(parseLinuxGateFixtureContract(env()), {
    parent: '/home/redacted-profile/te-gate-fixtures',
    limit: 256,
    runId: 'run-20260922',
    suite: 'source-suite.mjs',
  })
})

test('declared gate contract refuses partial, empty, inherited, non-strict, and over-bound input', () => {
  const accepted128 = env({
    [GATE_FIXTURE_ENV_KEYS.runId]: 'a' + 'b'.repeat(127),
    [GATE_FIXTURE_ENV_KEYS.suite]: 'c' + 'd'.repeat(127),
  })
  assert.equal(parseLinuxGateFixtureContract(accepted128).runId.length, 128)
  assert.equal(parseLinuxGateFixtureContract(accepted128).suite.length, 128)
  const cases = [
    env({ [GATE_FIXTURE_ENV_KEYS.suite]: undefined }),
    env({ [GATE_FIXTURE_ENV_KEYS.limit]: '' }),
    { ...env(), TOOLSENABLED_TEST_STRICT: '0' },
    Object.assign(Object.create(env()), { TOOLSENABLED_TEST_STRICT: '1' }),
    env({
      [GATE_FIXTURE_ENV_KEYS.runId]: 'a' + 'b'.repeat(128),
    }),
    env({ [GATE_FIXTURE_ENV_KEYS.limit]: '000256' }),
    env({ [GATE_FIXTURE_ENV_KEYS.limit]: String(MAX_GATE_FIXTURE_LIMIT + 1) }),
    env({ [GATE_FIXTURE_ENV_KEYS.parent]: '/home/redacted-profile/../other' }),
    env({ [GATE_FIXTURE_ENV_KEYS.suite]: '../secrets' }),
  ]
  for (const candidate of cases) {
    assert.throws(() => parseLinuxGateFixtureContract(candidate))
  }
})

test('gate allocation initializes only an owned parent and returns metadata-only ownership', () => {
  const state = fixture()
  const result = prepareRetainedGateFixture(options(state))
  assert.equal(result.root, '/home/redacted-profile/te-gate-fixtures/te-source-fixture-000001')
  assert.deepEqual(result.environment, {
    TMPDIR: result.root,
    TEMP: result.root,
    TMP: result.root,
    TOOLSENABLED_RETAIN_LIFECYCLE_FIXTURES: '1',
    TOOLSENABLED_TEST_RETAIN_FIXTURES: '1',
  })
  assert.deepEqual(Object.keys(result.ownership).sort(), [
    'allocatedAt', 'kind', 'limit', 'manifest', 'parent', 'root',
    'runId', 'schemaVersion', 'slot', 'status', 'suite',
  ].sort())
  assert.equal(result.ownership.status, 'ALLOCATED')
  assert.equal(result.ownership.slot, 1)
  assert.equal(result.ownership.limit, 2)
  assert.equal(result.ownership.manifest, state.paths.join(result.root, GATE_FIXTURE_MANIFEST))
  const marker = JSON.parse(state.filesystem.readFileSync(
    state.paths.join(state.parent, GATE_FIXTURE_PARENT_MARKER),
  ))
  const manifest = JSON.parse(state.filesystem.readFileSync(result.ownership.manifest))
  assert.deepEqual(Object.keys(marker).sort(), ['kind', 'limit', 'parent', 'schemaVersion'].sort())
  assert.deepEqual(Object.keys(manifest).sort(), [
    'allocatedAt', 'kind', 'limit', 'parent', 'root', 'runId',
    'schemaVersion', 'slot', 'status', 'suite',
  ].sort())
  assert.equal('environment' in marker, false)
  assert.equal('environment' in manifest, false)
  assert.deepEqual(state.filesystem.removals, [])
})

test('capacity is persistent across run IDs and counts allocated roots, not bytes', () => {
  const state = fixture()
  const first = prepareRetainedGateFixture(options(state, { limit: 2 }))
  state.filesystem.addDirectory(state.paths.join(first.root, 'state'))
  state.filesystem.addFile(state.paths.join(first.root, 'state', 'opaque.bin'), 'fixture data')
  const second = prepareRetainedGateFixture(options(state, {
    limit: 2, runId: 'run-20260923', suite: 'other-suite.mjs',
  }))
  assert.equal(second.ownership.slot, 2)
  assert.throws(() => prepareRetainedGateFixture(options(state, {
    limit: 2, runId: 'run-20260924',
  })), /capacity exhausted/)
  assert.deepEqual(state.filesystem.removals, [])
})

test('unknown parent contents, mismatched marker, and partial slot metadata refuse without reuse', () => {
  const state = fixture()
  state.filesystem.addDirectory(state.parent)
  state.filesystem.addFile(state.paths.join(state.parent, 'unexpected'), 'unknown')
  assert.throws(() => prepareRetainedGateFixture(options(state)), /unknown contents/)
  const mismatch = fixture()
  mismatch.filesystem.addDirectory(mismatch.parent)
  mismatch.filesystem.addFile(
    mismatch.paths.join(mismatch.parent, GATE_FIXTURE_PARENT_MARKER),
    JSON.stringify({
      schemaVersion: 1,
      kind: 'tools-enabled-retained-fixture-parent',
      parent: mismatch.parent,
      limit: 3,
    }),
  )
  assert.throws(() => prepareRetainedGateFixture(options(mismatch)), /does not match/)
  const partial = fixture()
  partial.filesystem.addDirectory(partial.parent)
  partial.filesystem.addFile(
    partial.paths.join(partial.parent, GATE_FIXTURE_PARENT_MARKER),
    JSON.stringify({
      schemaVersion: 1,
      kind: 'tools-enabled-retained-fixture-parent',
      parent: partial.parent,
      limit: 2,
    }),
  )
  partial.filesystem.addDirectory(
    partial.paths.join(partial.parent, 'te-source-fixture-000001'),
  )
  assert.throws(() => prepareRetainedGateFixture(options(partial)), /missing its manifest/)
})

test('foreign, linked, aliased, Git-ancestor, and noncanonical parents refuse', () => {
  const foreign = fixture()
  assert.throws(() => prepareRetainedGateFixture(options(foreign, {
    parent: '/srv/fixture-other/te-gate-fixtures',
  })), /non-home child/)
  const linked = fixture()
  linked.filesystem.addDirectory(linked.parent)
  linked.filesystem.symlinks.add(linked.parent)
  assert.throws(() => prepareRetainedGateFixture(options(linked)), /ordinary directories/)
  const foreignOwner = fixture()
  foreignOwner.filesystem.addDirectory(foreignOwner.parent, { uid: 2000 })
  assert.throws(() => prepareRetainedGateFixture(options(foreignOwner)), /owned by another account/)
  const aliased = fixture()
  aliased.filesystem.addDirectory(aliased.parent)
  aliased.filesystem.aliases.set(aliased.parent, aliased.parent + '-alias')
  assert.throws(() => prepareRetainedGateFixture(options(aliased)), /path alias/)
  const git = fixture()
  git.filesystem.addFile(git.paths.join(git.accountHome, '.git'), 'marker')
  assert.throws(() => prepareRetainedGateFixture(options(git)), /Git ancestor/)
  const noncanonical = fixture()
  assert.throws(() => prepareRetainedGateFixture(options(noncanonical, {
    parent: '/home/redacted-profile/../redacted-profile/te-gate-fixtures',
  })), /normalized/)
})

test('marker creation revalidates parent identity and contents before allocation', () => {
  const lateContent = fixture()
  lateContent.filesystem.addDirectory(lateContent.parent)
  const lateMarker = lateContent.paths.join(lateContent.parent, GATE_FIXTURE_PARENT_MARKER)
  lateContent.filesystem.onWrite = file => {
    if (file === lateMarker) {
      lateContent.filesystem.addFile(
        lateContent.paths.join(lateContent.parent, 'late-entry'),
        'interleaved',
      )
    }
  }
  assert.throws(
    () => prepareRetainedGateFixture(options(lateContent)),
    /changed during marker initialization/,
  )
  assert.deepEqual(lateContent.filesystem.removals, [])

  const swapped = fixture()
  swapped.filesystem.addDirectory(swapped.parent)
  const swappedMarker = swapped.paths.join(swapped.parent, GATE_FIXTURE_PARENT_MARKER)
  swapped.filesystem.onWrite = file => {
    if (file === swappedMarker) {
      swapped.filesystem.aliases.set(swapped.parent, swapped.parent + '-replacement')
    }
  }
  assert.throws(
    () => prepareRetainedGateFixture(options(swapped)),
    /path alias/,
  )
  assert.deepEqual(swapped.filesystem.removals, [])


  const replaced = fixture()
  replaced.filesystem.addDirectory(replaced.parent)
  const replacedMarker = replaced.paths.join(replaced.parent, GATE_FIXTURE_PARENT_MARKER)
  replaced.filesystem.onWrite = file => {
    if (file === replacedMarker) {
      replaced.filesystem.identities.set(replaced.parent, { dev: 1, ino: 999 })
    }
  }
  assert.throws(
    () => prepareRetainedGateFixture(options(replaced)),
    /changed during marker initialization/,
  )
  assert.deepEqual(replaced.filesystem.removals, [])
})


test('metadata links, aliases, non-files, foreign owners, and oversized records refuse', () => {
  const markerLink = fixture()
  markerLink.filesystem.addDirectory(markerLink.parent)
  markerLink.filesystem.symlinks.add(
    markerLink.paths.join(markerLink.parent, GATE_FIXTURE_PARENT_MARKER),
  )
  assert.throws(() => prepareRetainedGateFixture(options(markerLink)), /ordinary metadata file/)

  const markerDirectory = fixture()
  markerDirectory.filesystem.addDirectory(markerDirectory.parent)
  markerDirectory.filesystem.addDirectory(
    markerDirectory.paths.join(markerDirectory.parent, GATE_FIXTURE_PARENT_MARKER),
  )
  assert.throws(() => prepareRetainedGateFixture(options(markerDirectory)), /ordinary metadata file/)

  const markerAlias = fixture()
  markerAlias.filesystem.addDirectory(markerAlias.parent)
  const markerAliasPath = markerAlias.paths.join(
    markerAlias.parent, GATE_FIXTURE_PARENT_MARKER,
  )
  markerAlias.filesystem.addFile(markerAliasPath, JSON.stringify({
    schemaVersion: 1,
    kind: 'tools-enabled-retained-fixture-parent',
    parent: markerAlias.parent,
    limit: 2,
  }))
  markerAlias.filesystem.aliases.set(markerAliasPath, markerAliasPath + '-alias')
  assert.throws(() => prepareRetainedGateFixture(options(markerAlias)), /path alias/)


  const markerForeign = fixture()
  markerForeign.filesystem.addDirectory(markerForeign.parent)
  markerForeign.filesystem.addFile(
    markerForeign.paths.join(markerForeign.parent, GATE_FIXTURE_PARENT_MARKER),
    JSON.stringify({
      schemaVersion: 1,
      kind: 'tools-enabled-retained-fixture-parent',
      parent: markerForeign.parent,
      limit: 2,
    }),
    { uid: 2000 },
  )
  assert.throws(
    () => prepareRetainedGateFixture(options(markerForeign)),
    /owned by another account/,
  )

  const markerLarge = fixture()
  markerLarge.filesystem.addDirectory(markerLarge.parent)
  markerLarge.filesystem.addFile(
    markerLarge.paths.join(markerLarge.parent, GATE_FIXTURE_PARENT_MARKER),
    'x'.repeat(MAX_GATE_FIXTURE_METADATA_BYTES + 1),
  )
  assert.throws(() => prepareRetainedGateFixture(options(markerLarge)), /metadata size bound/)


  const slotForeign = fixture()
  const slotResult = prepareRetainedGateFixture(options(slotForeign))
  slotForeign.filesystem.owners.set(slotResult.root, 2000)
  assert.throws(
    () => prepareRetainedGateFixture(options(slotForeign)),
    /owned by another account/,
  )

  const manifestLink = fixture()
  const linkedResult = prepareRetainedGateFixture(options(manifestLink))
  manifestLink.filesystem.symlinks.add(linkedResult.ownership.manifest)
  assert.throws(() => prepareRetainedGateFixture(options(manifestLink)), /ordinary metadata file/)

  const manifestDirectory = fixture()
  const directoryResult = prepareRetainedGateFixture(options(manifestDirectory))
  manifestDirectory.filesystem.addDirectory(directoryResult.ownership.manifest)
  assert.throws(() => prepareRetainedGateFixture(options(manifestDirectory)), /ordinary metadata file/)

  const manifestForeign = fixture()
  const foreignResult = prepareRetainedGateFixture(options(manifestForeign))
  manifestForeign.filesystem.owners.set(foreignResult.ownership.manifest, 2000)
  assert.throws(() => prepareRetainedGateFixture(options(manifestForeign)), /owned by another account/)

  const manifestLarge = fixture()
  const largeResult = prepareRetainedGateFixture(options(manifestLarge))
  manifestLarge.filesystem.files.set(
    largeResult.ownership.manifest,
    'x'.repeat(MAX_GATE_FIXTURE_METADATA_BYTES + 1),
  )
  assert.throws(() => prepareRetainedGateFixture(options(manifestLarge)), /metadata size bound/)
})

test('allocation and persisted manifests require bounded canonical timestamps', () => {
  const invalidClock = fixture()
  assert.throws(() => prepareRetainedGateFixture(options(invalidClock, {
    now: () => '2026-09-22',
  })), /timestamp/)

  const persisted = fixture()
  const result = prepareRetainedGateFixture(options(persisted))
  const manifest = JSON.parse(persisted.filesystem.readFileSync(result.ownership.manifest))
  manifest.allocatedAt = '2026-99-22T11:00:00.000Z'
  persisted.filesystem.files.set(result.ownership.manifest, JSON.stringify(manifest))
  assert.throws(() => prepareRetainedGateFixture(options(persisted)), /timestamp/)
})

test('Windows paths remain portable while case-normalized canonical roots are accepted', () => {
  const state = fixture('win32')
  state.filesystem.addDirectory(state.parent)
  state.filesystem.aliases.set(state.parent, state.parent.toLowerCase())
  const result = prepareRetainedGateFixture(options(state, {
    limit: 2,
    now: () => '2026-09-22T11:01:00.000Z',
  }))
  assert.equal(result.root, 'C:\\Users\\redacted-profile\\te-gate-fixtures\\te-source-fixture-000001')
  const parsed = parseGateFixtureContract({
    TOOLSENABLED_TEST_STRICT: '1',
    [GATE_FIXTURE_ENV_KEYS.parent]: state.parent,
    [GATE_FIXTURE_ENV_KEYS.limit]: '256',
    [GATE_FIXTURE_ENV_KEYS.runId]: 'run-20260922',
    [GATE_FIXTURE_ENV_KEYS.suite]: 'source-suite.mjs',
  }, { platform: 'win32' })
  assert.equal(parsed.parent, state.parent)
  assert.equal(parsed.limit, 256)
})
