/* The public boundary of the Settings controller. Run alone with:
 * node --test tools/test/connect-computer-settings.test.mjs */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  bridgeCanDisconnect,
  createConnectComputerSettings,
  deviceClaimBridge,
  forgetRememberedClaim,
} from '../../src/connect-computer-settings.js'

const NOW = 1_780_000_000_000

function bridge(overrides = {}) {
  return {
    status: async () => ({ ok: true, connected: false }),
    begin: async () => ({ ok: true, code: 'TC-4KQ2-9WFA', expiresAtMs: NOW + 60_000, intervalSeconds: 5 }),
    poll: async () => ({ ok: true, state: 'none' }),
    cancel: async () => ({ ok: true }),
    ...overrides,
  }
}

function controllerFor(claim) {
  return createConnectComputerSettings({
    now: () => NOW,
    resolveBridge: () => claim,
    schedule: () => ({ fake: true }),
    cancelTimer: () => {},
  })
}

test.beforeEach(() => forgetRememberedClaim())

test('bridge detection accepts the four verbs callers provide and keeps disconnect optional', () => {
  const olderInstalledApp = bridge()
  assert.equal(deviceClaimBridge({ deviceClaim: olderInstalledApp }), olderInstalledApp,
    'a bridge with every connection verb is usable without the newer disconnect verb')
  assert.equal(bridgeCanDisconnect(olderInstalledApp), false,
    'an older bridge remains connectable but does not advertise disconnect')

  const incomplete = bridge()
  delete incomplete.poll
  assert.equal(deviceClaimBridge({ deviceClaim: incomplete }), null,
    'a bridge missing a ceremony verb is refused instead of failing during a claim')
})

test('a busy disconnect check is unknown, is not cached, and genuine absence stays absent', async () => {
  const installed = bridge({
    status: async () => ({ ok: true, connected: true }),
    disconnect: async () => ({ ok: true, wasConnected: true }),
  })
  let looks = 0
  const controller = createConnectComputerSettings({
    now: () => NOW,
    resolveBridge: () => {
      looks += 1
      if (looks === 3) throw Object.assign(new Error('file table busy'), { code: 'EMFILE' })
      return installed
    },
    schedule: () => ({ fake: true }),
    cancelTimer: () => {},
  })

  await controller.checkStatus()
  const busyMarkup = controller.markup()
  assert.match(busyMarkup, /data-refusal-code="CONNECT_DISCONNECT_CHECK_FAILED"/,
    'EMFILE has its own could-not-check code instead of becoming no disconnect verb')
  assert.match(busyMarkup, /not a claim that disconnect is unavailable/i,
    'the visible answer explicitly declines to claim absence')
  assert.doesNotMatch(busyMarkup, /data-connect-action="disconnect"/)

  const recoveredMarkup = controller.markup()
  assert.match(recoveredMarkup, /data-connect-action="disconnect"/,
    'the could-not-check result was not cached or latched')

  const older = controllerFor(bridge())
  await older.checkStatus()
  assert.doesNotMatch(older.markup(), /data-connect-disconnect-check-refusal/,
    'a genuine older bridge without the optional verb remains ordinary absence')

  const unknownSource = createConnectComputerSettings({
    now: () => NOW,
    resolveBridge: () => installed,
    readingOverRelay: () => { throw { code: 'EAGAIN' } },
    schedule: () => ({ fake: true }),
    cancelTimer: () => {},
  })
  await unknownSource.checkStatus()
  const unknownSourceMarkup = unknownSource.markup()
  assert.match(unknownSourceMarkup, /data-refusal-code="CONNECT_DATA_SOURCE_CHECK_FAILED"/,
    'EAGAIN while locating the screen has its own could-not-check code')
  assert.match(unknownSourceMarkup, /not a claim that either location applies/i)
  assert.doesNotMatch(unknownSourceMarkup, /data-connect-action="disconnect"/,
    'an unknown location must not expose a local-only destructive control')
  controller.destroy()
  older.destroy()
  unknownSource.destroy()
})

