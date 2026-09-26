'use strict'

const path = require('node:path')

// Stands in for the real planner. `confinedSessionPlan` answers whatever the
// test staged in MC_TEST_CONFINEMENT_PLAN, so the host's own resolution path --
// engine root -> hostModule -> confinedSessionPlan -- is the thing exercised.
function confinedSessionPlan() {
  return JSON.parse(process.env.MC_TEST_CONFINEMENT_PLAN || '{"ok":false,"code":"AGENT_CONFINEMENT_UNAVAILABLE"}')
}

function installationProfileRoot() { return path.parse(__dirname).root }
function assertAccountProfilePath(value) { return path.resolve(value) }
function assertAccountProfileEnvironment(environment) { return environment }

module.exports = { confinedSessionPlan, installationProfileRoot, assertAccountProfilePath, assertAccountProfileEnvironment }
