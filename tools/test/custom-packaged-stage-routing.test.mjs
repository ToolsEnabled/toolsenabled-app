import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { parseAst } from 'rollup/parseAst'
import {
  exactTreeManifest, releaseDirectory, stage as stageRelease,
  stageModeForArguments, STAGE_EXACT_RELEASE,
} from '../test-account-harness.mjs'
import { artifactProofCounts, planFor, releaseArgumentsFor, usesSharedReleaseStage } from '../packaged-qa-suite.mjs'
import { SOURCE_MANIFESTS } from '../lib/adapters/source-suite-manifests.mjs'

const toolsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const drivers = [
  'checkout-privacy-packaged-qa.mjs', 'owner-account-packaged-qa.mjs',
  'loop-packaged-qa.mjs', 'team-panel-packaged-qa.mjs',
  'google-signin-packaged-qa.mjs', 'research-walkthrough-qa.mjs',
  'google-signin-live-qa.mjs',
]

test('the custom-stage regression is mandatory in the release source census', () => {
  const entries = SOURCE_MANIFESTS.app.inventory.filter(row => row.file === 'tools/test/custom-packaged-stage-routing.test.mjs')
  assert.equal(entries.length, 1)
  assert.equal(entries[0].reason, null, 'required regression cannot be excluded as a helper')
})

// Execute each driver's actual stage function, not its main() browser/payment
// scenarios. Tiny byte fixtures prove routing and no overlay only; no installer
// or native application is executed or qualified by this source regression.
function readStage(name, context) {
  const source = readFileSync(path.join(toolsRoot, name), 'utf8')
  const tree = parseAst(source)
  const declaration = tree.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'stage')
  assert.ok(declaration, `${name}: named stage function is missing`)
  const imported = tree.body.filter(node => node.type === 'ImportDeclaration'
    && node.source.value === './test-account-harness.mjs').flatMap(node => node.specifiers)
  for (const [local, original] of [
    ['stageRelease', 'stage'], ['stageModeForArguments', 'stageModeForArguments'],
    ['STAGE_EXACT_RELEASE', 'STAGE_EXACT_RELEASE'],
  ]) {
    assert.ok(imported.some(node => node.local.name === local && node.imported?.name === original),
      `${name}: ${local} must use the real shared harness export`)
  }
  return vm.runInNewContext(`(${source.slice(declaration.start, declaration.end)})`, { path, ...context })
}

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'te-custom-stage-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const release = path.join(root, 'selected candidate')
  mkdirSync(path.join(release, 'resources', 'capability', 'tools', 'lib'), { recursive: true })
  const executableName = process.platform === 'linux' ? 'toolsenabled' : 'ToolsEnabled.exe'
  writeFileSync(path.join(release, executableName), Buffer.from([127, 69, 76, 70, 1, 2, 3, 4]), { mode: 0o755 })
  writeFileSync(path.join(release, 'resources', 'app.asar'), 'candidate archive; no source overlay')
  writeFileSync(path.join(release, 'resources', 'capability', 'tools', 'secrets.ps1'), 'candidate vault, not checkout vault')
  writeFileSync(path.join(release, 'resources', 'capability', 'tools', 'lib', 'vault-acl.ps1'), 'candidate dependency')
  return { root, release, executableName }
}

