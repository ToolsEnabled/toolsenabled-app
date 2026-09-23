'use strict'

// A launch-environment module of the WRONG SHAPE: the file is present, so an
// existsSync check is satisfied, but it cannot do the job the host needs.
//
// This is the case a presence check alone gets wrong, and it is not a contrived
// one -- it is what an older or a partial payload looks like. `subscriptionLaunchEnvironment`
// scrubs but does not assert, so a host that accepted this module would apply
// the account pin afterwards with nothing left to catch a credential the pin
// reintroduced. Recognition must be checked against the functions the host
// actually calls, not against the file existing.
function subscriptionLaunchEnvironment(baseEnvironment = process.env) {
  return { ...baseEnvironment }
}

module.exports = { subscriptionLaunchEnvironment }
