/* THE ROW TABLE BEHIND THE ACTIONS POPUP, walked as data.
 *
 * chatActionRowsFor lives inside the computers view's closure, so it cannot be
 * imported. This suite executes its complete declaration and the actual
 * common-row helper under chosen states, including the real controlState
 * normalization. The store and host capabilities are explicit fixtures; the
 * row definitions, copy and consumer callbacks are the maintained source. So "a stopped agent's Stop row says why" is checked against the
 * sentence the row would really carry, and a row that lost its group or its
 * reason fails here whatever it looks like.
 *
 * WHAT IT DEFENDS, in the owner's terms ("more like vscode, much more
 * intuitive"): every action this build performs has a row; the rows are
 * grouped, with the group that ends or forgets something last; every row that
 * can be switched off says why in the state that switches it off; and the
 * cancelled-mention sentence is its own.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'
import { controlState } from '../../src/components.js'
import { LOOP_BOUNDS } from '../../src/agent-loops.js'
import { MANUAL_ACCOUNT_CONTINUATION_LOCAL_ONLY } from '../../src/manual-account-continuation.js'
import { planNodeRemoval } from '../../src/tree-node-removal.js'
import { createSingleFlight } from '../../src/single-flight.js'
import { cloudCommandAction } from '../../src/cloud-command-actions.js'
import { launchTier } from '../../src/orchestration-controls.js'

/* SWITCH_PANEL joined this list on 2026-09-19, and the gap it closes is worth
   naming. T381 added the `switch-continue` row to chatActionRowsFor() on
   2026-09-18 and did not add its copy object here. This suite LIFTS that
   function out of the view and runs it against a hand-built scope, so a free
   identifier the scope does not name is a ReferenceError -- and because the row
   is spread conditionally, `...(savedConversation ? [{ ... SWITCH_PANEL.action
   ... }] : [])`, the object literal is only evaluated when a test supplies a
   saved conversation. So the three tests that do exactly that had been failing
   with "SWITCH_PANEL is not defined" while the twelve that do not went on
   passing, which is why the suite looked mostly fine. */
import { EFFORT_SWITCH, MODEL_PANEL, PALETTE_PANEL, REMOVE_PANEL, RESUME_PANEL, REWIND_PANEL, SWITCH_PANEL } from '../../src/fleet-tree-copy.js'

const VIEW = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')

const ROW_BUILDERS = ['nodeRemovalBlock', 'commonChatActionsFor', 'chatActionRowsFor', 'pendingModelChoice', 'cancelPendingModelChoice']
  .map(name => declaredFunctionSource(VIEW, name)).join('\n')

/* Build the rows for one state. Defaults are an idle, never-started node on
   the installed app; each test names only what it changes. */
