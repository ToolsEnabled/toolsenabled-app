'use strict'

const { createHash, randomUUID } = require('node:crypto')
const MAX_STOP_BYTES = 4096
const MAX_OPERATIONS = 64
const COMPLETED_TTL_MS = 30 * 60 * 1000
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 128
  && /^[a-z0-9][a-z0-9._:/-]*$/i.test(value)
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const fail = code => { throw Object.assign(new Error(code), { code }) }
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const code = (error, fallback) => typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,127}$/.test(error.code) ? error.code : fallback
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length
  && Object.keys(value).every(key => keys.includes(key))

function normalizeDesktopStopRequest(value) {
  if (!exactKeys(value, ['requestId', 'target']) || !uuid(value.requestId)
      || !exactKeys(value.target, ['version', 'treeId', 'nodeId', 'sessionId', 'revision'])
      || value.target.version !== 1 || !['treeId', 'nodeId', 'sessionId'].every(key => identifier(value.target[key]))
      || typeof value.target.revision !== 'string' || !/^[a-f0-9]{64}$/.test(value.target.revision)
      || Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_STOP_BYTES) fail('MC_AGENT_DESKTOP_STOP_INVALID')
  return Object.freeze({ requestId: value.requestId, target: Object.freeze({ version: 1,
    treeId: value.target.treeId, nodeId: value.target.nodeId, sessionId: value.target.sessionId, revision: value.target.revision }) })
}

const sameAuthority = (a, b) => ['owner', 'ticket', 'epoch', 'deviceId', 'pairId'].every(key => a[key] === b[key])

/* Main-process-only operation journal. Admission dependencies are the existing
   paired-desktop checks; the private native handler redeems its own close lease.
   Neither a target digest nor a request ID is an authority grant. */