for (const name of drivers) {
  for (const form of ['split', 'inline', 'suite-marker']) {
    test(`${name}: ${form} selects unchanged candidate bytes before any checkout overlay`, async t => {
      const { root, release, executableName } = fixture(t)
      const scratch = path.join(root, 'scratch')
      mkdirSync(scratch)
      const argv = ['node', name, ...(form === 'inline' ? [`--release=${release}`] : ['--release', release])]
      const environment = form === 'suite-marker' ? { TOOLSENABLED_QA_STAGE_MODE: STAGE_EXACT_RELEASE } : {}
      const before = exactTreeManifest(release)
      let delegated = 0
      const stage = readStage(name, {
        STAGE_EXACT_RELEASE,
        stageModeForArguments: () => stageModeForArguments(form === 'suite-marker' ? ['node', name] : argv, environment),
        stageRelease: async (...args) => {
          assert.deepEqual(args, [scratch], 'delegate must not override shared candidate selection or mode')
          delegated++
          return stageRelease(scratch, releaseDirectory(argv), {
            mode: stageModeForArguments(argv, environment),
            overlay: () => { throw new Error('candidate staging attempted a checkout overlay') },
          })
        },
        assertRendererMeasurable: () => { throw new Error('candidate staging inspected checkout renderer') },
      })
      const result = await stage(scratch)
      assert.equal(delegated, 1)
      const app = path.join(scratch, 'app')
      const executable = path.join(app, executableName)
      if (name === 'checkout-privacy-packaged-qa.mjs') {
        assert.equal(result.executable, executable)
        assert.equal(result.archive, path.join(app, 'resources', 'app.asar'))
      } else if (['owner-account-packaged-qa.mjs', 'google-signin-packaged-qa.mjs', 'google-signin-live-qa.mjs'].includes(name)) {
        assert.equal(result.executable, executable)
        assert.equal(result.app, app)
        if (name.startsWith('google-signin-')) {
          assert.equal(result.stageMode, STAGE_EXACT_RELEASE)
          assert.equal(result.sourceRelease, release)
          if (name === 'google-signin-live-qa.mjs') assert.equal(result.shim, 'not-applied-exact-release')
        }
      } else assert.equal(result, executable)
      assert.deepEqual(exactTreeManifest(app), before)
      assert.deepEqual(exactTreeManifest(release), before, 'original candidate must remain untouched')
    })
  }

  test(`${name}: development mode retains the existing renderer-currentness gate`, async () => {
    const sentinel = new Error('legacy renderer gate reached')
    const stage = readStage(name, {
      STAGE_EXACT_RELEASE, REPO_ROOT: toolsRoot,
      stageModeForArguments: () => stageModeForArguments(['node', name], {}),
      stageRelease: () => assert.fail('implicit development mode must not claim exact-candidate staging'),
      assertRendererMeasurable: () => { throw sentinel },
    })
    await assert.rejects(stage('unused'), error => error === sentinel)
  })

  test(`${name}: malformed candidate arguments fail before any staging`, async () => {
    for (const suffix of [['--release'], ['--release='], ['--release', '--visible'], ['--release=a', '--release=b']]) {
      const stage = readStage(name, {
        STAGE_EXACT_RELEASE,
        stageModeForArguments: () => stageModeForArguments(['node', name, ...suffix], {}),
        stageRelease: () => assert.fail('invalid candidate must not be staged'),
        assertRendererMeasurable: () => assert.fail('invalid candidate must not fall back to checkout'),
      })
      await assert.rejects(stage('unused'), /--release/)
    }
  })

  test(`${name}: missing candidate never falls back to checkout or a default artifact`, async t => {
    const { root } = fixture(t)
    const release = path.join(root, 'absent')
    const scratch = path.join(root, 'scratch')
    mkdirSync(scratch)
    const argv = ['node', name, '--release', release]
    const stage = readStage(name, {
      STAGE_EXACT_RELEASE,
      stageModeForArguments: () => stageModeForArguments(argv, {}),
      stageRelease: () => stageRelease(scratch, releaseDirectory(argv), { mode: STAGE_EXACT_RELEASE }),
      assertRendererMeasurable: () => assert.fail('missing candidate must not select checkout'),
    })
    await assert.rejects(stage(scratch), { code: 'ENOENT' })
  })
}

test('custom stage delegation is recognized without counting synthetic functional QA as exact-artifact proof', () => {
  const entries = planFor(drivers)
  for (const entry of entries) {
    const source = readFileSync(entry.file, 'utf8')
    assert.equal(usesSharedReleaseStage(source), true, entry.name)
    assert.deepEqual(releaseArgumentsFor(source, '/selected/candidate'), ['--release', '/selected/candidate'])
    assert.equal(entry.artifactProof, ['google-signin-packaged-qa.mjs', 'research-walkthrough-qa.mjs', 'google-signin-live-qa.mjs'].includes(entry.name)
      ? 'unclassified' : 'instrumented-copy', entry.name)
  }
  assert.deepEqual(artifactProofCounts(entries.map(entry => ({ ...entry, verdict: 'PASS' }))),
    { exact: 0, instrumented: 4, unclassified: 3 })
})

test('credential-waiting and cut-check consume the shared candidate without an ambiguous stage binding', () => {
  for (const name of ['credential-waiting-visible-qa.mjs', 'cut-check-drive.mjs']) {
    const source = readFileSync(path.join(toolsRoot, name), 'utf8')
    assert.equal(usesSharedReleaseStage(source), true, name)
    assert.deepEqual(releaseArgumentsFor(source, '/selected/candidate'), ['--release', '/selected/candidate'])
    // Run only the actual candidate-selection expression, never credential
    // queue setup, account copying, an agent launch or a browser flow.
    const tree = parseAst(source)
    const binding = tree.body.filter(node => node.type === 'ImportDeclaration'
      && node.source.value === './test-account-harness.mjs')
      .flatMap(node => node.specifiers).find(node => node.imported?.name === 'stage')?.local.name
    assert.ok(binding, name)
    let found = 0
    const visit = node => {
      if (!node || typeof node !== 'object') return
      if (node.type === 'CallExpression' && node.callee?.name === binding) {
        const scratch = Object.freeze({ marker: name })
        const selected = Object.freeze({ marker: 'actual shared stage result' })
        const result = vm.runInNewContext(source.slice(node.start, node.end), {
          scratch, [binding]: value => { assert.equal(value, scratch); return selected },
        })
        assert.equal(result, selected)
        found++
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(visit)
        else if (value && typeof value === 'object') visit(value)
      }
    }
    visit(tree)
    assert.equal(found, 1, name)
  }
})

