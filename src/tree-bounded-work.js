/* Native Page 2 work owns saved circles and host session receipts. A session
 * identifier is never translated into a legacy lane launch, identity or PID. */

const signed = value => Number.isSafeInteger(value?.sequence) && value.sequence > 0
  && /^[a-f0-9]{64}$/.test(String(value?.eventHash || ''))
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
    && signed(result.record)
}

export function verifiedTreeWorkStatus(status, receipt, { closed = false } = {}) {
  return status?.ok === true && status.action === 'tree.dispatch'
    && ['sessionId', 'nodeId', 'agentId', 'computerId', 'treeId', 'parentNodeId', 'parentSessionId', 'deadlineAt', 'capMs'].every(key => status[key] === receipt[key])
    && signed(status.record)
    && (!closed || (status.state === 'closed' && signed(status.endRecord)))
}

const failure = result => result?.message || result?.reason || result?.sentence || 'The work could not be confirmed. Check its circle before trying again.'

/** One retained controller per selected parent and control. Stop joins starts
 * already in flight, keeps incomplete receipts reachable, and never reports
 * cleanup from a renderer timer or a missing projection row. */
export function createTreeWorkController({ kind, start, readStatus, close, isBusy = () => true,
  subscribeEnded = () => () => {}, setTimer = (callback, delay) => setTimeout(callback, delay), clearTimer = clearTimeout } = {}) {
  const listeners = new Set()
  let state = Object.freeze({ kind, phase: 'idle', busy: false, stoppable: false, rows: [], attempts: 0, message: '' })
  let timer = null
  let flight = null
  let stopFlight = null
  let stopRequested = false
  let plan = null
  let unsubscribeEnded = null
  const patch = fields => {
    state = Object.freeze({ ...state, ...fields, ...(fields.rows ? { rows: Object.freeze(fields.rows) } : {}) })
    for (const listener of listeners) { try { listener(state) } catch { /* a retired panel cannot undo real work */ } }
    return state
  }
  const cancelTimer = () => { if (timer !== null) clearTimer(timer); timer = null }
  const updateRow = (sessionId, fields) => patch({ rows: state.rows.map(row => row.sessionId === sessionId ? { ...row, ...fields } : row) })

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
      unsubscribeEnded?.(); unsubscribeEnded = null
    }
  }

  async function startOne(parent, tier, label) {
    let result
    try { result = await start({ ...plan, ...parent, tier, label }) }
    catch (error) { result = { ok: false, message: error?.message } }
    // Even an incomplete acknowledgement can name a real child. Preserve the
    // exact target for Stop and refuse all further automatic starts.
    const receipt = result?.boundedWork
    if (named(result?.sessionId)) {
      const verified = verifiedTreeWork(result, { ...parent, capMs: plan.capMs })
      patch({ rows: [...state.rows, { label, tier, nodeId: result.nodeId || receipt?.nodeId || null,
        sessionId: result.sessionId, receipt: receipt || null, record: result.record || null,
        phase: verified ? 'started' : 'unconfirmed', detail: verified ? 'Started; open its circle to follow the conversation.' : failure(result) }] })
      if (verified) return { ok: true, receipt }
    }
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
      await flight?.catch(() => {})
      let confirmed = true
      // Members first, then their lead. The host also owns descendant cleanup;
      // the separate reads preserve a useful outcome for every visible circle.
      for (const row of [...state.rows].reverse()) if (row.phase !== 'closed') confirmed = await closeRow(row) && confirmed
      if (confirmed) { unsubscribeEnded?.(); unsubscribeEnded = null }
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
        if (!stopRequested) patch({ phase: 'active', busy: false, message: `${state.rows.length} saved agent${state.rows.length === 1 ? '' : 's'} started. Open their circles to follow their replies. Stop closes this work.` })
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
