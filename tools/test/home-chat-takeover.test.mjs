/* The home page's full-page chat: the rules, not the pixels.
 *
 * Three of these pin an owner instruction directly, so they are written
 * against the sentence rather than against the implementation:
 *   - "not every subtree needs to be included just the main trees"
 *   - "ONLY 1 view at a time"
 *   - "replicate the page 2 chat surface" -- by REUSE, proven by mounting a
 *     real agent subject and observing the agent-session module run, not by
 *     comparing markup (copied markup would pass a markup test and still be
 *     the second renderer the rule forbids).
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  TAKEOVER_COPY,
  buildSubjectChoices,
  defaultSubjectId,
  subjectMatchesTurn,
  subjectMatchesRun,
  mountChatTakeover, coordinatorChatConfig } from '../../src/home-chat-takeover.js'

const MACHINES = [
  { id: 'c1', label: 'Studio' },
  { id: 'c2', label: 'Laptop' },
]

test('draft agents are selectable and saved runs do not duplicate their computer-qualified identity', () => {
  const choices = buildSubjectChoices({
    machines: MACHINES,
    nodesByComputer: new Map([
      ['c1', [{ id: 'worker', role: 'worker', displayName: 'Builder 1' }]],
      ['c2', [{ id: 'worker', role: 'worker', displayName: 'Builder 2' }]],
    ]),
    conversations: new Map([['session', { nodeId: 'worker', computerId: 'c1', role: 'worker' }]]),
  })
  const agents = choices.filter(choice => choice.kind === 'agent')
  assert.deepEqual(agents.map(choice => choice.id), ['agent:c1:worker', 'agent:c2:worker'])
  assert.ok(agents.every(choice => choice.treeNode))
  assert.match(agents[0].label, /Builder 1.*Studio/)
})

test('a saved tree agent uses the full shared workspace and disposes it when the subject changes', () => {
  const events = []
  const choices = [{ id: 'agent:c1:worker', kind: 'agent', agentId: 'worker', computerId: 'c1', savedConversation: true }, { id: 'everything', kind: 'everything' }]
  const surface = mountChatTakeover(fakeHost(), {
    choices, subjectId: choices[0].id, live: true,
    renderAgent: (_host, subject, drafts) => {
      events.push(subject.id)
      assert.equal(typeof drafts.readDraft, 'function')
      return () => events.push('disposed')
    },
    renderTranscript: () => { events.push('activity'); return () => {} },
  })
  surface.show('everything')
  assert.deepEqual(events, ['agent:c1:worker', 'disposed', 'activity'])
  surface.destroy()
})

test('run scopes use saved computer, tree, and agent identities, including colliding tree names', () => {
  const run = { sessionId: 'run-1' }
  const saved = { computerId: 'c1', treeId: 't1', nodeId: 'agent-a', displayName: 'Builder' }
  assert.equal(subjectMatchesRun({ kind: 'computer', computerId: 'c1' }, run, saved), true)
  assert.equal(subjectMatchesRun({ kind: 'computer', computerId: 'c2' }, run, saved), false)
  assert.equal(subjectMatchesRun({ kind: 'tree', computerId: 'c1', treeId: 't1' }, run, saved), true)
  assert.equal(subjectMatchesRun({ kind: 'tree', computerId: 'c2', treeId: 't1' }, run, saved), false)
  assert.equal(subjectMatchesRun({ kind: 'agent', agentId: 'agent-a' }, run, saved), true)
  assert.equal(subjectMatchesRun({ kind: 'agent', agentId: 'Builder' }, run, saved), false)
  assert.equal(subjectMatchesRun({ kind: 'computer', computerId: 'c1' }, run, null), false)
  assert.equal(subjectMatchesRun({ kind: 'everything' }, run, null), true)
})

test('selecting the already open subject does not dispose its surface or lose its state', () => {
  let mounts = 0, disposals = 0
  const surface = mountChatTakeover(fakeHost(), {
    choices: choicesFixture(), subjectId: 'everything',
    renderTranscript: () => { mounts += 1; return () => { disposals += 1 } },
  })
  surface.show('everything')
  assert.equal(mounts, 1)
  assert.equal(disposals, 0)
  surface.destroy()
  assert.equal(disposals, 1)
})
const SPEAKERS = { codex: { label: 'Codex' }, claude: { label: 'Claude' } }

test('a newly discovered agent can be selected without disposing the current view during a roster refresh', () => {
  let mounts = 0, disposals = 0
  const surface = mountChatTakeover(fakeHost(), {
    choices: choicesFixture(), subjectId: 'everything',
    renderTranscript: () => { mounts += 1; return () => { disposals += 1 } },
  })
  surface.updateChoices([...choicesFixture(), { id: 'agent:studio:new', kind: 'agent', agentId: 'new', savedConversation: true }])
  assert.equal(surface.subject.id, 'everything')
  assert.equal(mounts, 1)
  assert.equal(disposals, 0)
  surface.show('agent:studio:new')
  assert.equal(surface.subject.agentId, 'new')
  assert.equal(mounts, 2)
  assert.equal(disposals, 1)
  surface.destroy()
})

/* A store snapshot's shape: trees are the main trees, nodes are what the
   owner excluded. Both are present here so a regression that reads `nodes`
   has something wrong to find. */
