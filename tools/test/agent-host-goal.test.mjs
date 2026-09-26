/* DOES A GOAL ACTUALLY MAKE THE AGENT WORK ON ITS OWN? (T61)
 *
 * The defect these close is a `/goal` that recorded a queue row and left an
 * IDLE agent -- so the assertion that matters is not "the goal was stored",
 * it is "a turn the person did not send arrived at the provider". Every test
 * here drives the host's own poll and then reads what the fake adapter
 * RECEIVED, which is the only evidence that separates a loop that ran from a
 * loop that would have.
 *
 * PROVIDER-INDEPENDENCE IS TESTED BY RUNNING THE SAME BODY TWICE, once on a
 * Codex-tier session and once on a Claude-tier one, against an adapter that
 * offers no goal API of any kind. That is the acceptance point the previous
 * native-only build could not meet: its own gate answered "This agent
 * provider does not support native goals. Use a Codex agent."
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { createAgentHost } from '../../shell/agent-host.cjs'
import { testScratchRoot } from '../lib/test-scratch-root.mjs'

const require = createRequire(import.meta.url)
const ENGINE = fileURLToPath(new URL('./fixtures/confined-engine/src/lib/agent-engine/codex-process.js', import.meta.url))
const engine = require(ENGINE)
/* The SAME offline fixture's Claude entry point. A Claude-tier session starts
   through startClaudeSession, not startCodexSession, so a test that mocked
   only the latter would silently be measuring one provider twice. */
const CLAUDE_ENGINE = fileURLToPath(new URL('./fixtures/confined-engine/src/lib/agent-engine/claude-cli-process.js', import.meta.url))
const claudeEngine = require(CLAUDE_ENGINE)
const goalRules = require(path.resolve(import.meta.dirname, '..', '..', 'shell', 'session-goal.cjs'))

const ACHIEVED = goalRules.GOAL_ACHIEVED_MARKER
const BLOCKED = goalRules.GOAL_BLOCKED_MARKER

/* A STANDING-RULES LEDGER THE TEST CAN EDIT BETWEEN TURNS.
 *
 * The host composes the rules block by READING this on every turn
 * (composeStandingRequestsNote in agent-host.cjs), so changing `entries` here
 * between two turns is exactly what the person editing their Ledger page does
 * between two turns. That is the only way to tell a turn that REFRESHED the
 * rules from a turn that merely carries the ones it was started with -- and
 * telling those apart is the whole of acceptance point 5.
 *
 * Implements the three members standingRequestLayers() and
 * standingRequestLayerLines() actually call, and nothing else; a fuller fake
 * would be asserting the shape of the real module rather than the behaviour
 * under test. */
function rulesStore(initial) {
  const store = {
    entries: initial,
    ledger: {
      SCOPE_WORD: { global: 'every agent' },
      ledgerPath: scope => `/fixture/${scope}.jsonl`,
      readLedger: scope => ({
        path: `/fixture/${scope}.jsonl`,
        exists: scope === 'global',
        entries: scope === 'global' ? store.entries : [],
        warnings: [],
      }),
    },
  }
  return store
}

/* A CONTROLLABLE CLOCK AND A CONTROLLABLE POLL, injected through the host's
   own options. Nothing here waits on wall clock: `advance` moves the clock
   past the turn boundary the host requires and then runs the poll the host
   registered, which is exactly what the real 5-second interval does. */
function fixture(t, { provider = null, rules = null, tasks = null, authority = null, toolContext = false, continuation = null } = {}) {
  const scratch = testScratchRoot('.toolsenabled-host-goal')
  mkdirSync(scratch, { recursive: true })
  const cwd = mkdtempSync(path.join(scratch, 'run-'))
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null })

  const sent = []
  let emit = () => {}
  let turnSeq = 0
  let clock = 1_000_000
  const polls = new Set()

  const adapter = {
    transport: { child },
    /* NO getGoal/setGoal/clearGoal. This adapter is every provider that has
       no native goal API, which includes the Claude tiers the owner runs. */
    sendTurn: async request => {
      turnSeq += 1
      sent.push(request)
      return { turnId: `turn-${turnSeq}` }
    },
    interrupt: async () => {},
    answerApproval() {},
  }

  const started = async options => {
    emit = options.onEvent
    return { threadId: 'thread-1', adapter, close() {} }
  }
  t.mock.method(engine, 'startCodexSession', started)
  if (typeof claudeEngine.startClaudeSession === 'function') {
    t.mock.method(claudeEngine, 'startClaudeSession', started)
  }

  const host = createAgentHost({
    enginePath: ENGINE,
    defaultCwd: cwd,
    profileRoot: process.platform === 'win32' ? os.homedir() : path.parse(cwd).root,
    freeMemory: () => 64 * 1024 * 1024 * 1024,
    confinementPlanner: () => ({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {}, ...(toolContext ? { servers: ['fixture-tools'] } : {}) }),
    now: () => clock,
    goalPollTimer: { set: fn => { polls.add(fn); return { unref() {} } }, clear: () => polls.clear() },
    /* Only when a test is about the standing rules. Absent, the host loads
       the real one out of the engine payload and finds nothing, which is the
       world every other test here wants. */
    ...(rules ? { rLedgerLoader: () => rules.ledger } : {}),
    ...(tasks ? { ownerRequestStoreLoader: () => tasks } : {}),
    ...(authority ? { sessionAuthority: authority } : {}),
    ...(continuation ? { ledgerContinuationLoader: () => ({ createLedgerContinuation: () => continuation }) } : {}),
  })
  const packets = []
  host.onEvent(packet => packets.push(packet))
  t.after(async () => {
    await host.closeAll()
    if (process.env.TOOLSENABLED_TEST_RETAIN_FIXTURES === '1') console.log('RETAINED_GOAL_FIXTURE ' + cwd)
    else rmSync(cwd, { recursive: true, force: true })
  })

  const api = {
    host,
    adapter,
    emit: event => emit(event),
    sent,
    packets,
    provider,
    /* The agent speaks, then its turn ends. One helper because every test
       needs the pair and a test that emitted only one of them would be
       measuring a state the product never reaches. */
    async turnEnds(text, { status = 'completed' } = {}) {
      if (text !== null) emit({ type: 'assistant_text_delta', text, turnId: `turn-${turnSeq}` })
      emit({ type: 'turn_completed', status, turnId: `turn-${turnSeq}` })
      await Promise.resolve()
    },
    /* Move past the boundary the host insists on, then run its poll. */
    async advance(ms = 6000) {
      clock += ms
      for (const poll of polls) poll()
      await new Promise(resolve => setImmediate(resolve))
      await new Promise(resolve => setImmediate(resolve))
    },
    goal: () => host.readGoal({ sessionId: 'circle' }).goal,
  }
  return api
}

