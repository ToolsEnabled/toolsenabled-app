/* THE RAIL CHATBOX'S DECISIONS — especially the empty ones.
 *
 * Owner, verbatim: "On the right when you click a node there should be a
 * chatbox along with the other buttons."
 *
 * The failure this suite exists to prevent is not a blank screen. It is a box
 * that looks like a working chat and is not one. Two ways that happens:
 *
 *   · a composer that accepts what a person types and has nowhere to send it.
 *     A dispatched lane is handed its whole prompt on stdin at spawn and the
 *     pipe is closed; there is no second write. So for most nodes on page 2
 *     there is NO live channel, and the box has to say so rather than offer an
 *     input field.
 *
 *   · an empty box that reports the wrong emptiness. "Nobody has said
 *     anything" and "you switched every speaker off" look identical and are
 *     not: the second is undone by the person in one click and the first is
 *     not. src/chatbox-feed.js already distinguishes them; this suite proves
 *     the rail does not flatten them back together.
 *
 * WHICH AGENTS AND RUNS APPEAR IS NOT THIS FILE'S DECISION — it belongs to
 * src/chatbox-feed.js, which the settings page owns. These tests drive the
 * rail through that module's real storage keys rather than stubbing its
 * answers, so a rail that stopped honouring the person's settings fails here.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/* chatbox-feed.js reads localStorage directly and falls back to its defaults
   when storage refuses. Under `node --test` there is no storage at all, so
   without this the suite could only ever exercise the default settings — and
   the settings-dependent branches are exactly the ones worth proving. */
const store = new Map()
globalThis.localStorage = {
  getItem: key => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => { store.set(key, String(value)) },
  removeItem: key => { store.delete(key) },
  clear: () => store.clear(),
}

const { planNodeChatbox, channelCaption } = await import('../../src/node-chatbox.js')
const { resolveChatChannel, channelHasConversation, CHAT_CHANNEL_KINDS } = await import('../../src/orchestration-controls.js')

const AGENT = { id: 'terra-01', name: 'Terra 01' }
const TURNS = [{ who: 'terra-01', text: 'picking up the lane' }, { who: 'luna-02', text: 'ack' }]
const RUNS = [{ sequence: 4, atMs: 1_700_000_000_000 }]

test.beforeEach(() => store.clear())

/* ---------------------------------------------------------------
   the channel
   --------------------------------------------------------------- */

test('a live node with no app-owned session gets no composer and a stated reason', () => {
  const plan = planNodeChatbox({ agent: AGENT, live: true, turns: TURNS })
  assert.equal(plan.channel.kind, 'none')
  assert.equal(plan.channel.canSend, false)
  assert.ok(plan.composerReason, 'the box refuses to send and does not say why')
})

test('a session this app started is sendable and says so in the caption', () => {
  const plan = planNodeChatbox({
    agent: AGENT, live: true, sessionAvailable: true, sessionAgentId: 'terra-01', turns: TURNS,
  })
  assert.equal(plan.channel.kind, 'session')
  assert.equal(plan.composerReason, null)
  assert.match(channelCaption(plan.channel, 'Manager'), /reaches the running agent/)
})

test('the simulated fleet never claims to reach a process', () => {
  const plan = planNodeChatbox({ agent: AGENT, live: false, turns: TURNS })
  assert.equal(plan.channel.kind, 'simulated')
  assert.match(channelCaption(plan.channel), /simulated/)
  assert.doesNotMatch(channelCaption(plan.channel), /running agent/)
})

/* ---------------------------------------------------------------
   "a conversation exists" and "you may write to it" are two questions

   These were being asked in two different ways — `channel.kind !== 'none'` in
   one place and `channel.canSend` in another — and they agreed only because no
   kind has yet existed that HAS a conversation and cannot be written to. That
   is an invariant holding by construction with nothing asserting it, which is
   the same shape as the two defects this pairing has already produced: true
   today, one refactor from silently false, and quiet in both directions.

   The drift that would actually happen is an interrupted session
   (mcAgent.interrupt() already exists) or a read-only simulated fleet. Either
   adds a kind with a conversation and canSend:false, at which point the caller
   that meant "a conversation exists" starts reporting "no channel to this
   agent" — reviving the defect commit f4b4433 fixed, without a test going red.
   --------------------------------------------------------------- */

test('a conversation that cannot be written to is still a conversation', () => {
  /* The drift case, asserted directly because resolveChatChannel cannot
     produce it yet. This is the whole point: it must already be pinned when
     someone adds the kind, not after. */
  assert.equal(channelHasConversation({ kind: 'session', canSend: false }), true)
  assert.equal(channelHasConversation({ kind: 'simulated', canSend: false }), true)
  assert.equal(channelHasConversation({ kind: 'none', canSend: false }), false)
  assert.equal(channelHasConversation(null), false)
})