const SNAPSHOT = {
  trees: [{ id: 't1', name: 'Release' }, { id: 't2', name: 'Support' }],
  nodes: [{ id: 'n1', treeId: 't1', name: 'a subtree node' }, { id: 'n2', treeId: 't1', name: 'another' }],
}

const choicesFixture = () => buildSubjectChoices({
  machines: MACHINES,
  speakers: SPEAKERS,
  treesByComputer: new Map([['c1', SNAPSHOT.trees]]),
})

test('the roster offers everything, the coordinator, computers, trees and agents', () => {
  const choices = choicesFixture()
  const kinds = choices.map((choice) => choice.kind)
  assert.equal(kinds[0], 'everything', 'everything is offered first')
  assert.equal(kinds[1], 'coordinator', 'the coordinator is offered second')
  for (const kind of ['computer', 'tree', 'agent']) {
    assert.ok(kinds.includes(kind), `the roster offers ${kind} subjects`)
  }
  assert.deepEqual(
    choices.filter((c) => c.kind === 'computer').map((c) => c.label),
    ['Studio', 'Laptop'],
    'every computer is offered, by its own label',
  )
  assert.deepEqual(
    choices.filter((c) => c.kind === 'agent').map((c) => c.agentId),
    ['codex', 'claude'],
    'every agent is offered',
  )
})

test('MAIN TREES ONLY -- a subtree node is never offered', () => {
  const choices = choicesFixture()
  const treeSubjects = choices.filter((choice) => choice.kind === 'tree')
  assert.deepEqual(treeSubjects.map((choice) => choice.treeId), ['t1', 't2'])
  for (const node of SNAPSHOT.nodes) {
    assert.ok(
      !choices.some((choice) => choice.treeId === node.id || choice.id.includes(node.id)),
      `the subtree node ${node.id} must not appear in the roster`,
    )
  }
})

test('a computer whose tree store could not be opened contributes no trees, and is still offered', () => {
  /* Absence of an entry means COULD NOT OPEN, not "has none" -- c2 has no
     entry here. It must still appear as a computer; only its trees are
     missing, and nothing claims it has none. */
  const choices = choicesFixture()
  assert.ok(choices.some((c) => c.kind === 'computer' && c.computerId === 'c2'))
  assert.ok(!choices.some((c) => c.kind === 'tree' && c.computerId === 'c2'))
})

test('the takeover opens on the coordinator', () => {
  assert.equal(defaultSubjectId(choicesFixture()), 'coordinator')
  assert.equal(defaultSubjectId([]), 'everything', 'an empty roster still names a subject')
})

