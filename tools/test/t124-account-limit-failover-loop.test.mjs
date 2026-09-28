/* T124. A SESSION AT A MODEL OR ACCOUNT LIMIT FAILS EVERY TURN, FOREVER.
 *
 * THE MEASURED DEFECT (T124). A manager returned the provider's usage-limit
 * message on MORE THAN THIRTY CONSECUTIVE TURNS, each ending "Turn did not
 * finish", WHILE MESSAGES KEPT BEING DELIVERED TO IT. Every time, only a
 * manual continuation on another account recovered the node, and the
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
 * T137; the landing branch carries it), so the seam is gone
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
import { LAUNCH_TIERS } from '../../src/orchestration-controls.js'
import { MODEL_PANEL } from '../../src/fleet-tree-copy.js'

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
  const worker = add({ parentId: manager.id, role: 'worker', message: 'Finish the task', tier: overrides.workerTier || 'claude-fable' })
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
       dedicated channel is required by an earlier commit; retain generic
       send for the separate queued-turn behavior. */
    async sendAutomatic(args) { calls.sendAutomatic.push(args); return { ok: true, deliveryDisposition: 'accepted', result: { ok: true } } },
    async updateTreeAddress(args) { return { ok: true } },
    async continuations(args) { calls.continuations.push(args); return { ok: true, enabled: false, actionable: false, taskIds: [], records: [] } },
  }
  const sessionNodeIds = new Map([['worker-session', worker.id], ['manager-session', manager.id], ['controller-session', controller.id]])
  const published = []
  const coordinator = createAccountRecoveryCoordinator({ bridge, sessionNodeIds,
    tiers: overrides.tiers || TIERS, canStart: () => true, canContinue: () => true, onCleanupRequired: () => {},
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
 * and the model switch is continueOnAnotherModel (request T137). These tests do not inject it and do not assert its
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

/* D6 (1.0.48): A PINNED MODEL IS NEVER SWAPPED BY THE FAILOVER. A row that
   names one exact model was chosen by the person; every other row is a
   different model -- the `claude-opus` alias runs Opus 5.5, not Opus 5. The
   walk leaves such an agent on its model (the account half still runs; here no
   other account exists, so it ends blocked), and it never moves anybody ONTO a
   pinned row either: an exact older version is a choice, not a stand-in. Every
   start below would succeed, so a model start that happens is a move that
   happened. */
const PINNED_TIERS = [
  { id: 'claude-opus-5', provider: 'claude', label: 'Opus 5', pinned: true },
  { id: 'claude-fable', provider: 'claude', label: 'Fable (latest)' },
  { id: 'claude-opus', provider: 'claude', label: 'Opus (latest)' },
  { id: 'astra', provider: 'codex', label: 'GPT-6-Astra', effort: 'max' },
]

test('D6 an agent on a pinned model is not moved to another model when it hits a limit', async t => {
  const f = fixture(t, { workerTier: 'claude-opus-5', tiers: PINNED_TIERS,
    start: args => ({ ok: true, sessionId: `moved-${args.tier}`, account: 'old-account' }) })
  const sessionId = f.treeStore.getNode(f.worker.id).sessionId
  f.emit({ sessionId, event: { type: 'turn_completed', status: 'failed', turnId: 'limit-turn-0', ...LIMIT_SHAPES.prose } })
  await drain()

  assert.deepEqual(modelStarts(f).map(row => row.tier), [], 'the failover moved a pinned agent to another model')
  assert.equal(f.treeStore.getNode(f.worker.id).tier, 'claude-opus-5', 'the agent is no longer on the model its person chose')
  const block = f.coordinator.externalBlock(f.worker.id)
  assert.equal(block?.blocked, true, 'with no other account the agent must stop spending turns')
  assert.match(f.treeStore.getNode(f.worker.id).statusNote || '', /keeps the model you chose/,
    'the tree does not say why no other model was tried')
})

test('D6 the failover never moves an agent onto a pinned model', async t => {
  const f = fixture(t, { tiers: PINNED_TIERS })
  await driveLimitLoop(f, 'prose')
  const tried = modelStarts(f).map(row => row.tier)
  assert.ok(tried.includes('claude-opus') && tried.includes('astra'), `the walk stopped early: ${JSON.stringify(tried)}`)
  assert.ok(!tried.includes('claude-opus-5'), 'the walk offered an exact older version as a stand-in')
})

/* REVIEW P6. The walk goes through the model table in order, and 1.0.48 put
   GPT-6-Sol and GPT-6-Luna between GPT-6-Astra and GPT-5.6-Luna and added
   Gemini 3.1 Flash Lite, all unpinned: an Astra agent at a limit got two extra
   Codex attempts and could land on GPT-6-Sol. The walk keeps exactly the
   candidates, in the order, it had before 1.0.48 -- the 1.0.47 table below,
   written out rather than read from the subject. And the depth it carries is
   held to each model: an Astra agent at ultra moved to GPT-5.6-Luna sent
   model_reasoning_effort=ultra to a model with no ultra. */
const WALK_BEFORE_1_0_48 = Object.freeze(['astra', 'luna', 'terra', 'sol', 'claude-fable', 'claude-sonnet', 'claude-opus',
  'agy-gemini-3-8-flash-high', 'agy-gemini-3-8-flash-medium', 'agy-gemini-3-8-flash-low',
  'agy-gemini-3-7-flash-high', 'agy-gemini-3-7-flash-medium', 'agy-gemini-3-7-flash-low',
  'agy-gemini-3-6-flash-high', 'agy-gemini-3-6-flash-medium', 'agy-gemini-3-6-flash-low',
  'agy-gemini-3-1-pro-high', 'agy-gemini-3-1-pro-low', 'gemini', 'gemini-3-1-pro', 'gemini-3-flash',
  'gemini-2-5-pro', 'gemini-2-5-flash', 'grok', 'grok-4-6', 'grok-4-5', 'local'])

test('P6 the model walk keeps its pre-1.0.48 candidates and carries only a depth each model takes', async t => {
  const f = fixture(t, { workerTier: 'astra', tiers: LAUNCH_TIERS })
  assert.equal(f.treeStore.setNodeLaunchPreferences(f.worker.id, { effort: 'ultra' }).ok, true)
  await driveLimitLoop(f, 'prose')
  const tried = modelStarts(f)
  assert.deepEqual(tried.map(row => row.tier), WALK_BEFORE_1_0_48.filter(id => id !== 'astra'),
    'the walk offered a model added in 1.0.48, or changed its order')
  const effortOn = id => tried.find(row => row.tier === id)?.effort
  assert.equal(effortOn('luna'), 'medium', 'ultra reached GPT-5.6-Luna, which has no ultra')
  assert.equal(effortOn('terra'), 'ultra', 'a depth the model takes is still carried')
  /* Follow-up V4: a node's saved depth stays with its provider; Claude starts
     at its own default. (A retry the person opted into at ultra still runs
     Claude at max: account-recovery-coordinator's "a retry carries only a
     depth each model takes".) */
  assert.equal(effortOn('claude-opus'), undefined, 'a saved Codex depth crossed onto Claude')
  assert.equal(effortOn('agy-gemini-3-8-flash-low'), 'low', 'an Antigravity row keeps its own fixed depth')
  assert.equal(effortOn('gemini'), undefined, 'Gemini Automatic is sent no depth')
})

/* FOLLOW-UP V4. The automatic walk still carried a depth from Codex onto
   Claude ("Codex and Claude share effort words"), so an untouched GPT-6-Astra
   agent -- which saves Codex's default, medium -- started Fable, Sonnet and
   Opus at --effort medium, a depth nobody chose. The rule review P2 gave the
   next-model menu and Switch and continue holds here too: a saved depth
   travels only within its provider, and only the person's recorded retry
   choice crosses; otherwise the model's own default. */
test('V4 the model walk carries an untouched Codex default within Codex only', async t => {
  const f = fixture(t, { workerTier: 'astra', tiers: LAUNCH_TIERS })
  assert.equal(f.treeStore.setNodeLaunchPreferences(f.worker.id, { effort: 'medium' }).ok, true)
  await driveLimitLoop(f, 'prose')
  const tried = modelStarts(f)
  const effortOn = id => tried.find(row => row.tier === id)?.effort ?? null
  for (const id of ['luna', 'terra', 'sol']) assert.equal(effortOn(id), 'medium', `${id} lost a depth its own provider saved`)
  for (const id of ['claude-fable', 'claude-sonnet', 'claude-opus']) {
    assert.ok(tried.some(row => row.tier === id), `the walk never reached ${id}`)
    assert.equal(effortOn(id), null, `${id} was started at Codex's default depth`)
  }
})

/* FOLLOW-UP V4, verify round 2. Turning the retry chip off records a policy,
   and it recorded the node's saved depth -- an untouched GPT-6-Astra agent's
   Codex default, medium -- as the person's own preferredEffort, the one depth
   the walk carries to another provider. So after "off" the walk started Fable,
   Sonnet and Opus at medium again. A default is recorded only as a default now. */
test('V4 turning the retry chip off does not make a Codex default the person\'s depth', async t => {
  let workerId = null
  const orgBridge = {
    read: async () => ({ ok: true, org: { revision: 2, agents: [{ id: workerId, role: 'worker', enabled: true }] }, roles: [{ id: 'worker', revision: 3 }] }),
    ensureSeat: async () => ({ ok: true, org: { revision: 4 } }),
  }
  const f = fixture(t, { workerTier: 'astra', tiers: LAUNCH_TIERS, retryOptions: { orgBridge } })
  workerId = f.worker.id
  assert.equal(f.treeStore.setNodeLaunchPreferences(f.worker.id, { effort: 'medium' }).ok, true)
  assert.equal(await f.coordinator.setAccountRetryOverride(f.worker.id, false), true, 'fixture premise: the off choice was recorded')
  assert.equal(f.coordinator.retryPolicy(f.worker.id)?.preferredEffort ?? null, null, 'a default was recorded as the person\'s own depth')
  await driveLimitLoop(f, 'prose')
  const tried = modelStarts(f)
  const effortOn = id => tried.find(row => row.tier === id)?.effort ?? null
  for (const id of ['luna', 'terra', 'sol']) assert.equal(effortOn(id), 'medium', `${id} lost a depth its own provider saved`)
  for (const id of ['claude-fable', 'claude-sonnet', 'claude-opus']) {
    assert.ok(tried.some(row => row.tier === id), `the walk never reached ${id}`)
    assert.equal(effortOn(id), null, `${id} was started at Codex's default depth after the chip was turned off`)
  }
})

/* REVIEW P13. The pinned agent's block said what happened and nothing to do.
   It now names the dialog that changes model or account, and a long provider
   message is shortened rather than the next step. */
test('P13 a pinned agent blocked at a limit is told what to do, even after a long provider message', async t => {
  const f = fixture(t, { workerTier: 'claude-opus-5', tiers: PINNED_TIERS })
  const sessionId = f.treeStore.getNode(f.worker.id).sessionId
  const long = { ...LIMIT_SHAPES.prose, text: `You have hit your usage limit. ${'More detail from the provider. '.repeat(12)}` }
  f.emit({ sessionId, event: { type: 'turn_completed', status: 'failed', turnId: 'limit-turn-long', ...long } })
  await drain()
  const note = f.treeStore.getNode(f.worker.id).statusNote || ''
  assert.match(note, /keeps the model you chose/)
  assert.match(note, /Choose another model or account with Switch and continue\.$/, `the block names no next step: ${note}`)
  for (const sentence of note.split(/(?<=[.!?])\s+/)) {
    assert.ok(sentence.split(/\s+/).length <= 25 || !/keeps the model|Switch and continue/.test(sentence),
      `a sentence of the closing is longer than 25 words: ${sentence}`)
  }
})

/* FOLLOW-UP V3. P13 fitted every block to its closing, so every blocked
   note -- not only the pinned one -- cut the provider's message short and
   lost the time it names ("try again at ..."). The provider's message is kept
   whole wherever it fits, as before 1.0.48; the pinned note keeps its short
   closing whole and cuts the MIDDLE of the provider's message, so its start
   and its retry time both survive. A message too long even on its own loses
   its middle too. */
const CODEX_LIMIT = 'You\'ve hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing), visit '
  + 'https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Jun 8th, 2026 3:00 AM.'
const RETRY_AT = 'try again at Jun 8th, 2026 3:00 AM.'

async function blockNoteFor(t, options, text) {
  const f = fixture(t, options)
  const sessionId = f.treeStore.getNode(f.worker.id).sessionId
  f.emit({ sessionId, event: { type: 'turn_completed', status: 'failed', turnId: 'limit-turn-note', ...LIMIT_SHAPES.prose, text } })
  await drain()
  assert.equal(f.coordinator.externalBlock(f.worker.id)?.blocked, true, 'the agent was not blocked')
  return f.treeStore.getNode(f.worker.id).statusNote || ''
}

test('V3 a blocked note keeps the provider\'s message whole where it fits, and its retry time always', async t => {
  const tried = await blockNoteFor(t, {}, CODEX_LIMIT)
  assert.ok(tried.includes(CODEX_LIMIT), `a note after another model was tried cut the provider's message: ${tried}`)
  const alone = await blockNoteFor(t, { tiers: [TIERS[0]] }, CODEX_LIMIT)
  assert.ok(alone.includes(CODEX_LIMIT), `a note with no other model cut the provider's message: ${alone}`)

  const pinned = await blockNoteFor(t, { workerTier: 'claude-opus-5', tiers: PINNED_TIERS }, CODEX_LIMIT)
  assert.ok(pinned.length <= 240, pinned)
  assert.match(pinned, /^Blocked outside this app: You've hit your usage limit\./, `the pinned note lost the message's start: ${pinned}`)
  assert.ok(pinned.includes(RETRY_AT), `the pinned note lost the retry time: ${pinned}`)
  assert.match(pinned, /keeps the model you chose/)
  assert.match(pinned, /Choose another model or account with Switch and continue\.$/)

  const long = `You have hit your usage limit. ${'More detail from the provider. '.repeat(12)}Try again at Jun 8th, 2026 3:00 AM.`
  for (const [name, options] of [['tried', {}], ['pinned', { workerTier: 'claude-opus-5', tiers: PINNED_TIERS }]]) {
    const note = await blockNoteFor(t, options, long)
    assert.ok(note.length <= 240, note)
    assert.match(note, /^Blocked outside this app: You have hit your usage limit\./, `${name}: the long message lost its start: ${note}`)
    assert.ok(note.includes('Try again at Jun 8th, 2026 3:00 AM.'), `${name}: the long message lost its retry time: ${note}`)
  }
})

/* REVIEW P7. A continuation onto another provider left the old provider's
   saved account on a managed slot, so the next Resume was refused as
   TREE_ACCOUNT_CHOICE_UNAVAILABLE. Account names are provider-local. */
test('P7 a model continuation onto another provider clears the saved account of the old one', async t => {
  const tiers = [
    { id: 'claude-fable', provider: 'claude', label: 'Fable (latest)' },
    { id: 'astra', provider: 'codex', label: 'GPT-6-Astra', effort: 'medium' },
  ]
  const f = fixture(t, { tiers, start: args => ({ ok: true, sessionId: args.sessionId || `moved-${args.tier}`, threadId: 'moved-thread', account: 'codex-account' }) })
  assert.equal(f.treeStore.setNodeLaunchPreferences(f.worker.id, { accountChoice: { name: 'old-account', provider: 'claude' } }).ok, true)
  const sessionId = f.treeStore.getNode(f.worker.id).sessionId
  f.emit({ sessionId, event: { type: 'turn_completed', status: 'failed', turnId: 'limit-turn-0', ...LIMIT_SHAPES.prose } })
  await drain()
  const moved = f.treeStore.getNode(f.worker.id)
  assert.equal(moved.tier, 'astra', 'the walk did not move the agent to the other provider')
  assert.equal(moved.accountChoice ?? null, null, 'the Claude account stayed on a Codex agent')
  /* Follow-up V6: and it is said on the continuation line, in the sentence
     the next-model menu uses for the same move. */
  const cleared = typeof MODEL_PANEL.accountCleared === 'function' ? MODEL_PANEL.accountCleared('codex') : ''
  assert.match(cleared, /signed-in Codex account/)
  assert.equal(moved.statusNote, `Continuing from the saved handoff. ${cleared}`, 'the saved account was cleared without a word')

  const same = fixture(t, { tiers: [tiers[0], { id: 'claude-opus', provider: 'claude', label: 'Opus (latest)' }],
    start: args => ({ ok: true, sessionId: args.sessionId || `moved-${args.tier}`, threadId: 'moved-thread', account: 'old-account' }) })
  assert.equal(same.treeStore.setNodeLaunchPreferences(same.worker.id, { accountChoice: { name: 'old-account', provider: 'claude' } }).ok, true)
  same.emit({ sessionId: same.treeStore.getNode(same.worker.id).sessionId,
    event: { type: 'turn_completed', status: 'failed', turnId: 'limit-turn-0', ...LIMIT_SHAPES.prose } })
  await drain()
  assert.equal(same.treeStore.getNode(same.worker.id).tier, 'claude-opus')
  assert.deepEqual(same.treeStore.getNode(same.worker.id).accountChoice, { name: 'old-account', provider: 'claude' },
    'a continuation within one provider keeps its account')
  assert.equal(same.treeStore.getNode(same.worker.id).statusNote, 'Continuing from the saved handoff.',
    'a kept account needs no extra sentence')
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
