import assert from 'node:assert/strict'
import { ownedFixtureTempRoot } from './lib/owned-fixture-temp.mjs'
import { spawnSync } from 'node:child_process'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { captureInstallBaseline, compareInstallBaseline } from '../lib/install-immutability-baseline.mjs'

const checker = fileURLToPath(new URL('../check-install-dir-immutable.mjs', import.meta.url))
const sealer = fileURLToPath(new URL('../seal-artifact.mjs', import.meta.url))

// T385: a sealable artifact states the commit it was built from; MC_SEAL_SOURCE_HEAD
// (set in runNode) injects the matching source head so the seal binds without a real
// cut worktree. The injection never disables the built-vs-source refusal.
const TEST_BUILT_SHA = ''.padEnd(40, 'a')

function fixture(t) {
  const tempRoot = ownedFixtureTempRoot()
  const root = mkdtempSync(path.join(tempRoot, 'install-immutability-baseline-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const artifact = path.join(root, 'win-unpacked')
  mkdirSync(path.join(artifact, 'resources', 'capability'), { recursive: true })
  writeFileSync(path.join(artifact, 'ToolsEnabled.exe'), 'INERT LOCAL BYTE FIXTURE; NOT AN EXECUTABLE\n')
  writeFileSync(path.join(artifact, 'resources', 'capability', 'PAYLOAD.json'), '{"fixture":true}\n')
  mkdirSync(path.join(artifact, 'resources', 'app', 'dist'), { recursive: true })
  writeFileSync(path.join(artifact, 'resources', 'app', 'dist', '.dist-source.json'),
    JSON.stringify({ schemaVersion: 1, appHead: TEST_BUILT_SHA }) + '\n')
  return { root, artifact, seal: path.join(root, '.artifact-seal-win-unpacked.json') }
}

function runNode(args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^NODE_(?:OPTIONS|PATH)$/i.test(name)))
  env.MC_SEAL_SOURCE_HEAD = TEST_BUILT_SHA
  env.MC_SEAL_SOURCE_CLEAN = '1'
  const result = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true })
  assert.ifError(result.error)
  assert.equal(result.signal, null)
  return { code: result.status, output: `${result.stdout || ''}${result.stderr || ''}` }
}

function record(artifact) {
  const result = runNode([sealer, '--record', artifact])
  assert.equal(result.code, 0, result.output)
}

