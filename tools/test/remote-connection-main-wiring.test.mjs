import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { parseAst } from 'rollup/parseAst'

const source = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const statements = parseAst(source).body
const require = createRequire(import.meta.url)
const { createAgentFacade } = require('../../shell/agent-facade.cjs')
const { COMMANDS } = require('../../shell/agent-command-surface.cjs')
const { webDriveMayWrite } = require('../../shell/relay-supervisor.cjs')
const { createAppShutdownCoordinator } = require('../../shell/research-shutdown.cjs')
const { createAppQuitGate } = require('../../shell/app-shutdown.cjs')
function callback(label, owner, context, indent = '  ') {
  const registration = source.indexOf(owner)
  const start = source.indexOf(label, registration) + label.length
  const ending = '\n' + indent + '},'
  const end = source.indexOf(ending, start) + ending.length - 1
  assert.ok(registration >= 0 && start >= registration + label.length && end > start)
  return runInNewContext('(' + source.slice(start, end) + ')', context)
}

test('actual primary acquisition refreshes ownership after the lock and preserves command-only handoff', () => {
  const events = []
  let acquired = false
  let refreshed = true
  const context = {
    app: {
      requestSingleInstanceLock: () => { events.push('lock'); return acquired },
      releaseSingleInstanceLock: () => events.push('release'),
    },
    treeNodeCommandAdditionalData: () => ({}),
    launchTreeNodeCommandId: null,
    remoteConnection: { prepareForPrimary: () => { events.push('refresh'); return refreshed } },
    refuseTreeNodeCommandWithoutPrimary: () => events.push('command-refusal'),
  }
  const lock = callback('requestLock: ', 'wireSingleInstance({', context)
  assert.equal(lock(), false)
  assert.deepEqual(events.splice(0), ['lock'])
  acquired = true
  assert.equal(lock(), true)
  assert.deepEqual(events.splice(0), ['lock', 'refresh'])
  refreshed = false
  assert.equal(lock(), false)
  assert.deepEqual(events.splice(0), ['lock', 'refresh', 'release'])
  context.launchTreeNodeCommandId = 'fixture-command'
  assert.equal(lock(), false)
  assert.deepEqual(events.splice(0), ['lock', 'command-refusal', 'release'])
})

test('actual relay event ingress rejects a prior account owner and a revoked connection', () => {
  const owner = {}
  const events = []
  let allowed = true
  const sessions = new Map([
    ['current', { owner }], ['old', { owner: {} }],
  ])
  const emit = callback('emitRelayEvent: ', 'function getAgentCommandSurface()', {
    agentSessions: sessions, RELAY_OWNER: owner,
    agentFacade: { emit: packet => events.push(packet) },
    remoteAccessStopping: false,
    remoteConnectionFence: { allowsRemote: () => allowed },
  }, '    ')
  emit({ sessionId: 'old' })
  emit({ sessionId: 'missing' })
  assert.equal(events.length, 0)
  const accepted = { sessionId: 'current' }
  emit(accepted)
  assert.deepEqual(events, [accepted])
  allowed = false
  emit({ sessionId: 'current' })
  assert.deepEqual(events, [accepted])
})

test('actual disconnect revokes credentials and tries facade close even if the workspace close throws', async () => {
  const owner = {}
  const events = []
  const context = {
    relayFacadeCredentials: { token: 'disposable-facade-fixture' }, RELAY_OWNER: owner,
    remoteWorkspaces: { close: () => { events.push('workspace'); throw Error('fixture close failure') } },
    agentFacade: { close: async () => { events.push('facade'); } },
    revokePendingRelayStarts: () => events.push('pending-starts'),
  }
  const revoke = callback('revoke: ', 'const remoteConnection = createRemoteConnectionLifecycle({', context)
  assert.equal(await revoke(), false)
  assert.equal(context.relayFacadeCredentials, null)
  assert.notEqual(context.RELAY_OWNER, owner)
  // Starts not yet accepted lose their admission before either close runs.
  assert.deepEqual(events, ['pending-starts', 'workspace', 'facade'])
})

function exactNode(nodes, label) {
  assert.equal(nodes.length, 1, `one actual ${label} must be present`)
  return source.slice(nodes[0].start, nodes[0].end)
}

function actualFunction(name, context) {
  const text = exactNode(statements.filter(node => node.type === 'FunctionDeclaration' && node.id?.name === name), name)
  return runInNewContext('(' + text + ')', context)
}

