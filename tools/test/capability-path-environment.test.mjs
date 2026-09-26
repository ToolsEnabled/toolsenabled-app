import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const require_ = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const {
  CAPABILITY_PATH_OVERRIDE_ENVIRONMENT_NAMES,
  isCapabilityPathOverrideEnvironmentName,
  scrubCapabilityPathOverrides,
} = require_(path.join(ROOT, 'shell', 'capability-path-environment.cjs'))

/* A path-shaped name that RESTRICTS instead of redirecting. A DEV runtime sets
   TOOLSENABLED_PROVIDER_ISOLATION_ROOT on purpose (tools/lib/development-session.mjs),
   and every shell reader treats its presence as "this session is private: refuse
   without an isolation policy". Scrubbing it at shell start would switch that
   isolation off, so the fence keeps it. Exactly one name may be here, and the
   test below makes it prove the restriction instead of taking it on trust. */
const RESTRICTIVE_MARKERS = new Set(['TOOLSENABLED_PROVIDER_ISOLATION_ROOT'])

function sourceFiles(directory, found = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) sourceFiles(target, found)
    else if (entry.isFile() && /\.(?:c?js|mjs)$/i.test(entry.name)) found.push(target)
  }
  return found
}

test('the centralized fence covers every path-shaped override used by capability source', () => {
  const discovered = new Set()
  for (const file of sourceFiles(path.join(ROOT, 'capability', 'src'))) {
    const source = readFileSync(file, 'utf8')
    /* TOOLSENABLED_* is the product namespace, including seams read through an
       injected environment object. Historical namespaces are discovered where
       capability code actually reads process.env; limiting this scan to the
       product prefix is how the earlier sidecar and overnight redirects escaped. */
    for (const match of source.matchAll(/TOOLSENABLED_[A-Z0-9_]+/g)) {
      if (/(?:_PATH|_FILE|_DIR|_ROOT|_DB)$/.test(match[0])) discovered.add(match[0])
    }
    for (const match of source.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) {
      if (/(?:_PATH|_FILE|_DIR|_ROOT|_DB)$/.test(match[1])) discovered.add(match[1])
    }
  }
  const declared = new Set(CAPABILITY_PATH_OVERRIDE_ENVIRONMENT_NAMES)
  assert.deepEqual([...discovered].filter(name => !declared.has(name) && !RESTRICTIVE_MARKERS.has(name)), [],
    'a capability filesystem override can bypass the centralized account-state fence')
  for (const required of [
    'TOOLSENABLED_STATE_ROOT', 'TOOLSENABLED_STATE_PATH', 'TOOLSENABLED_SCHEDULER_LEGACY_PATH',
    'TOOLSENABLED_SETTINGS_PATH', 'TOOLSENABLED_VAULT_PATH', 'TOOLSENABLED_RESEARCH_DB',
    'TOOLSENABLED_SEARCH_DB', 'TOOLSENABLED_AGENT_PRESENCE_FILE',
    'TOOLSENABLED_PROVIDER_STATE_FILE', 'TOOLSENABLED_WORKER_RUNTIME_DIR',
    'OVERNIGHT_ADVISORY_RUNTIME_DIR', 'OVERNIGHT_ADVISORY_STATE_DIR',
  ]) assert.ok(declared.has(required), `${required} is absent from the centralized fence`)
})

test('scrubbing is case-insensitive and leaves non-path launch facts alone', () => {
  const environment = Object.fromEntries(
    CAPABILITY_PATH_OVERRIDE_ENVIRONMENT_NAMES.map((name, index) => [index === 0 ? name.toLowerCase() : name, `C:\\foreign\\${index}`]),
  )
  environment.TOOLSENABLED_AGENT_ID = 'worker-one'
  environment.SystemRoot = 'C:\\Windows'

  assert.equal(isCapabilityPathOverrideEnvironmentName('toolsenabled_state_path'), true)
  scrubCapabilityPathOverrides(environment)
  for (const name of Object.keys(environment)) {
    assert.equal(isCapabilityPathOverrideEnvironmentName(name), false, `${name} survived the scrub`)
  }
  assert.equal(environment.TOOLSENABLED_AGENT_ID, 'worker-one')
  assert.equal(environment.SystemRoot, 'C:\\Windows')
})

test('the one restrictive marker is kept by the scrub and actually restricts', () => {
  const marker = 'TOOLSENABLED_PROVIDER_ISOLATION_ROOT'
  assert.deepEqual([...RESTRICTIVE_MARKERS], [marker], 'a second name joined the restrictive exemption')
  assert.equal(isCapabilityPathOverrideEnvironmentName(marker), false, 'the marker joined the scrubbed fence')
  const environment = scrubCapabilityPathOverrides({ [marker]: path.join(ROOT, 'no-such-dev-profile') })
  assert.ok(Object.hasOwn(environment, marker), 'the scrub removed the provider isolation marker')

  const { createAccountRegistryStore } = require_(path.join(ROOT, 'shell', 'account-registry.cjs'))
  assert.throws(
    () => createAccountRegistryStore({ file: path.join(ROOT, 'no-such-account-registry.json'), env: environment, providerIsolation: null }),
    { code: 'AGENT_PROVIDER_ISOLATION_UNAVAILABLE' },
    'the marker was present without an isolation policy and the account store did not refuse',
  )
})
