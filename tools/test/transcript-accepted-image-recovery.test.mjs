/* T1655: an accepted image's descriptor must cross the host acceptance
 * boundary before provider dispatch settles. The bytes remain in the
 * session-owned custody file; the transcript receives only a basename and a
 * measured byte count. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { createAgentHost } from '../../shell/agent-host.cjs'

const require = createRequire(import.meta.url)
const surfaceModule = require('../../shell/agent-command-surface.cjs')
const { createAgentCommandSurface, REQUIRED_DEPS } = surfaceModule
const ENGINE = path.resolve(import.meta.dirname, 'fixtures/dual-engine/src/lib/agent-engine/codex-process.js')
const engineRecorder = require(ENGINE)

const owner = Object.freeze({ id: 't1655-window' })
const principal = Object.freeze({ kind: 'window', owner, mayWrite: true, label: 'T1655 fixture' })

function ipcError(code, message = code) {
  throw Object.assign(new Error(message), { code })
}

function parseSend(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) ipcError('MC_AGENT_INVALID_PAYLOAD')
  for (const key of Object.keys(value)) {
    if (!['sessionId', 'text', 'images'].includes(key)) ipcError('MC_AGENT_INVALID_PAYLOAD')
  }
  if (typeof value.sessionId !== 'string' || !value.sessionId) ipcError('MC_AGENT_INVALID_PAYLOAD')
  if (typeof value.text !== 'string') ipcError('MC_AGENT_INVALID_PAYLOAD')
  return {
    sessionId: value.sessionId,
    text: value.text,
    ...(value.images === undefined ? {} : { images: value.images }),
  }
}

function commandFixture({ imagePath, release }) {
  const calls = []
  const sessions = new Map([['image-session', {
    owner,
    ownerKind: 'window',
    state: 'ready',
    ended: false,
    attachments: new Set([imagePath]),
  }]])
  const host = {
    sendTurn: async request => {
      calls.push(request)
      await release
      return { sessionId: request.sessionId, turnId: 'accepted-command-turn' }
    },
    sendTurnTracked: async request => {
      calls.push(request)
      await release
      return { ok: true, deliveryDisposition: 'accepted', result: { sessionId: request.sessionId, turnId: 'accepted-command-turn' } }
    },
    onAcceptedPrompt: () => {},
  }
  const deps = {}
  for (const [name, kind] of Object.entries(REQUIRED_DEPS)) {
    deps[name] = kind === 'function' ? () => null
      : kind === 'number' ? 128
        : kind === 'string' ? '/tmp/t1655-workspace'
          : {}
  }
  const recorded = []
  Object.assign(deps, {
    agentSessions: sessions,
    currentAgentHost: () => host,
    getAgentHost: () => host,
    agentIpcError: ipcError,
    agentPayload: value => value,
    boundedAgentString: value => value,
    parseAgentSend: parseSend,
    rendererSafeAgentError: error => error,
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    MAX_SESSION_ID_LENGTH: 128,
    AGENT_EFFORT_VALUES: [],
    WORKSPACE_ROOT: '/tmp/t1655-workspace',
    statFile: async requested => {
      assert.equal(requested, imagePath)
      return { size: 23 }
    },
    recordAcceptedTranscriptSend: async value => { recorded.push(value) },
  })
  return { calls, recorded, surface: createAgentCommandSurface(deps) }
}

test('command surface computes the custody descriptor before provider resolution and does not append a duplicate row', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 't1655-command-'))
  const imagePath = path.join(root, 'accepted-frame.png')
  writeFileSync(imagePath, Buffer.alloc(23, 7))
  let release
  const held = new Promise(resolve => { release = resolve })
  const fixture = commandFixture({ imagePath, release: held })
  try {
    const pending = fixture.surface.run('agent:send', {
      sessionId: 'image-session', text: 'Describe this image.', images: [{ path: imagePath }],
    }, principal)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(fixture.calls.length, 1, 'the host must be entered before the provider promise settles')
    assert.deepEqual(fixture.calls[0].acceptedAttachmentSummaries, [{ name: 'accepted-frame.png', bytes: 23 }])
    assert.equal(JSON.stringify(fixture.calls[0].acceptedAttachmentSummaries).includes(root), false, 'the private custody path must not cross descriptor metadata')
    release()
    await pending
    assert.deepEqual(fixture.recorded, [], 'the old second transcript write would duplicate the first accepted boundary')
  } finally {
    console.log('RETAINED_T1655_FIXTURE ' + root)
  }
})

test('host acceptance exposes the sanitized descriptor before sendTurn resolves', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 't1655-host-'))
  const imagePath = path.join(root, 'accepted-frame.png')
  writeFileSync(imagePath, Buffer.alloc(23, 9))
  const priorPlan = process.env.MC_TEST_CONFINEMENT_PLAN
  process.env.MC_TEST_CONFINEMENT_PLAN = JSON.stringify({
    ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {}, servers: [],
  })
  const accepted = []
  let sendResolved = false
  let host
  try {
    t.mock.method(engineRecorder, 'startCodexSession', async options => ({
      threadId: 't1655-thread',
      adapter: {
        transport: { child: { exitCode: null, signalCode: null } },
        sendTurn: async request => {
          assert.deepEqual(request.images, [{ path: imagePath }])
          return { turnId: 'accepted-host-turn' }
        },
        interrupt: async () => {},
        answerApproval: () => {},
      },
      close: () => {},
    }))
    host = createAgentHost({
      enginePath: ENGINE,
      defaultCwd: root,
      startProviderProbe: () => 'codex',
      providerCommandResolver: () => path.join(root, 'not-launched'),
      freeMemory: () => 64 * 1024 ** 3,
    })
    await host.startSession({ sessionId: 'image-session' })
    host.onAcceptedPrompt(prompt => {
      assert.equal(sendResolved, false, 'the descriptor is delivered at acceptance, not after provider completion')
      accepted.push(prompt)
    })
    const result = await host.sendTurn({
      sessionId: 'image-session',
      text: 'Describe this image.',
      origin: 'person',
      images: [{ path: imagePath }],
      acceptedAttachmentSummaries: [{ name: 'accepted-frame.png', bytes: 23 }],
    })
    sendResolved = true
    assert.equal(result.turnId, 'accepted-host-turn')
    assert.equal(accepted.length, 1)
    assert.deepEqual(accepted[0].attachments, [{ name: 'accepted-frame.png', bytes: 23 }])
    assert.ok(Object.isFrozen(accepted[0].attachments))
    assert.equal(JSON.stringify(accepted[0]).includes(root), false, 'the transcript boundary must not expose a private path')
  } finally {
    await host.closeAll()
    if (priorPlan === undefined) delete process.env.MC_TEST_CONFINEMENT_PLAN
    else process.env.MC_TEST_CONFINEMENT_PLAN = priorPlan
    console.log('RETAINED_T1655_FIXTURE ' + root)
  }
})
