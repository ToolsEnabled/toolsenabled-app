import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_TASK_STALENESS_HOURS,
  MAX_TASK_STALENESS_HOURS,
  MIN_TASK_STALENESS_HOURS,
  TASK_STALENESS_HOURS_KEY,
  deriveTaskStaleness,
  readTaskStalenessHours,
  taskActivityAt,
  writeTaskStalenessHours,
} from '../../src/task-staleness.js'
import { rowOf } from '../../src/ledger-live.js'

const NOW = Date.parse('2026-09-23T12:00:00.000Z')
const HOUR = 60 * 60 * 1000

function memory(initial = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null },
    setItem(key, value) { values.set(key, String(value)) },
    removeItem(key) { values.delete(key) },
  }
}

function task(extra = {}) {
  return {
    id: 'T1632',
    kind: 'T',
    status: 'in-progress',
    filedAt: '2026-09-22T12:00:00.000Z',
    decisions: [],
    history: [],
    ...extra,
  }
}

test('the task inactivity preference defaults to 24 hours and has a bounded key', () => {
  const result = readTaskStalenessHours(memory())

  assert.equal(TASK_STALENESS_HOURS_KEY, 'mc.ledger.task-staleness-hours')
  assert.equal(DEFAULT_TASK_STALENESS_HOURS, 24)
  assert.equal(MIN_TASK_STALENESS_HOURS, 1)
  assert.equal(MAX_TASK_STALENESS_HOURS, 8760)
  assert.deepEqual(result, {
    ok: true,
    confirmed: true,
    hours: 24,
    source: 'default',
    reason: null,
  })
})

test('valid whole-hour preferences persist only after a matching readback', () => {
  const storage = memory()

  assert.deepEqual(writeTaskStalenessHours(48, storage), {
    ok: true,
    confirmed: true,
    hours: 48,
    reason: null,
  })
  assert.equal(storage.getItem(TASK_STALENESS_HOURS_KEY), '48')
  assert.equal(readTaskStalenessHours(storage).hours, 48)
})

test('invalid or unavailable preference state is explicit and does not become a default', () => {
  const malformed = readTaskStalenessHours(memory({ [TASK_STALENESS_HOURS_KEY]: '24.5' }))
  assert.equal(malformed.ok, false)
  assert.equal(malformed.confirmed, false)
  assert.equal(malformed.hours, null)
  assert.equal(malformed.source, 'invalid')

  const unavailable = readTaskStalenessHours({ getItem() { throw new Error('storage refused') } })
  assert.equal(unavailable.ok, false)
  assert.equal(unavailable.confirmed, false)
  assert.equal(unavailable.hours, null)
  assert.equal(unavailable.source, 'unavailable')

  for (const value of [0, -1, 1.5, 8761, '48', null]) {
    const result = writeTaskStalenessHours(value, memory())
    assert.equal(result.ok, false, `invalid preference ${String(value)} is refused`)
    assert.equal(result.confirmed, false)
  }

  const discarded = memory()
  discarded.setItem = () => {}
  assert.equal(writeTaskStalenessHours(24, discarded).ok, false, 'a discarded default-valued write is not confirmed')
  assert.equal(readTaskStalenessHours(discarded).source, 'default')

  const unreadable = {
    getItem() { throw new Error('readback refused') },
    setItem() {},
  }
  assert.equal(writeTaskStalenessHours(48, unreadable).ok, false, 'an unreadable write is not confirmed')

  const concurrent = new Map([[TASK_STALENESS_HOURS_KEY, '24']])
  const replaced = {
    getItem(key) { return concurrent.has(key) ? concurrent.get(key) : null },
    setItem(key, value) {
      concurrent.set(key, String(value))
      if (String(value) === '48') concurrent.set(key, '72')
    },
    removeItem(key) { concurrent.delete(key) },
  }
  assert.equal(writeTaskStalenessHours(48, replaced).ok, false, 'a concurrent replacement is not confirmed')
  assert.equal(concurrent.get(TASK_STALENESS_HOURS_KEY), '72', 'a newer concurrent setting is never rolled back')

  const uncertainValues = new Map([[TASK_STALENESS_HOURS_KEY, '24']])
  const uncertain = {
    getItem(key) { return uncertainValues.has(key) ? uncertainValues.get(key) : null },
    setItem(key, value) {
      uncertainValues.set(key, String(value))
      throw new Error('write result uncertain')
    },
    removeItem(key) { uncertainValues.delete(key) },
  }
  assert.equal(writeTaskStalenessHours(72, uncertain).ok, false, 'an uncertain write is not confirmed')
  assert.equal(uncertainValues.get(TASK_STALENESS_HOURS_KEY), '72', 'an uncertain write is not destructively cleaned up')
})

