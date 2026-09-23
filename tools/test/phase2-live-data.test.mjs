import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
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
  agentProjectionFields,
  aggregateTerminalLaneTasks,
  loadAgentProjectionTelemetry,
  projectAgentRelationships,
} from '../gen-projection-lib.mjs'
import { canonicalRootForTests } from '../canonical-root.mjs'
import {
  assertCanonicalPresenceReader,
  canonicalPresenceEnvironment,
  copyCanonicalPresenceReaders,
} from './fixtures/canonical-presence.mjs'

// WHERE THE REAL FIXTURE READER COMES FROM.
//
// This was one developer's absolute Desktop path, which made these tests
// unrunnable on any other machine and put an account name in a tracked file --
// and a tracked file publishes on every push, which is the exposure the
// owner-data rules exist for. tools/test/generator-failures.test.mjs and
// tools/test/agent-control-target.test.mjs already removed exactly this
// default and explain the reasoning at length; this file was missed. Resolved
// the same way they now are: tools/canonical-root.mjs reads only an explicit
// integration/release override or the ignored owner capability-source setting.
// It never searches another layout for a plausible-looking checkout.
const REAL_CANONICAL = canonicalRootForTests()
const FIXED_NOW = '2026-08-06T12:00:00.000Z'
const SENSITIVE_MARKER = 'fixture-sensitive-marker-abcdefghijklmnopqrstuvwxyz123456'

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf8')
}

function taskStore(rowsByStatus, agentByTask) {
  return {
    listTasks({ type, status, limit }) {
      assert.equal(type, 'codex-agent-lane')
      assert.equal(limit, 200)
      return (rowsByStatus[status] || []).map(id => ({ id, type }))
    },
    getTask({ taskId, includePayload, includeCheckpoint }) {
      assert.equal(includePayload, true)
      assert.equal(includeCheckpoint, false)
      const agentId = agentByTask[taskId]
      return {
        payload: { title: `ignored ${SENSITIVE_MARKER}`, objective: `ignored ${SENSITIVE_MARKER}`, context: JSON.stringify({ agentId, ignoredSecret: SENSITIVE_MARKER }) },
        result: { ignoredSecret: SENSITIVE_MARKER },
        error: { message: SENSITIVE_MARKER },
        claimToken: SENSITIVE_MARKER,
      }
    },
  }
}

function presenceRecord({ agentId, dispatcher, reportsTo, startedAt, runId, status = 'running', terminalAt = null }) {
  return {
    agentId,
    runId,
    recordRevision: 1,
    role: 'manager',
    tier: 'gpt-5.6-sol/xhigh',
    reportsTo,
    dispatcher,
    lane: 'phase2-data',
    territory: 'fixture',
    currentTask: null,
    brief: 'fixture brief',
    consoleLog: 'fixture.log',
    worktree: 'fixture-worktree',
    launchSpec: 'fixture-launch.json',
    pid: null,
    startedAt,
    lastHeartbeat: startedAt,
    status,
    exitCode: null,
    lastVerdict: null,
    terminalAt,
    staleReason: null,
    mailboxOffset: 0,
    respawnCount: 0,
    verdictConsumedAt: null,
  }
}

function liveFixture(root) {
  write(join(root, 'tools', 'agent-preflight.js'), `
const value = {
  generatedAt: '${FIXED_NOW}',
  machine: { letter: 'A' },
  otherAgents: { codex: [], claude: [], activeWindowMinutes: 90 },
  localServices: [{ name: 'fixture', ageSec: 1, stale: false, detail: 'healthy' }]
};
process.stdout.write(JSON.stringify(value));
`)
}

function runGenerator(domain, canonicalRoot, liveRoot, outputRoot) {
  return spawnSync(process.execPath, [join(PROJECT_ROOT, 'tools', `gen-${domain}.mjs`)], {
    cwd: PROJECT_ROOT,
    env: {
      ...canonicalPresenceEnvironment(canonicalRoot),
      MC_NOW: FIXED_NOW,
      MC_CANONICAL_ROOT: canonicalRoot,
      MC_LIVE_ROOT: liveRoot,
      MC_OUTPUT_ROOT: outputRoot,
    },
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  })
}

