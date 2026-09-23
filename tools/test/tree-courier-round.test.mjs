import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'

const require_ = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const { planTreeRound } = require_(path.join(ROOT, 'shell', 'tree-courier-round.cjs'))

/* THE DEFECT THESE PIN, MEASURED 2026-09-03 on an isolated state root with
   forty messages already on the wire and a 12,608-byte broker spool, driving
   the courier's own 1200 ms tick:

     whole tick, three circles   13.96 / 15.10 / 17.19 ms   min / median / max
     whole tick, six circles     25.66 / 30.70 / 49.05 ms

   The courier asked the engine one question per circle per tick and every one
   of those questions re-read the tree directory and re-checked the roster to
   read one page -- identical answers, recomputed per circle. And with every
   circle gone it went on ticking 0.83 times a second until the app quit,
   because startTreePolling() had no counterpart short of closing the host.

   These call the rule with values. The last one reads the host, because a
   correct rule nothing consults is decoration. */

const circle = (over = {}) => ({
  sessionId: 'session-1',
  state: 'ready',
  treeAddress: { agentId: 'tree-aaaa', selfName: 'Circle1', managerName: 'Controller' },
  treeCursor: 0,
  treePumpPromise: null,
  ...over,
})

test('with nobody on the tree the courier has nothing to carry and says so', () => {
  /* `awaiting` rides the answer now: a circle that knows its NAME but holds no
     address is not on the tree and has nothing to be read from, yet it is not
     idle either -- it is waiting for the directory, and this courier's timer is
     the only clock its registration retry rides. The sessions below have no
     treeIdentity, so none of them is waiting and the list is empty. */
  assert.deepEqual(planTreeRound([]), { idle: true, requests: [], awaiting: [] })
  assert.deepEqual(
    planTreeRound([
      { sessionId: 'a', state: 'ready', treeAddress: null },
      { sessionId: 'b', state: 'ready' },
    ]),
    { idle: true, requests: [], awaiting: [] },
    'sessions that were never briefed onto the tree cannot be written to, so they are not the courier\'s business',
  )

  /* AND THE CASE THE FIELD EXISTS FOR: briefed, named, still unaddressed. Not
     on the tree, but reporting idle here would stop the timer that is about to
     ask the directory again -- which is how a circle whose registration was
     refused once stayed unreachable forever. */
  const waiting = planTreeRound([
    { sessionId: 'c', state: 'ready', treeAddress: null, treeIdentity: { selfName: 'Manager', managerName: null } },
  ])
  assert.equal(waiting.idle, false, 'a circle waiting on the directory must keep the courier awake')
  assert.deepEqual(waiting.requests, [], 'but there is nothing to read for it yet')
  assert.deepEqual(waiting.awaiting, ['c'])
  // An address with no durable id is not an address. Answering otherwise would
  // keep the timer alive for a circle no message can ever reach.
  assert.deepEqual(
    planTreeRound([{ sessionId: 'a', state: 'ready', treeAddress: { agentId: '' } }]),
    { idle: true, requests: [], awaiting: [] },
  )
})

test('a circle that is merely quiet is still read -- silence is not idleness', () => {
  const plan = planTreeRound([circle()])
  assert.equal(plan.idle, false, 'a quiet circle still has to be read or the next arrival waits for something else to happen')
  assert.deepEqual(plan.requests, [
    { sessionId: 'session-1', agentId: 'tree-aaaa', cursor: 0, limit: 10 },
  ])
})

test('the round carries each circle\'s own cursor, and an unusable one reads as the beginning', () => {
  const plan = planTreeRound([
    circle({ sessionId: 'a', treeAddress: { agentId: 'tree-aaaa' }, treeCursor: 41 }),
    circle({ sessionId: 'b', treeAddress: { agentId: 'tree-bbbb' }, treeCursor: undefined }),
    circle({ sessionId: 'c', treeAddress: { agentId: 'tree-cccc' }, treeCursor: Number.NaN }),
  ], { inboxLimit: 3 })

  assert.deepEqual(plan.requests, [
    { sessionId: 'a', agentId: 'tree-aaaa', cursor: 41, limit: 3 },
    { sessionId: 'b', agentId: 'tree-bbbb', cursor: 0, limit: 3 },
    { sessionId: 'c', agentId: 'tree-cccc', cursor: 0, limit: 3 },
  ], 'a cursor that is not a number must read from the start, never be sent as NaN or skip a circle')
})

