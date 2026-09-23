'use strict'

// This fixture is missing the optional summary/recall/ledger modules on
// purpose. Confinement is mandatory, so forward to the complete fixture's
// planner to keep each absence test about exactly the module it names.
module.exports = require('../../../confined-engine/src/lib/agent-session-confinement.js')