test('terminal task aggregation covers every outcome, zero denominator, and secret-free output', () => {
  const store = taskStore({
    succeeded: ['s1'],
    failed: ['f1'],
    uncertain: ['u1'],
    cancelled: ['c1', 'c2'],
  }, {
    s1: 'agent-a', f1: 'agent-a', u1: 'agent-a', c1: 'agent-a', c2: 'agent-b',
  })
  const aggregate = aggregateTerminalLaneTasks(store)
  assert.equal(aggregate.ok, true)
  assert.deepEqual(aggregate.outcomes, {
    succeeded: 1,
    failed: 1,
    uncertain: 1,
    cancelled: 2,
    attributed: 5,
  })
  assert.equal(aggregate.byAgent['agent-a'].tasksDone, 4)
  assert.equal(aggregate.byAgent['agent-a'].failRate, 66.7)
  assert.equal(aggregate.byAgent['agent-b'].tasksDone, 1)
  assert.equal(Object.hasOwn(aggregate.byAgent['agent-b'], 'failRate'), false)
  assert.equal(JSON.stringify(aggregate).includes(SENSITIVE_MARKER), false)
})

test('a saturated 200-row status read fails closed instead of publishing a partial lifetime count', () => {
  const ids = Array.from({ length: 200 }, (_, index) => `task-${index}`)
  const aggregate = aggregateTerminalLaneTasks(taskStore({ succeeded: ids }, Object.fromEntries(ids.map(id => [id, 'agent-a']))))
  assert.equal(aggregate.ok, false)
  assert.equal(aggregate.reason, 'source-truncated')
  assert.deepEqual(agentProjectionFields('agent-a', null, aggregate), {})
})

test('malformed task attribution fails closed without publishing partial per-agent telemetry', () => {
  const store = {
    listTasks({ status }) { return status === 'succeeded' ? [{ id: 'bad', type: 'codex-agent-lane' }] : [] },
    getTask() { return { payload: { context: '{not-json' } } },
  }
  const aggregate = aggregateTerminalLaneTasks(store)
  assert.equal(aggregate.ok, false)
  assert.equal(aggregate.reason, 'source-malformed')
  assert.deepEqual(agentProjectionFields('agent-a', null, aggregate), {})
})

test('registry fields preserve exact epochs/origins, stop only on exact terminal evidence, and omit malformed values', () => {
  const registry = {
    agents: {
      exact: { agentId: 'exact', startedAt: 1_786_000_123_456, status: 'finished', terminalAt: 1_786_000_223_456, origin: 'user', reportsTo: null },
      malformed: { agentId: 'malformed', startedAt: '1786000123456', origin: 'user-spawned', reportsTo: null },
      unresolved: { agentId: 'unresolved', startedAt: 42, status: 'running', terminalAt: 84, origin: 'self', reportsTo: null },
      badTerminal: { agentId: 'badTerminal', startedAt: 100, status: 'failed', terminalAt: 99, origin: 'self', reportsTo: null },
    },
  }
  assert.deepEqual(agentProjectionFields('exact', registry, null), { bornAt: 1_786_000_123_456, stoppedAt: 1_786_000_223_456, origin: 'user' })
  assert.deepEqual(agentProjectionFields('malformed', registry, null), {})
  assert.deepEqual(agentProjectionFields('unresolved', registry, null), { bornAt: 42, origin: 'self' })
  assert.deepEqual(agentProjectionFields('badTerminal', registry, null), { bornAt: 100, origin: 'self' })
  assert.deepEqual(agentProjectionFields('not-in-registry', registry, null), {})
})

test('observed delegates_to edges carry provenance, resolve endpoints, and defer to declared duplicates', () => {
  const declared = [
    { from: 'root', to: 'worker-a', type: 'delegates_to' },
    { from: 'root', to: 'worker-a', type: 'manages' },
  ]
  const registry = {
    agents: {
      'worker-a': { agentId: 'worker-a', reportsTo: 'root' },
      'worker-b': { agentId: 'worker-b', reportsTo: 'root' },
      outside: { agentId: 'outside', reportsTo: 'root' },
      malformed: { agentId: 'malformed', reportsTo: '../root' },
    },
  }
  const projected = projectAgentRelationships(declared, registry, new Set(['root', 'worker-a', 'worker-b']))
  assert.deepEqual(projected, [
    { from: 'root', to: 'worker-a', type: 'delegates_to', sourceKind: 'declared' },
    { from: 'root', to: 'worker-a', type: 'manages', sourceKind: 'declared' },
    { from: 'root', to: 'worker-b', type: 'delegates_to', sourceKind: 'observed' },
  ])
})

