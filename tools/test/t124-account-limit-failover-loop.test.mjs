/* T124. A SESSION AT A MODEL OR ACCOUNT LIMIT FAILS EVERY TURN, FOREVER.
 *
 * THE MEASURED DEFECT (T124 ledger entry). Manager (5323eb2d) returned
 * "You've reached your Fable limit. Switch to another model, or manage usage
 * credits" on MORE THAN THIRTY CONSECUTIVE TURNS from 21:47Z to 23:38Z, each
 * ending "Turn did not finish", WHILE MESSAGES KEPT BEING DELIVERED TO IT. The
 * same manager, Builder 4, Builder 6 and Builder (4a1a39df) had died the same
 * way at 20:25Z on another account's monthly spend limit. Every time, only the
 * owner's manual continuation on another account recovered the node, and the
 * tree lost its links each time.
 *
 * WHAT THIS SUITE PINS, and what it deliberately does not.
 *
 * It pins BEHAVIOUR, driven by values: deliveries are offered to a node whose
 * provider refuses with a limit, and the suite counts how many of them actually
 * became turns. The defect is a COUNT, not a spelling -- "thirty-plus turns and
 * still going" -- so the assertion is a count too. A better implementation that
 * stops the loop by some other means passes this suite unchanged.
 *
 * It does NOT pin the sentence a provider sends, the note text, the status
 * word, the policy field names, or the order the failover tries things. It
 * asks one question of the product -- "would a sender burn another turn on
 * this node right now?" -- through the coordinator's public fence, and treats
 * "there is no fence at all" as the defect, which is what the ledger measured.
 *
 * BOTH SHAPES THE LEDGER NAMES ARE COVERED. A limit reported as prose with NO
 * provider code (the shell's own verdict on the event, failureReason
 * 'account-limit' -- see shell/account-session-recovery.cjs limitReason and
 * tools/test/t17-limit-continuation-notification.test.mjs), and a limit
 * reported WITH a code (AGENT_RESUME_ACCOUNT_LIMIT).
 *
 * THE MODEL HALF RUNS AGAINST THE LANDED T137 SWITCH, NOT AGAINST A STAND-IN.
 * An earlier revision of this suite injected a `continueOnAnotherModel`
 * seam because the method did not exist. It exists now (the Controller landed
 * T137; cut2/app-landing-20260916 carries it at da09197d), so the seam is gone
 * and these tests drive the real method through the coordinator's own public
 * surface. What they steer is the BRIDGE -- whether a replacement session
 * starts -- which is the real-world variable, not an injected answer.
 *
 * NO REAL LIMIT IS INDUCED, no provider is contacted and no credential is
 * involved. Every refusal below is a literal in the fixture bridge.
 *
 *   node --test tools/test/t124-account-limit-failover-loop.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAccountRecoveryCoordinator } from '../../src/account-recovery-coordinator.js'
import { createFleetTreeStore } from '../../src/fleet-trees.js'
import { createTranscriptStore } from '../../src/session-transcript-store.js'
import { createRecoveryHandoffStore } from '../../src/recovery-handoff-store.js'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'

/* THE BOUND THIS SUITE DECLARES. The ledger measured "more than thirty"
   consecutive burnt turns over 111 minutes. The loop driver below offers
   DELIVERY_ROUNDS deliveries, which is more than the measured run, and the
   suite fails if the product consumes more than TURN_BUDGET of them. The
   budget is not one: a first limit refusal is information nobody had yet, and
   a failover attempt is allowed to cost a turn. What is not allowed is that
   the count keeps climbing with the deliveries. */
const DELIVERY_ROUNDS = 40
const TURN_BUDGET = 8

function memoryStorage() {
  const cells = new Map()
  return {
    read(key) { return cells.has(key) ? structuredClone(cells.get(key)) : null },
    write(key, value) { cells.set(key, structuredClone(value)); return true },
  }
}
const settle = () => new Promise(resolve => setImmediate(resolve))
async function drain(rounds = 60) { for (let i = 0; i < rounds; i++) await settle() }

const TIERS = [
  { id: 'claude-fable', provider: 'claude', label: 'Fable' },
  { id: 'claude-opus', provider: 'claude', label: 'Opus' },
  { id: 'astra', provider: 'codex', label: 'GPT-6-Astra', effort: 'max' },
]

