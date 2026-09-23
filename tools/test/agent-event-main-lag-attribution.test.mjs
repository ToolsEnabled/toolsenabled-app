/* W22 agent-run-lag. shell/main.cjs's `host.onEvent(...)` fan-out runs on
 * every packet from every live circle and is not an ipcMain handler, so
 * shell/main-lag.cjs's automatic ipcMain wrapping never saw it -- exactly
 * the gap Manager 3 named ("the per-agent-event work in the main process").
 *
 * The Electron main process cannot be booted in a unit test (same constraint
 * tools/test/usage-record-wiring.test.mjs already states and works around),
 * so the wiring half executes its actual listener and span wrappers with
 * explicit dependencies. The mechanism half -- whether note()
 * actually attributes a span to the label of whichever wrapped call really
 * ran longest -- is a real behavioural test against the unmodified
 * shell/main-lag.cjs, calling it with values.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { testScratchRoot } from '../lib/test-scratch-root.mjs'

const require_ = createRequire(import.meta.url)
const { bindSessionChangePaths } = require_('../../shell/session-change-paths.cjs')
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (relative) => readFileSync(path.join(REPO_ROOT, relative), 'utf8')
const { createMainLagMonitor, UNATTRIBUTED } = require_(path.join(REPO_ROOT, 'shell/main-lag.cjs'))

test('createMainLagMonitor.note() attributes the worst span to whichever wrapped call actually ran longest', () => {
  const file = testScratchRoot('.toolsenabled-mainlag-mechanism-test.log')
  const monitor = createMainLagMonitor({ file })
  assert.equal(monitor.stats().worstLabel, null, 'a fresh monitor must start with no attribution')

  const busyWaitMs = (ms) => { const until = Date.now() + ms; while (Date.now() < until) { /* real synchronous work */ } }

  monitor.note('agent-event:forward', () => busyWaitMs(2))
  monitor.note('agent-event:usage-record', () => busyWaitMs(30))
  monitor.note('agent-event:notification', () => busyWaitMs(4))

  const stats = monitor.stats()
  assert.equal(stats.worstLabel, 'agent-event:usage-record',
    'the longest of three real synchronous spans must be the one remembered, not the first or the last')
  assert.ok(stats.worstMs >= 15, `the remembered span must carry roughly the time it actually blocked (${stats.worstMs})`)
  assert.notEqual(stats.worstLabel, UNATTRIBUTED)
})

test('the actual main event callback attributes forwarding, records and notification while preserving the ending reason', () => {
  const main = read('shell/main.cjs')
  const functionSource = name => {
    const start = main.indexOf(`function ${name}(`)
    const end = main.indexOf('\n}', start)
    assert.ok(start >= 0 && end > start, `missing actual ${name} wrapper`)
    return main.slice(start, end + 2)
  }
  const marker = 'removeAgentEventListener = host.onEvent('
  const start = main.indexOf(marker)
  const end = main.indexOf('\n  })', start)
  assert.ok(start >= 0 && end > start, 'missing actual agent event listener')
  const callback = main.slice(start + marker.length, end + 4)
  const wrappers = ['noteAgentTurnUsage', 'noteAgentNotification', 'recordSessionEnd'].map(functionSource).join('\n')

  for (const kind of ['window', 'relay']) {
    for (const reason of [null, 'exited', 'cap-reached', 'parent-stopped']) {
      const calls = []
      let label = null
      const record = (operation, ...args) => { calls.push({ operation, label, args }) }
      const session = { started: true, state: 'ready', owner: kind === 'window' ? {
        isDestroyed: () => false,
        send: (...args) => record('window-send', ...args),
      } : {} }
      const agentSessions = new Map([['session-1', session]])
      const context = {
        agentSessions,
        bindSessionChangePaths, path, WORKSPACE_ROOT: path.join(path.resolve(testScratchRoot('main-event-workspace'))),
        AGENT_EVENT_CHANNEL: 'agent-event',
        mainLagMonitor: { note(span, fn) {
          const prior = label
          label = span
          try { return fn() } finally { label = prior }
        } },
        getAgentCommandSurface: () => ({ forwardSessionEvent(packet) {
          record('surface-forward', packet)
          return kind === 'relay'
        } }),
        transcriptCapture: { packet: packet => record('transcript', packet) },
        noteAgentTurnUsageImpl: (...args) => record('usage', ...args),
        noteAgentTurnCompleted: (...args) => record('completed', ...args),
        noteAgentNotificationImpl: (...args) => record('notification', ...args),
        recordSessionEndImpl: (...args) => record('ending', ...args),
        ownedByThisWindow: () => kind === 'window',
      }
      const listener = runInNewContext(`${wrappers}\n(${callback})`, context, { filename: 'main-event-span-fixture.cjs' })
      const packet = { sessionId: 'session-1', event: reason ? { type: 'session_ended', reason } : { type: 'turn_completed' } }
      listener(packet)
      assert.equal(calls.find(call => call.operation === 'surface-forward')?.label, 'agent-event:forward')
      assert.equal(calls.find(call => call.operation === 'usage')?.label, 'agent-event:usage-record')
      assert.deepEqual(calls.find(call => call.operation === 'usage')?.args, [session, packet])
      assert.ok(calls.findIndex(call => call.operation === 'surface-forward') < calls.findIndex(call => call.operation === 'usage'),
        'event delivery must precede the usage write')
      const sent = calls.filter(call => call.operation === 'window-send')
      const notified = calls.filter(call => call.operation === 'notification')
      assert.equal(sent.length, kind === 'window' ? 1 : 0)
      assert.equal(notified.length, kind === 'window' ? 1 : 0)
      if (kind === 'window') {
        assert.equal(sent[0].label, 'agent-event:forward')
        assert.deepEqual(sent[0].args, ['agent-event', packet])
        assert.equal(notified[0].label, 'agent-event:notification')
        assert.deepEqual(notified[0].args, [packet])
      }
      const endings = calls.filter(call => call.operation === 'ending')
      assert.equal(endings.length, reason ? 1 : 0)
      if (reason) {
        assert.equal(endings[0].label, 'agent-event:spawn-record-end')
        assert.deepEqual(endings[0].args, [session, 'session-1', reason], 'the measured span must retain the actual ending cause')
        assert.equal(session.observedEndReason, reason)
      }
      const beforeUnknown = calls.length
      listener({ sessionId: 'unknown', event: { type: 'session_ended', reason: 'exited' } })
      assert.equal(calls.length, beforeUnknown, 'unknown sessions must not enter the fan-out')
    }
  }
})

test('createAgentHost is handed the app\'s one real mainLagMonitor instance, not built without it', () => {
  const main = read('shell/main.cjs')
  const build = main.slice(main.indexOf('async function buildAgentHost'), main.indexOf('removeAgentEventListener = host.onEvent('))
  assert.match(build, /mainLag: mainLagMonitor,/,
    'createAgentHost is constructed without the monitor, so the tree courier can never attribute a span either')
})
