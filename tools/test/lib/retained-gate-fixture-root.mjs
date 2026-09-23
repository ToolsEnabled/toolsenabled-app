import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  inspectSourceFixtureHome,
  retainedSourceFixtureEnvironment,
  explicitWindowsFixtureParent,
} from './source-fixture-root.mjs'

export const GATE_FIXTURE_ENV_KEYS = Object.freeze({
  parent: 'TOOLSENABLED_TEST_FIXTURE_PARENT',
  limit: 'TOOLSENABLED_TEST_FIXTURE_LIMIT',
  runId: 'TOOLSENABLED_TEST_FIXTURE_RUN_ID',
  suite: 'TOOLSENABLED_TEST_FIXTURE_SUITE',
})

export const MAX_GATE_FIXTURE_LIMIT = 4096
export const MAX_GATE_FIXTURE_METADATA_BYTES = 16 * 1024
export const GATE_FIXTURE_PARENT_MARKER = '.te-retained-fixture-parent.json'
export const GATE_FIXTURE_MANIFEST = 'manifest.json'

const PARENT_KIND = 'tools-enabled-retained-fixture-parent'
const FIXTURE_KIND = 'tools-enabled-retained-fixture'
const SCHEMA_VERSION = 1
const SLOT_PATTERN = /^te-source-fixture-(\d{6})$/
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const MAX_ALLOCATION_TIMESTAMP_LENGTH = 24
const ALLOCATION_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
const pathsFor = platform => platform === 'win32' ? path.win32 : path.posix
const samePath = (platform, left, right) => platform === 'win32'
  ? left.toLowerCase() === right.toLowerCase()
  : left === right

function defaultAccountIdentity(platform) {
  if (platform === 'win32') return Object.freeze({ platform, mode: 'windows-profile-acl' })
  return Object.freeze({
    platform,
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
  })
}

function assertOwnedEntry(entry, file, label, platform, accountIdentity) {
  if (platform === 'win32') {
    if (accountIdentity?.platform && accountIdentity.platform !== 'win32') {
      fail(label + ' has an incompatible Windows ownership identity')
    }
    if (accountIdentity?.mode !== 'windows-profile-acl') {
      fail(label + ' requires the current Windows profile ACL boundary')
    }
    return
  }
  if (!Number.isSafeInteger(accountIdentity?.uid) || accountIdentity.uid < 0) {
    fail(label + ' current-account ownership is unavailable')
  }
  if (entry.uid !== accountIdentity.uid) {
    fail(label + ' is owned by another account')
  }
}

function assertAllocationTimestamp(value, label = 'Fixture allocation timestamp') {
  if (typeof value !== 'string' ||
      value.length !== MAX_ALLOCATION_TIMESTAMP_LENGTH ||
      !ALLOCATION_TIMESTAMP_PATTERN.test(value)) {
    fail(label + ' must be a bounded canonical UTC timestamp')
  }
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    fail(label + ' must be a valid UTC timestamp')
  }
  return value
}

function fail(message) {
  throw new Error(message)
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(label + ' must be an object')
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(label + ' has unknown or missing metadata')
  }
}

function assertPortableAbsolute(value, label, platform) {
  const paths = pathsFor(platform)
  if (typeof value !== 'string' || !paths.isAbsolute(value) ||
      paths.normalize(value) !== value || value === paths.parse(value).root ||
      /[\x00-\x1f]/.test(value)) {
    fail(label + ' must be a normalized non-root absolute path')
  }
  return value
}

function assertIdentifier(value, label) {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    fail(label + ' must be a bounded portable identifier')
  }
  return value
}

function parseLimit(value) {
  if (typeof value !== 'string' || !/^(?:[1-9]\d*)$/.test(value)) {
    fail('Fixture limit must be a canonical positive decimal')
  }
  const limit = Number(value)
  if (!Number.isSafeInteger(limit) || limit > MAX_GATE_FIXTURE_LIMIT) {
    fail('Fixture limit exceeds hard bound ' + MAX_GATE_FIXTURE_LIMIT)
  }
  return limit
}