test('whole-thread scopes never show less than the panel they grew out of', () => {
  const turn = { agentId: 'codex', computerId: 'c1', treeId: 't1' }
  for (const kind of ['everything', 'coordinator']) {
    assert.equal(subjectMatchesTurn({ kind }, turn), true)
    assert.equal(subjectMatchesTurn({ kind }, { agentId: 'other' }), true)
  }
})

test('a narrowed scope takes its own turns and no others', () => {
  const turn = { agentId: 'codex', computerId: 'c1', treeId: 't1' }
  assert.equal(subjectMatchesTurn({ kind: 'agent', agentId: 'codex' }, turn), true)
  assert.equal(subjectMatchesTurn({ kind: 'agent', agentId: 'claude' }, turn), false)
  assert.equal(subjectMatchesTurn({ kind: 'computer', computerId: 'c1' }, turn), true)
  assert.equal(subjectMatchesTurn({ kind: 'computer', computerId: 'c2' }, turn), false)
  assert.equal(subjectMatchesTurn({ kind: 'tree', treeId: 't1' }, turn), true)
  assert.equal(subjectMatchesTurn({ kind: 'tree', treeId: 't2' }, turn), false)
})

/* A host with just enough DOM surface for the mount contract. Deliberately
   not jsdom: what is under test is the disposal ORDER, which needs no layout. */
function fakeHost() {
  return { children: [], replaceChildren(...kids) { this.children = kids } }
}

test('ONLY 1 VIEW AT A TIME -- the previous surface is disposed before the next is built', () => {
  const events = []
  const painter = (host, subject) => {
    events.push(`mount:${subject.id}`)
    return () => events.push(`dispose:${subject.id}`)
  }
  /* Starts on 'everything', not 'coordinator': the coordinator subject now
     mounts the REAL chat surface (which needs a DOM this file deliberately
     lacks), and the property under test -- disposal order -- is the same for
     every painter-backed subject. The coordinator's own mount is covered by
     its dedicated tests below. */
  const surface = mountChatTakeover(fakeHost(), {
    choices: choicesFixture(),
    subjectId: 'everything',
    renderTranscript: painter,
  })
  surface.show('computer:c1')
  surface.show('tree:c1:t1')
  surface.destroy()

  assert.deepEqual(events, [
    'mount:everything',
    'dispose:everything', 'mount:computer:c1',
    'dispose:computer:c1', 'mount:tree:c1:t1',
    'dispose:tree:c1:t1',
  ], 'every switch disposes before it mounts, and destroy leaves nothing mounted')

  const mounted = events.filter((e) => e.startsWith('mount:')).length
  const disposed = events.filter((e) => e.startsWith('dispose:')).length
  assert.equal(mounted, disposed, 'no surface is ever left mounted')
})

test('a LIVE agent subject does NOT use the page-1 painter -- it reuses the page-2 surface', () => {
  /* The painter is the home page's own renderer. If a live agent subject ever
     reaches it, someone has written a second agent chat renderer, which is
     exactly what "replicate by reuse" forbids.
     SCOPED TO LIVE when the simulation fallback landed. The original pinned
     live:false -- written when "reuse the page-2 surface" was assumed to
     produce something. It does not: that surface's own fence answers "render
     nothing at all" off a real fleet, and the owner measured the result on the
     live site as two blank panels. The intent this test protects is unchanged
     -- the feed painter is not an agent CHAT renderer, it scopes the activity
     feed -- and the live case still refuses the painter absolutely. */
  /* THIS FILE HAS NO DOM ON PURPOSE (see fakeHost), and the live path mounts
     the REAL page-2 surface, which needs one. So the mount throwing
     ReferenceError out of agent-session.js is not noise here -- it is the
     EVIDENCE: control entered the page-2 module, not the painter. The painter
     count staying at zero is the other half of the same proof. */
  let painterCalls = 0
  let enteredPage2 = false
  try {
    mountChatTakeover(fakeHost(), {
      choices: choicesFixture(),
      subjectId: 'agent:codex',
      live: true,
      renderTranscript: () => { painterCalls += 1; return () => {} },
    })
  } catch (error) {
    enteredPage2 = String(error?.stack || '').includes('agent-session.js')
  }
  assert.equal(painterCalls, 0, 'a live agent subject is never painted by the home renderer')
  assert.equal(enteredPage2, true, 'and control demonstrably entered the page-2 surface module')
})

