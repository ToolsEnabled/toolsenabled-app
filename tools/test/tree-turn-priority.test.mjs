import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'

const require_ = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const { TREE_TURN_REASONS, treeTurnDecision } = require_(path.join(ROOT, 'shell', 'tree-turn-priority.cjs'))

/* THE DEFECT THESE PIN, MEASURED 2026-09-03. Four messages the owner typed at
   03:53:21, 03:57:17, 03:58:34 and 04:08:35 reached neither the Controller's
   engine transcript nor the owner-capture spool. Nothing refused them: the
   shell's tree courier, offering one of ~95 agent_comms messages every 1200 ms,
   took every turn boundary before the renderer's queued-message drain could,
   the drain's send was refused with AGENT_TURN_ACTIVE, its words went back to
   the front of the queue, and the next boundary went the same way.

   The first two tests assert the RULE by calling it with values. The third
   plays the race out over 95 tree messages, which is the shape the person
   actually lost. The last pins the three seams in the host that feed it, since
   a correct rule nothing consults is decoration. */

const POLL_MS = 1200

test('with nobody waiting the courier takes the boundary, and one turn at a time still wins first', () => {
  /* boundaryAt is a full poll interval and more behind `now`: the boundary's
     own drain window (see 'a boundary that just opened' below) has closed, so
     this is the ordinary idle case and not the instant after a turn ended. */
  const idleWithTraffic = treeTurnDecision({
    now: 10_000,
    queuedTreeTurns: 3,
    turnActive: false,
    personWaitingSince: null,
    boundaryAt: 8_000,
    personYieldMs: POLL_MS,
  })
  assert.equal(idleWithTraffic.take, true, 'tree traffic must still flow when no person is waiting')
  assert.equal(idleWithTraffic.reason, TREE_TURN_REASONS.TAKE)

  assert.deepEqual(
    treeTurnDecision({
      now: 10_000,
      queuedTreeTurns: 3,
      turnActive: true,
      personWaitingSince: null,
      boundaryAt: 9_000,
      personYieldMs: POLL_MS,
    }),
    { take: false, reason: TREE_TURN_REASONS.TURN_ACTIVE },
    'one turn at a time is the engine contract and must be refused before anything else is weighed',
  )

  assert.deepEqual(
    treeTurnDecision({
      now: 10_000,
      queuedTreeTurns: 0,
      turnActive: false,
      personWaitingSince: 9_999,
      boundaryAt: 9_000,
      personYieldMs: POLL_MS,
    }),
    { take: false, reason: TREE_TURN_REASONS.QUEUE_EMPTY },
    'no tree traffic is no question to answer',
  )
})

test('a person whose send was refused gets the next boundary, and cannot hold it past one poll interval', () => {
  const boundaryAt = 500_000
  const refusedAt = boundaryAt - 240_000 // refused four minutes earlier, mid-turn

  const atTheBoundary = treeTurnDecision({
    now: boundaryAt + 1,
    queuedTreeTurns: 95,
    turnActive: false,
    personWaitingSince: refusedAt,
    boundaryAt,
    personYieldMs: POLL_MS,
  })
  assert.deepEqual(atTheBoundary, { take: false, reason: TREE_TURN_REASONS.PERSON_FIRST },
    'the courier must stand aside at the boundary a waiting person is about to reach')

  /* THE WINDOW IS TIMED FROM THE BOUNDARY, NOT FROM THE REFUSAL. Timed from the
     refusal it would already have expired here -- four minutes is many poll
     intervals -- and the person would lose the boundary again, which is the
     starvation with extra steps. */
  assert.equal(
    treeTurnDecision({
      now: boundaryAt + POLL_MS,
      queuedTreeTurns: 95,
      turnActive: false,
      personWaitingSince: refusedAt,
      boundaryAt,
      personYieldMs: POLL_MS,
    }).take,
    true,
    'a renderer that never came back must not hold the tree past one poll interval per boundary',
  )

  /* A reservation with no boundary yet recorded is still a reservation. */
  assert.equal(
    treeTurnDecision({
      now: refusedAt + 1,
      queuedTreeTurns: 1,
      turnActive: false,
      personWaitingSince: refusedAt,
      boundaryAt: null,
      personYieldMs: POLL_MS,
    }).reason,
    TREE_TURN_REASONS.PERSON_FIRST,
    'a session that has never completed a turn must still yield to a refused person',
  )

  /* Absence is absence. A missing reservation must not read as one made at the
     epoch, which would be a permanent expired yield, nor as one made now. */
  for (const absent of [undefined, null, Number.NaN, -1, 'yesterday']) {
    assert.equal(
      treeTurnDecision({
        now: 10_000,
        queuedTreeTurns: 1,
        turnActive: false,
        personWaitingSince: absent,
        boundaryAt: 8_000,
        personYieldMs: POLL_MS,
      }).take,
      true,
      `an unusable reservation (${String(absent)}) must read as nobody waiting, not as a yield`,
    )
  }

  /* A clock the caller could not supply is a named refusal, never a silent
     pass over the person who is waiting. */
  assert.equal(
    treeTurnDecision({
      now: Number.NaN,
      queuedTreeTurns: 1,
      turnActive: false,
      personWaitingSince: 9_000,
      boundaryAt: 9_000,
      personYieldMs: POLL_MS,
    }).reason,
    TREE_TURN_REASONS.CLOCK_UNUSABLE,
  )
})

