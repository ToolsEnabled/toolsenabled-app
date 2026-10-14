/* A START THE COMPUTER IS TOO BUSY FOR SAYS SO, AND TRIES AGAIN BY ITSELF.
 *
 * T289. Worker 82, page 2: a start held by the resource guard sat SIX MINUTES
 * across eight manual attempts with no progress shown and no retry. I saw the
 * same thing on my own window -- the status read "refused · this computer is
 * under heavy load..." and then nothing happened, forever, unless the person
 * pressed send again. A person creating their first agent watches six minutes
 * of apparent nothing and concludes the product is broken. It is the worst
 * thing left for a new user.
 *
 * The guard itself is right: AGENT_RESOURCE_PRESSURE and its siblings are the
 * computer saying "not yet", and starting anyway is how the machine dies. What
 * was wrong is that "not yet" was painted as "no", which are different answers
 * and want different behaviour.
 *
 * SO THE TRANSIENT CODES ARE A LIST, NOT A GUESS. Waiting on a code that will
 * never clear -- an unknown provider, a tier this computer cannot seat -- would
 * be a spinner in front of a permanent refusal, which is worse than the
 * refusal. Only the codes that mean "ask again shortly" are retried; every
 * other refusal keeps the single-attempt behaviour it has always had.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'

const dom = installDomStandIn()
const { mountAgentSessionSurface } = await import('../../src/agent-session.js')
const settle = async (turns = 30) => { for (let i = 0; i < turns; i += 1) await new Promise(resolve => setTimeout(resolve, 0)) }

function refusal(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function world(t, { startResults = [] } = {}) {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const store = new Map([['mc.write.agent-session', 'enabled']])
  globalThis.localStorage = {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)) },
    removeItem: key => { store.delete(key) },
  }
  const starts = []
  const sends = []
  const waits = []
  const bridge = {
    availability: async () => ({ ok: true }),
    confinement: async () => ({ ok: true, tier: 'standard' }),
    onEvent: () => () => {},
    interrupt: async () => ({ ok: true }),
    close: async () => ({ ok: true }),
    start: async value => {
      starts.push(value)
      const next = startResults.shift()
      if (next instanceof Error) throw next
      return { sessionId: value.sessionId }
    },
    send: async value => { sends.push(value); return { turnId: `turn-${sends.length}` } },
  }
  /* The clock is the test's, so a bounded wait of minutes runs in
     milliseconds and the SHAPE of the schedule is what is measured rather
     than a real delay nobody would sit through in a suite. */
  const realTimeout = globalThis.setTimeout
  globalThis.setTimeout = (fn, ms, ...rest) => {
    if (ms >= 1000) { waits.push(ms); return realTimeout(fn, 0, ...rest) }
    return realTimeout(fn, ms, ...rest)
  }
  t.after(() => {
    globalThis.setTimeout = realTimeout
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage)
    else delete globalThis.localStorage
  })
  return { bridge, starts, sends, waits }
}

async function mount(t, env) {
  const root = dom.document.createElement('div')
  dom.document.body.appendChild(root)
  let control = null
  const dispose = mountAgentSessionSurface(root, {
    live: true, agentId: 'held-start', bridge: env.bridge, chatComposer: true,
    chatTitle: 'Agent 1', publishSession: false, onController: next => { control = next },
  })
  t.after(() => { try { dispose?.() } catch { /* already gone */ } })
  await settle()
  assert.ok(control, 'the surface published no controller, so nothing below is measured')
  return { root, control, chat: () => root.querySelector('[data-chat-panel]') }
}

const notes = panel => Array.from(panel.chat().querySelectorAll('.msg'))
  .filter(row => row.className.split(/\s+/).includes('note')).map(row => row.textContent)

