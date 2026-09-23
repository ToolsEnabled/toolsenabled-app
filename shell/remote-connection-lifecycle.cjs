'use strict'

const adminContract = require('./owner-administration-contract.cjs')

// One join between local disconnect intent and the two owners of remote
// authority: the claim child and the relay child. Storage outcome and process
// completion are distinct facts; neither may be inferred from a timer.
function createRemoteConnectionLifecycle({ fence, claim, relay, revoke, clearConsent, onConnected = async () => {} } = {}) {
  for (const [name, value] of Object.entries({ fence, claim, relay })) {
    if (!value || typeof value !== 'object') throw new TypeError(name + ' is required')
  }
  for (const [name, value] of Object.entries({ revoke, clearConsent, onConnected })) {
    if (typeof value !== 'function') throw new TypeError(name + ' is required')
  }
  if (typeof claim.invalidateForDisconnect !== 'function') throw new TypeError('Claim invalidation is required')
  let disconnectFlight = null
  let claimTicket = null
  let adminFlight = null
  let cleanupBarrier = fence.snapshot().disconnectPending || Boolean(fence.snapshot().pendingOwner)
  // A newly created lifecycle has not admitted any in-memory remote grant.
  let grantsRevokedKnown = true
  let lastMutationOutcome = fence.snapshot().mutationOutcome
  let hasRun = false

  function failure(code, reason) { return Object.freeze({ ok: false, code, reason }) }
  function pending() {
    return failure('DEVICE_CLAIM_DISCONNECT_PENDING', 'Remote access is blocked while this computer finishes disconnecting. Check its connection status before taking another action.')
  }
  function consentRefusal() {
    return failure('DEVICE_CLAIM_CONSENT_CLEAR_FAILED', 'The previous remote-control choice could not be cleared. Remote access remains blocked. Check that ToolsEnabled can save its settings before connecting again.')
  }
  function clearChoice() {
    try { return clearConsent() === true } catch { return false }
  }
  function metadata(answer) {
    const current = fence.snapshot()
    return Object.freeze({
      ...answer,
      remoteAccessBlocked: current.blocked,
      disconnectPending: current.blocked && (cleanupBarrier || current.disconnectPending || Boolean(current.pendingOwner)),
      restartSafety: current.restartSafety,
    })
  }
  function safely(action, fallback) {
    try { return Promise.resolve(action()).catch(() => fallback) } catch { return Promise.resolve(fallback) }
  }
  function remoteStoppedNow() {
    try { return relay.status().running === false } catch { return false }
  }
  async function reconcileOwnership() {
    const owner = fence.snapshot().pendingOwner
    if (!owner) return true
    const result = await safely(() => claim.reconcileOwnership(owner), { quiescent: false })
    if (result?.quiescent !== true) return false
    return fence.completeOwnership(owner, result.receipt) === true
  }
  function priorOwnerPending() {
    const owner = fence.snapshot().pendingOwner
    if (!owner) return false
    try { return claim.ownsPendingOwnership(owner) !== true } catch { return true }
  }
  function unknownChild() {
    return { ...pending(), childQuiescent: false, remoteStopped: remoteStoppedNow(), credentialObservedAbsent: false }
  }

  function administrativeFailure() {
    return failure('DEVICE_ADMIN_REFUSED', 'Administrative enrollment remains blocked. Check the trusted operation and its exact receipt before retrying.')
  }
  function sameOperation(operation, expected) {
    return operation && operation.operationId === expected.operationId && operation.contextDigest === expected.contextDigest
  }
  function administer(action, input) {
    hasRun = true
    if (adminFlight || disconnectFlight || !adminContract.ACTIONS.has(action)) return Promise.resolve(metadata(administrativeFailure()))
    let operation
    try {
      if (action === 'identity') adminContract.context(input.context, undefined, true)
      else operation = adminContract.binding(input.context)
    } catch { return Promise.resolve(metadata(administrativeFailure())) }
    const initialTicket = fence.ticket()
    const run = async () => {
      let ticket = initialTicket
      const fresh = () => fence.isCurrent(ticket) && !disconnectFlight
      if (fence.snapshot().damaged || claim.claimOpen?.() || claimTicket !== null) return metadata(administrativeFailure())
      if (action === 'identity') {
        if (fence.snapshot().adminOperation || !remoteStoppedNow()) return metadata(administrativeFailure())
        if (priorOwnerPending() && !await reconcileOwnership()) return metadata(unknownChild())
        if (!fresh() || fence.snapshot().pendingOwner) return metadata(administrativeFailure())
        const answer = await claim.administer(action, input)
        return metadata(fresh() && answer?.childQuiescent === true ? answer : administrativeFailure())
      }
      if (action === 'pair-request') {
        if (!fence.allowsRemote() || claim.enrolled() !== true || input.webDriveEnabled !== true) return metadata(administrativeFailure())
        const answer = await claim.administer(action, input)
        return metadata(fresh() && fence.allowsRemote() && answer.childQuiescent === true ? answer : administrativeFailure())
      }
      if (!remoteStoppedNow()) return metadata(administrativeFailure())
      const cancelAfterDisconnect = action === 'cancel' && !fence.snapshot().adminOperation
      if (action === 'prepare' || cancelAfterDisconnect) {
        if (cancelAfterDisconnect && !fence.snapshot().blocked) return metadata(administrativeFailure())
        if (cleanupBarrier || fence.snapshot().disconnectPending || fence.snapshot().pendingOwner || fence.snapshot().adminOperation) return metadata(administrativeFailure())
        const status = await claim.status()
        if (!fresh() || status?.ok !== true || status.connected !== false || status.childQuiescent !== true
            || !remoteStoppedNow() || claim.claimOpen?.() || fence.snapshot().pendingOwner) return metadata(administrativeFailure())
        ticket = fence.reserveAdministration(ticket, operation)
        if (ticket === null) return metadata(administrativeFailure())
      } else {
        if (!sameOperation(fence.snapshot().adminOperation, operation)) return metadata(administrativeFailure())
        // A restart may retain the prior child. Reconcile that exact owner
        // before admitting even a read; a replacement child's exit is unrelated.
        if (priorOwnerPending() && !await reconcileOwnership()) return metadata(unknownChild())
        if (!fresh() || fence.snapshot().pendingOwner || !remoteStoppedNow()) return metadata(administrativeFailure())
        if (fence.snapshot().disconnectPending && !fence.completeCleanup(ticket)) return metadata(administrativeFailure())
        cleanupBarrier = false
      }
      // Retire old in-memory workspace/facade owners before any new grant can
      // be collected. Reservation already closed the durable admission fence.
      grantsRevokedKnown = false
      const revoked = await safely(revoke, false)
      if (!fresh() || revoked !== true || !remoteStoppedNow()) return metadata(administrativeFailure())
      grantsRevokedKnown = true
      const answer = await claim.administer(action, input)
      if (!fresh() || !sameOperation(fence.snapshot().adminOperation, operation)) return metadata(administrativeFailure())
      if (answer?.ok !== true || answer.childQuiescent !== true || fence.snapshot().pendingOwner || !remoteStoppedNow()) return metadata(answer?.ok === false ? answer : administrativeFailure())
      if (action === 'cancel') {
        if (!fence.cancelAdministration(ticket, operation)) return metadata(administrativeFailure())
      } else if (action === 'finalize') {
        let receipt
        try { receipt = adminContract.receipt(answer.receipt, input.context) } catch { return metadata(administrativeFailure()) }
        if (answer.stage !== 'finalized' || receipt.serverCollected !== true) return metadata(administrativeFailure())
        if (!clearChoice()) return metadata(consentRefusal())
        // Cache publication precedes unblocking. A failed fence write therefore
        // still refuses relay admission. No cached status can clear this record.
        if (claim.completeAdministration(answer.receipt) !== true
          || !fence.completeAdministrativeEnrollment(ticket, operation, { consentCleared: true })) return metadata(administrativeFailure())
        await onConnected(ticket)
        if (!fresh() || !fence.allowsRemote()) return metadata(administrativeFailure())
      }
      return metadata(answer)
    }
    adminFlight = Promise.resolve().then(run).catch(() => metadata(administrativeFailure()))
    const flight = adminFlight
    flight.finally(() => { if (adminFlight === flight) adminFlight = null })
    return flight
  }

  return Object.freeze({
    administer,
    prepareForPrimary() {
      if (hasRun || fence.refreshForPrimary() !== true) return false
      const current = fence.snapshot()
      cleanupBarrier = current.disconnectPending || Boolean(current.pendingOwner)
      lastMutationOutcome = current.mutationOutcome
      return true
    },
    async status() {
      hasRun = true
      if (priorOwnerPending() && !await reconcileOwnership()) return metadata(unknownChild())
      const answer = await safely(() => claim.status(), unknownChild())
      const childQuiescent = answer?.childQuiescent === true
      const remoteStopped = remoteStoppedNow()
      const credentialObservedAbsent = answer?.ok === true && answer.connected === false
      if (!disconnectFlight && credentialObservedAbsent && childQuiescent && remoteStopped && grantsRevokedKnown) {
        if (fence.snapshot().blocked) fence.completeCleanup(fence.ticket())
        cleanupBarrier = fence.snapshot().disconnectPending || Boolean(fence.snapshot().pendingOwner)
      }
      return Object.freeze({ ...metadata(answer), childQuiescent, remoteStopped,
        credentialObservedAbsent,
        ...(lastMutationOutcome ? { mutationOutcome: lastMutationOutcome } : {}) })
    },

    async begin(request) {
      hasRun = true
      if (fence.snapshot().damaged) {
        return metadata(failure('DEVICE_CLAIM_CONNECTION_STATE_UNREADABLE',
          'The saved connection state cannot be read safely. Remote access is blocked. Preserve the existing app data and use supported recovery before connecting again.'))
      }
      if (adminFlight || fence.snapshot().adminOperation || disconnectFlight || cleanupBarrier || fence.snapshot().disconnectPending || priorOwnerPending()) return metadata(pending())
      const ticket = fence.ticket()
      const deciding = request && Object.prototype.hasOwnProperty.call(request, 'accept')
      if (deciding && claimTicket !== ticket) return metadata(pending())
      const answer = await safely(() => claim.begin(request), unknownChild())
      if (!fence.isCurrent(ticket) || disconnectFlight) return metadata(pending())
      if (!deciding && answer?.ok === true) claimTicket = ticket
      return metadata(answer)
    },

    async poll() {
      hasRun = true
      if (adminFlight || fence.snapshot().adminOperation || disconnectFlight || cleanupBarrier || fence.snapshot().disconnectPending || priorOwnerPending()) return metadata(pending())
      const ticket = fence.ticket()
      const answer = await safely(() => claim.poll(), unknownChild())
      if (!fence.isCurrent(ticket) || disconnectFlight) return metadata(pending())
      if (answer?.ok === true && answer.state === 'connected') {
        if (claimTicket !== ticket) return metadata(pending())
        if (!clearChoice()) {
          fence.block()
          fence.recordDisconnect(fence.ticket())
          return metadata(consentRefusal())
        }
        if (!fence.completeFreshClaim(ticket, { consentCleared: true })) {
          return metadata(failure('DEVICE_CLAIM_CONNECTION_STATE_WRITE_FAILED',
            'This computer received its connection, but could not save the local permission to resume remote access. Remote access remains blocked. Check that ToolsEnabled can save its data.'))
        }
        claimTicket = null
        await onConnected(ticket)
        if (!fence.isCurrent(ticket) || disconnectFlight) return metadata(pending())
      }
      return metadata(answer)
    },

    cancel() {
      hasRun = true
      const answer = claim.cancel()
      if (answer?.ok === true) claimTicket = null
      return metadata(answer)
    },

    disconnect() {
      hasRun = true
      if (disconnectFlight) return disconnectFlight
      // All of these happen before the first await. A refusal from the vault
      // must not preserve an already admitted grant or let a late poll restart.
      const ticket = fence.block()
      claimTicket = null
      cleanupBarrier = true
      grantsRevokedKnown = false
      const claimStopped = safely(() => claim.invalidateForDisconnect(), { quiescent: false })
      const grantsRevoked = safely(revoke, false)
      const relayStopped = safely(() => relay.stop(), { ok: false, stopped: false })
      const consentCleared = clearChoice()
      const intentRecorded = fence.recordDisconnect(ticket)
      disconnectFlight = (async () => {
        const [claimReceipt, relayReceipt, revoked] = await Promise.all([claimStopped, relayStopped, grantsRevoked])
        const quiescent = claimReceipt?.quiescent === true && await reconcileOwnership()
        const stopped = relayReceipt?.ok === true && relayReceipt.stopped === true
        const localRevoked = revoked === true
        grantsRevokedKnown = localRevoked
        // Do not race a replacement credential with an unobserved old helper.
        const answer = quiescent && stopped && localRevoked
          ? await safely(() => claim.disconnect(), { ...failure('DEVICE_CLAIM_DISCONNECT_UNCERTAIN',
            'The connection cleanup did not return a confirmed result. Check its status before taking another action.'), mutationOutcome: 'UNCERTAIN' })
          : pending()
        const finalQuiescent = answer?.childQuiescent === true
        if (['REMOVED_SYNCED', 'NOT_ATTEMPTED', 'UNCERTAIN'].includes(answer?.mutationOutcome)) {
          lastMutationOutcome = answer.mutationOutcome
          fence.recordOutcome(ticket, lastMutationOutcome)
        }
        let cleanupRecorded = false
        if (answer?.ok === true && finalQuiescent && stopped && localRevoked) {
          cleanupRecorded = fence.completeCleanup(ticket)
          cleanupBarrier = fence.snapshot().disconnectPending || Boolean(fence.snapshot().pendingOwner)
        }
        const completed = answer?.ok === true && finalQuiescent && stopped && localRevoked && consentCleared && intentRecorded && cleanupRecorded
        const result = answer?.ok === true && !completed
          ? failure('DEVICE_CLAIM_CONNECTION_STATE_WRITE_FAILED', 'Remote access stopped, but this computer could not save every part of the disconnect. Check that ToolsEnabled can save its data before connecting again.')
          : answer
        return Object.freeze({
          ...metadata(result),
          credentialCleared: answer?.ok === true,
          ...(answer?.mutationOutcome ? { mutationOutcome: answer.mutationOutcome } : {}),
          remoteStopped: stopped && localRevoked,
          childQuiescent: finalQuiescent,
          webDriveConsentCleared: consentCleared,
          restartSafety: fence.snapshot().restartSafety,
          // A successful storage receipt does not cure failed consent or intent
          // persistence. Keep each outcome visible rather than invent rollback.
          disconnectPending: !completed || !stopped || !localRevoked,
        })
      })()
      const finished = disconnectFlight
      finished.finally(() => { if (disconnectFlight === finished) disconnectFlight = null }).catch(() => {})
      return finished
    },
  })
}
module.exports = { createRemoteConnectionLifecycle }
