import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { parseAst } from 'rollup/parseAst'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'
import { createAccountRecoveryCoordinator } from '../../src/account-recovery-coordinator.js'
import { withResearchTreeBinding } from '../../src/research-tree-session.js'
import { createFleetTreeStore } from '../../src/fleet-trees.js'
import { createTranscriptStore } from '../../src/session-transcript-store.js'
import { createRecoveryHandoffStore } from '../../src/recovery-handoff-store.js'
import * as manual from '../../src/manual-account-continuation.js'
import * as outbox from '../../src/session-outbox.js'

const source = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
const functions = ['recoveryImageContext', 'recoveryCoordinator', 'continueNodeOnAnotherAccount']
  .map(name => declaredFunctionSource(source, name)).join('\n')
let rowSource
function visit(node) {
  if (!node || typeof node !== 'object') return
  if (node.type === 'ObjectExpression' && node.properties.some(property =>
    property.key?.name === 'id' && property.value?.value === 'continue-another-account')) rowSource = source.slice(node.start, node.end)
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(visit)
    else if (value && typeof value === 'object') visit(value)
  }
}
visit(parseAst(source))
assert.ok(rowSource, 'the actual manual-continuation row must exist')
const tick = () => new Promise(resolve => setImmediate(resolve))

function fixture(t, { sourceMode = 'local', hold = null, tiers = [], historyDirectory = null, taskHistoryVerified = true } = {}) {
  const values = new Map()
  const storage = { read: key => values.has(key) ? structuredClone(values.get(key)) : null,
    write: (key, value) => { values.set(key, structuredClone(value)); return true } }
  let serial = 0, mode = sourceMode, allowed = true, release
  const gate = new Promise(resolve => { release = resolve })
  const treeStore = createFleetTreeStore({ computerId: 'fixture', storage, makeId: kind => `${kind}-${++serial}` })
  const node = treeStore.addNode({ role: 'worker', message: 'Keep the original work.', tier: 'luna' }).node
  treeStore.attachSession(node.id, 'old-session')
  treeStore.setNodeStatus(node.id, 'turn-failed')
  const transcriptStore = { ...createTranscriptStore({ computerId: 'fixture', storage }) }
  if (historyDirectory) transcriptStore.readLatest = async id => ({ ...transcriptStore.get(id), recoveryDirectory: historyDirectory })
  transcriptStore.save(node.id, { account: 'original-account', threadId: 'saved-thread', provider: 'codex',
    lines: [{ who: 'agent', text: 'Previously completed work.', at: 1 }] })
  const handoffStore = createRecoveryHandoffStore({ computerId: 'fixture', storage })
  const sessions = new Map([['old-session', node.id]])
  const calls = { seat: [], close: [], start: [], send: [], outbox: [], notices: [] }
  /* THE SEND SEAM IS THE TRACKED ONE. Since b6b3102b3 the coordinator trusts
     only the bridge's tracked disposition: a handoff counts as delivered when
     sendAutomatic answers { ok, result: {...}, deliveryDisposition: 'accepted' }
     (src/account-recovery-coordinator.js, "Only the trusted tracked disposition
     establishes non-delivery"). A bare { ok: true } is an UNCONFIRMED delivery
     and pauses the recovery, which is what made every continuation here read
     false. `refuseStart` lets one case have the shell refuse an account at the
     start, the way the real start does for an account this computer has not
     registered. */
  const accepted = request => ({ ok: true, result: { ok: true, sessionId: request.sessionId, threadId: 'new-thread' }, deliveryDisposition: 'accepted' })
  let refuseStart = null
  const bridge = {
    onEvent: () => () => {},
    async ledger() { return { ok: true, records: [], chain: { checked: true, ok: taskHistoryVerified } } },
    async close(request) { calls.close.push(request); if (hold === 'close') await gate; return { sessionId: request.sessionId, closed: true } },
    async start(request) { calls.start.push(request); if (hold === 'start') await gate;
      const refused = refuseStart?.(request)
      if (refused) return refused
      return { ok: true, sessionId: 'new-session', account: request.treeAccount || 'backup-account' } },
    async send(request) { calls.send.push(request); return accepted(request) },
    async sendAutomatic(request) { calls.send.push(request); return accepted(request) },
  }
  const context = vm.createContext({
    window: { mcAgent: bridge }, LAUNCH_TIERS: tiers, loadAccounts: async () => ({ available: false, accounts: [] }), treeStore, treeStoreId: 'fixture', transcriptStore,
    accountRecoveryCoordinator: null, createAccountRecoveryCoordinator, withResearchTreeBinding,
    RUN_RECOVERY_BRIDGE: null, RUN_RECOVERY_BOUND_BRIDGE: null, RUN_KEEP_TRYING_CONSENT: async () => false,
    RUN_SESSION_NODES: sessions, RUN_NODE_REPLACEMENTS: { busy: () => false },
    outboxMoveSession: (...args) => { calls.outbox.push(args); return outbox.moveSession(...args) },
    outboxTakeNext: outbox.takeNext, outboxConfirmDelivered: outbox.confirmDelivered, outboxRequeueFront: outbox.requeueFront,
    retainTreeSessionCleanup: () => assert.fail('ordinary fixture start must not need cleanup'),
    currentDataSource: () => mode, isWriteEnabled: () => allowed, START_CONTROL_FLAG: 'agent-session',
    startControlOffReason: () => 'Starting agents is switched off.',
    MANUAL_ACCOUNT_CONTINUATION_LOCAL_ONLY: manual.MANUAL_ACCOUNT_CONTINUATION_LOCAL_ONLY,
    nodeReplacementFlight: { busy: () => false }, destroyed: false,
    identityRoleForTreeNode: role => role,
    ensureSeatForNode: async () => { calls.seat.push(node.id); if (hold === 'seat') await gate; return { ok: true } },
    roleBindingForStart: () => ({ ok: true, binding: { agentId: 'fixture-seat' } }),
    startProfileId: value => value, savedSessionEffort: manual.savedSessionEffort, tierEffortOf: () => 'medium',
    current: node, running: false, cleanupPending: false, canStartSession: true, agent: 'Agent',
  })
  vm.runInContext(functions, context)
  const coordinator = context.recoveryCoordinator()
  coordinator.register('fixture', { treeStore, transcriptStore, handoffStore })
  coordinator.subscribe(notice => calls.notices.push(notice))
  t.after(() => { release(); coordinator.destroy(); outbox.clearSession('old-session'); outbox.clearSession('new-session') })
  const out = { textContent: '' }
  return { context, coordinator, node, treeStore, transcriptStore, handoffStore, sessions, calls, out, release,
    setSource: value => { mode = value }, disable: () => { allowed = false },
    refuseStartWhen: decide => { refuseStart = decide },
    /* A replacement bridge is a whole bridge that must not START; the handoff
       that follows an already-dispatched start still needs its send and
       close, as the real bridge always has them. */
    replaceBridge: () => { context.window.mcAgent = { ...bridge, start: () => assert.fail('replacement bridge must not start') } },
    row: () => vm.runInContext(`(${rowSource})`, context),
    run: () => context.continueNodeOnAnotherAccount(treeStore.getNode(node.id), out),
  }
}