test('a start held for load is retried by itself, and the words the person typed are what finally goes', async t => {
  const env = world(t, { startResults: [refusal('AGENT_RESOURCE_PRESSURE'), refusal('AGENT_RESOURCE_PRESSURE')] })
  const panel = await mount(t, env)
  const outcome = await panel.control.send('look at my project')
  await settle()

  assert.equal(outcome.ok, true,
    'THE DEFECT: a start the computer was merely busy for was reported as a failure and never tried again')
  assert.equal(env.starts.length, 3, 'the held start must be retried, and only as many times as it took')
  assert.equal(env.sends.length, 1, 'the turn must be sent exactly once, on the attempt that succeeded')
  assert.equal(env.sends[0].text, 'look at my project', 'the words the person typed were lost between attempts')
  /* EACH ATTEMPT IS A FRESH SESSION. The refused one was closed on the way
     out, and reusing its id would ask the host to adopt a session it has
     already forgotten -- the same rule agent-session-rejected-start-retry
     holds for the manual path. */
  const ids = env.starts.map(request => request.sessionId)
  assert.equal(new Set(ids).size, ids.length, 'a retry reused the session id of a start that was already closed')
  assert.equal(env.sends[0].sessionId, ids[ids.length - 1], 'the turn was sent to something other than the session that opened')
})

test('waiting is said out loud, and it does not read as a refusal', async t => {
  const env = world(t, { startResults: [refusal('AGENT_RESOURCE_PRESSURE')] })
  const panel = await mount(t, env)
  await panel.control.send('start when you can')
  await settle()

  const said = notes(panel).join(' | ')
  assert.notEqual(said, '', 'THE DEFECT: nothing was said while the start waited, which is the six minutes of silence')
  assert.match(said, /wait|again|busy|try/i, 'the sentence must say it is waiting and will try again')
  assert.equal(/refused/i.test(said), false,
    'a wait was painted as a refusal, which is the whole confusion: "not yet" and "no" are different answers')
})

test('the waiting is bounded, and when it gives up it says so and keeps the words', async t => {
  /* Enough refusals to outlast any bound this could reasonably have. */
  const env = world(t, { startResults: Array.from({ length: 40 }, () => refusal('AGENT_RESOURCE_PRESSURE')) })
  const panel = await mount(t, env)
  const outcome = await panel.control.send('never going to fit')
  await settle()

  assert.equal(outcome.ok, false, 'an unbounded wait is not a wait, it is a hang')
  assert.ok(env.starts.length > 1, 'it must have tried more than once before giving up')
  assert.ok(env.starts.length <= 12, `it tried ${env.starts.length} times, which is a retry storm rather than a bound`)
  assert.ok(env.waits.length >= 2, 'the attempts must be spaced, not hammered back to back')
  /* A schedule that backs off, rather than the same gap forever. */
  assert.ok(env.waits[env.waits.length - 1] >= env.waits[0], 'the wait between attempts must not shrink')
  assert.equal(env.sends.length, 0, 'nothing was ever sent, so no turn may have been reported as sent')
})

test('a refusal that will never clear is not waited on at all', async t => {
  /* An unknown provider does not become known by asking again. Spinning here
     would put a wait in front of a permanent answer, which is worse than the
     answer. */
  const env = world(t, { startResults: [refusal('AGENT_TIER_SESSION_ACTOR_UNSUPPORTED')] })
  const panel = await mount(t, env)
  const outcome = await panel.control.send('this cannot work')
  await settle()

  assert.equal(outcome.ok, false)
  assert.equal(env.starts.length, 1,
    'a permanent refusal was retried, so the person waits through a schedule for an answer that cannot change')
  assert.equal(env.waits.length, 0, 'no wait may be scheduled for a refusal that will never clear')
})

test('closing the surface while it waits does not start an agent afterwards', async t => {
  const env = world(t, { startResults: Array.from({ length: 40 }, () => refusal('AGENT_RESOURCE_PRESSURE')) })
  const root = dom.document.createElement('div')
  dom.document.body.appendChild(root)
  let control = null
  const dispose = mountAgentSessionSurface(root, {
    live: true, agentId: 'held-and-closed', bridge: env.bridge, chatComposer: true,
    chatTitle: 'Agent 1', publishSession: false, onController: next => { control = next },
  })
  await settle()
  const pending = control.send('start then go away')
  await settle(4)
  const during = env.starts.length
  dispose()
  await settle(40)
  await pending.catch(() => null)
  assert.ok(env.starts.length <= during + 1,
    `the surface was torn down and kept starting agents: ${during} attempts before, ${env.starts.length} after`)
})
