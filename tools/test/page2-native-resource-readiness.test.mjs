import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createResourceAdmission, normalizeSettings } = require('../../capability/src/lib/agent-resource-admission.js')
const { waitForResourceAdmission, waitForNativeResourceReady } = require('../lib/page2-native-resource-readiness.cjs')
const GIB = 1024 ** 3

// The actual packed admission implementation decides every verdict below.
// Only clock/physical samples and the surrounding IPC envelope are synthetic.
function fixture({ settings: initial = {}, cpu = [20, 25, 22], freshEachRead = true } = {}) {
  let clock = 10000, samples = 0, settings = normalizeSettings(initial)
  const governor = createResourceAdmission({ now: () => clock, settings: () => settings })
  const observations = [], requests = []
  const read = () => {
    requests.push({ provider: 'codex' })
    if (freshEachRead || samples === 0) {
      governor.recordSample({ atMs: clock, cpuPercent: cpu[Math.min(samples, cpu.length - 1)],
        freeBytes: 16 * GIB, totalBytes: 32 * GIB, logicalProcessors: 16, loopLagMs: 0 })
      samples++
    }
    const snapshot = governor.snapshot()
    return { ok: true, ...snapshot, bootId: 'synthetic-resource-monitor', sampleId: `synthetic-resource-monitor:${snapshot.atMs}`,
      admission: governor.inspect({ provider: 'codex' }) }
  }
  return { governor, observations, requests, read,
    options: { read, record: async value => { observations.push(value) }, now: () => clock,
      sleep: async milliseconds => { clock += milliseconds }, timeoutMs: 5000, pollMs: 1000 },
    advance(milliseconds) { clock += milliseconds },
    policy(value) { settings = normalizeSettings(value) },
  }
}

test('actual warming admission becomes ready only after three fresh spanning samples with no reservation or policy write', async () => {
  const f = fixture()
  const result = await waitForResourceAdmission(f.options)
  assert.equal(result.attempts, 3)
  assert.equal(result.elapsedMs, 2000)
  assert.deepEqual(f.observations.map(row => row.snapshot.admission.code || 'allowed'),
    ['AGENT_RESOURCE_WARMING', 'AGENT_RESOURCE_WARMING', 'allowed'])
  assert.deepEqual(f.observations.map(row => row.snapshot.atMs), [10000, 11000, 12000])
  assert.equal(result.snapshot.admission.ok, true)
  assert.equal(result.snapshot.readyWindow, true)
  assert.equal(result.snapshot.settings.reserveBytes, 2 * GIB)
  assert.equal(result.snapshot.settings.providerBytes.codex, GIB)
  assert.equal(f.governor.snapshot().starting, 0)
  assert.equal(f.governor.snapshot().reservedBytes, 0)
  assert.deepEqual(f.requests, Array.from({ length: 3 }, () => ({ provider: 'codex' })))
})

test('near-capacity fluctuations remain warming until the actual production window becomes stable', async () => {
  const f = fixture({ cpu: [65, 86, 73, 74, 75] })
  const result = await waitForResourceAdmission({ ...f.options, timeoutMs: 7000 })
  assert.equal(result.attempts, 5)
  assert.equal(f.observations[2].snapshot.readyWindow, true)
  assert.equal(f.observations[2].snapshot.admission.code, 'AGENT_RESOURCE_WARMING')
  assert.match(f.observations[2].snapshot.admission.reason, /near capacity.*fluctuating/)
  assert.equal(result.snapshot.headroomWindow, true)
  assert.equal(f.governor.snapshot().reservedBytes, 0)
})

test('a persistent actual refusal reaches its deadline without any visible Start input', async () => {
  const f = fixture({ freshEachRead: false })
  let presses = 0
  await assert.rejects(async () => {
    await waitForResourceAdmission({ ...f.options, timeoutMs: 3000 })
    presses++
  }, /AGENT_RESOURCE_WARMING.*three fresh resource samples/)
  assert.equal(presses, 0)
  assert.equal(f.observations.length, 3)
  assert.equal(f.governor.snapshot().starting, 0)
  assert.equal(f.governor.snapshot().reservedBytes, 0)
})

test('an allowed observation is not a debit and cannot override a later actual provider-root refusal', async () => {
  const f = fixture()
  await waitForResourceAdmission(f.options)
  const grant = f.governor.reserve({ provider: 'codex' })
  assert.equal(grant.ok, true)
  f.advance(1000)
  f.governor.recordSample({ atMs: 13000, cpuPercent: 99, freeBytes: 16 * GIB, totalBytes: 32 * GIB, loopLagMs: 0 })
  assert.equal(f.governor.revalidate(grant.token).code, 'AGENT_RESOURCE_PRESSURE')
  assert.equal(f.governor.snapshot().starting, 1)
  f.governor.release(grant.token)
})

