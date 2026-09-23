import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { sessionEventTurnId } from '../../src/agent-session-events.js'
import { treeSessionEventSource } from './lib/tree-session-event-source.mjs'

/* turnStamp, WIRED FROM THE REAL SEND PATHS.
 *
 * src/components.js's turnStamp (makeMsg's fifth argument, openStream's
 * `turnStamp` option, history entries' `.turnStamp` field) had zero
 * production callers before this change — every message this view ever built
 * passed no stamp, so the badge never rendered anywhere real. Each assertion
 * below pins one real send path to the REAL engine turn identity it now
 * carries (sessionOpenTurns / the resolved send's own turnId / the turn
 * settleTurnBoundary is settling) — never a synthesised counter, per the
 * component's own rule: "a stamp is evidence supplied by the transcript
 * source; no supplied stamp means no badge".
 *
 * THIS FILE IS THE WORKED EXAMPLE FOR WRITING A SOURCE-SHAPE PIN. Two of its
 * assertions were once exact literals and both went red on correct work — a
 * hoist, and a field added to an object. The rule that came out of it is in
 * tools/test/REGRESSION-NOTES.md under "Writing a source-shape pin", and it is
 * one question: CAN THIS TEXT CHANGE WHILE THE BEHAVIOUR THIS TEST PROTECTS
 * STAYS TRUE? If yes, pin the invariant, not the spelling. The three ways to do
 * that are all used below: capture the identifier and assert relationships
 * against the captured name; slice to a NAMED stable neighbour rather than a
 * character count; and, where the statements can be run, extract and EXECUTE
 * them with new Function so the assertion is about behaviour. An exact literal
 * still earns its place where the spelling IS the contract. */

const VIEW = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')

test('the live streaming bubble opens stamped with the turn settleTurnBoundary just named', () => {
  const { dispatcherNode } = treeSessionEventSource(VIEW)
  const calls = []
  function visit(node) {
    if (!node || typeof node !== 'object') return
    if (node.type === 'CallExpression' && VIEW.slice(node.callee.start, node.callee.end) === 'railChat.root.openStream') calls.push(node)
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit)
      else if (value && typeof value === 'object') visit(value)
    }
  }
  visit(dispatcherNode)
  assert.equal(calls.length, 1, 'the live rail must open exactly one stream')
  const options = calls[0].arguments[0]
  const readOptions = new Function('sessionId', 'sessionOpenTurns', 'nativeReconcileSessions',
    `return (${VIEW.slice(options.start, options.end)})`)
  for (const reconciled of [false, true]) {
    for (const turn of [null, 'actual-engine-turn']) {
      const actual = readOptions('session', new Map(turn ? [['session', turn]] : []), new Set(reconciled ? ['session'] : []))
      assert.equal(actual.turnStamp, turn, 'a live bubble carries the actual engine turn, or remains unstamped')
      assert.equal(actual.entryId, reconciled && turn ? `agent:session:${turn}` : undefined,
        'native reconciliation names the same entry without replacing its turn stamp')
    }
  }
})

/* THIS PIN WAS AIMED AT A SPELLING, AND THE SPELLING MOVED.
 *
 * It used to require the resolved-turnId expression to appear INLINE in the
 * transcript line. Then the drain grew a second surface to stamp -- the
 * broadcast to every mounted chat on that session -- and the expression was
 * hoisted into one named const so both surfaces could be handed the same
 * value (40eea8d). The behaviour this test exists to protect got STRONGER and
 * the test went red, which is the pin failing, not the code: a source
 * assertion that duplicates an expression's exact spelling breaks on every
 * refactor that does not change what the expression means.
 *
 * So it is aimed at the invariant instead, which is the thing that can
 * actually be lost: the stamp is derived from the resolved send's own
 * turnId, and the durable transcript line and the live bubble on every
 * mounted surface are handed THE SAME derived value -- never one stamped and
 * one bare, and never two independently computed answers about which turn one
 * message belongs to. */
test('a queued message drained to the engine is stamped with the send\'s own resolved turnId', () => {
  /* TWO STEPS, AND NEITHER OF THEM A SPELLING. Pin the computation, then pin
     its use -- the same shape as 'the ordinary turn-completion reply' test
     below (completingTurnId). The derivation's own NAME is read out of the
     source rather than written down here, so hoisting or renaming the shared
     const cannot make this test red on its own; what it cannot survive is the
     stamp ceasing to come from the resolved send's turnId, or either surface
     being handed something other than that one value.

     BOTH SURFACES, because there are two: the durable transcript line and the
     bubble broadcastOwnerMessage paints on every mounted chat for this
     session. One stamped and one bare is exactly the split this test exists
     to catch, and a pin on transcriptAppend alone would not see it.

     Sliced to the function's own end, not a fixed character count: a fixed
     3000 (this pin's original bound) went stale the moment the
     refused-delivery branch above the derivation grew a guard clause of its
     own, which pushed both targets past that count and read as neither ever
     having existed -- the exact silent-miss shape this suite's own header
     names. `drainOutboxMessage` is immediately followed by the tree's event
     listener, itself introduced by a stable, named comment. */
  const drainStart = VIEW.indexOf('async function drainOutboxMessage')
  const drainEnd = VIEW.indexOf("/* THE TREE'S OWN EAR ON THE SESSION STREAM.", drainStart)
  assert.ok(drainEnd > drainStart, 'could not find where drainOutboxMessage ends (its neighbour was renamed or moved)')
  const drainFn = VIEW.slice(drainStart, drainEnd)
  const derivation = drainFn.match(/const (\w+) = drained && typeof drained\.turnId === 'string' && drained\.turnId \? drained\.turnId : null/)
  assert.ok(derivation,
    'the drained stamp is no longer derived from the resolved send\'s own turnId — a queued turn\'s own message goes unstamped')
  const stamp = derivation[1]
  assert.match(drainFn, new RegExp(`transcriptAppend\\(sessionId, \\{ who: 'you'[^}]*turnStamp: ${stamp} \\}\\)`),
    'the drained "you" line no longer carries the resolved turnId — the saved record of a queued turn goes unstamped')
  assert.match(drainFn, new RegExp(`broadcastOwnerMessage\\(sessionId, entry\\.text, \\{[^}]*turnStamp: ${stamp} \\}\\)`),
    'the bubble every mounted surface paints for a drained message no longer carries the same stamp the saved line got')
})