async function start(api, provider) {
  await api.host.startSession({ sessionId: 'circle', ...(provider ? { tier: provider } : {}) })
  return api
}

test('a goal sends the objective straight away and then starts the NEXT turn with nobody asking', async t => {
  const f = await start(fixture(t))
  const result = await f.host.setGoal({ sessionId: 'circle', objective: 'make the suite green' })

  assert.equal(result.goal.objective, 'make the suite green')
  assert.equal(result.goal.status, 'active')
  assert.equal(f.sent.length, 1, 'the objective goes to the provider as the person\'s own first turn')
  assert.ok(f.sent[0].text.startsWith('make the suite green'),
    'the agent is told what to do, not merely that a goal exists')

  await f.turnEnds('I fixed one test. More to do.')
  assert.equal(f.sent.length, 1, 'nothing starts inside the turn boundary the person\'s queue owns')

  await f.advance()
  assert.equal(f.sent.length, 2, 'THE DEFECT: before this, an agent with a goal sat idle here')
  assert.equal(f.goal().continuations, 1, 'and the self-started turn is counted as self-started')
  assert.match(f.sent[1].text, /self-started turn 1\b/)
})

test('one completed turn starts exactly ONE continuation, however often the poll runs', async t => {
  const f = await start(fixture(t))
  await f.host.setGoal({ sessionId: 'circle', objective: 'keep going' })
  await f.turnEnds('working')

  await f.advance()
  assert.equal(f.sent.length, 2)
  /* THE OVERLAP THE POLL MUST NOT CAUSE. The continuation started above has
     not completed, so every later poll must find the session busy and do
     nothing. A second turn here would be two turns at once. */
  await f.advance()
  await f.advance()
  assert.equal(f.sent.length, 2, 'a poll during a live turn must not start a second one')
  assert.equal(f.goal().continuations, 1)
})

test('the agent reports the goal achieved and nothing further starts', async t => {
  const f = await start(fixture(t))
  await f.host.setGoal({ sessionId: 'circle', objective: 'tidy up' })
  await f.turnEnds('still going')
  await f.advance()
  assert.equal(f.sent.length, 2)

  await f.turnEnds(`All tidy.\n\n${ACHIEVED}`)
  assert.equal(f.goal().status, 'achieved')

  await f.advance()
  await f.advance()
  assert.equal(f.sent.length, 2, 'an achieved goal must never start another turn')

  const said = f.packets.map(packet => packet.event?.text || '').join(' ')
  assert.match(said, /goal achieved/i, 'and the person is told in plain words, in the conversation')
})

test('an agent that only TALKS about the marker keeps working', async t => {
  const f = await start(fixture(t))
  await f.host.setGoal({ sessionId: 'circle', objective: 'ship it' })
  await f.turnEnds(`I will write ${ACHIEVED} once the build passes.`)
  await f.advance()
  assert.equal(f.goal().status, 'active', 'a promise to finish is not finishing')
  assert.equal(f.sent.length, 2)
})

test('an agent that says it is stuck stops the goal rather than repeating itself', async t => {
  const f = await start(fixture(t))
  await f.host.setGoal({ sessionId: 'circle', objective: 'deploy' })
  await f.turnEnds(`I need the deploy key.\n${BLOCKED}`)
  assert.equal(f.goal().status, 'blocked')
  await f.advance()
  assert.equal(f.sent.length, 1, 'a blocked goal must not keep spending turns')
})