/* The two senders, played out exactly as the host composes them:

     sendTurn()   refuses an overlapping turn by name and, when the refused
                  turn was the person's, leaves the reservation behind.
     pumpTick()   asks treeTurnDecision() before claiming a boundary.
     drain()      the renderer's turn-completed listener: one queued message,
                  back to the front of its queue if refused.

   The pump ticks BEFORE the drain at every boundary, which is the losing order
   the person actually got. */
function playTheRace({ treeMessages, personMessages, boundaries, turnMs = 5_000 }) {
  const session = { turnActive: false, personWaitingSince: null, turnBoundaryAt: null }
  const treeQueue = [...treeMessages]
  const personQueue = [...personMessages]
  const sent = []
  let now = 1_000_000

  const sendTurn = (text, origin) => {
    if (session.turnActive) {
      if (origin === 'person') session.personWaitingSince = now
      const error = new Error('active')
      error.code = 'AGENT_TURN_ACTIVE'
      throw error
    }
    if (origin === 'person') session.personWaitingSince = null
    session.turnActive = true
    sent.push({ text, origin })
  }

  const pumpTick = () => {
    const claim = treeTurnDecision({
      now,
      queuedTreeTurns: treeQueue.length,
      turnActive: session.turnActive,
      personWaitingSince: session.personWaitingSince,
      boundaryAt: session.turnBoundaryAt,
      personYieldMs: POLL_MS,
    })
    if (!claim.take) return
    const next = treeQueue.shift()
    try { sendTurn(next, 'agent') } catch { treeQueue.unshift(next) }
  }

  const drain = () => {
    if (personQueue.length === 0) return
    const entry = personQueue.shift()
    try { sendTurn(entry, 'person') } catch { personQueue.unshift(entry) }
  }

  /* A turn is already running when the person types, which is why the message
     was queued rather than sent. */
  sendTurn(treeQueue.shift(), 'agent')
  for (let boundary = 0; boundary < boundaries; boundary += 1) {
    now += turnMs
    session.turnActive = false
    session.turnBoundaryAt = now
    now += 1
    pumpTick()
    now += 1
    drain()
    /* THE COURIER KEEPS TICKING. A boundary nobody took at the first tick --
       the pump stood aside and the person had no words -- is taken at a later
       tick, one poll interval on, exactly as the real setInterval does. Two
       ticks are enough: the yield is one interval long by construction. */
    for (let tick = 0; tick < 2 && !session.turnActive; tick += 1) {
      now += POLL_MS
      pumpTick()
    }
  }
  return { sent, personQueue }
}