// Execute the actual main-process callbacks with a held host cleanup. The
// facade below is a real loopback server; only its action body is a no-op.
// No Electron owner, account store, enrollment helper or customer file is used.
//
// PORTED 2026-09-06 from the r9 lane's inline before-quit handler to the
// verified LIVE app's shutdown coordinator, with the same assertions. Two lanes
// implemented app quit twice; the coordinator is the implementation that
// survived. Drive its real window-close gate after the last window closes.
// Nothing here re-implements the quit path: the coordinator is the real
// createAppShutdownCoordinator, and its `onBegin`, `onComplete`, `quit` and
// `closeAgents` wiring is sliced out of shell/main.cjs exactly as the relay
// callbacks below already are. The r9 handler's own bookkeeping -- the module
// locals `agentShutdownPromise` and `agentShutdownComplete` -- went with it, so
// the coordinator's `flight` promise and `appShutdown.complete` stand in for
// them. Those are the same two observations under different names.
function quittingMain({ host = true, complete = false } = {}) {
  const events = []
  // Kept off `events` on purpose: the rows below assert exact cleanup ORDER,
  // and the exit record is bookkeeping alongside that order, not a step in it.
  const exitRecords = []
  const owner = {}
  const persisted = { enrolled: true, drive: 'on', blocked: false, writes: 0 }
  let resolveClose
  const closing = new Promise(resolve => { resolveClose = resolve })
  const callbacks = new Map()
  const context = {
    nodeRecovery: { async stop() {} },
    usageRecorder: { async flush() { events.push('usage-flush') } },
    transcriptCapture: { async shutdown() { events.push('transcript-close') } },
    nodeTranscripts: { async shutdown({ deleteNodes }) { deleteNodes(); events.push('node-transcript-close') } },
    nodePrivacyCleanup: {
      prepare() { events.push('privacy-prepare') },
      complete() { events.push('privacy-complete') },
    },
    sandboxSetup: { sealAdmission() { events.push('setup-seal') } },
    sandboxSetupExecutor: null,
    remoteAccessStopping: false,
    agentRuntimeStoppedForReset: false,
    treeNodeCommandDispatchEnabled: true,
    treeNodeCommandBroker: { dispose: () => events.push('broker-dispose') },
    relayFacadeCredentials: null,
    RELAY_OWNER: owner,
    agentSessions: new Map([['fixture-session', { owner }]]),
    recordSessionEnd: (_session, id, reason) => events.push(['session-end', id, reason]),
    removeAgentEventListener: () => events.push('remove-listener'),
    voiceHost: { close: () => events.push('voice-close') },
    console: { error: () => events.push('cleanup-error') },
    createAppShutdownCoordinator,
    createAppQuitGate, BrowserWindow: { getAllWindows: () => [] },
    remoteConnectionFence: {
      allowsRemote: () => !persisted.blocked,
      ticket: () => 1,
      isCurrent: value => value === 1,
      block() { persisted.blocked = true; persisted.writes += 1 },
      recordDisconnect() { persisted.writes += 1 },
    },
    deviceClaim: {
      enrolled: () => persisted.enrolled,
      disconnect() { persisted.enrolled = false; persisted.writes += 1 },
    },
    rendererPrefs: {
      snapshot: () => ({ values: { 'mc.relay.web-drive': persisted.drive } }),
      remove() { persisted.drive = null; persisted.writes += 1 },
    },
    webDriveMayWrite,
    app: {
      on: (name, handler) => callbacks.set(name, handler),
      quit: () => events.push('quit'),
    },
  }
  context.agentHost = host ? { closeAll: () => { events.push('host-close'); return closing } } : null
  context.closeAgentSessionsForQuit = actualFunction('closeAgentSessionsForQuit', context)
  const coordinator = statements.filter(node => node.type === 'VariableDeclaration')
    .flatMap(node => node.declarations).filter(node => node.id?.name === 'appShutdown').map(node => node.init)
  context.appShutdown = runInNewContext(
    '(' + exactNode(coordinator, 'appShutdown initializer') + ')', context)
  context.relayPrincipal = actualFunction('relayPrincipal', context)
  context.relayMachineIsEnrolled = actualFunction('relayMachineIsEnrolled', context)
  context.armRelayFacade = actualFunction('armRelayFacade', context)
  // MEASURED 2026-09-17 at app 5c7798a3: this used to require that the
  // before-quit handler BE the createAppQuitGate(...) call expression. T180
  // hoisted the gate to `const appQuitGate` and registered a handler that first
  // writes a durable exit record and then delegates to it -- a strictly larger
  // handler, and the pin read it as "no registration at all", reddening four
  // rows about quit ADMISSION with "one actual before-quit coordinator
  // registration must be present". Bind the real gate and then run the real
  // registration, so the exit-record write is inside what these rows execute.
  const gate = statements.filter(node => node.type === 'VariableDeclaration')
    .flatMap(node => node.declarations).filter(node => node.id?.name === 'appQuitGate')
  context.exitRecord = { writeExitRecord: (...written) => exitRecords.push(written) }
  context.appQuitGate = runInNewContext('(' + exactNode(gate, 'appQuitGate initializer') + ')', context)
  const registration = statements.filter(node => {
    const call = node.type === 'ExpressionStatement' ? node.expression : null
    if (call?.type !== 'CallExpression' || call.callee?.object?.name !== 'app'
      || call.callee?.property?.name !== 'on' || call.arguments[0]?.value !== 'before-quit') return false
    return /\bappQuitGate\b/.test(source.slice(node.start, node.end))
  })
  runInNewContext(exactNode(registration, 'before-quit coordinator registration'), context)
  let flight = null
  const fixture = {
    context, events, persisted, exitRecords,
    // The coordinator returns its in-flight promise; the r9 handler stored the
    // same thing in `agentShutdownPromise`. `null` before the first quit, and
    // `undefined` from a call that early-returns, are both preserved verbatim.
    beforeQuit: () => {
      const returned = callbacks.get('before-quit')({ preventDefault: () => events.push('prevent-default') })
      if (returned) flight = returned
      return returned
    },
    shutdownPromise: () => flight,
    release: () => resolveClose(),
  }
  if (complete) {
    // The r9 fixture set `agentShutdownComplete: true` directly, because that
    // was a plain module local. Completion is now the coordinator's own phase,
    // so it is reached the only way it can legitimately be reached: by running
    // a whole shutdown first. Callers get an already-complete coordinator.
    fixture.reachComplete = async () => {
      fixture.beforeQuit()
      resolveClose()
      await flight
      assert.equal(context.appShutdown.complete, true, 'the fixture must start from a genuinely complete shutdown')
      events.length = 0
    }
  }
  return fixture
}

