#!/usr/bin/env node

// Real Local inference is an explicit opt-in, never a provider-free substitute.
// This driver stages only exact candidate bytes. Fixture identity/settings are
// disclosed; it does not qualify onboarding, installer lifecycle or update.
// No model server, model response, native bridge, tool result or turn is faked.
// Usage: node tools/agent-really-starts-qa.mjs --release <candidate-dir>
//   --run-local-inference --local-model <installed-model> [--visible]
//   [--local-endpoint http://127.0.0.1:11434] [--local-gpu-policy 'Require GPU']
//   [--out <new-private-evidence-dir>]
// Exit 3: missing prerequisite; 1: failed journey/cleanup; 0: all measured.

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import {
  stage, STAGE_EXACT_RELEASE, exactTreeManifest, seedMachineRecord, environmentFor,
  userDataFor, openWindow,
} from './test-account-harness.mjs'
import { makePrivateDirectory } from './lib/packaged-platform.mjs'
import owned from '../shell/owned-claim-process.cjs'
import {
  LOCAL_QA_ROLE, localQaOptions, selectedModel, prerequisite, readOwnedJson,
  sha256, runLocalNativeJourney, assertLocalCleanup, assertLocalAccountPath, readLocalThread, assertLocalSourceInputs,
} from './lib/local-agent-native-journey.mjs'

const SELF = fileURLToPath(import.meta.url), REPO = path.resolve(path.dirname(SELF), '..')
const require = createRequire(import.meta.url)
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

export async function metadata(endpoint, route, { fetchImpl = fetch } = {}) {
  assert.ok(['/api/tags', '/api/version'].includes(route), 'Only read-only local runtime metadata routes are allowed')
  let response
  try { response = await fetchImpl(endpoint + route, { signal: AbortSignal.timeout(5000), redirect: 'error' }) }
  catch { prerequisite(`The selected loopback runtime is unavailable at ${route}; start it before this explicitly selected model journey.`) }
  if (!response.ok) prerequisite(`The selected local runtime refused ${route} with HTTP ${response.status}.`)
  if (!response.body?.getReader) prerequisite(`The selected local runtime returned no metadata body for ${route}.`)
  const reader = response.body.getReader(); const chunks = []; let bytes = 0
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break
      bytes += next.value.length; if (bytes > 1024 * 1024) prerequisite('Local runtime metadata exceeded 1 MiB.')
      chunks.push(Buffer.from(next.value))
    }
  } catch (error) {
    if (error?.code === 'LOCAL_QA_PREREQUISITE') throw error
    prerequisite(`The selected local runtime metadata stream failed for ${route}.`)
  } finally { await reader.cancel().catch(() => {}) }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { prerequisite(`The selected local runtime returned invalid JSON for ${route}.`) }
}

function fixture(staged, profile, options) {
  // This is an explicitly selected QA profile. The proof asks the native
  // worker to read one fixture file, so it must use the tier that admits that
  // exact function; Standard/Guided are covered by the refusal tests below.
  const servicesRoot = seedMachineRecord(profile, staged.appRoot, 'unrestricted')
  const environment = environmentFor(profile)
  const stateRoot = path.join(userDataFor(profile), 'capability')
  makePrivateDirectory(userDataFor(profile)); makePrivateDirectory(stateRoot)
  const engineRoot = path.join(staged.appRoot, 'resources', 'capability')
  const env = { ...environment, TOOLSENABLED_STATE_ROOT: stateRoot }
  const settings = require(path.join(engineRoot, 'src/lib/settings.js'))
  const file = settings.resolveValuesPath({ env })
  assert.ok(path.relative(profile, file) && !path.relative(profile, file).startsWith('..'))
  const values = { 'model.provider': 'Ollama', 'model.endpoint': options.endpoint,
    'model.name': options.model, 'model.local_agent_name': options.model,
    'model.local_gpu_policy': options.gpuPolicy, 'model.local_context_tokens': 8192,
    'model.local_thinking': 'Fast', 'model.local_keep_alive_minutes': 1,
    'agent.agent_api': 'Only' }
  makePrivateDirectory(path.dirname(file))
  save(file, { revision: 1, values, provenance: Object.fromEntries(Object.keys(values)
    .map(id => [id, { source: 'user', atMs: Date.now(), directive: null }])) })
  const parsed = settings.loadSettings({ valuesPath: file, env })
  assert.deepEqual(parsed.rejected, [], 'Candidate must accept every explicit fixture setting')
  for (const [id, value] of Object.entries(values)) assert.equal(parsed.values[id], value)
  const stores = require(path.join(engineRoot, 'src/lib/agent-org-store.js')).createInstalledAgentOrgStores({
    baselineFile: path.join(engineRoot, 'config/agent-org.json'), env,
  })
  stores.roleStore.createCustomRole({ id: LOCAL_QA_ROLE,
    rules: { owns: 'Read only the exact requested fixture file and answer the person.',
      mustNot: 'Never write files, run commands, delegate, or call another tool.', handoff: 'Return the observed file contents.' },
    functions: ['host.read_file'], requiresDirectUserAuthorization: true })
  assert.deepEqual(stores.roleStore.getRole(LOCAL_QA_ROLE).functions, ['host.read_file'])
  const workspace = path.join(profile, 'home', path.basename(userDataFor(profile)))
  const challenge = `LOCAL_TOOL_CONTENT_${crypto.randomUUID()}\n`
  const challengeFile = path.join(workspace, `challenge-${crypto.randomUUID()}.txt`)
  fs.writeFileSync(challengeFile, challenge, { mode: 0o600, flag: 'wx' })
  return { engineRoot, servicesRoot, stateRoot, environment, file: challengeFile, content: challenge, values, settingsPath: file }
}

