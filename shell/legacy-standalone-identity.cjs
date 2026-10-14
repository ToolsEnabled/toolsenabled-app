'use strict'
const fs = require('node:fs')
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value)
const unavailable = 'AGENT_RESUME_IDENTITY_UNAVAILABLE'
const mismatch = 'AGENT_RESUME_IDENTITY_MISMATCH'

// This is an identity lookup, never a continuation claim or recovery. Use the
// engine's v1 decoder (including its integrity/key checks), for ONE exact host
// session. Do not create an empty database when an older install has no record.
function readSavedStandaloneContinuation({ file, sessionId, continuationModule }) {
  if (!identity(sessionId)) throw new Error('Invalid saved host identity.')
  let stat
  try { stat = fs.lstatSync(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Saved continuations are not a regular file.')
  const state = continuationModule.createContinuationState({ file })
  try { return state.nativeSessionIdentity(sessionId) }
  finally { state.close() }
}

// 1.0.48's standalone bind saved speech but omitted authoritative native
// metadata. Its window-start command DID save the provider thread and account
// in agent.continuation.v1, keyed by the sessionId in its durable open-tab row.
// Join those two saved records; never search for a recent or similar session.
function createLegacyStandaloneTranscriptReader({ readTranscript, readTabs, readContinuation }) {
  return async request => {
    const answer = await readTranscript(request)
    const saved = answer?.metadata
    if (answer?.ok !== true || answer.durable === false || !saved || saved.closed
        || !/^standalone-[a-f0-9-]{36}$/i.test(request?.nodeId || '')
        || saved.nativeSessionId) return answer
    const complete = identity(saved.threadId) && ['codex', 'claude', 'gemini'].includes(saved.provider)
      && Object.hasOwn(saved, 'account') && (saved.account === null || identity(saved.account))
    const refused = code => ({ ...answer, metadata: { ...saved,
      threadId: null, provider: null, resumeIdentityError: code } })
    try {
      if (saved.computerId !== request.computerId || saved.nodeId !== request.nodeId) return refused(mismatch)
      const raw = readTabs(request.computerId)
      if (typeof raw !== 'string' || Buffer.byteLength(raw) > 64 * 1024) return refused(unavailable)
      const ledger = JSON.parse(raw)
      if (ledger?.v !== 1 || !Array.isArray(ledger.tabs) || ledger.tabs.length > 64) return refused(unavailable)
      const matches = ledger.tabs.filter(tab => tab?.id === request.nodeId)
      if (matches.length !== 1) return refused(mismatch)
      const tab = matches[0]
      if (!identity(tab.sessionId)) return complete ? answer : refused(unavailable)
      const descriptor = await readContinuation(tab.sessionId)
      // A transcript that already recorded a full identity remains evidence.
      // A speech-only transcript cannot supply the missing provider thread.
      if (!descriptor) return complete ? answer : refused(unavailable)
      if (descriptor.sessionId !== tab.sessionId || descriptor.requestKeys
          || (descriptor.agentId != null && descriptor.agentId !== request.nodeId)
          || (descriptor.roleBinding?.agentId != null && descriptor.roleBinding.agentId !== request.nodeId)) return refused(mismatch)
      if (!identity(descriptor.resumeThreadId) || !['codex', 'claude', 'gemini'].includes(descriptor.resumeThreadProvider)
          || !Object.hasOwn(descriptor, 'resumeAccount')
          || !(descriptor.resumeAccount === null || identity(descriptor.resumeAccount))) return refused(unavailable)
      const recovered = { threadId: descriptor.resumeThreadId,
        provider: descriptor.resumeThreadProvider, account: descriptor.resumeAccount }
      for (const field of Object.keys(recovered)) {
        if (Object.hasOwn(saved, field) && saved[field] !== recovered[field]) return refused(mismatch)
      }
      return { ...answer, metadata: { ...saved, ...recovered, nativeSessionId: tab.sessionId } }
    } catch { return refused(unavailable) }
  }
}
module.exports = { createLegacyStandaloneTranscriptReader, readSavedStandaloneContinuation }