test('a circle that is not ready keeps the courier running and is not read this round', () => {
  const plan = planTreeRound([
    circle({ sessionId: 'starting', state: 'starting' }),
    circle({ sessionId: 'ending', state: 'ended', treeAddress: { agentId: 'tree-bbbb' } }),
  ])
  assert.equal(plan.idle, false, 'a circle still holding an address is still addressable, so the courier must keep ticking')
  assert.deepEqual(plan.requests, [], 'nothing may be read for a session that cannot take a turn')
})

test('a circle already mid-pass is left alone, so one arrival is never queued twice', () => {
  const inFlight = circle({ sessionId: 'busy', treePumpPromise: Promise.resolve() })
  const free = circle({ sessionId: 'free', treeAddress: { agentId: 'tree-bbbb' }, treeCursor: 7 })
  const plan = planTreeRound([inFlight, free])

  assert.equal(plan.idle, false)
  assert.deepEqual(plan.requests, [
    { sessionId: 'free', agentId: 'tree-bbbb', cursor: 7, limit: 10 },
  ], 'reading again from a cursor a pass has not advanced yet delivers the same message to the same agent twice')
})

test('the courier stops when the last circle leaves and wakes when one registers', () => {
  /* THE WAKE PATH, as a transition rather than a snapshot. The same sessions
     that answered idle answer not-idle the instant one of them is given an
     address -- which is exactly what registerTreeSession() does, and why it is
     the thing that starts the timer again. */
  const sessions = [{ sessionId: 'a', state: 'ready', treeAddress: null }]
  assert.equal(planTreeRound(sessions).idle, true, 'with the tree empty the timer must be allowed to stop')

  sessions[0].treeAddress = { agentId: 'tree-aaaa' }
  sessions[0].treeCursor = 0
  const woken = planTreeRound(sessions)
  assert.equal(woken.idle, false, 'a circle that has just been briefed must wake the courier, not wait for one to be running')
  assert.deepEqual(woken.requests, [{ sessionId: 'a', agentId: 'tree-aaaa', cursor: 0, limit: 10 }])

  sessions[0].treeAddress = null
  assert.equal(planTreeRound(sessions).idle, true, 'and when it leaves the tree the courier must be able to stop again')
})

test('the host plans the round, stops when the tree empties, and reads once for all of it', () => {
  const host = readFileSync(path.join(ROOT, 'shell', 'agent-host.cjs'), 'utf8')

  assert.match(host, /require\('\.\/tree-courier-round\.cjs'\)/, 'the host stopped consulting the round rule')

  const round = host.slice(host.indexOf('async function pumpTreeRound'), host.indexOf('function startTreePolling'))
  assert.ok(round.length > 200, 'pumpTreeRound left agent-host.cjs')
  assert.match(round, /planTreeRound\(sessions\.values\(\)/, 'the round no longer asks who is on the tree')
  assert.ok(round.indexOf('if (plan.idle)') < round.indexOf('readTreeInboxes('),
    'the round reads the durable inbox before finding out whether anybody is on the tree')
  assert.match(round, /stopTreePolling\(\)/, 'an empty tree no longer stops the timer, so it ticks until the app quits')
  assert.match(round, /readTreeInboxes\(plan\.requests\)/, 'the round no longer reads for the whole plan at once')
  assert.ok(!/await pumpTreeSession\(/.test(round),
    'the round awaits one circle\'s hand-off before offering the next; on Claude that is the whole turn, paid by every other circle')

  const read = host.slice(host.indexOf('async function readTreeInboxes'), host.indexOf('function pumpTreeSessionOnce'))
  assert.ok(read.length > 200, 'readTreeInboxes left agent-host.cjs')
  assert.match(read, /typeof treeMessaging\.provider\.inboxes === 'function'/,
    'the batched read is assumed rather than asked for, so an older installed engine gets a call it does not have')
  assert.match(read, /treeMessaging\.provider\.inbox\(\{/,
    'the per-circle fallback is gone, so an older installed engine reads nothing at all')

  const pump = host.slice(host.indexOf('function pumpTreeSessionOnce'), host.indexOf('function pumpTreeSession('))
  assert.ok(!/provider\.inbox/.test(pump),
    'the per-circle read is back inside the per-circle pass, which is the cost this round exists to remove')

  for (const name of ['registerTreeSession', 'adoptTreeAddressFromThread', 'adoptTreeAddress', 'updateTreeAddress']) {
    const binding = declaredFunctionSource(host, name)
    assert.equal((binding.match(/startTreePolling\(\)/g) || []).length, 1,
      `${name} must wake the courier after registering, resuming, adopting, or moving a live agent`)
  }
})