/* THE LIMIT REFUSAL, IN THE TWO SHAPES THE LEDGER RECORDS.

   `prose` carries the shell's verdict and NO code, because the provider sent
   none -- the observed sentence contains none of `quota`, `usage limit` or
   `rate limit`, so the code regex alone never saw it. `coded` carries the
   code. Both must end the loop. */
const LIMIT_SHAPES = {
  prose: { failureReason: 'account-limit' },
  coded: { code: 'AGENT_RESUME_ACCOUNT_LIMIT', failureReason: 'account-limit' },
}

/* Controller -> Manager -> Worker, because the ledger requires the blocked
   node to notify BOTH its manager and the Controller, and a two-level tree
   cannot tell those two apart. */
function fixture(t, overrides = {}) {
  let serial = 0
  const treeStore = createFleetTreeStore({ computerId: 'local', storage: memoryStorage(), makeId: kind => `${kind}-${++serial}` })
  const add = args => { const result = treeStore.addNode(args); assert.equal(result.ok, true, result.problems?.join(' ')); return result.node }
  const controller = add({ role: 'controller', message: 'Run the cut' })
  const manager = add({ parentId: controller.id, role: 'manager', message: 'Manage the lane' })
  const worker = add({ parentId: manager.id, role: 'worker', message: 'Finish the task', tier: 'claude-fable' })
  assert.equal(treeStore.attachSession(controller.id, 'controller-session').ok, true)
  assert.equal(treeStore.attachSession(manager.id, 'manager-session').ok, true)
  assert.equal(treeStore.attachSession(worker.id, 'worker-session').ok, true)
  treeStore.setNodeStatus(worker.id, 'turn-failed')

  const transcriptStore = createTranscriptStore({ computerId: 'local', storage: memoryStorage() })
  assert.equal(transcriptStore.save(worker.id, { lines: [{ who: 'you', text: 'Finish the task', at: 1 },
    { who: 'agent', text: 'The first step is complete.', at: 2 }], threadId: 'old-thread', account: 'old-account', provider: 'claude' }), true)
  const handoffStore = createRecoveryHandoffStore({ computerId: 'local', storage: memoryStorage(), bridge: null })

  const calls = { send: [], sendAutomatic: [], start: [], close: [], continuations: [] }
  const listeners = new Set()
  const bridge = {
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    async close(args) { calls.close.push(args); return { sessionId: args.sessionId, closed: true } },
    async start(args) { calls.start.push(args); return overrides.start ? overrides.start(args) : { ok: false, code: 'ACCOUNT_RECOVERY_NO_ALTERNATE', reason: 'No eligible account.' } },
    async send(args) { calls.send.push(args); return { ok: true } },
    /* Recovery and escalation are automatic notices, not owner turns. The
       dedicated channel is required by 16cf5d642/b6b3102b3; retain generic
       send for the separate queued-turn behavior. */
    async sendAutomatic(args) { calls.sendAutomatic.push(args); return { ok: true, deliveryDisposition: 'accepted', result: { ok: true } } },
    async updateTreeAddress(args) { return { ok: true } },
    async continuations(args) { calls.continuations.push(args); return { ok: true, enabled: false, actionable: false, taskIds: [], records: [] } },
  }
  const sessionNodeIds = new Map([['worker-session', worker.id], ['manager-session', manager.id], ['controller-session', controller.id]])
  const published = []
  const coordinator = createAccountRecoveryCoordinator({ bridge, sessionNodeIds,
    tiers: TIERS, canStart: () => true, canContinue: () => true, onCleanupRequired: () => {},
    readAccounts: async () => ({ available: true, accounts: overrides.accounts || [{ name: 'old-account', provider: 'claude' }] }),
    ...overrides.retryOptions })
  const transcripts = { ...transcriptStore, readLatest: async id => ({ ...transcriptStore.get(id), recoveryDirectory: '/owned/node-records' }) }
  coordinator.register('local', { treeStore, transcriptStore: transcripts, handoffStore })
  coordinator.subscribe(value => published.push(value))
  t.after(() => coordinator.destroy())

  const emit = packet => { for (const listener of listeners) listener(packet) }

  /* WOULD A SENDER SPEND A TURN ON THIS NODE RIGHT NOW? This is the real
     sender contract, not an invented one: src/views/computers.js
     queueForSession refuses to drain into a node whose session is not live
     (nodeSessionEnded) and -- this is what T124 adds -- into a node that is
     externally blocked. Both gates are modelled, because a failed account
     sweep legitimately CLOSES the old session, and a test that kept firing
     turn events at a closed session would be measuring something that cannot
     happen.

     The fence probe is tolerant on purpose: at bytes where no fence exists it
     answers "deliverable", which is exactly the measured defect -- every
     delivery becomes another burnt turn. */
  const deliverable = () => {
    const live = treeStore.getNode(worker.id)
    if (!live?.sessionId || sessionNodeIds.get(live.sessionId) !== live.id) return false
    const block = typeof coordinator.externalBlock === 'function' ? coordinator.externalBlock(live.id) : null
    return block?.blocked !== true
  }
  const fenced = () => coordinator.externalBlock?.(worker.id)?.blocked === true

  return { coordinator, treeStore, transcripts, handoffStore, sessionNodeIds, bridge, calls, published,
    controller, manager, worker, emit, deliverable, fenced }
}