test('on the simulation an agent subject paints the FEED rather than nothing', () => {
  /* The complement of the test above, and the defect it pins was shipped and
     seen: the takeover's default subject is an agent, so a simulation visitor
     opened the full page onto two empty panels. Off a live fleet the agent
     surface deliberately renders nothing, so the takeover must hand the
     subject to the caller's painter -- a demonstration instead of a blank. */
  let painterCalls = 0
  const surface = mountChatTakeover(fakeHost(), {
    choices: choicesFixture(),
    subjectId: 'agent:codex',
    live: false,
    renderTranscript: () => { painterCalls += 1; return () => {} },
  })
  assert.equal(painterCalls, 1, 'the simulation paints the feed for an agent subject')
  assert.equal(surface.subject.kind, 'agent')
  surface.destroy()
})

test('an unknown subject id mounts nothing rather than guessing', () => {
  let painted = 0
  const surface = mountChatTakeover(fakeHost(), {
    choices: choicesFixture(),
    subjectId: 'everything',
    renderTranscript: () => { painted += 1; return () => {} },
  })
  surface.show('subject-that-does-not-exist')
  assert.equal(surface.subject, null, 'no subject is invented')
  assert.equal(painted, 1, 'nothing new was painted for the unknown id')
  surface.destroy()
})

test('the expand and collapse controls are named for what they do', () => {
  for (const key of ['expandLabel', 'collapseLabel', 'pickerLabel']) {
    assert.equal(typeof TAKEOVER_COPY[key], 'string')
    assert.ok(TAKEOVER_COPY[key].length > 0, `${key} carries a sentence`)
  }
})

test('on the simulation the coordinator subject mounts the REAL chat surface, not the feed', () => {
  /* The owner's question, verbatim: "the chat surface which is already built
     and finished - its not showing up yet is it? why not?" Because buildChat
     was mounted only by page 3. The takeover DEFAULTS to the coordinator, so
     the simulation must open onto the finished surface in its own labelled
     demonstration mode -- not the read-only feed, and never a blank. This
     file has no DOM, so entering components.js (which needs one) is itself
     the proof the real surface was taken, painter untouched. */
  let painterCalls = 0
  let enteredComponents = false
  try {
    mountChatTakeover(fakeHost(), {
      choices: choicesFixture(),
      subjectId: 'coordinator',
      live: false,
      renderTranscript: () => { painterCalls += 1; return () => {} },
    })
  } catch (error) {
    enteredComponents = String(error?.stack || '').includes('components.js')
  }
  assert.equal(painterCalls, 0, 'the coordinator no longer falls to the feed painter on the simulation')
  assert.equal(enteredComponents, true, 'control demonstrably entered the finished chat surface')
})