test('a turn settled early by the next turn\'s first delta is stamped with the turn that just ended', () => {
  const fn = VIEW.slice(VIEW.indexOf('function settleTurnBoundary'), VIEW.indexOf('function transcriptAppend'))
  assert.match(fn, /transcriptAppend\(sessionId, \{ who: 'agent', text: spoken, at: Date\.now\(\), turnStamp: open \}\)/,
    'settleTurnBoundary\'s early-settled reply no longer carries `open` (the turn id it captured before overwriting it) as its stamp')
})

test('completion preserves the event turn or the known open turn on both reply surfaces', () => {
  const { dispatcherNode } = treeSessionEventSource(VIEW)
  const callNames = new Set(['sessionOpenTurns.delete', 'transcriptAppend', 'deliverTurnReply'])
  const statements = dispatcherNode.body.body.filter(statement => {
    if (statement.type === 'VariableDeclaration') {
      return statement.declarations.some(declaration => declaration.id.name === 'completingTurnId')
    }
    const call = statement.type === 'ExpressionStatement' && statement.expression
    return call?.type === 'CallExpression' && callNames.has(VIEW.slice(call.callee.start, call.callee.end))
  })
  assert.equal(statements.length, 4, 'capture, delete, transcript and delivery statements must all exist')
  // Execute the actual four statements in source order with the real event
  // reader. This isolates stamp propagation; the complete event consumer is
  // exercised with buildChat by tree-empty-turn-transcript.test.mjs.
  const completion = new Function('sessionEventTurnId', 'packet', 'sessionId', 'sessionOpenTurns', 'said',
    'transcriptAppend', 'deliverTurnReply', statements.map(statement => VIEW.slice(statement.start, statement.end)).join('\n'))
  for (const [eventTurn, openTurn, expected] of [
    ['named-turn', 'named-turn', 'named-turn'],
    ['before-first-delta', null, 'before-first-delta'],
    [null, 'known-open-turn', 'known-open-turn'],
    [null, null, null],
  ]) {
    const sessionId = 'stamp-session'
    const open = new Map(openTurn ? [[sessionId, openTurn]] : [])
    const transcripts = [], deliveries = []
    completion(sessionEventTurnId, { sessionId, event: { type: 'turn_completed', status: 'completed',
      ...(eventTurn ? { turnId: eventTurn } : {}) } }, sessionId, open, 'Completed words.',
    (...args) => transcripts.push(args), (...args) => deliveries.push(args))
    assert.equal(open.has(sessionId), false, 'completion clears the open turn')
    assert.equal(transcripts.length, 1)
    assert.equal(transcripts[0][0], sessionId)
    assert.equal(transcripts[0][1].who, 'agent')
    assert.equal(transcripts[0][1].text, 'Completed words.')
    assert.equal(transcripts[0][1].turnStamp, expected)
    assert.deepEqual(deliveries, [[sessionId, 'Completed words.', expected]])
  }
})

/* AND THIS PIN WAS AIMED AT A SPELLING TOO, AND A FIELD WAS ADDED TO IT.
 *
 * It required the entry literal to be exactly
 *   const sentEntry = { who: 'you', text, at: Date.now() }
 * The attachment work then gave the line a pictures spread --
 *   ..., ...(pictures?.length ? { pictures } : {})
 * -- and the pin went red on a change that was correct and that this test has
 * no opinion about. Same species as the second test in this file, and as the
 * chat-composer pin the typing fix moved out of its 700-character window: an
 * exact-literal source assertion breaks on every legitimate addition, and the
 * red then has to be argued about before it can be dismissed.
 *
 * So it is aimed at the invariant, which is what can actually be lost: ONE
 * object is built for the "you" line, THAT SAME binding is what reaches the
 * transcript, and THAT SAME binding is what the resolved send stamps. Holding
 * it by reference is the whole point -- the stamp arrives after the append, so
 * a copy anywhere in that chain means the transcript keeps an unstamped line
 * forever. The binding's NAME is read out of the source rather than written
 * down here, so renaming it cannot make this red on its own. What it cannot
 * survive is the line ceasing to be held by reference, a different object
 * being appended, or the stamp never being applied. The field list is free to
 * grow; three of the fields are not named here at all. */
test('the primary interactive send stamps its own "you" line once the engine actually mints a turn id', () => {
  const send = VIEW.slice(VIEW.indexOf('function treeCardSend'), VIEW.indexOf('async function drainOutboxMessage'))
  const held = send.match(/const (\w+) = \{ who: 'you', text,[^\n]*\}/)
  assert.ok(held,
    'the "you" line is no longer built as one named object — a later stamp could not reach the transcript\'s own copy of it')
  const entry = held[1]
  assert.match(send, new RegExp(`transcriptAppend\\(node\\.sessionId, ${entry}\\)`),
    'the held entry is no longer the one actually appended to the transcript')
  assert.match(send, new RegExp(`if \\(sent && typeof sent\\.turnId === 'string' && sent\\.turnId\\) ${entry}\\.turnStamp = sent\\.turnId`),
    'the resolved send no longer stamps the held entry once bridge.send() actually names a turn')
})
