// B8 (found by hand on the installed 1.0.46, 2026-09-25): a standalone agent tab with an open session
// and three answered turns showed an Actions menu that said "This agent has not started yet",
// "Nothing was asked here yet", "It has not answered yet", "This agent is not running right now",
// with Stop and Interrupt switched off. The rows come from the tree's builder, which reads the tree's
// session registry that standalone tabs are deliberately absent from. These pin the correction.
import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
register('./helpers/css-stub-loader.mjs', import.meta.url)
const standaloneModule = await import('../../src/tree-standalone-agent.js')
const { correctStandaloneActionRows, STANDALONE_TREE_ONLY_SENTENCE } = standaloneModule
const { PALETTE_PANEL } = await import('../../src/fleet-tree-copy.js')

// What the tree's builder answers for a standalone seat, whatever the tab's session is doing.
const treeRows = () => [
  { id: 'queue', enabled: false, disabledHint: PALETTE_PANEL.whyNotStarted, run: () => 'tree-queue' },
  { id: 'copy-brief', enabled: false, disabledHint: PALETTE_PANEL.whyNoBrief, run: () => 'tree-copy-brief' },
  { id: 'copy-reply', enabled: false, disabledHint: PALETTE_PANEL.whyNoReply, run: () => 'tree-copy-reply' },
  { id: 'child', enabled: true, disabledHint: null, run: () => 'tree-child' },
  { id: 'interrupt', enabled: false, disabledHint: PALETTE_PANEL.whyNotRunning, run: () => 'tree-interrupt' },
  { id: 'stop', enabled: false, disabledHint: PALETTE_PANEL.whyNotRunning, run: () => 'tree-stop' },
  { id: 'permission-settings', enabled: true, disabledHint: null, run: () => 'tree-permission-settings' },
]
const byId = rows => Object.fromEntries(rows.map(row => [row.id, row]))

test('a running standalone agent: Interrupt and Stop work through the tab, and the conversation is readable', async () => {
  const calls = []
  const seat = { id: 'standalone-b8', role: 'worker' }
  const rows = byId(correctStandaloneActionRows(treeRows(), {
    snapshot: { sessionId: 'session-b8', phase: 'working', transcript: [
      { who: 'you', text: 'Count slowly to 80.' }, { who: 'agent', text: '1, 2, 3' },
      { who: 'you', text: 'Faster.' }, { who: 'agent', text: '4 5 6' }] },
    pause: async () => { calls.push('pause'); return { ok: true } },
    terminate: async () => { calls.push('terminate'); return { ok: true } },
    seat,
  }))
  assert.equal(rows.interrupt.enabled, true)
  assert.equal(rows.stop.enabled, true)
  await rows.interrupt.run({ say() {} })
  await rows.stop.run({ say() {} })
  assert.deepEqual(calls, ['pause', 'terminate'], 'the rows drive the tab session, not the tree registry that does not hold it')
  assert.equal(rows['copy-brief'].enabled, true)
  assert.equal(rows['copy-reply'].enabled, true)
  assert.equal(seat.message, 'Count slowly to 80.', 'Copy what you asked copies the brief')
  assert.equal(seat.reply, '4 5 6', 'Copy what it said copies the latest answer')
  assert.equal(rows.queue.disabledHint, STANDALONE_TREE_ONLY_SENTENCE, 'a tree-only row says so instead of "has not started yet"')
  assert.equal(rows['permission-settings'].enabled, true, 'rows the tree already answers correctly are untouched')
  assert.equal(rows['permission-settings'].run(), 'tree-permission-settings')
})

test('an open but idle standalone agent: Stop works, Interrupt says nothing is running', () => {
  const rows = byId(correctStandaloneActionRows(treeRows(), {
    snapshot: { sessionId: 'session-b8', phase: 'open', transcript: [{ who: 'you', text: 'Hi' }, { who: 'agent', text: 'Hello' }] },
    pause: async () => ({ ok: true }), terminate: async () => ({ ok: true }),
  }))
  assert.equal(rows.interrupt.enabled, false)
  assert.equal(rows.interrupt.disabledHint, PALETTE_PANEL.whyNotRunning)
  assert.equal(rows.stop.enabled, true)
})