function rowsFor({
  running = false,
  started = false,
  cleanupPending = false,
  canPick = true,
  turnsSoFar = 0,
  sentEarlier = false,
  reply = '',
  message = '',
  saved = false,
  savedAccount = null,
  childCount = 0,
  busyChild = false,
  runPaletteAction = () => {},
  recovery = null,
  startEnabled = true,
  sourceMode = 'local',
  nodeId = 'node-a',
  tier = 'astra',
  loopIntervals = new Map(),
  loopSurface = null,
  childSlot = undefined,
} = {}) {
  const node = { id: nodeId, tier, sessionId: started ? 'chat-a' : null, status: running ? 'running' : 'idle', message }
  const children = Array.from({ length: childCount }, (_, index) => ({ id: `child-${index}`, parentId: node.id, status: 'idle' }))
  const stub = () => {}
  const savedConversation = saved || sentEarlier ? { lines: sentEarlier ? [{ who: 'you', text: 'Earlier saved message' }] : [], account: savedAccount } : null
  const scope = {
    PALETTE_PANEL, EFFORT_SWITCH, RESUME_PANEL, REWIND_PANEL, SWITCH_PANEL, MODEL_PANEL, REMOVE_PANEL,
    MANUAL_ACCOUNT_CONTINUATION_LOCAL_ONLY, LOOP_BOUNDS, controlState, cloudCommandAction, launchTier,
    planNodeRemoval, startDraftFlight: createSingleFlight(), nodeBranchRemovalFlight: createSingleFlight(),
    treeNodeName: value => value.id,
    treeStore: { getNode: id => id === node.id ? node : children.find(child => child.id === id), childrenOf: id => id === node.id ? children : [],
      ...(childSlot === undefined ? {} : { childSlot: id => (id === node.id ? childSlot : null) }) },
    window: { mcAgent: { start: stub, close: stub, interrupt: stub, rewind: stub, setEffort: stub,
      ...(canPick ? { pickAttachment: stub, pickMention: stub } : {}) } },
    nodeBusy: value => value.id === node.id ? running : busyChild, nodeSessionLive: () => started && !cleanupPending,
    nodeCleanupPending: () => cleanupPending, nodeSessionEnded: () => !started,
    startCleanupSentence: () => 'Cleanup has not finished. Try Stop again.',
    START_NEEDS_APP_TEXT: () => 'Starting an agent needs the installed application.',
    isWriteEnabled: () => startEnabled, START_CONTROL_FLAG: 'agent-session',
    startControlOffReason: () => 'Starting agents is switched off.',
    nodeReplies: new Map(reply ? [[node.id, reply]] : []),
    sessionTurnLog: new Map([[node.sessionId, Array.from({ length: turnsSoFar }, (_, index) => ({ turnId: `turn-${index}`, yourText: `Message ${index}` }))]]),
    transcriptStore: { has: () => Boolean(savedConversation), get: () => savedConversation },
    loopIntervals, mockSource: () => sourceMode === 'mock',
    setOrgStatus: (...args) => { assert.ok(loopSurface, 'A loop action must supply its explicit surface'); return loopSurface.setOrgStatus(...args) },
    statusSink: stub, runPaletteAction, openComposeFor: stub, focusDetailsControl: stub, resumeNodeSession: stub,
    recoveryCoordinator: () => recovery ? { isRecovering: () => false, retryPolicy: () => null, ...recovery } : null, nodeReplacementFlight: { busy: () => false }, continueNodeOnAnotherAccount: stub,
    currentDataSource: () => sourceMode,
    pendingModelChoices: new Map(), notifyNodeStatusListeners: () => {}, RUN_SESSION_CLEANUPS: new Map(),
  }
  scope.openLoopFor = node => {
    assert.ok(loopSurface, 'A loop action test must supply its explicit surface')
    const loopScope = { showWorkspaceControls: stub, mockSource: scope.mockSource, PALETTE_PANEL, treeStore: scope.treeStore, ...loopSurface }
    const open = new Function(...Object.keys(loopScope), `${declaredFunctionSource(VIEW, 'openLoopFor')}; return openLoopFor`)(...Object.values(loopScope))
    return open(node)
  }
  const build = new Function(...Object.keys(scope), `${ROW_BUILDERS}; return chatActionRowsFor`)(...Object.values(scope))
  return build(node)
}

const byId = rows => Object.fromEntries(rows.map(row => [row.id, row]))

test('manual continuation and retry stay together after the conversation rows', () => {
  const rows = rowsFor({ saved: true, savedAccount: 'saved-account', recovery: { canRetry: () => true, isRecovering: () => false } })
  const ids = rows.map(row => row.id)
  assert.equal(ids.indexOf('retry-account-recovery'), ids.indexOf('copy-reply') + 1)
  assert.equal(ids.indexOf('continue-another-account'), ids.indexOf('retry-account-recovery') + 1)
  /* T381's `switch-continue` row joined this contiguous run on 2026-09-18,
     between the account continuation and the first plain Agent row. The line
     below pinned `child` directly after `continue-another-account`, which was
     the whole run until then. It is EXTENDED rather than relaxed: what this
     test protects is that the continuation rows stay together and in order, not
     that there happen to be two of them, so the new row is named explicitly and
     a future one will fail here again rather than slip in unnoticed. */
  assert.equal(ids.indexOf('switch-continue'), ids.indexOf('continue-another-account') + 1)
  assert.equal(ids.indexOf('child'), ids.indexOf('switch-continue') + 1)
  assert.equal(byId(rows)['continue-another-account'].group, PALETTE_PANEL.groupAgent)
})