test('a person waiting behind 95 tree messages is answered, not outranked forever', () => {
  const tree = Array.from({ length: 95 }, (unused, index) => `tree-${index}`)
  const { sent, personQueue } = playTheRace({
    treeMessages: tree,
    personMessages: ['what the owner typed at 03:53:21'],
    boundaries: 95,
  })

  const personSent = sent.filter(turn => turn.origin === 'person')
  assert.equal(personQueue.length, 0, 'the person\'s message is still sitting in the renderer queue')
  assert.equal(personSent.length, 1, 'the person\'s one message must be sent exactly once')
  assert.equal(personSent[0].text, 'what the owner typed at 03:53:21')

  /* HOW LATE IS IT ALLOWED TO BE. Two machine messages may precede it and no
     more. The first was already running when the person typed -- that is WHY
     the message was queued, and no priority rule can un-send it. The second is
     the one lost race: until a person's send has been refused, nothing in the
     shell knows a person is waiting. That refusal records the reservation, and
     the person takes the very next boundary. */
  const position = sent.findIndex(turn => turn.origin === 'person')
  assert.ok(position <= 2, `the person waited behind ${position} machine messages; at most two are allowed`)

  /* AND THE TREE IS NOT STARVED IN RETURN. A fix that made the person win by
     stopping the courier would be the same defect pointing the other way. */
  assert.ok(sent.filter(turn => turn.origin === 'agent').length >= 90,
    'tree traffic must keep flowing once the person\'s words have gone')
})

test('four queued messages all get through while the tree keeps talking', () => {
  const { sent, personQueue } = playTheRace({
    treeMessages: Array.from({ length: 95 }, (unused, index) => `tree-${index}`),
    personMessages: ['03:53:21', '03:57:17', '03:58:34', '04:08:35'],
    boundaries: 40,
  })
  assert.equal(personQueue.length, 0, 'a queue that drains one per boundary must empty within forty boundaries')
  assert.deepEqual(
    sent.filter(turn => turn.origin === 'person').map(turn => turn.text),
    ['03:53:21', '03:57:17', '03:58:34', '04:08:35'],
    'the person\'s messages must arrive, in the order they were typed',
  )
})

/* THE SECOND LOST RACE, CLOSED.
 *
 * The 95-message test above allowed the person to lose ONE boundary ("until a
 * person's send has been refused, nothing in the shell knows a person is
 * waiting"). That concession assumed the person's words reach sendTurn() and
 * get refused. They usually do not: the renderer checks nodeBusy() FIRST and,
 * at a busy circle, puts the words straight into src/session-outbox.js without
 * ever asking the host (src/views/computers.js treeCardSend's busy branch, and
 * the busy composer's queue.add -> queueForSession). So no reservation exists
 * at the first boundary, the pump takes it, the person's drain is refused, and
 * only THEN is a reservation recorded -- one whole machine turn late, which on
 * a Claude worker is minutes.
 *
 * THE RULE NOW: a boundary that has just opened belongs to the renderer's
 * drain for one poll interval whether or not a refusal was ever recorded. The
 * host stamps turnBoundaryAt on every turn_completed, and that stamp alone
 * opens the window. A refusal still opens one too (a session that has never
 * completed a turn), and the tree still cannot be held past one interval per
 * boundary by a renderer that went away. */
test('a boundary that just opened is the drain\'s first, with no refusal on record', () => {
  const boundaryAt = 700_000
  assert.deepEqual(
    treeTurnDecision({
      now: boundaryAt + 5,
      queuedTreeTurns: 7,
      turnActive: false,
      personWaitingSince: null,
      boundaryAt,
      personYieldMs: POLL_MS,
    }),
    { take: false, reason: TREE_TURN_REASONS.PERSON_FIRST },
    'the pump took a boundary that opened 5 ms ago; the renderer\'s drain (an IPC round trip away) has not had its turn, and no refusal was recorded because the renderer queued without asking the host',
  )
  assert.equal(
    treeTurnDecision({
      now: boundaryAt + POLL_MS,
      queuedTreeTurns: 7,
      turnActive: false,
      personWaitingSince: null,
      boundaryAt,
      personYieldMs: POLL_MS,
    }).take,
    true,
    'a boundary nobody drained within one poll interval belongs to the tree; holding it longer starves the tree for a person who said nothing',
  )
  assert.equal(
    treeTurnDecision({
      now: 10,
      queuedTreeTurns: 1,
      turnActive: false,
      personWaitingSince: null,
      boundaryAt: null,
      personYieldMs: POLL_MS,
    }).take,
    true,
    'a session that has never completed a turn and has nobody refused has no window to hold',
  )
})

