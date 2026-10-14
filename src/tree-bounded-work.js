/* Native Page 2 work owns saved circles and host session receipts. A session
 * identifier is never translated into a legacy lane launch, identity or PID. */

import { auditReceiptDisposition } from './mission-bridge.js'
import { nodeStatusForTurn, sessionTurnFailureText, sessionTurnStatus } from './agent-session-events.js'

const signed = value => Number.isSafeInteger(value?.sequence) && value.sequence > 0
  && /^[a-f0-9]{64}$/.test(String(value?.eventHash || ''))
/* B29: AUDIT OFF (Basic, the default since 7a1134d61) IS NOT AN UNCONFIRMED
   START. The shell then answers with the engine's exact unsigned receipt for
   THIS session (recordSpawnIntent's skippedStatus; recordSessionEnd's end
   copy), and demanding a signed one refused every Launch, Team and Loop. */
const recorded = (value, action, sessionId) => signed(value)
  || auditReceiptDisposition(value, action, sessionId) === 'not-required'
const named = value => typeof value === 'string' && value.length > 0

export function verifiedTreeWork(result, expected = {}) {
  const receipt = result?.boundedWork
  return result?.ok === true && receipt?.action === 'tree.dispatch'
    && named(receipt.sessionId) && receipt.sessionId === result.sessionId
    && named(receipt.nodeId) && receipt.nodeId === receipt.agentId
    && (!result.nodeId || receipt.nodeId === result.nodeId)
    && ['computerId', 'treeId', 'parentNodeId', 'parentSessionId'].every(key => named(receipt[key]) && (!expected[key] || receipt[key] === expected[key]))
    && (!expected.nodeId || receipt.nodeId === expected.nodeId)
    && Number.isFinite(receipt.startedAt) && Number.isFinite(receipt.deadlineAt)
    && Number.isFinite(receipt.capMs) && receipt.capMs > 0
    && receipt.deadlineAt > receipt.startedAt
    && (!expected.capMs || receipt.capMs <= expected.capMs)
    && recorded(result.record, 'controller.agent.launch', result.sessionId)
}

export function verifiedTreeWorkStatus(status, receipt, { closed = false } = {}) {
  return status?.ok === true && status.action === 'tree.dispatch'
    && ['sessionId', 'nodeId', 'agentId', 'computerId', 'treeId', 'parentNodeId', 'parentSessionId', 'deadlineAt', 'capMs'].every(key => status[key] === receipt[key])
    && recorded(status.record, 'controller.agent.launch', receipt.sessionId)
    && (!closed || (status.state === 'closed' && recorded(status.endRecord, 'agent_session_end', receipt.sessionId)))
}

const failure = result => result?.message || result?.reason || result?.sentence || 'The work could not be confirmed. Check its circle before trying again.'

/* B36: A STARTED AGENT WHOSE FIRST TURN FAILED IS NOT "STARTED".
 *
 * Found by the c5 Linux extra hand test (09-27): a Team with a Sonnet 5 lead
 * and a Haiku 4.5 member while the Claude account was at its weekly limit.
 * Both starts were accepted, so the box said "2 saved agents started ...
 * Started; open its circle to follow the conversation" for both -- while the
 * usage records said `error` for both and the canvas said "2 need review" and
 * "the last turn failed: You've hit your weekly limit". A start answers when
 * the brief is ACCEPTED (B31), which is before the provider has done anything
 * with it, so the box has to keep listening for the brief's own turn.
 *
 * The first completed turn of a session this box started IS its brief's turn:
 * the box names the session (onSessionOpen) before the brief is sent. Only
 * that turn is read, and only a failure changes what the box says. The
 * engine's sentence is shown as the canvas shows it -- the provider's own
 * words are the ones a person can act on -- bounded so one runaway sentence
 * cannot swallow the box. */
