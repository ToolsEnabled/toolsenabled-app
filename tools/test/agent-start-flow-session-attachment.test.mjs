import assert from 'node:assert/strict'
import { register } from 'node:module'
import test, { beforeEach } from 'node:test'
import { useStartConsent } from './lib/start-consent-fixture.mjs'

beforeEach(t => { useStartConsent(t) })

/* computers.js owns browser stylesheets; this loader keeps the isolated proof
   on JavaScript behavior while every production JavaScript dependency still
   loads normally. */
register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.css')) return { url: new URL(specifier, context.parentURL).href, shortCircuit: true }
    return nextResolve(specifier, context)
  }
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`), import.meta.url)

const { startAgentForNode } = await import('../../src/views/computers.js')

function useBridge(t, bridge) {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete globalThis.window
  })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { mcAgent: bridge } })
}

test('a broker start carries only its opaque request identity to native admission', async t => {
  const requestId = 'tnc-11111111-1111-4111-8111-111111111111'
  useBridge(t, { async start(request) {
    assert.equal(request.treeCommandRequestId, requestId)
    assert.equal(Object.hasOwn(request, 'expiresAt'), false, 'the renderer cannot supply the native deadline')
    return { ok: true, sessionId: 'command-child' }
  }, async send() { return { ok: true } } })
  const result = await startAgentForNode({ text: 'Fictional task.', surface: 'fleet-tree', treeCommandRequestId: requestId })
  assert.equal(result.ok, true)
  assert.equal(result.sessionId, 'command-child')
})

test('delegated start attaches and acknowledges the root without awaiting a child first turn, and reports later failure', async t => {
  const order = []; const failures = []
  let finish
  const turn = new Promise(resolve => { finish = resolve })
  useBridge(t, {
    async start(request) { assert.equal(request.delegationToken, 'one-use'); return { ok: true, sessionId: 'delegated-root' } },
    send() { order.push('send'); return turn },
  })
  const result = await startAgentForNode({ text: 'Spawn your own child and do real work.',
    surface: 'fleet-tree', delegationToken: 'one-use',
    onSessionOpen() { order.push('attach') }, onFirstTurnFailure(outcome) { failures.push(outcome) } })
  assert.equal(result.ok, true)
  assert.equal(result.sessionId, 'delegated-root')
  assert.equal(result.firstTurnState, 'submitted', 'root readiness is not completed work')
  assert.deepEqual(order, ['attach', 'send'])
  assert.deepEqual(failures, [])
  finish({ ok: false, code: 'AGENT_SESSION_BUSY' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(failures.length, 1)
  assert.equal(failures[0].sessionId, 'delegated-root')
  assert.equal(failures[0].ok, false)
})

test('host launchSettings is exact on normal and immediate success paths and callback, without legacy effort synthesis', async t => {
  const receipt = { schemaVersion: 1, sessionId: 'host-session', threadId: null, provider: 'codex', model: 'host-model', effort: 'high', source: 'host-launch-configuration' }
  const normalCallback = []
  useBridge(t, {
    async start() { return { ok: true, sessionId: 'normal-session', effort: 'low', launchSettings: receipt } },
    async send() { return { ok: true } },
  })
  const normal = await startAgentForNode({ text: 'normal', surface: 'fleet-tree', effort: 'minimal',
    onSessionOpen: payload => normalCallback.push(payload) })
  assert.strictEqual(normal.launchSettings, receipt)
  assert.strictEqual(normalCallback[0].launchSettings, receipt)
  assert.equal(normal.launchSettings.effort, 'high')
  const immediateCallback = []
  let release
  const pending = new Promise(resolve => { release = resolve })
  useBridge(t, {
    async start() { return { ok: true, sessionId: 'immediate-session', effort: 'low', launchSettings: receipt } },
    send() { return pending },
  })
  const immediate = await startAgentForNode({ text: 'immediate', surface: 'fleet-tree', effort: 'minimal',
    delegationToken: 'one-use', onSessionOpen: payload => immediateCallback.push(payload) })
  assert.strictEqual(immediate.launchSettings, receipt)
  assert.strictEqual(immediateCallback[0].launchSettings, receipt)
  release({ ok: true })
  await new Promise(resolve => setImmediate(resolve))
  useBridge(t, {
    async start() { return { ok: true, sessionId: 'legacy-session', effort: 'host-only' } },
    async send() { return { ok: true } },
  })
  const legacy = await startAgentForNode({ text: 'legacy', surface: 'fleet-tree', effort: 'requested-only' })
  assert.equal(Object.hasOwn(legacy, 'launchSettings'), false)
})
for (const state of [null, 'disabled', 'true', true]) {
  test(`actual start helper honors the saved setting or declared default (${String(state)})`, async t => {
    globalThis.localStorage.getItem = () => state
    useBridge(t, {
      start: () => { assert.equal(state, null, 'disabled start crossed IPC'); return { ok: true, sessionId: 'default-enabled' } },
      send: () => { assert.equal(state, null, 'disabled start sent a turn'); return { ok: true } },
    })
    const result = await startAgentForNode({ text: 'Retain this brief.', surface: 'fleet-tree' })
    if (state === null) {
      assert.equal(result.ok, true, 'an unset start preference uses the declared enabled default')
      assert.equal(result.sessionId, 'default-enabled')
    } else {
      assert.equal(result.ok, false)
      assert.equal(result.code, 'MC_TREE_COMMAND_START_DISABLED')
      assert.equal(result.sessionId, null)
    }
  })
}

test('actual start helper fails closed on unreadable consent', async t => {
  globalThis.localStorage.getItem = () => { throw new Error('unreadable') }
  useBridge(t, { start: () => assert.fail('unreadable consent crossed IPC'), send() {} })
  const result = await startAgentForNode({ text: 'Retain this brief.', surface: 'fleet-tree' })
  assert.equal(result.code, 'MC_TREE_COMMAND_START_DISABLED')
})

test('consent turned off after host dispatch keeps the opened session attached', async t => {
  const order = []
  useBridge(t, {
    async start() {
      globalThis.localStorage.getItem = () => null
      return { ok: true, sessionId: 'already-opened' }
    },
    async send() { order.push('send'); return { ok: true } },
  })
  const result = await startAgentForNode({ text: 'Authorized before dispatch.', surface: 'fleet-tree',
    onSessionOpen: ({ sessionId }) => { assert.equal(sessionId, 'already-opened'); order.push('attach') },
  })
  assert.equal(result.ok, true)
  assert.equal(result.sessionId, 'already-opened')
  assert.deepEqual(order, ['attach', 'send'])
})

for (const returned of [false, true]) {
  test(`failed startup cleanup keeps the client-known Stop target (${returned ? 'returned' : 'IPC rejection'})`, async t => {
    let requestId = null
    let releaseStart
    const pendingStart = new Promise(resolve => { releaseStart = resolve })
    const cleanupTargets = []
    const opened = []
    const sent = []
    useBridge(t, {
      async start(request) {
        requestId = request.sessionId
        await pendingStart
        if (returned) return { ok: false, code: 'AGENT_SESSION_CLEANUP_FAILED' }
        // Electron retains the message but strips error.code and sessionId.
        throw new Error("Error invoking remote method 'mc-agent-start': Error: AGENT_SESSION_CLEANUP_FAILED")
      },
      async send(request) { sent.push(request) },
    })
    const pending = startAgentForNode({
      text: 'This turn must never be sent.',
      surface: 'fleet-tree',
      onSessionOpen: session => opened.push(session),
      onCleanupRequired: session => cleanupTargets.push(session),
    })
    releaseStart()
    const result = await pending
    assert.equal(typeof requestId, 'string', 'the renderer must name the request before IPC can lose the receipt')
    assert.ok(requestId.length > 0)
    assert.equal(result.sessionId, requestId, 'Stop must target the exact failed start, not a replacement ID')
    assert.equal(result.ok, false)
    assert.equal(result.cleanupPending, true)
    assert.equal(result.code, 'AGENT_SESSION_CLEANUP_FAILED')
    assert.deepEqual(cleanupTargets, [{ sessionId: requestId, code: 'AGENT_SESSION_CLEANUP_FAILED' }])
    assert.deepEqual(opened, [], 'cleanup ownership is not a successful start')
    assert.deepEqual(sent, [], 'an unconfirmed start cannot receive the initial turn')
  })
}

test('an ordinary failed start does not become a retained cleanup or a running session', async t => {
  const retained = []
  const opened = []
  useBridge(t, {
    async start({ sessionId }) { return { ok: false, code: 'AGENT_ACCOUNT_UNAVAILABLE',
      startOutcome: { requestSessionId: sessionId, custody: 'none', admission: 'not-admitted', cleanup: 'not-required' } } },
    async send() { assert.fail('failed start sent a turn') },
  })
  const result = await startAgentForNode({
    text: 'Not sent.', surface: 'fleet-tree',
    onCleanupRequired: session => retained.push(session),
    onSessionOpen: session => opened.push(session),
  })
  assert.equal(result.ok, false)
  assert.equal(result.sessionId, null)
  assert.notEqual(result.cleanupPending, true)
  assert.deepEqual(retained, [])
  assert.deepEqual(opened, [])
})

test('a successful start exposes its exact session before send and can attach the node as running', async (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete globalThis.window
  })

  const sessionNodeIds = new Map()
  const node = { id: 'qa-node' }
  const attached = []
  const statuses = []
  const order = []
  const store = {
    attachSession(nodeId, sessionId) {
      assert.equal(sessionNodeIds.get(sessionId), nodeId)
      attached.push([nodeId, sessionId])
      order.push('attached')
      return { ok: true }
    },
    setNodeStatus(nodeId, status) {
      statuses.push([nodeId, status])
      order.push(`status:${status}`)
      return { ok: true }
    },
  }

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      mcAgent: {
        async start(request) {
          order.push('start')
          assert.deepEqual(request.roleBinding, {
            id: 'release-scribe', expectedOrgRevision: 7, expectedRoleRevision: 4,
          })
          assert.equal(Object.hasOwn(request.roleBinding, 'directions'), false,
            'renderer-authored directions crossed the start boundary')
          return {
            sessionId: 'qa-session-positive',
            threadId: 'qa-thread-positive',
            account: 'work-account',
            roleIntroduction: 'TOOLSENABLED ROLE DIRECTIONS\nRole: Release scribe',
          }
        },
        async send(request) {
          order.push('send')
          assert.deepEqual(request, { sessionId: 'qa-session-positive', text: 'Safe isolated proof.' })
          assert.deepEqual(attached, [[node.id, 'qa-session-positive']],
            'send ran before the node carried the successful session id')
          assert.deepEqual(statuses, [[node.id, 'running']],
            'send ran before the attached node looked running')
          return { ok: true }
        },
      },
    },
  })

  const result = await startAgentForNode({
    text: 'Safe isolated proof.',
    surface: 'fleet-tree',
    tier: 'guided',
    effort: 'medium',
    roleBinding: { id: 'release-scribe', expectedOrgRevision: 7, expectedRoleRevision: 4 },
    onSessionOpen: ({ sessionId, threadId, account, roleIntroduction }) => {
      assert.equal(sessionId, 'qa-session-positive')
      assert.equal(threadId, 'qa-thread-positive')
      assert.equal(account, 'work-account')
      assert.equal(roleIntroduction, 'TOOLSENABLED ROLE DIRECTIONS\nRole: Release scribe')
      sessionNodeIds.set(sessionId, node.id)
      const attachedResult = store.attachSession(node.id, sessionId)
      assert.equal(attachedResult.ok, true)
      store.setNodeStatus(node.id, 'running')
    },
  })

  assert.deepEqual(result, {
    ok: true,
    needsApp: false,
    sessionId: 'qa-session-positive',
    threadId: 'qa-thread-positive',
    account: 'work-account',
    roleIntroduction: 'TOOLSENABLED ROLE DIRECTIONS\nRole: Release scribe',
    code: null,
    sentence: null,
    needsAssistantProgram: false,
  })
  assert.deepEqual(order, ['start', 'attached', 'status:running', 'send'])
})

test('a start receipt already marked ended is never exposed as live and receives no first turn', async (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete globalThis.window
  })

  let opened = 0
  let sent = 0
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      mcAgent: {
        async start() {
          return {
            sessionId: 'qa-ended-before-receipt',
            threadId: 'qa-thread-ended',
            ended: true,
            endCode: 'MC_AGENT_SESSION_ENDED',
          }
        },
        async send() { sent += 1; return { ok: true } },
      },
    },
  })

  const result = await startAgentForNode({
    text: 'must never be sent',
    surface: 'fleet-tree',
    onSessionOpen: () => { opened += 1 },
  })

  assert.equal(result.ok, false)
  assert.equal(result.sessionEnded, true)
  assert.equal(result.sessionId, 'qa-ended-before-receipt', 'the durable run id was discarded')
  assert.equal(result.code, 'MC_AGENT_SESSION_ENDED')
  assert.equal(opened, 0, 'a terminal receipt was registered in the live tree map')
  assert.equal(sent, 0, 'a turn was sent through a session already reported ended')
})

test('an exit racing the first send cannot repaint the dead tree session as successful', async (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete globalThis.window
  })

  let live = false
  let ended = 0
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      mcAgent: {
        async start() { return { sessionId: 'qa-exit-during-send', threadId: 'qa-thread-race' } },
        async send() {
          /* The real onEvent listener removes the runtime mapping before this
             acknowledgement can resume the start caller. */
          live = false
          return { ok: true, turnId: 'qa-turn-race' }
        },
      },
    },
  })

  const result = await startAgentForNode({
    text: 'race the process exit',
    surface: 'fleet-tree',
    onSessionOpen: () => { live = true },
    sessionIsOpen: () => live,
    onSessionEnd: () => { ended += 1 },
  })

  assert.equal(result.ok, false)
  assert.equal(result.sessionEnded, true)
  assert.equal(result.code, 'MC_AGENT_SESSION_ENDED')
  assert.equal(ended, 1)
})

test('an immediate unknown-session send after a start is classified as a dead start, not a live refused turn', async (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete globalThis.window
  })

  let ended = null
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      mcAgent: {
        async start() { return { sessionId: 'qa-unknown-after-start' } },
        async send() { throw new Error('MC_AGENT_UNKNOWN_SESSION') },
      },
    },
  })

  const result = await startAgentForNode({
    text: 'send after an unobserved early exit',
    surface: 'fleet-tree',
    onSessionEnd: value => { ended = value },
  })

  assert.equal(result.ok, false)
  assert.equal(result.sessionEnded, true)
  assert.equal(result.code, 'MC_AGENT_UNKNOWN_SESSION')
  assert.deepEqual(ended, { sessionId: 'qa-unknown-after-start', code: 'MC_AGENT_UNKNOWN_SESSION' })
})
