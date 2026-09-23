import assert from 'node:assert/strict'
import { ownedFixtureTempRoot } from './lib/owned-fixture-temp.mjs'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { getReadinessContract, readinessDigest, assertReleaseReadiness } from '../lib/release-readiness.mjs'
import { createReadinessPlan } from '../release-packager/lib/readiness-plan.mjs'
import { inspectSourceSuite } from '../lib/adapters/source-suites.mjs'

const CLI = fileURLToPath(new URL('../release-packager/plan-readiness.mjs', import.meta.url))
// Exercise the CLI and its disposable input trees outside the source checkout.
const OUTSIDE_SOURCE = ownedFixtureTempRoot()
const INSTALLED = ['fresh-install', 'durable-critical-journey', 'upgrade', 'uninstall-reinstall',
  'privilege-isolation-recovery', 'advertised-integrations', 'update-delivery']
// Registered, but with no executable scenario: tools/lib/adapters/installed-lifecycle.mjs
// refuses these by name rather than letting a constant selector pass them.
const WITHOUT_SCENARIO = ['advertised-integrations', 'update-delivery']

test('Linux planning retains the complete shared graph and discloses missing native implementations', () => {
  const target = { platform: 'linux', arch: 'x64' }
  const plan = createReadinessPlan('toolsenabled', { target })
  const windows = createReadinessPlan('toolsenabled')
  assert.equal(plan.status, 'blocked')
  assert.deepEqual(plan.target, target)
  assert.deepEqual(plan.installer, { format: 'deb', architecture: 'amd64' })
  assert.equal(plan.runtimeAccount, 'owning-non-elevated')
  assert.equal(plan.subjectMeasurer.status, 'registered')
  assert.equal(Object.hasOwn(plan.subjectMeasurer, 'reason'), false)
  assert.deepEqual(plan.requirements.map(({ id, scope, assertions }) => ({ id, scope, assertions })),
    windows.requirements.map(({ id, scope, assertions }) => ({ id, scope, assertions })))
  assert.deepEqual(plan.missingAdapters, INSTALLED)
  assert.equal(plan.requirements.filter(row => row.implementation.status === 'registered').length, 3)
  assert.equal(Object.hasOwn(plan, 'ready'), false)
})