function post(origin, token) {
  return new Promise((resolve, reject) => {
    const request = http.request(new URL('/v1/agent/request', origin), {
      method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('error', reject)
      response.on('end', () => {
        try { resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks)) }) }
        catch (error) { reject(error) }
      })
    })
    request.on('error', reject)
    request.setTimeout(5000, () => request.destroy(Error('Owned facade fixture did not answer')))
    request.end('{}')
  })
}

test('actual before-quit refuses loopback remote work while host cleanup is pending, without disconnecting', async () => {
  const { context, events, persisted, exitRecords, beforeQuit, shutdownPromise, release } = quittingMain()
  const dispatches = []
  const facade = createAgentFacade({
    surface: {
      commands: Object.keys(COMMANDS),
      sessionLoad: () => ({ open: 0, max: 1 }),
      run: async command => { dispatches.push(command); return { ok: true } },
    },
    principalForRelay: context.relayPrincipal,
    log() {},
  })
  try {
    const { origin, token } = await facade.listen()
    assert.equal(context.relayMachineIsEnrolled(), true)
    assert.equal(context.relayPrincipal().mayWrite, true)
    assert.equal((await post(origin, token)).status, 200, 'the owned test connection works before quit')
    assert.deepEqual(exitRecords, [], 'nothing writes an exit record before a quit is asked for')
    beforeQuit()
    // T180: the reason a quit ran has to outlive the process that ran it, so
    // the record is written on the way in -- before the gate can preventDefault
    // and before any cleanup that might never finish.
    assert.deepEqual(exitRecords, [['before-quit', 'app-quit-gate']])
    assert.equal(context.appShutdown.complete, false)
    assert.ok(shutdownPromise())
    const stopped = await post(origin, token)
    assert.equal(stopped.status, 400, 'a pending closeAll must not leave the remote command door open')
    assert.equal(stopped.body.error.code, 'MC_AGENT_CONNECTION_CLOSED')
    assert.deepEqual(dispatches, ['agent:request'], 'no second action was dispatched after quit began')
    assert.throws(context.relayPrincipal, error => error.code === 'MC_AGENT_CONNECTION_CLOSED')
    assert.equal(context.relayMachineIsEnrolled(), false)
    assert.deepEqual(persisted, { enrolled: true, drive: 'on', blocked: false, writes: 0 })
    beforeQuit()
    assert.equal(events.filter(value => value === 'host-close').length, 1, 'a repeated quit does not duplicate host cleanup')
    assert.deepEqual(exitRecords, [['before-quit', 'app-quit-gate'], ['before-quit', 'app-quit-gate']],
      'every quit attempt is recorded, including one the gate refuses, or the trail hides the attempt that mattered')
    release()
    await shutdownPromise()
    assert.equal(context.appShutdown.complete, true)
    assert.equal(context.agentHost, null)
    assert.ok(events.includes('privacy-complete'), 'all current host cleanup must complete')
    assert.equal(context.appShutdown.snapshot().agents, 'settled', 'an incomplete host fixture must not masquerade as successful closure')
    assert.equal(events.filter(value => value === 'quit').length, 1)
    assert.deepEqual(persisted, { enrolled: true, drive: 'on', blocked: false, writes: 0 })
  } finally {
    release()
    await shutdownPromise()
    await facade.close()
  }
})