function readOrNull(filesystem, file) {
  try {
    return filesystem.lstatSync(file)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function readJson(filesystem, file, label, platform, accountIdentity) {
  let entry
  try {
    entry = filesystem.lstatSync(file)
  } catch (error) {
    throw new Error(label + ' is unreadable: ' + (error?.message || error))
  }
  if (!entry.isFile() || entry.isSymbolicLink()) {
    fail(label + ' must be an ordinary metadata file')
  }
  assertOwnedEntry(entry, file, label, platform, accountIdentity)
  const actual = filesystem.realpathSync.native(file)
  if (!samePath(platform, actual, file)) {
    fail(label + ' resolves through a path alias')
  }
  if (!Number.isSafeInteger(entry.size) || entry.size < 0 ||
      entry.size > MAX_GATE_FIXTURE_METADATA_BYTES) {
    fail(label + ' exceeds metadata size bound')
  }
  let source
  try {
    source = filesystem.readFileSync(file, 'utf8')
  } catch (error) {
    throw new Error(label + ' is unreadable: ' + (error?.message || error))
  }
  const text = String(source)
  if (Buffer.byteLength(text, 'utf8') > MAX_GATE_FIXTURE_METADATA_BYTES) {
    fail(label + ' exceeds metadata size bound')
  }
  try {
    return JSON.parse(text)
  } catch {
    fail(label + ' is malformed')
  }
}

function writeExclusive(filesystem, file, value, label) {
  const encoded = JSON.stringify(value) + '\n'
  if (Buffer.byteLength(encoded, 'utf8') > MAX_GATE_FIXTURE_METADATA_BYTES) {
    fail(label + ' exceeds metadata size bound')
  }
  try {
    filesystem.writeFileSync(file, encoded, {
      encoding: 'utf8', flag: 'wx', mode: 0o600,
    })
  } catch (error) {
    if (error?.code === 'EEXIST') return false
    throw new Error('Unable to initialize ' + label + ': ' + (error?.message || error))
  }
  return true
}

function assertOrdinaryDirectory(filesystem, file, label, platform, accountIdentity) {
  const entry = filesystem.lstatSync(file)
  if (!entry.isDirectory() || entry.isSymbolicLink()) fail(label + ' must be an ordinary directory')
  assertOwnedEntry(entry, file, label, platform, accountIdentity)
  const actual = filesystem.realpathSync.native(file)
  if (!samePath(platform, actual, file)) fail(label + ' resolves through a path alias')
  return entry
}

function assertSameDirectoryIdentity(before, after, label) {
  if (before.dev !== undefined || after.dev !== undefined) {
    if (before.dev !== after.dev || before.ino !== after.ino) {
      fail(label + ' changed during marker initialization')
    }
  }
}

function assertChildOfAccountHome(accountHome, parent, platform) {
  const paths = pathsFor(platform)
  const relative = paths.relative(accountHome, parent)
  if (!relative || relative === '..' || relative.startsWith('..' + paths.sep) ||
      paths.isAbsolute(relative)) {
    fail('Fixture parent must be a non-home child of the current account home')
  }
}

function markerMetadata(parent, limit) {
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: PARENT_KIND,
    parent,
    limit,
  }
}

function validateMarker(value, parent, limit, platform) {
  assertObject(value, 'Fixture parent marker')
  assertExactKeys(value, ['schemaVersion', 'kind', 'parent', 'limit'], 'Fixture parent marker')
  if (value.schemaVersion !== SCHEMA_VERSION || value.kind !== PARENT_KIND ||
      typeof value.parent !== 'string' || !samePath(platform, value.parent, parent) ||
      value.limit !== limit) {
    fail('Fixture parent marker does not match the requested owner or capacity')
  }
}

function manifestMetadata({ parent, root, slot, runId, suite, limit, allocatedAt }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: FIXTURE_KIND,
    status: 'ALLOCATED',
    parent,
    root,
    slot,
    runId,
    suite,
    limit,
    allocatedAt: assertAllocationTimestamp(allocatedAt),
  }
}

function validateManifest(value, { parent, root, slot, limit }, platform) {
  assertObject(value, 'Retained fixture manifest')
  assertExactKeys(value, [
    'schemaVersion', 'kind', 'status', 'parent', 'root', 'slot',
    'runId', 'suite', 'limit', 'allocatedAt',
  ], 'Retained fixture manifest')
  if (value.schemaVersion !== SCHEMA_VERSION || value.kind !== FIXTURE_KIND ||
      value.status !== 'ALLOCATED' || typeof value.parent !== 'string' ||
      !samePath(platform, value.parent, parent) || typeof value.root !== 'string' ||
      !samePath(platform, value.root, root) || value.slot !== slot ||
      value.limit !== limit || typeof value.allocatedAt !== 'string') {
    fail('Retained fixture manifest does not match its immutable slot')
  }
  assertIdentifier(value.runId, 'Retained fixture manifest runId')
  assertIdentifier(value.suite, 'Retained fixture manifest suite')
  assertAllocationTimestamp(value.allocatedAt, 'Retained fixture manifest allocatedAt')
  return value
}