test('a message queued while the circle worked, never refused, still takes the very first boundary', () => {
  /* playTheRace never refuses the person's send before the first boundary --
     the words go into the queue while a tree turn runs, exactly as the
     renderer's busy door does -- so it is the shape this rule exists for. */
  const { sent, personQueue } = playTheRace({
    treeMessages: Array.from({ length: 95 }, (unused, index) => `tree-${index}`),
    personMessages: ['what the owner typed while the worker was busy'],
    boundaries: 95,
  })
  assert.equal(personQueue.length, 0)
  const position = sent.findIndex(turn => turn.origin === 'person')
  assert.equal(position, 1,
    `the person's message went out behind ${position} machine messages; only the turn already running when they typed may precede it`)
  assert.ok(sent.filter(turn => turn.origin === 'agent').length >= 90,
    'the tree must keep flowing once the person\'s words have gone')

  /* Four typed messages go at four consecutive boundaries, and the tree gets
     every boundary after that. */
  const four = playTheRace({
    treeMessages: Array.from({ length: 95 }, (unused, index) => `tree-${index}`),
    personMessages: ['one', 'two', 'three', 'four'],
    boundaries: 40,
  })
  assert.deepEqual(four.sent.slice(0, 5).map(turn => turn.origin), ['agent', 'person', 'person', 'person', 'person'],
    'a person with four queued messages waits behind machine chatter between them')
  assert.ok(four.sent.length >= 38, `the tree sent only ${four.sent.length - 4} messages in 40 boundaries after the person was done`)
})

test('the renderer\'s busy door queues without asking the host, which is why the boundary window cannot depend on a refusal', () => {
  const view = readFileSync(path.join(ROOT, 'src', 'views', 'computers.js'), 'utf8')
  // Exercise the production doors: adding another reason to hold a message
  // (such as an in-flight model change) must not invalidate busy-turn priority.
  for (const state of [{ busy: true, pending: null }, { busy: false, pending: { applying: true } }]) {
    const node = { id: 'priority-node', sessionId: 'priority-session' }
    const queued = [], replies = []
    const values = {
      notePersonSpokeTo() {}, treeStore: { getNode: () => node },
      parseSlashCommand: () => null, nodeBusy: () => state.busy,
      pendingModelChoice: () => state.pending,
      QUEUE_PANEL: { cardQueued: 'Queued' },
      outboxEnqueue(sessionId, text) {
        const entry = { sessionId, text }; queued.push(entry)
        return { ok: true, entry }
      },
      window: { get mcAgent() { assert.fail('A held message contacted the host') } },
      outboxTakeNext() { assert.fail('A held message was removed for delivery') },
      drainOutboxMessage() { assert.fail('A held message was sent') },
    }
    const load = name => new Function(...Object.keys(values),
      declaredFunctionSource(view, name) + `\nreturn ${name}`)(...Object.values(values))
    load('treeCardSend')(node, 'Card message', {
      reply: text => replies.push(text), fail: message => assert.fail(message),
    })
    const result = load('queueForSession')(node, 'Composer message')
    assert.deepEqual(queued, [
      { sessionId: node.sessionId, text: 'Card message' },
      { sessionId: node.sessionId, text: 'Composer message' },
    ])
    assert.deepEqual(replies, ['Queued'])
    assert.deepEqual(result, { ok: true, entry: queued[1], sentence: 'Queued' })
  }
})