/* THE LOOP, DRIVEN BY VALUES. Each round is one message arriving for a node
   whose provider is refusing on a limit: ask the fence, and if nothing stops
   the delivery, spend the turn and let the provider refuse it. Returns how
   many of the offered deliveries actually became turns. */
async function driveLimitLoop(f, shape) {
  let turnsConsumed = 0
  for (let round = 0; round < DELIVERY_ROUNDS; round++) {
    if (!f.deliverable()) { await drain(4); continue }
    const sessionId = f.treeStore.getNode(f.worker.id).sessionId
    turnsConsumed += 1
    await f.bridge.send({ sessionId, text: `message ${round}` })
    f.emit({ sessionId, event: { type: 'turn_completed', status: 'failed',
      turnId: `limit-turn-${round}`, ...LIMIT_SHAPES[shape] } })
    await drain()
  }
  return turnsConsumed
}

for (const shape of ['prose', 'coded']) {
  test(`T124 a ${shape} limit refusal stops consuming turns instead of failing every turn forever`, async t => {
    const f = fixture(t)
    const turnsConsumed = await driveLimitLoop(f, shape)
    assert.ok(turnsConsumed <= TURN_BUDGET,
      `the node consumed ${turnsConsumed} of ${DELIVERY_ROUNDS} offered deliveries; the measured defect is that the count never stops climbing`)
    assert.equal(f.fenced(), true, 'deliveries are still not fenced after a sustained limit refusal')
  })

  test(`T124 a ${shape} limit with no candidate left marks the node blocked-external with the reason`, async t => {
    const f = fixture(t)
    await driveLimitLoop(f, shape)
    const block = f.coordinator.externalBlock(f.worker.id)
    assert.equal(block?.blocked, true, 'the node was never marked blocked-external')
    assert.equal(typeof block.reason, 'string')
    assert.ok(block.reason.trim().length > 0, 'a blocked-external marking with no reason tells the person nothing')
    /* The reason is on the TREE too, not only in coordinator memory: the
       manager and the Controller read the tree, not this object. */
    const note = f.treeStore.getNode(f.worker.id)?.statusNote || ''
    assert.ok(note.trim().length > 0, 'the tree carries no reason for the block')
  })

  test(`T124 a ${shape} limit with no candidate left notifies the manager and the Controller`, async t => {
    const f = fixture(t)
    await driveLimitLoop(f, shape)
    const told = new Set(f.calls.sendAutomatic.map(row => row.sessionId))
    assert.ok(told.has('manager-session'), 'the manager was never told its worker is blocked')
    assert.ok(told.has('controller-session'), 'the Controller was never told')
    /* Escalation is not a second loop: one notice per block episode, not one
       per refused delivery. */
    for (const target of ['manager-session', 'controller-session']) {
      const count = f.calls.sendAutomatic.filter(row => row.sessionId === target).length
      assert.equal(count, 1, `${target} was notified ${count} times for one block`)
    }
  })
}

