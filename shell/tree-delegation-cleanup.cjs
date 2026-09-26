'use strict'

// Called only for a main-owned failed delegation, never a renderer-supplied ID.
// A cancelled start grant does not stop a root that has already started.
async function cleanupTreeDelegation(receipt, { readSession, ownerKey, close }) {
  receipt.permit?.cancel()
  if (!receipt.childSessionId) return
  const session = readSession(receipt.childSessionId)
  if (!session) return // A pending start still meets its cancelled final guard.
  if (!receipt.permit || session.treeDelegationStart !== receipt.permit) {
    throw Object.assign(new Error('The failed tree start has been replaced; the replacement was not touched.'), { code: 'TREE_DELEGATION_CLEANUP_FAILED' })
  }
  const principal = { kind: session.ownerKind, owner: session.owner,
    label: 'The application cleaning up its failed tree start', mayWrite: true }
  if (ownerKey(principal) !== receipt.ownerKey) {
    throw Object.assign(new Error('The failed tree start no longer has the expected owner.'), { code: 'TREE_DELEGATION_CLEANUP_FAILED' })
  }
  await close(receipt.childSessionId, principal)
  if (readSession(receipt.childSessionId) === session) {
    throw Object.assign(new Error('The failed tree start could not be confirmed closed.'), { code: 'TREE_DELEGATION_CLEANUP_FAILED' })
  }
}

module.exports = { cleanupTreeDelegation }
