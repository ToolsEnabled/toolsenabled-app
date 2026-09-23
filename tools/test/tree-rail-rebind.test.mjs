/* A RAIL OPENED BEFORE THE START LANDS MUST STILL FIND THE SESSION.
 *
 * THE DEFECT, traced 2026-09-04 while answering "one agent sometimes cannot
 * spawn another". Press a circle, then open its rail while the asynchronous
 * start is still completing. showTreeNodeControls builds the whole panel from
 * the node as it stands at that instant -- sessionId null -- so
 * treeChatConfigFor takes its session-less branch: a READ-ONLY chat carrying
 * composerReason, with no onSend and no onReady, therefore no
 * registerChatSurface; and the mount records `railChat.sessionId = null`.
 *
 * When the start then lands, startDraftNode's onSessionOpen attaches the real
 * session, marks the node running and refreshes the canvas -- and nothing
 * remounts that rail. The panel in front of the person stays bound to a
 * session that does not exist. The agent's reply arrives, is appended to the
 * transcript and persisted, and every door on its way to the open chat misses
 * it: `railChat.sessionId === sessionId` is false, chatSurfaces has no entry
 * under the new id, and the composer is still disabled -- so the person cannot
 * send the follow-up ("now spawn a worker") without leaving the node and
 * coming back.
 *
 * WHAT THE FIRST ROUND OF THIS FILE GOT WRONG, and why the invariant below is
 * shaped the way it is. It pinned three attach sites inside ONE function
 * (startDraftNode) while calling itself the rule for "every place a start
 * attaches a session to the node". It was not: resumeNodeSessionUnguarded
 * already attached a session in two more places, and one of them -- the resume
 * whose session is reported ENDED before it returns -- attached and then
 * returned false straight past the function's own remount tail, leaving
 * exactly the stale panel this file exists to end. A restart asked for by the
 * assistant above the circle (runTreeNodeCommand's fresh-start branch, the
 * agent.restart tool's landing site) attached a replacement session through
 * src/fresh-start-existing-node.js and reconciled nothing at all, while the
 * person's own Clear row beside it always had. So the invariant no longer
 * slices one blessed function: it finds EVERY attach in the view, and every
 * call into the module that attaches for it, and asks whether control can
 * leave without reconciling the rail.
 *
 * WHAT IS HELD HERE. The rule itself is a real module, driven with values:
 * src/tree-rail-rebind.js decides when an open rail is stale, including the
 * cases where a rebuild would be the WRONG answer (a rail on another node, a
 * rail already mounted on this very session -- a needless rebuild disposes the
 * chat and closes an open actions popup, which is the defect
 * tools/test/rail-status-repaint.test.mjs exists to keep shut). The view is a
 * 10,000-line closure over a live DOM and cannot be imported by a test
 * process, so its half is pinned by source slice, the same proof shape
 * rail-status-repaint.test.mjs uses and for the same stated reason.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { parseAst } from 'rollup/parseAst'
import { railRebindDecision } from '../../src/tree-rail-rebind.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const view = readFileSync(join(ROOT, 'src', 'views', 'computers.js'), 'utf8')

/* Comments are blanked to spaces, newlines kept, so a sentence in a comment
   can never satisfy (or unbalance) an assertion about code. */
