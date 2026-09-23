import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const MAIN = fs.readFileSync(path.join(ROOT, 'shell', 'main.cjs'), 'utf8')
const PRELOADS = ['shell/preload.cjs', 'shell/fleet-profile-preload.cjs']
const require = createRequire(path.join(ROOT, 'shell/main.cjs'))

function rendererCalls(source) {
  return [...source.matchAll(/ipcRenderer\.(invoke|sendSync|send|on|once|removeListener)\(\s*(['"])([^'"]+)\2/g)]
    .map(match => ({ transport: match[1], channel: match[3] }))
}

function mainRegistrations(source) {
  const registrations = new Map([...source.matchAll(/ipcMain\.(handle|on)\(\s*(['"])([^'"]+)\2/g)]
    .map(match => [match[3], match[1]]))
  const ipcMain = { handle(channel, callback) {
    assert.equal(typeof callback, 'function')
    assert.equal(registrations.has(channel), false, `duplicate composed registration: ${channel}`)
    registrations.set(channel, 'handle')
  } }
  // Execute the actual closed registration loops. A literal-call scan sees
  // only their prefixes, leaving every composed channel unaccounted for.
  for (const marker of [
    "for (const [channel, command] of [[",
    "for (const operation of ['append',",
    "for (const operation of ['save',",
  ]) {
    const start = source.indexOf(marker), end = source.indexOf('\n}', start)
    assert.ok(start >= 0 && end > start, `missing registration loop: ${marker}`)
    vm.runInNewContext(source.slice(start, end + 2), { ipcMain })
  }
  // The main process composes this module into the same bus. Execute its real
  // installer at the production call site; callbacks are only registered,
  // so this transport census opens no window and contacts no peer.
  const start = source.indexOf("const remoteWorkspaces = require('./remote-workspace.cjs').installRemoteWorkspace({")
  const end = source.indexOf('\nconst remoteConnection =', start)
  assert.ok(start >= 0 && end > start, 'main must install the remote workspace transport')
  vm.runInNewContext(source.slice(start, end), {
    ipcMain, require, BrowserWindow: class {},
    relaySupervisor: { remoteWorkspace: { subscribe() {} } },
    trustedFleetProfileSender: () => false, relayMachineIsEnrolled: () => false,
  })
  return registrations
}

function registrationStatement(source, kind, channel) {
  const marker = `ipcMain.${kind}('${channel}'`
  const start = source.indexOf(marker)
  assert.notEqual(start, -1, `main must register ${channel}`)
  const open = source.indexOf('(', start)
  let depth = 0
  let quote = null
  let escaped = false
  let lineComment = false
  let blockComment = false
  for (let index = open; index < source.length; index += 1) {
    const char = source[index]
    const next = source[index + 1]
    if (lineComment) {
      if (char === '\n') lineComment = false
      continue
    }
    if (blockComment) {
      if (char === '*' && next === '/') { blockComment = false; index += 1 }
      continue
    }
    if (quote) {
      if (escaped) { escaped = false; continue }
      if (char === '\\') { escaped = true; continue }
      if (char === quote) quote = null
      continue
    }
    if (char === '/' && next === '/') { lineComment = true; index += 1; continue }
    if (char === '/' && next === '*') { blockComment = true; index += 1; continue }
    if (char === "'" || char === '"' || char === '`') { quote = char; continue }
    if (char === '(') depth += 1
    if (char === ')') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  assert.fail(`could not find the end of ${channel}`)
}

test('every production preload request has the matching main-process transport', () => {
  const registrations = mainRegistrations(MAIN)
  const rows = PRELOADS.flatMap(file => rendererCalls(fs.readFileSync(path.join(ROOT, file), 'utf8'))
    .map(call => ({ file, ...call })))
  const inbound = rows.filter(row => ['invoke', 'sendSync', 'send'].includes(row.transport))
  assert.ok(inbound.length > 100, 'the inventory must cover the composed production boundary, not a hand-picked subset')
  for (const row of inbound) {
    assert.equal(registrations.has(row.channel), true, `${row.file} exposes ${row.channel} without a main registration`)
    const expected = row.transport === 'invoke' ? 'handle' : 'on'
    assert.equal(registrations.get(row.channel), expected,
      `${row.file} uses ${row.transport} for ${row.channel}, but main registers ${registrations.get(row.channel)}`)
  }
})

test('bridge proof and endpoint refuse an untrusted frame before waiting or disclosing', async () => {
  for (const [channel, answerName] of [
    ['mc-bridge-proof', 'currentBridgeProof'],
    ['mc-bridge-endpoint', 'currentBridgeEndpoint'],
  ]) {
    let handler = null
    let settled = 0
    const expected = { ok: true, channel }
    const context = {
      ipcMain: { handle: (_channel, callback) => { handler = callback } },
      assertTrustedAgentSender: event => {
        if (event?.trusted !== true) throw Object.assign(new Error('refused'), { code: 'MC_AGENT_SENDER_REFUSED' })
      },
      capabilityLayerSettled: async () => { settled += 1 },
      [answerName]: () => expected,
    }
    vm.runInNewContext(registrationStatement(MAIN, 'handle', channel), context)
    await assert.rejects(() => handler({ trusted: false }), /refused/)
    assert.equal(settled, 0, `${channel} must refuse before awaiting capability startup`)
    assert.deepEqual(await handler({ trusted: true }), expected)
    assert.equal(settled, 1)
  }
})

/* THIS SANDBOX IS A REAL SLICE OF shell/main.cjs, so it acquires whatever the
 * product puts between those two markers -- and that is the point: a stand-in
 * narrow enough to miss a new statement would stop measuring the real file.
 * MEASURED 2026-09-07 at app 4ba0ceac: the main-lag work inserted
 * `createMainLagMonitor(...)` and `mainLagMonitor.instrument(ipcMain)` into
 * this region, the sandbox had no such name, and the whole check died on
 * "createMainLagMonitor is not defined" -- an accessibility SENDER check
 * reported as a failure of a lag monitor. The collaborators below are supplied
 * so the subject can be measured again; nothing about the sender assertions
 * changed. */
test('each accessibility transport checks its sender before touching the owner-bound host', () => {
  const helper = MAIN.slice(MAIN.indexOf('function accessibilityCommand('), MAIN.indexOf('function voiceCommand('))
  const handlers = new Map(), calls = []
  const instrumented = [], exitRecordWriters = []
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) }
  const context = {
    ipcMain,
    path,
    SHELL_USER_DATA_PATH: path.join(ROOT, 'this-test-writes-nothing'),
    /* Not a no-op: it records WHAT it was handed and HOW MANY channels existed
       at that moment, which is the claim the comment beside it in main.cjs
       makes -- that the monitor is armed above the first registration so the
       twelve handlers here are covered. Asserted below. */
    createMainLagMonitor: () => ({
      instrument: bus => instrumented.push({ bus, channelsRegisteredSoFar: handlers.size }),
      start: () => {},
    }),
    /* MEASURED 2026-09-17 at app 5c7798a3: T180's durable exit record inserted
       `createExitRecordWriter(...)` into this same region and the whole sender
       check died on "createExitRecordWriter is not defined" -- the third time a
       new collaborator in this region has been reported as a failure of the
       accessibility SENDER assertions. Supplied, and recorded rather than
       stubbed, so the region keeps being measured whole. */
    BrowserWindow: { getAllWindows: () => [] },
    agentHost: null,
    createExitRecordWriter: options => { exitRecordWriters.push(options); return { writeExitRecord: () => {} } },
    assertTrustedAgentSender(event) { if (!event.trusted) throw Error('untrusted frame') },
    accessibilityHost: Object.fromEntries(['state', 'prepareEnable', 'confirm', 'reject', 'disable']
      .map(command => [command, (owner, value) => { calls.push({ command, owner, value }); return command }])),
  }
  vm.runInNewContext(helper, context)

  assert.deepEqual(instrumented.map(entry => entry.channelsRegisteredSoFar), [0],
    'the lag monitor must be instrumented exactly once, before any channel in this region is registered')
  assert.equal(instrumented[0].bus, ipcMain,
    'the monitor instrumented a different object than the one these handlers register on, so they are untimed')
  assert.equal(exitRecordWriters.length, 1, 'the exit-record writer must be built exactly once in this region')
  assert.equal(exitRecordWriters[0].file, path.join(context.SHELL_USER_DATA_PATH, 'exit-record.log'),
    'the exit record must land beside the rest of this profile, not in a shared or cwd-relative path')
  for (const field of ['getOpenWindowCount', 'getInFlightContinuationCount']) {
    assert.equal(typeof exitRecordWriters[0][field], 'function', field + ' must be supplied, or the record cannot say what was still open')
    assert.doesNotThrow(exitRecordWriters[0][field], 'an exit record is written while the app is dying; its probes may not throw')
  }
  const owner = {}, value = {}
  for (const [channel, command] of [
    ['status', 'state'], ['prepareEnable', 'prepareEnable'], ['confirm', 'confirm'], ['reject', 'reject'], ['disable', 'disable'],
  ]) {
    const handler = handlers.get('mc-accessibility:' + channel)
    assert.equal(typeof handler, 'function')
    const before = calls.length
    assert.throws(() => handler({ trusted: false, sender: owner }, value), /untrusted frame/)
    assert.equal(calls.length, before)
    assert.equal(handler({ trusted: true, sender: owner }, value), command)
    assert.deepEqual(calls.at(-1), { command, owner, value })
  }
})

test('theme packets are trusted, closed-schema, and cannot throw on hostile values', () => {
  let handler = null
  const calls = []
  const context = {
    ipcMain: { on: (_channel, callback) => { handler = callback } },
    trustedFleetProfileSender: event => event?.trusted === true,
    win: {
      setTitleBarOverlay: value => calls.push(['overlay', value]),
      setBackgroundColor: value => calls.push(['background', value]),
    },
    nativeTheme: { themeSource: 'system' },
    writeState: value => calls.push(['state', value]),
    TITLEBAR_H: 36,
  }
  vm.runInNewContext(registrationStatement(MAIN, 'on', 'mc-theme'), context)

  assert.doesNotThrow(() => handler({ trusted: true }, null))
  handler({ trusted: false }, { theme: 'black', bg: '#000000', ink: '#ffffff' })
  handler({ trusted: true }, { theme: 'invented', bg: '#000000', ink: '#ffffff' })
  handler({ trusted: true }, { theme: 'black', bg: 'transparent', ink: '#ffffff' })
  assert.deepEqual(calls, [])
  assert.equal(context.nativeTheme.themeSource, 'system')

  handler({ trusted: true }, { theme: 'black', bg: '#000000', ink: '#ffffff' })
  assert.equal(context.nativeTheme.themeSource, 'dark')
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ['overlay', { color: '#000000', symbolColor: '#ffffff', height: 36 }],
    ['background', '#000000'],
    ['state', { theme: 'black' }],
  ])
})