// SYNTHETIC PRE-RUNTIME BOUNDARY ONLY. The real checker and real seal verifier
// run. Only the checker's two CJS runtime/profile dependencies are replaced;
// every operation they expose throws. No scratch/profile, application process,
// guest, native installer or successful runtime result is substituted.
const runtimeBoundary = 'SYNTHETIC_INSTALL_RUNTIME_BOUNDARY: no runtime/profile operation was performed'
const moduleReplacement = `
  export function createRequire() {
    return file => {
      const stop = () => { throw new Error(${JSON.stringify(runtimeBoundary)}) };
      if (file.endsWith('sterile-launch.cjs')) return {
        canonicalizeCreatedQaProfile: stop, createOutsideWriteFence: stop,
        prepareSterileProfile: stop, sterileLaunchEnvironment: stop, sterileProfileDirectories: stop,
      };
      if (file.endsWith('install-profile-guard.cjs')) return { trustedProfileShortAliasRoot: stop };
      throw new Error('unexpected synthetic runtime dependency');
    };
  }
`
const loader = `
  export function resolve(specifier, context, nextResolve) {
    if (context.parentURL === ${JSON.stringify(new URL('../check-install-dir-immutable.mjs', import.meta.url).href)} && specifier === 'node:module') {
      return { url: 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(moduleReplacement)}), shortCircuit: true };
    }
    return nextResolve(specifier, context);
  }
`
const preload = `data:text/javascript,${encodeURIComponent(`import { register } from 'node:module'; register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(loader)}`)}, import.meta.url);`)}`
const runChecker = artifact => runNode(['--import', preload, checker, artifact])

test('standalone checker refuses pre-existing litter twice against the same recorded seal', t => {
  const { artifact, seal } = fixture(t)
  record(artifact)
  const sealed = readFileSync(seal)
  writeFileSync(path.join(artifact, 'debug.log'), 'contamination before this check started\n')
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = runChecker(artifact)
    assert.equal(result.code, 1, result.output)
    assert.match(result.output, /seal verification failed.*before the session|sealed baseline.*differs/is)
    assert.match(result.output, /debug\.log/)
    assert.ok(!result.output.includes(runtimeBoundary), 'contaminated input must refuse before the runtime/profile boundary')
    assert.deepEqual(readFileSync(seal), sealed, 'the checker must never adopt contaminated bytes by resealing')
  }
})

test('standalone checker admits a pristine sealed fixture only to the throwing runtime boundary', t => {
  const { artifact, seal } = fixture(t)
  record(artifact)
  const sealed = readFileSync(seal)
  const result = runChecker(artifact)
  assert.equal(result.code, 1, result.output)
  assert.ok(result.output.includes(runtimeBoundary), result.output)
  assert.deepEqual(readFileSync(seal), sealed)
})

for (const [label, damage] of [
  ['missing preseal baseline', ({ seal }) => rmSync(seal)],
  ['malformed seal', ({ seal }) => writeFileSync(seal, 'not JSON\n')],
  ['seal for another artifact', ({ seal }) => {
    const value = JSON.parse(readFileSync(seal, 'utf8'))
    value.artifact = 'other-unpacked'
    writeFileSync(seal, JSON.stringify(value))
  }],
  ['empty seal', ({ seal }) => {
    const value = JSON.parse(readFileSync(seal, 'utf8'))
    value.files = {}
    writeFileSync(seal, JSON.stringify(value))
  }],
]) {
  test(`standalone checker refuses ${label} before runtime/profile work`, t => {
    const input = fixture(t)
    record(input.artifact)
    damage(input)
    const result = runChecker(input.artifact)
    assert.equal(result.code, 1, result.output)
    assert.match(result.output, /seal|baseline/i)
    assert.ok(!result.output.includes(runtimeBoundary), result.output)
  })
}

test('pristine sealed bytes remain unchanged against the captured baseline', async t => {
  const { artifact } = fixture(t)
  record(artifact)
  const baseline = await captureInstallBaseline(artifact)
  const result = await compareInstallBaseline(baseline)
  assert.deepEqual({ added: result.added, removed: result.removed, changed: result.changed }, { added: [], removed: [], changed: [] })
  assert.equal(baseline.entries.get('resources/capability/'), 'DIRECTORY')
})

for (const [label, mutate, expected] of [
  ['added file', artifact => writeFileSync(path.join(artifact, 'new-output.txt'), 'runtime output\n'), { added: ['new-output.txt'], removed: [], changed: [] }],
  ['modified sealed file', artifact => writeFileSync(path.join(artifact, 'ToolsEnabled.exe'), 'changed fixture bytes\n'), { added: [], removed: [], changed: ['ToolsEnabled.exe'] }],
  ['removed sealed file', artifact => rmSync(path.join(artifact, 'ToolsEnabled.exe')), { added: [], removed: ['ToolsEnabled.exe'], changed: [] }],
  ['new empty directory', artifact => mkdirSync(path.join(artifact, 'captures')), { added: ['captures/'], removed: [], changed: [] }],
]) {
  test(`captured baseline detects a ${label} after the session boundary`, async t => {
    const { artifact } = fixture(t)
    record(artifact)
    const baseline = await captureInstallBaseline(artifact)
    mutate(artifact)
    const result = await compareInstallBaseline(baseline)
    assert.deepEqual({ added: result.added, removed: result.removed, changed: result.changed }, expected)
  })
}

test('directory census still detects removal of an initially empty directory', async t => {
  const { artifact } = fixture(t)
  mkdirSync(path.join(artifact, 'empty-packaged-directory'))
  record(artifact)
  const baseline = await captureInstallBaseline(artifact)
  rmSync(path.join(artifact, 'empty-packaged-directory'), { recursive: true })
  assert.deepEqual((await compareInstallBaseline(baseline)).removed, ['empty-packaged-directory/'])
})

test('version-1 seals leave pre-existing empty directory provenance outside their file coverage', async t => {
  const { artifact } = fixture(t)
  record(artifact)
  mkdirSync(path.join(artifact, 'empty-before-check'))
  const baseline = await captureInstallBaseline(artifact)
  assert.equal(baseline.entries.get('empty-before-check/'), 'DIRECTORY')
  assert.deepEqual((await compareInstallBaseline(baseline)).added, [])
})

test('a replacement seal cannot approve runtime mutation by being re-recorded', async t => {
  const { artifact } = fixture(t)
  record(artifact)
  const baseline = await captureInstallBaseline(artifact)
  writeFileSync(path.join(artifact, 'ToolsEnabled.exe'), 'changed and re-recorded fixture\n')
  record(artifact)
  await assert.rejects(compareInstallBaseline(baseline), /Artifact seal changed/)
})

test('changing only seal metadata still invalidates the captured baseline', async t => {
  const { artifact, seal } = fixture(t)
  record(artifact)
  const baseline = await captureInstallBaseline(artifact)
  const parsed = JSON.parse(readFileSync(seal, 'utf8'))
  parsed.recordedAt = 'changed fixture metadata'
  writeFileSync(seal, JSON.stringify(parsed))
  await assert.rejects(compareInstallBaseline(baseline), /Artifact seal changed/)
})

test('removing the seal after baseline capture cannot produce an unchanged result', async t => {
  const { artifact, seal } = fixture(t)
  record(artifact)
  const baseline = await captureInstallBaseline(artifact)
  rmSync(seal)
  await assert.rejects(compareInstallBaseline(baseline), /Existing artifact seal is unavailable or untrusted/)
})

test('an unsealed preseal artifact refuses without creating a seal', async t => {
  const { artifact, seal } = fixture(t)
  await assert.rejects(captureInstallBaseline(artifact), /before runtime checks; this check never creates a seal/)
  assert.equal(existsSync(seal), false)
})

test('a hard-linked seal is not accepted as a trusted baseline file', async t => {
  const { root, artifact, seal } = fixture(t)
  record(artifact)
  linkSync(seal, path.join(root, 'seal-alias.json'))
  await assert.rejects(captureInstallBaseline(artifact), /unavailable or untrusted.*ordinary permitted-link file/)
})
