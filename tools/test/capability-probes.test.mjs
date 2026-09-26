/* The setup and settings surfaces both consume this cache.  These tests keep
 * the three-valued answer intact: a failed reading is not evidence that a
 * capability is missing, while the two explicit bridge/Codex verdicts remain
 * useful to the caller. */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CAPABILITY_PROBE_EVENT,
  probe,
  probeState,
  refreshCapabilityProbes,
  resetCapabilityProbes,
} from '../../src/capability-probes.js'
import { resetBridgeSession, setBridgeTransport } from '../../src/mission-bridge.js'

const originalAgent = globalThis.mcAgent
const originalWindow = globalThis.window
const originalCustomEvent = globalThis.CustomEvent

test.afterEach(() => {
  resetCapabilityProbes()
  setBridgeTransport(null)
  resetBridgeSession()
  if (originalAgent === undefined) delete globalThis.mcAgent
  else globalThis.mcAgent = originalAgent
  if (originalWindow === undefined) delete globalThis.window
  else globalThis.window = originalWindow
  if (originalCustomEvent === undefined) delete globalThis.CustomEvent
  else globalThis.CustomEvent = originalCustomEvent
})

function bridgeAnswer(answer) {
  setBridgeTransport(async () => answer)
}

test('another ready provider never proves the Codex capability', async () => {
  for (const readyProvider of ['local', 'claude', 'gemini', 'grok', 'antigravity']) {
    for (const codexCode of ['AGENT_CODEX_CLI_NOT_INSTALLED', 'AGENT_CONFINEMENT_SIGNED_OUT']) {
      resetCapabilityProbes()
      globalThis.mcAgent = { availability: async () => ({ ok: true, code: 'AGENT_ENGINE_READY', readyProvider, codexCode }) }
      bridgeAnswer({ ok: true })
      assert.equal((await refreshCapabilityProbes())['codex-installed'], false)
    }
  }
})

test('the public lookup preserves an unanswered capability before and after reset', () => {
  resetCapabilityProbes()
  assert.equal(probeState('codex-installed'), undefined,
    'an unread capability must stay unanswered, not become definitely missing')
  assert.equal(probe('not-a-declared-capability'), undefined,
    'the probe function real guidance callers receive must preserve an unknown id as unanswered')
})

test('refresh publishes explicit successful readings but leaves the unimplemented cloud reading unanswered', async () => {
  globalThis.mcAgent = { availability: async () => ({ ok: true }) }
  bridgeAnswer({ ok: true })

  const events = []
  globalThis.window = { dispatchEvent: event => { events.push(event); return true } }
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, init) { this.type = type; this.detail = init.detail }
  }

  const result = await refreshCapabilityProbes()

  assert.deepEqual(result, {
    'codex-installed': true,
    'audited-connection': true,
    'codex-cloud-account': undefined,
  }, 'refresh must report only capabilities that its read-only calls actually verified')
  assert.equal(probe('codex-installed'), true,
    'the guidance caller must see the verified Codex reading in the cache')
  assert.equal(events.length, 1, 'one completed refresh must announce exactly one cache change')
  assert.equal(events[0].type, CAPABILITY_PROBE_EVENT,
    'the refresh announcement must use the exported capability-change event')
  assert.equal(Object.isFrozen(events[0].detail), true,
    'listeners must receive an immutable, data-free announcement rather than unverified answers')
})

test('refresh records the two explicit negative verdicts real bridges return', async () => {
  for (const code of ['AGENT_CODEX_CLI_NOT_INSTALLED', 'AGENT_CONFINEMENT_SIGNED_OUT']) {
    resetCapabilityProbes()
    globalThis.mcAgent = { availability: async () => ({ ok: false, code }) }
    bridgeAnswer({ ok: false, code: 'BRIDGE_UNREACHABLE', reason: 'offline' })

    const result = await refreshCapabilityProbes()

    assert.equal(result['codex-installed'], false,
      `the documented ${code} verdict must remain a definite negative reading`)
    assert.equal(result['audited-connection'], false,
      'an explicit unreachable bridge verdict must remain a definite negative reading')
  }
})

test('failed or ambiguous Codex reads never collapse into a definite answer', async () => {
  bridgeAnswer({ ok: true })
  const replies = [
    null,
    { ok: 'yes' },
    { ok: false, code: 'AGENT_FOLDER_NOT_ALLOWED' },
  ]

  for (const reply of replies) {
    resetCapabilityProbes()
    globalThis.mcAgent = { availability: async () => reply }
    await refreshCapabilityProbes()
    assert.equal(probeState('codex-installed'), undefined,
      `an ambiguous Codex reply ${JSON.stringify(reply)} must stay unanswered, not become missing`)
  }

  resetCapabilityProbes()
  globalThis.mcAgent = { availability: async () => { throw new Error('bridge did not answer') } }
  await refreshCapabilityProbes()
  assert.equal(probeState('codex-installed'), undefined,
    'a Codex availability call that could not be read must stay unanswered')
})

test('simultaneous surface mounts share one reading and receive the same result', async () => {
  let codexReads = 0
  let bridgeReads = 0
  let releaseCodex
  globalThis.mcAgent = { availability: () => {
    codexReads += 1
    return new Promise(resolve => { releaseCodex = resolve })
  } }
  setBridgeTransport(async () => { bridgeReads += 1; return { ok: true } })

  const first = refreshCapabilityProbes()
  const second = refreshCapabilityProbes()
  assert.strictEqual(second, first,
    'concurrent callers must share the exact in-flight promise rather than pay for duplicate reads')
  releaseCodex({ ok: true })
  const [firstResult, secondResult] = await Promise.all([first, second])

  assert.strictEqual(secondResult, firstResult,
    'callers sharing a refresh must receive the same immutable snapshot')
  assert.equal(codexReads, 1, 'concurrent surface mounts must make one Codex availability call')
  assert.equal(bridgeReads, 1, 'concurrent surface mounts must make one bridge reachability call')
  assert.equal(Object.isFrozen(firstResult), true,
    'a caller must not be able to rewrite the shared capability snapshot')
})