test('a retryable account recovery adds one contiguous Agent row for its exact node', () => {
  assert.equal(byId(rowsFor())['retry-account-recovery'], undefined)
  assert.equal(byId(rowsFor({ recovery: { canRetry: () => false } }))['retry-account-recovery'], undefined)
  const checked = []
  const rows = rowsFor({ recovery: { canRetry: id => { checked.push(id); return true } } })
  assert.deepEqual(checked, ['node-a'])
  assert.equal(rows.filter(row => row.id === 'retry-account-recovery').length, 1)
  assert.equal(byId(rows)['retry-account-recovery'].group, PALETTE_PANEL.groupAgent)
  const groupRuns = rows.filter((row, index) => index === 0 || rows[index - 1].group !== row.group).map(row => row.group)
  assert.deepEqual(groupRuns, [PALETTE_PANEL.groupCommon, PALETTE_PANEL.groupConversation, PALETTE_PANEL.groupAgent, PALETTE_PANEL.groupDanger])
})

test('account recovery retry explains a running session or a disabled start control', () => {
  const recovery = { canRetry: () => true }
  for (const running of [false, true]) {
    for (const startEnabled of [false, true]) {
      const row = byId(rowsFor({ recovery, running, startEnabled }))['retry-account-recovery']
      assert.equal(row.enabled, !running && startEnabled)
      if (!row.enabled) assert.equal(row.disabledHint, running ? RESUME_PANEL.busy : 'Starting agents is switched off.')
    }
  }
})

test('the enabled account recovery row closes the menu and retries its exact node once', async () => {
  const calls = []
  const recovery = { canRetry: () => true, retry: async id => { calls.push(['retry', id]) } }
  const row = byId(rowsFor({ recovery }))['retry-account-recovery']
  assert.equal(row.enabled, true)
  await row.run({ close: () => calls.push(['close']) })
  assert.deepEqual(calls, [['close'], ['retry', 'node-a']])
})

test('a failed start with retained cleanup offers Stop without offering another start or removal', () => {
  const retained = byId(rowsFor({ cleanupPending: true, saved: true }))
  assert.equal(retained.stop.enabled, true)
  assert.equal(retained.interrupt.enabled, false)
  assert.equal(retained.resume.enabled, false)
  assert.equal(retained.clear.enabled, false)
  assert.equal(retained.remove.enabled, false)
  assert.equal(byId(rowsFor()).stop.enabled, false, 'an ordinary failed or absent start has no Stop target')
})

test('every action this build performs has a row, including the three doors that were missing', () => {
  const ids = rowsFor().map(row => row.id)
  for (const id of ['goal', 'loop', 'attach', 'mention', 'queue']) {
    assert.ok(ids.includes(id), `${id} has no row in the menu -- the door is missing again`)
  }
  for (const id of ['effort', 'model', 'rewind', 'copy-brief', 'copy-reply', 'child', 'move', 'resume', 'interrupt', 'stop', 'clear']) {
    assert.ok(ids.includes(id), `${id} left the menu`)
  }
  assert.equal(new Set(ids).size, ids.length, 'a row id appears twice')
})

test('every row belongs to a group, and the group that ends or forgets something is last', () => {
  const rows = rowsFor()
  for (const row of rows) {
    assert.equal(typeof row.group, 'string', `${row.id} has no group; the list is flat again`)
    assert.ok(row.group.length > 0, `${row.id} has an empty group`)
  }
  const groups = [...new Set(rows.map(row => row.group))]
  assert.deepEqual(groups, [PALETTE_PANEL.groupCommon, PALETTE_PANEL.groupConversation, PALETTE_PANEL.groupAgent, PALETTE_PANEL.groupDanger],
    'The four actual groups must remain contiguous and in their intended order')
  assert.equal(groups[groups.length - 1], PALETTE_PANEL.groupDanger, 'the destructive group is not last')
  const danger = rows.filter(row => row.group === PALETTE_PANEL.groupDanger).map(row => row.id).sort()
  assert.deepEqual(danger, ['clear', 'interrupt', 'remove', 'stop'], 'the destructive group does not hold exactly the four rows that stop, forget or remove')
  /* Remove ends something for good, so it closes the destructive group: the
     last row of the whole table, never a neighbour of Copy. */
  assert.equal(rows[rows.length - 1].id, 'remove', 'the remove row is not the last row of the table')
  /* Consecutive: a group is a heading, so its rows sit together. */
  const seen = new Set()
  let last = null
  for (const row of rows) {
    if (row.group !== last) {
      assert.ok(!seen.has(row.group), `${row.group} appears in two separate runs; its heading would print twice`)
      seen.add(row.group)
      last = row.group
    }
  }
})

