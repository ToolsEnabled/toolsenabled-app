/* THE CHAT WAS NOT A CONTEXT WINDOW, AND A FIVE-MINUTE TURN PUT ZERO ROWS IN IT.
 *
 * Owner, item 1 and his biggest ask: he wants to see what the agent is doing,
 * the way an editor shows its tool calls interleaved with its prose.
 *
 * NOTHING WAS MISSING ON THE WIRE. The engine emits tool_call, tool_result and
 * approval_request (engine-contract.js's EVENT_TYPES); the codex adapter puts
 * the command, the exit code and a toolCallId on them, and the Claude CLI
 * adapter puts the tool's own name ("Bash", "Read"), its input, and a
 * tool_use_id that pairs a result with its call. The host, the main process and
 * the preload forward every packet unfiltered, and src/agent-session-events.js
 * already had a reader for them.
 *
 * IT WAS THROWN AWAY AT THE LAST STEP. The single consumer routed the reader's
 * answer to a ONE-LINE OVERWRITTEN status string and a chip, and deleted it on
 * completion. It never reached the chat log, the transcript, or any list of
 * what was done. So a turn that spent five minutes running commands produced no
 * rows at all, by construction.
 *
 * WHAT THIS PINS: the reader carries enough to JOIN a result to its call and to
 * say what was done; a bounded buffer keeps them in arrival order with visible
 * caps rather than silent ones; and the chat has a second door beside openStream
 * that appends and UPDATES rows in the same log.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import {
  ACTION_LIMITS,
  createActionBuffer,
  sessionActivityEvent,
} from '../../src/agent-session-events.js'
import { actionRowWords, activityLine, commandSummary, foldedActionsLine } from '../../src/fleet-tree-copy.js'

const SRC = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'src')
const components = readFileSync(join(SRC, 'components.js'), 'utf8')
const view = readFileSync(join(SRC, 'views', 'computers.js'), 'utf8')
const styles = readFileSync(join(SRC, 'styles.css'), 'utf8')

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker)
  assert.notEqual(start, -1, `source section start is missing: ${startMarker}`)
  assert.notEqual(end, -1, `source section end is missing: ${endMarker}`)
  assert.ok(start < end, `source section is out of order: ${startMarker} must precede ${endMarker}`)
  return source.slice(start, end)
}

/* The two shapes, copied from what the adapters really emit. */
const codexCall = {
  sessionId: 's1',
  event: {
    type: 'tool_call',
    turnId: 'turn-a',
    itemId: 'item-7',
    toolCallId: 'item-7',
    tool: 'commandExecution',
    payload: { command: 'npm test', cwd: 'C:/work' },
  },
}
const codexResult = {
  sessionId: 's1',
  event: {
    type: 'tool_result',
    turnId: 'turn-a',
    itemId: 'item-7',
    toolCallId: 'item-7',
    tool: 'commandExecution',
    payload: { status: 'completed', exitCode: 0, aggregatedOutput: '2295 tests, 0 fail' },
  },
}
const claudeCall = {
  sessionId: 's1',
  event: { type: 'tool_call', toolCallId: 'toolu_9', tool: 'Read', payload: { file_path: 'C:/work/src/app.js' } },
}
const claudeResult = {
  sessionId: 's1',
  event: { type: 'tool_result', toolCallId: 'toolu_9', text: 'export function app() {}', status: 'error' },
}

test('the ACP structured title survives its category and a title-less result', () => {
  const buffer = createActionBuffer()
  const call = sessionActivityEvent({ sessionId: 's1', event: {
    type: 'tool_call', toolCallId: 'native-call', tool: 'other',
    payload: { title: 'toolsenabled__host_list_processes', kind: 'other', rawInput: {} },
  } }, 's1')
  const added = buffer.add(call, { turnId: 'native-turn', at: 100 })
  assert.equal(actionRowWords(added.row).detail, 'toolsenabled__host_list_processes')
  buffer.add(sessionActivityEvent({ sessionId: 's1', event: {
    type: 'tool_result', toolCallId: 'native-call', tool: 'other', payload: { status: 'completed', rawOutput: {} },
  } }, 's1'), { turnId: 'native-turn', at: 200 })
  assert.equal(buffer.list().length, 1)
  assert.equal(actionRowWords(buffer.list()[0]).detail, 'toolsenabled__host_list_processes')
  assert.equal(actionRowWords(buffer.list()[0]).state, 'finished')
})

/* ---------------------------------------------------------------
   A. The reader carries what a row needs, from BOTH engines.
   --------------------------------------------------------------- */

test('a call carries the name the result will be joined on', () => {
  assert.equal(sessionActivityEvent(codexCall, 's1').toolCallId, 'item-7')
  assert.equal(sessionActivityEvent(codexResult, 's1').toolCallId, 'item-7')
  assert.equal(sessionActivityEvent(claudeCall, 's1').toolCallId, 'toolu_9')
  assert.equal(sessionActivityEvent(claudeResult, 's1').toolCallId, 'toolu_9')
})

