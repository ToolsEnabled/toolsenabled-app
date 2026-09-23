import { webcrypto } from 'node:crypto'
/* THE CONVERSATION A TREE NODE SHOWS, AND THE WAYS IT USED TO LOSE ONE.
 *
 * Owner, on tonight's preview build: "Sometimes the messages in history
 * disappear or combine into each other."
 *
 * WHAT THIS FILE CAN AND CANNOT MEASURE, said plainly. src/views/computers.js
 * imports three stylesheets and reaches echarts, a canvas and a ResizeObserver
 * at module load, so a plain Node process cannot import it at all -- the same
 * measurement tools/two-tree-render-qa.mjs's header records. The parts that
 * ARE importable are tested as behaviour below; the rest is pinned at the
 * source level, the way tools/test/tree-drag-contract.test.mjs pins the drag
 * rules, and the runtime proof is the packaged driver named at the bottom.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { parseAst } from 'rollup/parseAst'
import { createTranscriptStore } from '../../src/session-transcript-store.js'

import { sessionEventTurnId, sessionMessageBoundary } from '../../src/agent-session-events.js'
import { describeRun } from '../../src/local-activity.js'
import { openMemory, ownDisclosure } from '../../src/components.js'

const here = fileURLToPath(import.meta.url)
const SRC = join(dirname(dirname(dirname(here))), 'src')
const view = readFileSync(join(SRC, 'views', 'computers.js'), 'utf8')
const components = readFileSync(join(SRC, 'components.js'), 'utf8')
/* The words this view hands the chat live in the copy module, where the
   plain-language gate can hold them; the assertions about the closed line read
   them from there rather than from the view. */
const copy = readFileSync(join(SRC, 'fleet-tree-copy.js'), 'utf8')

function sessionOpenBeforeRefresh() {
  // Additional receipt fields must not hide this callback from the test.
  // Its responsibility is transcript persistence, not a fixed parameter list.
  const at = view.indexOf('async function startDraftNodeUnguarded(')
  assert.ok(at >= 0, 'the actual session handoff must exist')
  const handoff = view.slice(at)
  const header = /onSessionOpen:\s*\(\{[^}]*\}\)\s*=>\s*\{/.exec(handoff)
  assert.ok(header, 'the actual session-open callback must exist')
  const body = handoff.slice(header.index + header[0].length)
  const refresh = body.indexOf('refreshTree()')
  assert.ok(refresh >= 0, 'the session-open callback must refresh the tree')
  return body.slice(0, refresh)
}

/* ---------------------------------------------------------------
   A. The first thing said is recorded like every other thing said.
   --------------------------------------------------------------- */

test('the brief a person types is persisted by the actual opening callback, including after the view closes', () => {
  const functions = new Map()
  const collect = node => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'FunctionDeclaration') functions.set(node.id.name, node)
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(collect)
      else if (value && typeof value === 'object') collect(value)
    }
  }
  collect(parseAst(view))
  const start = functions.get('startDraftNodeUnguarded')
  assert.ok(start, 'the actual draft start must exist')
  const callbacks = []
  const findOpen = node => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'Property' && node.key.name === 'onSessionOpen') callbacks.push(node.value)
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(findOpen)
      else if (value && typeof value === 'object') findOpen(value)
    }
  }
  findOpen(start)
  assert.equal(callbacks.length, 1, 'measure exactly the real start callback')
  for (const destroyed of [false, true]) {
    let saved = null, writes = 0, attached = false
    const storage = { read: () => saved, write: (_key, value) => { writes++; saved = JSON.parse(JSON.stringify(value)); return true } }
    const transcripts = createTranscriptStore({ computerId: 'opening-brief', storage })
    const node = { id: 'opening-node', tier: 'fixture' }
    const draft = { message: 'Keep my exact opening question.', tier: node.tier, effort: 'high' }
    const store = {
      getNode: id => id === node.id ? node : null,
      attachSession: () => { attached = true; return { ok: true } },
      setNodeStatus: () => {},
    }
    const context = vm.createContext({
      crypto: webcrypto,
      Date, Array, sessionNodeIds: new Map(), sessionEfforts: new Map(), sessionThreadIds: new Map(),
      sessionAccountNames: new Map(), sessionTranscripts: new Map(), TRANSCRIPT_MAX_ENTRIES: 100,
      transcriptStore: destroyed ? null : transcripts, treeStore: destroyed ? null : store,
      startTranscripts: transcripts, store, node, draft, destroyed, attachProblem: null,
      briefContext: {}, nodeManagerContext: () => 'Separate tree context.',
      editorCopy: { ok: true, receipt: null }, standaloneSettledTurns: new Map(),
      capturedProfileId: null, LAUNCH_TIERS: [{ id: node.tier, provider: 'codex' }],
      tierEffortOf: () => 'high', readEngineCatalog: () => {}, rememberBoundSessionProfile: () => {},
      refreshTree: () => { assert.ok(transcripts.get(node.id), 'the brief must be saved before refresh') },
      rebindRailToSession: () => {},
    })
    for (const name of ['transcriptAppend', 'persistTranscript']) {
      const actual = functions.get(name)
      assert.ok(actual, `${name} must use production behavior`)
      vm.runInContext(view.slice(actual.start, actual.end), context)
    }
    const callback = vm.runInContext(`(${view.slice(callbacks[0].start, callbacks[0].end)})`, context)
    callback({ sessionId: 'opening-session', threadId: 'opening-thread', account: 'fixture-account', roleIntroduction: 'Separate role context.' })
    assert.equal(attached, true)
    assert.equal(writes, 1, 'opening lines must be saved in one complete batch')
    const reopened = createTranscriptStore({ computerId: 'opening-brief', storage }).get(node.id)
    assert.ok(reopened, 'a new store must read the saved opening record')
    assert.deepEqual(reopened.lines.map(line => line.text), [draft.message, 'Separate tree context.', 'Separate role context.'])
    assert.equal(reopened.threadId, 'opening-thread')
    assert.equal(reopened.account, 'fixture-account')
  }
})

