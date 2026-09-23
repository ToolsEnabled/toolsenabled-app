'use strict'

/* AN ENGINE THAT DOES THINGS AND SAYS SO -- a turn with tools in it, narrated
 * over the product's own wiring.
 *
 * WHY THIS EXISTS. The chat log had to be shown carrying what an agent DOES,
 * not only what it says, and the acceptance for that is a turn arriving through
 * the real path: engine -> shell/agent-host.cjs -> shell/main.cjs -> the
 * preload's mc-agent:event -> the renderer's activity branch -> a row in the
 * chat. Nothing above the host may be stubbed for that to mean anything, and
 * nothing here stubs it: every packet below is emitted through the host's own
 * `onEvent`, in the exact shapes the two real adapters emit
 * (capability/src/lib/agent-engine/codex-adapter.js and claude-cli-adapter.js).
 *
 * WHAT IT IS NOT, said plainly so no report can overstate it. This is not a
 * model. It reasons about nothing and answers no question; it replays a
 * fixed turn -- some words, a command, that command's result, more words, a
 * file read, its result, then a completion -- on a timer. What it proves is
 * that the PRODUCT carries a turn's actions from the wire to the glass and to
 * the saved record. Whether a model would have chosen those commands is a
 * question for a real engine, and this fixture cannot answer it.
 *
 * WHY A FIXTURE RATHER THAN THE REAL ENGINE. Both are worth running; this one
 * is the one that can be run on demand. It needs no subscription, no network,
 * no quota and no sign-in, so the same turn is reproducible on any machine, and
 * a lane whose provider quota is spent can still hold this behaviour shut.
 *
 * BOTH ENGINE SHAPES, IN ONE TURN, DELIBERATELY. codex names its tool calls
 * with an item id and puts the command and the exit code in the payload; the
 * Claude CLI names them with a tool_use_id, puts the tool's own name on the
 * event ("Read"), passes the tool's input through as the payload, and puts the
 * outcome on the EVENT rather than in the payload. The renderer has to join a
 * result to its call for both, so both are narrated here.
 */

/* EVERY TURN GETS ITS OWN NAME, AND ITS TOOL CALLS TOO -- as a real engine
 * does. An earlier version of this fixture reused one turn id for every send,
 * and a second turn's tool calls then carried ids a surface had already seen,
 * so they were correctly folded into the first turn's rows and no new row
 * appeared. That is a fixture that cannot answer the question it was built for.
 */
let turnCount = 0

/* HOW LONG THE TURN TAKES, AND WHY IT IS NOT INSTANT.
 *
 * A real turn with commands in it runs for minutes; this one runs for about
 * four seconds. Both numbers are deliberate. Not instant, because a turn that
 * arrived in a single tick would let a renderer that batches badly still look
 * correct -- and because the question "can a person open a row onto what the
 * command printed" is only answerable WHILE the turn is running: once it ends,
 * its rows are filed into the saved record and redrawn from there, and the
 * record keeps the command and not its output. A turn measured in tens of
 * milliseconds leaves no window to look in, and a driver that tried reported
 * the rows as bodiless. */
const SPEED = 4

/* The turn, as a script. Each step is [delay in ms, event]. */
function turnScript(TURN_ID, seq) {
  return [
    [40, { type: 'assistant_text_delta', turnId: TURN_ID, text: 'Checking the tests' }],
    [40, { type: 'assistant_text_delta', turnId: TURN_ID, text: ' first.' }],
    [60, {
      type: 'tool_call',
      turnId: TURN_ID,
      itemId: `item-cmd-1-${seq}`,
      toolCallId: `item-cmd-1-${seq}`,
      tool: 'commandExecution',
      payload: { command: 'npm test --silent', cwd: 'C:/work/research-app' },
    }],
    [220, {
      type: 'tool_result',
      turnId: TURN_ID,
      itemId: `item-cmd-1-${seq}`,
      toolCallId: `item-cmd-1-${seq}`,
      tool: 'commandExecution',
      payload: { status: 'completed', exitCode: 0, aggregatedOutput: '2295 tests, 0 failures' },
    }],
    /* The Claude CLI's shape: the tool's own name, its input as the payload,
       and a tool_use_id that pairs the two. */
    [60, {
      type: 'tool_call',
      turnId: TURN_ID,
      toolCallId: `toolu_read_1-${seq}`,
      tool: 'Read',
      payload: { file_path: 'C:/work/research-app/src/components.js' },
    }],
    [180, {
      type: 'tool_result',
      turnId: TURN_ID,
      toolCallId: `toolu_read_1-${seq}`,
      tool: 'Read',
      text: 'export function buildChat(...) { ... }',
      status: 'ok',
    }],
    /* One that did NOT go well, because a row that can only ever say "finished"
       is a row nobody has to trust. */
    [60, {
      type: 'tool_call',
      turnId: TURN_ID,
      itemId: `item-cmd-2-${seq}`,
      toolCallId: `item-cmd-2-${seq}`,
      tool: 'commandExecution',
      payload: { command: 'node tools/does-not-exist.mjs', cwd: 'C:/work/research-app' },
    }],
    [180, {
      type: 'tool_result',
      turnId: TURN_ID,
      itemId: `item-cmd-2-${seq}`,
      toolCallId: `item-cmd-2-${seq}`,
      tool: 'commandExecution',
      payload: { status: 'failed', exitCode: 1, aggregatedOutput: 'Cannot find module' },
    }],
    [60, { type: 'assistant_text_delta', turnId: TURN_ID, text: ' The suite is green' }],
    [40, { type: 'assistant_text_delta', turnId: TURN_ID, text: ' and one script is missing.' }],
    [80, { type: 'turn_completed', turnId: TURN_ID, status: 'completed' }],
  ]
}

/* How many steps this turn has, and how many of them are actions, so a driver
   can assert against the script rather than against a number it typed twice. */
const SCRIPT_FACTS = Object.freeze({
  actions: 6,
  rows: 3,
})

async function startCodexSession(options) {
  const onEvent = options && typeof options.onEvent === 'function' ? options.onEvent : null
  const timers = new Set()
  let closed = false

  const narrate = (TURN_ID, seq) => {
    let at = 0
    for (const [wait, event] of turnScript(TURN_ID, seq)) {
      at += wait * SPEED
      const timer = setTimeout(() => {
        timers.delete(timer)
        if (closed || !onEvent) return
        onEvent(event)
      }, at)
      timers.add(timer)
    }
  }

  return {
    adapter: {
      /* Answered at once with the turn's name, the way the codex adapter does,
         and the turn's events follow. */
      sendTurn: async () => {
        turnCount += 1
        const turnId = `turn-narrated-${turnCount}`
        narrate(turnId, turnCount)
        return { turnId }
      },
      interrupt: async () => {},
      answerApproval: () => {},
      forkThread: async () => ({ threadId: 'thread-narrated-forked' }),
    },
    threadId: 'thread-narrated-1',
    close() {
      closed = true
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
    },
  }
}

module.exports = { startCodexSession, SCRIPT_FACTS }