test('a call says what it is doing, whichever engine phrased it', () => {
  assert.equal(sessionActivityEvent(codexCall, 's1').detail, 'npm test')
  /* Claude names the tool and puts its argument in the input, so the detail is
     the PATH for a read and the command for a shell call. A row that said only
     "Read" would be the one-line status string this replaces. */
  assert.equal(sessionActivityEvent(claudeCall, 's1').detail, 'C:/work/src/app.js')
  assert.equal(sessionActivityEvent(claudeCall, 's1').tool, 'Read')
})

test('a result says how it went, and the two engines say it in different places', () => {
  const codex = sessionActivityEvent(codexResult, 's1')
  assert.equal(codex.exitCode, 0)
  assert.equal(codex.status, 'completed')
  /* The Claude CLI puts status on the EVENT, not in the payload. Reading only
     payload.status called every failed Claude tool call a success. */
  assert.equal(sessionActivityEvent(claudeResult, 's1').status, 'error')
})

test('a result carries the output a person can open, bounded', () => {
  assert.equal(sessionActivityEvent(codexResult, 's1').output, '2295 tests, 0 fail')
  const huge = {
    sessionId: 's1',
    event: { type: 'tool_result', toolCallId: 'x', payload: { aggregatedOutput: 'y'.repeat(ACTION_LIMITS.maxOutputChars + 500) } },
  }
  assert.equal(sessionActivityEvent(huge, 's1').output.length, ACTION_LIMITS.maxOutputChars)
})

test('the old fields are untouched, so the status line and the chip keep working', () => {
  assert.equal(sessionActivityEvent(codexCall, 's1').kind, 'call')
  assert.equal(sessionActivityEvent(codexCall, 's1').command, 'npm test')
  assert.equal(sessionActivityEvent(codexResult, 's1').kind, 'result')
  assert.equal(sessionActivityEvent({ sessionId: 's1', event: { type: 'usage' } }, 's1'), null)
  assert.equal(sessionActivityEvent(codexCall, 's2'), null)
})

/* ---------------------------------------------------------------
   B. The buffer: arrival order, one row per call, visible caps.
   --------------------------------------------------------------- */

test('a result updates the row its call opened; it never appends a second one', () => {
  const buffer = createActionBuffer()
  const opened = buffer.add(sessionActivityEvent(codexCall, 's1'), { turnId: 'turn-a', at: 10 })
  assert.equal(opened.change, 'added')
  const closed = buffer.add(sessionActivityEvent(codexResult, 's1'), { turnId: 'turn-a', at: 20 })
  assert.equal(closed.change, 'updated')
  assert.equal(buffer.list().length, 1, 'the result appended a second row instead of closing the first')
  const row = buffer.list()[0]
  assert.equal(row.tool, 'commandExecution')
  assert.equal(row.detail, 'npm test')
  assert.equal(row.state, 'done')
  assert.equal(row.output, '2295 tests, 0 fail')
  assert.equal(row.at, 10, 'the row jumped to the end of the conversation when its result landed')
})

test('a result that failed says so on the row it belongs to', () => {
  const buffer = createActionBuffer()
  buffer.add(sessionActivityEvent(claudeCall, 's1'), { turnId: 'turn-a', at: 10 })
  buffer.add(sessionActivityEvent(claudeResult, 's1'), { turnId: 'turn-a', at: 20 })
  assert.equal(buffer.list()[0].state, 'undone')
})

test('a result with no call before it still gets a row rather than being dropped', () => {
  const buffer = createActionBuffer()
  const only = buffer.add(sessionActivityEvent(codexResult, 's1'), { turnId: 'turn-a', at: 5 })
  assert.equal(only.change, 'added')
  assert.equal(buffer.list().length, 1)
})

test('an engine that names no call keeps every row separate', () => {
  /* Joining on an EMPTY id would fold every unnamed action into one row. */
  const buffer = createActionBuffer()
  const nameless = { kind: 'call', toolCallId: '', tool: 'fileChange', detail: 'a.js', command: '', exitCode: null, status: '', output: '' }
  buffer.add(nameless, { turnId: 't', at: 1 })
  buffer.add({ ...nameless, detail: 'b.js' }, { turnId: 't', at: 2 })
  assert.equal(buffer.list().length, 2)
})

test('the per-turn cap folds rather than drops, and the fold is countable', () => {
  const buffer = createActionBuffer({ maxPerTurn: 3, maxPerSession: 50 })
  for (let i = 0; i < 9; i += 1) {
    buffer.add({ kind: 'call', toolCallId: `c${i}`, tool: 'commandExecution', detail: `step ${i}`, command: '', exitCode: null, status: '', output: '' }, { turnId: 'turn-a', at: i })
  }
  assert.equal(buffer.list().length, 3, 'the per-turn cap does not hold; a long turn can push thousands of rows')
  assert.equal(buffer.folded('turn-a'), 6, 'the actions beyond the cap vanished with no count, which is a silent cap')
  assert.match(foldedActionsLine(6), /6/, 'the fold has no words, so a person is never told there is more')
})