test('Common actions use this node state and its own loop interval', () => {
  const intervals = new Map([['node-a', 3], ['node-b', 17]])
  const first = rowsFor({ started: true, nodeId: 'node-a', loopIntervals: intervals })
  assert.deepEqual(first.slice(0, 3).map(row => [row.id, row.group]), [
    ['cloud', PALETTE_PANEL.groupCommon], ['goal', PALETTE_PANEL.groupCommon], ['loop', PALETTE_PANEL.groupCommon],
  ])
  const a = byId(first), b = byId(rowsFor({ nodeId: 'node-b', loopIntervals: intervals }))
  assert.equal(a.cloud.enabled, true)
  assert.equal(b.cloud.enabled, false)
  assert.equal(a.goal.enabled, true)
  assert.equal(b.goal.enabled, false, 'Another node having a session must not enable this goal')
  assert.equal(b.goal.disabledHint, PALETTE_PANEL.whyNotStarted)
  assert.equal(a.loop.minutes, 3)
  assert.equal(b.loop.minutes, 17)
  assert.equal(byId(rowsFor()).loop.minutes, LOOP_BOUNDS.defaultIntervalMs / 60_000)
  const cleanup = byId(rowsFor({ started: true, cleanupPending: true }))
  assert.equal(cleanup.cloud.enabled, false)
  assert.equal(cleanup.goal.enabled, false)
  assert.equal(cleanup.goal.disabledHint, PALETTE_PANEL.whyNotStarted)
  const example = byId(rowsFor({ sourceMode: 'mock' }))
  assert.equal(example.loop.enabled, false)
  assert.equal(example.loop.disabledHint, PALETTE_PANEL.loopExample)
  // T1351: /loop on an agent that has never started is greyed out with the
  // same reason as /goal, instead of opening a setup whose Start loop is dead.
  assert.equal(a.loop.enabled, true, 'a started agent opens loop setup as before')
  assert.equal(b.loop.enabled, false)
  assert.equal(b.loop.disabledHint, PALETTE_PANEL.whyNotStarted)
  assert.equal(cleanup.loop.enabled, false)
  assert.equal(byId(rowsFor({ sourceMode: 'mock', started: true })).loop.disabledHint, PALETTE_PANEL.loopExample, 'the example keeps its own reason')
  const composed = []
  a.goal.run({ compose: (...args) => composed.push(args) })
  assert.deepEqual(composed, [['/goal ', PALETTE_PANEL.goalHint]])
})

/* THE CLOUD SWARM ACTION IS A CODEX CLOUD AFFORDANCE, so it belongs only on an
   agent that can actually run one. /cloud launches a Codex Cloud swarm; a Claude
   or local agent (the owner's Controller and Managers) has nothing to run, so the
   action is hidden there rather than offered as a dead row -- while the codex
   Builders that can run it still get it. Goal and loop stay on every agent. */
test('the cloud swarm action is offered only to codex agents that can run a codex cloud swarm', () => {
  // A started codex agent (a cloud Builder) offers the cloud swarm, enabled and
  // sitting at the head of the common group like it always has.
  const codex = byId(rowsFor({ started: true, tier: 'astra' }))
  assert.equal(codex.cloud?.group, PALETTE_PANEL.groupCommon, 'a codex agent lost its cloud swarm action')
  assert.equal(codex.cloud.enabled, true, 'a started codex agent cannot reach its own cloud swarm')

  // A started Claude agent cannot run a codex cloud swarm, so the row is absent
  // entirely -- not merely shown disabled.
  const claude = byId(rowsFor({ started: true, tier: 'claude-opus' }))
  assert.equal(claude.cloud, undefined, 'the cloud swarm action is offered on a Claude agent that cannot run it')

  // A started local agent likewise never offers it.
  const local = byId(rowsFor({ started: true, tier: 'local' }))
  assert.equal(local.cloud, undefined, 'the cloud swarm action is offered on a local agent that cannot run it')

  // Goal and loop are common to every agent regardless of provider, and hiding
  // cloud must not disturb them.
  for (const [label, rows] of [['claude', claude], ['local', local]]) {
    assert.ok(rows.goal, `the goal action must remain on a ${label} agent`)
    assert.ok(rows.loop, `the loop action must remain on a ${label} agent`)
  }
})