/* ROTATION ON (T44/T17). The ledger's first requirement is that a limit
   refusal actually TRIES another account, which the measured run never did
   once in thirty turns -- and its last is that when the sweep finds nothing,
   the node ends blocked rather than back in the loop. */
test('T124 with rotation on, a limit sweeps other accounts and ends blocked when none takes it', async t => {
  const clock = Date.parse('2026-09-16T00:00:00Z')
  const f = fixture(t, {
    accounts: [{ name: 'old-account', provider: 'claude' }, { name: 'own-codex', provider: 'codex' }],
    retryOptions: { now: () => clock, orgBridge: {
      read: async () => ({ ok: true, org: { revision: 2, agents: [{ id: 'worker-seat', role: 'worker', enabled: true }] }, roles: [{ id: 'worker', revision: 3 }] }),
      ensureSeat: async () => ({ ok: true, org: { revision: 4 } }) } },
    start: () => ({ ok: false, code: 'ACCOUNT_RECOVERY_NO_ALTERNATE', reason: 'No eligible account.',
      accountRetry: { provider: 'codex', account: null, attempts: [], retry: { nextAttemptAt: null, resetAt: null, reason: 'observed-reset' } } }),
  })
  /* The agent is mid-turn when the person turns rotation on, which is when it
     actually happens: the opt-in records the choice and starts nothing, so the
     live session is still there to receive the limit refusal below. */
  assert.equal(f.treeStore.setNodeStatus(f.worker.id, 'running').ok, true)
  assert.equal(await f.coordinator.keepTryingAccounts({ computerId: 'local', nodeId: f.worker.id, waitForReset: false,
    allowedProviders: ['claude', 'codex'],
    startOptions: { tier: 'claude-fable', effort: 'max', roleBinding: { agentId: 'worker-seat', id: 'worker', expectedOrgRevision: 2, expectedRoleRevision: 3 } } }), true)
  assert.equal(f.coordinator.retryPolicy(f.worker.id)?.enabled, true, 'the rotation opt-in was not recorded')
  assert.equal(f.calls.start.length, 0, 'the opt-in started a session instead of recording the choice')

  const turnsConsumed = await driveLimitLoop(f, 'prose')
  assert.ok(f.calls.start.length > 0, 'the limit refusal never tried another account')
  assert.ok(turnsConsumed <= TURN_BUDGET,
    `the node consumed ${turnsConsumed} of ${DELIVERY_ROUNDS} offered deliveries with rotation on`)
  assert.equal(f.fenced(), true, 'an exhausted account sweep left the node unfenced')
  const told = new Set(f.calls.sendAutomatic.map(row => row.sessionId))
  assert.ok(told.has('manager-session') && told.has('controller-session'),
    'an exhausted account sweep escalated to nobody')
})

/* THE MODEL HALF OF THE FAILOVER, RUN THROUGH THE LANDED T137 SWITCH.
 *
 * The ledger's own words are "switches to another available model or account",
 * and the model switch is continueOnAnotherModel (owner request T137, landed
 * by the Controller). These tests do not inject it and do not assert its
 * spelling; they steer the BRIDGE -- whether a replacement session starts --
 * and read what the agent ends up on. Any implementation that moves the agent
 * to another offered model passes them unchanged.
 *
 * The worker starts on 'claude-fable'. TIERS offers two others. A start
 * carrying a `tier` and no `continueFromAccount` is a model continuation
 * (src/account-recovery-coordinator.js recover(): a model continuation "names
 * no account to move away from"), which is how these tests count them without
 * reaching inside the coordinator. */
const modelStarts = f => f.calls.start.filter(row => row.tier && row.continueFromAccount === undefined)

test('T124 the failover really moves the agent to another model, and blocks only when none takes it', async t => {
  const f = fixture(t)
  await driveLimitLoop(f, 'prose')

  const tried = modelStarts(f).map(row => row.tier)
  assert.ok(tried.length > 0,
    'the limit refusal never tried another model -- the ledger asks for another model or account, and this is the model half')
  assert.ok(tried.includes('claude-opus') && tried.includes('astra'),
    `the failover stopped before it had offered every other model; it tried ${JSON.stringify(tried)}`)
  assert.ok(!tried.includes('claude-fable'),
    'the failover offered the agent the very model that is refusing it')
  assert.equal(f.coordinator.externalBlock(f.worker.id)?.blocked, true,
    'every model refused this agent and it was still not fenced')
})

