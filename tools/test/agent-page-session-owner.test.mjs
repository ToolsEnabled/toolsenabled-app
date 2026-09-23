import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import test from 'node:test'

import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { resetLiveSessionForTest, liveSessionFor } from '../../src/agent-session-registry.js'

register('./css-loader.mjs', import.meta.url)
const { roleBindingForAgentProjection } = await import('../../src/views/agent.js')
const agentViewSource = readFileSync(new URL('../../src/views/agent.js', import.meta.url), 'utf8')

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

function roleSnapshot() {
  return {
    state: 'ready',
    org: {
      revision: 17,
      agents: [{ id: 'agent-1', displayName: 'Agent One', role: 'reviewer', provider: 'codex' }],
      relationships: [],
    },
    roles: [{ id: 'reviewer', revision: 9, name: 'Reviewer' }],
  }
}

test('the Agent page derives only authoritative role identity and exact revisions', () => {
  const snapshot = roleSnapshot()
  assert.deepEqual(roleBindingForAgentProjection(snapshot, 'agent-1', 'reviewer'), {
    agentId: 'agent-1',
    id: 'reviewer',
    expectedOrgRevision: 17,
    expectedRoleRevision: 9,
  })

  assert.equal(roleBindingForAgentProjection(snapshot, 'agent-1', 'old-role'), null,
    'a stale projected assignment must not be rebound using current revisions')
  assert.equal(roleBindingForAgentProjection({ ...snapshot, roles: [] }, 'agent-1', 'reviewer'), null,
    'a missing authoritative role must fail closed')
  assert.equal(roleBindingForAgentProjection({ ...snapshot, org: { ...snapshot.org, revision: -1 } }, 'agent-1', 'reviewer'), null,
    'an invalid organisation revision must fail closed')
})

