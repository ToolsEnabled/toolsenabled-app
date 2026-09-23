import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { asyncSingleFlight } from '../../shell/async-single-flight.cjs'
import { assertBootstrapAccountPath } from '../../shell/agent-host.cjs'

test('concurrent pre-readiness callers construct exactly one agent host', async () => {
  let releaseReadiness
  const readiness = new Promise(resolve => { releaseReadiness = resolve })
  let createAgentHostCalls = 0
  const expectedHost = Object.freeze({ kind: 'one-host' })
  const createAgentHost = async () => {
    await readiness
    createAgentHostCalls += 1
    return expectedHost
  }
  const getAgentHost = asyncSingleFlight(createAgentHost)

  const first = getAgentHost()
  const second = getAgentHost()
  assert.strictEqual(first, second, 'pre-readiness callers must share the exact in-flight promise')
  await Promise.resolve()
  assert.equal(createAgentHostCalls, 0, 'the host must not be constructed before readiness settles')

  releaseReadiness()
  const [firstHost, secondHost] = await Promise.all([first, second])
  assert.strictEqual(firstHost, expectedHost)
  assert.strictEqual(secondHost, expectedHost)
  assert.equal(createAgentHostCalls, 1, 'createAgentHost must run once for concurrent startup callers')

  const main = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
  assert.match(main, /const buildAgentHostOnce = asyncSingleFlight\(buildAgentHost\)/,
    'main must route agent-host construction through the proven single-flight')
  const getHost = main.slice(main.indexOf('function getAgentHost()'), main.indexOf('/* ---------- the agent and organisation channels'))
  assert.match(getHost, /return agentHost \? Promise\.resolve\(agentHost\) : buildAgentHostOnce\(\)/,
    'main must reuse an existing host or the one in-flight construction')
  assert.ok(getHost.indexOf('agentRuntimeStoppedForReset') < getHost.indexOf('return agentHost ?'),
    'the terminal reset gate must win before an existing or in-flight host can be reused')
  const build = main.slice(main.indexOf('async function buildAgentHost()'), main.indexOf('const buildAgentHostOnce'))
  assert.ok(build.indexOf('await capabilityLayerStarting') < build.indexOf('const host = createAgentHost({'),
    'the actual host factory must remain behind capability/owner-host readiness')
  assert.equal((build.match(/\bcreateAgentHost\(\{/g) || []).length, 1,
    'the single-flight build must contain exactly one actual createAgentHost call')
})

test('the bootstrap account fence accepts redirected profiles and rejects their siblings', { skip: process.platform !== 'win32' }, () => {
  const profileRoot = 'D:\\Profiles\\Alice'
  assert.equal(
    assertBootstrapAccountPath('D:\\Profiles\\Alice\\ToolsEnabled\\capability\\src\\engine.js', { profileRoot }),
    'D:\\Profiles\\Alice\\ToolsEnabled\\capability\\src\\engine.js',
    'an owned redirected-profile path must not require a C:\\Users spelling',
  )
  assert.throws(
    () => assertBootstrapAccountPath('D:\\Profiles\\Bob\\engine.js', { profileRoot }),
    error => error?.code === 'AGENT_CONFINEMENT_FOREIGN_PROFILE',
    'a sibling under the redirected profile parent must still be refused before access',
  )
})

test('main passes its authenticated profile fence to readiness and host construction', () => {
  const main = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
  assert.match(main, /createAgentHost\(\{[\s\S]*?profileRoot: SHELL_PROFILE_FENCE,[\s\S]*?sessionAuthority:/,
    'agent-host construction must receive the already-authenticated shell profile')
  assert.match(main, /engineAvailability: options => engineAvailability\(\{ \.\.\.options, profileRoot: SHELL_PROFILE_FENCE \}\)/,
    'availability must use the same authenticated profile as actual starts')
})