test('planning CLI selects the explicit native target and cannot accept arbitrary profile policy', () => {
  const result = spawnSync(process.execPath, [CLI, '--target', 'linux-x64'], { encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 1, result.stderr)
  const plan = JSON.parse(result.stdout)
  assert.deepEqual(plan.target, { platform: 'linux', arch: 'x64' })
  assert.equal(plan.requirements.length, 10)
  for (const args of [['--target', 'linux-arm64'], ['--target', 'linux-x64', '--target', 'win32-x64'], ['--profiles', 'build']]) {
    const refusal = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', windowsHide: true })
    assert.equal(refusal.status, 2)
    assert.equal(refusal.stdout, '')
  }
})

test('the current app census selects every source suite and accounts for the context-bound strict invocation', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const selection = inspectSourceSuite('app', { sourceRoots: { app: root } })
  assert.deepEqual(selection.exclusions, [
    { file: 'tools/test/helpers/account-buckets-electron.cjs', reason: 'imported-fixture-helper' },
    { file: 'tools/test/helpers/account-buckets-renderer.mjs', reason: 'imported-fixture-helper' },
    { file: 'tools/test/helpers/chat-readable-stream-electron.cjs', reason: 'imported-fixture-helper' },
    { file: 'tools/test/helpers/chat-readable-stream-renderer.mjs', reason: 'imported-fixture-helper' },
    { file: 'tools/test/helpers/page2-role-studio-renderer.mjs', reason: 'imported-fixture-helper' },
    { file: 'tools/test/helpers/role-studio-empty-electron.cjs', reason: 'imported-fixture-helper' },
    { file: 'tools/test/helpers/role-studio-empty-renderer.mjs', reason: 'imported-fixture-helper' },
    { file: 'tools/test/helpers/tree-card-compact-electron.cjs', reason: 'imported-fixture-helper' },
    { file: 'tools/test/helpers/tree-card-compact-renderer.mjs', reason: 'imported-fixture-helper' },
    { file: 'tools/test/lib/retained-gate-fixture-root.mjs', reason: 'imported-fixture-helper' },
    { file: 'tools/test/owner-administration-fixture.mjs', reason: 'imported-fixture-helper' },
  ])
  assert.deepEqual(selection.files, selection.discovered.filter(file => !selection.exclusions.some(row => row.file === file)))
  assert.ok(selection.files.includes('tools/test/this-computer-settings.test.mjs'))
  assert.ok(selection.files.includes('tools/test/source-retrieval-report.test.mjs'))
  for (const name of ['owner-administration', 'owner-administration-lifecycle',
    'owner-administration-main-wiring', 'owner-administration-process']) {
    assert.ok(selection.files.includes(`tools/test/${name}.test.mjs`))
  }
  assert.equal(selection.files.includes('tools/test/owner-administration-fixture.mjs'), false,
    'the imported cryptographic helper is source input, not an executable suite')
  for (const file of ['tools/test/blank-tree-role.test.mjs', 'tools/test/role-studio-empty-directions.test.mjs',
    'tools/test/machine-search-path-async-startup.test.mjs', 'tools/test/metrics-startup-attribution.test.mjs']) {
    assert.ok(selection.files.includes(file), `${file} must execute`)
  }
  // The merged Settings queue adds executable suites. The actual adapter must
  // select each exactly once; listing one as a helper cannot satisfy inclusion.
  // settings-profile-keeps-your-choices.test.mjs is the pre-85dc71a8 name of
  // settings-profile-applies-whole-preset.test.mjs; the rename landed with the
  // whole-preset change and the census must follow the file that exists.
  for (const file of ['tools/test/chat-actions-typed-command.test.mjs',
    'tools/test/settings-profile-applies-whole-preset.test.mjs',
    'tools/test/settings-quick-sliders.test.mjs', 'tools/test/tree-drag-edge-pan.test.mjs']) {
    assert.equal(selection.files.filter(selected => selected === file).length, 1, `${file} must execute exactly once`)
    assert.equal(selection.exclusions.some(row => row.file === file), false, `${file} is not a helper`)
  }
  assert.equal(selection.obligations.some(row => ['missing-tests', 'unreconciled-tests',
    'changed-required-aliases'].includes(row.id)), false)
  // This is only reconciliation. Execution still requires a measured subject,
  // exact engine, prepared payload/dependencies and a fresh private scratch.
  assert.ok(selection.commands.some(row => row.id === 'app:strict-release'
    && row.context === 'app-strict-engine-scratch'))
  // The explicit component CLI has assertions and requires native context.
  // Its imported renderer is an input; neither becomes fabricated execution.
  assert.deepEqual(selection.obligations, [{ id: 'unmapped-required-command',
    alias: 'test:role-studio-component', command: ['node', 'tools/qa/page2-role-studio-interaction.cjs'] }])
  assert.equal(selection.exclusions.some(row => row.file === 'tools/qa/page2-role-studio-interaction.cjs'), false)
  assert.equal(selection.complete, false)
})

test('the named administrative fixture remains a required measured input without becoming a standalone suite', t => {
  const root = mkdtempSync(path.join(OUTSIDE_SOURCE, 'administrative-fixture-census-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(path.join(root, 'tools/test'), { recursive: true })
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: {} }))
  const helper = 'tools/test/owner-administration-fixture.mjs'
  const inspect = () => inspectSourceSuite('app', { sourceRoots: { app: root } })
  assert.ok(inspect().obligations.some(row => row.id === 'missing-tests' && row.files.includes(helper)))
  writeFileSync(path.join(root, helper), "throw Error('An imported helper must never be executed by planning')\n")
  writeFileSync(path.join(root, 'tools/test/unlisted-helper.mjs'), "throw Error('Not a classified input')\n")
  const result = inspect()
  assert.ok(result.discovered.includes(helper))
  assert.equal(result.files.includes(helper), false)
  assert.equal(result.discovered.includes('tools/test/unlisted-helper.mjs'), false)
  assert.equal(result.obligations.some(row => row.id === 'missing-tests' && row.files.includes(helper)), false)
})