test('the named Agent-page composer is wired to the mounted session owner, not a private bridge path', () => {
  assert.doesNotMatch(agentViewSource, /agentBridge\.(?:start|send|close)\s*\(/,
    'the page regained a second direct session lifecycle beside the mounted owner')
  assert.match(agentViewSource, /roleBinding:\s*projection\.roleBinding\s*\|\|\s*null/)
  assert.match(agentViewSource, /requireRoleBinding:\s*true/)
  assert.match(agentViewSource, /onSessionEnd:\s*\(\{ sessionId, code \}\)\s*=>/,
    'the page does not release its pending composer when its one owner terminalizes')
  /* `send(text` and not `send(text)`. What this case exists to catch is the
     page growing a SECOND way to talk to the agent -- a private bridge path
     beside the mounted lifecycle owner -- and the assertion above
     (doesNotMatch agentBridge.(start|send|close)) is the fence that catches
     it. Requiring the call to have exactly one argument pinned a SPELLING
     rather than that property, and it went red the day the composer began
     handing the owner the pasted image alongside the words: the pin forbade
     the picture from being sent at all, and the fastest way back to green
     would have been to drop the picture. The property is unchanged and still
     required: the composer's send goes through agentSessionController, with
     the person's words as its first argument. */
  assert.match(agentViewSource, /await agentSessionController\.send\(text\b/,
    'the composer no longer sends through the lifecycle owner')
})

async function mountedOwner({
  start = null,
  close = async () => ({ closed: true }),
  interrupt = async () => ({ ok: true }),
  send = null,
  roleBinding = roleBindingForAgentProjection(roleSnapshot(), 'agent-1', 'reviewer'),
} = {}) {
  const { document, restore } = installDomStandIn(globalThis)
  const store = new Map([['mc.write.agent-session', 'enabled']])
  globalThis.localStorage = {
    getItem: key => store.get(key) ?? null,
    setItem: (key, value) => { store.set(key, String(value)) },
    removeItem: key => { store.delete(key) },
  }
  let eventListener = null
  let controller = null
  const endings = []
  const calls = []
  let turn = 0
  const ownerContext = Object.freeze({
    version: 1,
    ownerId: 'agent-page-owner-fixture',
    currentEpoch: 'agent-page-owner-epoch',
    kind: 'local',
  })
  const ownerListeners = new Set()
  let recovery = null
  let recoverySerial = 0
  const bridge = {
    availability: async () => ({ ok: true }),
    confinement: async () => ({ ok: true, tier: 'standard' }),
    ownerContext: async () => ownerContext,
    onOwnerContextChanged: listener => {
      ownerListeners.add(listener)
      return () => ownerListeners.delete(listener)
    },
    onEvent: listener => { eventListener = listener; return () => { eventListener = null } },
    start: async value => {
      calls.push(['start', value])
      const started = typeof start === 'function'
        ? await start(value)
        : { sessionId: value.sessionId }
      if (!value.recoveryId) return started
      assert.ok(recovery, 'the recovery start must follow an ended-register receipt')
      assert.equal(value.recoveryId, recovery.recoveryId)
      assert.equal(value.sessionId, recovery.sessionId)
      return {
        ...started,
        ok: started?.ok ?? true,
        sessionId: value.sessionId,
        recovery: { ...recovery },
      }
    },
    imageQueue: async request => {
      if (request.operation === 'ended-register') {
        assert.deepEqual(request.ownerContext, ownerContext)
        const serial = ++recoverySerial
        recovery = {
          recoveryId: `owner-recovery-${serial}`,
          sourceSessionId: request.sourceSessionId,
          sessionId: `owner-successor-${serial}`,
          conversationId: 'agent-1',
          ownerContext,
        }
        calls.push(['ended-register', request])
        return { ok: true, result: { ...recovery } }
      }
      if (request.operation === 'binding') {
        return {
          ok: true,
          result: { sessionId: request.sessionId, conversationId: 'agent-1', ownerContext },
        }
      }
      if (request.operation === 'read') {
        return {
          ok: true,
          result: {
            version: 1,
            entries: [],
            automaticSend: false,
            generation: 'empty-queue',
            destinationSessionId: null,
          },
        }
      }
      return { ok: false, code: 'TEST_IMAGE_QUEUE_UNAVAILABLE' }
    },
    send: async value => {
      calls.push(['send', value])
      return typeof send === 'function'
        ? send(value)
        : { sessionId: value.sessionId, turnId: `turn-${++turn}` }
    },
    close: async value => { calls.push(['close', value]); return close(value) },
    interrupt: async value => { calls.push(['interrupt', value]); return interrupt(value) },
  }
  const root = document.createElement('div')
  document.body.appendChild(root)
  const { mountAgentSessionSurface } = await import('../../src/agent-session.js')
  const dispose = mountAgentSessionSurface(root, {
    live: true,
    agentId: 'agent-1',
    bridge,
    roleBinding,
    requireRoleBinding: true,
    onController: value => { controller = value },
    onSessionEnd: value => { endings.push(value) },
  })
  await tick()
  return { calls, controller: () => controller, dispose, endings, restore, root, emit: packet => eventListener?.(packet), roleBinding }
}

test('a retired owner completing its close cannot erase the next page session', async (t) => {
  resetLiveSessionForTest()
  let releaseClose
  const predecessor = await mountedOwner({
    close: () => new Promise(resolve => { releaseClose = () => resolve({ closed: true }) }),
  })
  let successor = null
  t.after(async () => {
    releaseClose?.()
    successor?.dispose()
    await tick()
    successor?.restore()
    predecessor.restore()
  })
  const first = await predecessor.controller().send('the first page')
  predecessor.emit({ sessionId: first.sessionId, event: { type: 'turn_completed', turnId: 'turn-1', status: 'completed' } })
  predecessor.dispose()
  await tick()
  assert.equal(typeof releaseClose, 'function', 'the old route must be waiting on its actual close')

  successor = await mountedOwner()
  const second = await successor.controller().send('the newly opened page')
  assert.equal(liveSessionFor('agent-1')?.sessionId, second.sessionId)

  releaseClose()
  await tick()
  assert.equal(liveSessionFor('agent-1')?.sessionId, second.sessionId,
    'a late close from the retired page removed Pause, Respawn, and Terminate for the new session')
})

test('an outgoing page event cannot reclaim the new page session during route overlap', async (t) => {
  resetLiveSessionForTest()
  const predecessor = await mountedOwner()
  const first = await predecessor.controller().send('the outgoing page')
  const successor = await mountedOwner()
  t.after(async () => {
    predecessor.dispose()
    successor.dispose()
    await tick()
    successor.restore()
    predecessor.restore()
  })
  const second = await successor.controller().send('the incoming page')
  predecessor.emit({ sessionId: first.sessionId, event: { type: 'turn_completed', turnId: 'turn-1', status: 'completed' } })
  assert.equal(liveSessionFor('agent-1')?.sessionId, second.sessionId,
    'the inert outgoing page reclaimed the steering mapping before its route retirement timer fired')
  predecessor.dispose()
  await tick()
  assert.equal(liveSessionFor('agent-1')?.sessionId, second.sessionId)
})

test('a named Agent-page session cannot start without an authoritative role binding', async () => {
  resetLiveSessionForTest()
  const panel = await mountedOwner({ roleBinding: null })
  const result = await panel.controller().send('must not run generically')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'AGENT_SESSION_NOT_READY')
  assert.equal(panel.calls.some(([name]) => name === 'start'), false,
    'the bridge was allowed to start a named agent without its saved role directions')
  panel.dispose()
  panel.restore()
})

test('one controller owns Agent-page start, continued sends, steering, and close', async () => {
  resetLiveSessionForTest()
  const panel = await mountedOwner()
  const controller = panel.controller()
  assert.equal(typeof controller?.send, 'function', 'the named session surface did not publish its message controller')

  const first = await controller.send('first turn')
  assert.equal(first.ok, true)
  const mapped = liveSessionFor('agent-1')
  assert.equal(mapped?.sessionId, first.sessionId, 'the Controls mapping does not target the composer session')
  assert.deepEqual(panel.calls[0], ['start', { sessionId: first.sessionId, roleBinding: panel.roleBinding }],
    'start did not carry the exact authoritative role identity and revisions')
  assert.deepEqual(panel.calls[1], ['send', { sessionId: first.sessionId, text: 'first turn' }])

  panel.emit({ sessionId: first.sessionId, event: { type: 'turn_completed', turnId: 'turn-1', status: 'completed' } })
  await tick()
  const second = await controller.send('second turn')
  assert.equal(second.sessionId, first.sessionId, 'continuing the chat opened a second private session')
  assert.equal(panel.calls.filter(([name]) => name === 'start').length, 1, 'continuing the chat started another child')
  assert.deepEqual(panel.calls.at(-1), ['send', { sessionId: first.sessionId, text: 'second turn' }])

  panel.emit({ sessionId: first.sessionId, event: { type: 'turn_completed', turnId: 'turn-2', status: 'completed' } })
  await controller.terminate()
  assert.deepEqual(panel.calls.at(-1), ['close', { sessionId: first.sessionId }],
    'Terminate did not close the same session the composer used')
  assert.equal(liveSessionFor('agent-1'), null, 'the steering mapping survived its owner closing')
  panel.dispose()
  panel.restore()
})

test('an injected host exit terminalizes the owner once and permits a fresh session', async () => {
  resetLiveSessionForTest()
  const panel = await mountedOwner()
  const controller = panel.controller()
  const first = await controller.send('work until the process exits')

  const terminalPacket = {
    sessionId: first.sessionId,
    event: { type: 'session_ended', reason: 'exited', exit: { code: 0, signal: null } },
  }
  panel.emit(terminalPacket)
  assert.equal(liveSessionFor('agent-1'), null, 'the dead session remained targetable from Controls')
  assert.equal(panel.root.querySelector('[data-session-status]').dataset.state, 'refused',
    'exit code zero was incorrectly painted as a successful live session')
  assert.match(panel.root.querySelector('[data-session-status]').textContent, /ended/i)

  panel.emit(terminalPacket)
  assert.equal(panel.endings.length, 1, 'a duplicate terminal packet terminalized the owner twice')
  assert.equal((await controller.terminate()).code, 'MC_AGENT_SESSION_ENDED',
    'a later control lost the named ended-session outcome')
  assert.equal(panel.calls.some(([name]) => name === 'close'), false,
    'the renderer tried to close a process the host had already observed exit')

  const restarted = await controller.send('start fresh')
  assert.equal(restarted.ok, true)
  assert.notEqual(restarted.sessionId, first.sessionId)
  assert.equal(panel.calls.filter(([name]) => name === 'start').length, 2,
    'recovery created something other than one fresh session through the same owner')
  panel.dispose()
  panel.restore()
})

test('an exit racing the start receipt cannot revive or send through the terminal session', async () => {
  resetLiveSessionForTest()
  let releaseStart
  const panel = await mountedOwner({
    start: value => new Promise(resolve => { releaseStart = () => resolve({ sessionId: value.sessionId }) }),
  })
  const sending = panel.controller().send('race the start receipt')
  await tick()
  const sessionId = panel.calls.find(([name]) => name === 'start')?.[1]?.sessionId
  assert.ok(sessionId)

  panel.emit({ sessionId, event: { type: 'session_ended', reason: 'exited', exit: { code: null, signal: 'SIGTERM' } } })
  releaseStart()
  const result = await sending
  assert.equal(result.code, 'MC_AGENT_SESSION_ENDED',
    'a child exit during start was mislabeled as a person-requested stop')
  assert.equal(liveSessionFor('agent-1'), null)
  assert.equal(panel.calls.some(([name]) => name === 'send'), false,
    'a late start receipt revived the terminal owner and sent a turn')
  assert.equal(panel.endings.length, 1)
  panel.dispose()
  panel.restore()
})

test('an exit racing an accepted send receipt cannot report the dead session as started', async () => {
  resetLiveSessionForTest()
  let releaseSend
  const panel = await mountedOwner({
    send: value => new Promise(resolve => {
      releaseSend = () => resolve({ sessionId: value.sessionId, turnId: 'turn-race' })
    }),
  })
  const sending = panel.controller().send('race the send receipt')
  await tick()
  const sessionId = panel.calls.find(([name]) => name === 'send')?.[1]?.sessionId
  assert.ok(sessionId)

  panel.emit({ sessionId, event: { type: 'session_ended', reason: 'exited', exit: { code: 17, signal: null } } })
  releaseSend()
  const result = await sending
  assert.equal(result.ok, false)
  assert.equal(result.code, 'MC_AGENT_SESSION_ENDED')
  assert.equal(result.sessionId, sessionId, 'the ended run lost its durable identity')
  assert.equal(liveSessionFor('agent-1'), null, 'the late send receipt revived the dead Controls target')
  assert.match(panel.root.querySelector('[data-session-status]').textContent, /ended/i,
    'the late send receipt overwrote the terminal state')

  panel.dispose()
  panel.restore()
})

test('an exit racing a continued-turn receipt cannot report the dead session as open', async () => {
  resetLiveSessionForTest()
  let sendCount = 0
  let releaseContinue
  const panel = await mountedOwner({
    send: value => {
      sendCount += 1
      if (sendCount === 1) return { sessionId: value.sessionId, turnId: 'turn-1' }
      return new Promise(resolve => {
        releaseContinue = () => resolve({ sessionId: value.sessionId, turnId: 'turn-2' })
      })
    },
  })
  const controller = panel.controller()
  const first = await controller.send('first turn')
  panel.emit({ sessionId: first.sessionId, event: { type: 'turn_completed', turnId: 'turn-1', status: 'completed' } })

  const continuing = controller.send('race a later turn')
  await tick()
  panel.emit({ sessionId: first.sessionId, event: { type: 'session_ended', reason: 'exited', exit: { code: 23, signal: null } } })
  releaseContinue()
  const result = await continuing
  assert.equal(result.ok, false)
  assert.equal(result.code, 'MC_AGENT_SESSION_ENDED')
  assert.equal(result.sessionId, first.sessionId)
  assert.equal(liveSessionFor('agent-1'), null)
  assert.match(panel.root.querySelector('[data-session-status]').textContent, /ended/i,
    'the late continued-turn receipt repainted a dead session as open')

  panel.dispose()
  panel.restore()
})

test('an exit racing a rejected close stays terminal and never re-enables dead controls', async () => {
  resetLiveSessionForTest()
  let rejectClose
  const panel = await mountedOwner({
    close: () => new Promise((_resolve, reject) => {
      rejectClose = () => reject(new Error('MC_AGENT_UNKNOWN_SESSION'))
    }),
  })
  const controller = panel.controller()
  const first = await controller.send('finish before close answers')
  panel.emit({ sessionId: first.sessionId, event: { type: 'turn_completed', turnId: 'turn-1', status: 'completed' } })

  const stopping = controller.terminate()
  await tick()
  panel.emit({ sessionId: first.sessionId, event: { type: 'session_ended', reason: 'exited', exit: { code: null, signal: 'SIGTERM' } } })
  rejectClose()
  const result = await stopping
  assert.equal(result.ok, true, 'teardown was reported failed even though the host proved the process ended')
  assert.equal(result.ended, true)
  assert.equal(result.code, 'MC_AGENT_SESSION_ENDED')
  assert.equal(liveSessionFor('agent-1'), null)
  assert.match(panel.root.querySelector('[data-session-status]').textContent, /ended/i,
    'the close rejection replaced the terminal state with a live-looking refusal')
  assert.equal(panel.root.querySelector('[data-session-stop]').disabled, true,
    'Stop was re-enabled for a process the host proved dead')

  panel.dispose()
  panel.restore()
})

test('controller refusals recover codes from Electron-style Error.message', async () => {
  resetLiveSessionForTest()
  let sendCount = 0
  const panel = await mountedOwner({
    interrupt: async () => { throw new Error('MC_AGENT_UNKNOWN_SESSION') },
    close: async () => { throw new Error('AGENT_SESSION_CLEANUP_FAILED') },
    send: async value => {
      sendCount += 1
      if (sendCount > 1) throw new Error('MC_AGENT_SESSION_ENDED')
      return { sessionId: value.sessionId, turnId: 'turn-1' }
    },
  })
  const controller = panel.controller()
  const first = await controller.send('keep working')

  const paused = await controller.pause()
  assert.equal(paused.code, 'MC_AGENT_UNKNOWN_SESSION', 'Pause discarded the code transported in Error.message')
  panel.emit({ sessionId: first.sessionId, event: { type: 'turn_completed', turnId: 'turn-1', status: 'completed' } })
  const continued = await controller.send('continue after the host ended it')
  assert.equal(continued.code, 'MC_AGENT_SESSION_ENDED', 'Send discarded the ended-session code transported in Error.message')
  const stopped = await controller.terminate()
  assert.equal(stopped.code, 'AGENT_SESSION_CLEANUP_FAILED', 'Terminate discarded the close refusal transported in Error.message')

  panel.dispose()
  panel.restore()
})