test('relay continuation refuses before seat or close and the row explains the local-only policy', async t => {
  const f = fixture(t, { sourceMode: 'relay' })
  const before = f.transcriptStore.get(f.node.id)
  assert.equal(await f.run(), false)
  assert.equal(f.row().enabled, false)
  assert.match(f.row().disabledHint, /app on that computer/)
  assert.match(f.out.textContent, /app on that computer/)
  assert.deepEqual(f.calls.seat, [])
  assert.deepEqual(f.calls.close, [])
  assert.deepEqual(f.calls.start, [])
  assert.deepEqual(f.transcriptStore.get(f.node.id), before)
  assert.equal(f.treeStore.getNode(f.node.id).sessionId, 'old-session')
})

test('local continuation remains enabled and preserves the agent and its saved work', async t => {
  const f = fixture(t)
  assert.equal(f.row().enabled, true)
  assert.equal(await f.run(), true)
  assert.equal(f.calls.seat.length, 1)
  assert.equal(f.calls.close.length, 1)
  assert.equal(f.calls.start.length, 1)
  assert.equal(f.calls.send.length, 1)
  assert.equal(f.calls.start[0].continueFromAccount, 'original-account')
  assert.equal(f.sessions.get('new-session'), f.node.id)
  assert.equal(f.treeStore.getNode(f.node.id).sessionId, 'new-session')
  assert.match(f.calls.send[0].text, /Previously completed work/)
})

