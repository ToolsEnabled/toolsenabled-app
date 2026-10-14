'use strict'

const MAX_TAB_BYTES = 64 * 1024
const MAX_TABS = 64
const MAX_PAGES = 256
const PAGE_SIZE = 100
const REFUSAL = 'This saved conversation could not be transferred to the tree. Its original tab is still open.'
const refuse = () => { throw Object.assign(new Error(REFUSAL), { code: 'AGENT_STOPPED_ADOPTION_REFUSED' }) }
const checked = answer => { if (answer?.ok !== true || answer.durable === false) refuse(); return answer }
const sameIdentity = (metadata, identity, source) => metadata && !metadata.closed && !metadata.resumeIdentityError
  && metadata.computerId === source.computerId && metadata.nodeId === source.nodeId
  && metadata.nativeSessionId === identity.nativeSessionId && metadata.threadId === identity.threadId
  && metadata.provider === identity.provider && metadata.account === identity.account

// These readers are supplied by main for this person's own saved tabs and
// canonical transcripts. Renderer values are exact selectors, never evidence
// of ownership, provider identity, sign-in home or a stopped process.
function createStoppedConversationAdoption({ readTabs, readTranscript, store } = {}) {
  return Object.freeze({
    async prepare({ identity, source, destination, assertCurrent }) {
      if (typeof readTabs !== 'function' || typeof readTranscript !== 'function'
          || typeof store?.append !== 'function' || typeof store?.bindSessionMetadata !== 'function') refuse()
      const verifyTab = () => {
        let ledger
        try {
          const raw = readTabs(source.computerId)
          if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_TAB_BYTES) refuse()
          ledger = JSON.parse(raw)
        } catch { refuse() }
        if (ledger?.v !== 1 || !Array.isArray(ledger.tabs) || ledger.tabs.length > MAX_TABS) refuse()
        const matches = ledger.tabs.filter(tab => tab?.id === source.nodeId)
        if (matches.length !== 1 || matches[0].sessionId !== identity.nativeSessionId) refuse()
      }
      verifyTab(); assertCurrent()
      let page = checked(await readTranscript({ ...source, limit: PAGE_SIZE }))
      if (!sameIdentity(page.metadata, identity, source)) refuse()
      const revision = page.metadata.revision
      const rows = [], cursors = new Set()
      for (let pages = 0; ; pages++) {
        assertCurrent()
        if (pages >= MAX_PAGES || !sameIdentity(page.metadata, identity, source)
            || page.metadata.revision !== revision || !Array.isArray(page.entries)) refuse()
        rows.unshift(...page.entries.filter(entry => entry?.promptSource !== 'toolsenabled')
          .map(({ recoveryFiles: _sourceFiles, ...entry }) => entry))
        if (!page.before) break
        if (!page.entries.length || typeof page.before !== 'string' || cursors.has(page.before)) refuse()
        cursors.add(page.before)
        page = checked(await readTranscript({ ...source, before: page.before, strictBefore: true, limit: PAGE_SIZE }))
      }
      const verify = async () => {
        verifyTab(); assertCurrent()
        const current = checked(await readTranscript({ ...source, limit: 1 }))
        if (!sameIdentity(current.metadata, identity, source) || current.metadata.revision !== revision) refuse()
        assertCurrent()
      }
      return Object.freeze({
        async persist() {
          await verify()
          const target = checked(await store.read({ ...destination, limit: 1 }))
          if (target.entries?.length || target.metadata?.nativeSessionId || target.metadata?.closed) refuse()
          assertCurrent()
          // The destination is a new reservation. Speech and actions become
          // durable before native ownership moves; a refusal leaves the source
          // untouched and the renderer removes only that empty reservation.
          for (let offset = 0; offset < rows.length; offset += PAGE_SIZE) {
            checked(await store.append({ ...destination, entries: rows.slice(offset, offset + PAGE_SIZE) }))
            assertCurrent()
          }
          await verify()
          checked(await store.bindSessionMetadata({ ...destination, sessionId: identity.nativeSessionId,
            metadata: { threadId: identity.threadId, provider: identity.provider, account: identity.account },
            replace: true }))
          await verify()
          return { count: rows.length }
        },
      })
    },
  })
}
module.exports = { createStoppedConversationAdoption, REFUSAL, MAX_TAB_BYTES, MAX_TABS, MAX_PAGES, PAGE_SIZE }
