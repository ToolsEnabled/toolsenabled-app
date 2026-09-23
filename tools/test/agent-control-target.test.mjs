import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import {
  PROJECT_ROOT,
  assertValidProjection,
  readSchema,
  validateAgainstSchema,
} from '../gen-projection-lib.mjs'
import { canonicalRootForTests } from '../canonical-root.mjs'
import {
  assertCanonicalPresenceReader,
  canonicalPresenceEnvironment,
  copyCanonicalPresenceReaders,
} from './fixtures/canonical-presence.mjs'

// WHERE THE FIXTURE READERS COME FROM, AND WHY IT IS NOT CANONICAL_ROOT.
//
// These tests build their fixture by copying the REAL reader modules out of the
// ToolsEnabled checkout, so they exercise the actual parsing code rather than a
// re-implementation of it. That is worth keeping.
//
// It used to import CANONICAL_ROOT from the generator library, which is a different
// concept wearing the same name: CANONICAL_ROOT is "the root THIS GENERATOR RUN must
// read", a value that is now fail-closed when unset precisely so a build cannot silently
// read one person's Desktop. Borrowing it as a test-fixture location coupled a test to
// the generator's configuration and broke the moment that default was removed.
//
// tools/canonical-root.mjs resolves only an explicit integration override, the
// release source override, or the ignored owner capability-source setting. It
// never searches sibling/Desktop layouts and cannot silently bind this test to
// an old checkout that merely carries the expected marker.
const CANONICAL_FIXTURE_SOURCE = canonicalRootForTests()

// A SKIP MUST BE LOUD, AND MUST NOT BE THE NORMAL CASE.
//
// Skipping when the sibling checkout is absent is right -- a stranger cloning only this
// repo has no ToolsEnabled tree and should not see three failures they cannot act on.
// But a test that quietly skips is a test that stopped protecting anything while still
// printing green, which is the failure-reported-as-success defect this project keeps
// finding. The reason is therefore always stated, and on a normal developer layout the
// path resolves and the tests RUN.
function canonicalReadersMissing() {
  return !existsSync(join(CANONICAL_FIXTURE_SOURCE, 'src', 'lib', 'agent-org.js'))
}

const SKIP_REASON =
  `Configured ToolsEnabled engine not found at ${CANONICAL_FIXTURE_SOURCE}: these tests copy its real ` +
  'reader modules as a fixture. Set MC_CANONICAL_ROOT, TOOLSENABLED_SOURCE, or private/capability-source.owner.json to run them.'

const FIXED_NOW = '2026-08-06T19:00:00.000Z'
const DECLARED = Object.freeze({
  running: 'coordinator-sol',
  // R1186/R1187 (2026-08-08, canonical config/agent-org.json rev18) retired the
  // 'claude' agent id: the sole Claude shadow-manager seat became
  // 'shadow-manager-opus5' under the Opus 5 Ultra org. 'coordinator-sol' is
  // retained (disabled, role 'observer') rather than removed, so it still
  // resolves; 'claude' does not and must track its successor id here.
  starting: 'shadow-manager-opus5',
  finished: 'codex-manager-reconcile',
  failed: 'codex-manager-platform',
  stale: 'codex-manager-release',
  missing: 'codex-manager-deep-systems',
})
const FORBIDDEN_VALUES = Object.freeze([
  'registry-worktree-value',
  'registry-brief-value',
  'registry-console-log-value',
  'registry-launch-spec-value',
  'registry-checkpoint-value',
  'registry-prompt-value',
  'registry-task-handle-value',
  'registry-verdict-value',
  'registry-mailbox-value',
  'registry-path-value',
  'registry-command-value',
])

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf8')
}

// The declared roster this fixture asserts against. These are FIXTURE ids and
// are deliberately not read from the owner's live org: config/agent-org.json in
// the canonical tree states owner intent and is edited whenever the org changes
// (R1186 reseated it and dropped the id this fixture had been borrowing), so a
// test copying it went red with no commit in this repo behind it. What this
// test is actually about -- that gen-agents maps presence records onto declared
// agents and emits an exact controlTarget -- does not depend on WHO is declared.
function fixtureOrg() {
  const agent = (id, displayName) => ({
    id,
    displayName,
    role: id === DECLARED.running ? 'controller' : 'manager',
    provider: 'codex',
    enabled: true,
    assignedPhase: null,
    phasePriority: [],
  })
  return {
    schemaVersion: 1,
    revision: 7,
    agents: [
      agent(DECLARED.running, 'Fixture Controller'),
      agent(DECLARED.starting, 'Fixture Starting'),
      agent(DECLARED.finished, 'Fixture Finished'),
      agent(DECLARED.failed, 'Fixture Failed'),
      agent(DECLARED.stale, 'Fixture Stale'),
      agent(DECLARED.missing, 'Fixture Missing'),
    ],
    relationships: Object.values(DECLARED)
      .filter(id => id !== DECLARED.running)
      .map(id => ({ from: DECLARED.running, to: id, type: 'manages' })),
  }
}

