'use strict'

// A ROUTING STAND-IN for src/lib/providers/subscription-launch-env.js, and
// nothing more. Copied from
// tools/test/fixtures/closing-engine/src/lib/providers/subscription-launch-env.js,
// which documents the shape in full: shell/agent-host.cjs resolves this
// module out of the engine tree at start, exactly as it resolves the
// confinement planner, so a minimal engine fixture needs a working stand-in
// here even when the test using it never inspects what was scrubbed.
const BILLING_TRIPWIRE = Object.freeze(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL'])

const calls = []

function record(baseEnvironment, context) {
  calls.push({
    context,
    isLiveProcessEnv: baseEnvironment === process.env,
    names: Object.keys(baseEnvironment),
  })
}

class LaunchEnvironmentError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'LaunchEnvironmentError'
    this.code = code
    this.details = details
  }
}

function subscriptionLaunchEnvironment(baseEnvironment = process.env) {
  const environment = { ...baseEnvironment }
  for (const name of BILLING_TRIPWIRE) delete environment[name]
  return environment
}

function assertNoBillingCredentials(environment, { context = '' } = {}) {
  const leaked = BILLING_TRIPWIRE.filter(name => environment && environment[name] !== undefined)
  if (leaked.length > 0) {
    throw new LaunchEnvironmentError(
      'LAUNCH_BILLING_CREDENTIAL_PRESENT',
      `Refusing to launch a subscription CLI${context ? ` (${context})` : ''}: ${leaked.join(', ')} survived the environment scrub.`,
      { variables: leaked },
    )
  }
  return environment
}

function safeLaunchEnvironment(baseEnvironment = process.env, { context = '' } = {}) {
  record(baseEnvironment, context)
  return assertNoBillingCredentials(subscriptionLaunchEnvironment(baseEnvironment), { context })
}

module.exports = {
  BILLING_TRIPWIRE,
  LaunchEnvironmentError,
  assertNoBillingCredentials,
  calls,
  safeLaunchEnvironment,
  subscriptionLaunchEnvironment,
}
