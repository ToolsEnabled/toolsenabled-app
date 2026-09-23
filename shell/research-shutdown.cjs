'use strict'

const { randomUUID } = require('node:crypto')

const RESEARCH_GRACE_MS = 5_000
const RESEARCH_CLEANUP_MS = 10_000

/* Owns the app's wait, NOT a database migration permission. Only the engine's
   retained facades can recognize their scope-bound cleanup observations. A
   missing facade, failed request or expired wait is UNKNOWN; allowing the
   window to exit does not turn any of those into research-worker cleanup. */
function createAppShutdownCoordinator({
  quit,
  onBegin = () => {},
  closeAgents = () => {},
  onComplete = () => {},
  graceMs = RESEARCH_GRACE_MS,
  cleanupMs = RESEARCH_CLEANUP_MS,
  waitMs = graceMs + cleanupMs + 1_000,
  schedule = setTimeout,
  unschedule = clearTimeout,
  makeRequestId = randomUUID,
} = {}) {
  if (typeof quit !== 'function') throw new TypeError('A shutdown coordinator needs the app quit function.')
  for (const value of [graceMs, cleanupMs, waitMs]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 120_000) throw new TypeError('Shutdown waits must be finite and bounded.')
  }
  const entries = ['owner-host', 'capability'].map(source => ({ source, facade: null, reader: null, pending: false, observation: null }))
  let phase = 'running'
  let flight = null
  let resolveFlight
  let timer
  let agentState = 'not-requested'
  let requestId
  let finalResult = null
  let researchSealed = false
  let researchFlight = null
  let resolveResearchFlight
  let researchTimer
  let researchResult = null
  let researchGeneration = 0

  const unknown = reasonCode => Object.freeze({ status: 'unknown', reasonCode })
  const reasonOf = (error, fallback) => typeof error?.code === 'string' && /^[A-Z0-9_]{1,100}$/.test(error.code) ? error.code : fallback

  function finishResearch(timedOut = false) {
    if (!researchFlight || researchResult || !timedOut && entries.some(entry => entry.pending)) return
    unschedule(researchTimer)
    const research = Object.freeze(entries.map(entry => Object.freeze({
      source: entry.source,
      observation: entry.pending || !entry.observation ? unknown('RESEARCH_QUIESCE_TIMEOUT') : entry.observation,
    })))
    researchResult = Object.freeze({
      ok: research.every(entry => ['owned-empty', 'not-started-in-epoch'].includes(entry.observation.status)),
      scope: 'app-owned-research-maintenance-observation', generation: researchGeneration, timedOut, research,
    })
    resolveResearchFlight(researchResult)
  }

  function finish(timedOut = false) {
    if (phase !== 'quiescing') return
    if (!timedOut && (agentState === 'pending' || entries.some(entry => entry.pending))) return
    phase = 'complete'
    unschedule(timer)
    if (agentState === 'pending') agentState = 'unknown'
    finalResult = Object.freeze({
      scope: 'app-owned-runtime-shutdown-observation',
      timedOut,
      agents: agentState,
      research: Object.freeze(entries.map(entry => Object.freeze({
        source: entry.source,
        observation: entry.pending || !entry.observation ? unknown('RESEARCH_QUIESCE_TIMEOUT') : entry.observation,
      }))),
    })
    // Neither reporting trouble nor a damaged optional service may trap exit.
    try { onComplete(finalResult) } catch { /* the result remains an observation, not proof */ }
    resolveFlight(finalResult)
    quit()
  }

  function seal(entry) {
    if (!entry.facade) return
    try { entry.facade.sealAdmission() } catch (error) {
      entry.observation = unknown(reasonOf(error, 'RESEARCH_SEAL_UNAVAILABLE'))
    }
    // A client's local seal is not a remote acknowledgement. Only its shared
    // engine reader may recognize a later quiesceOwned result.
  }

  function quiesce(entry) {
    if (entry.requested) return
    entry.requested = true
    if (!entry.facade) {
      entry.observation ||= unknown('RESEARCH_SUPERVISOR_UNAVAILABLE')
      return
    }
    entry.pending = true
    let pending
    try { pending = entry.facade.quiesceOwned({ requestId, graceMs, cleanupMs }) }
    catch (error) { pending = Promise.reject(error) }
    Promise.resolve(pending).then(value => {
      entry.receipt = value
      let observation
      try { observation = entry.reader(value) } catch { /* unreadable is unknown */ }
      return observation || unknown('RESEARCH_QUIESCE_UNRECOGNIZED')
    }, error => unknown(reasonOf(error, 'RESEARCH_QUIESCE_UNAVAILABLE'))).then(observation => {
      if (phase === 'complete') return // a late answer cannot rewrite a timeout
      entry.observation ||= observation
      entry.pending = false
      finishResearch()
      finish()
    })
  }

  function registerResearch(source, facade, reader) {
    if (!['owner-host', 'capability'].includes(source)) throw new TypeError('Unknown app-owned research source.')
    if (!facade || typeof facade.sealAdmission !== 'function' || typeof facade.quiesceOwned !== 'function'
        || typeof facade.snapshot !== 'function' || typeof reader !== 'function') {
      return unavailableResearch(source, 'RESEARCH_SUPERVISOR_UNAVAILABLE')
    }
    if (entries.some(entry => entry.facade === facade)) return
    researchGeneration++
    // Retain every actual facade. A new generation never erases the old one's
    // outstanding responsibility, even if it has the same display label.
    const entry = entries.find(item => item.source === source && !item.facade)
      || { source, facade: null, reader: null, pending: false, observation: null }
    if (!entries.includes(entry)) entries.push(entry)
    Object.assign(entry, { facade, reader: value => reader(value, facade), observation: null, requested: false })
    if (phase !== 'running' || researchSealed) {
      seal(entry)
      quiesce(entry)
    }
  }

  function unavailableResearch(source, reasonCode = 'RESEARCH_SUPERVISOR_UNAVAILABLE') {
    researchGeneration++
    const entry = entries.find(item => item.source === source && !item.facade)
      || { source, facade: null, reader: null, pending: false, observation: null }
    if (!entries.includes(entry)) entries.push(entry)
    entry.observation = unknown(reasonCode)
  }

  function beforeQuit(event) {
    if (phase === 'complete') return
    event.preventDefault()
    if (flight) return flight
    phase = 'quiescing'
    flight = new Promise(resolve => { resolveFlight = resolve })
    requestId = makeRequestId()
    timer = schedule(() => finish(true), waitMs)
    // Seal all known research admissions before anything yields or starts
    // closing session authority. A late registration is sealed above too.
    for (const entry of entries) seal(entry)
    agentState = 'pending'
    // Even the synchronous beginning of session cleanup may use its shared
    // authorities. Both private research calls must already have been made.
    for (const entry of entries) quiesce(entry)
    try { onBegin() } catch { /* cleanup still proceeds */ }
    let closing
    try { closing = closeAgents() } catch (error) { closing = Promise.reject(error) }
    Promise.resolve(closing).then(() => {
      if (phase !== 'complete') { agentState = 'settled'; finish() }
    }, () => {
      if (phase !== 'complete') { agentState = 'unknown'; finish() }
    })
    return flight
  }

  function quiesceResearch() {
    if (researchFlight && (!researchResult || researchResult.generation === researchGeneration)) return researchFlight
    if (phase !== 'running') return Promise.resolve(Object.freeze({ ok: false, reasonCode: 'APP_SHUTDOWN_STARTED' }))
    // Maintenance seals the same retained facades as quit, without quitting
    // the window. Keep their authentic observations for the later quit: a
    // bridge stopped after this drain need not answer over a dead channel.
    researchSealed = true
    researchResult = null
    requestId = makeRequestId()
    researchFlight = new Promise(resolve => { resolveResearchFlight = resolve })
    researchTimer = schedule(() => finishResearch(true), waitMs)
    for (const entry of entries) seal(entry)
    for (const entry of entries) quiesce(entry)
    finishResearch()
    return researchFlight
  }

  function researchQuiesced(value) {
    return value === researchResult && value?.ok === true && value.generation === researchGeneration
      && entries.length === value.research.length
      && entries.every((entry, index) => {
        if (entry.pending || entry.observation !== value.research[index].observation) return false
        try { return entry.reader?.(entry.receipt) === entry.observation } catch { return false }
      })
  }

  return Object.freeze({
    get started() { return phase !== 'running' },
    get complete() { return phase === 'complete' },
    beforeQuit,
    quiesceResearch,
    researchQuiesced,
    registerResearch,
    unavailableResearch,
    snapshot() { return finalResult || Object.freeze({ phase, agents: agentState }) },
  })
}

module.exports = Object.freeze({ createAppShutdownCoordinator, RESEARCH_GRACE_MS, RESEARCH_CLEANUP_MS })
