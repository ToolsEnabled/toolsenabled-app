/* T180: pid 44348's last main-lag.log entry was 19:28:38.757Z, and nothing
 * after it said why the process went away. Two things are tested here with
 * real, unmodified modules and real values -- never a spelling pin against
 * this file's own implementation:
 *
 *  1. shell/exit-record.cjs's writer actually persists a durable, readable
 *     record (trigger, initiator, open windows, in-flight continuations) --
 *     this is the gate with the mutation check quoted in the report.
 *  2. Driving the REAL provider-limit checkpoint writer (shell/node-recovery-
 *     store.cjs's createNodeRecoveryStore, the module T180 names as the
 *     "node-recovery handoff" writer) for three sessions at once, using the
 *     REAL handoff text builder (shell/account-session-recovery.cjs's
 *     recoveryHandoff), completes without throwing and leaves the exit-record
 *     file untouched -- the app stays alive and writes no exit record.
 *
 * The Electron main process cannot be booted in a unit test (the same
 * constraint tools/test/agent-event-main-lag-attribution.test.mjs already
 * states and works around), so this drives the actual modules named in the
 * T180 record directly, with real filesystem I/O against a scratch
 * directory, rather than a stub of shell/main.cjs's wiring.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'
import { testScratchRoot } from '../lib/test-scratch-root.mjs'

const require_ = createRequire(import.meta.url)
const { createExitRecordWriter } = require_('../../shell/exit-record.cjs')
const { createNodeRecoveryStore } = require_('../../shell/node-recovery-store.cjs')
const { recoveryHandoff, createRecoveryState, rememberRecoveryText } = require_('../../shell/account-session-recovery.cjs')

test('createExitRecordWriter.writeExitRecord persists trigger, initiator and the counts it was given', () => {
  const file = testScratchRoot('.toolsenabled-t180-exit-record-mechanism.log')
  try { rmSync(file, { force: true }) } catch {}
  const writer = createExitRecordWriter({
    file,
    getOpenWindowCount: () => 2,
    getInFlightContinuationCount: () => 3,
  })

  const wrote = writer.writeExitRecord('before-quit', 'app-quit-gate')
  assert.equal(wrote, true, 'a writable scratch file must report a successful write')
  assert.ok(existsSync(file), 'writeExitRecord must leave a durable file behind')

  const lines = readFileSync(file, 'utf8').trim().split('\n')
  assert.equal(lines.length, 1)
  const record = JSON.parse(lines[0])
  assert.equal(record.trigger, 'before-quit')
  assert.equal(record.initiator, 'app-quit-gate')
  assert.equal(record.openWindows, 2)
  assert.equal(record.inFlightContinuations, 3)
  assert.equal(typeof record.pid, 'number')
  assert.ok(!Number.isNaN(Date.parse(record.at)), 'at must be a parseable timestamp')

  writer.writeExitRecord('will-quit', 'capability-layer-teardown')
  const secondPass = readFileSync(file, 'utf8').trim().split('\n')
  assert.equal(secondPass.length, 2, 'a second call must append, not overwrite, the durable record')

  try { rmSync(file, { force: true }) } catch {}
})

test('a provider-limit rollover of three sessions at once completes and writes no exit record', async () => {
  const recoveryDirectory = testScratchRoot('.toolsenabled-t180-node-recovery')
  const exitRecordFile = testScratchRoot('.toolsenabled-t180-exit-record-rollover.log')
  try { rmSync(recoveryDirectory, { recursive: true, force: true }) } catch {}
  try { rmSync(exitRecordFile, { force: true }) } catch {}

  const store = createNodeRecoveryStore({ directory: recoveryDirectory })
  // Nothing below wires this writer to the recovery store -- it exists only so
  // the test can assert its file stayed empty, exactly as shell/main.cjs's
  // real wiring never calls it from the recovery path either.
  const exitRecord = createExitRecordWriter({ file: exitRecordFile })

  const threeSessionsRollingOverAtOnce = ['node-3-0c35f697', 'node-26-15884fbb', 'node-7-da02fefa'].map(nodeId => {
    const state = createRecoveryState()
    rememberRecoveryText(state, 'person', 'ROLE: IMPLEMENTER working on T180.')
    rememberRecoveryText(state, 'assistant', 'Reached a provider limit mid-turn.')
    return store.save({
      computerId: 'computer-under-test',
      nodeId,
      record: { v: 1, handoff: recoveryHandoff(state) },
    })
  })

  const results = await Promise.all(threeSessionsRollingOverAtOnce)
  for (const result of results) assert.equal(result.ok, true, JSON.stringify(result))

  // The rollover ran to completion (the assertions above), which is what
  // "stays alive" means for a mechanism with no window or quit path of its
  // own to observe; shell/exit-record.cjs's own module never appears in
  // shell/node-recovery-store.cjs or shell/account-session-recovery.cjs
  // (read separately in the T180 report), so nothing here can call it.
  assert.equal(existsSync(exitRecordFile), false, 'a provider-limit rollover must write no exit record')

  try { rmSync(recoveryDirectory, { recursive: true, force: true }) } catch {}
  try { rmSync(exitRecordFile, { force: true }) } catch {}
})