test('all active task statuses use inactivity regardless of owner liveness', () => {
  for (const status of ['open', 'in-progress', 'blocked-external', 'recurring']) {
    const result = deriveTaskStaleness(task({ status, ownerId: 'live-owner' }), { hours: 24, now: NOW })
    assert.equal(result.stale, true, `${status} is stale when its activity is old`)
    assert.equal(result.reason, 'inactive')
  }
  assert.equal(deriveTaskStaleness(task({ ownerId: null }), { hours: 24, now: NOW }).stale, true)
})

test('task inactivity flags exactly at the configured boundary and keeps recent activity fresh', () => {
  const result = deriveTaskStaleness(task({ ownerId: 'live-owner' }), { hours: 24, now: NOW })

  assert.equal(result.lastActivityAt, '2026-09-22T12:00:00.000Z')
  assert.equal(result.thresholdMs, 24 * HOUR)
  assert.equal(result.stale, true)

  const recent = deriveTaskStaleness(task({ filedAt: '2026-09-22T12:00:00.001Z' }), { hours: 24, now: NOW })
  assert.equal(recent.stale, false)
  assert.equal(recent.reason, 'recent')
})

test('the latest decision or history activity keeps an active task fresh', () => {
  const decision = deriveTaskStaleness(task({
    filedAt: '2026-09-01T12:00:00.000Z',
    decisions: [{ at: '2026-09-23T11:59:00.000Z', decision: 'progress' }],
  }), { hours: 24, now: NOW })
  assert.equal(decision.stale, false)
  assert.equal(decision.lastActivityAt, '2026-09-23T11:59:00.000Z')

  const history = deriveTaskStaleness(task({
    filedAt: '2026-09-01T12:00:00.000Z',
    history: [{ kind: 'progress', at: '2026-09-23T11:00:00.000Z' }],
  }), { hours: 24, now: NOW })
  assert.equal(history.stale, false)
  assert.equal(history.lastActivityAt, '2026-09-23T11:00:00.000Z')
  const projected = deriveTaskStaleness(task({
    filedAt: '2026-09-01T12:00:00.000Z',
    decisions: 1,
    decisionHistory: [{ at: '2026-09-23T10:30:00.000Z' }],
  }), { hours: 24, now: NOW })
  assert.equal(projected.stale, false)
  assert.equal(projected.lastActivityAt, '2026-09-23T10:30:00.000Z')
  assert.equal(taskActivityAt(task({ filedAt: 'not-a-date' })), null)
})