const FIRST_TURN_OUTCOMES = Object.freeze(['finished', 'turn-failed', 'cancelled', 'interrupted'])
const MAX_FIRST_TURN_SENTENCE_CHARS = 400
function firstTurnSentence(value) {
  if (typeof value !== 'string') return null
  const text = value.replace(/\s+/g, ' ').trim()
  if (!text) return null
  return text.length > MAX_FIRST_TURN_SENTENCE_CHARS ? `${text.slice(0, MAX_FIRST_TURN_SENTENCE_CHARS - 1)}…` : text
}
const ended = text => /[.!?…]["”’)]?$/.test(text) ? text : `${text}.`
function firstTurnDetail(turn) {
  return turn.sentence ? `Its first turn failed: ${ended(turn.sentence)}` : 'Its first turn failed. Open its circle to read why.'
}

/** The completed-turn fact the box reads off one host event packet, or null
 * for any other packet. A Halt the person pressed is `interrupted`, never a
 * failure; the engine's sentence rides only on a turn that did not succeed. */
export function boundedTurnOutcome(packet) {
  const sessionId = packet?.sessionId
  const status = sessionTurnStatus(packet, sessionId)
  if (!status || !named(sessionId)) return null
  return Object.freeze({ sessionId,
    outcome: status === 'interrupted' ? 'interrupted' : nodeStatusForTurn(status),
    sentence: sessionTurnFailureText(packet, sessionId) })
}

/** One retained controller per selected parent and control. Stop joins starts
 * already in flight, keeps incomplete receipts reachable, and never reports
 * cleanup from a renderer timer or a missing projection row. */
export function createTreeWorkController({ kind, start, readStatus, close, isBusy = () => true,
  subscribeEnded = () => () => {},
  /* Every event packet the host sends (window.mcAgent.onEvent). The box reads
     only its own agents' first completed turns out of it (B36). */
  subscribeHostEvents = () => () => {},
  setTimer = (callback, delay) => setTimeout(callback, delay), clearTimer = clearTimeout } = {}) {
  const listeners = new Set()
  let state = Object.freeze({ kind, phase: 'idle', busy: false, stoppable: false, rows: [], attempts: 0, message: '' })
  let timer = null
  let flight = null
  let stopFlight = null
  let stopRequested = false
  let plan = null
  let unsubscribeEnded = null
  let unsubscribeTurns = null
  const patch = fields => {
    state = Object.freeze({ ...state, ...fields, ...(fields.rows ? { rows: Object.freeze(fields.rows) } : {}) })
    for (const listener of listeners) { try { listener(state) } catch { /* a retired panel cannot undo real work */ } }
    return state
  }
  const cancelTimer = () => { if (timer !== null) clearTimer(timer); timer = null }
  const updateRow = (sessionId, fields) => patch({ rows: state.rows.map(row => row.sessionId === sessionId ? { ...row, ...fields } : row) })
  const detachHost = () => {
    unsubscribeEnded?.(); unsubscribeEnded = null
    unsubscribeTurns?.(); unsubscribeTurns = null
  }

  /* B36: the sessions this run started, named as they open, and the outcome
     of each one's first (its brief's) turn. `startedLine` is the "started"
     sentence this box last wrote, so a late failure replaces that sentence
     and never a different one (a parent that ended, a refusal, a Stop). */
  const startedSessions = new Set()
  const firstTurns = new Map()
  let startedLine = null

  /* What the box says once its agents are started: "started" only while no
     brief's turn has failed. For Launch and Team; a Loop reports per run. */
  function startedMessage() {
    const count = state.rows.length
    const agents = `${count} saved agent${count === 1 ? '' : 's'}`
    const failed = state.rows.filter(row => row.phase === 'turn-failed')
    if (failed.length === 0) return `${agents} started. Open their circles to follow their replies. Stop closes this work.`
    const reasons = [...new Set(failed.map(row => row.firstTurn?.sentence).filter(Boolean))]
    const why = reasons.length === 1 && failed.every(row => row.firstTurn?.sentence)
      ? `The reason given: ${ended(reasons[0])}`
      : `Open ${failed.length === 1 ? 'its circle' : 'their circles'} to read why.`
    if (failed.length === count) {
      return count === 1
        ? `The agent started, but its first turn failed, so it is not working on the brief. ${why} Stop closes this work.`
        : `${agents} started, but every one’s first turn failed, so none of them is working on the brief. ${why} Stop closes this work.`
    }
    const some = failed.length === 1
      ? 'one of them failed on its first turn, so it is not working on the brief.'
      : `${failed.length} of them failed on their first turn, so they are not working on the brief.`
    return `${agents} started, but ${some} ${why} Stop closes this work.`
  }

  function applyFirstTurn(sessionId) {
    const turn = firstTurns.get(sessionId)
    const row = state.rows.find(row => row.sessionId === sessionId)
    if (!turn || turn.outcome !== 'turn-failed' || !row || row.phase !== 'started') return
    updateRow(sessionId, { phase: 'turn-failed', firstTurn: turn, detail: firstTurnDetail(turn) })
    if (startedLine !== null && state.phase === 'active' && state.message === startedLine) announceStarted()
  }

  function announceStarted() {
    startedLine = startedMessage()
    return patch({ phase: 'active', busy: false, message: startedLine })
  }

  function noteHostEvent(packet) {
    const turn = boundedTurnOutcome(packet)
    if (!turn || !startedSessions.has(turn.sessionId) || firstTurns.has(turn.sessionId)) return
    if (!FIRST_TURN_OUTCOMES.includes(turn.outcome)) return
    firstTurns.set(turn.sessionId, Object.freeze({ outcome: turn.outcome, sentence: firstTurnSentence(turn.sentence) }))
    applyFirstTurn(turn.sessionId)
  }

  async function refreshClosed(sessionId) {
    const row = state.rows.find(row => row.sessionId === sessionId)
    if (!row?.receipt) return
    let status
    try { status = await readStatus(sessionId) } catch { return }
    if (!verifiedTreeWorkStatus(status, row.receipt, { closed: true })) return
    updateRow(sessionId, { phase: 'closed', detail: 'The host confirmed this session and its child work closed.' })
    if (!flight && !stopFlight && state.phase !== 'running' && state.rows.every(row => row.phase === 'closed')) {
      // A later cap/exit can close the Lead after a Member was refused. Its
      // cleanup is confirmed, but the refused Team still owes that reason.
      //
      // A STOP THAT IS CONFIRMED LATE IS STILL A STOP, NOT A COMPLETION.
      // This branch preserved the "refused" disposition and nothing else, so a
      // person who pressed Stop, was told "Some sessions are not confirmed
      // closed", and then had the host confirm the close through the very
      // subscription stop() keeps open for it, watched the panel settle on
      // phase "completed" and the natural-completion sentence "No further run
      // is scheduled." The work did not complete; they halted it. Reproduced
      // in tools/test/bounded-work-stop-not-completed.test.mjs, which drives
      // the real controller through its injected collaborators.
      //
      // stopRequested is the honest reading of "the person asked for this to
      // end": stop() sets it, and so does the parent-ended branch, which is
      // also an ending rather than a completion. The sentence below is the
      // SAME one stop() writes on its own confirmed path, so a stop confirmed
      // late and a stop confirmed immediately now read identically -- which is
      // right, because they are the same outcome reached at different speeds.
      const refused = state.phase === 'refused'
      const halted = stopRequested && !refused
      patch({ phase: refused ? 'refused' : halted ? 'stopped' : 'completed', busy: false, stoppable: false,
        message: refused ? state.message
          : halted ? 'No further work will start. The host confirmed all started sessions closed.'
            : 'The host confirmed all started work closed. No further run is scheduled.' })
      detachHost()
    }
  }

  /* B31 FOLLOW-UP: A START NOW ANSWERS ONLY WHEN ITS BRIEF IS ACCEPTED, so a
     provider that never accepts would hold Stop behind `flight` for as long as
     the transport allows. The start names its session the moment it opens;
     stop() closes that session, which ends the wait, and then joins it. */
  let pendingStart = null
  async function startOne(parent, tier, label) {
    let result
    let opened = null
    const pending = { opened: new Promise(resolve => { opened = resolve }) }
    pendingStart = pending
    try { result = await start({ ...plan, ...parent, tier, label, onSessionOpen: sessionId => { if (named(sessionId)) { startedSessions.add(sessionId); opened(sessionId) } } }) }
    catch (error) { result = { ok: false, message: error?.message } }
    finally { if (pendingStart === pending) pendingStart = null; opened(null) }
    // Even an incomplete acknowledgement can name a real child. Preserve the
    // exact target for Stop and refuse all further automatic starts.
    const receipt = result?.boundedWork
    if (named(result?.sessionId)) {
      const verified = verifiedTreeWork(result, { ...parent, capMs: plan.capMs })
      /* B31: the host started this child and gave its receipt, but its brief
         was refused. It is not "Started": it is open without its task -- unless
         the refusal was that its session ended (c4 review), which is said. */
      const briefRefused = !verified && result.ok === false
        && verifiedTreeWork({ ...result, ok: true }, { ...parent, capMs: plan.capMs })
      patch({ rows: [...state.rows, { label, tier, nodeId: result.nodeId || receipt?.nodeId || null,
        sessionId: result.sessionId, receipt: receipt || null, record: result.record || null,
        phase: verified ? 'started' : 'unconfirmed',
        detail: verified ? 'Started; open its circle to follow the conversation.'
          : stopFlight ? 'Stopped before it took its brief. Stop checks that it closed.'
            : briefRefused && result.sessionEnded === true ? 'Its brief did not reach it, and its session has ended. Stop checks that it closed.'
              : briefRefused ? 'Its brief did not reach it. It is open without a task; Stop closes it.' : failure(result) }] })
      /* B36: a brief's turn can already have failed by the time its start
         answers (the start answers at acceptance, not at the reply). */
      startedSessions.add(result.sessionId)
      applyFirstTurn(result.sessionId)
      if (verified) return { ok: true, receipt }
    }
    /* A START ENDED BY STOP IS NOT A FAILED START (c4 second review). Stop
       closes a child whose brief is still waiting, and that close is what
       refuses the brief. Reporting it as "refused" put the failure sentence
       ("...did not reach it... Try it once more") on the box and gave Stop
       back while Stop was still closing. stop() owns the box from here. (Only
       the person's Stop: a parent that ended keeps its own branch above.) */
    if (stopFlight) return { ok: false }
    patch({ phase: 'refused', busy: false, stoppable: state.rows.some(row => row.phase !== 'closed'), message: failure(result) })
    return { ok: false }
  }

  async function closeRow(row) {
    let result
    try {
      const before = await readStatus(row.sessionId)
      if (row.receipt && verifiedTreeWorkStatus(before, row.receipt, { closed: true })) {
        updateRow(row.sessionId, { phase: 'closed', detail: 'The host confirmed this session and its child work closed.' })
        return true
      }
      // An unconfirmed start still belongs to its retained session ID; closing
      // it is safe, but missing cap attribution cannot earn a verified receipt.
      result = await close(row.sessionId)
      const after = await readStatus(row.sessionId)
      if (row.receipt && verifiedTreeWorkStatus(after, row.receipt, { closed: true })) {
        updateRow(row.sessionId, { phase: 'closed', detail: 'The host confirmed this session and its child work closed.' })
        return true
      }
    } catch (error) { result = { message: error?.message } }
    updateRow(row.sessionId, { phase: 'close-unconfirmed', detail: `Stop was not confirmed. ${failure(result)}` })
    return false
  }

  async function stop() {
    if (stopFlight) return stopFlight
    stopRequested = true
    cancelTimer()
    patch({ phase: 'stopping', busy: true, stoppable: false, message: 'No further work will start. Waiting for any start in flight, then closing the retained sessions.' })
    stopFlight = (async () => {
      const pending = pendingStart
      if (flight && pending) {
        const sessionId = await Promise.race([pending.opened, flight.then(() => null, () => null)])
        if (sessionId && pendingStart === pending) { try { await close(sessionId) } catch { /* the rows below still close and report */ } }
      }
      await flight?.catch(() => {})
      let confirmed = true
      // Members first, then their lead. The host also owns descendant cleanup;
      // the separate reads preserve a useful outcome for every visible circle.
      for (const row of [...state.rows].reverse()) if (row.phase !== 'closed') confirmed = await closeRow(row) && confirmed
      if (confirmed) detachHost()
      return patch({ phase: confirmed ? 'stopped' : 'close-unconfirmed', busy: false, stoppable: !confirmed,
        message: confirmed ? 'No further work will start. The host confirmed all started sessions closed.' : 'No further work will start. Some sessions are not confirmed closed; Stop remains available.' })
    })().finally(() => { stopFlight = null })
    return stopFlight
  }

  async function loopAttempt() {
    if (stopRequested || state.phase !== 'running') return state
    const index = state.attempts + 1
    patch({ busy: true })
    const previous = state.rows.at(-1)
    if (previous && previous.phase !== 'closed') {
      let observed
      try { observed = await readStatus(previous.sessionId) } catch { observed = null }
      if (!previous.receipt || !verifiedTreeWorkStatus(observed, previous.receipt)) {
        return patch({ phase: 'refused', busy: false, message: 'The previous run could not be verified. This loop will not start another copy; use Stop to check and close it.' })
      }
      if (observed.state === 'closed') {
        if (!verifiedTreeWorkStatus(observed, previous.receipt, { closed: true })) return patch({ phase: 'refused', busy: false, message: 'The previous run has no verified closing receipt. No further run will start.' })
        updateRow(previous.sessionId, { phase: 'closed', detail: 'The host confirmed this run closed.' })
      } else if (observed.state !== 'ready' || isBusy(previous.sessionId)) {
        patch({ busy: false, message: `Run ${index} was skipped because the previous run is still active.` })
        scheduleLoop()
        return state
      } else if (!await closeRow(previous)) {
        return patch({ phase: 'close-unconfirmed', busy: false, message: 'The previous run was not confirmed closed. No further run will start.' })
      }
    }
    if (stopRequested) return state
    const result = await startOne(plan, plan.tier, `Run ${index}`)
    if (result.ok && !stopRequested) {
      patch({ attempts: index, busy: false, stoppable: true, message: `Run ${index} started under the selected agent. Its time cap is enforced by the host.` })
      scheduleLoop()
    }
    return state
  }

  function scheduleLoop() {
    if (stopRequested || state.phase !== 'running') return
    if (state.attempts >= plan.iterations) {
      patch({ phase: 'active', busy: false, message: `${state.attempts} runs started. No further run will start. Stop remains available for the last run.` })
      return
    }
    timer = setTimer(() => {
      timer = null
      flight = loopAttempt().finally(() => {
        flight = null
        for (const row of state.rows) void refreshClosed(row.sessionId)
      })
    }, plan.intervalMs)
  }

  return Object.freeze({
    getState: () => state,
    getPlan: () => plan,
    subscribe(listener) { listeners.add(listener); listener(state); return () => listeners.delete(listener) },
    run(next) {
      if (flight || stopFlight || state.stoppable || state.busy) return Promise.resolve(state)
      if (!unsubscribeEnded) unsubscribeEnded = subscribeEnded(sessionId => {
        if (sessionId === plan?.parentSessionId) {
          stopRequested = true
          cancelTimer()
          // Parent shutdown closes only the started portion of a refused Team.
          // Its member refusal must survive this event and the later child proof.
          const refused = state.phase === 'refused'
          patch({ phase: refused ? 'refused' : 'active', busy: Boolean(flight),
            message: refused ? state.message : 'The selected parent ended. No further work will start.' })
          for (const row of state.rows) void refreshClosed(row.sessionId)
        } else void refreshClosed(sessionId)
      })
      if (!unsubscribeTurns) unsubscribeTurns = subscribeHostEvents(noteHostEvent)
      startedSessions.clear()
      firstTurns.clear()
      startedLine = null
      plan = Object.freeze({ ...next, members: [...(next.members || [])] })
      stopRequested = false
      patch({ phase: 'running', busy: true, stoppable: true, rows: [], attempts: 0, message: 'Starting saved child work under the selected agent…' })
      flight = (async () => {
        if (kind === 'loop') return loopAttempt()
        const lead = await startOne(plan, plan.tier, kind === 'team' ? 'Lead' : 'Worker')
        if (!lead.ok || stopRequested) return state
        if (kind === 'team') {
          for (const [index, tier] of plan.members.entries()) {
            if (stopRequested) break
            const member = await startOne({ computerId: lead.receipt.computerId, treeId: lead.receipt.treeId,
              parentNodeId: lead.receipt.nodeId, parentSessionId: lead.receipt.sessionId }, tier, `Member ${index + 1}`)
            if (!member.ok) return state
          }
        }
        if (!stopRequested) announceStarted()
        return state
      })().finally(() => {
        flight = null
        for (const row of state.rows) void refreshClosed(row.sessionId)
      })
      return flight
    },
    stop,

  })
}
