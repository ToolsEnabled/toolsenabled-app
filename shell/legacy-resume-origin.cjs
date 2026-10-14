'use strict'
const path = require('node:path')
const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }
const identity = (value, max = 512) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f]/.test(value)

// Upgrade bridge: selectors come from the renderer, identity and account come
// from the saved tab/transcript, and homes come only from the host's registry.
// No sign-in file is opened. A missing new-format origin is not permission to
// select whichever account is currently preferred.
function createLegacyResumeOriginResolver({ readTabs, readTrees, readTranscript, accountHome, defaultHome }) {
  return async ({ sessionId, threadId, provider, account, agentId, transcript }) => {
    if (!identity(transcript?.computerId) || !identity(transcript?.nodeId)) {
      fail('AGENT_RESUME_HOME_UNAVAILABLE', 'The saved conversation location could not be verified.')
    }
    let rows
    try {
      const standalone = /^standalone-[a-f0-9-]{36}$/i.test(transcript.nodeId)
      const raw = standalone ? readTabs(transcript.computerId) : readTrees?.(transcript.computerId)
      // Bound each canonical ledger independently. Never search other computers
      // or choose a recent session when the exact saved node is unavailable.
      if (typeof raw !== 'string' || Buffer.byteLength(raw) > (standalone ? 64 * 1024 : 64 * 1024 * 1024)) throw new Error()
      const saved = JSON.parse(raw)
      rows = standalone ? saved.tabs : saved.nodes
      if ((standalone ? saved.v !== 1 : saved.version !== 1 || saved.computerId !== transcript.computerId)
          || !Array.isArray(rows) || rows.length > (standalone ? 64 : 4096)) throw new Error()
    } catch { fail('AGENT_RESUME_IDENTITY_UNAVAILABLE', 'The saved agent identity could not be verified.') }
    const matches = rows.filter(row => row?.id === transcript.nodeId)
    const tab = matches.length === 1 ? matches[0] : null
    if (!tab || (agentId !== null && agentId !== transcript.nodeId)) {
      fail('AGENT_RESUME_IDENTITY_MISMATCH', 'The saved conversation does not belong to this agent.')
    }
    let answer
    try { answer = await readTranscript(transcript) }
    catch { fail('AGENT_RESUME_IDENTITY_UNAVAILABLE', 'The saved conversation could not be read to verify its native identity.') }
    const saved = answer?.metadata
    if (['AGENT_RESUME_IDENTITY_UNAVAILABLE', 'AGENT_RESUME_IDENTITY_MISMATCH'].includes(saved?.resumeIdentityError)) {
      fail(saved.resumeIdentityError, 'The saved conversation identity could not be confirmed from its recorded session.')
    }
    if (answer?.ok !== true || answer?.durable === false || !saved || saved.closed
        || !identity(saved.threadId) || !['claude', 'codex', 'gemini'].includes(saved.provider)
        || !Object.hasOwn(saved, 'account') || !(saved.account === null || identity(saved.account))) {
      fail('AGENT_RESUME_IDENTITY_UNAVAILABLE', 'The saved native conversation identity could not be verified.')
    }
    if (tab.sessionId !== sessionId || (saved.nativeSessionId && saved.nativeSessionId !== sessionId) || saved.threadId !== threadId
        || saved.provider !== provider || saved.account !== account
        || saved.computerId !== transcript.computerId || saved.nodeId !== transcript.nodeId) {
      fail('AGENT_RESUME_IDENTITY_MISMATCH', 'The saved conversation does not match its original agent or account.')
    }
    const lookup = () => {
      let home
      try { home = saved.account === null ? defaultHome(saved.provider) : accountHome(saved.account, saved.provider) }
      catch { fail('AGENT_RESUME_ACCOUNT_UNAVAILABLE', 'The saved conversation account is no longer configured. No other sign-in was used.') }
      if (!identity(home, 4096) || !path.isAbsolute(home)) {
        fail('AGENT_RESUME_HOME_UNAVAILABLE', 'The saved conversation account has no verified sign-in home.')
      }
      return path.resolve(home)
    }
    const home = lookup()
    const recordedHome = saved.pinnedHome ?? saved.home
    if (recordedHome !== undefined && recordedHome !== null
        && (!identity(recordedHome, 4096) || !path.isAbsolute(recordedHome))) {
      fail('AGENT_RESUME_HOME_UNAVAILABLE', 'The saved conversation sign-in folder could not be verified.')
    }
    if (recordedHome !== undefined && recordedHome !== null && path.resolve(recordedHome) !== home) {
      fail(saved.account === null ? 'AGENT_RESUME_HOME_UNAVAILABLE' : 'AGENT_RESUME_HOME_CHANGED',
        'This account now points to a different sign-in folder. Your conversation is kept. Choose the account again before resuming.')
    }
    const databaseHome = saved.databaseHome ?? null
    if (databaseHome !== null && (!identity(databaseHome, 4096) || !path.isAbsolute(databaseHome))) {
      fail('AGENT_RESUME_HOME_UNAVAILABLE', 'The saved native history home could not be verified.')
    }
    return Object.freeze({ threadId, provider: saved.provider, account: saved.account, agentId, home, databaseHome,
      assertCurrent() {
        if (lookup() !== home) fail(saved.account === null ? 'AGENT_RESUME_HOME_UNAVAILABLE' : 'AGENT_RESUME_HOME_CHANGED',
          'This account now points to a different sign-in folder. Your conversation is kept. Choose the account again before resuming.')
      } })
  }
}
module.exports = { createLegacyResumeOriginResolver }
