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

function installationProfileRoot() {
  if (process.env.MC_TEST_INSTALLATION_PROFILE_ROOT) {
    return path.resolve(process.env.MC_TEST_INSTALLATION_PROFILE_ROOT)
  }
  if (process.platform === 'win32') {
    const match = /^([a-z]:\\users\\[^\\]+)(?:\\|$)/i.exec(path.win32.normalize(__dirname))
    if (match) return path.win32.normalize(match[1])
  }
  return path.parse(__dirname).root
}
const accountFenceCalls = { paths: [], environments: [] }
function assertAccountProfilePath(value, options = {}) {
  accountFenceCalls.paths.push({ value, field: options.field || null })
  if (String(value).includes('foreign-profile-sentinel')) {
    const error = new Error('fixture refused a foreign profile path before access')
    error.code = 'AGENT_CONFINEMENT_FOREIGN_PROFILE'
    throw error
  }
  return path.resolve(value)
}
function assertAccountProfileEnvironment(environment) {
  accountFenceCalls.environments.push(environment)
  if (environment?.MC_TEST_FOREIGN_PROFILE_SENTINEL) {
    const error = new Error('fixture refused a foreign profile environment before launch')
    error.code = 'AGENT_CONFINEMENT_FOREIGN_PROFILE_ENVIRONMENT'
    throw error
  }
  return environment
}

module.exports = {
  confinedSessionPlan,
  resolveAgentConfinement,
  installationProfileRoot,
  assertAccountProfilePath,
  assertAccountProfileEnvironment,
  accountFenceCalls,
}
