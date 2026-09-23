'use strict'

// A ROUTING STAND-IN for src/lib/providers/subscription-launch-env.js, and
// nothing more. Read this header before trusting what a green test here means.
//
// WHAT IT IS FOR. shell/agent-host.cjs resolves this module out of the engine
// tree at runtime, exactly as it resolves the confinement planner. The question
// these fixtures answer is whether the host ROUTES the child's environment
// through it -- at both branches, with the account pin applied afterwards and
// re-asserted -- because a scrub the caller has stopped calling is the failure
// mode that ships a protection bypassed while every source-text check stays
// green.
//
// WHAT IT IS NOT. It is NOT the authoritative credential list and must never
// grow into one. The real module composes its list by folding the provider
// gateway's own providerEnvironment() over every provider id, precisely so a
// credential added to the gateway is inherited for free and no second
// hand-written list can drift from it. The names below are a deliberately small
// sample, chosen because each one is a DIFFERENT kind of harm:
//
//   ANTHROPIC_API_KEY  a real metered credential that outranks the owner's
//                      subscription login -- the billing outage itself
//   OPENAI_API_KEY     a real metered credential belonging to ANOTHER provider
//                      than the one being launched, which is the whole reason
//                      the real module takes a union rather than a per-provider
//                      scrub
//   OPENAI_BASE_URL    no credential at all; redirects where the session's
//                      prompts and file contents go, and the session still
//                      works, so nothing looks wrong
//
// The suite that uses this pins the host to the REAL module path in production
// (tools/capability-manifest.json + PAYLOAD_LAUNCH_ENVIRONMENT_MODULE), so this
// stand-in cannot be what a customer runs.
//
// Removal is by NAME, never by pattern. An over-broad filter would strip PATH or
// APPDATA and break the resolution that finds codex on Windows -- a scrub that
// takes away a capability is a different bug, not a safer one.
const BILLING_TRIPWIRE = Object.freeze(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL'])

// What the host handed us, so a test can assert the host passed the PARENT
// environment to be scrubbed rather than scrubbing something it had already
// replaced or bypassed.
//
// NAMES AND FACTS ONLY -- NEVER THE ENVIRONMENT OBJECT ITSELF. Recording
// `baseEnvironment` directly was the first version of this, and it was wrong
// twice over. It captures process.env BY REFERENCE, so a test reading it after
// restoring the environment sees the restored values rather than the ones the
// host was given; and the value it then reads back is a REAL credential off the
// build machine, which an assertion failure prints in full to the test log.
// Measured: it printed the owner's live ANTHROPIC_API_KEY. Deciding what to
// record at call time, and recording no values, makes both impossible.
const calls = []

function record(baseEnvironment, context) {
  calls.push({
    context,
    // Identity, not equality: the property under test is that the host handed
    // over the environment the CHILD would inherit, not a copy it had already
    // altered or an empty object it scrubbed for show.
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

// Faithful to the real one in the part that matters here: names only, never
// values -- the values are precisely what must never reach a log or a renderer.
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