test('a turn that failed pauses the goal instead of being retried on a timer', async t => {
  const f = await start(fixture(t))
  await f.host.setGoal({ sessionId: 'circle', objective: 'build' })
  await f.turnEnds('boom', { status: 'failed' })
  assert.equal(f.goal().status, 'paused')
  assert.equal(f.goal().objective, 'build', 'the objective is kept so the person can resume it')
  await f.advance()
  assert.equal(f.sent.length, 1)
})

test('Stop ends the goal between turns, and the agent starts nothing afterwards', async t => {
  const f = await start(fixture(t))
  await f.host.setGoal({ sessionId: 'circle', objective: 'long job' })
  await f.turnEnds('turn one done')
  await f.advance()
  assert.equal(f.sent.length, 2)
  await f.turnEnds('turn two done')

  /* BETWEEN TURNS IS EXACTLY WHEN A PERSON PRESSES STOP on a goal -- there is
     no spinner to stop, only the next turn to prevent. Before this, Stop with
     no turn in flight refused with AGENT_TURN_NONE. */
  const stopped = await f.host.interrupt({ sessionId: 'circle' })
  assert.equal(stopped.goalPaused, true)
  assert.equal(f.goal().status, 'paused')

  await f.advance()
  await f.advance()
  assert.equal(f.sent.length, 2, 'Stop means no more turns start on their own')
  const said = f.packets.map(packet => packet.event?.text || '').join(' ')
  assert.match(said, /Stopped\./, 'and the person is told so in the conversation')
})

test('Stop mid-turn also ends the goal', async t => {
  const f = await start(fixture(t))
  await f.host.setGoal({ sessionId: 'circle', objective: 'long job' })
  await f.turnEnds('one')
  await f.advance()
  assert.equal(f.sent.length, 2, 'a self-started turn is now running')

  await f.host.interrupt({ sessionId: 'circle' })
  assert.equal(f.goal().status, 'paused')
  await f.advance()
  assert.equal(f.sent.length, 2)
})

test('clearing the goal ends it and says so', async t => {
  const f = await start(fixture(t))
  await f.host.setGoal({ sessionId: 'circle', objective: 'something' })
  await f.turnEnds('ok')
  const cleared = f.host.clearGoal({ sessionId: 'circle' })
  assert.equal(cleared.cleared, true)
  assert.equal(f.goal(), null)
  await f.advance()
  assert.equal(f.sent.length, 1, 'a cleared goal starts nothing')
  assert.match(cleared.sentence, /cleared/i)
})

test('a goal continues beyond the former eight-turn boundary until achieved', async t => {
  const f = await start(fixture(t))
  await f.host.setGoal({ sessionId: 'circle', objective: 'endless' })
  for (let continuation = 0; continuation < 9; continuation += 1) {
    await f.turnEnds('still going')
    await f.advance()
  }
  assert.equal(f.goal().continuations, 9,
    'the Goal-only cap must not pause the work at the old eight-turn boundary')
  assert.equal(f.sent.length, 10, 'one person turn plus nine self-started turns')
  assert.equal(f.goal().status, 'active')

  await f.turnEnds(`finished\n\n${ACHIEVED}`)
  assert.equal(f.goal().status, 'achieved', 'the actual achieved ending still stops Goal')
  await f.advance()
  assert.equal(f.sent.length, 10, 'an achieved Goal never starts another turn')
})

test('every goal turn carries the CURRENT standing rules, because it is an ordinary turn', async t => {
  const f = await start(fixture(t))
  await f.host.setGoal({ sessionId: 'circle', objective: 'work' })
  await f.turnEnds('ok')
  await f.advance()

  /* POINT 5 OF THE ACCEPTANCE LIST, and the piece the native-goal build
     recorded as impossible ("no supported native hook"). It is free here
     BECAUSE the continuation is not special: it goes through the same
     sendTurn() a person's message does, and that path recomputes the rules
     block on every turn regardless of who started it. The evidence is that
     the self-started turn carries the goal block as an addition rather than
     arriving as bare text. */
  const continuation = f.sent[1].text
  assert.ok(continuation.includes('STANDING GOAL FOR THIS CONVERSATION'),
    'a self-started turn is composed by the same path that attaches per-turn context')
  assert.ok(continuation.includes('work'), 'and restates the objective')
  assert.ok(continuation.includes(ACHIEVED), 'and how to declare it done')
})

test('a person who types mid-goal is still working toward the goal', async t => {
  const f = await start(fixture(t))
  await f.host.setGoal({ sessionId: 'circle', objective: 'the standing job' })
  await f.turnEnds('ok')
  await f.host.sendTurn({ sessionId: 'circle', text: 'quick question', origin: 'person' })
  assert.ok(f.sent[1].text.startsWith('quick question'))
  assert.ok(f.sent[1].text.includes('the standing job'),
    'answering a question must not make the agent forget what it was doing')
})

