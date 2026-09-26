'use strict'

/* AN ENGINE WITH A REAL CHILD PROCESS BEHIND IT, so that "the child's own exit"
 * is a genuine operating-system event and not a stub calling a callback.
 *
 * WHY THIS EXISTS. The run ledger records a session's ending, and one of the two
 * genuine endings is the engine's child process going away on its own -- not
 * closed by the person, not closed by the app. Nothing in the shell can observe
 * that except through the process the engine started, so proving the recorder
 * means starting a process and letting it stop. This fixture starts one: a Node
 * child (this executable, re-entered as Node) that lives until it is told to
 * finish, or until MC_TEST_EXIT_AFTER_MS elapses, and then exits by itself.
 *
 * WHAT IT IS NOT, said plainly so no report can overstate it. It is not a model
 * and it answers nothing. Its turns are scripted: the first turn on a session
 * completes quickly and says so in the codex engine's own word (`completed`);
 * every later turn speaks once and then stays open, so a person has a running
 * turn to stop from the interface. What it proves is that the PRODUCT writes
 * down how a session ended, from the process it really started, through
 * shell/agent-host.cjs and shell/main.cjs to the signed record. Whether a real
 * engine's child exits at any particular moment is a fact about that engine.
 *
 * THE HANDLE SHAPE IS THE CLAUDE ENGINE'S. The vendored Claude transport exposes
 * its ChildProcess as `transport.child` (capability/src/lib/agent-engine/
 * claude-cli-process.js, createClaudeCliTransport); the shell observes an exit
 * through exactly that handle, so this fixture exposes the same one. The codex
 * shape (a multi-listener transport.onData that delivers `(null, exitInfo)`) is
 * covered by a unit test against the vendored transport itself.
 */

const { spawn } = require('node:child_process')

let turnCount = 0

/* How long the child lives before ending itself, or forever when unset. Read at
   spawn time so a driver can set it per launch. */
function exitAfterMs() {
  const raw = process.env.MC_TEST_EXIT_AFTER_MS
  const value = raw === undefined ? NaN : Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : null
}

/* What the child runs: wait for the parent to close stdin, or for the timer,
   then exit with the code the driver named (default 0). Written as a script
   string so the fixture needs no second file. */
function childScript(afterMs, code) {
  return [
    `const after = ${JSON.stringify(afterMs)};`,
    `const code = ${JSON.stringify(code)};`,
    'process.stdin.resume();',
    'process.stdin.on("end", () => process.exit(code));',
    'process.stdin.on("close", () => process.exit(code));',
    'if (after !== null) setTimeout(() => process.exit(code), after);',
  ].join('\n')
}

async function startCodexSession(options) {
  const onEvent = options && typeof options.onEvent === 'function' ? options.onEvent : null
  const timers = new Set()
  let closed = false

  const exitCode = Number.isSafeInteger(Number(process.env.MC_TEST_EXIT_CODE)) ? Number(process.env.MC_TEST_EXIT_CODE) : 0
  /* THIS EXECUTABLE, RE-ENTERED AS NODE. In a packaged app process.execPath is
     the product's own .exe, and starting it plain would open a second copy of
     the product; ELECTRON_RUN_AS_NODE makes it a Node runtime instead, which is
     exactly what the vendored codex-process.js does for the same reason.
     windowsHide, because a console window on a person's desktop is a defect
     this project has already paid for. */
  const child = spawn(process.execPath, ['-e', childScript(exitAfterMs(), exitCode)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'ignore', 'ignore'],
    windowsHide: true,
  })

  const later = (ms, event) => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      if (closed || !onEvent) return
      onEvent(event)
    }, ms)
    timers.add(timer)
  }

  return {
    adapter: {
      sendTurn: async () => {
        turnCount += 1
        const turnId = `turn-exiting-${turnCount}`
        later(80, { type: 'assistant_text_delta', turnId, text: turnCount === 1 ? 'Done.' : 'Working on it' })
        /* The first turn ends, in the engine's own word. Later turns stay open
           so the interface has a running agent to stop. */
        if (turnCount === 1) later(600, { type: 'turn_completed', turnId, status: 'completed' })
        return { turnId }
      },
      interrupt: async () => {},
      answerApproval: () => {},
      forkThread: async () => ({ threadId: 'thread-exiting-forked' }),
      transport: { child },
    },
    threadId: 'thread-exiting-1',
    close() {
      closed = true
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      try { child.stdin.end() } catch { /* already gone */ }
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill() } catch { /* already gone */ }
      }
      /* A close that KILLS THE CHILD AND THEN FAILS, so a test can stand in the
         one place the host keeps a closed-requested session in its map (state
         `close-failed`) while the child it asked to stop goes on to exit. That
         exit is the close's doing, not the child's own, and must not be
         reported as one. */
      if (process.env.MC_TEST_CLOSE_THROWS === '1') {
        const error = new Error('the fixture close failed after killing its child')
        error.code = 'FIXTURE_CLOSE_FAILED'
        throw error
      }
    },
  }
}

module.exports = { startCodexSession }