test('a live run is open, and the agent speaking folds it — unless a hand held it', () => {
  /* Owner, 2026-08-24: prose carries the transcript; calls are visible
     temporarily and then collapse. The run details element opens at birth so
     calls stream past as they happen, and settleActionRuns() folds every
     auto-opened run the moment words land (addMsg AND addContext — a context
     entry is not a call either). A run the person toggled BY HAND carries
     __runUserToggled and is exempt: a choice outranks the policy. */
  const runBlock = sourceBetween(components, 'const makeActionRun', 'const refreshRunLine')
  assert.match(runBlock, /wrap\.open = true/, 'a new run no longer opens — calls are invisible while they happen')
  assert.match(runBlock, /__runUserToggled = true/, "a hand toggle is not recorded, so the auto-fold will fight the person's choice")
  const settle = sourceBetween(components, 'const settleActionRuns', 'const addToActionRun')
  assert.match(settle, /__runUserToggled/, 'settle no longer spares hand-toggled runs')
  const msg = components.slice(components.indexOf('const addMsg = '), components.indexOf('const addMsg = ') + 400)
  assert.match(msg, /settleActionRuns\(\)/, 'words landing no longer fold the live run (addMsg)')
  const context = components.slice(components.indexOf('const addContext = '), components.indexOf('const addContext = ') + 400)
  assert.match(context, /settleActionRuns\(\)/, 'a context entry no longer folds the live run')
})

// Actual DOM repaint and folded error/refusal counts are exercised by
// thinking-transcript-pipeline.test.mjs with mixed tools and thinking.

test('actionRunLine names unsuccessful calls plainly without claiming a rollback', async () => {
  const { actionRunLine: line } = await import('../../src/fleet-tree-copy.js')
  assert.equal(line(0), '', 'zero calls is no line, not a claim of work')
  assert.equal(line(1), '1 tool call')
  assert.match(line(18), /18 tool calls/)
  assert.match(line(6, { undone: 1 }), /1 did not finish/, 'an unsuccessful call folded away silently')
  assert.match(line(6, { refused: 2 }), /2 refused/, 'refusals folded away silently')
  // Both counts remain visible without exposing the internal outcome key.
  const both = line(6, { refused: 1, undone: 1 })
  assert.match(both, /1 refused/, 'both never-fold states must ride the one line')
  assert.match(both, /1 did not finish/, 'both never-fold states must ride the one line')
  assert.doesNotMatch(both, /\bundo(?:ne)?\b/i, 'a nonzero result does not prove that changes were rolled back')

  /* A REFUSAL SAYS WHERE TO READ IT. The counts alone were a failure with
     nothing to do about it -- the plain-language gate flagged the whole
     composed line, not just the fragment. A clean run stays bare. */
  assert.match(line(6, { refused: 1 }), /press to read/, 'a refusal must say where the rows are')
  assert.match(line(6, { undone: 2 }), /2 did not finish.*press to read/, 'unsuccessful calls must point to their retained rows')
  assert.match(line(6, { unknown: 1 }), /1 no result came back.*press to read/, 'unknown calls must remain visible in the folded summary')
  const allUncertain = line(6, { refused: 1, undone: 1, unknown: 2 })
  assert.match(allUncertain, /1 refused/)
  assert.match(allUncertain, /1 did not finish/)
  assert.match(allUncertain, /2 no result came back/)
  assert.doesNotMatch(line(6), /press to read/, 'a run with nothing held gets no pointer, because there is nothing to go and read')
})

test('the per-session cap drops the OLDEST and says how many', () => {
  const buffer = createActionBuffer({ maxPerTurn: 100, maxPerSession: 4 })
  for (let i = 0; i < 10; i += 1) {
    buffer.add({ kind: 'call', toolCallId: `c${i}`, tool: 'commandExecution', detail: `step ${i}`, command: '', exitCode: null, status: '', output: '' }, { turnId: `turn-${i}`, at: i })
  }
  assert.equal(buffer.list().length, 4)
  assert.equal(buffer.list()[0].detail, 'step 6', 'the newest rows were dropped instead of the oldest')
  assert.equal(buffer.dropped, 6)
})

test('a new turn gets its own allowance, so one busy turn cannot mute the next', () => {
  const buffer = createActionBuffer({ maxPerTurn: 2, maxPerSession: 50 })
  for (const turnId of ['turn-a', 'turn-b']) {
    for (let i = 0; i < 4; i += 1) {
      buffer.add({ kind: 'call', toolCallId: `${turnId}-${i}`, tool: 'x', detail: 'y', command: '', exitCode: null, status: '', output: '' }, { turnId, at: i })
    }
  }
  assert.equal(buffer.list().length, 4)
  assert.equal(buffer.folded('turn-a'), 2)
  assert.equal(buffer.folded('turn-b'), 2)
})

test('an approval is a row too, and it is the one row that is waiting', () => {
  const packet = {
    sessionId: 's1',
    event: { type: 'approval_request', approval: { approvalId: 'ap-1', kind: 'command', availableDecisions: ['allow'], details: { command: 'rm -rf build' } } },
  }
  const buffer = createActionBuffer()
  buffer.add(sessionActivityEvent(packet, 's1'), { turnId: 'turn-a', at: 1 })
  assert.equal(buffer.list()[0].state, 'waiting')
  assert.equal(buffer.list()[0].detail, 'rm -rf build')
})

/* ---------------------------------------------------------------
   C. The words, where the plain-language gate can hold them.
   --------------------------------------------------------------- */