test('the Common loop row opens the actual loop surface and preserves its refusals', () => {
  for (const [sourceMode, available] of [['local', true], ['local', false], ['mock', true]]) {
    const calls = []
    const interval = { focus: () => calls.push('focus interval') }
    const box = {
      querySelector: selector => { assert.equal(selector, '[data-loop="every"]'); return available ? interval : null },
      scrollIntoView: () => calls.push('reveal loop'),
    }
    const controlsPage = {
      querySelector: selector => {
        if (selector === '.board-loop-box') return box
        if (selector === '[data-rail-tab="details"]') return { click: () => calls.push('open details') }
        if (selector === '[data-start-work-toggle]') return { getAttribute: name => { assert.equal(name, 'aria-expanded'); return 'false' }, click: () => calls.push('expand controls') }
        assert.fail(`Unexpected loop surface query: ${selector}`)
      },
    }
    const loopSurface = { controlsPage, currentRailTreeNode: { id: 'node-a' },
      activateRail: page => { assert.equal(page, controlsPage); calls.push('activate rail') },
      showTreeNodeControls: () => assert.fail('The exact node already owns the supplied loop surface'),
      setOrgStatus: (sentence, tone) => calls.push([sentence, tone]),
    }
    const row = byId(rowsFor({ started: true, sourceMode, loopSurface })).loop
    assert.equal(row.enabled, sourceMode === 'local')
    row.run({ close: () => calls.push('close menu') })
    assert.deepEqual(calls, sourceMode === 'mock'
      ? ['close menu', [PALETTE_PANEL.loopExample, 'refuse']]
      : ['close menu', 'activate rail', 'open details', 'expand controls',
          ...(available ? ['reveal loop', 'focus interval', [PALETTE_PANEL.loopOpened, 'ok']] : [[PALETTE_PANEL.loopUnavailable, 'refuse']])])
  }
})

test('a row that is switched off says why, in every state that switches it off', () => {
  /* Never started, on the installed app. */
  const idle = byId(rowsFor())
  for (const id of ['attach', 'mention', 'effort', 'rewind', 'clear']) {
    assert.equal(idle[id].enabled, false, `${id} is pressable before the agent has started`)
    assert.equal(idle[id].disabledHint, PALETTE_PANEL.whyNotStarted, `${id} is switched off and does not say the agent has not started`)
  }
  assert.equal(idle.model.enabled, true, 'model choices remain visible before a start')
  assert.equal(idle.model.disabledHint, '')
  for (const id of ['interrupt', 'stop']) {
    assert.equal(idle[id].enabled, false)
    assert.equal(idle[id].disabledHint, PALETTE_PANEL.whyNotRunning, `${id} is switched off and does not say the agent is not running`)
  }
  assert.equal(idle['copy-brief'].disabledHint, PALETTE_PANEL.whyNoBrief)
  assert.equal(idle['copy-reply'].disabledHint, PALETTE_PANEL.whyNoReply)
  assert.equal(idle.resume.disabledHint, PALETTE_PANEL.whyNoSaved)

  /* Started, idle, no turns yet: rewind's reason changes to the one that is
     now true. */
  const quiet = byId(rowsFor({ started: true, turnsSoFar: 0 }))
  assert.equal(quiet.rewind.enabled, false)
  assert.equal(quiet.rewind.disabledHint, PALETTE_PANEL.whyNoTurns, 'a started agent with no turns is told it has not started')

  /* After a restart: the window's turn log is empty but the durable transcript
     holds sent messages. Measured 2026-08-18: this state said "You have not
     sent it a message yet." beside a panel showing four of them. The row must
     tell the truth about the saved messages — and the fresh-node sentence
     above must stay exactly as it is, because for a genuinely fresh node it is
     true. */
  const restarted = byId(rowsFor({ started: true, turnsSoFar: 0, sentEarlier: true }))
  assert.equal(restarted.rewind.enabled, false)
  assert.equal(restarted.rewind.disabledHint, PALETTE_PANEL.whyOnlySavedTurns,
    'a restarted window with saved messages still claims nothing was ever sent')

  /* Running: resume is refused for being busy, and says so in RESUME_PANEL's
     own words rather than a new sentence. */
  const busy = byId(rowsFor({ started: true, running: true, saved: true }))
  assert.equal(busy.resume.enabled, false)
  assert.equal(busy.resume.disabledHint, RESUME_PANEL.busy)
  assert.equal(busy.interrupt.enabled, true)
  assert.equal(busy.stop.enabled, true)

  /* The branch preview refuses live work at any depth. An idle branch now
     has a single explicit confirmation; the store still removes leaves only. */
  assert.equal(busy.remove.enabled, false, 'a running agent can be removed out from under its session')
  assert.equal(busy.remove.disabledHint, 'Stop node-a first.')
  const parent = byId(rowsFor({ childCount: 2 }))
  assert.equal(parent.remove.enabled, true)
  assert.equal(parent.remove.hint, 'Removes this agent and 2 agents below it after one confirmation.')
  const activeBranch = byId(rowsFor({ childCount: 2, busyChild: true }))
  assert.equal(activeBranch.remove.enabled, false, 'a running descendant blocks the entire branch')
  assert.equal(activeBranch.remove.disabledHint, 'Stop child-0 first.')
  assert.equal(idle.remove.enabled, true, 'an idle leaf cannot be removed at all -- the missing leg again')
  assert.equal(idle.remove.hint, REMOVE_PANEL.hint)

  /* A page with no picker: attach and mention say the real reason. */
  const preview = byId(rowsFor({ started: true, canPick: false }))
  assert.equal(preview.attach.enabled, false)
  assert.equal(preview.attach.disabledHint, PALETTE_PANEL.whyNoPicker)
  assert.equal(preview.mention.disabledHint, PALETTE_PANEL.whyNoPicker)

  /* And every disabled row, in every state above, carries SOME reason. */
  for (const rows of [idle, quiet, busy, preview, parent]) {
    for (const row of Object.values(rows)) {
      if (row.enabled === false) {
        assert.equal(typeof row.disabledHint, 'string', `${row.id} is switched off with no reason`)
        assert.ok(row.disabledHint.length > 0, `${row.id} is switched off with an empty reason`)
      }
    }
  }
})

