'use strict'

/* THE SAME FIXTURE ENGINE AS codex-process.js BESIDE IT, PLUS A CHILD THAT CAN
 * DIE ON ITS OWN.
 *
 * WHY IT IS A SEPARATE FILE. observeEngineExit() in shell/agent-host.cjs only
 * subscribes when the started value carries `adapter.transport.child`; the
 * plain fixture carries none, so on it a session can only ever end the way the
 * person ends it -- closeSession(). That is exactly the case that must NOT be
 * reported to a worker as its manager failing, so a suite that has only that
 * lever cannot tell the two endings apart at all. Adding a transport to the
 * shared fixture would change what forty-nine other suites are standing on;
 * this sits beside it, in the same directory so `engineRoot` resolves to the
 * same fixture payload, and nothing that does not name it is affected.
 *
 * It starts no process. `child` is an EventEmitter and exitAt(index) is the
 * test saying "that one's provider is gone now", which is the one thing a real
 * OS child does that a stub otherwise cannot. INDEXED BY START ORDER, because
 * the host hands the engine no session id -- calls[n] and children[n] are the
 * same start, which is the same pairing every other fixture assertion in this
 * tree already relies on.
 */

const { EventEmitter } = require('node:events')

const calls = []
const adapterCalls = []
const children = []

function adapter() {
  const child = new EventEmitter()
  child.exitCode = null
  child.signalCode = null
  children.push(child)
  return {
    transport: { child },
    sendTurn: async request => { adapterCalls.push({ method: 'sendTurn', request }); return { turnId: 't1' } },
    steerTurn: async request => { adapterCalls.push({ method: 'steerTurn', request }); return { threadId: request.threadId, turnId: request.turnId } },
    interrupt: async request => { adapterCalls.push({ method: 'interrupt', request }) },
    answerApproval: answer => { adapterCalls.push({ method: 'answerApproval', answer }) },
    forkThread: async (threadId, forkOptions) => {
      adapterCalls.push({ method: 'forkThread', threadId, forkOptions })
      return { threadId: 'thread-forked' }
    },
  }
}

async function startCodexSession(options) {
  calls.push(options)
  return { adapter: adapter(), threadId: 'thread-1', close() {} }
}

async function resumeCodexSession(options) {
  calls.push({ resumed: true, ...options })
  return {
    adapter: adapter(),
    threadId: (options && options.threadId) || 'thread-resumed',
    resumed: { turns: [], turnCount: 0 },
    close() {},
  }
}

/* The provider for this session goes away without anybody asking it to. */
function exitAt(index, { code = 1, signal = null } = {}) {
  const child = children[index]
  if (!child) return false
  child.exitCode = code
  child.signalCode = signal
  child.emit('exit', code, signal)
  return true
}

function reset() {
  calls.length = 0
  adapterCalls.length = 0
  children.length = 0
}

module.exports = { startCodexSession, resumeCodexSession, calls, adapterCalls, children, exitAt, reset }