test('a row says what was done in words a person reads, never a status key', () => {
  const words = actionRowWords({ kind: 'result', tool: 'commandExecution', detail: 'npm test', state: 'done', output: '' })
  assert.equal(typeof words.tool, 'string')
  assert.ok(words.tool.length > 0)
  assert.equal(words.detail, 'npm test')
  assert.ok(!/^(done|undone|waiting|working)$/.test(words.state), 'the row shows the internal key rather than a word')
  for (const state of ['working', 'done', 'undone', 'waiting']) {
    assert.ok(actionRowWords({ kind: 'call', tool: 'x', detail: 'y', state, output: '' }).state.length > 0, `${state} has no words`)
  }
})

test('an MCP tool call is named after its tool, never the word Step twice', () => {
  /* MEASURED on the shipped build, 2026-08-19: a Sonnet child called
     mcp__toolsenabled__agent_comms_send_local, and its two rows in the chat
     each read "Step Step finished" -- raw name unrecognised, detail empty, so
     the fallback word filled both slots and the one thing a person wanted to
     know (WHICH tool ran) was the one thing the row left out. The raw name
     carries the answer in its own spelling: mcp__<server>__<tool>. */
  const words = actionRowWords({ kind: 'call', tool: 'mcp__toolsenabled__agent_comms_send_local', detail: '', state: 'done', output: '' })
  assert.equal(words.tool, 'Tool')
  assert.match(words.detail, /agent_comms_send_local/, 'the tool own name is gone from the row')
  assert.match(words.detail, /toolsenabled/, 'which server answered is gone from the row')
  /* A detail the event DID carry still wins: the name is a fallback, not a veto. */
  const kept = actionRowWords({ kind: 'call', tool: 'mcp__toolsenabled__web_fetch', detail: 'https://example.org', state: 'done', output: '' })
  assert.equal(kept.detail, 'https://example.org')
  assert.equal(kept.tool, 'Tool')
})

test('a thinking row reads as Thinking, never as a bare Step', () => {
  /* Owner, 2026-09-03: "more event types are fine we should be showing the
     user when the model is thinking anyway." A thinking activity carries no
     tool name (there is no tool), so without its own fallback it would read
     the same as an unrecognised call -- the "Step Step finished" defect this
     file already guards against for MCP tools, in a new shape. */
  const words = actionRowWords({ kind: 'thinking', tool: '', detail: '', state: 'done', output: 'weighing the options' })
  assert.equal(words.tool, 'Thinking')
  const line = activityLine({ kind: 'thinking', output: 'weighing the options' })
  assert.equal(line, 'Thinking.')

  const activity = sessionActivityEvent({ sessionId: 's1', event: { type: 'thinking', turnId: 'turn-a', text: 'weighing the options' } }, 's1')
  const buffer = createActionBuffer()
  const filed = buffer.add(activity, { turnId: 'turn-a', at: 1 })
  assert.equal(filed.row.kind, 'thinking')
  assert.equal(actionRowWords(filed.row).tool, 'Thinking')
})

/* ---------------------------------------------------------------
   D. The chat's second door.
   --------------------------------------------------------------- */

/* SLICED BY STRUCTURE: the door is everything between its own heading and the
   actions popup that follows it. A fixed byte window would report a live
   behaviour as missing the first time somebody adds a note. */
const door = sourceBetween(components, '---- THE SECOND DOOR', '---- THE ACTIONS POPUP')