test('actual before-quit closes admission before voice cleanup and either early return', async () => {
  const untouched = { enrolled: true, drive: 'on', blocked: false, writes: 0 }

  /* No agent host to wait for. The coordinator's onBegin closes admission and
     then calls voiceHost.close(), so the ordering this case exists to protect
     is observed there.

     The observation is RECORDED and asserted afterwards rather than asserted
     inside the callback. main.cjs wraps that call as
     `try { voiceHost.close() } catch { }`, and the coordinator wraps the whole
     of onBegin the same way, so an AssertionError thrown from inside would be
     swallowed twice and the case would pass without checking anything. Same two
     assertions, somewhere they can actually fail. */
  {
    const { context, persisted, beforeQuit, shutdownPromise } = quittingMain({ host: false })
    let observed = null
    context.voiceHost.close = () => {
      let principalCode = null
      try { context.relayPrincipal() } catch (error) { principalCode = error.code }
      observed = { principalCode, enrolled: context.relayMachineIsEnrolled() }
    }
    beforeQuit()
    assert.ok(observed, 'voice cleanup must run on the quit path')
    assert.equal(observed.principalCode, 'MC_AGENT_CONNECTION_CLOSED')
    assert.equal(observed.enrolled, false)
    await shutdownPromise()
    assert.equal(context.appShutdown.complete, true, 'a quit with no agent host settles without waiting on one')
    assert.deepEqual(persisted, untouched)
  }

  /* Already complete: the genuine early return. The r9 handler returned before
     creating its shutdown promise; the coordinator returns before preventDefault
     and before onBegin, which is the same refusal to start a second shutdown. */
  {
    const fixture = quittingMain({ complete: true })
    const { context, events, persisted, beforeQuit } = fixture
    await fixture.reachComplete()
    let voiceCloses = 0
    context.voiceHost.close = () => { voiceCloses += 1 }
    assert.equal(beforeQuit(), undefined, 'a completed shutdown early-returns')
    assert.equal(voiceCloses, 0, 'a completed shutdown does not begin cleanup again')
    assert.deepEqual(events, [], 'no preventDefault and no second cleanup after completion')
    assert.deepEqual(persisted, untouched)
  }
})

test('actual facade arming cannot restore a bearer when ordinary quit wins the await', async () => {
  const { context, persisted, beforeQuit, shutdownPromise, release } = quittingMain()
  let resolveListen
  let closes = 0
  let listens = 0
  context.agentFacade = {
    listen() { listens += 1; return new Promise(resolve => { resolveListen = resolve }) },
    async close() { closes += 1 },
  }
  try {
    const arming = context.armRelayFacade()
    beforeQuit()
    resolveListen({ origin: 'http://127.0.0.1:1', token: 'disposable-quit-fixture' })
    assert.equal(await arming, false)
    assert.equal(context.relayFacadeCredentials, null)
    assert.equal(closes, 1)
    assert.equal(await context.armRelayFacade(), false)
    assert.equal(listens, 1, 'no new facade listen is admitted while quitting')
    assert.deepEqual(persisted, { enrolled: true, drive: 'on', blocked: false, writes: 0 })
  } finally {
    release()
    await shutdownPromise()
  }
})

test('actual relay event ingress drops late events after ordinary quit begins', async () => {
  const { context, beforeQuit, shutdownPromise, release } = quittingMain()
  const events = []
  context.agentFacade = { emit: packet => events.push(packet) }
  const emit = callback('emitRelayEvent: ', 'function getAgentCommandSurface()', context, '    ')
  beforeQuit()
  try {
    context.agentSessions.set('late', { owner: context.RELAY_OWNER })
    emit({ sessionId: 'late' })
    assert.deepEqual(events, [])
  } finally {
    release()
    await shutdownPromise()
  }
})