function invoke(args = [], nodeArgs = []) {
  return spawnSync(process.execPath, [...nodeArgs, CLI, ...args], {
    cwd: OUTSIDE_SOURCE,
    env: { PATH: '', ...(process.platform === 'win32' ? { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows' } : {}) },
    encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024,
  })
}

function assertPlanningOnly(plan) {
  assert.equal(plan.schema, 'toolsenabled.release-readiness-plan')
  assert.equal(plan.schemaVersion, 1)
  assert.equal(plan.scope, 'planning-only')
  assert.match(plan.authority, /no execution or evidence verification/)
  assert.match(plan.authority, /cannot qualify a release/)
  for (const key of ['ready', 'releaseReady', 'run', 'subject', 'observations', 'execution', 'unmeasured']) {
    assert.equal(Object.hasOwn(plan, key), false, `${key} would resemble execution evidence`)
  }
  assert.ok(['blocked', 'unverified'].includes(plan.status))
}

function sourceFixture(t) {
  const root = mkdtempSync(path.join(OUTSIDE_SOURCE, 'release-source-plan-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const sourceRoots = { app: path.join(root, 'app'), engine: path.join(root, 'engine') }
  for (const [name, directory] of Object.entries(sourceRoots)) {
    mkdirSync(path.join(directory, name === 'app' ? 'tools/test' : 'tests'), { recursive: true })
    mkdirSync(path.join(directory, 'tools'), { recursive: true })
    writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ scripts: { test: 'node tools/should-not-run.mjs' } }))
    writeFileSync(path.join(directory, 'tools/should-not-run.mjs'),
      "import fs from 'node:fs'; fs.writeFileSync('executed', 'unexpected'); throw new Error('source inspection executed candidate code');\n")
  }
  writeFileSync(path.join(sourceRoots.app, 'tools/test/new-landing.test.mjs'), "throw new Error('do not execute');\n")
  writeFileSync(path.join(sourceRoots.engine, 'tests/new-landing.test.js'), "throw new Error('do not execute');\n")
  return { root, sourceRoots }
}

test('planning preserves every required scope, profile and assertion from the source contract', () => {
  for (const product of ['toolsenabled', 'scribe', 'web-editor', 'presentation-suite']) {
    const contract = getReadinessContract(product), before = readinessDigest(contract)
    const plan = createReadinessPlan(product)
    assertPlanningOnly(plan)
    assert.equal(plan.product, product)
    assert.deepEqual(plan.target, contract.target)
    assert.equal(plan.contractSha256, before)
    assert.deepEqual(plan.requirements.map(({ id, scope, profiles, assertions }) => ({ id, scope, profiles, assertions })),
      contract.requirements.map(({ id, scope, profiles, assertions }) => ({ id, scope, profiles, assertions })))
    assert.deepEqual(plan.missingAdapters, contract.requirements.filter(row => !row.adapter).map(row => row.id))
    for (const row of plan.requirements) {
      const actual = contract.requirements.find(required => required.id === row.id)
      if (actual.adapter) {
        const { executableScenario, refusal, ...core } = row.implementation
        assert.deepEqual(core, { status: 'registered', id: actual.adapter.id,
          sha256: actual.adapter.sha256, proofScope: actual.adapter.proofScope })
        // An installed row also discloses whether its registered executor has
        // any scenario to run; a build row has no such distinction to make.
        assert.equal(executableScenario === undefined, !INSTALLED.includes(row.id), row.id)
        assert.equal(refusal === undefined, executableScenario !== false, row.id)
      } else assert.deepEqual(row.implementation, { status: 'missing', reason: actual.unavailableReason })
    }
    // The returned description is not the authority object; changing a plan
    // cannot edit policy that later cutter/qualification calls will use.
    plan.requirements[0].assertions.length = 0
    plan.target.platform = 'changed-description'
    assert.equal(readinessDigest(getReadinessContract(product)), before)
  }
})

test('ToolsEnabled planning shows every installed adapter registered, and still names the two that cannot run', () => {
  const plan = createReadinessPlan('toolsenabled')
  // Registering an adapter that always refuses must not read as ready to run:
  // two rows have no executable scenario, so the plan stays blocked and says
  // which rows and why, instead of reporting a clean "unverified".
  assert.equal(plan.status, 'blocked')
  assert.deepEqual(plan.missingAdapters, [])
  assert.deepEqual(plan.unexecutableRequirements, WITHOUT_SCENARIO)
  for (const row of plan.requirements.filter(required => INSTALLED.includes(required.id))) {
    assert.equal(row.implementation.status, 'registered')
    assert.equal(row.implementation.id, `${row.id}:v1`)
    assert.deepEqual(row.profiles, ['windows-x64-standard', 'windows-x64-administrator'])
    assert.equal(row.implementation.executableScenario, !WITHOUT_SCENARIO.includes(row.id), row.id)
    if (!WITHOUT_SCENARIO.includes(row.id)) { assert.equal(row.implementation.refusal, undefined, row.id); continue }
    assert.ok(row.implementation.refusal.reason,
      `mutation \`register ${row.id} with no stated reason\` survived: expected the measured reason`)
    assert.ok(row.implementation.refusal.remedy,
      `mutation \`register ${row.id} with no remedy\` survived: expected what a person can do about it`)
  }
  assert.deepEqual(plan.requirements.filter(row => row.implementation.status === 'registered').map(row => row.id),
    ['source:app', 'source:engine', 'artifact-integrity', ...INSTALLED])
})

test('unknown or absent products cannot select a caller-defined qualification scope', () => {
  for (const product of [undefined, null, '', 'unknown', '__proto__', 'constructor', 'ToolsEnabled', { product: 'toolsenabled' }]) {
    assert.throws(() => createReadinessPlan(product), /unknown product/)
  }
})

test('the actual CLI emits only a planning report and exits blocked for missing adapters', () => {
  for (const args of [[], ['--product', 'toolsenabled'], ['--product', 'scribe']]) {
    const result = invoke(args)
    assert.ifError(result.error)
    assert.equal(result.signal, null)
    assert.equal(result.status, 1)
    assert.equal(result.stderr, '')
    assert.ok(result.stdout.endsWith('\n'))
    const plan = JSON.parse(result.stdout)
    assertPlanningOnly(plan)
    assert.deepEqual(plan, createReadinessPlan(args[1] || 'toolsenabled'))
  }
})

test('CLI help documents planning-only output and blocked exit status', () => {
  const result = invoke(['--help'])
  assert.ifError(result.error)
  assert.equal(result.status, 0)
  assert.equal(result.stderr, '')
  assert.match(result.stdout, /planning-only/)
  assert.match(result.stdout, /1  A planning-only report with required adapters missing/)
})

test('CLI refuses unknown, duplicate and incomplete options without a partial report', () => {
  for (const args of [['--product'], ['--product', ''], ['--product', '--help'],
    ['--product', 'toolsenabled', '--product', 'scribe'], ['--product', '__proto__'],
    ['--product', 'unknown'], ['--readiness-evidence', 'receipt.json'], ['--scope', 'build'], ['--help', '--unknown']]) {
    const result = invoke(args)
    assert.ifError(result.error)
    assert.equal(result.status, 2, JSON.stringify(args))
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /^Readiness planning failed: /)
  }
})

test('CLI remains usable without filesystem write or subprocess permission', () => {
  // The existing source measurers lstat every ancestor of their fixed files;
  // read access includes those ancestors. No writes or child processes are
  // granted by this Node permission configuration.
  const result = invoke([], ['--permission', '--allow-fs-read=*'])
  assert.ifError(result.error)
  assert.equal(result.status, 1, result.stderr)
  assert.equal(result.stderr, '')
  assertPlanningOnly(JSON.parse(result.stdout))
})

test('a contract import failure returns an error without a partial planning report', () => {
  const result = invoke([], ['--permission', `--allow-fs-read=${CLI}`])
  assert.ifError(result.error)
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /^Readiness planning failed: /)
})