function copyCanonicalReaders(root) {
  copyCanonicalPresenceReaders(CANONICAL_FIXTURE_SOURCE, root)
  assertCanonicalPresenceReader(root)
  const orgConfig = join(root, 'config', 'agent-org.json')
  mkdirSync(dirname(orgConfig), { recursive: true })
  writeFileSync(orgConfig, JSON.stringify(fixtureOrg(), null, 2), 'utf8')
  // The coupling that remains is to the canonical SCHEMA, which is the real
  // dependency, and it is asserted rather than assumed: if agent-org.js ever
  // tightens beyond what this fixture declares, this fails here with the
  // validator's own code instead of surfacing as a confusing projection diff.
  assertFixtureOrgValidates(root, orgConfig)
}

function assertFixtureOrgValidates(root, orgConfig) {
  const probe = spawnSync(process.execPath, [
    '-e',
    'const { normalizeOrg } = require(process.argv[1]);' +
    'const raw = JSON.parse(require("node:fs").readFileSync(process.argv[2], "utf8"));' +
    'process.stdout.write(String(normalizeOrg(raw).agents.length));',
    join(root, 'src', 'lib', 'agent-org.js'),
    orgConfig,
  ], { env: canonicalPresenceEnvironment(root), encoding: 'utf8', timeout: 30_000, windowsHide: true })
  assert.equal(probe.status, 0, `fixture agent-org.json rejected by the canonical validator: ${probe.stderr}`)
  assert.equal(probe.stdout, String(fixtureOrg().agents.length))
}

function liveFixture(root) {
  write(join(root, 'tools', 'agent-preflight.js'), `
process.stdout.write(JSON.stringify({
  generatedAt: '${FIXED_NOW}',
  otherAgents: { codex: [], claude: [], activeWindowMinutes: 90 }
}));
`)
}

function presenceRecord({ agentId, runId, status, pid, recordRevision, startedAt }) {
  const terminal = status === 'finished' || status === 'failed'
  return {
    agentId,
    runId,
    recordRevision,
    role: 'manager',
    tier: 'gpt-5.6-sol/xhigh',
    reportsTo: null,
    dispatcher: 'owner',
    lane: 'registry-lane-value',
    territory: 'registry-territory-value',
    currentTask: 'registry-task-handle-value',
    brief: 'registry-brief-value',
    consoleLog: 'registry-console-log-value',
    worktree: 'registry-worktree-value',
    launchSpec: 'registry-launch-spec-value',
    pid,
    startedAt,
    lastHeartbeat: startedAt + 500,
    status,
    exitCode: terminal ? (status === 'finished' ? 0 : 1) : null,
    lastVerdict: terminal ? 'registry-verdict-value' : null,
    terminalAt: terminal ? startedAt + 1_000 : null,
    staleReason: status === 'stale' ? 'registry-stale-reason-value' : null,
    mailboxOffset: 123,
    respawnCount: 2,
    verdictConsumedAt: terminal ? startedAt + 1_100 : null,
    checkpoint: 'registry-checkpoint-value',
    prompt: 'registry-prompt-value',
    taskHandle: 'registry-task-handle-value',
    mailbox: 'registry-mailbox-value',
    path: 'registry-path-value',
    command: 'registry-command-value',
  }
}

function validPresenceState() {
  const specs = [
    [DECLARED.running, 'aaaaaaaa-00000001', 'running', 41001],
    [DECLARED.starting, 'aaaaaaaa-00000002', 'starting', null],
    [DECLARED.finished, 'aaaaaaaa-00000003', 'finished', 41003],
    [DECLARED.failed, 'aaaaaaaa-00000004', 'failed', 41004],
    [DECLARED.stale, 'aaaaaaaa-00000005', 'stale', 41005],
    ['registry-only', 'aaaaaaaa-00000006', 'running', 41006],
  ]
  return {
    schemaVersion: 1,
    revision: 29,
    updatedAt: 1_786_030_000_000,
    agents: Object.fromEntries(specs.map(([agentId, runId, status, pid], index) => [
      agentId,
      presenceRecord({
        agentId,
        runId,
        status,
        pid,
        recordRevision: index + 1,
        startedAt: 1_786_030_001_000 + (index * 10_000),
      }),
    ])),
  }
}

function runAgentsFixture(t, presenceState) {
  const fixture = mkdtempSync(join(tmpdir(), 'mc-agent-control-target-'))
  t.after(() => rmSync(fixture, { recursive: true, force: true }))
  const canonical = join(fixture, 'canonical')
  const live = join(fixture, 'live')
  const output = join(fixture, 'output')
  copyCanonicalReaders(canonical)
  liveFixture(live)
  write(join(canonical, 'state', 'agent-presence.json'), JSON.stringify(presenceState))

  const run = spawnSync(process.execPath, [join(PROJECT_ROOT, 'tools', 'gen-agents.mjs')], {
    cwd: PROJECT_ROOT,
    env: {
      ...canonicalPresenceEnvironment(canonical),
      MC_NOW: FIXED_NOW,
      MC_CANONICAL_ROOT: canonical,
      MC_LIVE_ROOT: live,
      MC_OUTPUT_ROOT: output,
    },
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  })
  assert.equal(run.status, 0, run.stderr)
  return JSON.parse(readFileSync(join(output, 'agents.json'), 'utf8'))
}

