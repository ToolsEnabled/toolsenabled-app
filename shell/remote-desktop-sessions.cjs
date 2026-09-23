'use strict'

const { readDesktopTreeSnapshot } = require('./desktop-tree-snapshot.cjs')
const { createNativeDesktopStop } = require('./native-desktop-stop.cjs')

// A paired browser may open this window's conversations without becoming
// their owner. Every request and watch remains bound to the current pairing.
const MAX_RESPONSE_BYTES = 80 * 1024
const MAX_WATCHES = 4
const fail = code => { const error = new Error(code); error.code = code; throw error }
const word = (value, limit = 128) => typeof value === 'string' && value.length > 0 ? value.slice(0, limit) : null
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8')

function createRemoteDesktopSessions(deps) {
  const watches = new Map()
  const pendingSends = new Map()
  let epoch = 0
  function assertConnection(context, write = false) {
    const current = deps.currentPrincipal()
    if (context.epoch !== epoch || current.kind !== 'relay' || current.owner !== context.owner
        || !deps.connectionContinues(context.ticket)) fail('MC_AGENT_CONNECTION_CLOSED')
    if (write && current.mayWrite !== true) fail('MC_AGENT_PRINCIPAL_READ_ONLY')
  }
  async function checkClaim(context, write = false) {
    assertConnection(context, write)
    const status = await deps.deviceStatus()
    assertConnection(context, write)
    if (status?.connected !== true || !word(status.deviceId) || !word(status.pairId)
        || (context.deviceId && (context.deviceId !== status.deviceId || context.pairId !== status.pairId))) {
      fail('MC_AGENT_CONNECTION_CLOSED')
    }
    if (!context.deviceId) { context.deviceId = status.deviceId; context.pairId = status.pairId }
  }
  async function admit(principal, write = false) {
    if (principal?.kind !== 'relay') fail('MC_AGENT_PRINCIPAL_INVALID')
    if (write && principal.mayWrite !== true) fail('MC_AGENT_PRINCIPAL_READ_ONLY')
    const context = { owner: principal.owner, ticket: deps.connectionTicket(), epoch }
    await checkClaim(context, write)
    assertConnection(context, write)
    return context
  }
  function refusal(session, context) {
    if (session.pairingOwner !== context.owner) return 'MC_AGENT_REMOTE_SESSION_PREVIOUS_CONNECTION'
    if (session.boundedWork) return 'MC_AGENT_REMOTE_SESSION_BOUNDED_WORK'
    return null
  }
  function sessionFor(sessionId, context, expected = null) {
    const session = deps.sessions.get(sessionId)
    if (!session || (expected && session !== expected) || session.ownerKind !== 'window' || refusal(session, context)) {
      fail('MC_AGENT_REMOTE_SESSION_REFUSED')
    }
    if (session.ended) fail('MC_AGENT_SESSION_ENDED')
    if (session.state !== 'ready') fail('MC_AGENT_REMOTE_SESSION_REFUSED')
    return session
  }
  const nativeStop = deps.nativeStopHandler ? createNativeDesktopStop({
    readTree: () => readDesktopTreeSnapshot(deps.rendererPrefsSnapshot()),
    sessionFor, assertContext: assertConnection, checkContext: checkClaim, handler: deps.nativeStopHandler,
  }) : null
  async function stop(value, principal) {
    if (!nativeStop) fail('MC_AGENT_DESKTOP_STOP_UNAVAILABLE')
    return nativeStop.start(value, await admit(principal, true))
  }
  async function stopStatus(value, principal) {
    if (!nativeStop) fail('MC_AGENT_DESKTOP_STOP_UNAVAILABLE')
    return nativeStop.status(value, await admit(principal))
  }
  function arm(sessionId, context, session) {
    const previous = watches.get(sessionId)
    watches.delete(sessionId)
    const watch = { context, session }
    watches.set(sessionId, watch)
    const evicted = watches.size > MAX_WATCHES ? watches.entries().next().value : null
    if (evicted) watches.delete(evicted[0])
    return { sessionId, watch, previous, evicted }
  }
  function rollbackWatch({ sessionId, watch, previous, evicted }) {
    const restore = (id, candidate, oldest = false) => {
      if (!candidate || watches.has(id) || watches.size >= MAX_WATCHES) return
      try {
        assertConnection(candidate.context)
        sessionFor(id, candidate.context, candidate.session)
      } catch { return }
      if (oldest) {
        const newer = [...watches]
        watches.clear(); watches.set(id, candidate)
        for (const entry of newer) watches.set(...entry)
      } else watches.set(id, candidate)
    }
    // Undo only this admission; an overlapping read/send may have installed a
    // newer watch while this request awaited disk or the host. Never replace it,
    // exceed the cap, or resurrect a watch after facade close/revocation.
    if (watches.get(sessionId) === watch) {
      watches.delete(sessionId)
      restore(sessionId, previous)
    }
    if (evicted) restore(...evicted, true)
  }
  function forward(packet) {
    const watch = watches.get(packet?.sessionId)
    if (!watch) return false
    try {
      assertConnection(watch.context)
      const session = deps.sessions.get(packet.sessionId)
      if (session !== watch.session || session?.ownerKind !== 'window' || refusal(session, watch.context)) {
        watches.delete(packet.sessionId); return false
      }
      deps.emitRemote(packet)
      if (packet.event?.type === 'session_ended') watches.delete(packet.sessionId)
      return true
    } catch { watches.delete(packet.sessionId); return false }
  }
  function personTurn({ sessionId, text, turnId }, via, expected = deps.sessions.get(sessionId)) {
    if (deps.sessions.get(sessionId) !== expected) return
    const packet = { sessionId, event: { type: 'person_turn', via, text, turnId: turnId || null, at: Date.now() } }
    forward(packet)
    if (via === 'remote') deps.emitWindow(packet)
  }
  function acceptedPrompt(request) {
    if (request?.origin !== 'person' || deps.sessions.get(request.sessionId)?.ownerKind !== 'window') return
    const pending = pendingSends.get(request.sessionId)
    if (pending && pending.text === request.text && deps.sessions.get(request.sessionId) === pending.session) {
      pending.reported = true
      pending.turnId = word(request.turnId)
      personTurn(request, 'remote', pending.session)
    } else personTurn(request, 'desktop')
  }
  function sessionList(context) {
    const answer = { ok: true, mayWrite: deps.currentPrincipal().mayWrite === true, sessions: [], truncated: false }
    const stopTargets = nativeStop && answer.mayWrite ? nativeStop.targetsFor(deps.sessions.keys(), context) : null
    for (const [sessionId, session] of deps.sessions) {
      if (session?.ownerKind !== 'window' || session.ended || session.state !== 'ready') continue
      const reason = refusal(session, context)
      const host = deps.host()
      const metadata = host?.sessionTranscriptMetadata?.(sessionId)
      const activity = host?.sessionActivity?.(sessionId)
      const row = {
        sessionId: word(sessionId), agentId: word(session.agentId), nodeId: word(session.treeNodeId),
        name: word(session.desktopName, 120), provider: word(metadata?.provider), tier: word(session.tier),
        busy: typeof activity?.busy === 'boolean' ? activity.busy : null,
        turnsCompleted: Number.isSafeInteger(session.turnsCompleted) && session.turnsCompleted >= 0 ? session.turnsCompleted : 0,
        lastTurnStatus: word(session.lastTurnStatus), transcript: !!deps.bindingFor(sessionId),
        openable: reason === null, refusal: reason,
      }
      if (nativeStop && answer.mayWrite && !reason) {
        const target = stopTargets?.get(sessionId)
        if (target) row.stopTarget = target
      }
      if (!row.sessionId) continue
      answer.sessions.push(row)
      if (answer.sessions.length > 200 || bytes(answer) > MAX_RESPONSE_BYTES) {
        answer.sessions.pop(); answer.truncated = true; break
      }
    }
    if (answer.sessions.some(row => row.stopTarget)) answer.desktopStopVersion = 1
    return answer
  }
  async function list(principal) {
    const context = await admit(principal)
    assertConnection(context)
    const answer = sessionList(context)
    assertConnection(context)
    return answer
  }
  async function tree(principal) {
    const context = await admit(principal)
    let preferences
    try { preferences = await deps.rendererPrefsSnapshot?.() }
    catch { assertConnection(context); fail('MC_AGENT_DESKTOP_TREE_UNAVAILABLE') }
    assertConnection(context)
    const desktopTree = readDesktopTreeSnapshot(preferences)
    const runtime = sessionList(context)
    // The immutable preference snapshot and activity rows may have been read
    // across an asynchronous boundary. Recheck the physical pairing as well as
    // the relay generation before any saved context leaves this computer.
    await checkClaim(context)
    assertConnection(context)
    return { ok: true, mayWrite: deps.currentPrincipal().mayWrite === true, desktopTree,
      sessions: runtime.sessions, sessionsTruncated: runtime.truncated }
  }
  async function treeReadLease(principal) {
    // Private host seam for paged byte snapshots, never an IPC/query mode.
    // Retain the original pairing and grant even when the public tree changes.
    const mayWrite = principal?.mayWrite === true
    const context = await admit(principal)
    let revoked = false
    const assertGrant = currentPrincipal => {
      assertConnection(context)
      if (revoked || currentPrincipal?.kind !== 'relay' || currentPrincipal.owner !== context.owner
          || (currentPrincipal.mayWrite === true) !== mayWrite
          || (deps.currentPrincipal().mayWrite === true) !== mayWrite) fail('MC_AGENT_CONNECTION_CLOSED')
    }
    assertGrant(principal)
    return async function check(currentPrincipal) {
      try {
        assertGrant(currentPrincipal)
        await checkClaim(context)
        assertGrant(currentPrincipal)
      } catch (error) {
        revoked = true
        throw error
      }
    }
  }
  function transcriptEntry(entry) {
    return {
      id: word(entry.id, 512), who: ['you', 'agent', 'action'].includes(entry.who) ? entry.who : 'action',
      text: typeof entry.text === 'string' ? entry.text : '',
      at: Number.isSafeInteger(entry.at) && entry.at >= 0 ? entry.at : null,
      turnId: word(entry.turnStamp) || (typeof entry.id === 'string' && /^agent:/.test(entry.id) ? word(entry.id.split(':').slice(2).join(':')) : null),
      context: entry.promptSource === 'toolsenabled' && ['tree', 'requests', 'tasks', 'history', 'role', 'tools', 'capabilities'].includes(entry.promptKind) ? entry.promptKind : null,
      clipped: false,
    }
  }
  async function transcript(value, principal) {
    const context = await admit(principal)
    const { sessionId, before, limit = 30 } = value || {}
    if (!word(sessionId) || sessionId.length > 128 || Object.keys(value || {}).some(key => !['sessionId', 'before', 'limit'].includes(key))
        || !Number.isSafeInteger(limit) || limit < 1 || limit > 60) fail('AGENT_FACADE_BAD_QUERY')
    if (before !== undefined && (typeof before !== 'string' || !/^\d{16}-[a-f0-9]{64}\.json$/.test(before))) fail('MC_AGENT_TRANSCRIPT_CURSOR_INVALID')
    const session = sessionFor(sessionId, context)
    const binding = deps.bindingFor(sessionId)
    const assertCurrent = () => { assertConnection(context); sessionFor(sessionId, context, session) }
    // Subscribe before reading history. Otherwise a turn can finish between
    // the disk snapshot and the final claim check with neither its final text
    // nor completion reaching the phone. A failed read releases this watch.
    const admission = arm(sessionId, context, session)
    let succeeded = false
    try {
      let answer = { ok: true, sessionId, bound: !!binding, entries: [], before: null }
      if (binding) {
        let size = limit
        for (;;) {
          let page
          try { page = await deps.readTranscript({ ...binding, before, limit: size, strictBefore: true }, assertCurrent) }
          catch (error) {
            assertCurrent()
            fail(error?.code === 'MC_AGENT_TRANSCRIPT_CURSOR_INVALID' ? error.code : 'MC_AGENT_TRANSCRIPT_UNAVAILABLE')
          }
          assertCurrent()
          answer = { ...answer, entries: page.entries.map(transcriptEntry), before: page.before || null }
          if (bytes(answer) <= MAX_RESPONSE_BYTES) break
          if (size > 1) { size = Math.max(1, Math.floor(size / 2)); continue }
          const entry = answer.entries[0]
          let lo = 0, hi = entry.text.length
          const fullText = entry.text
          entry.clipped = true
          while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2)
            entry.text = fullText.slice(0, mid)
            if (bytes(answer) <= MAX_RESPONSE_BYTES) lo = mid
            else hi = mid - 1
          }
          entry.text = fullText.slice(0, lo)
          break
        }
      } else if (before !== undefined) fail('MC_AGENT_TRANSCRIPT_CURSOR_INVALID')
      await checkClaim(context)
      assertCurrent()
      succeeded = true
      return answer
    } finally {
      if (!succeeded) rollbackWatch(admission)
    }
  }
  async function send(value, principal) {
    const context = await admit(principal, true)
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(key => !['sessionId', 'text'].includes(key))
        || typeof value.sessionId !== 'string' || !value.sessionId || value.sessionId.length > 128
        || typeof value.text !== 'string' || !value.text.trim() || value.text.length > 200000) fail('MC_AGENT_INVALID_PAYLOAD')
    const { sessionId, text } = value
    const session = sessionFor(sessionId, context)
    // No await separates final authority admission from the host's synchronous
    // send edge. The host refuses busy sessions instead of queuing a retry.
    assertConnection(context, true)
    const host = deps.host()
    if (pendingSends.has(sessionId) || host.sessionActivity?.(sessionId)?.busy === true) fail('AGENT_TURN_ACTIVE')
    const admission = arm(sessionId, context, session)
    const pending = { text, session, reported: false }
    pendingSends.set(sessionId, pending)
    let accepted = false
    try {
      let result
      try { result = await host.sendTurn({ sessionId, text, origin: 'person' }) }
      catch (error) {
        // The host announces acceptance before checking whether Stop or exit
        // ended its session during the acknowledgement. Its accepted-prompt
        // hook is proof that the words arrived even if that later check throws.
        if (!pending.reported) throw error
        result = { ok: true, turnId: pending.turnId }
      }
      // An accepted provider turn must never be retried because its receipt was
      // lost to disconnect. The bridge discards the stale response, and history
      // supplies the accepted words after the person reconnects.
      if (result?.ok === false) {
        if (!pending.reported) fail(result.code || 'AGENT_SESSION_FAILED')
        result = { ok: true, turnId: pending.turnId }
      }
      accepted = true
      if (deps.sessions.get(sessionId) === session) {
        try { await deps.recordSend({ sessionId, text, turnId: result?.turnId || null, ...(result?.transcriptPrompt ? { transcriptPrompt: result.transcriptPrompt } : {}) }) } catch {}
      }
      try { if (!pending.reported) personTurn({ sessionId, text, turnId: result?.turnId }, 'remote', session) } catch {}
      // The write was admitted before the host accepted it. A later claim
      // hiccup, read-only toggle or session replacement cannot turn that fact
      // into a refusal. A revoked bridge generation still drops the receipt.
      return { ok: true, sessionId, turnId: word(result?.turnId) }
    } finally {
      if (!accepted) rollbackWatch(admission)
      if (pendingSends.get(sessionId) === pending) pendingSends.delete(sessionId)
    }
  }
  return Object.freeze({ list, tree, treeReadLease, transcript, send, stop, stopStatus, forward, personTurn, acceptedPrompt,
    checkStopContext: checkClaim,
    close() { epoch += 1; watches.clear() },
  })
}
module.exports = { createRemoteDesktopSessions, MAX_RESPONSE_BYTES }