/* TERMINATION, WHICH IS THE WHOLE POINT. A failover that keeps trying models
   forever is T124 rebuilt one storey up: the measured defect was thirty-plus
   turns that never stopped climbing, and a walk that cycles fable -> opus ->
   fable spends turns the same way. Forty deliveries are offered; each model
   may be attempted AT MOST ONCE. */
test('T124 the model walk terminates: no model is offered twice however long the limit lasts', async t => {
  const f = fixture(t)
  await driveLimitLoop(f, 'prose')

  const tried = modelStarts(f).map(row => row.tier)
  const seen = new Set(tried)
  assert.equal(tried.length, seen.size,
    `a model was offered more than once across ${DELIVERY_ROUNDS} deliveries: ${JSON.stringify(tried)} -- the walk cycles instead of terminating`)
  assert.ok(tried.length <= TIERS.length - 1,
    `the walk attempted ${tried.length} switches with only ${TIERS.length - 1} other models offered`)

  /* And the derived answer is recorded, not thrown away. The landed switch
     returns a bare Boolean; which models were spent and why the last one
     refused are derived at the call site, because a manager reading the tree
     needs to know the difference between "nothing left to try" and "something
     else is already moving it". */
  const block = f.coordinator.externalBlock(f.worker.id)
  assert.deepEqual([...(block?.modelSwitch?.attempted || [])], tried,
    'the block does not record which models the failover actually spent')
  assert.ok((block?.modelSwitch?.refusedBecause || '').trim().length > 0,
    'the block records no reason the model switch was refused')
})

test('T124 a model switch that succeeds is not blocked and keeps the node working', async t => {
  const f = fixture(t, { start: args => ({ ok: true, sessionId: `moved-${args.tier}`, account: 'old-account' }) })

  const sessionId = f.treeStore.getNode(f.worker.id).sessionId
  f.emit({ sessionId, event: { type: 'turn_completed', status: 'failed', turnId: 'limit-turn-0', ...LIMIT_SHAPES.prose } })
  await drain()

  const live = f.treeStore.getNode(f.worker.id)
  assert.notEqual(live.tier, 'claude-fable',
    'the agent is still on the model that is refusing it -- the switch did not take')
  assert.equal(f.fenced(), false,
    'a node that successfully moved to another model must not be marked blocked-external')
  assert.equal(f.deliverable(), true, 'the node moved models and still refuses deliveries')
})

/* THE DISTINCTION A BARE BOOLEAN CANNOT MAKE. continueOnAnotherModel answers
   `false` both for "no model left" and for "a turn is still running on this
   agent" -- and those want opposite responses. Mid-turn, the right answer is
   to stand back: nothing may close a live turn out from under itself (the
   landed switch holds that guard too), and fencing an agent whose turn has not
   even finished would stop an agent nothing is yet wrong with. */
test('T124 a limit arriving mid-turn stands back instead of fencing or closing the turn', async t => {
  const f = fixture(t)
  assert.equal(f.treeStore.setNodeStatus(f.worker.id, 'running').ok, true)

  const sessionId = f.treeStore.getNode(f.worker.id).sessionId
  f.emit({ sessionId, event: { type: 'turn_completed', status: 'failed', turnId: 'limit-turn-0', ...LIMIT_SHAPES.prose } })
  await drain()

  assert.equal(modelStarts(f).length, 0,
    'a live turn was closed out from under itself to try another model')
  assert.equal(f.fenced(), false,
    'an agent whose turn is still running was fenced as though nothing could be done for it')
})

/* THE IDENTIFIER GOES WHERE A PERSON DOES NOT READ IT.
 *
 * This is a REGRESSION I SHIPPED AND THEN CAUGHT: the first version of this
 * failover composed "The provider refused this turn (CODE)" into the note the
 * tree shows, and tools/test/refusal-copy.test.mjs named the exact line -- "no
 * view or copy module interpolates a code into a string a person reads". That
 * suite pins the SOURCE TEXT of every view and copy module. This one pins the
 * BEHAVIOUR from the other side, by reading what the product actually put in
 * front of a person, so the invariant survives a rewrite that the source-text
 * scan would not recognise.
 *
 * Both halves matter and they are asserted separately: the person-facing
 * reason and the tree note carry NO identifier, and the identifier is still
 * RECORDED, because a block whose code is nowhere makes a support conversation
 * guess. */
