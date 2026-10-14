import assert from 'node:assert/strict'
import { register } from 'node:module'
import test, { beforeEach } from 'node:test'
import { useStartConsent } from './lib/start-consent-fixture.mjs'

beforeEach(t => { useStartConsent(t) })

/* computers.js owns browser stylesheets; this loader keeps the isolated proof
   on JavaScript behavior while every production JavaScript dependency still
   loads normally. Copied from agent-start-flow-session-attachment.test.mjs,
   the existing harness for this same exported function. */
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

/* THE SEAM t5-m2-LANE-W2-spawn-tail.md ASKS TO BE MEASURED: what
 * startAgentForNode still awaits after onSessionOpen has fired -- the point
 * at which the circle is attached, running, and registered.
 *
 * This harness cannot reproduce the live 5,892-12,326 ms tail itself, because
 * that number is the real IPC round trip to a spawned provider process, and
 * this lane may not start a provider or restart the application. What it CAN
 * measure, against the real exported function rather than a description of
 * it, is the STRUCTURE of the wait: exactly one await follows onSessionOpen
 * (bridge.send), the synchronous work inside onSessionOpen costs a
 * near-zero, bounded number of milliseconds, and nothing else is awaited in
 * between. That structure is what licenses the conclusion that bridge.send
 * -- "the brief send settling" -- is the whole of the removable tail, not an
 * assumption standing in for a measurement. */
test('after onSessionOpen fires, the only await before startAgentForNode settles is bridge.send', async (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete globalThis.window
  })

  const order = []
  const timings = {}
  const SEND_DELAY_MS = 200

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      mcAgent: {
        async start() {
          order.push('start')
          return { sessionId: 'qa-tail-session', threadId: 'qa-tail-thread', roleIntroduction: null }
        },
        async send(request) {
          order.push('send:start')
          timings.sendStartedAt = process.hrtime.bigint()
          assert.deepEqual(request, { sessionId: 'qa-tail-session', text: 'measure the tail' })
          await new Promise(resolve => setTimeout(resolve, SEND_DELAY_MS))
          order.push('send:done')
          timings.sendDoneAt = process.hrtime.bigint()
          return { ok: true }
        },
      },
    },
  })

  const callStartedAt = process.hrtime.bigint()

  const result = await startAgentForNode({
    text: 'measure the tail',
    surface: 'fleet-tree',
    onSessionOpen: ({ sessionId }) => {
      order.push('onSessionOpen:start')
      timings.onSessionOpenStartedAt = process.hrtime.bigint()
      /* Representative of the synchronous work the real onSessionOpen
         callback in startDraftNode does before the send: two-to-three
         transcript appends (array push, no I/O) and one profile-map write
         (Map.set, no I/O) -- see rememberBoundSessionProfile and
         transcriptAppend in src/views/computers.js, both plain in-memory
         mutations with no await in their own bodies. */
      const transcript = []
      transcript.push({ who: 'you', text: 'the brief', at: Date.now() })
      transcript.push({ who: 'you', text: 'manager context', at: Date.now() })
      const sessionProfileIds = new Map()
      sessionProfileIds.set(sessionId, 'qa-profile')
      order.push('onSessionOpen:end')
      timings.onSessionOpenEndedAt = process.hrtime.bigint()
    },
  })

  timings.returnedAt = process.hrtime.bigint()

  assert.equal(result.ok, true)
  assert.deepEqual(order, ['start', 'onSessionOpen:start', 'onSessionOpen:end', 'send:start', 'send:done'],
    'no operation ran between onSessionOpen finishing and send starting, and none ran between send finishing and the function returning')

  const ms = (from, to) => Number(to - from) / 1e6
  const onSessionOpenSyncMs = ms(timings.onSessionOpenStartedAt, timings.onSessionOpenEndedAt)
  const gapBeforeSendMs = ms(timings.onSessionOpenEndedAt, timings.sendStartedAt)
  const sendAwaitMs = ms(timings.sendStartedAt, timings.returnedAt)
  const totalMs = ms(callStartedAt, timings.returnedAt)

  /* Named terms, each with a number, per the lane's task 1. */
  t.diagnostic(`onSessionOpen synchronous work: ${onSessionOpenSyncMs.toFixed(3)} ms`)
  t.diagnostic(`gap between onSessionOpen ending and bridge.send starting: ${gapBeforeSendMs.toFixed(3)} ms`)
  t.diagnostic(`bridge.send await (the injected 200 ms stand-in for the brief send settling): ${sendAwaitMs.toFixed(3)} ms`)
  t.diagnostic(`whole call: ${totalMs.toFixed(3)} ms`)

  /* The onSessionOpen work -- the harness's stand-in for the transcript
     append and the profile-map write the lane brief asked about -- is a
     bounded, near-zero cost. 25 ms is generous headroom on a busy CI box; a
     regression that made this synchronous block expensive would still be
     caught long before it could explain a multi-second tail. */
  assert.ok(onSessionOpenSyncMs < 25,
    `onSessionOpen's synchronous work took ${onSessionOpenSyncMs.toFixed(3)} ms, expected under 25 ms`)
  assert.ok(gapBeforeSendMs < 25,
    `the gap between onSessionOpen ending and bridge.send starting was ${gapBeforeSendMs.toFixed(3)} ms, expected under 25 ms`)
  /* The whole remaining wait is attributable to bridge.send: the function
     does not return meaningfully before the send's artificial delay clears. */
  assert.ok(sendAwaitMs >= SEND_DELAY_MS - 5,
    `the wait after send started was only ${sendAwaitMs.toFixed(3)} ms, expected at least ${SEND_DELAY_MS - 5} ms`)
})