test('enabled rows carry their ordinary hints', () => {
  const live = byId(rowsFor({ started: true, running: true, turnsSoFar: 2, reply: 'Done.', message: 'Do it.', saved: false }))
  for (const id of ['attach', 'mention', 'effort', 'model', 'rewind', 'copy-brief', 'copy-reply', 'interrupt', 'stop', 'clear', 'queue', 'child', 'move']) {
    assert.equal(live[id].enabled, true, `${id} is off on a running agent that has said something`)
  }
  assert.equal(live.attach.hint, PALETTE_PANEL.attachHint)
  assert.equal(live.mention.hint, PALETTE_PANEL.mentionHint)
  assert.equal(live.queue.hint, PALETTE_PANEL.queueFocusHint)
})

test('the restored composer rows act on their originating chat once and preserve their receipts', async () => {
  const calls = []
  const rows = byId(rowsFor({ started: true, runPaletteAction: id => calls.push(['legacy-runner', id]) }))
  const ctx = {
    close: () => calls.push(['close']), say: text => calls.push(['say', text]),
    composer: {
      attach: async () => { calls.push(['attach']); return true },
      mention: async () => { calls.push(['mention']); return true },
      focus: () => calls.push(['focus']),
    },
  }
  for (const id of ['attach', 'mention', 'queue']) await rows[id].run(ctx)
  assert.deepEqual(calls, [
    ['attach'], ['say', PALETTE_PANEL.attachPicked],
    ['mention'], ['close'], ['close'], ['focus'],
  ], 'Actions must use the originating composer and never dispatch to another chat through the old runner')
  calls.length = 0
  ctx.composer.attach = async () => { calls.push(['attach']); return false }
  ctx.composer.mention = async () => { calls.push(['mention']); return false }
  await rows.attach.run(ctx)
  await rows.mention.run(ctx)
  assert.deepEqual(calls, [
    ['attach'], ['say', PALETTE_PANEL.attachCancelled],
    ['mention'], ['say', PALETTE_PANEL.mentionCancelled],
  ], 'Cancelled pickers must retain Actions with the exact action-specific receipt')
})

/* THE SENTENCE ABOUT THE WRONG ACTION. A cancelled mention said "Nothing was
   attached." -- PALETTE_PANEL.attachCancelled, reused from a different branch. */
