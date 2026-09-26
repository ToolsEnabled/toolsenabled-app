import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { assertQaSelectionHost, planFor } from '../packaged-qa-suite.mjs'
import { assertReadinessAdaptersAvailable } from '../lib/release-readiness.mjs'

const require = createRequire(import.meta.url)
const helperFile = require.resolve('../lib/sterile-launch.cjs')
const { assertSharedHostQualificationAllowed, providerAuthenticatedLaunchEnvironment,
  sterileLaunchEnvironment, sterileProfileDirectories } = require(helperFile)
const repository = path.resolve(import.meta.dirname, '../..')
const restrictive = /^(TOOLSENABLED_SHARED_HOST_SESSION|TOOLSENABLED_PROVIDER_ISOLATION_ROOT)$/i
const scratch = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-host-qa-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }))
  return root
}

test('shared build and runtime markers refuse owner-auth restoration before identity getters or filesystem work', () => {
  for (const name of ['TOOLSENABLED_SHARED_HOST_SESSION', 'toolsenabled_shared_host_session',
    'TOOLSENABLED_PROVIDER_ISOLATION_ROOT', 'toolsenabled_provider_isolation_root']) {
    for (const value of ['1', '', '0', 'false', undefined]) {
      const identity = {
        get accountHome() { assert.fail('The owner home must not be resolved') },
        get scratchRoot() { assert.fail('No scratch directory may be prepared') },
      }
      assert.throws(() => providerAuthenticatedLaunchEnvironment(identity, { [name]: value }),
        { code: 'QA_DISPOSABLE_WORKER_REQUIRED' })
    }
  }
})

test('an ambient shared session cannot be hidden with a caller-supplied empty environment or guest claim', () => {
  const previous = process.env.TOOLSENABLED_SHARED_HOST_SESSION
  process.env.TOOLSENABLED_SHARED_HOST_SESSION = '1'
  try {
    for (const environment of [{}, { TOOLSENABLED_SHARED_HOST_SESSION: '0' },
      { TOOLSENABLED_DISPOSABLE_WORKER: '1', isolation: 'disposable-machine' }]) {
      assert.throws(() => assertSharedHostQualificationAllowed(environment), { code: 'QA_DISPOSABLE_WORKER_REQUIRED' })
    }
  } finally {
    if (previous === undefined) delete process.env.TOOLSENABLED_SHARED_HOST_SESSION
    else process.env.TOOLSENABLED_SHARED_HOST_SESSION = previous
  }
})

test('the ordinary mixed launch still composes its explicit account identity and scratch stores when no session opted in', t => {
  const root = scratch(t)
  // A separate native Node process models the ordinary caller even when this
  // source suite itself runs inside a marked CUT build. It never launches a
  // provider, and every path below belongs to this synthetic fixture.
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !restrictive.test(name)))
  const script = `const fs=require('node:fs'),path=require('node:path');
const {providerAuthenticatedLaunchEnvironment}=require(process.argv[1]);
const owner=path.join(process.argv[2],'synthetic-account');
const scratchRoot=path.join(process.argv[2],'synthetic-scratch');
const env=providerAuthenticatedLaunchEnvironment({accountHome:owner,scratchRoot},{PATH:'/usr/bin:/bin'}, {platform:'linux'});
if(env.USERPROFILE!==owner || env.CODEX_HOME!==path.join(owner,'.codex') || env.APPDATA!==path.join(scratchRoot,'appdata'))process.exit(1);
if(fs.existsSync(owner)||!fs.existsSync(env.APPDATA))process.exit(2);`
  const result = spawnSync(process.execPath, ['-e', script, helperFile, root], { env: environment, encoding: 'utf8', timeout: 10000, windowsHide: true })
  assert.equal(result.status, 0, result.stderr)
})

test('ordinary sterile profiles retain the restriction without restoring a provider account', t => {
  const root = scratch(t), profile = sterileProfileDirectories(root)
  const env = sterileLaunchEnvironment(profile, { TOOLSENABLED_SHARED_HOST_SESSION: '1', PATH: process.env.PATH })
  assert.equal(env.TOOLSENABLED_SHARED_HOST_SESSION, '1')
  assert.equal(env.USERPROFILE, profile.userProfile)
  assert.equal(env.CODEX_HOME, profile.codexHome)
  assert.throws(() => providerAuthenticatedLaunchEnvironment({}, env), { code: 'QA_DISPOSABLE_WORKER_REQUIRED' })
})

test('a costly selection refuses as a whole while source/provider-free selection remains available', () => {
  const rows = planFor(['provider-login-drive.mjs', 'cloud-launch-packaged-qa.mjs'])
  const environment = { TOOLSENABLED_SHARED_HOST_SESSION: '1' }
  assert.equal(rows.find(row => row.name === 'cloud-launch-packaged-qa.mjs').costly, true)
  assert.doesNotThrow(() => assertQaSelectionHost(rows.filter(row => !row.costly), environment))
  assert.throws(() => assertQaSelectionHost(rows, environment), { code: 'QA_DISPOSABLE_WORKER_REQUIRED' })
  assert.equal(rows.length, 2, 'The refusal cannot silently drop requested coverage')
})

test('actual real-provider and costly-suite entrypoints refuse before owner discovery, directory creation, or child execution', t => {
  const root = scratch(t), touched = path.join(root, 'forbidden-side-effect.txt')
  const trap = path.join(root, 'side-effect-trap.cjs')
  fs.writeFileSync(trap, `const fs=require('node:fs'),cp=require('node:child_process'),os=require('node:os');
const refuse=()=>{const error=Error('Forbidden side effect');fs.writeFileSync(${JSON.stringify(touched)},error.stack);throw error;};
fs.mkdirSync=refuse;fs.mkdtempSync=refuse;cp.spawn=refuse;cp.spawnSync=refuse;os.homedir=refuse;`)
  for (const [file, args] of [
    ['tools/run-agent-from-ui-smoke.cjs', []],
    ['tools/packaged-qa-suite.mjs', ['--only', 'cloud-launch-packaged-qa', '--include-costly']],
    ['tools/packaged-qa-suite.mjs', ['--only', 'cloud-launch-packaged-qa', '--include-costly', '--release', path.join(root, 'unused-release')]],
  ]) {
    const result = spawnSync(process.execPath, ['--require', trap, path.join(repository, file), ...args], {
      env: { ...process.env, TOOLSENABLED_SHARED_HOST_SESSION: '1', MISSION_CONTROL_ENGINE: path.join(root, 'unused-engine') },
      encoding: 'utf8', timeout: 10000, windowsHide: true,
    })
    assert.notEqual(result.status, 0, file)
    assert.match(result.stderr, /QA_DISPOSABLE_WORKER_REQUIRED|dedicated disposable worker/, file)
    assert.equal(fs.existsSync(touched), false, 'No owner lookup, file creation, or child execution before refusal: ' + file
      + (fs.existsSync(touched) ? '\n' + fs.readFileSync(touched, 'utf8') : ''))
  }
})

test('full release readiness names a disposable-guest executor for every installed-product row', () => {
  // Importing the registry measures its fixed source closure. It must not
  // start a machine, a guest or a product to do that, which is the boundary
  // every other case in this file is about.
  const contract = assertReadinessAdaptersAvailable('toolsenabled')
  for (const id of ['fresh-install', 'durable-critical-journey']) {
    const row = contract.requirements.find(item => item.id === id)
    assert.equal(row.adapter.id, `${id}:v1`)
    assert.equal(row.adapter.proofScope, row.scope,
      `mutation \`register ${id} under a weaker proof scope\` survived: expected the row's own scope`)
  }
})
