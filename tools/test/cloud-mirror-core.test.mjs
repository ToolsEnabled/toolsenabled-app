import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const require = createRequire(import.meta.url)
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const mirror = require(join(REPO, 'capability', 'src', 'lib', 'cloud-agent', 'cloud-mirror.js'))
const { ROUTES } = require(join(REPO, 'capability', 'src', 'lib', 'mission-bridge', 'server.js'))
const { createMissionActions } = require(join(REPO, 'capability', 'src', 'lib', 'mission-bridge', 'actions.js'))

const SOURCE = 'a'.repeat(40)
const BLOB = 'b'.repeat(40)
const TREE = 'c'.repeat(40)
const PUBLICATION = 'd'.repeat(40)
const REMOTE = 'https://github.com/Customer/Private-Mirror.git'
const REPOSITORY = 'Customer/Private-Mirror'
const BRANCH = 'cloud-mirror/engine'
const NOW = '2026-08-30T12:00:00.000Z'

// The core deliberately inspects the physical .git boundary before it lets an
// injected Git adapter run. Keep this fixture hermetic but real enough to reach
// the privacy assertions, entirely inside the Dev account's temporary folder.
const SOURCE_FIXTURE_ROOT = mkdtempSync(join(tmpdir(), 'cloud-mirror-source-checkout-'))
const SOURCE_ROOT = join(SOURCE_FIXTURE_ROOT, 'checkout')
mkdirSync(join(SOURCE_ROOT, '.git', 'objects', 'info'), { recursive: true })
writeFileSync(join(SOURCE_ROOT, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n\tbare = false\n')
after(() => rmSync(SOURCE_FIXTURE_ROOT, { recursive: true, force: true }))

/* THE PATH A FIXTURE WRITES IS NOT ALWAYS THE PATH `existsImpl` IS ASKED ABOUT.
 *
 * MEASURED 2026-09-03: on this machine `os.tmpdir()` hands back an 8.3 short
 * name (the very alias src/lib/account-profile-boundary.js's "8.3 short name
 * is the same account, spelled shorter" fix exists to recognise). The core's
 * own fencedCloudPath() canonicalises every path it is given -- correctly --
 * before it ever reaches an injected existsImpl, so a mock keyed on the RAW
 * tmpdir()-built string stops matching the moment that canonicalisation runs:
 * `candidate !== registryPath` reads the canonical form of registryPath as a
 * DIFFERENT file, existsImpl answers "exists" for a file nothing wrote, and
 * registration or replacement then dies on a genuine ENOENT trying to read or
 * unlink it. This mirrors the product's own canonicalisation for the one
 * component that can legitimately change (the directory, via its nearest
 * EXISTING ancestor) while leaving the fixture's own filename untouched, so
 * the comparison holds however the temp root happens to be spelled. */
function canonicalTempPath(filePath) {
  // realpathSync.native, not the plain export: the core's own
  // expandThroughExistingAncestor() (src/lib/account-profile-boundary.js)
  // prefers the native binding for exactly this reason -- Node's pure-JS
  // realpathSync does not expand a Windows 8.3 short name, so the plain
  // export it silently returns %TEMP% unchanged, still short, still
  // mismatched against what the core's own canonicalisation produces.
  const realpath = realpathSync.native || realpathSync
  return join(realpath(dirname(filePath)), basename(filePath))
}

function metadata(overrides = {}) {
  return {
    fullName: REPOSITORY,
    private: true,
    visibility: 'private',
    archived: false,
    disabled: false,
    ...overrides,
  }
}

function registrationOptions(overrides = {}) {
  const registryPath = join(tmpdir(), `cloud-mirror-registration-${process.pid}-${Math.random()}.json`)
  return {
    projectKey: 'engine',
    sourceRoot: SOURCE_ROOT,
    mirrorRemote: REMOTE,
    cloudRepository: REPOSITORY,
    registryPath,
    existsImpl: candidate => candidate !== canonicalTempPath(registryPath),
    runGitImpl: (_root, args) => {
      assert.equal(args[0], 'rev-parse')
      return SOURCE
    },
    mkdirImpl: () => {},
    writeFileImpl: () => {},
    renameImpl: () => {},
    ...overrides,
  }
}

test('registration refuses a public exact destination before any Git network operation or registry write', async () => {
  const events = []
  await assert.rejects(mirror.registerMirrorProject(registrationOptions({
    githubRepoGetImpl: async destination => {
      events.push(`github:${destination.fullName}`)
      return metadata({ private: false, visibility: 'public' })
    },
    networkGitImpl: async () => {
      events.push('network-git')
      return { exitCode: 0, stdout: '', stderr: '' }
    },
    writeFileImpl: () => events.push('registry-write'),
  })), error => error?.code === 'CLOUD_MIRROR_REPOSITORY_NOT_PRIVATE')
  assert.deepEqual(events, [`github:${REPOSITORY}`])
})

test('registration verifies the typed identity as private before reach/write probes and persists only its canonical remote', async () => {
  const events = []
  let serialized = null
  const result = await mirror.registerMirrorProject(registrationOptions({
    mirrorRemote: '  https://github.com/Customer/Private-Mirror  ',
    githubRepoGetImpl: async destination => {
      events.push(`github:${destination.fullName}`)
      return metadata()
    },
    networkGitImpl: async (_root, args) => {
      events.push(args[0] === 'push' ? `git:${args.slice(0, 2).join(':')}` : `git:${args[0]}`)
      return { exitCode: 0, stdout: '', stderr: '' }
    },
    writeFileImpl: (_file, value) => {
      events.push('registry-write')
      serialized = value
    },
    renameImpl: () => events.push('registry-rename'),
  }))

  assert.deepEqual(events, [
    `github:${REPOSITORY}`,
    'git:ls-remote',
    'git:push:--dry-run',
    `github:${REPOSITORY}`,
    'registry-write',
    'registry-rename',
  ])
  assert.equal(result.project.mirrorRemote, REMOTE)
  const saved = JSON.parse(serialized).projects.engine
  assert.equal(saved.mirrorRemote, REMOTE)
  assert.equal(saved.githubRepository, REPOSITORY)
  assert.equal(saved.cloudRepository, REPOSITORY)
})

function publishHarness(t, { repositoryMetadata = metadata() } = {}) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'cloud-mirror-publish-test-'))
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }))
  const registryPath = join(stateRoot, 'registry.json')
  const events = []
  let readCount = 0
  const project = Object.freeze({
    key: 'engine',
    sourceRoot: SOURCE_ROOT,
    mirrorRemote: REMOTE,
    mirrorBranch: BRANCH,
    boundaryManifest: join(SOURCE_ROOT, 'config', 'cloud-mirror-boundary.json'),
    cloudRepository: REPOSITORY,
    githubRepository: REPOSITORY,
    privacyVerifiedAt: NOW,
    enabled: true,
  })
  const boundary = Object.freeze({
    file: project.boundaryManifest,
    manifestSha256: 'e'.repeat(64),
    withhold: Object.freeze({ paths: Object.freeze([]), prefixes: Object.freeze([]) }),
    mirror: Object.freeze({ paths: Object.freeze(['file.txt']), prefixes: Object.freeze([]) }),
    acknowledged: new Map(),
  })
  const runGitImpl = (_root, args) => {
    if (args.includes('commit-tree')) return PUBLICATION
    switch (args[0]) {
      case 'rev-parse': return args.includes('--abbrev-ref') ? 'main' : SOURCE
      case 'ls-tree': return `100644 blob ${BLOB} 5\tfile.txt\0`
      case 'cat-file': return Buffer.from(`${BLOB} blob 5\nhello\n`)
      case 'update-index': return ''
      case 'write-tree': return TREE
      case 'status': return ''
      default: throw new Error(`unexpected git operation ${args.join(' ')}`)
    }
  }
  const networkGitImpl = async (_root, args) => {
    if (args[0] === 'push') {
      events.push({ kind: 'push', args: [...args] })
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    assert.deepEqual(args.slice(0, 2), ['ls-remote', '--exit-code'])
    events.push({ kind: 'read', remote: args[2], ref: args[3] })
    readCount += 1
    return readCount === 1
      ? { exitCode: 2, stdout: '', stderr: '' }
      : { exitCode: 0, stdout: `${PUBLICATION}\trefs/heads/${BRANCH}\n`, stderr: '' }
  }
  return {
    events,
    options: {
      projectKey: 'engine',
      publishedAt: NOW,
      stateRoot,
      runGitImpl,
      networkGitImpl,
      loadRegistryImpl: () => ({ registryPath, projects: new Map([['engine', project]]) }),
      loadBoundaryImpl: () => boundary,
      githubRepoGetImpl: async destination => {
        events.push({ kind: 'privacy', destination: destination.fullName })
        return repositoryMetadata
      },
    },
  }
}

