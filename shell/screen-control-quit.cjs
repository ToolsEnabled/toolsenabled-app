'use strict'

// Independent of other shutdown joins: their completion cannot authorize an
// exit while a native input helper or its release operation remains uncertain.
function createScreenControlQuitGuard({ host, quit, onBlocked = () => {} }) {
  let confirmed = false, flight = null
  return function beforeQuit(event) {
    if (confirmed) return
    event.preventDefault()
    if (!flight) {
      let pending
      try { pending = host.shutdown() } catch (error) { pending = Promise.reject(error) }
      flight = Promise.resolve(pending).then(result => {
        if (result?.cleanupConfirmed !== true) throw new Error('Screen cleanup was not confirmed.')
        confirmed = true
        quit()
      }).catch(error => { onBlocked(error) })
      flight.catch(() => {})
    }
    return flight
  }
}
module.exports = { createScreenControlQuitGuard }