test('importing the planning entry point does not run the command', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `await import(${JSON.stringify(new URL('../release-packager/plan-readiness.mjs', import.meta.url).href)})`], {
    cwd: OUTSIDE_SOURCE, encoding: 'utf8', windowsHide: true, timeout: 15000,
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
})

test('a planning report cannot satisfy the production release consumer', async () => {
  const plan = createReadinessPlan('toolsenabled')
  await assert.rejects(() => assertReleaseReadiness(plan, { product: 'toolsenabled' }), error => {
    assert.equal(error.code, 'RELEASE_READINESS_BLOCKED')
    // Every row now names an executor, so the first refusal moved on: a plan
    // still carries no measured installer and can never become a receipt.
    assert.match(error.message, /measure the exact nonempty installer/)
    return true
  })
})

test('source planning exposes new tests, removed inventory and unmapped commands without executing them', t => {
  const { sourceRoots } = sourceFixture(t)
  const plan = createReadinessPlan('toolsenabled', { sourceRoots })
  assertPlanningOnly(plan)
  assert.equal(plan.sourceInspection.scope, 'source-selection-only')
  assert.match(plan.sourceInspection.authority, /No tests ran/)
  assert.match(plan.sourceInspection.authority, /commits, cleanliness and runtime behavior were not verified/)
  assert.deepEqual(plan.sourceInspection.suites.map(row => row.id), ['source:app', 'source:engine'])
  for (const suite of plan.sourceInspection.suites) {
    assert.equal(suite.status, 'blocked')
    assert.match(suite.manifestSha256, /^[a-f0-9]{64}$/)
    assert.ok(suite.obligations.some(row => row.id === 'missing-tests' && row.files.length > 0))
    assert.ok(suite.obligations.some(row => row.id === 'unmapped-required-command'
      && row.command.join(' ') === 'node tools/should-not-run.mjs'))
  }
  assert.deepEqual(plan.sourceInspection.suites[0].obligations.find(row => row.id === 'unreconciled-tests').files,
    ['tools/test/new-landing.test.mjs'])
  assert.deepEqual(plan.sourceInspection.suites[1].obligations.find(row => row.id === 'unreconciled-tests').files,
    ['tests/new-landing.test.js'])
  assert.deepEqual(plan.missingAdapters, [])
  assert.deepEqual(plan.unexecutableRequirements, WITHOUT_SCENARIO)
  for (const directory of Object.values(sourceRoots)) assert.equal(existsSync(path.join(directory, 'executed')), false)
})