test('a tab that never started keeps the true answers: not started, nothing asked', () => {
  const seat = {}
  const rows = byId(correctStandaloneActionRows(treeRows(), { snapshot: { sessionId: null, phase: 'draft', transcript: [] }, seat }))
  assert.equal(rows.interrupt.enabled, false)
  assert.equal(rows.stop.enabled, false)
  assert.equal(rows['copy-brief'].disabledHint, PALETTE_PANEL.whyNoBrief)
  assert.equal(rows.queue.disabledHint, PALETTE_PANEL.whyNotStarted, 'before a session exists, "has not started yet" is the truth')
  assert.equal(seat.message, '')
})

test('a refused stop is said in the menu, not swallowed', async () => {
  const said = []
  const rows = byId(correctStandaloneActionRows(treeRows(), {
    snapshot: { sessionId: 'session-b8', phase: 'working', transcript: [] },
    pause: async () => ({ ok: false, sentence: 'The agent did not confirm the stop.' }),
  }))
  await rows.interrupt.run({ say: text => said.push(text) })
  assert.deepEqual(said, ['The agent did not confirm the stop.'])
})

/* B4 (1.0.48): a New agent tab comes back after a restart with its saved
   conversation and no running session. The tree's Resume and Switch rows light
   up for any seat with a saved conversation, and both then fail, because they
   only work on tree agents. The way to continue a standalone agent is to send
   it a message, so the rows say that, and Copy reads the saved words too. */
test('a restored agent: Resume and Switch point at sending a message, and Copy reads the saved conversation (B4)', () => {
  const withTreeOnlyRows = () => [...treeRows(),
    { id: 'resume', enabled: true, disabledHint: null, run: () => 'tree-resume' },
    { id: 'switch-continue', enabled: true, disabledHint: null, run: () => 'tree-switch' }]
  const savedLines = [
    { who: 'you', text: 'Standing rules for this computer.', promptSource: 'toolsenabled', promptKind: 'requests' },
    { who: 'you', text: 'Count to three.' }, { who: 'agent', text: '1 2 3' }]
  const seat = {}
  const rows = byId(correctStandaloneActionRows(withTreeOnlyRows(), {
    snapshot: { sessionId: null, phase: 'draft', transcript: [] }, seat, savedLines, continues: true }))
  assert.equal(rows.resume.enabled, false)
  assert.equal(rows.resume.disabledHint, 'Send a message to continue this conversation.')
  assert.equal(rows['switch-continue'].enabled, false)
  assert.equal(rows['switch-continue'].disabledHint, STANDALONE_TREE_ONLY_SENTENCE)
  assert.equal(rows['copy-brief'].enabled, true, 'the saved question is something to copy')
  assert.equal(rows['copy-reply'].enabled, true)
  assert.equal(seat.message, 'Count to three.', 'a line ToolsEnabled added is not what the person asked')
  assert.equal(seat.reply, '1 2 3')

  // Once it is running again the tree's Resume still cannot act on it.
  const live = byId(correctStandaloneActionRows(withTreeOnlyRows(), {
    snapshot: { sessionId: 'session-b4', phase: 'open', transcript: [{ who: 'agent', text: '4 5 6' }] }, seat, savedLines }))
  assert.equal(live.resume.enabled, false)
  assert.equal(live['switch-continue'].enabled, false)
  assert.equal(seat.reply, '4 5 6', 'Copy what it said reads the newest answer')
})

/* B4 review (1.0.48), D6. "Send a message to continue this conversation." is the Resume row's
   answer only while nothing runs (design step 8). While the agent works it read as though the agent
   had stopped. The row still stays off while running: the tree's Resume lights up for any seat with
   a saved conversation and then fails, because resumeNodeSession refuses a seat no tree holds. */