async function worker(configFile) {
  // An internal worker report is explicitly unqualified until its parent gets
  // the native containment receipt. Running this mode alone cannot emit PASS.
  const root = path.dirname(configFile), config = readOwnedJson(root, path.basename(configFile), 65536).value
  assert.equal(config.version, 1); assert.equal(config.stageMode, STAGE_EXACT_RELEASE)
  assert.ok(config.root === root && path.dirname(config.profile) === root)
  assert.equal(config.stateRoot, path.join(userDataFor(config.profile), 'capability'))
  let window = null, failure = null, journey = null
  const steps = []
  async function record(name, value) {
    const item = { name, at: new Date().toISOString(), value }
    steps.push(item); save(path.join(root, `${name}.json`), item)
  }
  try {
    window = await openWindow(config.executable, config.profile)
    const observedSettings = await window.evaluate(`(async()=>{const s=await window.mcSettings.read();return {ok:s.ok,available:s.available,valuesPath:s.valuesPath,
      rows:(s.rows||[]).filter(r=>${JSON.stringify(Object.keys(config.values))}.includes(r.id)).map(r=>({id:r.id,value:r.value}))}})()`)
    assert.equal(observedSettings?.ok, true); assert.equal(observedSettings.available, true)
    assert.equal(observedSettings.valuesPath, config.settingsPath)
    for (const [id, value] of Object.entries(config.values)) assert.equal(observedSettings.rows.find(row => row.id === id)?.value, value)
    await record('native-identity', { executable: config.executable, processId: window.child.pid,
      candidateManifestSha256: config.candidateManifestSha256, profile: config.profile,
      endpoint: config.endpoint, model: config.model, modelDigest: config.modelDigest, settings: observedSettings })
    journey = await runLocalNativeJourney({ window,
      configuration: { model: config.model, file: config.file, content: config.content }, record,
      readThread: id => readLocalThread(config.profile, config.stateRoot, id),
    })
  } catch (error) {
    failure = { code: error.code || 'LOCAL_QA_JOURNEY_FAILED', message: String(error.message).slice(0, 2000) }
    try { await record('failure', failure) } catch { /* original failure retained below */ }
  } finally {
    if (window) {
      try {
        await window.session.send('Browser.close', {}, 10000)
      } catch (error) {
        // A successful Browser.close may close its own CDP socket first. The
        // retained ChildProcess handle, below, decides whether it exited.
        if (window.child.exitCode === null) await pause(200)
      }
      const until = Date.now() + 10000
      while (window.child.exitCode === null && window.child.signalCode === null && Date.now() < until) await pause(100)
      if (window.child.exitCode === null && window.child.signalCode === null) failure ||= { code: 'LOCAL_QA_APP_CLOSE_UNCONFIRMED', message: 'The native app did not close; containment cleanup must finish and this run fails.' }
      window.session.close()
    }
    save(path.join(root, 'worker-observations.json'), { version: 1, qualified: false, proofScope: 'native-exact-candidate-fixture',
      inputSha256: sha256(fs.readFileSync(configFile)), steps, journey, failure })
  }
  // The native outer owner retains/reaps any surviving owned descendants.
  // Never use a numeric PID/tree guess or wait indefinitely for leaked pipes.
  process.exit(failure ? 1 : 0)
}