test('T124 the block shows a person no refusal code, and still records the code', async t => {
  const f = fixture(t)
  await driveLimitLoop(f, 'coded')

  const block = f.coordinator.externalBlock(f.worker.id)
  assert.equal(block?.blocked, true, 'precondition: the node is blocked')

  /* Shaped like this product's identifiers -- the same rule refusal-copy.js
     uses to decide something IS a code (IDENTIFIER_RE): SHOUTING_SNAKE_CASE.
     Asserting on the shape rather than on the literal 'AGENT_RESUME_ACCOUNT_LIMIT'
     means a different code leaking is caught too. */
  const identifier = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/
  const note = f.treeStore.getNode(f.worker.id)?.statusNote || ''
  assert.equal(identifier.test(block.reason), false,
    `the reason a person reads carries a refusal code: ${JSON.stringify(block.reason)}`)
  assert.equal(identifier.test(note), false,
    `the note on the tree carries a refusal code: ${JSON.stringify(note)}`)

  /* And the escalation is person-facing too -- it is sent into the manager's
     and the Controller's own conversations. */
  for (const row of f.calls.sendAutomatic.filter(row => ['manager-session', 'controller-session'].includes(row.sessionId))) {
    assert.equal(identifier.test(row.text), false,
      `the escalation notice carries a refusal code: ${JSON.stringify(row.text)}`)
  }

  assert.equal(block.code, 'AGENT_RESUME_ACCOUNT_LIMIT',
    'the code is nowhere at all -- a support conversation has nothing to ask about')
})

/* THE INVARIANT THAT MUST KEEP WINNING. retrySafetyRefusal is checked before
   any limit classification, and this fence must not become a way around it: a
   refusal that needs a person's review is not an account limit, even when the
   shell also put an 'account-limit' verdict on the same event. */
test('T124 a safety refusal is not treated as an account limit', async t => {
  const f = fixture(t)
  f.emit({ sessionId: 'worker-session', event: { type: 'turn_completed', status: 'failed',
    turnId: 'refused-turn', code: 'AGENT_PERMISSION_DENIED', failureReason: 'account-limit' } })
  await drain()
  const block = typeof f.coordinator.externalBlock === 'function' ? f.coordinator.externalBlock(f.worker.id) : null
  assert.equal(block?.blocked === true, false, 'a permission refusal was laundered into an account-limit block')
})

/* THE WAY OUT OF THE BLOCK MATTERS AS MUCH AS THE WAY IN.
 *
 * A fence with no exit is worse than the defect it replaces: the measured run
 * at least recovered whenever the owner continued the node by hand, and a node
 * that can never take another turn again would lose that. The block is a fence
 * on SPENDING TURNS, never a stop on recovery, so each of the three ways a node
 * can genuinely come back must clear it. Two of them are asserted here; the
 * third (a successful model switch) is asserted above. */
test('T124 a turn that actually lands clears the block', async t => {
  const f = fixture(t)
  await driveLimitLoop(f, 'prose')
  assert.equal(f.fenced(), true, 'precondition: the node is blocked')

  const sessionId = f.treeStore.getNode(f.worker.id).sessionId
  f.emit({ sessionId, event: { type: 'turn_completed', status: 'completed', turnId: 'recovered-turn' } })
  await drain()

  assert.equal(f.fenced(), false,
    'the allowance reset or the person moved the node, but the fence never lifted -- it can never take another turn')
  /* And the fence really is open again, not merely reported open: deliveries
     resume. */
  assert.equal(f.deliverable(), true, 'the node is unblocked but still refuses deliveries')
})