for (const [name, initial, code] of [
  ['low physical memory', { reserveBytes: 16 * GIB }, 'AGENT_MEMORY_LOW'],
  ['absent controller advice', { mode: 'controller' }, 'AGENT_RESOURCE_CONTROLLER_UNKNOWN'],
]) test(`actual ${name} cannot be replaced by a ready-window-only decision`, async () => {
  const f = fixture({ settings: initial })
  await assert.rejects(waitForResourceAdmission(f.options), new RegExp(code))
  assert.equal(f.observations.at(-1).snapshot.readyWindow, true)
  assert.equal(f.observations.at(-1).snapshot.admission.ok, false)
  assert.equal(f.governor.snapshot().reservedBytes, 0)
})

for (const [name, mutate] of [
  ['monitor identity changes', (_f, snapshot) => { snapshot.bootId = 'different-monitor' }],
  ['policy switches off', f => { f.policy({ mode: 'off' }) }],
  ['memory reserve is reduced', f => { f.policy({ reserveBytes: GIB }) }],
]) test(`waiting refuses when ${name} instead of accepting a newly easier policy`, async () => {
  const f = fixture()
  let reads = 0
  const read = () => {
    if (++reads === 2 && name !== 'monitor identity changes') mutate(f)
    const snapshot = f.read()
    if (reads === 2 && name === 'monitor identity changes') mutate(f, snapshot)
    return snapshot
  }
  await assert.rejects(waitForResourceAdmission({ ...f.options, read }), /monitor and resource policy must remain unchanged/)
  assert.equal(f.observations.length, 2)
  assert.equal(f.governor.snapshot().reservedBytes, 0)
})

for (const [name, mutate] of [
  ['missing host', value => { value.ok = false }],
  ['missing admission', value => { delete value.admission }],
  ['truthy nonboolean admission', value => { value.admission.ok = 'yes' }],
  ['privileged admission mode', value => { value.admission.state.mode = 'off' }],
  ['different admission policy', value => { value.admission.state.settings = { mode: 'off' } }],
]) test(`the read-only wait refuses ${name}`, async () => {
  const f = fixture()
  await assert.rejects(waitForResourceAdmission({ ...f.options, read: () => {
    const value = structuredClone(f.read()); mutate(value); return value
  } }))
  assert.equal(f.observations.length, 1)
})

test('a hanging or throwing read is bounded and retained without any input retry', async () => {
  for (const read of [() => new Promise(() => {}), () => { throw Error('synthetic resource IPC failure') }]) {
    const observations = []
    await assert.rejects(waitForResourceAdmission({ read, record: async row => { observations.push(row) }, readTimeoutMs: 5 }),
      /bounded deadline|synthetic resource IPC failure/)
    assert.equal(observations.length, 1)
    assert.equal(observations[0].attempt, 1)
    assert.equal(typeof observations[0].error, 'string')
  }
})

test('an otherwise allowed read arriving after the bounded deadline cannot authorize native input', async () => {
  const f = fixture({ settings: { mode: 'off' } })
  await assert.rejects(waitForResourceAdmission({ ...f.options, read: () => {
    const value = f.read(); f.advance(6000); return value
  } }), /deadline expired before native input/)
})

test('the native adapter invokes only the actual status reader and retains its response in nested steps', async () => {
  const f = fixture()
  f.read(); f.advance(1000); f.read(); f.advance(1000)
  const steps = [], calls = []
  const context = {
    page: { evaluate: callback => vm.runInNewContext(`(${callback.toString()})()`, {
      window: { mcResources: { status(request) { calls.push(JSON.parse(JSON.stringify(request))); return f.read() },
        configure() { throw Error('The native readiness helper must not write a resource policy') } } },
    }) },
    async step(id, action) { const value = await action(); steps.push({ id, value }); return value },
  }
  const result = await waitForNativeResourceReady(context, 'bounded-team-stop')
  assert.deepEqual(calls, [{ provider: 'codex' }])
  assert.deepEqual(steps.map(row => row.id), ['resource-read-bounded-team-stop-1', 'resource-ready-bounded-team-stop'])
  assert.equal(steps[0].value.snapshot.admission.ok, true)
  assert.equal(result.snapshot.sampleId, 'synthetic-resource-monitor:12000')
  assert.equal(f.governor.snapshot().reservedBytes, 0)
})

test('the five bounded Start inputs each follow their own readiness observation without changing existing gestures', () => {
  const source = fs.readFileSync(new URL('../lib/page2-native-bounded-scenarios.cjs', import.meta.url), 'utf8')
  for (const [id, selector, gesture] of [
    ['bounded-launch-stop', 'data-launch="dispatch"', 'dblclick'],
    ['bounded-team-stop', 'data-team="go"', 'click'],
    ['bounded-loop-navigation-stop', 'data-loop="go"', 'click'],
    ['bounded-cap-cleanup', 'data-launch="dispatch"', 'click'],
    ['bounded-parent-stop-cleanup', 'data-team="go"', 'click'],
  ]) {
    assert.ok(source.includes(`await waitForNativeResourceReady(context, '${id}')\n    await box.locator('[${selector}]').${gesture}()`), id)
  }
  assert.equal((source.match(/await waitForNativeResourceReady\(/g) || []).length, 5)
})