test('an unreadable installed status remains unknown and still offers the safe next action', async () => {
  const controller = controllerFor(bridge({
    status: async () => { throw new Error('DEVICE_VAULT_UNREADABLE') },
  }))

  await controller.checkStatus()
  const state = controller.getState()
  assert.equal(state.phase, 'unknown',
    'a could-not-read answer must not collapse into connected or disconnected')

  const markup = controller.markup()
  assert.match(markup, /could not check whether this computer is joined/i,
    'the status copy tells the person the answer is unknown')
  assert.match(markup, /data-connect-action="begin"/,
    'an unreadable status still offers the supported request-code action')
  assert.doesNotMatch(markup, /DEVICE_VAULT_UNREADABLE/,
    'an internal refusal identifier is not presented as user-facing prose')
  controller.destroy()
})

test('a successful request presents a copy affordance without exposing account secrets', async () => {
  const controller = controllerFor(bridge())
  await controller.begin()

  const markup = controller.markup()
  assert.match(markup, /data-connect-code[^>]*readonly/,
    'the issued code is presented in a selectable read-only control')
  assert.match(markup, /data-connect-action="copy"[^>]*aria-label="[^"]*copy[^"]*"/i,
    'the code has a plainly named keyboard-accessible copy action')
  assert.match(markup, /password[^<]*(never|does not)[^<]*(passes|sent|shared)/i,
    'the instructions distinguish the claim code from the password that stays private')
  controller.destroy()
})

const stopped = { remoteAccessBlocked: true, remoteStopped: true, childQuiescent: true, restartSafety: 'recorded', disconnectPending: false }
const uncertain = { ok: false, code: 'DEVICE_CLAIM_DISCONNECT_FAILED', mutationOutcome: 'UNCERTAIN',
  credentialCleared: false, ...stopped, disconnectPending: true }

test('a blocked startup credential offers status and explicit finish without an automatic poll', async () => {
  const calls = []
  const controller = controllerFor(bridge({
    status: async () => { calls.push('status'); return { ok: true, connected: true, ...stopped, disconnectPending: true } },
    poll: async () => { calls.push('poll'); return { ok: true, state: 'connected' } },
    disconnect: async () => { calls.push('disconnect'); return uncertain },
  }))
  await controller.checkStatus()
  assert.deepEqual(calls, ['status'])
  const html = controller.markup()
  assert.equal(controller.getState().phase, 'disconnect-review')
  assert.match(html, /Check connection status/); assert.match(html, /Finish disconnect/)
  assert.doesNotMatch(html, /data-connect-action="begin"|data-connect-field="web-drive"/)
  assert.doesNotMatch(html, /data-connect-action="check-status" disabled/)
  controller.destroy()
})

test('lost disconnect completion removes joined and Drive claims without scheduling any mutation', async () => {
  const calls = []
  const controller = controllerFor(bridge({
    status: async () => { calls.push('status'); return { ok: true, connected: true } },
    begin: async () => { calls.push('begin'); return { ok: false } },
    poll: async () => { calls.push('poll'); return { ok: true, state: 'connected' } },
    cancel: async () => { calls.push('cancel'); return { ok: true } },
    disconnect: async () => { calls.push('disconnect'); throw Error('Nothing changed. Restart. private-password') },
  }))
  await controller.checkStatus(); await controller.disconnect()
  for (let i = 0; i < 3; i += 1) controller.markup()
  await controller.begin(); await controller.pollOnce(); await controller.cancel({ thenBegin: true })
  assert.deepEqual(calls, ['status', 'disconnect'])
  assert.equal(controller.getState().phase, 'disconnect-review')
  const html = controller.markup()
  assert.doesNotMatch(html, /Nothing changed|Restart|private-password|Try once more|data-connect-field="web-drive"/i)
  assert.match(html, /stop not confirmed/); assert.match(html, /completion not confirmed/)
  assert.match(html, /Keep ToolsEnabled running/); assert.match(html, /Check connection status/)
  assert.equal(controller.isTicking(), false)
  controller.destroy()
})