test('every channel kind is declared, so a fourth forces a decision', () => {
  const reached = new Set()
  for (const live of [true, false]) {
    for (const sessionAvailable of [true, false]) {
      for (const sessionAgentId of [null, 'terra-01', 'someone-else']) {
        const channel = resolveChatChannel({ live, sessionAvailable, sessionAgentId, agentId: 'terra-01' })
        assert.ok(CHAT_CHANNEL_KINDS.includes(channel.kind),
          `resolveChatChannel returned undeclared kind "${channel.kind}"`)
        reached.add(channel.kind)
      }
    }
  }
  assert.deepEqual([...reached].sort(), [...CHAT_CHANNEL_KINDS].sort(),
    'a declared kind is unreachable, or a reachable kind is undeclared')
})

test('the use site asks by name, which no behavioural test can yet prove', () => {
  /* A SOURCE-TEXT ASSERTION, AND THE ONE PLACE ONE IS THE RIGHT TOOL.
     Swapping `channelHasConversation(channel)` back to `channel.canSend` at
     this use site is behaviourally INVISIBLE today: the two agree for every
     channel resolveChatChannel can currently return, so every behavioural test
     above stays green through that revert. The choice only becomes observable
     on the day someone adds the fourth kind — which is the day it is too late
     to notice. Pinning the intent is therefore the only protection available,
     and pinning it as text is honest about being exactly that.

     Anchored precisely, with the anchor and the bound both asserted, because a
     test of mine earlier in this lane sliced from a CALL SITE instead of a
     definition and was checking air until a mutant exposed it.

     BOTH use sites are covered. The first version of this test pinned only
     `contextHiddenReason`, and a mutant swapping `contextAvailable` to
     `canSend` survived it — the same partial-coverage failure, found the same
     way, one turn later. */
  const source = readFileSync(path.join(ROOT, 'src/node-chatbox.js'), 'utf8')
  const sites = [
    { field: 'contextAvailable', end: ',\n', why: 'whether there is a conversation to show' },
    { field: 'contextHiddenReason', end: '      : null,', why: 'whether a conversation exists to be hidden' },
  ]
  for (const site of sites) {
    const start = source.indexOf(`    ${site.field}:`)
    assert.notEqual(start, -1, `${site.field} not found — this test is checking air`)
    const end = source.indexOf(site.end, start)
    assert.notEqual(end, -1, `${site.field} has no terminator — this test is checking air`)
    const expression = source.slice(start, end)
    assert.ok(expression.includes('channelHasConversation(channel)'),
      `${site.field} stopped asking ${site.why}`)
    assert.ok(!expression.includes('canSend'),
      `${site.field} is asking about sendability again; the first non-writable conversation revives f4b4433`)
  }
})

test('the two questions are asked by name over every reachable channel', () => {
  for (const live of [true, false]) {
    for (const sessionAvailable of [true, false]) {
      const channel = resolveChatChannel({ live, sessionAvailable, sessionAgentId: 'terra-01', agentId: 'terra-01' })
      const plan = planNodeChatbox({ agent: AGENT, live, sessionAvailable, sessionAgentId: 'terra-01' })
      assert.equal(plan.showContext, channelHasConversation(channel),
        'showContext stopped tracking whether a conversation exists')
      assert.equal(plan.composerReason === null, channel.canSend,
        'the composer stopped tracking whether the person may write')
    }
  }
})

/* ---------------------------------------------------------------
   the person's settings, honoured rather than reinvented
   --------------------------------------------------------------- */

test('runs mode "hidden" removes the runs half and leaves the conversation', () => {
  store.set('mc.chat.runs', 'hidden')
  const plan = planNodeChatbox({ agent: AGENT, live: false, turns: TURNS, runs: RUNS })
  assert.equal(plan.showRuns, false)
  assert.equal(plan.runs.length, 0)
  assert.equal(plan.showContext, true)
})

test('runs mode "only" removes the conversation and leaves the runs', () => {
  store.set('mc.chat.runs', 'only')
  const plan = planNodeChatbox({ agent: AGENT, live: false, turns: TURNS, runs: RUNS, runsSupported: true })
  assert.equal(plan.showContext, false)
  assert.equal(plan.turns.length, 0)
  assert.equal(plan.showRuns, true)
  assert.equal(plan.runs.length, 1)
})

test('a chosen-agent selection hides the others and counts what it held back', () => {
  store.set('mc.chat.agents', JSON.stringify(['terra-01']))
  const plan = planNodeChatbox({ agent: AGENT, live: false, turns: TURNS })
  assert.equal(plan.hiddenAgents, 1)
  assert.equal(plan.turns.length, 1)
  assert.equal(plan.turns[0].who, 'terra-01')
})