test('what the product added about the tree is recorded too, and separately', () => {
  const body = sessionOpenBeforeRefresh()
  assert.match(
    body,
    /transcriptAppend\(sessionId, \{ who: 'you', text: nodeManagerContext\(briefContext\)/,
    'the tree context is sent to the agent and not shown; this page does not send what it will not show',
  )
  assert.ok(
    body.indexOf('text: draft.message') < body.indexOf('nodeManagerContext(briefContext)'),
    'the context is recorded before the person own words',
  )
})

test('the tree context is drawn as the tree words, not as a second dark YOU bubble', () => {
  /* The address block is recorded who:'you' — the side it was sent from — and
     both surfaces therefore painted it as three hundred pixels of plumbing in
     the person's own colour, the loudest thing in the conversation (measured
     on a staged packaged build, 2026-08-20). It is recognised at draw time by
     the SAME contract shell/agent-host.cjs reads the address back out of
     (readTreeAddress), never by guessing at prose, and the record itself is
     untouched. */
  assert.match(view, /function markTreeContext/, 'nothing renames the tree context at draw time')
  assert.match(view, /readTreeAddress\(entry\.text\)/, 'the context is recognised by something other than the address contract')
  assert.match(view, /mergeActionsIntoHistory\(markTreeContext\(history/, 'the chat config draws the raw history, so the context wears YOU again')
  assert.match(components, /entry\.who === 'context'/, 'buildChat does not know the context entry; it would fall through as a them-bubble')
})

test('the tree context is folded shut, and the closed line earns the press', () => {
  /* Quiet was only half of it. MEASURED on a staged packaged build: the aside
     still drew 298px in a 371px log, so a first-timer's first screen of their
     first conversation was internal plumbing. Folding it is not truncating it
     -- the entry stays whole inside -- but a fold whose label says nothing is
     one nobody opens, so the closed line has to say WHAT is behind it and HOW
     MUCH, in the person's own words. */
  assert.match(components, /const addContext = /, 'the context is drawn as a plain bubble again, so it is a wall of text on open')
  const draw = components.slice(components.indexOf('const addContext = '), components.indexOf('/* ---- THE SECOND DOOR'))
  assert.match(draw, /createElement\('details'\)/, 'the aside is not a disclosure; there is nothing to press')
  assert.ok(!/wrap\.open = true/.test(draw), 'the aside is forced open, which is the defect this closes')
  assert.match(draw, /entry\.summary/, 'the closed line carries no sentence, so the fold is a mystery box')
  /* THE SIZE IS THE HALF THAT EARNS THE PRESS, and it is the caller's word. */
  assert.match(view, /treeContextSummary\(context\)/, 'nothing composes the closed line from the entry it is folding')
  assert.match(copy, /export function treeContextSummary/, 'the closed line has no copy of its own')
  assert.match(copy, /\$\{words\} words/, 'the closed line does not say how much is behind it')

  /* PER CONVERSATION, NEVER GLOBALLY. Somebody who opens this wants it open for
     the thread they are reading. A shared default is the thing being avoided. */
  assert.match(view, /openKey: typeof sessionId === 'string'/, 'the open state is not keyed to a conversation')
  assert.match(draw, /entry\.openKey/, 'the component ignores the key, so the memory is global')
  assert.match(draw, /contextOpen\.remember\(key, wrap\.open\)/, 'opening it is forgotten the moment the panel rebuilds')
  assert.match(draw, /wrap\.open = contextOpen\.recall\(key\) === 'open'/, 'the remembered state is not read back on rebuild')
  /* THE MEMORY IS THE SHARED ONE, not a private copy. Exercise its public
     contract rather than requiring a particular function body. */
  assert.match(components, /const contextOpen = openMemory\('mc\.chat\.context-open:'\)/, 'the context fold stopped using the shared memory, or changed its key')
  const priorStorage = globalThis.localStorage
  const values = new Map()
  globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  }
  try {
    const memory = openMemory('mc.chat.context-open:')
    assert.equal(memory.recall('thread-1'), null, 'recall must answer null until this conversation has a remembered choice')
    memory.remember('thread-1', true)
    assert.equal(memory.recall('thread-1'), 'open', 'remembering an open fold must be observable on its next recall')
    memory.remember('thread-1', false)
    assert.equal(memory.recall('thread-1'), 'closed', 'remembering a closed fold must be observable on its next recall')
    globalThis.localStorage = { getItem() { throw new Error('private storage') }, setItem() { throw new Error('private storage') } }
    assert.equal(memory.recall('thread-2'), null, 'a storage refusal must leave the fold usable with no remembered choice')
    assert.doesNotThrow(() => memory.remember('thread-2', true), 'a storage refusal must not stop a person toggling the fold')
  } finally {
    if (priorStorage === undefined) delete globalThis.localStorage
    else globalThis.localStorage = priorStorage
  }
  /* THE OWNED PRESS, SHARED TOO, with the one narrowing the run rows need: a
     press inside the open body (selecting text, following the door) is left
     alone; a press on the summary, or whose target is the details itself (the
     elementFromPoint case on a collapsed row), toggles. */
  let click
  const details = { open: false, addEventListener: (type, listener) => { if (type === 'click') click = listener } }
  const summary = { contains: target => target === summary }
  const body = {}
  const toggles = []
  ownDisclosure(details, { within: summary, onToggle: open => toggles.push(open) })
  let prevented = false
  click({ target: summary, preventDefault: () => { prevented = true } })
  assert.equal(prevented, true, 'a summary press must cancel the native toggle before applying the owned toggle')
  assert.equal(details.open, true, 'a summary press must open a closed disclosure exactly once')
  click({ target: body, preventDefault: () => assert.fail('a press in the open body must retain its native action') })
  assert.equal(details.open, true, 'a press inside the open body must not fold the disclosure')
  click({ target: details, preventDefault() {} })
  assert.equal(details.open, false, 'a press resolved to the details row must toggle the disclosure')
  assert.deepEqual(toggles, [true, false], 'the toggle callback must report only owned disclosure changes')
})

test('the manager named in the brief is the name on the circle', () => {
  /* MEASURED, not guessed: on a staged build with a real Codex session, a child
     under a circle drawn "Manager" was told its manager was "Agent", and it
     said so back. composeParentFor() hands over `{ id, name }` -- a projection
     whose name has ALREADY been through treeNodeName -- and re-running
     treeNodeName over it finds no `role`, so roleLabel returns its generic
     word. The parent's name must be read off the projection, never recomputed
     from it. */
  const helper = view.slice(view.indexOf('function briefContextFor'), view.indexOf('function briefContextFor') + 1400)
  assert.match(helper, /parentName: parent \? \(parent\.name \|\| null\) : null/, 'the parent name is recomputed from a projection that has no role; the brief will name a generic label')
  assert.match(helper, /selfName: treeNodeName\(node\)/, 'the node is a real store record and must keep its computed name')
  /* And the projection it reads really does carry one. */
  const projection = view.slice(view.indexOf('function composeParentFor'), view.indexOf('function composeParentFor') + 400)
  assert.match(projection, /name: treeNodeName\(node\)/, 'composeParentFor stopped carrying a name, so the brief has nothing true to read')
})

test('the durable half is written from the same lines, so a resume carries the brief', () => {
  const append = view.slice(view.indexOf('function transcriptAppend'), view.indexOf('function persistTranscript'))
  assert.match(append, /persistTranscript\(sessionId\)/, 'appends no longer reach the durable excerpt')
})

test('and the durable half is READ BACK, so a restart shows the conversation rather than rebuilding one', () => {
  /* THE MEASUREMENT THIS PINS. On a staged packaged build, a node holding five
     recorded lines drew TWO bubbles after the app was restarted -- the first
     question above the second answer -- on both the rail chat and the compact
     card. `sessionTranscripts` is window memory; a new window has none; so the
     `!history.length` fallback composed node.message with node.reply and
     produced a conversation that never happened.
     This asserts the store is consulted BEFORE that fallback, and that the
     fallback is still there for a node whose conversation was never recorded. */
  const config = view.slice(view.indexOf('function treeChatConfigFor'), view.indexOf('function treeChatConfigFor') + 6400)
  const live = config.indexOf('sessionTranscripts.get(node.sessionId)')
  const stored = config.indexOf('transcriptStore.get(node.id)')
  const fallback = config.indexOf('nodeReplies.get(node.id) || node.reply', live)
  assert.ok(live > -1, 'the live map read is gone; this test is pinned to the wrong function')
  assert.ok(stored > -1, 'a session with no window memory never reads the durable record, so a restart rebuilds the conversation from the brief and the latest reply')
  assert.ok(stored > live, 'the durable record must be the fallback for an empty window, not the first source')
  assert.ok(fallback > stored, 'the brief-plus-latest-reply fallback must come AFTER the record, or it will keep standing in for one that exists')
})

/* ---------------------------------------------------------------
   B. Where one turn ends and the next begins.
   --------------------------------------------------------------- */

test('a packet names its turn, or names nothing', () => {
  const id = 'turn-7f3a'
  assert.equal(sessionEventTurnId({ sessionId: 's1', event: { type: 'assistant_text_delta', turnId: id } }, 's1'), id)
  assert.equal(sessionEventTurnId({ sessionId: 's2', event: { turnId: id } }, 's1'), null)
  assert.equal(sessionEventTurnId({ sessionId: 's1', event: { type: 'assistant_text_delta' } }, 's1'), null)
  assert.equal(sessionEventTurnId({ sessionId: 's1', event: { turnId: 7 } }, 's1'), null)
  assert.equal(sessionEventTurnId({ sessionId: 's1', event: { turnId: '' } }, 's1'), null)
  assert.equal(sessionEventTurnId({ sessionId: 's1', event: { turnId: 'x'.repeat(513) } }, 's1'), null)
  assert.equal(sessionEventTurnId(null, 's1'), null)
})

test('a delta naming a new turn settles the old one before it adds a word', () => {
  /* The accumulator and the open bubble were released ONLY by turn_completed.
     A turn that ended any other way left both standing, and the next turn's
     first delta appended to the last turn's answer inside the same bubble --
     "combine into each other". */
  const delta = view.slice(view.indexOf('const text = sessionEventText(packet, sessionId)'))
  const settleAt = delta.indexOf('settleTurnBoundary(sessionId, sessionEventTurnId(packet, sessionId))')
  const accumulateAt = delta.indexOf("sessionTurnText.set(sessionId, (sessionTurnText.get(sessionId) || '') + text)")
  assert.ok(settleAt !== -1, 'the delta branch no longer settles the turn boundary')
  assert.ok(settleAt < accumulateAt, 'the boundary is settled after the new words are added, which merges them')

  const settle = view.slice(view.indexOf('function settleTurnBoundary'), view.indexOf('function transcriptAppend'))
  assert.match(settle, /if \(!open \|\| open === turnId\) return/, 'the settler no longer distinguishes a new turn from the open one')
  assert.match(settle, /sessionTurnText\.delete\(sessionId\)/, 'the accumulator survives a turn boundary; the next turn inherits these words')
  assert.match(settle, /transcriptAppend\(sessionId, \{ who: 'agent'/, 'an unfinished turn words are dropped instead of recorded')
  assert.match(settle, /railChat\.stream\.close/, 'the previous turn bubble is never ended, so the next turn repaints it')
})

test('a completed turn clears the open-turn mark, so the next delta opens a fresh bubble', () => {
  /* SLICED BY STRUCTURE, NOT BY BYTE COUNT: a note added above the needle used
     to push it out of a fixed 900-character window, and the test then reported
     a live behaviour as missing. */
  const completion = view.slice(view.indexOf('const status = sessionTurnStatus(packet, sessionId)'))
  const branch = completion.slice(0, completion.indexOf('nodeActivity.delete(nodeId)'))
  assert.match(branch, /sessionOpenTurns\.delete\(sessionId\)/, 'the open-turn mark outlives the turn')
})

/* ---------------------------------------------------------------
   C. Every surface waiting on a turn is answered.
   --------------------------------------------------------------- */

test('the reply wrapper answers its own chat, never whichever one is mounted now', () => {
  /* The wrapper read the live `railChat` variable, which is reassigned on
     every rail rebuild -- so a reply arriving after a rebuild closed a
     DIFFERENT node's bubble with this node's words. */
  const mount = view.slice(view.indexOf("const chatHost = controlsPage.querySelector('[data-rail-chat-host]')"))
  const block = mount.slice(0, mount.indexOf('railChat = mine') + 40)
  assert.match(block, /const mine = \{ sessionId: node\.sessionId/, 'the rail chat is no longer captured before the chat is built')
  assert.match(block, /if \(railChat === mine && mine\.stream\)/, 'the wrapper reads the live railChat again; a reply can land in another node chat')
})

/* ---------------------------------------------------------------
   D. Never innerHTML over a mounted chat.
   --------------------------------------------------------------- */

test('every rail rebuild disposes the mounted chat first', () => {
  /* The rule is stated where railChat is declared and only one of the four
     rebuild sites obeyed it. After the others, railChat survived pointing at a
     detached root whose sessionId still matched, so every delta was pushed
     into a chat log that was not in the document. */
  let from = 0
  let sites = 0
  for (;;) {
    const at = view.indexOf('controlsPage.innerHTML', from)
    if (at === -1) break
    sites += 1
    const before = view.slice(Math.max(0, at - 1400), at)
    assert.ok(
      before.includes('disposeRailChat()'),
      `a controlsPage rebuild at offset ${at} wipes the rail without disposing the chat mounted in it`,
    )
    from = at + 1
  }
  /* Three sites: showTreeNodeControls, showProjectionControls, and
     showProjectionUnavailable's wipe. This floor was four when the example
     seat had a rail of its own (showExampleAgentControls); the approved
     mock-data architecture removed it -- the simulation drives the SAME tree
     rail through the sample tree store now, so its rebuilds are the first
     site's rebuilds and there is no fourth body to check. The floor exists so
     a NEW rebuild site cannot appear unchecked; if it reads high, count the
     controlsPage.innerHTML sites before touching it. */
  assert.ok(sites >= 3, `expected every rail rebuild to be checked; found ${sites}`)
})

test('the settings-driven chat box disposes before it re-renders', () => {
  const mount = view.slice(view.indexOf('function mountRailChat'))
  const render = mount.slice(0, 4000)
  assert.match(render, /mounted\?\.dispose\?\.\(\)/, 'a chatbox setting change drops a mounted chat on the floor')
})

/* ---------------------------------------------------------------
   E. Neither surface may fall through to the demonstration excerpt.
   --------------------------------------------------------------- */

test('the shared chat config pins seed 0, so no surface can fabricate a conversation', () => {
  /* buildChat's rule: `history.length ? [] : CHAT.slice(start, start + seed)`,
     with seed defaulting to 3. The card pinned 0 and the rail did not, so the
     rail rendered three canned bubbles over any empty transcript and dropped
     them on the next rebuild: messages that appear, then disappear. */
  assert.match(components, /const seeded = Array\.isArray\(history\) && history\.length \? \[\] : CHAT\.slice/, 'the seeding rule moved; re-derive this guard')
  /* BOUNDED AT treeChatConfigFor's OWN CLOSE, 2026-08-28, not at the next
     function after it. The old boundary (function chatActionRowsFor) swept in
     everything textually between the two -- including mountRailChat, which is
     no comment's business here -- and broke the moment mountRailChat gained a
     third seed: 0 of its own (B3's chat-readonly-fork replacement, also
     seed: 0, for the identical reason: an empty transcript must never fall
     through to the demonstration bubbles). This test is about treeChatConfigFor
     specifically, per its own name and the comment above; scoping the slice to
     what it actually says it checks is the fix, not widening the count to
     absorb whatever else the old boundary happened to catch. */
  const configFn = view.slice(view.indexOf('function treeChatConfigFor'), view.indexOf('/* The chip repaints once per frame'))
  const seeds = configFn.match(/^ +seed: 0,$/gm) || []
  assert.equal(seeds.length, 2, 'both of treeChatConfigFor returns must pin seed 0; one of them can fabricate history')
})

/* ---------------------------------------------------------------
   F. Recovery deletes a transcript only when it is really the same line.
   --------------------------------------------------------------- */

test('the dead-session recovery matches the whole line, not a prefix of it', () => {
  /* `tail.text === text.slice(0, tail.text.length)` matched any shorter
     earlier "you" line that happened to start the same way, and the branch it
     guards deletes the node's entire saved conversation. */
  assert.ok(
    !/tail\.text === text\.slice\(0, tail\.text\.length\)/.test(view),
    'the loose prefix match is back; typing a short line that starts an earlier one erases the saved conversation',
  )
  const recovery = view.slice(view.indexOf('const durable = transcriptStore ? transcriptStore.get(node.id) : null'))
  const block = recovery.slice(0, recovery.indexOf('const seeded ='))
  assert.match(block, /tail\.text\.length === TRANSCRIPT_LIMITS\.maxLineChars/, 'the only legitimate prefix -- a line the store truncated -- is no longer the only one admitted')
  assert.match(block, /tail\.text === text \|\| wasTruncated/, 'the whole-line comparison is gone')
})

/* ---------------------------------------------------------------
   G. Two messages in one turn are two paragraphs, not one word.
   --------------------------------------------------------------- */

test('a message boundary is read off the wire, and only from the events that mark one', () => {
  /* Owner, off the home card: "Said back: ...now.I couldn't". Words arrive as
     deltas and were joined bare; the engine marks where a message ends. */
  for (const type of ['assistant_text', 'tool_call', 'tool_result', 'approval_request']) {
    assert.equal(sessionMessageBoundary({ sessionId: 's1', event: { type } }, 's1'), true, `${type} marks a message end`)
  }
  /* codex emits usage mid-message; a break there would split a sentence. */
  assert.equal(sessionMessageBoundary({ sessionId: 's1', event: { type: 'usage' } }, 's1'), false)
  assert.equal(sessionMessageBoundary({ sessionId: 's1', event: { type: 'assistant_text_delta', text: 'x' } }, 's1'), false)
  /* The turn ending is the bigger seam and already owned by sessionTurnStatus. */
  assert.equal(sessionMessageBoundary({ sessionId: 's1', event: { type: 'turn_completed' } }, 's1'), false)
  /* Exact session, exact shape, false for everything else. */
  assert.equal(sessionMessageBoundary({ sessionId: 's2', event: { type: 'assistant_text' } }, 's1'), false)
  assert.equal(sessionMessageBoundary({ sessionId: 's1', event: null }, 's1'), false)
  assert.equal(sessionMessageBoundary(null, 's1'), false)
})

test('the tree accumulator writes a paragraph break between two messages of one turn', () => {
  const delta = view.slice(view.indexOf('const text = sessionEventText(packet, sessionId)'))
  const settleAt = delta.indexOf('settleTurnBoundary(sessionId, sessionEventTurnId(packet, sessionId))')
  const breakAt = delta.indexOf("sessionTurnText.set(sessionId, sessionTurnText.get(sessionId) + '\\n\\n')")
  const accumulateAt = delta.indexOf("sessionTurnText.set(sessionId, (sessionTurnText.get(sessionId) || '') + text)")
  assert.ok(breakAt !== -1, 'the accumulator no longer writes the break; two messages join as one word')
  assert.ok(settleAt < breakAt && breakAt < accumulateAt, 'the break must land after the turn settles and before the new words')
  assert.match(delta.slice(0, accumulateAt), /if \(sessionBreakPending\.delete\(sessionId\) && sessionTurnText\.get\(sessionId\)\)/, 'the break is written without a message having ended, or onto an empty accumulator')
  /* The flag is raised where the boundary is read, beside the usage event, so
     a boundary packet that carries no text still marks the seam. */
  const markAt = delta.indexOf('if (sessionMessageBoundary(packet, sessionId)) sessionBreakPending.add(sessionId)')
  const usedAt = delta.indexOf('const used = sessionUsageEvent(packet, sessionId)')
  assert.ok(markAt !== -1, 'the tree ear no longer reads message boundaries')
  assert.ok(markAt < usedAt, 'the boundary must be marked before the usage branch returns')
  /* And the home card's live row does the same, through the same reader. */
  const home = readFileSync(join(SRC, 'views', 'home.js'), 'utf8')
  const ear = home.slice(home.indexOf('const onAgentPacket'), home.indexOf('const detachAgentEvents'))
  assert.match(ear, /const boundary = sessionMessageBoundary\(packet, sessionId\)/)
  assert.match(ear, /if \(live\.text && live\.breakPending\) live\.text \+= '\\n\\n'/, 'the home row joins two messages bare again')
  assert.match(ear, /if \(boundary\) \{\s*\n\s*live\.breakPending = true/, 'the boundary is read but never remembered')
  /* And the single-agent page's composer, which has one accumulator for its
     one session: the same reader, the same rule, the same shape as the home
     row. It was the third accumulator and the one left joining bare. */
  const agent = readFileSync(join(SRC, 'views', 'agent.js'), 'utf8')
  const composer = agent.slice(agent.indexOf('const detachAgentEvents'), agent.indexOf('const startOrContinue'))
  assert.ok(composer.length > 0, 'the agent page listener is where this test expects it')
  assert.match(composer, /if \(chatTurnText && chatBreakPending\) chatTurnText \+= '\\n\\n'/, 'the agent page joins two messages bare again')
  const agentMarkAt = composer.indexOf('if (sessionMessageBoundary(packet, chatSessionId)) chatBreakPending = true')
  const agentCompletionAt = composer.indexOf('if (!sessionTurnStatus(packet, chatSessionId)) return')
  assert.ok(agentMarkAt !== -1, 'the agent page no longer reads message boundaries')
  assert.ok(agentMarkAt < agentCompletionAt, 'the boundary must be marked before the completion check returns')
  /* A flag left over from one turn must not write a break at the head of the
     next: it is cleared where the turn is handed over and where a new one is sent. */
  assert.match(composer, /chatTurnText = ''\s*\n\s*chatBreakPending = false\s*\n\s*chatReply = null/, 'the completion hands the turn over without clearing the break flag')
  const sender = agent.slice(agent.indexOf('const startOrContinue'), agent.indexOf('// chat panel'))
  assert.match(sender, /chatTurnText = ''\s*\n\s*chatBreakPending = false/, 'a new message starts with a break still owed from the last one')
})

test('the joined words read as two sentences on the one-line row and as two paragraphs in the body', () => {
  /* The accumulator rule, simulated exactly as both ears apply it: a break is
     owed after a boundary and spent on the next word, never on an empty
     accumulator and never at the end of a turn. */
  const join = (events) => {
    let text = ''
    let breakPending = false
    for (const event of events) {
      if (event.text !== undefined) {
        if (text && breakPending) text += '\n\n'
        breakPending = false
        text += event.text
      }
      if (event.boundary) breakPending = true
    }
    return text
  }
  const spoken = join([{ text: 'I checked the file' }, { text: ' just now.' }, { boundary: true }, { text: "I couldn't" }, { text: ' open it.' }])
  assert.equal(spoken, "I checked the file just now.\n\nI couldn't open it.")
  /* The home row clips to one line and the break becomes one space. */
  const row = describeRun({ sequence: 1, atMs: 0, result: 'started', reason: null, sessionId: 's1' }, null, 1000, { live: { text: spoken, working: true } })
  assert.equal(row.said, "I checked the file just now. I couldn't open it.")
  /* Tokens of ONE message are not split: no boundary, no break. */
  assert.equal(join([{ text: 'now.' }, { text: ' I' }]), 'now. I')
  /* A boundary before any words writes nothing, and a trailing one is dropped. */
  assert.equal(join([{ boundary: true }, { text: 'Hello.' }, { boundary: true }]), 'Hello.')
})

/* THE RUNTIME PROOF is tools/tree-chat-transcript-drive.mjs: a staged packaged
   build, a real agent, two consecutive turns, and both surfaces read. Nothing
   above can observe a bubble; that driver can, and it is the discriminating
   check this area never had. */
