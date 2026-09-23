'use strict'

const path = require('node:path')

// Stands in for the real planner. `confinedSessionPlan` answers whatever the
// test staged in MC_TEST_CONFINEMENT_PLAN, so the host's own resolution path --
// engine root -> hostModule -> confinedSessionPlan -- is the thing exercised.
function confinedSessionPlan() {
  return JSON.parse(process.env.MC_TEST_CONFINEMENT_PLAN || '{"ok":false,"code":"AGENT_CONFINEMENT_UNAVAILABLE"}')
}

/* The READ-ONLY half the availability probe asks about, staged the same way.
 *
 * DEFAULTS TO A SYNTHETIC NON-ISOLATED ANSWER ON PURPOSE. No production tier
 * has this shape today. An unstaged fixture keeps tests unrelated to readiness
 * independent of a credential; tests of the real boundary stage `isolated`
 * explicitly and an installation-owned profile, so ambient auth.json state can
 * never decide them. */
function resolveAgentConfinement() {
  return JSON.parse(process.env.MC_TEST_CONFINEMENT_RESOLVED || '{"tier":"unrestricted","isolated":false}')
}

function installationProfileRoot() { return path.parse(__dirname).root }
function assertAccountProfilePath(value) { return path.resolve(value) }
function assertAccountProfileEnvironment(environment) { return environment }

module.exports = { confinedSessionPlan, resolveAgentConfinement, installationProfileRoot, assertAccountProfilePath, assertAccountProfileEnvironment }