// 02c9ecb3 requires complete saved history before an automatic close. The
// browser relay has only its viewport store; a history-capable bridge below
// separately exercises the mount's automatic-start consent contract.
test('the real recovery mount requires complete history before using separate relay start consent', async t => {
  const packet = { sessionId: 'old-session', event: {
    type: 'account_recovery_needed', recoveryId: 'fixture-ticket', handoff: 'Continue the saved work.',
  } }
  const plainRelay = fixture(t, { sourceMode: 'relay' })
  assert.equal(await plainRelay.coordinator.recover(packet), false)
  assert.deepEqual(plainRelay.calls.close, [])
  assert.deepEqual(plainRelay.calls.start, [])
  assert.deepEqual(plainRelay.calls.send, [])
  assert.match(plainRelay.calls.notices.at(-1).error, /complete saved conversation.*unavailable/i)
  assert.equal(plainRelay.treeStore.getNode(plainRelay.node.id).sessionId, 'old-session')

  for (const historyDirectory of ['/fixture/saved-conversation', 'Q:\\fixture\\saved-conversation']) {
    const f = fixture(t, { sourceMode: 'relay', historyDirectory })
    assert.equal(f.row().enabled, false, 'manual continuation remains local-only')
    assert.equal(await f.coordinator.recover(packet), true)
    assert.equal(f.calls.close.length, 1)
    assert.equal(f.calls.start.length, 1)
    assert.equal(f.calls.start[0].accountRecovery.recoveryId, 'fixture-ticket')
    assert.equal(f.calls.start[0].continueFromAccount, undefined)
    assert.equal(f.calls.send.length, 1)
    assert.ok(f.calls.send[0].text.includes(JSON.stringify(historyDirectory)))
    assert.equal(f.treeStore.getNode(f.node.id).sessionId, 'new-session')
  }
  for (const refusal of ['consent', 'task history']) {
    const f = fixture(t, { sourceMode: 'relay', historyDirectory: '/fixture/saved-conversation',
      taskHistoryVerified: refusal !== 'task history' })
    if (refusal === 'consent') f.disable()
    assert.equal(await f.coordinator.recover(packet), false)
    assert.deepEqual(f.calls.close, [], refusal)
    assert.deepEqual(f.calls.start, [], refusal)
    assert.deepEqual(f.calls.send, [], refusal)
    assert.match(f.calls.notices.at(-1).error, refusal === 'consent' ? /Starting agents is disabled/ : /task records could not be read/i)
    assert.equal(f.treeStore.getNode(f.node.id).sessionId, 'old-session')
  }
})

test('a source change during seat provisioning refuses before closing the old session', async t => {
  const f = fixture(t, { hold: 'seat' })
  const pending = f.run()
  await tick()
  f.setSource('relay'); f.release()
  assert.equal(await pending, false)
  assert.deepEqual(f.calls.close, [])
  assert.deepEqual(f.calls.start, [])
  assert.equal(f.treeStore.getNode(f.node.id).sessionId, 'old-session')
})

for (const revoke of ['source', 'bridge', 'consent']) {
  test(`manual continuation rechecks ${revoke} after the old-session close await`, async t => {
    const f = fixture(t, { hold: 'close' })
    const pending = f.run()
    await tick()
    assert.equal(f.calls.close.length, 1)
    if (revoke === 'source') f.setSource('relay')
    else if (revoke === 'bridge') f.replaceBridge()
    else f.disable()
    f.release()
    assert.equal(await pending, false)
    assert.deepEqual(f.calls.start, [])
    assert.deepEqual(f.calls.send, [])
    assert.equal(f.treeStore.getNode(f.node.id).sessionId, 'old-session')
    assert.match(f.handoffStore.get(f.node.id).handoff, /Previously completed work/)
  })
}

/* The admitted session is the circle's whatever changes afterwards: no second
   start, no orphan. What the coordinator no longer does after such a change is
   SEND by itself -- canContinue (local source, same bridge) is rechecked at the
   await between the admitted start and the handoff, so the continuation pauses
   with its reason and keeps the handoff for a later send. */