test('the source-inspection CLI works with reads only and preserves blocked exit status', t => {
  const { sourceRoots } = sourceFixture(t)
  const result = invoke(['--source-app', sourceRoots.app, '--source-engine', sourceRoots.engine],
    ['--permission', '--allow-fs-read=*'])
  assert.ifError(result.error)
  assert.equal(result.status, 1, result.stderr)
  assert.equal(result.stderr, '')
  const plan = JSON.parse(result.stdout)
  assertPlanningOnly(plan)
  assert.equal(plan.sourceInspection.status, 'blocked')
  assert.equal(plan.sourceInspection.suites.length, 2)
})

test('source planning refuses partial roots, caller policy and ambiguous CLI paths', t => {
  const { sourceRoots } = sourceFixture(t)
  for (const options of [null, [], { policy: {} }, { sourceRoots: null }, { sourceRoots: { app: sourceRoots.app } },
    { sourceRoots: { ...sourceRoots, website: sourceRoots.app } }]) {
    assert.throws(() => createReadinessPlan('toolsenabled', options), /sourceRoots|source roots/)
  }
  assert.throws(() => createReadinessPlan('scribe', { sourceRoots }), /exactly these source roots: website/)
  for (const args of [['--source-app'], ['--source-app', 'relative'], ['--source-app', '--source-engine'],
    ['--source-app', sourceRoots.app], ['--source-app', sourceRoots.app, '--source-app', sourceRoots.app],
    ['--source-website', sourceRoots.app],
    ['--product', 'scribe', '--source-app', sourceRoots.app, '--source-engine', sourceRoots.engine]]) {
    const result = invoke(args)
    assert.ifError(result.error)
    assert.equal(result.status, 2, JSON.stringify(args))
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /^Readiness planning failed: /)
  }
})

test('source planning refuses a linked source root instead of inspecting its target', t => {
  const { root, sourceRoots } = sourceFixture(t)
  const linked = path.join(root, 'linked-app')
  symlinkSync(sourceRoots.app, linked, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => createReadinessPlan('toolsenabled', { sourceRoots: { ...sourceRoots, app: linked } }), /link|reparse/i)
})