test('on a LIVE fleet the coordinator hands the page back to the real painter', () => {
  /* THIS TEST USED TO ASSERT THE OPPOSITE, AND IT WAS PINNING A DEFECT.
   *
   * It required painterCalls to stay at 0 on a live fleet, reasoning that no
   * live coordinator sender exists anywhere in the product, so the honest
   * surface was buildChat with an empty history and a disabled box.
   *
   * That premise was wrong about the product. On a configured fleet
   * describeHome already answers panel.kind "conversation" with context -- the
   * COLLAPSED panel on page one is a working coordinator surface. So expanding
   * it replaced a real conversation with an empty, disabled one reading "The
   * coordinator cannot be messaged yet": the door built to answer the owner's
   * "there is no chat on the first page" opened onto that very complaint.
   * Two independent verifiers reproduced it; the second drove the whole home
   * view in the repo's own Electron and pressed the real button.
   *
   * renderTranscript is paintSubject in views/home.js, which MOVES the real
   * panel -- its turns, its thread head, its audited composer -- into the
   * stage, exactly as the `everything` subject already did. */
  let painterCalls = 0
  let enteredComponents = false
  try {
    mountChatTakeover(fakeHost(), {
      choices: choicesFixture(),
      subjectId: 'coordinator',
      live: true,
      renderTranscript: () => { painterCalls += 1; return () => {} },
    })
  } catch (error) {
    enteredComponents = String(error?.stack || '').includes('components.js')
  }
  assert.equal(painterCalls, 1,
    'a live coordinator no longer reaches the painter the caller supplies, so expanding page one replaces the working conversation with something else')
  assert.equal(enteredComponents, false,
    'a live coordinator still built its own chat surface instead of handing the page the real panel')
})

test('the live coordinator config refuses the box, and the simulation config demonstrates', () => {
  /* DRIVEN WITH VALUES, because the previous version of this test could not
     fail: it asserted only that the mount reached components.js, which is true
     with or without a composerReason. A mutation proved it -- 14/14 both ways.
     This calls the decision directly and asserts what buildChat is HANDED. */
  const liveCfg = coordinatorChatConfig({ live: true, label: 'Coordinator' })
  assert.equal(typeof liveCfg.composerReason, 'string')
  assert.ok(liveCfg.composerReason.trim().length > 0,
    'a live copy refuses the box and says why -- there is no coordinator sender in the product')
  assert.ok(/open a computer/i.test(liveCfg.composerReason),
    'and the refusal carries a next step rather than dead-ending')
  assert.notEqual(liveCfg.sampleConversation, true,
    'a live copy must NEVER self-answer: that is the seeded simulator on real data')
  assert.equal(liveCfg.seed, 0)
  assert.deepEqual(liveCfg.history, [],
    'seed 0 and an empty history, or buildChat paints canned bubbles as a conversation')

  const demoCfg = coordinatorChatConfig({ live: false, label: 'Coordinator' })
  assert.equal(demoCfg.sampleConversation, true,
    'the simulation takes the one sanctioned self-answering path')
  assert.equal(demoCfg.composerReason, undefined,
    'and is not refused, or the demonstration cannot demonstrate')

  assert.equal(coordinatorChatConfig({ live: true }).title, 'Coordinator',
    'a missing label still names the subject rather than rendering empty')
})

test('the chips gate is open, but no accessor is invented for state this function does not have', () => {
  /* "the home composer structurally can't grow chips today" (the gap that
     opened this) meant buildChat's own `${chips ? ...}` gate (components.js)
     never saw a truthy value from here at all. This pins that it now does --
     but coordinatorChatConfig is a pure function of {live, label}, with no
     session, tier, model override or outbox anywhere in its scope, so every
     accessor beyond the row's own gate must stay genuinely absent rather
     than a fabricated one. Real accessors or absent chips, never a chip that
     LOOKS wired but answers nothing true. */
  for (const live of [true, false]) {
    const cfg = coordinatorChatConfig({ live, label: 'Coordinator' })
    assert.ok(cfg.chips && typeof cfg.chips === 'object',
      `chips is missing on the ${live ? 'live' : 'simulation'} config -- the composer can never grow chips again`)
    assert.equal(typeof cfg.chips.tier, 'undefined',
      'a tier accessor exists with nothing real behind it -- this function has no confinement state to read')
    assert.equal(typeof cfg.chips.model, 'undefined',
      'a model accessor exists with nothing real behind it -- this function has no session/model-override state to read')
    assert.equal(typeof cfg.chips.onOpenEffort, 'undefined',
      'an effort press handler exists with nothing real behind it -- there is no effort-switching mechanism here')
  }
})