test('a running standalone agent: Resume stays off and says it is a tree action, not "send a message" (B4 review D6)', () => {
  const rows = () => [...treeRows(),
    { id: 'resume', enabled: true, disabledHint: null, run: () => 'tree-resume' },
    { id: 'switch-continue', enabled: true, disabledHint: null, run: () => 'tree-switch' }]
  for (const phase of ['working', 'open']) {
    const live = byId(correctStandaloneActionRows(rows(), {
      snapshot: { sessionId: 'session-d6', phase, transcript: [{ who: 'you', text: 'Count.' }] }, savedLines: [{ who: 'agent', text: '1' }] }))
    assert.equal(live.resume.enabled, false, `${phase}: the tree's Resume would fail on a standalone agent`)
    assert.equal(live.resume.disabledHint, STANDALONE_TREE_ONLY_SENTENCE,
      `${phase}: THE DEFECT: the running agent's Resume row says to send a message to continue`)
    assert.equal(live['switch-continue'].enabled, false)
    assert.equal(live['switch-continue'].disabledHint, STANDALONE_TREE_ONLY_SENTENCE)
  }
  const idle = byId(correctStandaloneActionRows(rows(), { snapshot: { sessionId: null, phase: 'draft', transcript: [] }, savedLines: [{ who: 'agent', text: '1' }], continues: true }))
  assert.equal(idle.resume.disabledHint, 'Send a message to continue this conversation.')
})

/* B4 verify: idle, "Send a message to continue this conversation." showed on a tab that had never
   sent anything, and on a stopped tab whose next session is not handed the conversation. It is true
   only while the saved conversation is still owed to the next send. */
test('an idle standalone agent: Resume says continue only while the conversation is owed to the next send (B4 verify)', () => {
  const rows = () => [...treeRows(), { id: 'resume', enabled: true, disabledHint: null, run: () => 'tree-resume' }]
  const draft = { sessionId: null, phase: 'draft', transcript: [] }
  const fresh = byId(correctStandaloneActionRows(rows(), { snapshot: draft }))
  assert.equal(fresh.resume.disabledHint, 'Send a message to start this agent.', 'THE DEFECT: a tab that never sent is told to continue')
  const stopped = byId(correctStandaloneActionRows(rows(), { snapshot: { ...draft, transcript: [{ who: 'you', text: 'Hi' }, { who: 'agent', text: 'Hello' }] } }))
  assert.equal(stopped.resume.disabledHint, STANDALONE_TREE_ONLY_SENTENCE, 'THE DEFECT: a stopped tab is told its conversation continues')
  const owed = byId(correctStandaloneActionRows(rows(), { snapshot: draft, savedLines: [{ who: 'agent', text: 'Hello' }], continues: true }))
  assert.equal(owed.resume.disabledHint, 'Send a message to continue this conversation.')
})

/* B23 (found by hand on 1.0.48 candidate 1): on a New agent tab, Actions > Switch model listed every
   model switched off with "This agent changed. Reopen the model menu for its current session." The
   tree's builder reads the tree's store and session registry, and a tab is in neither, so its
   next-model stage refused every row. The row now does what the tab's model chip does: it opens
   the tab's own chooser, and the choice is what the tab starts on next. */
const treeModelRow = () => ({ id: 'model', label: PALETTE_PANEL.switchModel, hint: PALETTE_PANEL.switchModelHint, enabled: true, disabledHint: null,
  run: ctx => ctx.show(() => [{ id: 'next-model-claude-sonnet-5', enabled: false,
    disabledHint: 'This agent changed. Reopen the model menu for its current session.' }]) })

test('Switch model on a New agent tab opens the tab\'s own model chooser, the one its model chip opens (B23)', async () => {
  const opened = [], shown = [], closed = []
  const ctx = { close: () => closed.push(true), show: rows => shown.push(rows), say() {} }
  for (const snapshot of [{ sessionId: 'session-b23', phase: 'open', transcript: [] }, { sessionId: null, phase: 'draft', transcript: [] }]) {
    const rows = byId(correctStandaloneActionRows([...treeRows(), treeModelRow()], { snapshot, changeModel: () => opened.push(snapshot.phase) }))
    assert.equal(rows.model.enabled, true)
    await rows.model.run(ctx)
  }
  assert.deepEqual(opened, ['open', 'draft'], 'THE DEFECT: the tree\'s next-model stage, whose rows are all off for a tab, was shown instead')
  assert.equal(shown.length, 0)
  assert.equal(closed.length, 2, 'the Actions menu closes so the chooser is what the person sees')
})