test('an already-dispatched manual continuation retains ownership after source and bridge change', async t => {
  const f = fixture(t, { hold: 'start' })
  const pending = f.run()
  await tick()
  assert.equal(f.calls.start.length, 1)
  f.setSource('relay'); f.replaceBridge(); f.release()
  assert.equal(await pending, false, 'the handoff is not sent once the source or bridge changed')
  assert.equal(f.calls.start.length, 1, 'no second start')
  assert.equal(f.calls.close.length, 1)
  assert.deepEqual(f.calls.send, [])
  assert.equal(f.sessions.get('new-session'), f.node.id, 'the admitted session is owned by the circle')
  assert.equal(f.treeStore.getNode(f.node.id).sessionId, 'new-session')
  assert.match(f.treeStore.getNode(f.node.id).statusNote, /app on that computer/, 'the circle says why it paused')
  assert.match(f.handoffStore.get(f.node.id).handoff, /Previously completed work/, 'the handoff is kept for a later send')
})

/* Start consent is rechecked at every await the coordinator crosses
   (assertRecoveryCurrent -> assertStartAllowed), including the one between the
   admitted start and the automatic handoff. Consent revoked there keeps the
   session the node already owns and sends nothing more by itself. */
test('consent revoked after dispatch keeps the admitted session but sends no automatic handoff', async t => {
  const f = fixture(t, { hold: 'start' })
  const pending = f.run()
  await tick()
  assert.equal(f.calls.start.length, 1)
  f.disable(); f.release()
  assert.equal(await pending, false)
  assert.equal(f.calls.start.length, 1)
  assert.deepEqual(f.calls.send, [], 'no automatic send once starts are switched off')
  assert.equal(f.sessions.get('new-session'), f.node.id, 'the admitted session stays owned by the circle')
  assert.equal(f.treeStore.getNode(f.node.id).sessionId, 'new-session')
  assert.match(f.treeStore.getNode(f.node.id).statusNote, /Starting agents is disabled/, 'the circle says why it paused')
  assert.match(f.handoffStore.get(f.node.id).handoff, /Previously completed work/, 'the handoff is kept for a later send')
})

test('account retry keeps the exact preference and selects the strongest compatible Gemini client', () => {
  const tiers = [
    { id: 'claude-fable', provider: 'claude' },
    { id: 'agy-gemini-3-8-flash-high', provider: 'gemini', client: 'antigravity' },
    { id: 'gemini-3-1-pro', provider: 'gemini' },
    { id: 'saved-gemini-choice', provider: 'gemini' },
  ]
  const both = [{ provider: 'claude' }, { provider: 'gemini' }, { provider: 'gemini', client: 'antigravity' }]
  assert.deepEqual(manual.accountRetryCandidates('claude-fable', tiers, both), ['claude-fable', 'agy-gemini-3-8-flash-high'])
  assert.deepEqual(manual.accountRetryCandidates('saved-gemini-choice', tiers, both), ['saved-gemini-choice', 'claude-fable'])
  assert.deepEqual(manual.accountRetryCandidates('claude-fable', tiers, [{ provider: 'gemini' }]), ['gemini-3-1-pro'])
  assert.deepEqual(manual.accountRetryCandidates('saved-gemini-choice', tiers, [{ provider: 'gemini', client: 'antigravity' }]), ['agy-gemini-3-8-flash-high'])
  assert.deepEqual(manual.accountRetryCandidates('claude-fable', tiers, [{ provider: 'gemini', client: 'unknown' }]), [])
})

/* ---- SWITCH AND CONTINUE (owner T381): one choice, landed on the mechanism it names ----
 *
 * The view's continueNodeWithChoice is sliced from computers.js and run with
 * the same collaborators the fixture above already replaces, plus the two it
 * adds: the account switch and the model continuation. The route rule
 * (src/switch-and-continue.js continuationRouteFor) is asserted by value
 * first, because the whole dialog rests on it: the saved thread can only be
 * RESUMED on its own account and provider (shell/agent-host.cjs refuses a
 * start naming both a thread and continueFromAccount), so anything else is a
 * handoff, and the person is told which before pressing. */
const switching = await import('../../src/switch-and-continue.js')
const { LAUNCH_TIERS: REAL_TIERS } = await import('../../src/orchestration-controls.js')
const { SWITCH_PANEL, EFFORT_CHOICES } = await import('../../src/fleet-tree-copy.js')

