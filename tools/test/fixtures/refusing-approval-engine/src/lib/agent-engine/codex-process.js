'use strict'

/* AN ENGINE WHOSE answerApproval REFUSES, THE REAL CLAUDE CLI SHAPE.
 *
 * The vendored Claude CLI adapter (engine src/lib/agent-engine/
 * claude-cli-adapter.js) declares:
 *
 *   async answerApproval(answer) {
 *     validateApprovalAnswer(answer)
 *     throw new ClaudeCliError('CLAUDE_CLI_APPROVALS_UNSUPPORTED', ...)
 *   }
 *
 * unconditionally -- approvals are not wired for that engine, so every call
 * refuses. Because the method is declared `async`, calling it does not throw
 * SYNCHRONOUSLY: the call returns an already-rejected promise. This fixture
 * reproduces exactly that shape, with no process behind it, so a test can
 * drive shell/agent-host.cjs's answerApproval() against an adapter that
 * genuinely refuses rather than one that merely records a call.
 *
 * sendTurn/interrupt/forkThread are inert stubs: validateStartedSession()
 * requires sendTurn and interrupt to be functions, and nothing in the test
 * that uses this fixture calls any of the three. */
async function startCodexSession() {
  return {
    adapter: {
      sendTurn: async () => ({ turnId: 'turn-refusing-1' }),
      interrupt: async () => {},
      answerApproval: async () => {
        const error = new Error('This Claude session does not ask for approvals; its permission level is fixed when it starts.')
        error.code = 'FIXTURE_APPROVALS_UNSUPPORTED'
        throw error
      },
      forkThread: async () => ({ threadId: 'thread-refusing-forked' }),
    },
    threadId: 'thread-refusing-1',
    close() {},
  }
}

module.exports = { startCodexSession }