test('Switch model on a New agent tab says when the choice is used, and where to go without a chooser (B23)', () => {
  const running = byId(correctStandaloneActionRows([treeModelRow()], { snapshot: { sessionId: 's', phase: 'working', transcript: [] }, changeModel() {} }))
  assert.notEqual(running.model.hint, PALETTE_PANEL.switchModelHint, 'a tab does not continue its running session on the new model')
  assert.match(running.model.hint, /next time this agent starts/)
  const idle = byId(correctStandaloneActionRows([treeModelRow()], { snapshot: { sessionId: null, phase: 'draft', transcript: [] }, changeModel() {} }))
  assert.match(idle.model.hint, /starts on the model you choose/)
  const none = byId(correctStandaloneActionRows([treeModelRow()], { snapshot: { sessionId: 's', phase: 'open', transcript: [] } }))
  assert.equal(none.model.enabled, false)
  assert.match(none.model.disabledHint, /new agent/, 'with no chooser the row says where another model is chosen')
})

/* B21 (found by hand on 1.0.48 candidate 1): "Start an agent under this one" on a New agent tab was
   left on by the B8 correction, and it opened the start panel for a NEW tree: the tab is not on a
   tree, so there is no "under this one" to start. A child needs a tree, so the row says so. */
test('Start an agent under this one is a tree action on a New agent tab, running or not (B21)', () => {
  const running = { sessionId: 'session-b21', phase: 'open', transcript: [{ who: 'you', text: 'Hi' }] }
  const idle = { sessionId: null, phase: 'draft', transcript: [] }
  for (const snapshot of [running, idle]) {
    const rows = byId(correctStandaloneActionRows(treeRows(), { snapshot }))
    assert.equal(rows.child.enabled, false, `${snapshot.phase}: THE DEFECT: the row opened the start panel for a new tree`)
    assert.equal(rows.child.disabledHint, STANDALONE_TREE_ONLY_SENTENCE)
  }
})

/* B21/B23 follow-up P2 (round-2 verify): after Add to tree the tab stays open, and its Actions still
   said "Start an agent under this one: This works on agents in a tree. Use Add to tree to get it."
   (false: it is on a tree and the button is gone), and Switch model opened the tab's chooser whose
   pick the tree's start ignored. */
test('a tab added to a tree: Switch model is off and says to select it on the tree, and the child row says the same (placed)', () => {
  const placedCopy = standaloneModule.STANDALONE_PLACED_COPY
  assert.ok(placedCopy, 'the placed sentences are exported')
  const opened = []
  for (const snapshot of [{ sessionId: 'session-placed', phase: 'open', transcript: [] }, { sessionId: null, phase: 'draft', transcript: [] }]) {
    const rows = byId(correctStandaloneActionRows([...treeRows(), treeModelRow()], { snapshot, placed: true, changeModel: () => opened.push(snapshot.phase) }))
    assert.equal(rows.model.enabled, false, 'THE DEFECT: the tab chooser was offered, and the tree ignored its pick')
    assert.equal(rows.model.disabledHint, placedCopy.model)
    assert.match(rows.model.disabledHint, /Select it on the tree/)
    assert.equal(rows.child.enabled, false)
    assert.equal(rows.child.disabledHint, placedCopy.child, 'THE DEFECT: a placed agent was told to use Add to tree')
    assert.doesNotMatch(rows.child.disabledHint, /Add to tree/)
  }
  assert.deepEqual(opened, [])
})

/* On a tab that is on no tree, "Change who it reports to" focused a tree Details control and Loop
   opened the tree's loop panel for a node that is not there. */
