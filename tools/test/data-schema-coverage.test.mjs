import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { validateAgainstSchema } from '../gen-projection-lib.mjs'

const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const CHECKER = join(PROJECT_ROOT, 'tools', 'check-data-schemas.mjs')
const REAL_DATA = join(PROJECT_ROOT, 'public', 'data')

function runChecker(directory) {
  return spawnSync(process.execPath, [CHECKER, directory], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  })
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'mc-data-schema-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('real public data is discovered and every file validates', () => {
  const run = runChecker(REAL_DATA)
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`)

  /* This asserted the literal "Discovered 9 ... validated 9" and went red the
     day a tenth data file was added, which is a maintenance tax rather than a
     finding. The two properties it was actually protecting are kept, and both
     are now derived rather than typed:

       1. every JSON file that EXISTS in public/data is discovered by the
          checker -- so a file that silently stops being scanned still fails
          here, which is the real guard;
       2. the count never drops below the nine that existed when this was
          written, and is never zero -- the checker's own "discovered nothing"
          failure mode, which a passing count of 0 would hide.

     A hardcoded total protected neither better; it only also failed on the
     legitimate case of adding a file with a schema beside it. */
  const present = readdirSync(REAL_DATA, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
  assert.ok(present.length >= 9, `public/data lost data files: ${present.length}`)
  assert.match(run.stdout, new RegExp(`Discovered ${present.length} JSON data files; validated ${present.length}\\.`))
})

/* The host, peer and repo values below are FIXTURES, not a captured machine.
   They were a real builder's LAN addresses and home-directory checkout, which
   is owner data sitting in a file that publishes; the shapes are what this
   test exercises, and the shapes are identical. Addresses are RFC 5737
   documentation range (192.0.2.0/24, matching the neutral ranges used in
   tools/test/no-owner-data.test.mjs) with the last octet preserved so local
   and peer stay distinguishable. Do not "restore" real values here. */
test('historical populated status output validates', () => {
  const statusSchema = JSON.parse(readFileSync(join(REAL_DATA, 'schema', 'status.schema.json'), 'utf8'))
  const populatedStatus = {
    schemaVersion: 1,
    generatedAt: '2026-08-04T15:45:03.011Z',
    generatedByHost: 'Machine A (192.0.2.2, retired compatibility host)',
    sourceRepo: 'C:/ToolsEnabled',
    health: {
      available: true,
      path: 'state/health-snapshot.json',
      observedAtMs: 1_785_805_283_686,
      observedAt: '2026-08-04T01:01:23.686Z',
      subsystems: [
        { id: 'dashboard', state: 'OK', reason: 'all four rungs verified' },
        { id: 'terra-02', state: 'OK', reason: 'all four rungs verified' },
        {
          id: 'fleet-supervisor',
          state: 'STOPPED',
          reason: 'stop sentinel state/fleet-supervisor.stop is present: this subsystem was stopped on purpose',
        },
        {
          id: 'sidecar-server',
          state: 'DOWN',
          reason: 'pid 9884 from state/sidecar-server.pid.lock is not running (stale lock)',
        },
        {
          id: 'agent-digest',
          state: 'DOWN',
          reason: "scheduled task 'ToolsEnabled Agent Digest' is 'Disabled', not Running",
        },
        {
          id: 'uac-delegation-helper',
          state: 'UNKNOWN',
          reason: "not verifiable: alive (On-demand by design: this helper is started per elevated request and exits immediately afterward, so 'not running' is its correct steady state and a liveness probe would report a false alarm on every sweep.); functioning (Exercising this rung would require performing a real elevated operation on every health sweep, which is a far worse idea than accepting a declared blind spot; its failures surface through the audited client call instead.)",
        },
        {
          id: 'health-observer',
          state: 'DOWN',
          reason: 'pid 43732 from state/health-observer.pid.lock is not running (stale lock)',
        },
        {
          id: 'coordinator-duty-host',
          state: 'DOWN',
          reason: 'pid 21576 from state/coordinator-duty-host.pid.lock is not running (stale lock)',
        },
        {
          id: 'owner-host',
          state: 'DOWN',
          reason: 'named pipe ToolsEnabled.OwnerHost.V1 is absent: the owner host is not listening',
        },
        {
          id: 'tunnel-bridge-keeper',
          state: 'DOWN',
          reason: "scheduled task 'ToolsEnabled Tunnel Bridge Keeper' is NOT registered, so the OS cannot start or restart this subsystem",
        },
        {
          id: 'fra-keeper',
          state: 'DOWN',
          reason: "scheduled task 'ToolsEnabled FRA Keeper' is NOT registered, so the OS cannot start or restart this subsystem",
        },
      ],
      counts: { OK: 2, DOWN: 7, STOPPED: 1, UNKNOWN: 1, OTHER: 0 },
      total: 11,
    },
    peerLink: {
      outbound: {
        available: true,
        path: 'state/full-remote-access-peer-liveness.json',
        authenticatedAt: '2026-08-04T15:42:30.660Z',
        authenticatedAtMs: 1_785_858_150_660,
        localHost: '192.0.2.2',
        peerHost: '192.0.2.1',
      },
      inbound: {
        available: true,
        path: 'state/full-remote-access-inbound-liveness.json',
        authenticatedAt: '2026-08-04T15:43:09.962Z',
        authenticatedAtMs: 1_785_858_189_962,
        localHost: '192.0.2.2',
        peerHost: '192.0.2.1',
      },
    },
    recentLanes: {
      available: true,
      path: 'state/agent-churn-ledger.jsonl',
      items: [
        { event: 'lane-end', laneId: 'ONESHOT-OPERATOR', model: 'gpt-5.6-sol', outcome: 'completed', exitCode: 0, durationMs: 625467, at: '2026-08-04T06:29:39.611Z', atMs: 1_785_824_979_611 },
        { event: 'lane-start', laneId: 'ONESHOT-OPERATOR', model: 'gpt-5.6-sol', outcome: null, exitCode: null, durationMs: null, at: '2026-08-04T06:19:14.143Z', atMs: 1_785_824_354_143 },
        { event: 'lane-end', laneId: 'DIRECTIVE-RELAY-3', model: 'gpt-5.6-sol', outcome: 'completed', exitCode: 0, durationMs: 1867149, at: '2026-08-04T04:28:58.723Z', atMs: 1_785_817_738_723 },
        { event: 'lane-start', laneId: 'DIRECTIVE-RELAY-3', model: 'gpt-5.6-sol', outcome: null, exitCode: null, durationMs: null, at: '2026-08-04T03:57:51.574Z', atMs: 1_785_815_871_574 },
        { event: 'lane-end', laneId: 'QUEUE-BACKFILL', model: 'gpt-5.6-sol', outcome: 'completed', exitCode: 0, durationMs: 1471009, at: '2026-08-04T01:11:08.668Z', atMs: 1_785_805_868_668 },
        { event: 'lane-end', laneId: 'DIRECTIVE-RELAY-2', model: 'gpt-5.6-sol', outcome: 'completed', exitCode: 0, durationMs: 385574, at: '2026-08-04T00:51:25.280Z', atMs: 1_785_804_685_280 },
        { event: 'lane-start', laneId: 'QUEUE-BACKFILL', model: 'gpt-5.6-sol', outcome: null, exitCode: null, durationMs: null, at: '2026-08-04T00:46:37.659Z', atMs: 1_785_804_397_659 },
        { event: 'lane-start', laneId: 'DIRECTIVE-RELAY-2', model: 'gpt-5.6-sol', outcome: null, exitCode: null, durationMs: null, at: '2026-08-04T00:44:59.706Z', atMs: 1_785_804_299_706 },
        { event: 'lane-start', laneId: 'DIRECTIVE-RELAY', model: 'gpt-5.6-sol', outcome: null, exitCode: null, durationMs: null, at: '2026-08-04T00:44:04.913Z', atMs: 1_785_804_244_913 },
        { event: 'lane-end', laneId: 'FABRIC-WIRE', model: 'gpt-5.6-sol', outcome: 'completed', exitCode: 0, durationMs: 1810590, at: '2026-08-04T00:00:28.265Z', atMs: 1_785_801_628_265 },
        { event: 'lane-start', laneId: 'FABRIC-WIRE', model: 'gpt-5.6-sol', outcome: null, exitCode: null, durationMs: null, at: '2026-08-03T23:30:17.675Z', atMs: 1_785_799_817_675 },
        { event: 'lane-end', laneId: 'SIDECAR-BRINGUP', model: 'gpt-5.6-sol', outcome: 'completed', exitCode: 0, durationMs: 706145, at: '2026-08-03T22:25:37.584Z', atMs: 1_785_795_937_584 },
      ],
    },
    hostUptime: {
      available: true,
      seconds: 382680.625,
      hostLabel: 'Machine A (192.0.2.2, retired compatibility host)',
    },
  }
  assert.equal(populatedStatus.health.subsystems[5].reason.length, 466)
  assert.deepEqual(validateAgainstSchema(populatedStatus, statusSchema), [])
})

test('a discovered data file without a matching schema fails by name', t => {
  const directory = fixture(t)
  writeFileSync(join(directory, 'uncovered.json'), '{"schemaVersion":1}\n')

  const run = runChecker(directory)
  assert.notEqual(run.status, 0, run.stdout)
  assert.match(`${run.stdout}\n${run.stderr}`, /uncovered\.json/)
  assert.match(run.stdout, /Discovered 1 JSON data files; validated 0\./)
})

test('schema-invalid data fails by name', t => {
  const directory = fixture(t)
  mkdirSync(join(directory, 'schema'))
  writeFileSync(join(directory, 'invalid.json'), '{"schemaVersion":2}\n')
  writeFileSync(join(directory, 'schema', 'invalid.schema.json'), JSON.stringify({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    required: ['schemaVersion'],
    properties: { schemaVersion: { const: 1 } },
  }))

  const run = runChecker(directory)
  assert.notEqual(run.status, 0, run.stdout)
  assert.match(`${run.stdout}\n${run.stderr}`, /invalid\.json/)
  assert.match(`${run.stdout}\n${run.stderr}`, /schema validation failed/)
})

test('an empty data directory fails instead of silently passing', t => {
  const directory = fixture(t)
  const run = runChecker(directory)
  assert.notEqual(run.status, 0, run.stdout)
  assert.match(run.stderr, /zero JSON data files/i)
})

test('a missing data directory fails', t => {
  const directory = fixture(t)
  const missing = join(directory, 'does-not-exist')
  const run = runChecker(missing)
  assert.notEqual(run.status, 0, run.stdout)
  assert.match(run.stderr, /missing or unreadable/i)
})