const blankButNewlines = text => text.replace(/[^\n]/g, ' ')
const code = view
  .replace(/\/\*[\s\S]*?\*\//g, blankButNewlines)
  .replace(/(^|[^:"'`])\/\/[^\n]*/g, (match, before) => before + blankButNewlines(match.slice(before.length)))

const lineOf = index => code.slice(0, index).split('\n').length

/** Slice a brace-balanced block whose header text ENDS with its opening brace,
    so a destructured parameter list cannot be mistaken for the body. */
function sliceBlock(source, header, what) {
  const at = source.indexOf(header)
  assert.notEqual(at, -1, `${what} is gone: ${JSON.stringify(header)} is not in the source`)
  const open = at + header.length - 1
  assert.equal(source[open], '{', `${what}: the slice marker does not end at its opening brace`)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(at, i + 1)
    }
  }
  return assert.fail(`${what} never closes its braces; the slice marker is stale`)
}

/* ---------------------- the reconciliation walk -------------------------- */

/* The return that cannot leave a stale rail behind, named rather than
   waved past, so another one added later is a failure and not a silence.
   Each is matched against the source immediately before the `return`. */
const EXEMPT_RETURNS = [
  {
    guard: /if \(destroyed(?: \|\| treeStore !== store)?\)\s*$/,
    why: 'the initiating view is destroyed or now displays a different store; its old rail must not be revived',
  },
]

/* Walk forward from a point where a session lands on a node and report what
   control reaches first: a rail reconciliation, or a way out of the function
   that leaves the open rail bound to the panel it had before. */
function reconciliationAfter(from) {
  const stops = /rebindRailToSession\(|showTreeNodeControls\(|\breturn\b/g
  stops.lastIndex = from
  const used = []
  let hit
  while ((hit = stops.exec(code)) !== null) {
    if (hit[0] !== 'return') return { reconciled: true, at: hit.index, exemptionsUsed: used }
    const before = code.slice(Math.max(0, hit.index - 140), hit.index)
    const exemption = EXEMPT_RETURNS.find(candidate => candidate.guard.test(before))
    if (!exemption) return { reconciled: false, at: hit.index, exemptionsUsed: used }
    used.push(exemption)
  }
  return { reconciled: false, at: code.length, exemptionsUsed: used }
}

/* ------------------------- the rule, driven with values ------------------ */

test('a rail bound to nothing rebinds the moment its node gains a session', () => {
  const answer = railRebindDecision({
    railActive: true,
    railNodeId: 'node-a',
    railSessionId: null,
    node: { id: 'node-a', sessionId: 'session-1' },
  })
  assert.deepEqual({ ...answer }, { rebind: true, reason: 'session-attached' })
})

test('a rail still bound to a retired session rebinds onto the new one', () => {
  const answer = railRebindDecision({
    railActive: true,
    railNodeId: 'node-a',
    railSessionId: 'session-1',
    node: { id: 'node-a', sessionId: 'session-2' },
  })
  assert.deepEqual({ ...answer }, { rebind: true, reason: 'session-replaced' })
})

test('a rail left holding a session the node no longer has is rebuilt too', () => {
  /* THE OTHER DIRECTION OF THE SAME DISAGREEMENT, and it is reachable: a
     restart that fails detaches the node (src/fresh-start-existing-node.js
     closes the old session and detaches before it starts the replacement) and
     the rail keeps a live composer pointed at a session that was closed a
     moment ago. Rebuilding puts back the honest session-less panel, which is
     the one that says why nothing can be sent. */
  const answer = railRebindDecision({
    railActive: true,
    railNodeId: 'node-a',
    railSessionId: 'session-1',
    node: { id: 'node-a', sessionId: null },
  })
  assert.deepEqual({ ...answer }, { rebind: true, reason: 'session-detached' })
})

test('a rail already mounted on this very session is left alone', () => {
  /* A needless rebuild disposes the mounted chat and closes an open actions
     popup mid-keystroke. That is the whole point of the guard. */
  const answer = railRebindDecision({
    railActive: true,
    railNodeId: 'node-a',
    railSessionId: 'session-1',
    node: { id: 'node-a', sessionId: 'session-1' },
  })
  assert.equal(answer.rebind, false)
  assert.equal(answer.reason, 'already-bound')
})

test('a node that is still starting has nothing to rebind to', () => {
  const answer = railRebindDecision({
    railActive: true,
    railNodeId: 'node-a',
    railSessionId: null,
    node: { id: 'node-a', sessionId: null },
  })
  assert.equal(answer.rebind, false)
  assert.equal(answer.reason, 'no-session')
})

test('a rail showing another node is never rebuilt by this node landing', () => {
  const answer = railRebindDecision({
    railActive: true,
    railNodeId: 'node-b',
    railSessionId: null,
    node: { id: 'node-a', sessionId: 'session-1' },
  })
  assert.equal(answer.rebind, false)
  assert.equal(answer.reason, 'other-node')
})

test('a closed rail and an empty rail are both left alone', () => {
  const closed = railRebindDecision({
    railActive: false,
    railNodeId: 'node-a',
    railSessionId: null,
    node: { id: 'node-a', sessionId: 'session-1' },
  })
  assert.equal(closed.rebind, false)
  assert.equal(closed.reason, 'rail-closed')

  const empty = railRebindDecision({
    railActive: true,
    railNodeId: null,
    railSessionId: null,
    node: { id: 'node-a', sessionId: 'session-1' },
  })
  assert.equal(empty.rebind, false)
  assert.equal(empty.reason, 'no-rail')
})

test('a node the store no longer holds is not rebuilt from a stale record', () => {
  for (const node of [null, undefined, {}, { id: '', sessionId: 'session-1' }]) {
    const answer = railRebindDecision({
      railActive: true,
      railNodeId: 'node-a',
      railSessionId: null,
      node,
    })
    assert.equal(answer.rebind, false, `a rebuild was offered for ${JSON.stringify(node)}`)
    assert.equal(answer.reason, 'node-gone')
  }
})

test('a session id that is not a non-empty string is absent, never a rebind target', () => {
  for (const sessionId of ['', '   ', 0, 1, false, true, {}, [], null, undefined]) {
    const answer = railRebindDecision({
      railActive: true,
      railNodeId: 'node-a',
      railSessionId: null,
      node: { id: 'node-a', sessionId },
    })
    assert.equal(answer.rebind, false, `${JSON.stringify(sessionId)} was taken for a live session id`)
    assert.equal(answer.reason, 'no-session')
  }
})

test('a rail session id that is not a non-empty string reads as bound to nothing', () => {
  for (const railSessionId of ['', '  ', 0, false, {}, null, undefined]) {
    const answer = railRebindDecision({
      railActive: true,
      railNodeId: 'node-a',
      railSessionId,
      node: { id: 'node-a', sessionId: 'session-1' },
    })
    assert.equal(answer.rebind, true, `${JSON.stringify(railSessionId)} was taken for a live mount`)
    assert.equal(answer.reason, 'session-attached')
  }
})

test('a node with no session under a rail bound to nothing is the quiet case', () => {
  /* THE FLOOR OF THE DETACH BRANCH. Both sides absent is agreement, not a
     disagreement to repair: a dashed circle whose rail is the read-only panel
     must not be torn down and rebuilt every time something touches the node. */
  for (const railSessionId of ['', '   ', 0, false, null, undefined]) {
    const answer = railRebindDecision({
      railActive: true,
      railNodeId: 'node-a',
      railSessionId,
      node: { id: 'node-a', sessionId: null },
    })
    assert.equal(answer.rebind, false, `${JSON.stringify(railSessionId)} was taken for a live mount`)
    assert.equal(answer.reason, 'no-session')
  }
})

test('the answer cannot be edited by whoever asked for it', () => {
  const answer = railRebindDecision({
    railActive: true,
    railNodeId: 'node-a',
    railSessionId: null,
    node: { id: 'node-a', sessionId: 'session-1' },
  })
  assert.ok(Object.isFrozen(answer))
  assert.throws(() => { 'use strict'; answer.rebind = false })
})

test('the decision reads nothing but its own arguments', () => {
  /* No store, no DOM, no clock: a rule that cannot be driven with values is a
     rule that has to be proved by driving the app. */
  const source = readFileSync(join(ROOT, 'src', 'tree-rail-rebind.js'), 'utf8')
  for (const forbidden of ['document', 'window', 'treeStore', 'Date.now', 'require(', 'import ']) {
    assert.equal(source.includes(forbidden), false,
      `src/tree-rail-rebind.js reaches for ${forbidden}, so it is no longer a decision that can be driven with values`)
  }
})

/* -------------------------- the view's half, pinned ---------------------- */

test('the start path rebinds the rail that is already open on the node', () => {
  const header = code.match(/onSessionOpen:\s*\(\{[^}]*\}\)\s*=>\s*\{/)?.[0]
  assert.ok(header, 'the actual session-open callback must exist')
  const opened = sliceBlock(
    code,
    header,
    "startDraftNode's onSessionOpen",
  )
  assert.match(opened, /store\.attachSession\(node\.id, sessionId\)/,
    'the start path no longer attaches the session here, so this pin is aimed at the wrong block')
  assert.match(opened, /rebindRailToSession\(node\.id\)/,
    'a session landed on the node and the rail already open on it was left bound to the pre-session panel')
  const attachedAt = opened.indexOf('store.setNodeStatus(node.id, \'running\'')
  const rebindAt = opened.indexOf('rebindRailToSession(node.id)')
  assert.ok(attachedAt !== -1 && rebindAt > attachedAt,
    'the rail is rebuilt before the node is marked running, so it remounts the state it is replacing')
})

test('the resume that ends before it returns rebinds the open rail', () => {
  /* THE SIBLING DEFECT the first round of this fix walked past. A resume whose
     session the engine reports ENDED still attaches that session to the node --
     "a session that is over is still a session" -- and then returns false,
     above the function's own remount tail, which only the success path below
     ever reaches. The rail open on the circle keeps the panel it was built
     with, over a run that happened. */
  const ended = sliceBlock(
    code,
    '    if (!result.ok || !result.sessionId) {',
    "resumeNodeSessionUnguarded's early return",
  )
  assert.match(ended, /store\.attachSession\(node\.id, result\.sessionId\)/,
    'this branch no longer attaches the ended session, so the pin is aimed at the wrong block')
  assert.match(ended, /rebindRailToSession\(node\.id\)/,
    'a resume attached a session and returned without reconciling the rail already open on the node')
  const sentenceAt = ended.indexOf('out.textContent = result.sentence')
  const rebindAt = ended.indexOf('rebindRailToSession(node.id)')
  const returnAt = ended.indexOf('return false')
  assert.ok(sentenceAt !== -1 && rebindAt > sentenceAt,
    'the rail is remounted before the refusal is written into it, so the sentence lands on a detached element')
  assert.ok(returnAt !== -1 && rebindAt < returnAt,
    'the rebind is unreachable: this branch returns before it')
})

test("the assistant's own restart reconciles the rail the person's Clear row already did", () => {
  /* runTreeNodeCommand is where agent.restart lands. It calls the SAME
     freshStartExistingNode the palette's Clear row calls -- deliberately, so a
     circle restarted by its manager and one restarted by hand end in the same
     state -- but the palette reconciled the open rail afterwards and this
     branch returned the module's answer straight through. The attach happens
     inside src/fresh-start-existing-node.js, so nothing in this file's own
     attach invariant could ever have seen it. */
  const branch = sliceBlock(
    code,
    "      if (command.action === 'fresh-start-existing-node') {",
    "runTreeNodeCommand's restart branch",
  )
  /* The call carries an afterBind step since the restart-brief lane landed
     (the assistant's restart keeps the node's brief); the primitive is the same. */
  assert.match(branch, /freshStartExistingNode\(node[,)]/,
    'the restart branch no longer calls the shared primitive, so the pin is aimed at the wrong block')
  assert.match(branch, /rebindRailToSession\(node\.id\)/,
    'an assistant replaced this circle\'s session and the rail open on it kept the closed one')
  const startedAt = branch.indexOf('freshStartExistingNode(node')
  const rebindAt = branch.indexOf('rebindRailToSession(node.id)')
  assert.ok(rebindAt > startedAt,
    'the rail is reconciled before the replacement session exists, so it rebinds to the session being replaced')
})

test('EVERY session attached anywhere in this view reconciles the open rail', () => {
  /* THE INVARIANT, and it counts the whole view rather than one blessed
     function. Every place the view attaches a session to a node is a place the
     rail already open on that node can be left bound to the panel it had
     before -- so from each of them, control must reach a reconciliation
     (rebindRailToSession, or the resume tail's own showTreeNodeControls)
     before it can return. A failed save is no longer exempt: the real session
     still requires an accessible runtime rail, driven by tree-start-persistence.
     The module-level runtime-store adapter has no rail; its callers inside
     computersView own this UI reconciliation, just like the imported store. */
  const viewAt = code.indexOf('export function computersView(')
  assert.ok(viewAt >= 0, 'the UI closure must exist')
  const attaches = [...code.matchAll(/(?<![A-Za-z0-9_$.])[A-Za-z_$][A-Za-z0-9_$]*\.attachSession\(/g)]
    .filter(attach => attach.index > viewAt)
  assert.ok(attaches.length >= 5,
    `this view attaches a session in ${attaches.length} place(s); the invariant is aimed at the wrong file`)
  const stale = []
  const exercised = new Set()
  for (const attach of attaches) {
    const walk = reconciliationAfter(attach.index + attach[0].length)
    for (const exemption of walk.exemptionsUsed) exercised.add(exemption.why)
    if (!walk.reconciled) {
      stale.push(`  src/views/computers.js:${lineOf(attach.index)} attaches a session, `
        + `then returns at line ${lineOf(walk.at)} without reconciling the rail`)
    }
  }
  assert.equal(stale.length, 0,
    `a session lands on a node and the rail already open on it keeps a panel that cannot reach it:\n${stale.join('\n')}`)
  for (const exemption of EXEMPT_RETURNS) {
    assert.ok(exercised.has(exemption.why),
      `EXEMPT_RETURNS still allows "${exemption.why}" but no attach site needs it any more; `
      + 'an unused exemption is a hole waiting for the next early return')
  }
})

test('EVERY restart that attaches inside another module reconciles at the call site', () => {
  /* executeFreshStartExistingNode detaches the old session and attaches the
     replacement inside src/fresh-start-existing-node.js, where the invariant
     above cannot see it. Its callers in this view answer for it. */
  const calls = [...code.matchAll(/(?<![A-Za-z0-9_$])freshStartExistingNode\(/g)]
    .filter(call => !/function\s+$/.test(code.slice(Math.max(0, call.index - 20), call.index)))
  assert.ok(calls.length >= 2,
    `freshStartExistingNode is called in ${calls.length} place(s); the invariant is aimed at the wrong name`)
  assert.equal(/return\s+(?:await\s+)?freshStartExistingNode\(/.test(code), false,
    'a restart is returned straight to its caller, so nothing can reconcile the rail it just changed the session under')
  const stale = []
  for (const call of calls) {
    const walk = reconciliationAfter(call.index + call[0].length)
    if (!walk.reconciled) {
      stale.push(`  src/views/computers.js:${lineOf(call.index)} replaces this node's session, `
        + `then returns at line ${lineOf(walk.at)} without reconciling the rail`)
    }
  }
  assert.equal(stale.length, 0,
    `a replacement session lands on a node and the rail open on it keeps the closed one:\n${stale.join('\n')}`)
})

test('the rebind asks the shared rule and re-reads the node from the store', () => {
  const body = sliceBlock(code, '  function rebindRailToSession(nodeId) {', 'rebindRailToSession')
  assert.match(body, /railRebindDecision\(/,
    'the rebind decides for itself instead of using src/tree-rail-rebind.js, so the two callers can drift')
  assert.match(body, /treeStore\.getNode\(nodeId\)/,
    'the rebind rebuilds from the caller\'s node object, which is the stale record that caused this defect')
  assert.match(body, /railActive:\s*controlsPage\.classList\.contains\('is-active'\)/,
    'the rebind no longer tells the rule whether the rail is even on screen')
  assert.match(body, /railSessionId:\s*railChat \? railChat\.sessionId : null/,
    'the rebind no longer reads the session the mounted chat was built for')
  assert.match(body, /if \(!decision\.rebind\) return false/,
    'the rebind ignores its own rule')
  assert.match(body, /showTreeNodeControls\(/,
    'the rebind does not remount the rail, so nothing about the panel changes')
  /* MATCHED BY NAME, NOT BY THE ARGUMENT'S SPELLING. This read
     `showTreeNodeControls(fresh)` until 2026-09-04, when the remount moved
     inside deferRailRebuildWhileTyping and began passing a node re-read at the
     moment the deferred rebuild actually runs. The old spelling failed against
     that, and the quickest way back to green would have been to remount from
     the node read before the wait -- a stale yes, which is this defect wearing
     a different hat. The two assertions below are what that spelling was
     standing in for, said directly. */
  assert.match(body, /deferRailRebuildWhileTyping\(/,
    'the rebind remounts immediately, so a landing start, refusal or ended session '
    + 'disposes the composer a person is typing in -- the owner\'s "my typing surface disappears"')
  assert.equal((body.match(/railRebindDecision\(/g) || []).length, 2,
    'the deferred rebuild does not re-read the rule when it finally runs, so a blur seconds later '
    + 'remounts on a decision taken before the rail may have moved, the node may have gone, '
    + 'or the rail may already be mounted on that session')
})

test('the rail mount records the session its chat was built for', () => {
  /* railRebindDecision is only as truthful as this field: it is the sole
     record of which session the panel in front of the person can reach. */
  assert.match(code, /const mine = \{ sessionId: node\.sessionId, nodeId: node\.id, root: null, stream: null \}/,
    'the rail mount no longer records the session id it was built for, so no rebind can tell a stale panel from a live one')
})

test('NEGATIVE CONTROL: a status landing still never rebuilds the rail', () => {
  const body = sliceBlock(code, '  function repaintRailStatus(node) {', 'repaintRailStatus')
  assert.equal(body.includes('showTreeNodeControls'), false,
    'repaintRailStatus rebuilds the rail again, which is the 2026-08-18 defect it was extracted to end')
  assert.equal(body.includes('rebindRailToSession'), false,
    'a status landing now rebuilds the rail through the rebind, which is the same defect wearing a new name')
})

test('NEGATIVE CONTROL: the resume that succeeds keeps its own unconditional remount', () => {
  /* It rebuilds for a DIFFERENT reason -- it has just replaced the
     conversation the panel is showing (resumedTranscriptLines) -- and must
     keep rebuilding in the one case the rule refuses: a resume that adopts the
     very session id the rail is already mounted on. Routing that tail through
     railRebindDecision would answer the wrong question. */
  // Find the function's real body, independent of optional resume parameters.
  // Parsing preserves the boundary even when a default contains braces.
  const found = []
  function visit(node) {
    if (!node || typeof node !== 'object') return
    if (node.type === 'FunctionDeclaration' && node.id?.name === 'resumeNodeSessionUnguarded') found.push(node)
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit)
      else if (value && typeof value === 'object') visit(value)
    }
  }
  visit(parseAst(view))
  assert.equal(found.length, 1, 'the real Resume body must remain uniquely identifiable')
  const body = code.slice(found[0].body.start, found[0].body.end)
  const tailAt = body.lastIndexOf('if (destroyed || treeStore !== store) return engineResumed')
  assert.ok(tailAt >= 0, 'the post-handoff view-ownership boundary must exist')
  const tail = body.slice(tailAt)
  assert.match(tail, /showTreeNodeControls\(treeStore \? treeStore\.getNode\(node\.id\) \|\| node : node\)/,
    'the successful resume no longer remounts the panel it just replaced the conversation in')
  assert.equal(tail.includes('rebindRailToSession'), false,
    'the successful resume now asks a rule that would refuse it whenever the session id did not change')
})