test("T124 the owner's manual continuation on another account clears the block", async t => {
  /* Only the ACCOUNT continuation starts here. A model continuation names no
     account to move away from (recover()), so `continueFromAccount` is exactly
     what tells the two apart -- and this fixture is the measured situation:
     no other model would take the agent, and the person's own move on another
     account did. */
  const f = fixture(t, { start: args => (args.continueFromAccount
    ? { ok: true, sessionId: 'rescued-session', account: 'other-account' }
    : { ok: false, code: 'ACCOUNT_RECOVERY_NO_ALTERNATE', reason: 'No eligible account.' }) })
  await driveLimitLoop(f, 'prose')
  assert.equal(f.fenced(), true, 'precondition: the node is blocked')

  /* This is the move that recovered the node by hand every single time in the
     measured run. When it works, the block is over. */
  const moved = await f.coordinator.continueOnAnotherAccount({ computerId: 'local', nodeId: f.worker.id,
    startOptions: { tier: 'claude-opus' } })
  assert.equal(moved, true, "the manual continuation did not start -- re-check this test's premise, not the fence")
  assert.equal(f.fenced(), false,
    'the owner continued this agent on another account and it is still fenced')
})

/* THE DOOR THAT ACTUALLY BURNT THE THIRTY TURNS, now exercised through
 * values rather than an implementation spelling. The existing bounded
 * declared-function harness compiles the real queueForSession closure with a
 * tiny outbox and coordinator seam: a blocked node must retain its entry and
 * never take or drain it, while an idle unblocked node must take and drain
 * exactly its queued entry. A replacement of the widened busy predicate or a
 * move of the external-block decision after the drain therefore fails by
 * behavior, not by source-text shape. */
const VIEW = readFileSync(join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'src', 'views', 'computers.js'), 'utf8')

function queueHarness({ blocked = false, pendingChoice = false } = {}) {
  const node = { id: 't124-node', sessionId: 't124-session' }
  const waiting = [], taken = [], drained = []
  let serial = 0
  const context = {
    treeStore: { getNode: id => id === node.id ? node : null },
    outboxEnqueue(sessionId, text) {
      const entry = { id: 'entry-' + (++serial), text }
      waiting.push({ sessionId, entry })
      return { ok: true, entry }
    },
    QUEUE_PANEL: { cardQueued: 'queued', cardQueuedIdle: 'sent now' },
    nodeBusy: () => false,
    pendingModelChoice: () => pendingChoice,
    nodeReplacementFlight: { busy: () => false },
    recoveryCoordinator: () => ({ externalBlock: () => ({ blocked }) }),
    nodeSessionEnded: () => false,
    outboxTakeNext(sessionId) {
      if (blocked) throw new Error('blocked node was drained')
      const index = waiting.findIndex(row => row.sessionId === sessionId)
      const row = index < 0 ? null : waiting.splice(index, 1)[0]
      if (row) taken.push(row)
      return row?.entry || null
    },
    drainOutboxMessage(sessionId, nodeId, entry) {
      if (blocked) throw new Error('blocked node reached drain')
      drained.push({ sessionId, nodeId, text: entry.text })
    },
  }
  const queueForSession = vm.runInNewContext(
    '(' + declaredFunctionSource(VIEW, 'queueForSession') + ')',
    context,
  )
  return { node, queueForSession, waiting, taken, drained }
}

test('T124 the one enqueue door asks about an external block before it drains onto the wire', () => {
  const blocked = queueHarness({ blocked: true })
  const retained = blocked.queueForSession(blocked.node, 'blocked text')
  assert.equal(retained.ok, true)
  assert.equal(retained.sentence, 'queued')
  assert.deepEqual(blocked.taken, [])
  assert.deepEqual(blocked.drained, [])
  assert.deepEqual(blocked.waiting.map(row => row.entry.text), ['blocked text'])

  const pending = queueHarness({ pendingChoice: true })
  const pendingResult = pending.queueForSession(pending.node, 'pending model text')
  assert.equal(pendingResult.ok, true)
  assert.equal(pendingResult.sentence, 'queued')
  assert.deepEqual(pending.taken, [])
  assert.deepEqual(pending.drained, [])
  assert.deepEqual(pending.waiting.map(row => row.entry.text), ['pending model text'])

  const open = queueHarness()
  const delivered = open.queueForSession(open.node, 'idle text')
  assert.equal(delivered.ok, true)
  assert.equal(delivered.sentence, 'sent now')
  assert.deepEqual(open.taken.map(row => row.entry.text), ['idle text'])
  assert.deepEqual(open.drained, [{ sessionId: 't124-session', nodeId: 't124-node', text: 'idle text' }])
})
