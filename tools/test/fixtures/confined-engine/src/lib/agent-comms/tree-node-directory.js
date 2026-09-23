'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/* A deliberately small test double for the app host's payload seam.
 *
 * The engine repository tests the real durable directory. This fixture exists
 * to prove the other half: shell/agent-host.cjs actually loads the two payload
 * modules, registers the address carried by the first turn, polls the inbox,
 * and hands an arrival to the receiving session. Keeping the double here lets
 * that test use the same confined fake engine as the rest of the host suite
 * without starting a provider process. */
/* THE THREE PARTS OF THE REAL MODULE A RESUME DEPENDS ON ARE MIRRORED HERE,
 * because a double that lacks them cannot fail the way production failed.
 * src/lib/agent-comms/tree-node-directory.js in the engine repository:
 *   - registerNode() stores the engine `threadId` beside the row;
 *   - unregisterNode() STAMPS `stoppedAt` and KEEPS the row, so a circle that
 *     was stopped is still findable by the thread it ran;
 *   - findByThreadId() answers the newest row that ran a thread, live or
 *     stopped, or null.
 * The old double dropped the thread and deleted stopped rows, which made every
 * resume look like a thread the directory had never seen. */
const nodes = []
/* How many of the next registrations refuse, and with which code. The real
   directory refuses a read it cannot trust -- a malformed file, a wrong schema
   -- and the host has to survive that happening at the one moment a brief
   arrives. Zero by default, so every other test sees the old fixture. */
const refusals = { remaining: 0, code: 'TREE_DIRECTORY_MALFORMED' }
let clock = 0
/* W22. How many times the next registerNode/heartbeatNode call should call
   its injected `lockSleep`, simulating a contended mutation lock's retry
   loop -- zero by default, so every other test sees the old fixture and
   this double stays a double, not a re-implementation of live-engine's real
   lock. Exists solely so tools/test/tree-courier-main-lag-attribution.test.mjs
   can prove agent-host.cjs's injected lockSleep/fsImpl are really invoked
   and really timed, without this repository depending on live-engine's path
   (which would be a hardcoded path outside this repo). */
let simulatedLockRetries = 0
function setSimulatedLockRetries(count) { simulatedLockRetries = count }

function agentIdForSession(sessionId) {
  return `fixture-${String(sessionId)}`
}

function failNextRegistrations(count, code = 'TREE_DIRECTORY_MALFORMED') {
  refusals.remaining = count
  refusals.code = code
}

function registrationAttempts() {
  return attempts.slice()
}

/* What the directory ended up holding, readable without a host instance. */
function listNodes() {
  return nodes.map(node => ({ ...node }))
}

const attempts = []
/* How many times the host has said each session is still running. The real
   directory turns a lapsed heartbeat into "no longer running" after its live
   window, so a host that stops beating is a host whose circles go dark. */
const heartbeats = new Map()

function heartbeatCount(sessionId) {
  return heartbeats.get(sessionId) || 0
}

function normalizeThreadId(threadId) {
  return typeof threadId === 'string' && threadId.length > 0 ? threadId : null
}

/* W22. `lockSleep`/`fsImpl` mirror the real module's own injectable options
   (see live-engine's tree-node-directory.js `createTreeNodeDirectory({
   lockSleep = sleepSync, fsImpl = fs, ... })`) so a caller instrumenting them
   -- shell/agent-host.cjs's loadTreeMessaging() -- gets real calls to spy on
   here, not silently-ignored arguments. */
function createTreeNodeDirectory({ lockSleep = () => {}, fsImpl = null } = {}) {
  function simulateLockWait() {
    for (let i = 0; i < simulatedLockRetries; i++) lockSleep(5)
  }
  function touchFsImpl() {
    if (!fsImpl) return
    const file = path.join(os.tmpdir(), `t5w22-fixture-directory-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`)
    try {
      fsImpl.writeFileSync(file, 'fixture')
      if (typeof fsImpl.fsyncSync === 'function') {
        const handle = fs.openSync(file, 'r+')
        try { fsImpl.fsyncSync(handle) } finally { fs.closeSync(handle) }
      }
      fsImpl.readFileSync(file, 'utf8')
    } finally {
      try { fs.unlinkSync(file) } catch { /* best effort, throwaway file */ }
    }
  }
  return Object.freeze({
    registerNode({ sessionId, nodeName, managerName = null, pid = null, threadId = null, treeKey = null } = {}) {
      simulateLockWait()
      touchFsImpl()
      attempts.push({ sessionId, nodeName, managerName })
      if (refusals.remaining > 0) {
        refusals.remaining -= 1
        const error = new Error(`fixture refusal: ${refusals.code}`)
        error.code = refusals.code
        throw error
      }
      clock += 1
      const entry = Object.freeze({
        agentId: agentIdForSession(sessionId),
        sessionId,
        nodeName,
        managerName,
        pid,
        threadId: normalizeThreadId(threadId),
        /* The fourth mirrored part: the real module keeps the tree a circle is
           on (`treeKey`) so two trees using the same role names are told apart.
           Kept here so a test can see which tree the host registered under. */
        treeKey: typeof treeKey === 'string' && treeKey.length > 0 ? treeKey : null,
        registeredAt: clock,
        stoppedAt: null,
      })
      const prior = nodes.findIndex(node => node.sessionId === sessionId)
      if (prior >= 0) nodes.splice(prior, 1)
      nodes.push(entry)
      return entry
    },
    heartbeatNode({ sessionId } = {}) {
      simulateLockWait()
      touchFsImpl()
      heartbeats.set(sessionId, heartbeatCount(sessionId) + 1)
      return Object.freeze({ found: nodes.some(node => node.sessionId === sessionId) })
    },
    bindThread({ sessionId, threadId } = {}) {
      const thread = normalizeThreadId(threadId)
      if (!thread) {
        const error = new Error('A thread id must be a non-empty string of at most 512 characters.')
        error.code = 'TREE_THREAD_INVALID'
        throw error
      }
      let found = false
      for (let index = 0; index < nodes.length; index += 1) {
        if (nodes[index].sessionId !== sessionId) continue
        found = true
        nodes[index] = Object.freeze({ ...nodes[index], threadId: thread })
      }
      return Object.freeze({ agentId: agentIdForSession(sessionId), found })
    },
    findByThreadId(threadId) {
      const thread = normalizeThreadId(threadId)
      if (!thread) return null
      const matches = nodes.filter(node => node.threadId === thread)
      if (matches.length === 0) return null
      matches.sort((left, right) => right.registeredAt - left.registeredAt)
      return Object.freeze({ ...matches[0] })
    },
    unregisterNode({ sessionId } = {}) {
      let removed = false
      for (let index = 0; index < nodes.length; index += 1) {
        if (nodes[index].sessionId !== sessionId) continue
        removed = true
        clock += 1
        nodes[index] = Object.freeze({ ...nodes[index], stoppedAt: clock })
      }
      return Object.freeze({ removed })
    },
    listNodes() {
      return nodes.map(node => Object.freeze({ ...node }))
    },
  })
}

function reset() {
  nodes.splice(0, nodes.length)
  attempts.splice(0, attempts.length)
  heartbeats.clear()
  refusals.remaining = 0
  refusals.code = 'TREE_DIRECTORY_MALFORMED'
  clock = 0
  simulatedLockRetries = 0
}

module.exports = Object.freeze({
  agentIdForSession,
  createTreeNodeDirectory,
  failNextRegistrations,
  heartbeatCount,
  listNodes,
  setSimulatedLockRetries,
  registrationAttempts,
  reset,
})