test('publish refuses a destination that is no longer private and never reaches push', async t => {
  const harness = publishHarness(t, { repositoryMetadata: metadata({ private: false, visibility: 'public' }) })
  await assert.rejects(mirror.publishMirror(harness.options), error => error?.code === 'CLOUD_MIRROR_REPOSITORY_NOT_PRIVATE')
  assert.deepEqual(harness.events.map(event => event.kind), ['read', 'privacy'])
})

test('publish rechecks the exact stored destination immediately before pushing the exact stored remote', async t => {
  const harness = publishHarness(t)
  await mirror.publishMirror(harness.options)
  assert.deepEqual(harness.events.map(event => event.kind), ['read', 'privacy', 'push', 'read'])
  assert.equal(harness.events[1].destination, REPOSITORY)
  assert.deepEqual(harness.events[2].args, ['push', REMOTE, `${PUBLICATION}:refs/heads/${BRANCH}`])
})

test('disable is a local-only reset and the disabled binding can be explicitly reverified against a different private destination', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cloud-mirror-disable-test-'))
  try {
    const registryPath = join(root, 'registry.json')
    const receiptFile = join(root, 'engine.json')
    mkdirSync(root, { recursive: true })
    writeFileSync(registryPath, `${JSON.stringify({
      schemaVersion: mirror.REGISTRY_SCHEMA,
      projects: {
        engine: {
          sourceRoot: SOURCE_ROOT,
          mirrorRemote: REMOTE,
          mirrorBranch: BRANCH,
          boundaryManifest: 'config/cloud-mirror-boundary.json',
          cloudRepository: REPOSITORY,
          githubRepository: REPOSITORY,
          privacyVerifiedAt: NOW,
        },
      },
    }, null, 2)}\n`)
    writeFileSync(receiptFile, '{"publication":"local authority"}\n')

    const result = mirror.disableMirrorProject({ projectKey: 'engine', registryPath, stateRoot: root, disabledAt: NOW })
    const saved = JSON.parse(readFileSync(registryPath, 'utf8')).projects.engine
    assert.equal(existsSync(receiptFile), false)
    assert.equal(saved.mirrorRemote, REMOTE)
    assert.equal(saved.mirrorBranch, BRANCH)
    assert.equal(saved.githubRepository, undefined)
    assert.equal(saved.privacyVerifiedAt, undefined)
    assert.equal(saved.locallyDisabledAt, NOW)
    assert.equal(result.project.enabled, false)
    assert.match(result.project.disabledReason, /GitHub repository and workspace branch were not changed/i)
    assert.equal(mirror.listRegisteredProjects({ registryPath }).projects[0].enabled, false)

    const replacementRemote = 'https://github.com/Customer/Replacement-Mirror.git'
    const replacementRepository = 'Customer/Replacement-Mirror'
    await mirror.registerMirrorProject({
      projectKey: 'engine',
      sourceRoot: SOURCE_ROOT,
      mirrorRemote: replacementRemote,
      cloudRepository: replacementRepository,
      registryPath,
      stateRoot: root,
      replace: true,
      existsImpl: candidate => candidate !== canonicalTempPath(receiptFile),
      runGitImpl: () => SOURCE,
      networkGitImpl: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      githubRepoGetImpl: async destination => {
        assert.equal(destination.fullName, replacementRepository)
        return metadata({ fullName: replacementRepository })
      },
    })
    const replaced = JSON.parse(readFileSync(registryPath, 'utf8')).projects.engine
    assert.equal(replaced.mirrorRemote, replacementRemote)
    assert.equal(replaced.githubRepository, replacementRepository)
    assert.equal(replaced.locallyDisabledAt, undefined)
    assert.equal(mirror.listRegisteredProjects({ registryPath }).projects[0].enabled, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the mission bridge exposes the local disable route separately from publish', () => {
  assert.equal(ROUTES['/v1/actions/cloud-mirror-disable'], 'cloudMirrorDisable')
  assert.equal(ROUTES['/v1/actions/cloud-mirror-publish'], 'cloudMirrorPublish')
})

test('the mission action forwards only the project key to the local disable core and reports that the remote was unchanged', async () => {
  const calls = []
  const agentOrg = JSON.parse(readFileSync(join(REPO, 'capability', 'config', 'agent-org.json'), 'utf8'))
  /* THE AUDIT WRITER MUST BE INJECTED, NOT DEFAULTED.
   *
   * createMissionActions() falls back to the REAL audit module when no
   * `audit` is supplied, and cloudMirrorDisable brackets the core call with
   * two durable requireRecord() writes. With the fallback in place this test
   * signed two rows -- cloud.mirror.disable.intent and cloud.mirror.disable,
   * target "engine", actor "controller" -- into whatever ledger
   * TOOLSENABLED_STATE_ROOT (or the per-user default) resolved to at the
   * time the suite ran. MEASURED 2026-09-03 on this machine: 24 such pairs in
   * the owner's live-tier ledger and 41 in the default-profile ledger, every
   * one for a project no registry has held since 2026-08-30, plus a vault
   * file and audit sqlite created wherever the state root pointed, and
   * 5-15 s per pair paying the anchor. A signed ledger that says a mirror
   * was disabled sixty-five times when it was never registered is not
   * evidence of anything, and a test run that mutates the owner's audit
   * history is a test run that cannot be repeated safely.
   *
   * The stub below records what the action asked the writer to do, so the
   * test can also prove the bracketing it relies on: exactly one intent
   * before the core call and exactly one outcome after it. */
  let auditSequence = 0
  const audit = {
    record: () => ({ ok: true, durable: true }),
    requireRecord: (action, target, details) => {
      auditSequence += 1
      calls.push({ kind: 'audit', action, target, details, sequence: auditSequence })
      return { durable: true, anchored: true, sequence: auditSequence, eventHash: auditSequence.toString(16).padStart(64, '0') }
    },
  }
  const actions = createMissionActions({
    roots: { app: REPO },
    actor: 'controller',
    agentOrg,
    audit,
    permissionSession: { origin: 'local', tier: 'full' },
    policy: { assertActive: (action, details) => calls.push({ kind: 'guard', action, details }) },
    cloudMirror: {
      disableMirrorProject: input => {
        calls.push({ kind: 'disable', input })
        return {
          registryPath: 'memory-registry.json',
          projectKey: input.projectKey,
          project: { key: input.projectKey, enabled: false, mirrorRemote: REMOTE, mirrorBranch: BRANCH },
        }
      },
    },
  })
  const response = await actions.cloudMirrorDisable({ projectKey: 'engine' })
  const guards = calls.filter(call => call.kind === 'guard')
  const disable = calls.find(call => call.kind === 'disable')
  assert.ok(guards.length >= 1)
  assert.equal(guards[0].action, 'mission.bridge.cloud-mirror-disable')
  assert.ok(guards.every(call => call.details.outward === false))
  assert.equal(disable.input.projectKey, 'engine')
  assert.equal(Object.keys(disable.input).sort().join(','), 'disabledAt,projectKey')
  assert.match(disable.input.disabledAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(response.receipt.remoteChanged, false)
  assert.equal(response.receipt.project.enabled, false)
  // Every durable write went to the injected writer, in the order the action
  // promises: intent, then the core mutation, then the outcome. If the
  // injection is ever dropped again these rows land in a real ledger instead
  // and this list is empty.
  const audits = calls.filter(call => call.kind === 'audit')
  assert.deepEqual(audits.map(call => [call.action, call.target]), [
    ['cloud.mirror.disable.intent', 'engine'],
    ['cloud.mirror.disable', 'engine'],
  ])
  assert.ok(calls.indexOf(audits[0]) < calls.indexOf(disable) && calls.indexOf(disable) < calls.indexOf(audits[1]))
  assert.deepEqual(response.receipt.intentAudit, { sequence: 1, eventHash: audits[0].sequence.toString(16).padStart(64, '0') })
  assert.deepEqual(response.receipt.audit, { sequence: 2, eventHash: audits[1].sequence.toString(16).padStart(64, '0') })
})
