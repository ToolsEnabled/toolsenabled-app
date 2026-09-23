'use strict'

/* Every process-level capability override whose value selects a filesystem
 * root, directory, database or file. These seams exist for isolated fixtures
 * and subordinate processes; an interactive app launch must not inherit one
 * and silently splice this installation's account into another state tree.
 *
 * Keep this list explicit. A broad TOOLSENABLED_* scrub would also erase
 * non-path launch facts that the shell deliberately supplies. The regression
 * test cross-checks every path-shaped name used by capability/src against this
 * list so a new persistence seam cannot arrive without joining the fence. */
const CAPABILITY_PATH_OVERRIDE_ENVIRONMENT_NAMES = Object.freeze([
  'OVERNIGHT_ADVISORY_RUNTIME_DIR',
  'OVERNIGHT_ADVISORY_STATE_DIR',
  'TOOLSENABLED_ACTIVE_REQUEST_PATH',
  'TOOLSENABLED_AGENT_COMMS_BROKER_FILE',
  'TOOLSENABLED_AGENT_LAUNCH_DIR',
  'TOOLSENABLED_AGENT_MAILBOX_DIR',
  'TOOLSENABLED_AGENT_PRESENCE_FILE',
  'TOOLSENABLED_AGENT_USEFUL_PROGRESS_DIR',
  'TOOLSENABLED_AUDIT_DB',
  'TOOLSENABLED_AUDIT_EMERGENCY_PATH',
  'TOOLSENABLED_AUDIT_JSONL_PATH',
  'TOOLSENABLED_AUDIT_TEXT_PATH',
  'TOOLSENABLED_BROWSER_OWNER_PATH',
  'TOOLSENABLED_BROWSER_PROFILE_PATH',
  'TOOLSENABLED_KILLSWITCH_PATH',
  'TOOLSENABLED_OWNER_LEDGER_FILE',
  'TOOLSENABLED_PLAYWRIGHT_OUTPUT_PATH',
  'TOOLSENABLED_PROJECT_ROOT',
  'TOOLSENABLED_PROTECTED_PROJECT_ROOT',
  'TOOLSENABLED_PROVIDER_STATE_FILE',
  'TOOLSENABLED_PROVIDERS_ROOT',
  'TOOLSENABLED_RESEARCH_ARTIFACT_DIR',
  'TOOLSENABLED_RESEARCH_DB',
  'TOOLSENABLED_RUNTIME_ROOT',
  'TOOLSENABLED_SCHEDULER_LEGACY_PATH',
  'TOOLSENABLED_SEARCH_DB',
  'TOOLSENABLED_SETTINGS_PATH',
  'TOOLSENABLED_STATE_PATH',
  'TOOLSENABLED_STATE_ROOT',
  'TOOLSENABLED_TREE_DIRECTORY_FILE',
  'TOOLSENABLED_VAULT_PATH',
  'TOOLSENABLED_WORKER_RUNTIME_DIR',
])

const CAPABILITY_PATH_OVERRIDE_KEYS = new Set(CAPABILITY_PATH_OVERRIDE_ENVIRONMENT_NAMES)

function isCapabilityPathOverrideEnvironmentName(name) {
  return typeof name === 'string' && CAPABILITY_PATH_OVERRIDE_KEYS.has(name.toUpperCase())
}

function scrubCapabilityPathOverrides(environment) {
  if (!environment || typeof environment !== 'object') return environment
  for (const name of Object.keys(environment)) {
    if (isCapabilityPathOverrideEnvironmentName(name)) delete environment[name]
  }
  return environment
}

module.exports = Object.freeze({
  CAPABILITY_PATH_OVERRIDE_ENVIRONMENT_NAMES,
  isCapabilityPathOverrideEnvironmentName,
  scrubCapabilityPathOverrides,
})