test('status after an uncertain removal is read-only and does not convert the old write into success', async () => {
  const calls = []
  let result = { ok: true, connected: true }
  const controller = controllerFor(bridge({
    status: async () => { calls.push('status'); return result },
    begin: async () => { calls.push('begin'); return { ok: true, code: 'TC-4KQ2-9WFA', expiresAtMs: NOW + 60000, remoteAccessBlocked: true } },
    poll: async () => { calls.push('poll'); return { ok: true, state: 'none' } },
    cancel: async () => { calls.push('cancel'); return { ok: true } },
    disconnect: async () => { calls.push('disconnect'); return uncertain },
  }))
  await controller.checkStatus(); await controller.disconnect()
  result = { ok: true, connected: false, ...stopped }
  await controller.checkStatus({ readOnly: true })
  assert.deepEqual(calls, ['status', 'disconnect', 'status'])
  assert.equal(controller.getState().phase, 'idle')
  assert.equal(controller.getState().disconnect.mutationOutcome, 'UNCERTAIN')
  assert.equal(controller.getState().disconnect.remoteAccessBlocked, true)
  assert.match(controller.markup(), /data-connect-action="begin"/)
  assert.match(controller.markup(), /earlier credential removal has an uncertain outcome/)
  await controller.begin()
  assert.deepEqual(calls, ['status', 'disconnect', 'status', 'begin'])
  assert.equal(controller.getState().phase, 'waiting')
  assert.match(controller.markup(), /Remote access remains blocked/)
  controller.destroy()
})

test('absence without both process and remote-stop observations cannot offer a fresh code', async () => {
  for (const missing of [{ childQuiescent: false }, { childQuiescent: null }, { remoteStopped: false }, { remoteAccessBlocked: 'true' }]) {
    const controller = controllerFor(bridge({
      status: async () => ({ ok: true, connected: false, ...stopped, ...missing }),
      disconnect: async () => uncertain,
    }))
    await controller.checkStatus()
    assert.equal(controller.getState().phase, 'disconnect-review')
    assert.doesNotMatch(controller.markup(), /data-connect-action="begin"/)
    controller.destroy()
  }
})

test('an earlier status reply cannot restore joined after disconnect started', async () => {
  let answer
  let count = 0
  const controller = controllerFor(bridge({
    status: () => ++count === 1 ? Promise.resolve({ ok: true, connected: true }) : new Promise(resolve => { answer = resolve }),
    disconnect: async () => uncertain,
  }))
  await controller.checkStatus()
  const checking = controller.checkStatus({ readOnly: true })
  await controller.disconnect()
  answer({ ok: true, connected: true })
  await checking
  assert.equal(controller.getState().phase, 'disconnect-review')
  assert.equal(controller.getState().disconnect.mutationOutcome, 'UNCERTAIN')
  controller.destroy()
})

test('static keyring guidance preserves process facts and never prints a backend message', async () => {
  const controller = controllerFor(bridge({
    status: async () => ({ ok: true, connected: true }),
    disconnect: async () => ({ ...uncertain, mutationOutcome: 'NOT_ATTEMPTED', localCause: 'SECRET_BACKEND_LOCKED',
      reason: 'SECRET_BACKEND_LOCKED private-session-address password=private' }),
  }))
  await controller.checkStatus(); await controller.disconnect()
  const html = controller.markup()
  assert.match(html, /Unlock your normal desktop keyring/)
  assert.match(html, /Remote network connection: stopped/)
  assert.match(html, /Local connection processes: finished/)
  assert.match(html, /removal step did not write a change/)
  assert.doesNotMatch(html, /private-session|password=|SECRET_BACKEND_LOCKED/)
  controller.destroy()
})