/* ---------------------------------------------------------------
   availability is about the SOURCE, not about its contents
   --------------------------------------------------------------- */

test('a node with a channel but nothing said still HAS a context source', () => {
  /* The first version of this planner passed `contextAvailable: turns.length > 0`,
     which answers "is it non-empty right now" rather than "does it exist".
     src/chatbox-feed.js's flags are about the source; emptiness is the empty
     state's job, one layer down. */
  const plan = planNodeChatbox({ agent: AGENT, live: false, turns: [], runs: [] })
  assert.equal(plan.showContext, true, 'a simulated node with no turns yet reported no context SOURCE')
  assert.equal(plan.turns.length, 0)
  assert.equal(plan.emptyReason, 'Nothing said yet.')
})

test('a rail that can read a run record HAS a runs source, even with zero runs', () => {
  const plan = planNodeChatbox({ agent: AGENT, live: false, turns: [], runs: [], runsSupported: true })
  assert.equal(plan.showRuns, true, 'a readable but empty run record reported no runs SOURCE')
  assert.equal(plan.runs.length, 0)
})

test('a rail with nobody to ask has no runs source at all', () => {
  /* readLocalSessions(undefined).supported === false — a browser with no shell
     behind it. Distinct from "asked, and there are none". */
  const plan = planNodeChatbox({ agent: AGENT, live: false, turns: TURNS, runs: [], runsSupported: false })
  assert.equal(plan.showRuns, false)
})

test('a live node with no channel has no context source', () => {
  const plan = planNodeChatbox({ agent: AGENT, live: true, turns: [], runs: [] })
  assert.equal(plan.channel.kind, 'none')
  assert.equal(plan.showContext, false, 'a node with no channel claimed to have a conversation source')
})

/* ---------------------------------------------------------------
   the four emptinesses, which are four different sentences
   --------------------------------------------------------------- */

test('filtering everyone out is reported as filtering, not as silence', () => {
  store.set('mc.chat.agents', JSON.stringify(['nobody-here']))
  const plan = planNodeChatbox({ agent: AGENT, live: false, turns: TURNS })
  assert.equal(plan.filteredToNothing, true)
  assert.match(plan.emptyReason, /hidden by your chat settings/)
})

test('genuine silence is not reported as filtering', () => {
  const plan = planNodeChatbox({ agent: AGENT, live: false, turns: [], runs: [] })
  assert.equal(plan.filteredToNothing, false)
  assert.equal(plan.emptyReason, 'Nothing said yet.')
})

test('"runs only" with no runs says that, rather than reporting no conversation', () => {
  store.set('mc.chat.runs', 'only')
  const plan = planNodeChatbox({ agent: AGENT, live: false, turns: TURNS, runs: [] })
  assert.match(plan.emptyReason, /show runs only/)
})

test('"runs hidden" with nothing said says that, rather than blaming the runs', () => {
  store.set('mc.chat.runs', 'hidden')
  const plan = planNodeChatbox({ agent: AGENT, live: false, turns: [], runs: RUNS })
  assert.match(plan.emptyReason, /hide runs/)
})

/* ---------------------------------------------------------------
   a fact about the SELECTION must not be reported as a fact about the BOX

   The exact combination below was measured against src/chatbox-feed.js by the
   lane that owns it: simulated fleet, "show only runs", and this node's own
   agent unticked. showContext false, showRuns true, filteredToNothing TRUE.
   Ungated, the box appended "None of the agents talking are ones you picked"
   to a panel that was deliberately not showing a conversation — a complaint
   about the context filter on a box with no context half — and swallowed the
   runs-only sentence underneath it.
   --------------------------------------------------------------- */

test('runs-only with everyone unticked does not blame the context filter', () => {
  store.set('mc.chat.runs', 'only')
  store.set('mc.chat.agents', JSON.stringify(['someone-else']))
  const plan = planNodeChatbox({
    agent: AGENT, live: false, turns: [{ who: 'luna-02' }], runs: [], runsSupported: true,
  })
  assert.equal(plan.showContext, false)
  /* BOTH HALVES PINNED. Asserting only one lets the pair collapse back into
     the single ambiguous fact that caused the defect: alias the derived field
     to the raw one and a test on the raw value alone still passes. */
  assert.equal(plan.filteredToNothing, true, 'the underlying selection fact should still be true')
  assert.equal(plan.contextFilteredToNothing, false, 'the gated fact leaked a half that is not on screen')
  assert.match(plan.emptyReason, /show runs only/,
    'the box reported the context filter as the cause while showing no context')
  assert.doesNotMatch(plan.emptyReason, /hidden by your chat settings/)
})