function validateSlot(filesystem, parent, slotName, limit, platform, accountIdentity) {
  const paths = pathsFor(platform)
  const match = SLOT_PATTERN.exec(slotName)
  if (!match) fail('Fixture parent contains an unknown entry')
  const slotNumber = Number(match[1])
  if (slotNumber < 1 || slotNumber > limit) {
    fail('Fixture parent contains a slot outside its pinned capacity')
  }
  const root = paths.join(parent, slotName)
  assertOrdinaryDirectory(filesystem, root, 'Retained fixture slot', platform, accountIdentity)
  const names = filesystem.readdirSync(root).map(String)
  if (!names.includes(GATE_FIXTURE_MANIFEST)) {
    fail('Retained fixture slot is missing its manifest')
  }
  const manifest = validateManifest(
    readJson(
      filesystem,
      paths.join(root, GATE_FIXTURE_MANIFEST),
      'Retained fixture manifest',
      platform,
      accountIdentity,
    ),
    { parent, root, slot: slotNumber, limit },
    platform,
  )
  if (names.filter(name => name === GATE_FIXTURE_MANIFEST).length !== 1) {
    fail('Retained fixture slot has duplicate manifest metadata')
  }
  return { root, slot: slotNumber, manifest }
}

function validateParentContents(filesystem, parent, marker, limit, platform, accountIdentity) {
  const initialParent = assertOrdinaryDirectory(
    filesystem, parent, 'Fixture parent', platform, accountIdentity,
  )
  const names = filesystem.readdirSync(parent).map(String)
  if (!names.includes(GATE_FIXTURE_PARENT_MARKER)) {
    if (names.length !== 0) fail('Unowned fixture parent contains unknown contents')
    const created = writeExclusive(
      filesystem, marker, markerMetadata(parent, limit), 'fixture parent marker',
    )
    if (!created) return validateParentContents(
      filesystem, parent, marker, limit, platform, accountIdentity,
    )
    const markerValue = readJson(
      filesystem, marker, 'Fixture parent marker', platform, accountIdentity,
    )
    validateMarker(markerValue, parent, limit, platform)
    const finalParent = assertOrdinaryDirectory(
      filesystem, parent, 'Fixture parent', platform, accountIdentity,
    )
    assertSameDirectoryIdentity(initialParent, finalParent, 'Fixture parent')
    const namesAfterMarker = filesystem.readdirSync(parent).map(String)
    if (namesAfterMarker.length !== 1 ||
        namesAfterMarker[0] !== GATE_FIXTURE_PARENT_MARKER) {
      fail('Fixture parent changed during marker initialization')
    }
    const finalMarkerValue = readJson(
      filesystem, marker, 'Fixture parent marker', platform, accountIdentity,
    )
    validateMarker(finalMarkerValue, parent, limit, platform)
    return []
  }
  const markerValue = readJson(
    filesystem, marker, 'Fixture parent marker', platform, accountIdentity,
  )
  validateMarker(markerValue, parent, limit, platform)
  const slots = []
  for (const name of names) {
    if (name === GATE_FIXTURE_PARENT_MARKER) continue
    slots.push(validateSlot(filesystem, parent, name, limit, platform, accountIdentity))
  }
  return slots
}

function validateContractOptions(options, platform, fixtureBoundary = null) {
  assertObject(options, 'Retained gate fixture options')
  const parent = assertPortableAbsolute(options.parent, 'Fixture parent', platform)
  const accountHome = assertPortableAbsolute(options.accountHome, 'Account home', platform)
  assertChildOfAccountHome(fixtureBoundary || accountHome, parent, platform)
  const limit = Number.isSafeInteger(options.limit) ? options.limit : parseLimit(options.limit)
  if (limit < 1 || limit > MAX_GATE_FIXTURE_LIMIT) {
    fail('Fixture limit exceeds hard bound ' + MAX_GATE_FIXTURE_LIMIT)
  }
  const runId = assertIdentifier(options.runId, 'Fixture runId')
  const suite = assertIdentifier(options.suite, 'Fixture suite')
  return { parent, accountHome, limit, runId, suite }
}

