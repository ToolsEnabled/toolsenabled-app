/* AGENT TOOL WORK IS NAMED IN THE STALL RECORD (T1763).
 *
 * The owner host runs every agent tool call inside this app's main process
 * (shell/capability-layer.cjs loads it; src/owner-host.js in the payload runs
 * each MCP line in-process), so a Ledger read or write holds the window. On
 * LIVE .47 none of that time had a name: about 87% of main-thread stall time
 * was written to main-lag.log as unattributed. The payload now times each line
 * as `owner-host:<tool>` through a `mainLag` it is given; these check that the
 * app gives it the real monitor, that a span opened through what the payload
 * receives lands in that monitor's record, and that main.cjs wires its own
 * monitor in. The payload side is tested in the engine suite
 * (tests/owner-host-main-lag-span.test.js) against the real socket host. */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import capabilityLayer from '../../shell/capability-layer.cjs'

const require_ = createRequire(import.meta.url)
const { createMainLagMonitor } = require_('../../shell/main-lag.cjs')
const { startAppOwnedOwnerHost, stopAppOwnedOwnerHost } = capabilityLayer

/* A payload whose owner host remembers the options the app created it with. */
function payloadRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'owner-host-main-lag-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'PAYLOAD.json'), JSON.stringify({
    bridgeEntrypoint: 'bridge.cjs', ownerHostModule: 'src/owner-host.js', hostModules: ['src/owner-host.js'],
  }))
  writeFileSync(join(root, 'bridge.cjs'), '')
  writeFileSync(join(root, 'src', 'owner-host.js'), `
    'use strict'
    exports.created = []
    exports.createOwnerHost = options => {
      exports.created.push(options)
      return {
        pipeName: 'owner-host-main-lag-fixture', generation: '00000000-0000-4000-8000-000000000000',
        listening: false, closed: false,
        async listen() { this.listening = true },
        async close() { this.closed = true },
        bindSession() { return { credential: 'opaque' } },
        revokeSession() { return true },
        assertSession() { return { valid: true } },
      }
    }
  `)
  return root
}

function busy(ms) {
  const until = Date.now() + ms
  while (Date.now() < until) { /* hold the thread, as a synchronous Ledger parse does */ }
}

test('the owner host is created with the app\'s own stall monitor, and its spans land in that record', async t => {
  const root = payloadRoot(t)
  const lines = []
  const monitor = createMainLagMonitor({ file: join(root, 'main-lag.log'), appendSink: line => { lines.push(line); return { written: true } } })
  const started = await startAppOwnedOwnerHost({ root, mainLag: monitor })
  assert.equal(started.ok, true)
  t.after(() => stopAppOwnedOwnerHost(started.host))
  const payload = require_(join(root, 'src', 'owner-host.js'))
  assert.equal(payload.created.length, 1)
  const given = payload.created[0].mainLag
  assert.equal(given, monitor, 'the payload receives the monitor itself, not a copy that records nowhere')
  const end = given.span('owner-host:ledger.read')
  busy(25)
  end()
  const stats = monitor.stats()
  assert.equal(stats.worstLabel, 'owner-host:ledger.read', 'the worst span the monitor holds is the owner-host one')
  assert.ok(stats.worstMs >= 20, `the span held the thread for ${stats.worstMs} ms`)
})

test('without a monitor, or with one that cannot open a span, the payload is created exactly as before', async t => {
  for (const mainLag of [undefined, null, {}, { span: 'not a function' }]) {
    const root = payloadRoot(t)
    const started = await startAppOwnedOwnerHost({ root, ...(mainLag === undefined ? {} : { mainLag }) })
    assert.equal(started.ok, true)
    const payload = require_(join(root, 'src', 'owner-host.js'))
    assert.equal(Object.hasOwn(payload.created[0], 'mainLag'), false, `mainLag ${JSON.stringify(mainLag)} is not passed on`)
    await stopAppOwnedOwnerHost(started.host)
  }
})

test('the app starts its owner host with the monitor that writes main-lag.log', () => {
  const main = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
  const call = main.match(/startAppOwnedOwnerHost\(\{([^}]*)\}\)/)
  assert.ok(call, 'main.cjs starts the app-owned owner host')
  assert.match(call[1], /\bmainLag:\s*mainLagMonitor\b/, 'the owner host is given mainLagMonitor')
  assert.match(main, /const mainLagMonitor = createMainLagMonitor\(\{ file: path\.join\(SHELL_USER_DATA_PATH, 'main-lag\.log'\)/,
    'mainLagMonitor is the monitor that writes main-lag.log')
})
