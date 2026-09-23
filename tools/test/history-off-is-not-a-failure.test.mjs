/* AUDITING OFF IS A NORMAL STATE, NOT A READ FAILURE (owner direction
 * 2026-09-20, T782; BUG-08-BASIC-HISTORY-SHOWN-BROKEN.md). With the signed
 * audit off -- the Basic default -- the host answers history and usage reads
 * with { ok: false, code: 'AUDIT_NOT_ENABLED', reason: 'Activity auditing is
 * off; saved history is preserved.' } (shell/main.cjs). Before this, every
 * reader folded that into "the record could not be read": Metrics said
 * ToolsEnabled could not open its own record, Computers said the count was
 * unavailable, Home said the record could not be read. These cases drive the
 * ACTUAL readers and projections with that answer and with a real failure
 * beside it, and hold the two apart.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

import { declaredFunctionSource } from './lib/declared-function-source.mjs'
import { readLocalSessions, historyDisabled, HISTORY_DISABLED_CODE, describeHome, readAgentEngine } from '../../src/local-activity.js'
import { readLocalUsage, describeLocalMetrics, LOCAL_METRICS_COPY, LOCAL_USAGE_COPY, sourceLine } from '../../src/local-metrics.js'
import { readMetricsRecords } from '../../src/metrics-records.js'
import { metricsFooterStatus, METRICS_AUDIT_OFF_STATUS } from '../../src/metrics-footer-status.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '../../src')

/* The host's exact answer (shell/main.cjs, both history and usage handlers). */
const OFF = Object.freeze({ ok: false, code: 'AUDIT_NOT_ENABLED', reason: 'Activity auditing is off; saved history is preserved.' })
const BROKEN = Object.freeze({ ok: false, code: 'AUDIT_UNAVAILABLE', reason: 'The ledger could not be opened.' })

test('readLocalSessions keeps auditing-off apart from every other unreadable answer', () => {
  assert.equal(HISTORY_DISABLED_CODE, 'AUDIT_NOT_ENABLED')
  assert.equal(historyDisabled(OFF), true)
  for (const answer of [BROKEN, { ok: false }, { ok: true, code: 'AUDIT_NOT_ENABLED' }, null, undefined, 'AUDIT_NOT_ENABLED', { code: 'AUDIT_NOT_ENABLED' }]) {
    assert.equal(historyDisabled(answer), false, JSON.stringify(answer))
  }
  const off = readLocalSessions(OFF)
  assert.equal(off.supported, true)
  assert.equal(off.readable, false)
  assert.equal(off.disabled, true)
  assert.deepEqual([off.total, off.runs.length, off.started, off.refused, off.verified], [0, 0, null, null, null], 'nothing is invented about the record')
  const broken = readLocalSessions(BROKEN)
  assert.deepEqual([broken.supported, broken.readable, broken.disabled], [true, false, false], 'a real failure is still a failure')
  const none = readLocalSessions(undefined)
  assert.deepEqual([none.supported, none.readable, none.disabled], [false, false, false])
  const fine = readLocalSessions({ ok: true, total: 0, verified: true, entries: [] })
  assert.deepEqual([fine.readable, fine.disabled], [true, false])
})

test('readLocalUsage keeps auditing-off apart as well', async () => {
  const off = await readLocalUsage({ agent: { usage: async () => OFF } })
  assert.deepEqual([off.supported, off.readable, off.disabled, off.turns.length], [true, false, true, 0])
  const broken = await readLocalUsage({ agent: { usage: async () => BROKEN } })
  assert.deepEqual([broken.supported, broken.readable, broken.disabled], [true, false, false])
  const thrown = await readLocalUsage({ agent: { usage: async () => { throw new Error('no') } } })
  assert.deepEqual([thrown.readable, thrown.disabled], [false, false])
})

test('the Metrics projection says auditing is off, not that the record could not be opened; a real failure still says that', async () => {
  const window = { startMs: Date.UTC(2026, 7, 22), endMs: Date.UTC(2026, 8, 21) }
  const off = await readMetricsRecords({ agent: { history: async () => OFF, usage: async () => OFF }, window })
  assert.deepEqual(off.readErrors, { history: 'AUDIT_NOT_ENABLED', usage: 'AUDIT_NOT_ENABLED' }, 'the code travels through, not METRICS_READ_UNAVAILABLE')
  assert.equal(off.sessions.disabled, true)
  assert.equal(off.usage.disabled, true)
  const projected = describeLocalMetrics(off.sessions, { usage: off.usage })
  assert.equal(projected.source.ok, false)
  assert.equal(projected.source.absence, LOCAL_METRICS_COPY.disabled)
  assert.match(LOCAL_METRICS_COPY.disabled, /Activity auditing is off for new operations/)
  // Root narrowing 2026-09-21: the off read is not a whole-machine health
  // guarantee (already-admitted audited work may still finish recording), so
  // "Nothing is broken and nothing was lost" is gone; saved history is kept.
  assert.doesNotMatch(LOCAL_METRICS_COPY.disabled, /Nothing is broken and nothing was lost/)
  assert.match(LOCAL_METRICS_COPY.disabled, /Saved history is preserved/)
  assert.match(LOCAL_METRICS_COPY.disabled, /Signed activity audit under Advanced settings/)
  assert.doesNotMatch(LOCAL_METRICS_COPY.disabled, /could not open|cannot read/)
  assert.match(LOCAL_USAGE_COPY.disabled, /Activity auditing is off for new operations/)
  assert.equal(sourceLine(off.sessions).absence, LOCAL_METRICS_COPY.disabled)

  const broken = await readMetricsRecords({ agent: { history: async () => BROKEN, usage: async () => BROKEN }, window })
  assert.deepEqual(broken.readErrors, { history: 'METRICS_READ_UNAVAILABLE', usage: 'METRICS_READ_UNAVAILABLE' })
  assert.equal(broken.sessions.disabled, false)
  assert.equal(describeLocalMetrics(broken.sessions, { usage: broken.usage }).source.absence, LOCAL_METRICS_COPY.unreadable, 'a record that would not open is still said to be one')

  const mixed = await readMetricsRecords({ agent: { history: async () => OFF, usage: async () => BROKEN }, window })
  assert.deepEqual(mixed.readErrors, { history: 'AUDIT_NOT_ENABLED', usage: 'METRICS_READ_UNAVAILABLE' }, 'each channel keeps its own answer')
})