export function parseGateFixtureContract(env = process.env, { platform = process.platform } = {}) {
  assertObject(env, 'Fixture environment')
  const keys = Object.values(GATE_FIXTURE_ENV_KEYS)
  const anyOwn = keys.some(key => own(env, key))
  const anyValue = keys.some(key => env[key] !== undefined)
  if (!anyOwn && !anyValue) return null
  if (!own(env, 'TOOLSENABLED_TEST_STRICT') || env.TOOLSENABLED_TEST_STRICT !== '1') {
    fail('Explicit retained fixture contract requires strict mode')
  }
  if (!keys.every(key => own(env, key))) {
    fail('Explicit retained fixture contract must provide all four fields')
  }
  if (!keys.every(key => typeof env[key] === 'string' && env[key].length > 0)) {
    fail('Explicit retained fixture contract cannot contain empty fields')
  }
  return Object.freeze({
    parent: assertPortableAbsolute(env[GATE_FIXTURE_ENV_KEYS.parent], 'Fixture parent', platform),
    limit: parseLimit(env[GATE_FIXTURE_ENV_KEYS.limit]),
    runId: assertIdentifier(env[GATE_FIXTURE_ENV_KEYS.runId], 'Fixture runId'),
    suite: assertIdentifier(env[GATE_FIXTURE_ENV_KEYS.suite], 'Fixture suite'),
  })
}

export function prepareRetainedGateFixture({
  filesystem = fs,
  platform = process.platform,
  accountHome = os.userInfo().homedir,
  now = () => new Date().toISOString(),
  accountIdentity = defaultAccountIdentity(platform),
  ...options
} = {}) {
  // Injected filesystems are used by the existing pure contract tests. Only
  // actual allocations may consult the actual account/volume observation.
  const fixtureBoundary = filesystem === fs && platform === process.platform
    ? explicitWindowsFixtureParent(options.parent)
    : null
  const contract = validateContractOptions({ ...options, accountHome }, platform, fixtureBoundary)
  const paths = pathsFor(platform)
  const marker = paths.join(contract.parent, GATE_FIXTURE_PARENT_MARKER)
  const parentEntry = readOrNull(filesystem, contract.parent)
  if (parentEntry === null) {
    const ancestor = paths.dirname(contract.parent)
    inspectSourceFixtureHome(ancestor, { platform, filesystem })
    try {
      filesystem.mkdirSync(contract.parent, { mode: 0o700 })
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
    inspectSourceFixtureHome(contract.parent, { platform, filesystem })
  } else {
    inspectSourceFixtureHome(contract.parent, { platform, filesystem })
  }
  assertOrdinaryDirectory(filesystem, contract.parent, 'Fixture parent', platform, accountIdentity)
  inspectSourceFixtureHome(fixtureBoundary || contract.accountHome, { platform, filesystem })
  const slots = validateParentContents(
    filesystem, contract.parent, marker, contract.limit, platform, accountIdentity,
  )
  const occupied = new Set(slots.map(slot => slot.slot))
  for (let slotNumber = 1; slotNumber <= contract.limit; slotNumber += 1) {
    if (occupied.has(slotNumber)) continue
    const slotName = 'te-source-fixture-' + String(slotNumber).padStart(6, '0')
    const root = paths.join(contract.parent, slotName)
    try {
      filesystem.mkdirSync(root, { mode: 0o700 })
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      validateSlot(
        filesystem, contract.parent, slotName, contract.limit, platform, accountIdentity,
      )
      continue
    }
    assertOrdinaryDirectory(filesystem, root, 'Retained fixture slot', platform, accountIdentity)
    const manifestPath = paths.join(root, GATE_FIXTURE_MANIFEST)
    const allocatedAt = assertAllocationTimestamp(now())
    const manifest = manifestMetadata({
      parent: contract.parent,
      root,
      slot: slotNumber,
      runId: contract.runId,
      suite: contract.suite,
      limit: contract.limit,
      allocatedAt,
    })
    if (!writeExclusive(
      filesystem, manifestPath, manifest, 'retained fixture manifest',
    )) {
      fail('Retained fixture slot has an existing manifest')
    }
    const storedManifest = validateManifest(
      readJson(
        filesystem,
        manifestPath,
        'Retained fixture manifest',
        platform,
        accountIdentity,
      ),
      { parent: contract.parent, root, slot: slotNumber, limit: contract.limit },
      platform,
    )
    return {
      root,
      environment: retainedSourceFixtureEnvironment(root, contract.parent, platform),
      ownership: Object.freeze({
        ...storedManifest,
        manifest: manifestPath,
      }),
    }
  }
  fail('Retained fixture capacity exhausted')
}