test('the goal survives a reload, because the page never owned it', async t => {
  const f = await start(fixture(t))
  await f.host.setGoal({ sessionId: 'circle', objective: 'survive' })
  await f.turnEnds('ok')
  await f.advance()

  /* A reload is the renderer going away and coming back to the same host
     process. sessionActivity is what the returning page reads. */
  const seen = f.host.sessionActivity('circle')
  assert.equal(seen.goal.objective, 'survive')
  assert.equal(seen.goal.status, 'active')
  assert.equal(seen.goal.continuations, 1, 'including how much it has already done on its own')
  assert.equal(f.host.readGoal({ sessionId: 'circle' }).goal.objective, 'survive')
})

test('an empty objective is refused and nothing is set', async t => {
  const f = await start(fixture(t))
  await assert.rejects(() => f.host.setGoal({ sessionId: 'circle', objective: '   ' }))
  assert.equal(f.goal(), null)
  await assert.rejects(
    () => f.host.setGoal({ sessionId: 'circle', objective: 'x'.repeat(goalRules.GOAL_MAX_OBJECTIVE_BYTES + 1) }),
    'an objective past the host bound is refused rather than truncated into a different goal',
  )
  assert.equal(f.goal(), null)
})

/* THE ACCEPTANCE POINT THE NATIVE-ONLY BUILD COULD NOT MEET. The adapter in
   this fixture has no goal API at all; if the answer depended on the provider
   offering one, both of these would refuse. */
for (const [tier, family] of [['luna', 'Codex'], ['claude-sonnet', 'Claude']]) {
  test(`a ${family} tier (${tier}) works toward a goal on its own with no native goal API`, async t => {
    const f = fixture(t)
    let started
    try {
      started = await f.host.startSession({ sessionId: 'circle', tier })
    } catch (error) {
      /* A REFUSAL NAMES ITSELF. If this box's payload cannot start this tier
         the test says which tier and why rather than passing quietly. */
      assert.fail(`the ${tier} tier could not be started in this fixture: ${error?.code || error?.message}`)
    }
    assert.ok(started.sessionId)
    await f.host.setGoal({ sessionId: 'circle', objective: `work on ${tier}` })
    assert.equal(f.sent.length, 1)
    await f.turnEnds('one step done')
    await f.advance()
    assert.equal(f.sent.length, 2, `${tier} must get a self-started turn like every other provider`)
    assert.equal(f.host.readGoal({ sessionId: 'circle' }).goal.continuations, 1)
  })
}

/* ACCEPTANCE POINT 5, MEASURED RATHER THAN ARGUED.
 *
 * The prior native-goal lane recorded this one as impossible -- "no supported
 * native hook" -- and it is impossible natively, because a provider that
 * continues a turn by itself never re-enters this app's send path, so nothing
 * recomposes the person's rules for it. Here the continuation IS an ordinary
 * sendTurn(), so the refresh is not a feature that had to be added; it is a
 * consequence. This test is what says so with values instead of with a claim.
 *
 * The evidence is a rule the person files BETWEEN two turns. A self-started
 * turn that carries the old rule and not the new one would mean an agent
 * working unattended under instructions the person has already withdrawn,
 * which is the costliest way this feature could be wrong.
 */
test('a rule the person files mid-goal reaches the very next SELF-STARTED turn', async t => {
  const rules = rulesStore([{ id: 'R1', stamp: 'filed', words: 'always spell out the units' }])
  const f = await start(fixture(t, { rules }))

  await f.host.setGoal({ sessionId: 'circle', objective: 'work' })
  assert.ok(f.sent[0].text.includes('always spell out the units'),
    'the first turn carries the rules that were filed when it started')
  assert.ok(!f.sent[0].text.includes('never work past midnight'))

  /* The person opens their Ledger page mid-goal and changes their mind. */
  rules.entries = [{ id: 'R2', stamp: 'filed', words: 'never work past midnight' }]

  await f.turnEnds('one step done')
  await f.advance()

  assert.equal(f.sent.length, 2, 'a turn nobody typed has to have arrived for this to measure anything')
  const selfStarted = f.sent[1].text
  assert.ok(selfStarted.includes('never work past midnight'),
    'a self-started turn is composed through the same path a person’s message takes, so it carries the CURRENT rules')
  assert.ok(!selfStarted.includes('always spell out the units'),
    'and a withdrawn rule is gone from it rather than riding along for the rest of the run')
  assert.ok(/replace the previous ledger rules/i.test(selfStarted),
    'and the agent is told these REPLACE what it was given before, not that they are an addition')
})

/* THE SAME QUESTION ASKED OF THE OTHER DIRECTION: a rule filed while the goal
   is active must not be announced as a change on a turn where nothing changed.
   Without this, the test above could be satisfied by a product that pastes the
   whole rules block onto every turn with a "replaces" banner it has not
   earned, and an agent that is told its rules changed every five seconds
   learns to ignore the banner. */
test('an unchanged rule set is not re-announced on every self-started turn', async t => {
  const rules = rulesStore([{ id: 'R1', stamp: 'filed', words: 'always spell out the units' }])
  const f = await start(fixture(t, { rules }))
  await f.host.setGoal({ sessionId: 'circle', objective: 'work' })
  await f.turnEnds('step one')
  await f.advance()
  assert.equal(f.sent.length, 2)
  assert.ok(!/replace the previous ledger rules/i.test(f.sent[1].text),
    'nothing changed, so nothing is announced as replacing anything')
})