export async function ownedWorker(config, environment, engineRoot, root, { spawnClaim = owned.spawnOwnedClaim } = {}) {
  makePrivateDirectory(path.join(root, 'owner-state'))
  const owner = spawnClaim({ spawn, command: process.execPath,
    args: [SELF, '--internal-local-worker', config, ...(process.argv.includes('--visible') ? ['--visible'] : [])], payloadRoot: engineRoot,
    stateRoot: path.join(root, 'owner-state'), environment, cleanupTimeoutMs: 15000 })
  let output = '', outputBytes = 0, cancelled = false, cleanupTimer, abandon, cancellation
  const abandoned = new Promise(resolve => { abandon = resolve })
  const cancel = () => {
    if (cancelled) return cancellation
    cancelled = true
    cleanupTimer = setTimeout(() => abandon(null), 16000)
    cancellation = Promise.resolve().then(() => owner.cancel()).catch(() => null)
    return cancellation
  }
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel)
  const timeout = setTimeout(cancel, 900000)
  for (const stream of [owner.child.stdout, owner.child.stderr].filter(Boolean)) {
    stream.on('error', cancel)
    stream.on('data', chunk => {
      outputBytes += chunk.length
      if (outputBytes > 1024 * 1024) cancel()
      else output += chunk.toString('utf8')
    })
  }
  try {
    const receipt = await Promise.race([owner.completion, abandoned])
    if (!receipt) {
      owner.child.unref?.()
      for (const stream of owner.child.stdio || []) stream?.destroy?.()
    }
    fs.writeFileSync(path.join(root, 'worker.log'), output, { mode: 0o600, flag: 'wx' })
    assert.equal(cancelled, false, 'The bounded native journey was cancelled, timed out, or exceeded its output cap')
    assertLocalCleanup(receipt)
    return receipt
  } catch (error) {
    await Promise.race([cancel(), abandoned])
    throw error
  } finally { clearTimeout(timeout); clearTimeout(cleanupTimer); process.off('SIGINT', cancel); process.off('SIGTERM', cancel) }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv[0] === '--internal-local-worker') { assert.ok(argv.length === 2 || (argv.length === 3 && argv[2] === '--visible')); return worker(path.resolve(argv[1])) }
  const options = localQaOptions(argv)
  const base = process.env.TEST_ACCOUNT_QA_SCRATCH || os.tmpdir()
  for (const file of [options.release, base, ...(options.out ? [options.out] : [])]) assertLocalAccountPath(file)
  const model = selectedModel(await metadata(options.endpoint, '/api/tags'), options.model)
  const version = await metadata(options.endpoint, '/api/version')
  assert.ok(typeof version.version === 'string' && version.version.length <= 100)
  makePrivateDirectory(base)
  const root = options.out || path.join(base, `local-native-qa-${crypto.randomUUID()}`)
  assert.equal(fs.existsSync(root), false, 'Local QA evidence directory must be new; failed runs are never overwritten')
  makePrivateDirectory(root)
  let final
  try {
    const candidateBefore = exactTreeManifest(options.release)
    const staged = await stage(root, options.release, { mode: STAGE_EXACT_RELEASE })
    const profile = path.join(root, 'profile'); makePrivateDirectory(profile)
    const prepared = fixture(staged, profile, { ...options, model: model.name })
    const configFile = path.join(root, 'worker-input.json')
    const config = { version: 1, root, profile, stageMode: STAGE_EXACT_RELEASE, executable: staged.executable,
      driverSha256: sha256(fs.readFileSync(SELF)), journeySha256: sha256(fs.readFileSync(path.join(REPO, 'tools/lib/local-agent-native-journey.mjs'))),
      candidateManifestSha256: sha256(JSON.stringify(candidateBefore)), model: model.name, modelDigest: model.digest,
      endpoint: options.endpoint, file: prepared.file, content: prepared.content,
      stateRoot: prepared.stateRoot, settingsPath: prepared.settingsPath, values: prepared.values }
    save(configFile, config)
    const environment = { ...prepared.environment }
    for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'TOOLSENABLED_QA_STAGE_MODE']) delete environment[name]
    const cleanup = await ownedWorker(configFile, environment, prepared.engineRoot, root)
    const observed = readOwnedJson(root, 'worker-observations.json').value
    assert.equal(observed.inputSha256, sha256(fs.readFileSync(configFile)))
    assert.equal(observed.failure, null); assert.ok(observed.journey)
    assert.deepEqual(exactTreeManifest(options.release), candidateBefore, 'Selected source candidate changed during its journey')
    assert.deepEqual(exactTreeManifest(staged.appRoot, { forbiddenRoot: options.release }), candidateBefore, 'Staged candidate bytes changed during its journey')
    assert.deepEqual(selectedModel(await metadata(options.endpoint, '/api/tags'), options.model), model, 'Selected local model identity changed during the journey')
    assertLocalSourceInputs([{ path: SELF, sha256: config.driverSha256 },
      { path: path.join(REPO, 'tools/lib/local-agent-native-journey.mjs'), sha256: config.journeySha256 }])
    final = { ok: true, proofScope: 'native-exact-candidate-fixture', installerQualification: false, pixelQualification: false,
      driverSha256: config.driverSha256, journeySha256: config.journeySha256,
      candidate: { release: options.release, manifestSha256: config.candidateManifestSha256 }, model, runtimeVersion: version.version,
      fixture: { profile, machinePermission: 'unrestricted', role: LOCAL_QA_ROLE, functions: ['host.read_file'], settings: prepared.values },
      inputSha256: observed.inputSha256, cleanup, journey: observed.journey }
    save(path.join(root, 'RESULT.json'), final)
    console.log(`PASS: native Local file tool, real busy Stop and later Enter/send; ${path.join(root, 'RESULT.json')}`)
  } catch (error) {
    final = { ok: false, code: error.code || 'LOCAL_QA_FAILED', message: String(error.message).slice(0, 2000), installerQualification: false }
    save(path.join(root, 'RESULT.json'), final)
    console.error(`FAIL: ${final.code}: ${final.message}; evidence ${root}`)
    process.exitCode = error.exitCode || 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) main().catch(error => {
  console.error(`CANNOT MEASURE: ${error.code || 'LOCAL_QA_FAILED'}: ${String(error.message).slice(0, 2000)}`)
  process.exitCode = error.exitCode || 1
})