test('buildChat has a door for actions beside the one for turns', () => {
  assert.match(components, /Object\.defineProperty\(root, 'addAction'/, 'the chat has no way to be told what the agent did')
  assert.ok(door.length > 200, 'the action door is gone; this suite is pinned to nothing')
  assert.match(door, /chat-action/, 'the action row has no class, so it cannot be styled or found')
  assert.match(door, /actionRows\.get\(/, 'rows are not joined on the id, so a result appends a second row')
})

test('the action rows land in the SAME log as the messages, in arrival order', () => {
  assert.match(door, /log\.appendChild/, 'actions are drawn somewhere other than the conversation')
})

test('appends are batched per frame, through the shared primitive', () => {
  /* The log is pinned to its bottom by a ResizeObserver and a MutationObserver
     that fire on every appended row. A busy turn emitting thousands of tool
     events would re-pin thousands of times on the main thread. And raw
     requestAnimationFrame is what src/page-frames.js exists to replace: on a
     covered window a frame never comes, so the pending callback -- and the
     whole view it closed over -- is retained for ever. */
  assert.match(door, /onNextFrame\(/, 'action rows are appended one at a time, or through a frame that may never come')
  assert.match(components, /import \{ onNextFrame \} from '\.\/page-frames\.js'/)
})

test('the row itself owns the press, because that is what a press lands on', () => {
  /* MEASURED on a staged packaged build with real mouse events:
     document.elementFromPoint over any part of a collapsed row -- the heading,
     the tool name, the command text -- answers the DETAILS element, not the
     SUMMARY inside it. So the click's target is the details, a handler bound to
     the summary never sees the event (events travel up, never down), and the
     row looked pressable while nothing opened. Three driven runs said
     "nothing opened" before this moved. */
  assert.match(door, /wrap\.addEventListener\('click'/, 'the disclosure is bound to something a press does not land on')
  assert.ok(!/head\.addEventListener\('click'/.test(door), 'the handler is back on the summary, where the press never arrives')
  assert.match(door, /wrap\.open = !wrap\.open/, 'the row no longer opens by hand, so a press on the summary toggles twice')
  assert.match(door, /is-bare/, 'a row with nothing to show can open onto an empty panel')
})

test('a conversation still open keeps the output its rows printed', () => {
  /* The saved record is an excerpt: it keeps the command and not what the
     command printed, because an archive of every tool's output does not belong
     in a person's settings file. But the window still HOLDS that output, so a
     row reopened five minutes later must still open onto it -- the richer copy
     wins for as long as there is one. */
  const body = sourceBetween(view, 'function mergeActionsIntoHistory', 'function persistTranscript')
  assert.match(body, /byMoment/, 'the buffer copy is never consulted, so every reopened row loses its output')
  assert.match(body, /richer \? \{ who: 'action', \.\.\.actionChatRow\(richer\) \} : savedActionRow/, 'the record copy wins over the one that still has the output')
})

test('an action row has a rule, and its opened body has one too', () => {
  assert.match(styles, /\.chat-action\b/, 'the action row has no rule; it paints as bare text like the reply bubbles did')
  assert.match(styles, /\.chat-action-detail\b/, 'the command has no rule of its own, so it cannot be truncated on one line')
})

test('an action row cannot be shrunk to a hairline by a scrolling log', () => {
  /* MEASURED on a staged packaged build, 2026-08-20 (and independently by a
     second lane on the sealed cut the same night): the log is a column flex
     container, .chat-action clips with overflow: hidden, and per flexbox an
     item whose overflow is not visible has an automatic minimum size of ZERO.
     So the moment a conversation scrolled — every real one — the negative
     free space was taken out of the only shrinkable items and every action
     row painted at ONE PIXEL: the whole context-window feature invisible,
     while the short-demo screenshots looked fine. flex: none is the row's
     existence; the overflow clip stays because the radius needs it. */
  const rule = sourceBetween(styles, '.chat-action {', '.chat-action-head {')
  assert.match(rule, /flex: none/, 'the row is shrinkable again; in any scrolled conversation it will paint at 1px')
  assert.match(rule, /overflow: hidden/, 'the clip is part of the mechanism this pin documents; if it moved, re-measure')
})

/* ---------------------------------------------------------------
   D1. A REFUSAL IS NOT A FAILURE, AND THE ROW HAS TO SAY WHICH.
   --------------------------------------------------------------- */

/* THE TWO SHAPES, COPIED OFF THE WIRE RATHER THAN IMAGINED.
 *
 * Measured 2026-08-20 on a real Codex/luna session in a staged packaged build,
 * through a read-only tap on the same preload channel the view subscribes to
 * (tools/context-window-drive.mjs). Both are commandExecution results and they
 * are structurally different, which is the whole reason this can be done
 * honestly rather than by matching the output prose:
 *
 *   refused   status "declined", exitCode -1
 *   failed    status "failed",   exitCode 1
 *
 * The refusal was `node --version` — a command that succeeds anywhere this
 * product runs — so the prompt carried its own positive control and there is no
 * reading of it in which the command merely went wrong.
 */
const declinedResult = {
  sessionId: 's1',
  event: {
    type: 'tool_result',
    turnId: 'turn-a',
    itemId: 'item-9',
    toolCallId: 'item-9',
    tool: 'commandExecution',
    payload: {
      status: 'declined',
      exitCode: -1,
      aggregatedOutput: '`"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command \'node --version\'` rejected: blocked by policy',
    },
  },
}
const failedResult = {
  sessionId: 's1',
  event: {
    type: 'tool_result',
    turnId: 'turn-a',
    itemId: 'item-10',
    toolCallId: 'item-10',
    tool: 'commandExecution',
    payload: {
      status: 'failed',
      exitCode: 1,
      aggregatedOutput: 'fatal: not a git repository (or any of the parent directories): .git\n',
    },
  },
}

test('a command that was never allowed to run does not read as one that failed', () => {
  /* "did not finish" says the command started and stopped short. These never
     started: the engine declined them before execution. A person looking at
     four identical red "did not finish" rows would go hunting a fault in their
     own commands, when what actually happened is that this computer would not
     let the agent run anything. */
  const buffer = createActionBuffer()
  buffer.add(sessionActivityEvent(declinedResult, 's1'), { turnId: 'turn-a' })
  const [row] = buffer.list()
  assert.notEqual(row.state, 'undone', 'a refusal is still filed as a failure')
  const words = actionRowWords(row)
  assert.notEqual(words.state, 'did not finish', 'the row still says the command failed to finish; it was never started')
  assert.notEqual(words.state, 'finished', 'a refusal was promoted to a success')
})

test('a command that really did fail still says so', () => {
  /* THE CONTROL, and it is the half that stops the fix over-reaching. If
     "declined" widened into "any non-zero exit", a genuinely broken command
     would start reading as a permission problem and send a person to the wrong
     place. git rev-parse in a folder that is not a repository is a real
     failure and must stay one. */
  const buffer = createActionBuffer()
  buffer.add(sessionActivityEvent(failedResult, 's1'), { turnId: 'turn-a' })
  const [row] = buffer.list()
  assert.equal(row.state, 'undone', 'a real command failure stopped reading as a failure')
  assert.equal(actionRowWords(row).state, 'did not finish')
})

test('the refusal is recognised by the field the engine sets, not by its prose', () => {
  /* The output text is the engine's own wording and will be rephrased without
     warning; `status` is the contract. A rule that read the sentence would be
     guessing at prose, which is the thing this codebase refuses to do. So the
     same status with no recognisable sentence in it must still be a refusal,
     and the same sentence with an ordinary status must not. */
  const buffer = createActionBuffer()
  buffer.add(sessionActivityEvent({
    ...declinedResult,
    event: { ...declinedResult.event, payload: { status: 'declined', exitCode: -1, aggregatedOutput: '' } },
  }, 's1'), { turnId: 'turn-a' })
  const [quiet] = buffer.list()
  assert.equal(actionRowWords(quiet).state, actionRowWords({ ...quiet }).state)
  assert.notEqual(quiet.state, 'undone', 'a refusal with no sentence in it was not recognised, so the rule is reading the prose')

  const other = createActionBuffer()
  other.add(sessionActivityEvent({
    ...failedResult,
    event: { ...failedResult.event, payload: { status: 'failed', exitCode: 1, aggregatedOutput: 'rejected: blocked by policy' } },
  }, 's1'), { turnId: 'turn-a' })
  assert.equal(other.list()[0].state, 'undone', 'a real failure whose output happens to contain the refusal sentence was misread as a refusal')
})

/* ---------------------------------------------------------------
   D2. A ROW STOPS SAYING "running" WHEN NOTHING IS RUNNING.
   --------------------------------------------------------------- */

test('a call whose result never arrived does not keep the word "running"', () => {
  /* SEEN BY THE COORDINATOR IN THE AFTER PICTURE, 2026-08-20, and it is a
     defect the row-height fix MADE VISIBLE rather than caused: third row down,
     `COMMAND Get-Content -Raw -Litera…  running`, green edge, on a turn that
     had ended long before. Before the rows were legible nobody could read the
     lie; that is not a reason to leave it.

     A call is filed `working` and only a RESULT moves it. When the turn ends
     without one -- the engine dropped it, the process died, the sandbox
     refused after the fact -- the row is frozen mid-sentence and the record
     keeps that word for ever, because recordTurnActions files row.state
     verbatim. */
  const buffer = createActionBuffer()
  const call = sessionActivityEvent({
    sessionId: 's1',
    event: {
      type: 'tool_call',
      turnId: 'turn-a',
      itemId: 'item-9',
      toolCallId: 'item-9',
      tool: 'commandExecution',
      payload: { command: 'Get-Content -Raw -LiteralPath C:/work/notes.md' },
    },
  }, 's1')
  const added = buffer.add(call, { turnId: 'turn-a' })
  assert.equal(added.row.state, 'working', 'a call that has not answered is not in flight; this test is measuring the wrong thing')

  const settled = buffer.settleUnfinished()
  assert.equal(settled.length, 1, 'the turn ended and nothing settled the row that was still in flight')
  assert.notEqual(added.row.state, 'working', 'the row still says it is running after the turn that owned it ended')
})

test('a result that never came is not promoted to a success', () => {
  /* THE TRAP THIS TEST EXISTS FOR. "finished" is the cheapest way to stop a row
     saying "running" and it is a lie of exactly the kind this whole night has
     been about: it turns an unknown into a success, silently, on a row a person
     is meant to be able to trust. It is not a failure either -- nobody measured
     the command failing. The only honest thing a row can say is that no result
     came back. */
  const buffer = createActionBuffer()
  buffer.add(sessionActivityEvent({
    sessionId: 's1',
    event: { type: 'tool_call', turnId: 'turn-a', itemId: 'item-9', toolCallId: 'item-9', tool: 'commandExecution', payload: { command: 'node --version' } },
  }, 's1'), { turnId: 'turn-a' })
  const [row] = buffer.settleUnfinished()

  const words = actionRowWords(row)
  assert.notEqual(words.state, 'finished', 'an unknown outcome was promoted to a success')
  assert.notEqual(words.state, 'running', 'the row still claims to be running')
  assert.match(words.state, /result/i, 'the settled word does not say the thing that is actually true: no result came back')
  /* And it must not borrow the failure word either -- nothing was measured
     failing, and a red row would send a person hunting a fault that may not
     exist. */
  assert.notEqual(row.state, 'undone', 'an unknown outcome was reported as a failure')
})

test('a result that arrives late still corrects its own row', () => {
  /* Settling is not a tombstone. If the engine is merely slow and the result
     turns up after the boundary, the row it belongs to must take it -- the
     join key is unchanged, so the ordinary update path has to keep working. */
  const buffer = createActionBuffer()
  buffer.add(sessionActivityEvent({
    sessionId: 's1',
    event: { type: 'tool_call', turnId: 'turn-a', itemId: 'item-9', toolCallId: 'item-9', tool: 'commandExecution', payload: { command: 'node --version' } },
  }, 's1'), { turnId: 'turn-a' })
  buffer.settleUnfinished()
  const late = buffer.add(sessionActivityEvent({
    sessionId: 's1',
    event: { type: 'tool_result', turnId: 'turn-a', itemId: 'item-9', toolCallId: 'item-9', tool: 'commandExecution', payload: { status: 'completed', exitCode: 0, aggregatedOutput: 'v22.19.0' } },
  }, 's1'), { turnId: 'turn-a' })
  assert.equal(late.change, 'updated', 'the late result opened a second row instead of answering the first')
  assert.equal(late.row.state, 'done', 'a settled row refuses the result it was waiting for')
})

test('the turn boundary settles the rows BEFORE it files them', () => {
  /* Order is the whole point: recordTurnActions writes `state: row.state` into
     the durable record, so a row settled after filing would be correct on
     screen and wrong for ever in the saved conversation. And the surfaces
     already on screen have to be told, or the row a person is looking at keeps
     the old word until something else repaints it. */
  const record = sourceBetween(view, 'function recordTurnActions', 'function savedActionRow')
  const settleAt = record.indexOf('settleUnfinished(')
  const fileAt = record.indexOf('row.recorded = true')
  assert.ok(settleAt !== -1, 'nothing settles the in-flight rows when the turn is filed')
  assert.ok(fileAt !== -1, 'the filing marker moved; re-read this test before trusting it')
  assert.ok(settleAt < fileAt, 'the rows are filed before they are settled, so the record keeps the word "running" for ever')
  assert.match(record, /broadcastAction\(/, 'the chat already on screen is never told, so it keeps showing "running"')
})

test('a command row shows the command, never fifty characters of shell wrapper', () => {
  /* MEASURED 2026-08-20: codex on Windows delivers every shell line as
     "C:\...\powershell.exe" -Command '...', so two different commands drew two
     visually identical rows. The summary strips a RECOGNISED wrapper only;
     the full line survives in the opened body and the hover title. */
  const wrapped = '"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command \'node --version\''
  assert.equal(commandSummary(wrapped), 'node --version')
  assert.equal(
    actionRowWords({ kind: 'call', tool: 'commandExecution', detail: wrapped, state: 'working', output: '' }).detail,
    'node --version',
  )
  assert.equal(commandSummary('bash -lc "ls -la"'), 'ls -la')
  assert.equal(commandSummary('cmd.exe /c dir'), 'dir')
  /* Anything not recognised comes back untouched: a path, a URL, a program
     whose name merely ends like a shell, a shell line with no command flag. */
  assert.equal(commandSummary('npm test'), 'npm test')
  assert.equal(commandSummary('C:/tools/publish.exe -c fast'), 'C:/tools/publish.exe -c fast')
  assert.equal(commandSummary('powershell.exe -File script.ps1'), 'powershell.exe -File script.ps1')
  assert.equal(commandSummary('https://example.org/a b'), 'https://example.org/a b')
})

test('the transcript column grows with the window, and stops growing', () => {
  /* THE DEFECT: `1fr minmax(320px, 400px)` gave every pixel past 1024 to the
     canvas and none to the words. Driven and measured 2026-08-20, the chat log
     came out 343px wide at 1024, at 1440 AND at 1920 -- a person who widened
     the window to read got more empty canvas and the same cut-off commands.
     The owner has now said twice that these windows are not coming out nicely
     enough, and a column that ignores 900px of screen is part of why.

     BOTH BOUNDS ARE THE TEST. Growing without a ceiling is the opposite
     mistake: past about 75 characters a line the eye loses the start of the
     next one, so a 1200px column on a 2560px screen reads worse than this bug
     did. And the floor has to stay where it is or 1024 -- the owner's stated
     minimum -- loses canvas to pay for it. */
  const rule = styles.slice(styles.indexOf('.comp-body {'), styles.indexOf('.comp-body {') + 400)
  const columns = /grid-template-columns:([^;]+);/.exec(rule)
  assert.ok(columns, 'the two-column rule moved; re-read this test before trusting it')
  assert.match(columns[1], /minmax\(\s*320px\s*,/, 'the rail floor moved; the stacked breakpoint and the 1024 layout are both sized from it')
  assert.match(columns[1], /clamp\(/, 'the rail is a fixed maximum again, so the transcript cannot grow with the window')
  const ceiling = /clamp\(\s*400px\s*,[^,]+,\s*(\d+)px\s*\)/.exec(columns[1])
  assert.ok(ceiling, 'the growth rule is not clamp(floor, fraction, ceiling); it must keep a floor AND a ceiling')
  const max = Number(ceiling[1])
  assert.ok(max > 400, `the ceiling ${max}px is no wider than the old fixed width, so nothing grows`)
  assert.ok(max <= 700, `the ceiling ${max}px is past the readable line length; a wider column reads worse, not better`)
})

test('the action rows use the mono token that exists', () => {
  /* var(--mono, …) referenced a token that never existed — the third
     silent-invalid instance of it found in this stylesheet — so the rows
     rendered in the var() fallback face, visibly different from every other
     mono surface. */
  assert.ok(!/var\(--mono[,)]/.test(styles), 'something still reads --mono, a token no rule defines')
})

test('a row that opens says so, and a bare row does not pretend to', () => {
  /* A restored conversation keeps the command and not its output, and those
     bare rows refused a press in silence — a control that lies about being a
     control. The disclosure mark is the difference, and its space is held on
     bare rows so the columns stay aligned. */
  assert.match(door, /chat-action-mark/, 'no disclosure mark; expandable and bare rows draw identically')
  assert.match(styles, /\.chat-action\[open\] > \.chat-action-head > \.chat-action-mark svg[^}]*rotate/, 'the row\'s own disclosure mark must turn when it opens')
  assert.doesNotMatch(styles, /\.chat-action\[open\] \.chat-action-mark svg/, 'an open run must not rotate the marks of its still-closed nested calls')
  assert.match(styles, /\.chat-action\.is-bare \.chat-action-mark[^}]*visibility: hidden/, 'a bare row still presents itself as pressable')
})

/* ---------------------------------------------------------------
   E. The view: keeps everything it did, and adds the rows.
   --------------------------------------------------------------- */

test('the activity branch keeps the status line and the chip it always had', () => {
  const body = sourceBetween(view, 'const activity = sessionActivityEvent(packet, sessionId)', 'const status = sessionTurnStatus(packet, sessionId)')
  assert.match(body, /nodeActivity\.set\(nodeId, line\)/, 'the one-line activity record was removed rather than added to')
  assert.match(body, /data-tree-activity/, 'the rail Details line stopped being written')
  assert.match(body, /scheduleChipRefresh\(nodeId\)/, 'the canvas chip stopped being refreshed')
})

test('and it now files the action where a person can read it later', () => {
  const body = sourceBetween(view, 'const activity = sessionActivityEvent(packet, sessionId)', 'const status = sessionTurnStatus(packet, sessionId)')
  assert.match(body, /actionBufferFor\(sessionId\)/, 'nothing keeps the action, so a chat opened mid-turn shows none of them')
  assert.match(body, /broadcastAction\(/, 'the open chat is never told; the rows only appear on a reopen')
  assert.match(body, /foldedActionsLine\(/, 'the per-turn cap is silent; a person is never told there was more')
})

test('the record is written once per TURN, never once per tool event', () => {
  /* A busy turn emits thousands of tool events, and every append writes the
     whole record to storage. Filing per event would put a hundreds-of-kilobyte
     write on the main thread between every command an agent runs. */
  const body = sourceBetween(view, 'const activity = sessionActivityEvent(packet, sessionId)', 'const status = sessionTurnStatus(packet, sessionId)')
  assert.ok(!/transcriptAppend\(/.test(body), 'the activity branch writes the durable record on every tool event')
  const record = sourceBetween(view, 'function recordTurnActions', 'function savedActionRow')
  assert.match(record, /transcriptAppend\(sessionId, \{[\s\S]{0,120}who: 'action'/, 'the action is not recorded, so it is gone at the next restart')
  assert.match(record, /\{ persist: false \}/, 'each filed action writes the whole record again')
  assert.match(record, /row\.recorded = true/, 'rows are filed twice, so a restart shows the same command over and over')
  assert.match(record, /TRANSCRIPT_LIMITS\.maxActionLines/, 'the record takes every action a turn produced, unbounded')
  /* And it is called where the words are filed -- both endings a turn has. */
  const settle = sourceBetween(view, 'function settleTurnBoundary', 'function transcriptAppend')
  assert.match(settle, /recordTurnActions\(sessionId\)/, 'a turn that ended without a completion loses its actions')
  /* LANDMARK-BOUNDED, NOT CHARACTER-DISTANCE-BOUNDED, 2026-08-28: a fixed
     .slice(0, 4000) window broke under a legitimate insertion earlier in the
     completion branch (B3's turnStamp wiring) even though recordTurnActions()
     was still called exactly where it always was. `const queuedNext =
     outboxTakeNext(sessionId)` is the branch's own last statement before the
     packet handler closes, so this now pins the mechanism -- the completion
     branch calls recordTurnActions() -- to its real structural scope. */
  const completion = view.slice(view.indexOf('const status = sessionTurnStatus(packet, sessionId)'), view.indexOf('const queuedNext = outboxTakeNext(sessionId)'))
  assert.match(completion, /recordTurnActions\(sessionId\)/, 'a completed turn loses its actions')
})

test('the chat a person opens mid-turn already shows what has been done', () => {
  const config = sourceBetween(view, 'function treeChatConfigFor', 'function chatActionRowsFor')
  assert.match(config, /mergeActionsIntoHistory\(/, 'a chat opened mid-turn shows the conversation with the work missing from it')
})

test('the two surfaces are told the same way the words are', () => {
  /* The delta branch already pushes to the rail chat AND the open card. An
     action that reached only one of them would be the drift this config
     builder exists to prevent. */
  assert.match(view, /function broadcastAction\(/, 'each surface is told separately; they will drift')
  const broadcast = view.slice(view.indexOf('function broadcastAction('))
  assert.match(broadcast.slice(0, 1200), /isConnected/, 'a chat that has been closed is still written to, which is a retained view')
})