test('cloud candidate staging copies exact bytes and never uses a checkout overlay', async t => {
  const source = readFileSync(path.join(toolsRoot, 'cloud-launch-packaged-qa.mjs'), 'utf8')
  const tree = parseAst(source)
  const fn = tree.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'stage')
  const imported = tree.body.filter(node => node.type === 'ImportDeclaration'
    && node.source.value === './test-account-harness.mjs').flatMap(node => node.specifiers)
  for (const [local, original] of [['stageRelease', 'stage'], ['releaseDirectory', 'releaseDirectory'], ['STAGE_EXACT_RELEASE', 'STAGE_EXACT_RELEASE']]) {
    assert.ok(imported.some(node => node.local.name === local && node.imported?.name === original))
  }
  const { root, release, executableName } = fixture(t)
  const before = exactTreeManifest(release)
  for (const [index, flags] of [['split', ['--release', release]], ['inline', [`--release=${release}`]]]) {
    const scratch = path.join(root, index)
    mkdirSync(scratch)
    const stage = vm.runInNewContext(`(${source.slice(fn.start, fn.end)})`, {
      releaseDirectory: () => releaseDirectory(['node', 'cloud-driver', ...flags]), STAGE_EXACT_RELEASE,
      stageRelease: (destination, selected, options) => {
        assert.equal(destination, scratch)
        assert.equal(selected, release)
        assert.equal(options.mode, STAGE_EXACT_RELEASE)
        return stageRelease(destination, selected, { mode: options.mode,
          overlay() { assert.fail('cloud must never overlay checkout source') } })
      },
    })
    const staged = await stage(scratch)
    assert.equal(staged.executable, path.join(scratch, 'app', executableName))
    assert.deepEqual(exactTreeManifest(staged.appRoot), before)
    assert.deepEqual(exactTreeManifest(release), before)
  }
  for (const flags of [['--release'], ['--release='], ['--release', '--visible'], ['--release=a', '--release=b']]) {
    const stage = vm.runInNewContext(`(${source.slice(fn.start, fn.end)})`, {
      releaseDirectory: () => releaseDirectory(['node', 'cloud-driver', ...flags]), STAGE_EXACT_RELEASE,
      stageRelease() { assert.fail('malformed candidate must not stage') },
    })
    await assert.rejects(stage('unused'), /--release/)
  }
  const missing = path.join(root, 'missing candidate')
  const missingScratch = path.join(root, 'missing-scratch')
  mkdirSync(missingScratch)
  const missingStage = vm.runInNewContext(`(${source.slice(fn.start, fn.end)})`, {
    releaseDirectory: () => releaseDirectory(['node', 'cloud-driver', '--release', missing]), STAGE_EXACT_RELEASE,
    stageRelease,
  })
  await assert.rejects(missingStage(missingScratch), { code: 'ENOENT' })
  assert.deepEqual(exactTreeManifest(release), before, 'missing selection must not modify the other candidate')
  assert.deepEqual(releaseArgumentsFor(source, release), ['--release', release])
  assert.match(source, /seedMachineRecord\(profile, staged\.appRoot, 'standard'\)/)
})

test('cloud driver refuses its unavailable native approval adapter before any provider or browser operation', async () => {
  const source = readFileSync(path.join(toolsRoot, 'cloud-launch-packaged-qa.mjs'), 'utf8')
  const tree = parseAst(source)
  const fn = tree.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'main')
  for (const platform of ['linux', 'darwin']) {
    const process = { platform }, output = []
    const main = vm.runInNewContext(`(${source.slice(fn.start, fn.end)})`, {
      process, console: { error: value => output.push(value) },
      auditSelf() { assert.fail('native-adapter refusal must precede all scenario work') },
    })
    await main()
    assert.equal(process.exitCode, 2)
    assert.match(output.join('\n'), /UNMEASURED:.*Windows native approval adapter/)
  }
})