/* CLI PARITY: "Run /goal again to continue."
 *
 * The installed CLI carries that sentence alongside "/goal <condition> to set
 * another", so a goal that has stopped short is picked back up by typing the
 * goal again rather than by learning a new word. Three things in this product
 * pause a goal without discarding it -- Stop, a failed turn, or the agent
 * saying it is blocked -- and every one of them leaves a person holding an
 * objective they can see and, before this was measured, no proof they could
 * act on.
 *
 * Without this the paused states are a dead end reachable three ways, which is
 * worse than not pausing at all: the app would be keeping the objective in
 * order to show it to someone who cannot use it.
 */
test('a paused goal is picked up again by typing the goal again, and starts over from zero', async t => {
  const f = await start(fixture(t))
  await f.host.setGoal({ sessionId: 'circle', objective: 'get the release out' })
  await f.turnEnds('one step done')
  await f.advance()
  assert.equal(f.goal().continuations, 1)

  /* Let the self-started turn finish, so this is Stop pressed between turns
     rather than Stop pressed into a live turn. The busy case is the test
     below; conflating them would measure two things and name one. */
  await f.turnEnds('and another step')
  await f.host.interrupt({ sessionId: 'circle' })
  assert.equal(f.goal().status, 'paused', 'Stop pauses rather than discards')
  const whilePaused = f.sent.length
  await f.advance()
  await f.advance()
  assert.equal(f.sent.length, whilePaused, 'and a paused goal starts nothing on its own')

  /* The person types the goal again. */
  await f.host.setGoal({ sessionId: 'circle', objective: 'get the release out' })
  assert.equal(f.goal().status, 'active', 'typing it again picks it up')
  assert.equal(f.goal().continuations, 0,
    'and the budget starts over, because a person who re-asked is a person who is watching again')
  assert.equal(f.sent.length, whilePaused + 1, 'the objective goes to the provider straight away')

  await f.turnEnds('carrying on')
  await f.advance()
  assert.equal(f.sent.length, whilePaused + 2, 'and it is working on its own again')
})

/* SETTING A GOAL ON A CIRCLE THAT IS ALREADY WORKING IS THE NORMAL CASE, not
   an edge one: the person watches a turn run, decides they want the whole job
   done, and types it. The host records it straight away and the ordinary poll
   starts the first self-started turn at the next open boundary. Measured
   because the alternative -- refusing while busy -- would make "set a goal" a
   thing that only works when the agent is idle, which is the opposite of what
   a goal is for, and it would look identical from outside to a goal that was
   accepted and then dropped. */
test('a goal set while a turn is already running is kept and starts at the next boundary', async t => {
  const f = await start(fixture(t))
  await f.host.sendTurn({ sessionId: 'circle', text: 'have a look at the notes', origin: 'person' })
  const busyAt = f.sent.length

  await f.host.setGoal({ sessionId: 'circle', objective: 'get the release out' })
  assert.equal(f.goal().objective, 'get the release out', 'the goal is recorded even though a turn is in flight')
  assert.equal(f.sent.length, busyAt, 'and nothing is sent on top of the live turn')

  await f.turnEnds('had a look')
  await f.advance()
  assert.equal(f.sent.length, busyAt + 1, 'the first self-started turn arrives once the boundary opens')
  assert.equal(f.goal().continuations, 1)
})

/* The same door for the other three ways a goal pauses, so none of them is the
   one that got left behind. Driven by state rather than by four copies of the
   walk above: what matters is that `paused` is always re-enterable. */
/* An ordinary person turn is the resume door promised by the paused-goal copy.
   It must reactivate both provider-failure and provider-blocked states, keep the
   objective, and return to autonomous work after that explicit turn finishes. */
for (const [how, arrive] of [
  ['the turn failed', async f => { await f.turnEnds('tried', { status: 'failed' }) }],
  ['the agent said it was blocked', async f => { await f.turnEnds('I need a decision.\n\n' + BLOCKED) }],
]) {
  test('an ordinary message resumes a goal stopped because ' + how, async t => {
    const f = await start(fixture(t))
    await f.host.setGoal({ sessionId: 'circle', objective: 'finish the migration' })
    await arrive(f)
    assert.notEqual(f.goal().status, 'active', 'this really is one of the stopped states')
    const stoppedAt = f.sent.length

    await f.host.sendTurn({ sessionId: 'circle', text: 'I fixed the issue', origin: 'person' })
    assert.equal(f.goal().status, 'active', 'an ordinary message must resume the paused goal')
    assert.equal(f.goal().continuations, 0, 'the explicit person turn starts a fresh bounded run')
    assert.equal(f.sent.length, stoppedAt + 1, 'the message itself is the one resumed turn')
    assert.match(f.sent[f.sent.length - 1].text, /finish the migration/,
      'the resumed turn still carries the standing objective')

    await f.turnEnds('back at it')
    await f.advance()
    assert.equal(f.sent.length, stoppedAt + 2, 'autonomous work resumes after the person turn')
  })
}
for (const [how, arrive] of [
  ['the turn failed', async f => { await f.turnEnds('tried', { status: 'failed' }) }],
  ['the agent said it was blocked', async f => { await f.turnEnds(`I need a decision.\n\n${BLOCKED}`) }],
]) {
  test(`a goal stopped because ${how} is picked up again by typing it again`, async t => {
    const f = await start(fixture(t))
    await f.host.setGoal({ sessionId: 'circle', objective: 'finish the migration' })
    await arrive(f)
    assert.notEqual(f.goal().status, 'active', 'this really is one of the stopped states')
    const stoppedAt = f.sent.length
    await f.advance()
    assert.equal(f.sent.length, stoppedAt, 'nothing self-starts out of a stopped goal')

    await f.host.setGoal({ sessionId: 'circle', objective: 'finish the migration' })
    assert.equal(f.goal().status, 'active')
    assert.equal(f.sent.length, stoppedAt + 1)
    await f.turnEnds('back at it')
    await f.advance()
    assert.equal(f.sent.length, stoppedAt + 2, 'and it works on its own again')
  })
}