function declaredAgent(payload, id) {
  const agent = payload.data.declared.find(candidate => candidate.id === id)
  assert.ok(agent, `missing declared fixture agent ${id}`)
  return agent
}

function withRunningTarget(payload, mutate) {
  const candidate = structuredClone(payload)
  const agent = declaredAgent(candidate, DECLARED.running)
  mutate(agent)
  return candidate
}

test('agents generator emits exact canonical control targets for every truthful presence status', t => {
  if (canonicalReadersMissing()) return t.skip(SKIP_REASON)
  const payload = runAgentsFixture(t, validPresenceState())
  assert.doesNotThrow(() => assertValidProjection('agents', payload))
  assert.ok(payload.data.declared.every(agent => Object.hasOwn(agent, 'controlTarget')))

  const running = declaredAgent(payload, DECLARED.running).controlTarget
  assert.deepEqual(running, {
    agentId: DECLARED.running,
    runId: 'aaaaaaaa-00000001',
    pid: 41001,
    status: 'running',
    recordRevision: 1,
    startedAt: 1_786_030_001_000,
    lastHeartbeat: 1_786_030_001_500,
  })
  assert.deepEqual(declaredAgent(payload, DECLARED.starting).controlTarget, {
    agentId: DECLARED.starting,
    runId: 'aaaaaaaa-00000002',
    pid: null,
    status: 'starting',
    recordRevision: 2,
    startedAt: 1_786_030_011_000,
    lastHeartbeat: 1_786_030_011_500,
  })
  for (const status of ['finished', 'failed', 'stale']) {
    assert.equal(declaredAgent(payload, DECLARED[status]).controlTarget.status, status)
  }
  assert.equal(declaredAgent(payload, DECLARED.missing).controlTarget, null)
  assert.equal(payload.data.declared.some(agent => agent.id === 'registry-only'), false)

  const serialized = JSON.stringify(payload)
  assert.equal(serialized.includes('registry-only'), false)
  for (const value of FORBIDDEN_VALUES) assert.equal(serialized.includes(value), false, value)
  for (const agent of payload.data.declared.filter(candidate => candidate.controlTarget !== null)) {
    assert.deepEqual(Object.keys(agent.controlTarget).sort(), [
      'agentId',
      'lastHeartbeat',
      'pid',
      'recordRevision',
      'runId',
      'startedAt',
      'status',
    ])
  }
})

test('malformed canonical presence remains fail-closed through the existing source envelope', t => {
  if (canonicalReadersMissing()) return t.skip(SKIP_REASON)
  const payload = runAgentsFixture(t, {
    schemaVersion: 1,
    revision: 1,
    updatedAt: null,
    agents: { [DECLARED.running]: { agentId: DECLARED.running, runId: 'malformed' } },
  })
  assert.equal(payload.ok, true)
  assert.ok(payload.data.declared.every(agent => agent.controlTarget === null))
  const source = payload.sources.find(candidate => candidate.id === 'agent-presence')
  assert.deepEqual(source, {
    id: 'agent-presence',
    kind: 'observed-registry',
    path: 'state/agent-presence.json',
    ok: false,
    observedAt: source.observedAt,
    reason: 'source-malformed',
  })
  assert.match(source.observedAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.doesNotThrow(() => assertValidProjection('agents', payload))
})

test('agents schema rejects unsafe or malformed control-target shapes', async t => {
  // Same guard as the two tests above: without it this test built the same
  // fixture and died in copyFileSync with an ENOENT the cloner cannot act on,
  // while its siblings skipped with a stated reason.
  if (canonicalReadersMissing()) return t.skip(SKIP_REASON)
  const payload = runAgentsFixture(t, validPresenceState())
  const schema = readSchema('agents')
  const reject = (name, mutate) => t.test(name, () => {
    const candidate = withRunningTarget(payload, mutate)
    assert.ok(validateAgainstSchema(candidate, schema).length > 0)
  })

  await reject('extra field', agent => { agent.controlTarget.extraControlTargetField = true })
  await reject('malformed run id', agent => { agent.controlTarget.runId = 'NOT-A-RUN' })
  await reject('zero pid', agent => { agent.controlTarget.pid = 0 })
  await reject('negative pid', agent => { agent.controlTarget.pid = -1 })
  await reject('unknown status', agent => { agent.controlTarget.status = 'paused' })
  await reject('missing control target', agent => { delete agent.controlTarget })
  await reject('array control target', agent => { agent.controlTarget = [] })
  await reject('string pid', agent => { agent.controlTarget.pid = '41001' })
  for (const field of ['agentId', 'runId', 'status', 'recordRevision', 'startedAt', 'lastHeartbeat']) {
    await reject(`null ${field}`, agent => { agent.controlTarget[field] = null })
  }
  await reject('fractional record revision', agent => { agent.controlTarget.recordRevision = 1.5 })
})