test('presence loading goes through normalizeRegistry and malformed registry input remains optional', t => {
  const fixture = mkdtempSync(join(tmpdir(), 'mc-phase2-presence-'))
  t.after(() => rmSync(fixture, { recursive: true, force: true }))
  write(join(fixture, 'src', 'lib', 'agent-presence.js'), `
module.exports = { normalizeRegistry(input) { return { agents: { node: { agentId: 'node', startedAt: input.epoch + 1, origin: 'self', reportsTo: null } } }; } };
`)
  write(join(fixture, 'state', 'agent-presence.json'), JSON.stringify({ epoch: 41 }))
  const loaded = loadAgentProjectionTelemetry(fixture)
  assert.deepEqual(agentProjectionFields('node', loaded.registry, loaded.tasks), { bornAt: 42, origin: 'self' })
  assert.equal(loaded.results.find(result => result.sourceId === 'agent-presence').ok, true)

  const malformed = mkdtempSync(join(tmpdir(), 'mc-phase2-presence-bad-'))
  t.after(() => rmSync(malformed, { recursive: true, force: true }))
  write(join(malformed, 'src', 'lib', 'agent-presence.js'), 'module.exports = { normalizeRegistry() { throw new Error("fixture malformed"); } };')
  write(join(malformed, 'state', 'agent-presence.json'), '{}')
  const rejected = loadAgentProjectionTelemetry(malformed)
  assert.equal(rejected.registry, null)
  assert.equal(rejected.results.find(result => result.sourceId === 'agent-presence').reason, 'source-malformed')
})

