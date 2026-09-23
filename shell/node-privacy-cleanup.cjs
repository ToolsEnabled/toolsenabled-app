'use strict'

const PENDING_KEY = 'mc.node-privacy.pending.v1'
function createNodePrivacyCleanup({ prefs, org, transcripts }) {
  const checked = answer => {
    if (!answer?.ok) throw new Error('Node privacy cleanup could not finish: ' + (answer?.error?.message || answer?.message || 'storage is unavailable'))
    return answer
  }
  const pending = () => checked(prefs.snapshot()).values[PENDING_KEY] === '1'
  return {
    prepare() {
      checked(prefs.prepareNodePrivacyCleanup())
      checked(org.resetOrg())
    },
    complete() { if (pending()) checked(prefs.remove(PENDING_KEY)) },
    async recover() {
      if (!pending()) return
      // The marker is persisted with the node removal, before either of the
      // other stores changes. A failed quit resumes cleanup before new nodes
      // or seats may be created, without discarding the owner's other settings.
      checked(org.resetOrg())
      await transcripts.clearForPrivacy()
      checked(prefs.remove(PENDING_KEY))
    },
  }
}
module.exports = { createNodePrivacyCleanup, PENDING_KEY }
