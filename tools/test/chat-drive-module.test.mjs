/* tools/lib/chat-drive-lib.mjs — the shared chat driver (B-pool-6 API decision
 * document, module scaffold). Unlike buildChat's own tests, this module
 * needs no DOM at all: `session`/`webContents`/`evaluate`/`delay` are all
 * caller-supplied, so every test here runs the REAL module against
 * lightweight recorders instead of pinning its source text -- these are
 * behavioral tests, not source pins.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CHAT_APPROVAL_SELECTOR, CHAT_COMPOSER_INPUT_SELECTOR, CHAT_SEND_SELECTOR, FLEET_NODE_VISIBLE, createChatPresser, waitForReply } from '../lib/chat-drive-lib.mjs'

const delay = () => Promise.resolve()

/** A CDP session recorder: every `.send(method, params)` call is logged. */
function fakeCdpSession() {
  const calls = []
  return { calls, send: async (method, params) => { calls.push([method, params]) } }
}

/** An Electron webContents recorder. */
function fakeWebContents() {
  const calls = []
  return { calls, sendInputEvent: event => { calls.push(event) } }
}

/** evaluate() that answers FLEET_NODE_VISIBLE calls as immediately visible
 *  at a fixed point, and anything else via a supplied table. */
function fakeEvaluate(extra = {}) {
  const calls = []
  return {
    calls,
    fn: async (expr) => {
      calls.push(expr)
      if (expr.includes('FLEET_NODE_VISIBLE') || expr.startsWith(`(${FLEET_NODE_VISIBLE})`) || /^\(\(selector\)/.test(expr)) {
        return { state: 'visible', x: 10, y: 20 }
      }
      for (const [needle, value] of Object.entries(extra)) {
        if (expr.includes(needle)) return typeof value === 'function' ? value(expr) : value
      }
      return null
    },
  }
}

test('re-exports the composer selectors from src/components.js, and its own send selector', () => {
  assert.equal(CHAT_COMPOSER_INPUT_SELECTOR, '.chat-input input')
  assert.deepEqual(CHAT_APPROVAL_SELECTOR, { accept: '[data-chat-approval="accept"]', decline: '[data-chat-approval="decline"]' })
  assert.equal(CHAT_SEND_SELECTOR, '.chat-send')
  assert.equal(typeof FLEET_NODE_VISIBLE, 'string')
})

test('createChatPresser requires exactly one transport', () => {
  const evaluate = fakeEvaluate().fn
  assert.throws(() => createChatPresser({ evaluate, delay }), /requires either/, 'no transport at all should throw')
  assert.throws(() => createChatPresser({ session: fakeCdpSession(), webContents: fakeWebContents(), evaluate, delay }),
    /exactly one transport/, 'both transports at once should throw')
})

test('the CDP branch presses with the exact mouseMoved/mousePressed/mouseReleased sequence chat-history-drive.mjs proved', async () => {
  const session = fakeCdpSession()
  const evaluate = fakeEvaluate().fn
  const presser = createChatPresser({ session, evaluate, delay })
  const result = await presser.press('.some-button')
  assert.equal(result, 'clicked')
  const kinds = session.calls.map(([method]) => method)
  assert.deepEqual(kinds, ['Input.dispatchMouseEvent', 'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent'],
    'press no longer dispatches exactly the three-event sequence chat-history-drive.mjs\'s own proven press() used -- this is the migration\'s own equivalence contract, not an arbitrary shape')
  assert.equal(session.calls[0][1].type, 'mouseMoved')
  assert.equal(session.calls[1][1].type, 'mousePressed')
  assert.equal(session.calls[2][1].type, 'mouseReleased')
  assert.equal(session.calls[0][1].button, 'none', 'mouseMoved must carry button:none, matching the origin driver')
  assert.equal(session.calls[0][1].clickCount, 0, 'mouseMoved must carry clickCount:0, matching the origin driver')
  assert.equal(session.calls[1][1].button, 'left')
  assert.equal(session.calls[2][1].button, 'left')
})

test('the CDP branch\'s key() takes only a name, and refuses one it does not carry a code for', async () => {
  const session = fakeCdpSession()
  const evaluate = fakeEvaluate().fn
  const presser = createChatPresser({ session, evaluate, delay })
  await presser.key('Enter')
  assert.deepEqual(session.calls.map(([method, params]) => [method, params.type, params.windowsVirtualKeyCode]),
    [['Input.dispatchKeyEvent', 'rawKeyDown', 13], ['Input.dispatchKeyEvent', 'keyUp', 13]],
    'key(\'Enter\') no longer dispatches the real rawKeyDown/keyUp pair with code 13')
  await assert.rejects(() => presser.key('F13'), /does not know "F13"/,
    'an unrecognised key name must refuse rather than dispatch a silently wrong (undefined) key code')
})

test('the CDP branch types via Input.insertText, keyed via typeInto', async () => {
  const session = fakeCdpSession()
  const evaluate = fakeEvaluate().fn
  const presser = createChatPresser({ session, evaluate, delay })
  await presser.typeInto('hello there')
  assert.deepEqual(session.calls, [['Input.insertText', { text: 'hello there' }]])
})

test('the webContents branch presses with real mouseDown/mouseUp sendInputEvent calls, never .click()', async () => {
  const webContents = fakeWebContents()
  const evaluate = fakeEvaluate().fn
  const presser = createChatPresser({ webContents, evaluate, delay })
  const result = await presser.press('.some-button')
  assert.equal(result, 'clicked')
  assert.deepEqual(webContents.calls.map(event => event.type), ['mouseDown', 'mouseUp'])
})

test('the webContents branch types via one \'char\' sendInputEvent per character', async () => {
  const webContents = fakeWebContents()
  const evaluate = fakeEvaluate().fn
  const presser = createChatPresser({ webContents, evaluate, delay })
  await presser.typeInto('hi!')
  assert.deepEqual(webContents.calls, [
    { type: 'char', keyCode: 'h' },
    { type: 'char', keyCode: 'i' },
    { type: 'char', keyCode: '!' },
  ])
})

test('send({viaEnter:true}) presses Enter; send() with no option clicks .chat-send', async () => {
  const session = fakeCdpSession()
  const evaluate = fakeEvaluate().fn
  const presser = createChatPresser({ session, evaluate, delay })

  await presser.send({ viaEnter: true })
  assert.deepEqual(session.calls.map(([method, params]) => [method, params.type]),
    [['Input.dispatchKeyEvent', 'rawKeyDown'], ['Input.dispatchKeyEvent', 'keyUp']],
    'send({viaEnter:true}) did not dispatch a real Enter key pair')

  session.calls.length = 0
  await presser.send()
  assert.deepEqual(session.calls.map(([method]) => method),
    ['Input.dispatchMouseEvent', 'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent'],
    'send() with no option did not click the send button with the full three-event press')
})

test('typeAndVerify types then reads the field back, and reports a mismatch honestly', async () => {
  const session = fakeCdpSession()
  // evaluate answers the read-back with whatever was actually typed, via Input.insertText's own record
  const evaluate = async (expr) => {
    if (expr.includes('FLEET_NODE_VISIBLE') || /^\(\(selector\)/.test(expr)) return { state: 'visible', x: 1, y: 1 }
    if (expr.includes('?.value')) {
      return session.calls.filter(([m]) => m === 'Input.insertText').map(([, p]) => p.text).join('')
    }
    return null
  }
  const presser = createChatPresser({ session, evaluate, delay })

  const result = await presser.typeAndVerify('.chat-input input', 'ok')
  assert.deepEqual(result, { ok: true, landed: 'ok' })
})

test('typeAndVerify reports a mismatch honestly rather than assuming success', async () => {
  const evaluate = async (expr) => (expr.includes('?.value') ? 'something else' : null)
  const presser = createChatPresser({ session: fakeCdpSession(), evaluate, delay })
  const result = await presser.typeAndVerify('.chat-input input', 'ok')
  assert.deepEqual(result, { ok: false, landed: 'something else' })
})

test('waitForReply requires rootSelector, and asks evaluate for the chat log\'s own child count', async () => {
  const evaluate = fakeEvaluate().fn
  await assert.rejects(() => waitForReply(evaluate, {}), /requires rootSelector/, 'waitForReply with no rootSelector should refuse rather than watch nothing')

  const calls = []
  const recordingEvaluate = async expr => { calls.push(expr); return { settled: true, waitedMs: 12, count: 3 } }
  const result = await waitForReply(recordingEvaluate, { rootSelector: '[data-rail-chat-host]', sinceCount: 2, quietMs: 300, timeoutMs: 9000 })
  assert.deepEqual(result, { settled: true, waitedMs: 12, count: 3 })
  assert.equal(calls.length, 1)
  assert.match(calls[0], /\[data-rail-chat-host\]/, 'the root selector never reached the evaluated expression')
  assert.match(calls[0], /\.chat-log/, 'the chat log selector never reached the evaluated expression')
  assert.match(calls[0], /,\s*2,\s*300,\s*9000\)/, 'sinceCount/quietMs/timeoutMs were not passed through in order')
})

test('waitForReply is also reachable off the returned presser, bound to the same evaluate', async () => {
  const calls = []
  const evaluate = async expr => { calls.push(expr); return { settled: false, waitedMs: 9000, count: 0 } }
  const presser = createChatPresser({ session: fakeCdpSession(), evaluate, delay })
  const result = await presser.waitForReply({ rootSelector: '[data-chat-panel]', sinceCount: 0 })
  assert.equal(result.settled, false, 'a reply that never arrived must not be reported as settled')
  assert.equal(calls.length, 1)
})

test('chat presser exposes bounded adaptive timing and input telemetry', async () => {
  const session = fakeCdpSession()
  const evaluate = fakeEvaluate().fn
  const presser = createChatPresser({
    session, evaluate, delay,
    timing: { visiblePollMs: 20, pressQuietMs: 10, pressBudgetMs: 50 },
  })
  assert.equal(presser.timing.visiblePollMs, 20)
  assert.equal(presser.timing.pressQuietMs, 10)
  assert.ok(presser.timing.pressBudgetMs <= 10_000)
  await presser.press('.some-button')
  await presser.typeInto('ok')
  const metrics = presser.metrics()
  assert.deepEqual(metrics.map(item => item.kind), ['press', 'type'])
  assert.equal(metrics[1].chars, 2)
  metrics.push({ kind: 'fake' })
  assert.equal(presser.metrics().length, 2, 'telemetry must be returned as a snapshot')
})

test('invalid timing overrides are ignored and extreme values are bounded', () => {
  const presser = createChatPresser({
    session: fakeCdpSession(), evaluate: fakeEvaluate().fn, delay,
    timing: { visiblePollMs: -1, pressBudgetMs: 99_999, keyQuietMs: 'bad' },
  })
  assert.equal(presser.timing.visiblePollMs, 80)
  assert.equal(presser.timing.keyQuietMs, 100)
  assert.equal(presser.timing.pressBudgetMs, 10_000)
})

for (const transport of ['CDP', 'webContents']) {
  test(`${transport} chat telemetry bounds history and distinguishes quiet from exhausted waits`, async () => {
    const options = transport === 'CDP' ? { session: fakeCdpSession() } : { webContents: fakeWebContents() }
    let exhausted = false
    const evaluate = async () => ({ waitedMs: exhausted ? 500 : 80, settled: !exhausted, reason: exhausted ? 'budget' : 'quiet' })
    const presser = createChatPresser({ ...options, evaluate, delay })
    await presser.typeInto('ready')
    assert.equal(presser.metrics()[0].settled, true)
    assert.equal(presser.metrics()[0].reason, 'quiet')
    exhausted = true
    for (let i = 0; i < 260; i++) await presser.typeInto('x'.repeat(i + 1))
    const metrics = presser.metrics()
    assert.equal(metrics.length, 256)
    assert.equal(metrics[0].chars, 5)
    assert.equal(metrics.at(-1).chars, 260)
    assert.ok(metrics.every(row => row.waitedMs === 500 && !row.settled && row.reason === 'budget'))
    metrics[0].reason = 'quiet'
    assert.equal(presser.metrics()[0].reason, 'budget')
  })
}