test('both generators emit matching live fields and declared/observed provenance from canonical-reader fixtures', t => {
  const fixture = mkdtempSync(join(tmpdir(), 'mc-phase2-generators-'))
  t.after(() => rmSync(fixture, { recursive: true, force: true }))
  const canonical = join(fixture, 'canonical')
  const live = join(fixture, 'live')
  const output = join(fixture, 'output')

  copyCanonicalPresenceReaders(REAL_CANONICAL, canonical)
  assertCanonicalPresenceReader(canonical)
  /* This fixture owns every identity its assertions name. Copying a developer's
     current org made a telemetry test fail whenever that unrelated org renamed
     a seat, and could make a zero-output generator look like valid coverage. */
  const declaredAgent = (id, displayName, role, provider) => ({
    id, displayName, role, provider, enabled: true, assignedPhase: null, phasePriority: [],
  })
  const org = {
    schemaVersion: 1,
    revision: 1,
    agents: [
      declaredAgent('coordinator-sol', 'Coordinator Sol', 'controller', 'none'),
      declaredAgent('codex-manager-seat-1', 'Manager seat 1', 'manager', 'codex'),
      declaredAgent('codex-manager-seat-2', 'Manager seat 2', 'manager', 'codex'),
    ],
    relationships: [
      { from: 'coordinator-sol', to: 'codex-manager-seat-1', type: 'manages' },
      { from: 'coordinator-sol', to: 'codex-manager-seat-2', type: 'manages' },
      { from: 'coordinator-sol', to: 'codex-manager-seat-2', type: 'delegates_to' },
    ],
  }
  write(join(canonical, 'config', 'agent-org.json'), JSON.stringify(org))
  write(join(canonical, 'state', 'agent-presence.json'), JSON.stringify({
    schemaVersion: 1,
    revision: 7,
    updatedAt: 1_786_000_999_000,
    agents: {
      'codex-manager-seat-1': presenceRecord({
        agentId: 'codex-manager-seat-1',
        dispatcher: 'coordinator-sol',
        reportsTo: 'coordinator-sol',
        startedAt: 1_786_000_111_000,
        runId: 'aaaaaaaa-bbbb-1111',
      }),
      'codex-manager-seat-2': presenceRecord({
        agentId: 'codex-manager-seat-2',
        dispatcher: 'owner',
        reportsTo: 'coordinator-sol',
        startedAt: 1_786_000_222_000,
        runId: 'aaaaaaaa-bbbb-2222',
        status: 'finished',
        terminalAt: 1_786_000_333_000,
      }),
    },
  }))
  write(join(canonical, 'src', 'lib', 'state-store.js'), `
const rows = { succeeded: ['s1'], failed: ['f1'], uncertain: ['u1'], cancelled: ['c1', 'c2'] };
const agents = { s1: 'codex-manager-seat-2', f1: 'codex-manager-seat-2', u1: 'codex-manager-seat-2', c1: 'codex-manager-seat-2', c2: 'codex-manager-seat-1' };
module.exports = {
  DEFAULT_STATE_PATH: 'fixture.sqlite3',
  createStateStore() {
    return {
      listTasks({ status }) { return (rows[status] || []).map(id => ({ id, type: 'codex-agent-lane' })); },
      getTask({ taskId }) { return { payload: { context: JSON.stringify({ agentId: agents[taskId], secret: '${SENSITIVE_MARKER}' }) }, result: '${SENSITIVE_MARKER}', error: '${SENSITIVE_MARKER}', claimToken: '${SENSITIVE_MARKER}' }; },
      close() {}
    };
  }
};
`)
  liveFixture(live)

  for (const domain of ['fleet', 'agents']) {
    const run = runGenerator(domain, canonical, live, output)
    assert.equal(run.status, 0, `${domain}: ${run.stderr}`)
  }
  const fleet = JSON.parse(readFileSync(join(output, 'fleet.json'), 'utf8'))
  const agents = JSON.parse(readFileSync(join(output, 'agents.json'), 'utf8'))
  assert.ok(fleet.data?.graph, `fleet generator exited zero without a graph: ${JSON.stringify(fleet)}`)
  assert.ok(Array.isArray(agents.data?.declared), `agents generator exited zero without declared nodes: ${JSON.stringify(agents)}`)
  const fleetSeat1 = fleet.data.graph.nodes.find(node => node.id === 'codex-manager-seat-1')
  const fleetSeat2 = fleet.data.graph.nodes.find(node => node.id === 'codex-manager-seat-2')
  const agentSeat1 = agents.data.declared.find(node => node.id === 'codex-manager-seat-1')
  const agentSeat2 = agents.data.declared.find(node => node.id === 'codex-manager-seat-2')

  for (const node of [fleetSeat2, agentSeat2]) {
    assert.equal(node.bornAt, 1_786_000_222_000)
    assert.equal(node.stoppedAt, 1_786_000_333_000)
    assert.equal(node.origin, 'user')
    assert.equal(node.tasksDone, 4)
    assert.equal(node.failRate, 66.7)
    assert.equal(node.enabled, true)
  }
  for (const node of [fleetSeat1, agentSeat1]) {
    assert.equal(node.bornAt, 1_786_000_111_000)
    assert.equal(Object.hasOwn(node, 'stoppedAt'), false)
    assert.equal(node.origin, 'self')
    assert.equal(node.tasksDone, 1)
    assert.equal(Object.hasOwn(node, 'failRate'), false)
  }

  for (const relationships of [fleet.data.graph.edges, agents.data.relationships]) {
    const seat2 = relationships.filter(edge => edge.from === 'coordinator-sol'
      && edge.to === 'codex-manager-seat-2' && edge.type === 'delegates_to')
    assert.deepEqual(seat2, [{ from: 'coordinator-sol', to: 'codex-manager-seat-2', type: 'delegates_to', sourceKind: 'declared' }])
    assert.ok(relationships.some(edge => edge.from === 'coordinator-sol'
      && edge.to === 'codex-manager-seat-1' && edge.type === 'delegates_to' && edge.sourceKind === 'observed'))
  }
  assert.equal(JSON.stringify({ fleet, agents }).includes(SENSITIVE_MARKER), false)
})