test('first usable turn leads with submitted text and carries retained history plus current relevant task contents', async t => {
  let revision = 1
  const records = [
    { id: 'T489', kind: 'T', scope: 'global', status: 'in-progress', verbatim: 'Deliver the exact submitted message promptly.', decisions: [{ at: '2026-09-21T00:00:00Z', reason: 'Preserve accepted and unknown delivery custody.' }] },
    { id: 'T767', kind: 'T', scope: 'thread', scopeKey: 'worker-node', status: 'open', verbatim: 'Carry current initiating intent.' },
    { id: 'T500', kind: 'T', scope: 'thread', scopeKey: 'worker-node', status: 'done', verbatim: 'Do not restart this completed work.' },
    { id: 'T900', kind: 'T', scope: 'thread', scopeKey: 'other-node', status: 'open', verbatim: 'UNRELATED_PRIVATE_TASK' },
  ]
  const f = fixture(t, { tasks: { readAll: () => ({ revision, records }) } })
  await f.host.startSession({ sessionId: 'circle', requestKeys: { treeAnchors: ['worker-node'], threadId: 'worker-node' }, historyHandoff: 'Saved conversation: earlier result.' })
  assert.equal(f.sent.length, 0, 'opening with history must not submit an empty recovery turn')
  const exact = 'Please continue T489 with this correction.'
  const reply = await f.host.sendTurn({ sessionId: 'circle', text: exact, origin: 'person' })
  assert.ok(f.sent[0].text.startsWith(exact + '\n\n'))
  assert.match(f.sent[0].text, /Saved conversation: earlier result/)
  assert.match(f.sent[0].text, /Deliver the exact submitted message promptly/)
  assert.match(f.sent[0].text, /Preserve accepted and unknown delivery custody/)
  assert.match(f.sent[0].text, /Carry current initiating intent/)
  assert.doesNotMatch(f.sent[0].text, /UNRELATED_PRIVATE_TASK|Do not restart this completed work/)
  assert.equal(reply.transcriptPrompt.text, exact)
  assert.ok(reply.transcriptPrompt.additions.some(part => part.kind === 'tasks'))
  await f.turnEnds('First answer')
  records[0].verbatim = 'UPDATED_CURRENT_TASK'; revision++
  await f.host.sendTurn({ sessionId: 'circle', text: 'Use updated T489.', origin: 'person' })
  assert.match(f.sent[1].text, /UPDATED_CURRENT_TASK/)
  assert.doesNotMatch(f.sent[1].text, /Saved conversation: earlier result/)
})


test('task context read failures are explicit and do not invent an empty task list', async t => {
  const f = fixture(t, { tasks: { readAll() { throw new Error('private path must not be disclosed') } } })
  await f.host.startSession({ sessionId: 'circle' })
  const result = await f.host.sendTurn({ sessionId: 'circle', text: 'Continue T767.', origin: 'person' })
  const context = result.transcriptPrompt.additions.find(part => part.kind === 'tasks')
  assert.match(context.text, /TASK_STORE_READ_FAILED/)
  assert.doesNotMatch(context.text, /private path|No tasks/)
  assert.ok(f.sent[0].text.startsWith('Continue T767.'))
})

