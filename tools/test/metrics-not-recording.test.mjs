// B3 residual (found by hand on 1.0.46, 2026-09-25): on a Linux session with no usable keyring,
// Electron safeStorage falls back to basic_text, the signing key for the run and usage records
// cannot be protected, and nothing is written. While audit is optional the agents still run, so
// Metrics sat empty and told the person to start an agent to fill it. The host now says whether it
// can record, and the empty readings name the real cause and its remedy.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { readLocalSessions } from '../../src/local-activity.js'
import { LOCAL_METRICS_COPY, LOCAL_USAGE_COPY, describeLocalMetrics, describeLocalUsage, readLocalUsage } from '../../src/local-metrics.js'

const main = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
const cannot = { ok: false, code: 'SPAWN_RECORD_KEYSTORE_UNAVAILABLE' }
const absences = value => JSON.stringify(value)

test('the host reports whether it can record, from the keystore, on both reads', () => {
  const start = main.indexOf('function recordingStatus()')
  const source = main.slice(start, main.indexOf('\n}\n', start) + 2)
  for (const [available, expected] of [[true, { ok: true }], [false, cannot]]) {
    const sandbox = { safeStorage: { isEncryptionAvailable: () => available } }
    vm.runInNewContext(source + '\nthis.status = recordingStatus()', sandbox)
    assert.deepEqual({ ...sandbox.status }, expected)
  }
  const throwing = { safeStorage: { isEncryptionAvailable: () => { throw new Error('no keystore') } } }
  vm.runInNewContext(source + '\nthis.status = recordingStatus()', throwing)
  assert.deepEqual({ ...throwing.status }, cannot, 'a keystore that cannot answer cannot protect a key either')
  for (const name of ['spawnRecordHistory', 'usageRecordHistory']) {
    const at = main.indexOf(`async function ${name}(`)
    const body = main.slice(at, main.indexOf('\n}\n', at))
    assert.match(body, /return result\?\.ok === true \? \{ \.\.\.result, recording: recordingStatus\(\) \} : result/, `${name} carries the answer`)
  }
})

test('an empty run record on a computer that cannot record names the cause, not "start an agent"', () => {
  const sessions = readLocalSessions({ ok: true, entries: [], recording: cannot })
  assert.deepEqual({ ...sessions.recording }, cannot)
  assert.ok(absences(describeLocalMetrics(sessions)).includes(LOCAL_METRICS_COPY.notRecording))
  assert.ok(!absences(describeLocalMetrics(sessions)).includes(LOCAL_METRICS_COPY.empty))
  for (const raw of [{ ok: true, entries: [] }, { ok: true, entries: [], recording: { ok: true } }]) {
    const ordinary = readLocalSessions(raw)
    assert.equal(ordinary.recording, null, 'an older host, or one that can record, is not read as "cannot"')
    assert.ok(absences(describeLocalMetrics(ordinary)).includes(LOCAL_METRICS_COPY.empty))
  }
  assert.equal(readLocalSessions({ ok: true, entries: [], recording: { ok: false, code: 'lower case' } }).recording, null,
    'only a bare code crosses')
})

test('an empty usage record on a computer that cannot record says the same', async () => {
  const usage = await readLocalUsage({ agent: { usage: async () => ({ ok: true, entries: [], recording: cannot }) } })
  assert.deepEqual({ ...usage.recording }, cannot)
  assert.ok(absences(describeLocalUsage(usage)).includes(LOCAL_USAGE_COPY.notRecording))
  const ordinary = await readLocalUsage({ agent: { usage: async () => ({ ok: true, entries: [] }) } })
  assert.ok(absences(describeLocalUsage(ordinary)).includes(LOCAL_USAGE_COPY.empty))
})