test('a cancelled mention says a sentence about mentioning, not about attaching', () => {
  assert.notEqual(PALETTE_PANEL.mentionCancelled, PALETTE_PANEL.attachCancelled, 'the two cancel sentences are one sentence')
  assert.match(PALETTE_PANEL.mentionCancelled, /mention/i, 'the mention-cancel sentence does not say what was not done')
  const runners = VIEW.slice(VIEW.indexOf('async function runPaletteAction'))
  const mention = runners.slice(runners.indexOf("if (id === 'mention')"), runners.indexOf("if (id === 'copy-brief'"))
  assert.ok(mention.length > 100, 'the mention runner could not be found')
  assert.match(mention, /PALETTE_PANEL\.mentionCancelled/, 'the mention runner does not use its own cancel sentence')
  assert.doesNotMatch(mention, /attachCancelled/, 'the mention runner still says "Nothing was attached." on cancel')
  const attach = runners.slice(runners.indexOf("if (id === 'attach')"), runners.indexOf("if (id === 'clear')"))
  assert.match(attach, /PALETTE_PANEL\.attachCancelled/, 'the attach runner lost its own cancel sentence')
})

/* Every disabled reason is a sentence a person can read, under the same rules
   the rest of the product's copy takes: no identifiers, no shouting, no
   README punctuation. */
test('every reason and every group heading reads as a sentence', () => {
  const words = Object.entries(PALETTE_PANEL).filter(([key]) => key.startsWith('why') || key.startsWith('group'))
  assert.ok(words.length >= 10, `expected the reasons and headings, walked ${words.length}`)
  for (const [key, sentence] of words) {
    assert.equal(typeof sentence, 'string')
    assert.ok(sentence.length > 0, `${key} is empty`)
    assert.doesNotMatch(sentence, /\b[A-Z][A-Z0-9_]{4,}\b/, `${key} carries an identifier: ${sentence}`)
    for (const bad of ['·', '…', '—', '|']) assert.ok(!sentence.includes(bad), `${key} carries README punctuation: ${sentence}`)
  }
})

/* OWNER REQUEST R1238 (2026-09-19): "why does the button hide now it needs to
   work". Switch and continue was spread in behind `savedConversation`, so on a
   circle with nothing saved the row was not refused, it was ABSENT -- and an
   absent control is indistinguishable from a product that never had one. This
   pins the palette's own standing rule for it: the row exists in every state,
   and every state that switches it off says why. */
test('switch and continue is offered in every state, and never simply missing', () => {
  const states = {
    'nothing saved yet': rowsFor(),
    'saved, idle': rowsFor({ saved: true }),
    'saved, mid-turn': rowsFor({ saved: true, running: true, started: true }),
    'saved, starting switched off': rowsFor({ saved: true, startEnabled: false }),
    'an example board': rowsFor({ saved: true, sourceMode: 'example' }),
  }
  for (const [state, rows] of Object.entries(states)) {
    const row = byId(rows)['switch-continue']
    assert.ok(row, `switch-continue is missing entirely when: ${state}`)
    assert.equal(row.group, PALETTE_PANEL.groupAgent, `switch-continue left its group when: ${state}`)
    if (!row.enabled) {
      assert.ok(row.disabledHint, `switch-continue is switched off and silent about it when: ${state}`)
    }
  }
  /* And the one it could never act on names the reason a person can act on,
     rather than the generic bridge sentence. */
  assert.equal(byId(states['nothing saved yet'])['switch-continue'].enabled, false)
  assert.equal(byId(states['nothing saved yet'])['switch-continue'].disabledHint, PALETTE_PANEL.whyNoSaved)
})

/* T1401: the Remove row's hint counted "1 agents below it". */
test('the Remove row names one agent below it in the singular', () => {
  assert.match(byId(rowsFor({ childCount: 1 })).remove.hint, /Removes this agent and 1 agent below it after one confirmation\./)
  assert.match(byId(rowsFor({ childCount: 2 })).remove.hint, /Removes this agent and 2 agents below it after one confirmation\./)
})

/* T1377: the ↳+ button hides when an agent has no free child slot, but the
   Actions row that opens the same start panel stayed enabled, so a person
   wrote a brief the store then refused. The row now follows the store's
   admission and says why. */
test('Start an agent under this one follows the free child slots the store admits', () => {
  const full = { total: 4, limit: 4, canAdd: false, reason: 'This agent already has 4 direct child slots, the most this tree allows.' }
  const row = byId(rowsFor({ childSlot: full })).child
  assert.equal(row.enabled, false, 'no free slot, no enabled row')
  assert.equal(row.disabledHint, full.reason, 'the row says the store\'s own reason')
  assert.equal(byId(rowsFor({ childSlot: { total: 1, limit: 4, canAdd: true, reason: '' } })).child.enabled, true)
  assert.equal(byId(rowsFor()).child.enabled, true, 'a node the store does not know keeps the row')
})