test('no agents are "held out by your choice" when the whole half is switched off', () => {
  store.set('mc.chat.runs', 'only')
  store.set('mc.chat.agents', JSON.stringify(['terra-01']))
  const plan = planNodeChatbox({ agent: AGENT, live: false, turns: TURNS, runs: RUNS, runsSupported: true })
  assert.equal(plan.hiddenAgents, 1, 'the raw selection fact is unchanged')
  assert.equal(plan.contextHiddenAgents, 0, 'the box blamed the agent filter while showing no conversation')
})

test('a hidden conversation is not reported as a missing channel', () => {
  /* The read-only frame fell back to "No channel to this agent." whenever the
     conversation was not on screen — a lie on a simulated node in runs-only,
     where the channel is fine and the person asked for runs. */
  store.set('mc.chat.runs', 'only')
  const plan = planNodeChatbox({ agent: AGENT, live: false, turns: TURNS, runs: RUNS, runsSupported: true })
  assert.equal(plan.channel.canSend, true)
  assert.equal(plan.composerReason, null)
  assert.match(plan.contextHiddenReason, /show runs only/)
})

test('a genuinely absent channel still says so, and claims no setting caused it', () => {
  const plan = planNodeChatbox({ agent: AGENT, live: true, turns: [], runs: [] })
  assert.equal(plan.channel.kind, 'none')
  assert.ok(plan.composerReason, 'a node with no channel must still say so')
  assert.equal(plan.contextHiddenReason, null,
    'a missing channel was blamed on a chat setting')
})

test('the four empty reasons are four distinct sentences', () => {
  const reasons = new Set()
  store.clear(); reasons.add(planNodeChatbox({ agent: AGENT, turns: [], runs: [] }).emptyReason)
  store.set('mc.chat.runs', 'only')
  reasons.add(planNodeChatbox({ agent: AGENT, turns: TURNS, runs: [] }).emptyReason)
  store.clear(); store.set('mc.chat.runs', 'hidden')
  reasons.add(planNodeChatbox({ agent: AGENT, turns: [], runs: RUNS }).emptyReason)
  store.clear(); store.set('mc.chat.agents', JSON.stringify(['nobody-here']))
  reasons.add(planNodeChatbox({ agent: AGENT, turns: TURNS, runs: [] }).emptyReason)
  assert.equal(reasons.size, 4, `collapsed to ${reasons.size} sentences: ${[...reasons].join(' | ')}`)
})

/* ---------------------------------------------------------------
   the rail is actually reachable — the defect that made this lane exist
   --------------------------------------------------------------- */

test('a single click on a node opens the rail, not only a double click', () => {
  /* The rail and its chat were fully built and the only gesture that opened
     them was dblclick. This is only a static backstop for the source of the
     fix; tools/page2-qa.cjs proves the behaviour against a real window with
     real pointer input, because source text cannot see reachability.

     THIS TEST WAS ITSELF A DEFECT ONCE, and the fix is worth keeping written
     down. It used to slice from `graph.indexOf('handleClick(record)')` — which
     matches the CALL SITE `this.handleClick(record)` in _wireNode first, ~300
     lines above the method. The slice therefore swept up _wireNode's dblclick
     handler, which legitimately contains the same onOpenControls call, so
     deleting the line from handleClick left the test green. A mutant caught it.
     The anchor is now the method DEFINITION at its own indentation, the body is
     bounded by its own closing brace, and both the anchor and the bound are
     asserted to exist so a future rename fails loudly instead of checking air. */
  const graph = readFileSync(path.join(ROOT, 'src/tree-graph.js'), 'utf8')
  const start = graph.indexOf('\n  handleClick(record) {')
  assert.notEqual(start, -1, 'handleClick method definition not found — this test is checking air')
  const end = graph.indexOf('\n  }', start)
  assert.notEqual(end, -1, 'handleClick body has no closing brace — this test is checking air')
  const body = graph.slice(start, end)
  assert.ok(!body.includes('dblclick'), 'the slice escaped handleClick — this test is checking air')
  assert.ok(body.includes('this.onOpenControls?.(record.agent)'),
    'a single click no longer opens the rail; the chatbox is undiscoverable again')
})

test('the live rail carries a chatbox rather than listing chat as unavailable', () => {
  const view = readFileSync(path.join(ROOT, 'src/views/computers.js'), 'utf8')
  const projection = view.slice(view.indexOf('function showProjectionControls'))
  assert.ok(projection.includes('board-chat-box'), 'the live rail has no chatbox')
  assert.ok(!/'chat', 'tuning'/.test(projection),
    'the live rail still reports chat and tuning as unavailable while rendering both')
})