function createNativeDesktopStop(deps, { now = Date.now, runtimeId = randomUUID(), maxOperations = MAX_OPERATIONS,
  completedTtlMs = COMPLETED_TTL_MS } = {}) {
  for (const name of ['readTree', 'sessionFor', 'assertContext', 'checkContext']) {
    if (typeof deps[name] !== 'function') throw new TypeError(`Native Stop requires ${name}`)
  }
  if (!identifier(runtimeId) || !Number.isSafeInteger(maxOperations) || maxOperations < 1 || maxOperations > MAX_OPERATIONS
      || !Number.isSafeInteger(completedTtlMs) || completedTtlMs < 1 || completedTtlMs > COMPLETED_TTL_MS) throw new TypeError('Invalid native Stop bounds')
  const instances = new WeakMap()
  const operations = new Map()
  const stopping = new WeakMap()
  const ready = session => deps.handler?.ready?.(session) === true

  function savedBinding(sessionId, session, tree = deps.readTree()) {
    const node = tree?.nodes?.find(item => item.sessionId === sessionId && item.id === session.treeNodeId)
    const savedTree = node && tree?.trees?.find(item => item.id === node.treeId)
    if (tree?.computerId !== 'this-computer' || !node || !savedTree || !identifier(node.id) || !identifier(node.treeId)
        || (node.parentId !== null && !identifier(node.parentId)) || typeof node.createdAt !== 'string' || !node.createdAt
        || typeof savedTree.createdAt !== 'string' || !savedTree.createdAt) fail('MC_AGENT_DESKTOP_STOP_STALE_TARGET')
    if (!instances.has(session)) instances.set(session, randomUUID())
    const revision = digest([1, runtimeId, node.id, node.treeId, node.parentId, node.createdAt, savedTree.createdAt,
      sessionId, instances.get(session)])
    return { session, node, target: Object.freeze({ version: 1, treeId: node.treeId, nodeId: node.id, sessionId, revision }) }
  }
  function binding(sessionId, context, expectedSession = null, tree = undefined) {
    deps.assertContext(context, true)
    const session = deps.sessionFor(sessionId, context, expectedSession)
    if (!ready(session)) fail('MC_AGENT_DESKTOP_STOP_UNAVAILABLE')
    return savedBinding(sessionId, session, tree)
  }

  function targetFor(sessionId, context) {
    try { return binding(sessionId, context).target } catch { return null }
  }
  function targetsFor(sessionIds, context) {
    const targets = new Map()
    let tree
    try { deps.assertContext(context, true); tree = deps.readTree() } catch { return targets }
    for (const id of sessionIds) {
      try { targets.set(id, binding(id, context, null, tree).target) } catch {}
    }
    return targets
  }
  const receipt = operation => Object.freeze({ ...operation.receipt, target: operation.request.target })
  function prune() {
    for (const [id, operation] of operations) {
      if (operation.finishedAt !== null && now() - operation.finishedAt >= completedTtlMs) operations.delete(id)
    }
  }
  function find(requestId, context) {
    const operation = operations.get(requestId)
    if (!operation || !sameAuthority(operation.context, context)) fail('MC_AGENT_DESKTOP_STOP_RECEIPT_UNAVAILABLE')
    return operation
  }
  function refused(operation, error) {
    operation.receipt = { ok: false, requestId: operation.request.requestId, outcome: 'not-sent', state: 'refused',
      closed: false, savedState: 'pending', code: code(error, 'MC_AGENT_DESKTOP_STOP_UNAVAILABLE') }
    operation.finishedAt = now()
    if (stopping.get(operation.session) === operation) stopping.delete(operation.session)
  }
  function complete(operation, result) {
    if (result?.outcome === 'not-sent' && result.closed !== true) { refused(operation, result); return }
    const closed = result?.closed === true
    const saved = closed && result?.savedState === 'recorded'
    operation.receipt = { ok: true, requestId: operation.request.requestId,
      state: saved ? 'completed' : 'needs-attention', closed, savedState: saved ? 'recorded' : closed ? 'unconfirmed' : 'pending',
      ...(saved ? {} : { code: closed ? 'MC_AGENT_DESKTOP_STOP_SAVE_PENDING' : 'AGENT_STOP_PENDING' }) }
    if (saved) {
      operation.finishedAt = now()
      if (stopping.get(operation.session) === operation) stopping.delete(operation.session)
    }
  }
  async function start(value, context) {
    const request = normalizeDesktopStopRequest(value)
    deps.assertContext(context, true)
    prune()
    if (operations.has(request.requestId)) {
      const prior = find(request.requestId, context)
      if (prior.bodyHash !== digest(request)) fail('MC_AGENT_DESKTOP_STOP_REQUEST_REUSED')
      await prior.admitted
      deps.assertContext(context, true)
      return receipt(prior)
    }
    if (operations.size >= maxOperations) fail('MC_AGENT_DESKTOP_STOP_CAPACITY')
    const initial = binding(request.target.sessionId, context)
    if (digest(initial.target) !== digest(request.target)) fail('MC_AGENT_DESKTOP_STOP_STALE_TARGET')
    if (stopping.has(initial.session)) fail('MC_AGENT_DESKTOP_STOP_PENDING')
    let release
    const operation = { request, context: Object.freeze({ ...context }), session: initial.session, bodyHash: digest(request),
      finishedAt: null, admitted: new Promise(resolve => { release = resolve }), receipt: null }
    operations.set(request.requestId, operation)
    stopping.set(initial.session, operation)
    try {
      await deps.checkContext(context, true)
      const current = binding(request.target.sessionId, context, initial.session)
      if (digest(current.target) !== digest(request.target)) fail('MC_AGENT_DESKTOP_STOP_STALE_TARGET')
      // The broker receives no arbitrary action or supplied principal. It owns
      // delivery and a one-use close lease for this exact native session.
      const delivered = deps.handler.dispatch({ request, session: initial.session, context: operation.context,
        assertTarget() {
          const latest = binding(request.target.sessionId, operation.context, initial.session)
          if (digest(latest.target) !== digest(request.target)) fail('MC_AGENT_DESKTOP_STOP_STALE_TARGET')
        },
        savedStateRecorded() {
          try {
            const saved = savedBinding(request.target.sessionId, initial.session)
            return digest(saved.target) === digest(request.target) && saved.node.status === 'finished'
              && saved.node.statusNote === 'Stopped by you.'
          } catch { return false }
        },
      })
      if (!delivered || typeof delivered.completion?.then !== 'function') fail('MC_AGENT_DESKTOP_STOP_UNAVAILABLE')
      operation.receipt = { ok: true, requestId: request.requestId, state: 'pending', closed: false, savedState: 'pending' }
      Promise.resolve(delivered.completion).then(result => complete(operation, result), () => complete(operation, null))
    } catch (error) { refused(operation, error) }
    finally { release() }
    // Cleanup, once dispatched, keeps its private receipt even if this browser
    // loses authority. A stale caller receives neither the result nor a retry.
    deps.assertContext(context, true)
    return receipt(operation)
  }
  async function status(value, context) {
    if (!exactKeys(value, ['requestId']) || !uuid(value.requestId)) fail('MC_AGENT_DESKTOP_STOP_INVALID')
    await deps.checkContext(context, false)
    prune()
    const operation = find(value.requestId, context)
    await operation.admitted
    deps.assertContext(context, false)
    return receipt(operation)
  }
  return Object.freeze({ targetFor, targetsFor, start, status })
}

module.exports = { createNativeDesktopStop, normalizeDesktopStopRequest, MAX_STOP_BYTES, MAX_OPERATIONS, COMPLETED_TTL_MS }