test('task snapshot is read once after Stop authority resumes and before the provider receives the turn', async t => {
  const gate = Promise.withResolvers(), entered = Promise.withResolvers()
  let revision = 1, reads = 0
  const record = { id: 'T767', kind: 'T', scope: 'global', status: 'open', verbatim: 'OLD_REQUEST' }
  const f = fixture(t, { tasks: { readAll() { reads++; return { revision, records: [record] } } }, authority: {
    bind: value => ({ bound: true, credential: Buffer.from(value.sessionId.padEnd(32, 'x')).toString('base64url') }),
    assert: () => ({ valid: true }), revoke() {}, cancelVersion: 2, cancelWork() {},
    resumeWork() { entered.resolve(); return gate.promise },
  } })
  await f.host.startSession({ sessionId: 'circle' })
  await f.host.sendTurn({ sessionId: 'circle', text: 'earlier work', origin: 'person' })
  await f.host.interrupt({ sessionId: 'circle' }); await f.turnEnds(null, { status: 'interrupted' })
  const before = reads
  const pending = f.host.sendTurn({ sessionId: 'circle', text: 'Now do T767.', origin: 'person' })
  try {
    await entered.promise
    assert.equal(reads, before, 'task reads must not precede the asynchronous authority boundary')
    record.verbatim = 'LATEST_REQUEST'; revision++
    gate.resolve(); await pending
    assert.equal(reads, before + 1)
    assert.match(f.sent[1].text, /LATEST_REQUEST/)
    assert.doesNotMatch(f.sent[1].text, /OLD_REQUEST/)
  } finally { gate.resolve(); await pending }
})

test('an invalid first send retains first-turn history and task context for the corrected submission', async t => {
  const tasks = { readAll: () => ({ revision: 4, records: [{ id: 'T767', kind: 'T', scope: 'thread', scopeKey: 'node', status: 'open', verbatim: 'Current startup task.' }] }) }
  const f = fixture(t, { tasks })
  await f.host.startSession({ sessionId: 'circle', requestKeys: { threadId: 'node' }, historyHandoff: 'HISTORY_FOR_RETRY' })
  const dispatchTracking = { dispatched: false }
  await assert.rejects(f.host.sendTurn({ sessionId: 'circle', text: 'Exact person intent.', origin: 'person', images: Array(9).fill({ path: 'image' }), dispatchTracking }), { code: 'AGENT_TURN_IMAGES_INVALID' })
  assert.equal(dispatchTracking.dispatched, false)
  assert.equal(f.sent.length, 0)
  const result = await f.host.sendTurn({ sessionId: 'circle', text: 'Exact person intent.', origin: 'person' })
  assert.equal(f.sent.length, 1)
  assert.match(f.sent[0].text, /HISTORY_FOR_RETRY/)
  assert.match(f.sent[0].text, /Current startup task/)
  assert.equal(result.transcriptPrompt.text, 'Exact person intent.')
})

test('accepted history is not replayed after an unknown late result', async t => {
  const f = fixture(t)
  await f.host.startSession({ sessionId: 'circle', historyHandoff: 'HISTORY_ONLY_ONCE' })
  const outcome = Promise.withResolvers()
  let calls = 0
  f.adapter.sendTurn = request => { calls++; f.sent.push(request); return outcome.promise }
  const accepted = []
  f.host.onAcceptedPrompt(value => accepted.push(value))
  const pending = f.host.sendTurn({ sessionId: 'circle', text: 'FIRST_INTENT', origin: 'person' })
  f.emit({ type: 'assistant_text_delta', turnId: 'accepted-unknown', text: 'First actual output.' })
  await pending
  outcome.reject(Object.assign(new Error('late transport failure'), { code: 'UNKNOWN_DELIVERY' }))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 1)
  assert.equal(accepted.length, 1)
  assert.equal(accepted[0].text, 'FIRST_INTENT')
  f.adapter.sendTurn = async request => { calls++; f.sent.push(request); return { turnId: 'second' } }
  await f.host.sendTurn({ sessionId: 'circle', text: 'SECOND_INTENT', origin: 'person' })
  assert.equal(calls, 2)
  assert.doesNotMatch(f.sent[1].text, /FIRST_INTENT|HISTORY_ONLY_ONCE/)
})

test('task selection uses current scope and explicit references without restarting terminal history', () => {
  const { composeTaskContext } = require('../../shell/session-task-context.cjs')
  const records = [
    { id: 'T1', kind: 'T', scope: 'tree', scopeKey: 'parent', status: 'in-progress', verbatim: 'ACTIVE_PARENT' },
    { id: 'T2', kind: 'T', scope: 'session', scopeKey: 'session', status: 'blocked-external', verbatim: 'BLOCKED_CURRENT' },
    { id: 'T3', kind: 'T', scope: 'thread', scopeKey: 'node', status: 'done', verbatim: 'OLD_FINISHED_REQUEST' },
    { id: 'T4', kind: 'T', scope: 'tree', scopeKey: 'parent', status: 'open', supersededBy: 'T1', verbatim: 'OLD_SUPERSEDED_REQUEST' },
    { id: 'T5', kind: 'T', scope: 'tree', scopeKey: 'elsewhere', status: 'open', verbatim: 'UNRELATED' },
  ]
  const store = { readAll: options => { assert.deepEqual(options.kinds, ['T']); return { revision: 42, records } } }
  const identity = { threadId: 'node', sessionId: 'session', treeAnchors: ['parent', 'node'] }
  const text = composeTaskContext(store, identity, 'Check T3, T4, and missing T999.', { firstTurn: true })
  assert.match(text, /Ledger revision 42/)
  assert.match(text, /ACTIVE_PARENT/); assert.match(text, /BLOCKED_CURRENT/)
  assert.match(text, /T3: done/); assert.match(text, /T4: open; superseded by T1/); assert.match(text, /unavailable: T999/)
  assert.doesNotMatch(text, /OLD_FINISHED_REQUEST|OLD_SUPERSEDED_REQUEST|UNRELATED/)
  assert.equal(composeTaskContext(store, identity, 'A later message.'), null)
})