test('the Metrics page footer delegates to the actual footer expression, and that expression says auditing is off for intentional off (mixed or both), not a read failure', () => {
  // The footer is its own module now, so this drives the ACTUAL expression by
  // value rather than pinning a source pattern (root review 2026-09-21): the
  // page wires metricsFooterStatus, and the mixed intentional-off case that
  // used to read "Some records could not be read" is the off status.
  const source = fs.readFileSync(path.join(SRC, 'views/metrics.js'), 'utf8')
  assert.match(source, /status\.textContent = metricsFooterStatus\(\{ needsUpdate, sessions, usage, readErrors,/,
    'the footer is set from the extracted expression, not an inline chain that folded intentional off into a read failure')
  const off = { disabled: true, readable: false }
  const healthy = { disabled: false, readable: true }
  assert.equal(metricsFooterStatus({ sessions: off, usage: healthy, updatedLabel: 'Updated 12:00' }), METRICS_AUDIT_OFF_STATUS)
  assert.equal(metricsFooterStatus({ sessions: healthy, usage: off, updatedLabel: 'Updated 12:00' }), METRICS_AUDIT_OFF_STATUS)
  assert.equal(metricsFooterStatus({ sessions: off, usage: off }), METRICS_AUDIT_OFF_STATUS)
  // Off beside a genuine failure is still a failure.
  assert.equal(metricsFooterStatus({ sessions: off, usage: { disabled: false, readable: false }, updatedLabel: 'Updated 12:00' }),
    'Could not read records. Try Refresh data.')
})

test('the Home hero and run panel say auditing is off instead of a record that could not be read', () => {
  const engine = readAgentEngine({ ok: true })
  const off = describeHome({ fleetConfigured: false, sessions: readLocalSessions(OFF), engine, nowMs: Date.UTC(2026, 8, 21) })
  assert.match(off.headline, /runs are not being recorded/)
  assert.doesNotMatch(off.headline, /could not be read/)
  assert.equal(off.panel.empty?.title, 'Activity auditing is off')
  assert.match(off.panel.empty?.body || '', /Saved history is preserved/)
  assert.match(off.panel.empty?.body || '', /Signed activity audit under Advanced settings/)

  const broken = describeHome({ fleetConfigured: false, sessions: readLocalSessions(BROKEN), engine, nowMs: Date.UTC(2026, 8, 21) })
  assert.match(broken.headline, /could not be read/, 'a real failure keeps its sentence')
  assert.equal(broken.panel.empty?.title, 'The record could not be read')
})

/* THE EXACT COUNT RENDERER, run: paintAgentsOnRecord is sliced out of
   computers.js and executed in a vm context with the real readLocalSessions
   and a bridge answering the host's audit-off shape, then the failure shape. */
test('Computers paintAgentsOnRecord says auditing is off, and a record that would not open is still unreadable', async () => {
  const source = fs.readFileSync(path.join(SRC, 'views/computers.js'), 'utf8')
  const fn = declaredFunctionSource(source, 'paintAgentsOnRecord')
  async function paint(answer) {
    const hero = { textContent: '', dataset: {}, isConnected: true }
    const note = { textContent: '' }
    const context = vm.createContext({
      statsPage: { querySelector: selector => (selector === '#agent-count' ? hero : selector === '[data-agent-record-note]' ? note : null) },
      mockSource: () => false, computer: null, destroyed: false,
      window: { mcAgent: { history: async () => answer } },
      readLocalSessions, drivenComputerCopy: (own, driven) => own,
    })
    vm.runInContext(fn, context)
    await context.paintAgentsOnRecord()
    return { hero, note }
  }
  const off = await paint(OFF)
  assert.equal(off.hero.textContent, '—')
  assert.equal(off.hero.dataset.recordState, 'off')
  assert.match(off.note.textContent, /^Activity auditing is off, so no count is kept\. Saved history is preserved; turn on Signed activity audit under Advanced settings to record new runs\.$/)
  const broken = await paint(BROKEN)
  assert.equal(broken.hero.dataset.recordState, 'unreadable')
  assert.equal(broken.note.textContent, 'Agent history could not be read, so the count is unavailable.')
  const counted = await paint({ ok: true, total: 3, outcomes: { starts: 3, started: 3, refused: 0 }, verified: true, entries: [] })
  assert.equal(counted.hero.dataset.recordState, 'counted')
  assert.equal(counted.hero.textContent, '3')
})