const treeMoveAndLoopRows = () => [
  { id: 'move', label: PALETTE_PANEL.moveFocus, enabled: true, disabledHint: null, run: () => 'tree-move' },
  { id: 'loop', label: PALETTE_PANEL.loop, icon: 'loop', minutes: 10, enabled: true, disabledHint: PALETTE_PANEL.whyNotStarted, run: () => 'tree-loop' },
  { id: 'goal', label: PALETTE_PANEL.goal, icon: 'goal', enabled: true, disabledHint: PALETTE_PANEL.whyNotStarted, run: () => 'tree-goal' },
]

test('Change who it reports to and Loop are tree actions on a tab that is on no tree, running or not', () => {
  for (const snapshot of [{ sessionId: 'session-open', phase: 'open', transcript: [] }, { sessionId: null, phase: 'draft', transcript: [] }]) {
    const rows = byId(correctStandaloneActionRows(treeMoveAndLoopRows(), { snapshot }))
    for (const id of ['move', 'loop']) {
      assert.equal(rows[id].enabled, false, `${snapshot.phase} ${id}: THE DEFECT: it opened a tree-only control`)
      assert.equal(rows[id].disabledHint, STANDALONE_TREE_ONLY_SENTENCE)
    }
    assert.equal(rows.goal.enabled, true, '/goal is typed into this tab and stays as it was')
  }
  const placed = byId(correctStandaloneActionRows(treeMoveAndLoopRows(), { snapshot: { sessionId: 's', phase: 'open', transcript: [] }, placed: true }))
  assert.equal(placed.move.enabled, true, 'on a tree, the tree rows stand')
  assert.equal(placed.loop.enabled, true)
})

/* c4 second review, real window: on a New agent tab, Actions > "Stop this agent" printed
   "[object Object]" on the menu's status line. The tab's rows returned the controller's result
   object, and the popup (src/components.js runPopRow) shows whatever run() returns with String().
   The status line reads the same sentences the tree's own rows say. Modelled exactly as runPopRow
   does it: ctx.say writes the line, then a truthy return value overwrites it. */
test('c4r2: the tab\'s Interrupt and Stop rows leave a sentence on the menu status line, never an object', async () => {
  const statusAfter = async (row) => {
    let line = ''
    const said = await row.run({ say(sentence) { line = String(sentence) } })
    if (said) line = String(said)
    return line
  }
  const running = { sessionId: 'session-c4r2', phase: 'working', transcript: [{ who: 'you', text: 'Hi' }] }
  const done = byId(correctStandaloneActionRows(treeRows(), {
    snapshot: running, pause: async () => ({ ok: true }), terminate: async () => ({ ok: true, closed: true }),
  }))
  assert.equal(await statusAfter(done.interrupt), PALETTE_PANEL.interruptDone)
  assert.equal(await statusAfter(done.stop), PALETTE_PANEL.stopped)
  const refused = byId(correctStandaloneActionRows(treeRows(), {
    snapshot: running,
    pause: async () => ({ ok: false, code: 'AGENT_TURN_NONE' }),
    terminate: async () => ({ ok: false, code: 'AGENT_SWITCH_PENDING' }),
  }))
  const interruptLine = await statusAfter(refused.interrupt)
  const stopLine = await statusAfter(refused.stop)
  for (const line of [interruptLine, stopLine]) assert.equal(/\[object Object\]/.test(line) || line === '', false, `status line: "${line}"`)
  assert.equal(interruptLine, PALETTE_PANEL.interruptMissed)
  assert.equal(stopLine, PALETTE_PANEL.stopRefusal('AGENT_SWITCH_PENDING'))
  const explained = byId(correctStandaloneActionRows(treeRows(), {
    snapshot: running, terminate: async () => ({ ok: false, code: 'AGENT_SWITCH_PENDING', sentence: 'The model switch is still finishing.' }),
  }))
  assert.equal(await statusAfter(explained.stop), 'The model switch is still finishing.', 'a refusal that names itself keeps its own sentence')
})