test('actual host accepted prompt preserves all seven produced additions through canonical capture', async t => {
  const capability = require('./fixtures/confined-engine/src/lib/capability-recall/index.js')
  t.mock.method(capability, 'recommend', () => ({ text: 'TRAILING_CAPABILITIES', tools: [], outcome: 'hit' }))
  const rules = rulesStore([{ id: 'R1', stamp: 'filed', words: 'CURRENT_R_RULE' }])
  const f = fixture(t, { rules, toolContext: true, tasks: { readAll: () => ({ revision: 7, records: [
    { id: 'T767', kind: 'T', scope: 'thread', scopeKey: 'node', status: 'open', verbatim: 'CURRENT_T_DATA' },
  ] }) } })
  await f.host.startSession({ sessionId: 'circle', historyHandoff: 'SAVED_HISTORY',
    requestKeys: { threadId: 'node', treeAnchors: ['node'] }, treeIdentity: { selfName: 'Worker', managerName: null },
    role: { id: 'worker', name: 'Worker', owns: 'CURRENT_ROLE', mustNot: 'Change scope.', handoff: 'Controller' },
  })
  f.host.updateTreeAddress({ sessionId: 'circle', selfName: 'Current Worker', managerName: null, treeKey: 'node', requestKeys: { threadId: 'node', treeAnchors: ['node'] } })
  const { createNodeTranscriptCapture } = require('../../shell/node-transcript-capture.cjs')
  const rows = [], writes = [], reported = []
  const capture = createNodeTranscriptCapture({ store: { append: async ({ entries }) => { rows.push(...entries); return { ok: true } } } })
  capture.bind({ sessionId: 'circle', computerId: 'fixture', nodeId: 'node' })
  f.host.onAcceptedPrompt(value => { reported.push(value); writes.push(capture.recordAcceptedTranscriptSend(value)) })
  const result = await f.host.sendTurn({ sessionId: 'circle', text: 'EXACT_INITIATING_PERSON', origin: 'person' })
  await Promise.all(writes); await capture.shutdown()
  const produced = result.transcriptPrompt.additions
  assert.deepEqual(produced.map(part => part.kind), ['tasks', 'history', 'tree', 'requests', 'role', 'tools', 'capabilities'])
  assert.equal(reported.length, 1)
  assert.equal(reported[0].transcriptPrompt, result.transcriptPrompt)
  assert.equal(f.sent[0].text, ['EXACT_INITIATING_PERSON', ...produced.map(part => part.text)].join('\n\n'))
  assert.equal(rows[0].text, 'EXACT_INITIATING_PERSON')
  assert.deepEqual(rows.slice(1).map(row => ({ kind: row.promptKind, text: row.text })), produced)
  assert.ok(rows.slice(1).every(row => row.promptSource === 'toolsenabled' && row.turnStamp === result.turnId))
  assert.match(rows.at(-2).text, /FIXTURE TOOL SUMMARY/)
  assert.equal(rows.at(-1).text, 'TRAILING_CAPABILITIES')
  assert.doesNotMatch(rows.find(row => row.promptKind === 'requests').text, /CURRENT_T_DATA/)
})

test('bounded task context names omissions and never matches absent scope keys', () => {
  const { composeTaskContext } = require('../../shell/session-task-context.cjs')
  const records = Array.from({ length: 100 }, (_, i) => ({ id: `T${i + 1}`, kind: 'T', scope: 'thread', scopeKey: 'node', status: 'open', verbatim: 'x'.repeat(2000) }))
  const text = composeTaskContext({ readAll: () => ({ revision: 9, records }) }, { threadId: 'node' }, 'Work.', { firstTurn: true })
  assert.ok(text.length <= 64000)
  assert.match(text, /Context bound/)
  assert.equal(composeTaskContext({ readAll: () => ({ records: [{ id: 'T1', kind: 'T', scope: 'thread', status: 'open', verbatim: 'malformed scope' }] }) }, {}, 'Work.', { firstTurn: true }), null)
})


test('Basic host timer skips disabled ledger polling while an explicit Goal keeps continuing', async t => {
  let enabled = false, polls = 0
  const continuation = { enabled: () => enabled, tick() { polls++ }, instructions: () => null,
    remember() {}, started() {}, completed() {}, refused() {}, stop() {}, forget() {}, close() {}, update() {} }
  const f = await start(fixture(t, { continuation }))
  await f.host.setGoal({ sessionId: 'circle', objective: 'Complete the bounded fixture goal' })
  await f.turnEnds('Working')
  await f.advance()
  assert.equal(polls, 0)
  assert.equal(f.sent.length, 2, 'disabling optional Ledger polling must not disable explicit Goal work')
  enabled = true
  await f.advance()
  assert.equal(polls, 1)
  enabled = false
  await f.advance()
  assert.equal(polls, 1)
  assert.equal(f.sent.length, 2, 'busy Goal still owns its turn')
})