test('the host consults the rule, records the reservation, and stamps the boundary', () => {
  const host = readFileSync(path.join(ROOT, 'shell', 'agent-host.cjs'), 'utf8')
  const pump = host.slice(host.indexOf('function pumpTreeSessionOnce'), host.indexOf('function pumpTreeSession('))
  assert.ok(pump.length > 200, 'pumpTreeSessionOnce left agent-host.cjs')
  assert.match(pump, /treeTurnDecision\(\{/, 'the tree pump no longer asks who owns the boundary')
  assert.match(pump, /personYieldMs: TREE_POLL_MS/,
    'the yield is no longer the courier\'s own poll interval — it would be an invented number')
  assert.ok(pump.indexOf('takeTreeBatch(session.treeQueue') > pump.indexOf('treeTurnDecision({'),
    'the pump claims a turn before asking whether it may — the person loses the boundary again')
  assert.ok(!/if \(session\.sendPromise \|\| session\.activeTurnId\) return/.test(pump),
    'the old unconditional idle test is back beside the decision; whichever runs first wins and it is not the person')

  const sendTurn = host.slice(host.indexOf('async function sendTurn({'), host.indexOf('const sendPromise = (async ()'))
  assert.match(sendTurn, /if \(origin === 'person'\) session\.personWaitingSince = Date\.now\(\)/,
    'a refused person no longer leaves a reservation, so the next boundary goes to the tree again')
  assert.ok(sendTurn.indexOf("session.personWaitingSince = Date.now()") < sendTurn.indexOf("fail('AGENT_TURN_ACTIVE'"),
    'the reservation must be recorded before the refusal throws')
  assert.match(sendTurn, /if \(origin === 'person'\) session\.personWaitingSince = null/,
    'a landed person turn no longer clears the reservation, so their own message would hold the tree back')

  const emit = host.slice(host.indexOf('function emit(session, event)'), host.indexOf('function credentialBindingOf'))
  const stamp = /session\.turnBoundaryAt = ([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\(\)/.exec(emit)
  assert.ok(stamp, 'nothing stamps the turn boundary, so the yield window has no start')
  /* THE STAMP AND THE READER MUST SHARE ONE CLOCK, and that is what is checked
     here rather than which clock it is. This line used to require the literal
     Date.now(), which meant it went red when the host correctly moved the
     stamp onto its own injected `now` -- and, worse, it would have stayed
     green on a host that stamped with the wall clock while
     autonomousSendAllowed() compared against the injected one. That is the
     exact failure agent-host.cjs's own comment at the stamp warns about: the
     five-second rule would be comparing two unrelated timelines. */
  const reader = host.slice(host.indexOf('function autonomousSendAllowed(session)'), host.indexOf('const continuationStarts'))
  assert.ok(reader.length > 100, 'autonomousSendAllowed left agent-host.cjs')
  assert.ok(reader.includes(`${stamp[1]}() - (session.turnBoundaryAt`),
    `the boundary is stamped with ${stamp[1]}() but autonomousSendAllowed compares against a different clock`)
})

/* THE THIRD LOST RACE. boundaryAt restamps on EVERY turn_completed, including
   the tree's own agent-originated turns. A circle whose gap between its own
   turns is shorter than personYieldMs never presents a boundary on which
   turnActive is false AND the window opened by the LATEST boundary has
   expired -- each restamp reopens the window before the previous one could
   close. This plays that exact shape out and asserts only that the wait is
   BOUNDED: it does not pin how the module bounds it, only that a delivered
   message is eventually taken rather than refused forever. */
test('a circle that restamps its own boundary faster than personYieldMs cannot yield to it forever', () => {
  const personYieldMs = POLL_MS
  const gapMs = 300          // shorter than personYieldMs -- the starving shape
  const turnMs = 5_000
  /* Generous on purpose: the point is "not forever", not a tight number. Fifty
     poll intervals is nowhere near the ten-minute horizon the defect was
     measured never resolving inside. */
  const ceilingMs = personYieldMs * 50

  let boundaryAt = null
  let turnActive = true
  let turnStartedAt = 0
  const queuedSince = 0
  let takenAt = null
  for (let now = 0; now <= ceilingMs; now += 50) {
    if (turnActive && now - turnStartedAt >= turnMs) {
      turnActive = false
      boundaryAt = now              // turn_completed restamps the boundary
    } else if (!turnActive && now - boundaryAt >= gapMs) {
      turnActive = true
      turnStartedAt = now           // the circle starts its own next turn
    }
    if (now % personYieldMs !== 0) continue
    const claim = treeTurnDecision({
      now,
      queuedTreeTurns: 1,
      turnActive,
      personWaitingSince: null,
      boundaryAt,
      personYieldMs,
      queuedSince,
    })
    if (claim.take) { takenAt = now; break }
  }

  assert.notEqual(takenAt, null,
    `a message queued behind a circle whose own gap (${gapMs} ms) is shorter than personYieldMs (${personYieldMs} ms) ` +
    `must still be taken within a bounded time; it was refused at every poll for the whole ${ceilingMs} ms window`)
})