test('the canonical numeric decision projection requires an authoritative latest timestamp', () => {
  const projected = deriveTaskStaleness(task({
    filedAt: '2026-09-01T12:00:00.000Z',
    decisions: 2,
    latestDecision: { decision: 'progress', at: '2026-09-23T11:59:00.000Z' },
  }), { hours: 24, now: NOW })
  assert.equal(projected.stale, false)
  assert.equal(projected.lastActivityAt, '2026-09-23T11:59:00.000Z')

  const missingLatest = deriveTaskStaleness(task({
    filedAt: '2026-09-01T12:00:00.000Z',
    decisions: 2,
    latestDecision: null,
  }), { hours: 24, now: NOW })
  assert.equal(missingLatest.stale, null)
  assert.equal(missingLatest.reason, 'unknown-time')

  const malformedLatest = deriveTaskStaleness(task({
    filedAt: '2026-09-01T12:00:00.000Z',
    decisions: 2,
    latestDecision: { decision: 'progress', at: 'not-a-date' },
  }), { hours: 24, now: NOW })
  assert.equal(malformedLatest.stale, null)
  assert.equal(malformedLatest.reason, 'unknown-time')

  const completeProjection = deriveTaskStaleness(task({
    filedAt: '2026-09-01T12:00:00.000Z',
    decisions: 2,
    decisionHistory: [
      { at: '2026-09-23T10:00:00.000Z' },
      { at: '2026-09-23T11:59:00.000Z' },
    ],
    latestDecision: null,
  }), { hours: 24, now: NOW })
  assert.equal(completeProjection.stale, false)
  assert.equal(completeProjection.lastActivityAt, '2026-09-23T11:59:00.000Z')

  const mismatchedProjection = deriveTaskStaleness(task({
    filedAt: '2026-09-01T12:00:00.000Z',
    decisions: 2,
    decisionHistory: [{ at: '2026-09-23T11:59:00.000Z' }],
    latestDecision: null,
  }), { hours: 24, now: NOW })
  assert.equal(mismatchedProjection.stale, null)
  assert.equal(mismatchedProjection.reason, 'unknown-time')
})

test('the live projection keeps numeric decision consumers and journal times separately', () => {
  const row = rowOf({
    id: 'T1632',
    kind: 'T',
    status: 'in-progress',
    filedAt: '2026-09-21T12:00:00.000Z',
    decisions: [
      { decision: 'progress', at: '2026-09-23T11:00:00.000Z' },
      { decision: 'note', at: '2026-09-23T11:30:00.000Z' },
    ],
    history: [{ seq: 4, kind: 'progress', at: '2026-09-23T11:45:00.000Z', actor: 'builder' }],
  })

  assert.equal(row.decisions, 2)
  assert.deepEqual(row.decisionHistory, [
    { at: '2026-09-23T11:00:00.000Z' },
    { at: '2026-09-23T11:30:00.000Z' },
  ])
  assert.deepEqual(row.history, [{ seq: 4, kind: 'progress', at: '2026-09-23T11:45:00.000Z', actor: 'builder' }])

  const projected = rowOf({
    id: 'T1632',
    kind: 'T',
    status: 'in-progress',
    filedAt: '2026-09-01T12:00:00.000Z',
    decisions: 2,
    latestDecision: { decision: 'progress', at: 'not-a-date' },
  })
  assert.equal(projected.decisions, 2)
  assert.deepEqual(projected.decisionHistory, [])
  assert.equal(projected.latestDecision.at, 'not-a-date')
  assert.equal(deriveTaskStaleness(projected, { hours: 24, now: NOW }).stale, null)
})

test('malformed or unknown times, other kinds, and terminal tasks omit the marker', () => {
  for (const record of [
    task({ filedAt: 'not-a-date' }),
    task({ filedAt: null, history: [] }),
    task({ history: { at: '2026-09-23T11:00:00.000Z' } }),
    task({ status: 'done' }),
    task({ status: 'superseded' }),
    task({ status: 'removed', removedAt: '2026-09-22T00:00:00.000Z' }),
    task({ status: 'declined' }),
    task({ status: 'not-possible-as-asked' }),
    task({ kind: 'R' }),
    task({ status: 'unknown' }),
  ]) {
    const result = deriveTaskStaleness(record, { hours: 24, now: NOW })
    assert.equal(result.stale, null, `no stale marker for ${record.kind}/${record.status}`)
    assert.ok(['unknown-time', 'terminal', 'not-task', 'unknown-status'].includes(result.reason))
  }
})

test('invalid threshold cannot produce a stale claim', () => {
  const result = deriveTaskStaleness(task(), { hours: 0, now: NOW })

  assert.equal(result.stale, null)
  assert.equal(result.reason, 'unknown-threshold')
})