test('the route: same account and provider is a resume; another account or provider is a handoff', () => {
  const route = choice => switching.continuationRouteFor({ savedAccount: 'a', savedProvider: 'claude', currentTier: 'claude-sonnet', tiers: REAL_TIERS, choice })
  assert.equal(route({ account: 'a', tier: 'claude-opus', effort: 'max' }).route, 'resume')
  assert.equal(route({ account: 'a', tier: 'claude-opus' }).changesModel, true)
  assert.equal(route({ tier: 'claude-sonnet', effort: 'low' }).route, 'resume', 'an absent account keeps the current one')
  assert.equal(route({ account: 'b', tier: 'claude-sonnet' }).route, 'handoff')
  assert.equal(route({ account: 'a', tier: 'astra' }).route, 'handoff')
  assert.equal(route({ account: 'a', tier: 'astra' }).provider, 'codex')
  assert.equal(route({ account: 'a', tier: 'astra' }).changesProvider, true)
})

/* EVERY DEPTH THE DIALOG OFFERS MUST BE ONE THE SHELL WILL ACCEPT. The person
   picks a depth here and it travels to the start as `effort`; shell/main.cjs
   validates it against AGENT_EFFORT_VALUES and answers MC_AGENT_EFFORT_UNKNOWN
   for anything else. A row the dialog draws that the shell then rejects is a
   control that cannot work, so the authority list is READ here rather than
   restated -- this asserts the subset by value, and says so if it cannot look. */
test('every depth the switch dialog offers is one the shell accepts', async () => {
  const shell = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
  const declaration = /const AGENT_EFFORT_VALUES = Object\.freeze\((\[[^\]]*\])\)/.exec(shell)
  assert.ok(declaration, 'REFUSED: AGENT_EFFORT_VALUES could not be read out of shell/main.cjs, so this gate measured nothing')
  const accepted = JSON.parse(declaration[1].replace(/'/g, '"'))
  assert.ok(accepted.length > 0)
  const offered = switching.switchChoices({ accounts: [], tiers: REAL_TIERS, efforts: EFFORT_CHOICES }).efforts.map(row => row.id)
  assert.ok(offered.length > 0, 'the dialog offers at least one depth')
  for (const effort of offered) assert.ok(accepted.includes(effort), `the dialog offers "${effort}", which the shell refuses as MC_AGENT_EFFORT_UNKNOWN`)
})

test('the dialog offers signed-in accounts, startable models and the product effort words, and hands the pick back', async () => {
  const { installDomStandIn } = await import('./lib/dom-stand-in.mjs')
  const dom = installDomStandIn(globalThis)
  try {
    const choices = switching.switchChoices({ accounts: [{ name: 'a', provider: 'claude', signedIn: true }, { name: 'b', provider: 'claude', signedIn: true },
      { name: 'c', provider: 'codex', signedIn: true }, { name: 'out', provider: 'claude', signedIn: false }],
      tiers: REAL_TIERS, efforts: EFFORT_CHOICES, refusedAccount: 'a', currentTier: 'claude-sonnet', currentEffort: 'medium' })
    assert.deepEqual(choices.accounts.map(row => row.name), ['a', 'b', 'c'], 'signed-out accounts are not offered')
    assert.equal(choices.accounts[0].refused, true)
    assert.ok(choices.models.some(row => row.id === 'astra') && choices.models.some(row => row.id === 'claude-opus'))
    /* R1238: local, grok and gemini are no longer DROPPED from this list. They
       are drawn with the reason they cannot be taken here, because asserting a
       row's ABSENCE is exactly what let the product hide three providers the
       owner went looking for. The rule now matches sessionModelChoices(). */
    const localRow = choices.models.find(row => row.id === 'local')
    assert.ok(localRow, 'the local node is shown rather than dropped')
    assert.equal(localRow.available, false, 'and it is not pickable here')
    assert.ok(localRow.reason, 'and it says why')
    assert.deepEqual(choices.efforts.map(row => row.id), EFFORT_CHOICES.map(row => row.id))
    const host = dom.document.createElement('div')
    let chosen = null, cancelled = 0
    const dialog = switching.mountSwitchAndContinueDialog({ document: dom.document, host, choices, tiers: REAL_TIERS,
      current: { account: 'a', provider: 'claude', tier: 'claude-sonnet', effort: 'medium' }, onChoose: value => { chosen = value }, onCancel: () => { cancelled += 1 } })
    assert.ok(dialog, 'the dialog mounts')
    const pick = (selector, value) => { const input = host.querySelectorAll(selector).find(row => row.value === value); assert.ok(input, `${selector}=${value}`); input.checked = true; input.dispatch('change') }
    const cost = () => host.querySelector('[data-switch-cost]').textContent
    assert.equal(cost(), SWITCH_PANEL.costResume, 'keeping the account is drawn as a resume')
    pick('[data-switch-model]', 'claude-opus'); pick('[data-switch-effort]', 'high')
    assert.equal(cost(), SWITCH_PANEL.costResume, 'another model on the same account is still a resume')
    pick('[data-switch-account]', 'b')
    assert.equal(cost(), SWITCH_PANEL.costHandoff, 'another account is drawn as the handoff it is')
    host.querySelector('[data-switch-continue]').dispatch('click')
    assert.deepEqual(chosen, { account: 'b', provider: 'claude', tier: 'claude-opus', effort: 'high', route: 'handoff' })
    assert.equal(cancelled, 0)
    assert.equal(host.querySelector('dialog'), null, 'the dialog closes itself after the pick')
  } finally { dom.restore() }
})

function choiceFixture(t) {
  /* The model list has to be in place BEFORE the coordinator is built:
     recoveryCoordinator() passes LAUNCH_TIERS into createAccountRecoveryCoordinator
     once and caches the coordinator, so a later assignment to context.LAUNCH_TIERS
     reaches the view's own reads and never the coordinator's -- which is what
     made continueOnAnotherModel refuse every tier here. */
  const f = fixture(t, { tiers: REAL_TIERS })
  const extra = { switch: [], resumes: [], models: [] }
  Object.assign(f.context, {
    SWITCH_PANEL, continuationRouteFor: switching.continuationRouteFor,
    /* Copied into this realm before it is recorded: the request is built inside
       the vm context, and assert/strict compares prototypes, so pushing the
       object itself fails a value comparison for a reason that is about vm and
       not about the product. The copy keeps every own property, so an unexpected
       extra field still fails. */
    /* The computer's global account switch is NOT part of this flow any more:
       the chosen account rides the one replacement as `treeAccount` ("The
       account page's global switch would redirect unrelated starts during this
       await", continueNodeWithChoice). The stub stays so a call to it is a
       failure the cases below can see. */
    switchAccount: async request => { extra.switch.push({ ...request }); return { ok: true, switched: true } },
    /* Resume takes the requested tier as an option (`requestedTier`); the
       circle's own tier changes only once admission publishes the accepted
       successor. The stub records what it was asked and mirrors that one
       publication (resumeNodeSessionUnguarded -> setNodeLaunchPreferences). */
    resumeNodeSession: async (node, options) => {
      const tier = options.requestedTier || node.tier
      extra.resumes.push({ tier, effort: options.effort || null })
      if (options.requestedTier) f.treeStore.setNodeLaunchPreferences(node.id, { tier, ...(options.effort ? { effort: options.effort } : {}) })
      return true
    },
    continueNodeOnAnotherModel: async (node, tierId, out, options) => {
      extra.models.push({ tier: tierId, effort: options?.effort || null })
      return f.coordinator.continueOnAnotherModel({ computerId: 'fixture', nodeId: node.id, startOptions: { tier: tierId,
        ...(options?.effort ? { effort: options.effort } : {}), ...(options?.treeAccount ? { treeAccount: options.treeAccount } : {}) } })
    },
    notifyNodeStatusListeners() {},
  })
  vm.runInContext(declaredFunctionSource(source, 'continueNodeWithChoice'), f.context)
  return { ...f, extra, choose: choice => f.context.continueNodeWithChoice(f.treeStore.getNode(f.node.id), choice, f.out) }
}

test('choosing another account switches this computer to it and continues with the handoff on the chosen model and depth', async t => {
  const f = choiceFixture(t)
  // The saved conversation is on codex (luna); the pick stays on codex, another account, another model.
  assert.equal(await f.choose({ account: 'backup-account', provider: 'codex', tier: 'sol', effort: 'xhigh' }), true)
  assert.deepEqual(f.extra.switch, [], 'the computer\'s own account is never switched for one circle')
  assert.deepEqual(f.extra.models, [{ tier: 'sol', effort: 'xhigh' }])
  assert.equal(f.calls.start.length, 1)
  assert.equal(f.calls.start[0].treeAccount, 'backup-account', 'the chosen account rides the start itself')
  assert.equal(f.calls.start[0].tier, 'sol')
  assert.equal(f.calls.start[0].effort, 'xhigh')
  assert.equal(f.calls.send.length, 1, 'the handoff follows the start')
  assert.equal(f.treeStore.getNode(f.node.id).tier, 'sol', 'the circle records the model that is running')
  assert.deepEqual(f.extra.resumes, [], 'another account is never a native resume')
})

test('choosing another account on the same model continues on that account with the chosen depth honoured', async t => {
  const f = choiceFixture(t)
  assert.equal(await f.choose({ account: 'backup-account', provider: 'codex', tier: 'luna', effort: 'high' }), true)
  assert.deepEqual(f.extra.switch, [], 'the computer\'s own account is never switched for one circle')
  assert.equal(f.calls.start.length, 1)
  assert.equal(f.calls.start[0].treeAccount, 'backup-account', 'the chosen account rides the start itself')
  assert.equal(f.calls.start[0].continueFromAccount, 'original-account', 'the refused account is the one moved away from')
  assert.equal(f.calls.start[0].effort, 'high', 'the chosen depth reaches the start payload')
  assert.deepEqual(f.extra.models, [])
})

test('keeping the account and changing model or depth is a native resume of the same thread: nothing switched, nothing handed off', async t => {
  const f = choiceFixture(t)
  assert.equal(await f.choose({ account: 'original-account', provider: 'codex', tier: 'sol', effort: 'low' }), true)
  assert.deepEqual(f.extra.switch, [])
  assert.deepEqual(f.calls.start, [], 'no fresh session')
  assert.deepEqual(f.calls.send, [], 'no handoff')
  assert.deepEqual(f.extra.resumes, [{ tier: 'sol', effort: 'low' }], 'the resume carries the chosen model and depth')
  assert.equal(f.treeStore.getNode(f.node.id).tier, 'sol')
})

/* An account this computer has not registered is refused where the account is
   now asserted: at the start the chosen account rides on. Nothing is admitted,
   nothing is handed off, the circle keeps its old session and says why on its
   own status; the dialog's line is the product's generic failure sentence. */
test('a refused account stops at the start with nothing admitted, and says why', async t => {
  const f = choiceFixture(t)
  f.refuseStartWhen(request => request.treeAccount === 'ghost'
    ? { ok: false, code: 'AGENT_ACCOUNT_UNKNOWN', reason: 'That account is not registered on this computer.' } : null)
  assert.equal(await f.choose({ account: 'ghost', provider: 'codex', tier: 'luna', effort: 'medium' }), false)
  assert.deepEqual(f.extra.switch, [], 'no global switch is attempted for it either')
  assert.equal(f.calls.start.length, 1, 'the one start carries the account and is refused there')
  assert.equal(f.calls.start[0].treeAccount, 'ghost')
  assert.deepEqual(f.calls.send, [], 'nothing is handed off')
  assert.equal(f.sessions.get('new-session'), undefined, 'nothing is admitted')
  assert.equal(f.treeStore.getNode(f.node.id).sessionId, 'old-session')
  assert.match(f.treeStore.getNode(f.node.id).statusNote, /not registered/, 'the circle says why')
  assert.equal(f.out.textContent, SWITCH_PANEL.failed)
})

test('the switch is refused off the local computer and while starts are switched off, before any switch or start', async t => {
  const f = choiceFixture(t)
  f.setSource('relay')
  assert.equal(await f.choose({ account: 'backup-account', provider: 'codex', tier: 'luna', effort: 'medium' }), false)
  assert.match(f.out.textContent, /app on that computer/)
  f.setSource('local'); f.disable()
  assert.equal(await f.choose({ account: 'backup-account', provider: 'codex', tier: 'luna', effort: 'medium' }), false)
  assert.match(f.out.textContent, /switched off/)
  assert.deepEqual(f.extra.switch, [])
  assert.deepEqual(f.calls.start, [])
})
