import assert from 'node:assert/strict'
import { ownedFixtureTempRoot } from './lib/owned-fixture-temp.mjs'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { canonicalRootForTests } from '../canonical-root.mjs'
import { fileURLToPath } from 'node:url'
import { assertCutQualification, writeDeclarationArtifacts } from '../release-packager/cut-release-candidate.mjs'
import { prepareDeclarationArtifacts, tagDeclaredCandidate } from '../release-packager/lib/declaration-preflight.mjs'
import { renderDeclaration, writeDeclaration } from '../release-packager/generate-declaration.mjs'
import { assertReadinessAdaptersAvailable, assertReceiptNamesRegisteredAdapters, getReadinessContract, readinessDigest, assertReleaseReadiness,
  LINUX_READINESS_TARGET, WINDOWS_READINESS_TARGET, checkArtifactIntegrity, qualifyReleaseArtifact, readReleaseReadiness } from '../lib/release-readiness.mjs'
import { assertPrivateReadinessPath, assertReadinessHandoffPaths, preserveReadinessReceipt } from '../release-packager/lib/readiness-handoff.mjs'

import { reconcileSourceCommands, sourceCaseExecutionRequirement } from '../lib/adapters/source-command-plan.mjs'
import { SOURCE_COMMAND_ACTIONS, SOURCE_MANIFESTS, SOURCE_RUNNER_REQUIREMENTS } from '../lib/adapters/source-suite-manifests.mjs'
import { parseSourceOutput, planSourceSuiteJobs, measureStrictSourceInputs, verifyStrictReleaseFiles, assertSourceCleanupConfirmed,
  inspectSourceSuite, inspectSourceTap, inspectSourceExecutionCoverage, inspectSourceCoverageRecords, describeSourceExecutionScope, assertSourceExecutionScope } from '../lib/adapters/source-suites.mjs'
import { measureTree, digestRecord } from '../lib/adapters/artifact-files.mjs'
import { fileIdentity, registeredToolEnvironment, runOwnedJob } from '../lib/transport/owned-job.mjs'

const CUTTER = fileURLToPath(new URL('../release-packager/cut-release-candidate.mjs', import.meta.url))
const GENERATOR = fileURLToPath(new URL('../release-packager/generate-declaration.mjs', import.meta.url))
const TEMP = ownedFixtureTempRoot()
const BLOCKED = /readiness|qualification adapters|receipt/i
const QUALIFICATION_ENV = { ...process.env, TEMP, TMP: TEMP,
  TOOLSENABLED_CUT_MODEL: 'Qualification Fixture', TOOLSENABLED_CUT_EMAIL: 'fixture@example.invalid',
  TOOLSENABLED_CUT_SESSION: 'qualification-fixture' }

async function fixture(action) {
  const root = await mkdtemp(path.join(TEMP, 'release-qualification-'))
  try { return await action(root) }
  finally {
    assert.equal(path.dirname(root), path.resolve(TEMP))
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}

function factsFor(root, readiness) {
  return {
    test: false, readiness, date: '2026-09-05', version: '9.9.9', previousVersion: '9.9.8', branch: 'fixture',
    sourceRef: 'c'.repeat(40), buildRef: 'a'.repeat(40), engineSourceRef: 'b'.repeat(40), branchAdvanced: false,
    candidate: { filename: 'ToolsEnabled Setup 9.9.9.exe', bytes: 42, sha256: 'd'.repeat(64) },
    publisher: 'ToolsEnabled, Inc.', treeState: { worktreeRemoved: false, buildInfoConfirmedClean: true },
    versionInfo: { companyName: 'ToolsEnabled, Inc.', productName: 'ToolsEnabled', fileVersion: '9.9.9', productVersion: '9.9.9', legalCopyright: 'Copyright 2026 ToolsEnabled' },
    appId: { configured: 'com.toolsenabled.desktop' }, unsigned: { signExecutable: false },
    pipeline: { distExitCode: 0, packagedQaExitCode: 0 },
    excludedWip: { measuredAt: '2026-09-05T00:00:00Z', dirtyFiles: [] }, otherCandidates: [],
    stagingDir: root, privateInputsCopied: [],
  }
}

function callerGreenReceipt() {
  const contract = getReadinessContract('toolsenabled')
  return { schema: 'toolsenabled.product-release-readiness', schemaVersion: 1,
    product: 'toolsenabled', contractSha256: readinessDigest(contract), ready: true, unmeasured: [],
    subject: { artifact: { sha256: 'd'.repeat(64), bytes: 42 }, sourceRefs: { app: 'a'.repeat(40), engine: 'b'.repeat(40) } },
    observations: contract.requirements.flatMap(row => row.profiles.map(profile => ({
      id: row.id, profile, scope: row.scope, status: 'passed', adapterId: 'caller-claims-it-ran',
      assertions: row.assertions.map(id => ({ id, status: 'passed', evidenceSha256: 'e'.repeat(64) })),
    }))),
    // Caller policy and a green label cannot register a trusted implementation.
    policy: { adaptersAvailable: true }, allTestsPassed: true,
  }
}

test('cut readiness preflight permits fresh evidence production only when trusted adapters exist', () => {
  // Every installed row now names a registered executor, so this preflight no
  // longer refuses the whole cut; it is back to checking the caller's own
  // handoff arguments. The adapter registry itself is asserted by
  // tools/test/installed-lifecycle-adapters.test.mjs, and a receipt naming an
  // unregistered executor is refused below, before any Git or staging work.
  assert.throws(() => assertCutQualification(), /--readiness-output is required/)
  assert.doesNotThrow(() => assertCutQualification('receipt.json'))
  assert.throws(() => assertCutQualification(' '), /must name one receipt when supplied/)
  assert.throws(() => assertCutQualification(undefined, ' '), /private receipt destination/)
  assert.throws(() => assertReadinessAdaptersAvailable('a-product-nobody-registered'), /unknown product/)
})

test('both native cutter targets use the shared preflight and refuse unavailable Linux implementations before artifact I/O', async () => {
  assert.doesNotThrow(() => assertCutQualification('receipt.json', undefined, undefined, WINDOWS_READINESS_TARGET))
  const blocked = error => {
    assert.equal(error.code, 'RELEASE_READINESS_BLOCKED')
    assert.deepEqual(error.details.map(row => row.id), ['fresh-install', 'durable-critical-journey',
      'upgrade', 'uninstall-reinstall', 'privilege-isolation-recovery', 'advertised-integrations', 'update-delivery'])
    return true
  }
  for (const args of [[], ['receipt.json'], [undefined, 'private-output.json', 'context.json']]) {
    assert.throws(() => assertCutQualification(args[0], args[1], args[2], LINUX_READINESS_TARGET), blocked)
  }
  assert.throws(() => assertReceiptNamesRegisteredAdapters('/absent-receipt.json', 'toolsenabled', LINUX_READINESS_TARGET), blocked)
  await assert.rejects(qualifyReleaseArtifact({ product: 'toolsenabled', target: LINUX_READINESS_TARGET,
    artifactPath: '/absent-candidate.deb', sourceRefs: { app: 'a'.repeat(40), engine: 'b'.repeat(40) } }), blocked)
  await assert.rejects(readReleaseReadiness('/absent-receipt.json', { product: 'toolsenabled', target: LINUX_READINESS_TARGET }), blocked)
})

test('artifact-only entry refuses substituted authority and unresolved inputs before any source execution', async () => {
  const target = { platform: process.platform, arch: process.arch }
  for (const key of ['adapters', 'measurers', 'receipt', 'contract', 'verificationTimeoutMs', 'policy']) {
    await assert.rejects(checkArtifactIntegrity({ product: 'toolsenabled', target, [key]: {} }), /input locations and exact refs only/)
  }
  await assert.rejects(checkArtifactIntegrity({ product: 'toolsenabled' }), /explicit native target/)
  const otherTarget = process.platform === 'linux' ? WINDOWS_READINESS_TARGET : LINUX_READINESS_TARGET
  await assert.rejects(checkArtifactIntegrity({ product: 'toolsenabled', target: otherTarget }), /actual native target/)
  await assert.rejects(checkArtifactIntegrity({ product: 'scribe', target: LINUX_READINESS_TARGET }), /No reviewed linux\/x64 deb artifact-integrity/)
  for (const sourceRefs of [undefined, {}, { app: 'HEAD', engine: 'b'.repeat(40) },
    { app: 'a'.repeat(40), engine: 'b'.repeat(40), website: 'c'.repeat(40) }]) {
    await assert.rejects(checkArtifactIntegrity({ product: 'toolsenabled', target, sourceRefs }), /exact candidate source reference/)
  }
})

test('artifact-only CLI requires explicit target and exact refs; help performs no qualification', async () => {
  const cli = fileURLToPath(new URL('../release-packager/check-artifact-integrity.mjs', import.meta.url))
  const { parseArtifactCheckArgs } = await import('../release-packager/check-artifact-integrity.mjs')
  const args = ['--target', 'linux-x64', '--artifact', path.join(TEMP, 'candidate.deb'), '--context', path.join(TEMP, 'context.json'),
    '--app-ref', 'a'.repeat(40), '--engine-ref', 'b'.repeat(40)]
  const parsed = parseArtifactCheckArgs(args)
  assert.deepEqual(parsed.target, LINUX_READINESS_TARGET)
  assert.deepEqual(parsed.sourceRefs, { app: 'a'.repeat(40), engine: 'b'.repeat(40) })
  assert.equal(parsed.product, 'toolsenabled')
  const standalone = parseArtifactCheckArgs(['--target', 'win32-x64', '--product', 'scribe',
    '--artifact', path.join(TEMP, 'candidate.exe'), '--context', path.join(TEMP, 'context.json'), '--website-ref', 'C'.repeat(40)])
  assert.deepEqual(standalone.sourceRefs, { website: 'c'.repeat(40) })
  assert.deepEqual(standalone.target, WINDOWS_READINESS_TARGET)
  const help = spawnSync(process.execPath, [cli, '--help'], { cwd: TEMP, env: { PATH: '' }, encoding: 'utf8', windowsHide: true })
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /ARTIFACT-ONLY/)
  assert.match(help.stdout, /releaseReady:false/)
  assert.doesNotMatch(help.stdout, /"status":\s*"passed"/)
  for (const invalid of [[], args.slice(2), [...args, '--target', 'win32-x64'], [...args, '--readiness', 'green.json'],
    [...args, '--product', 'scribe'], [...args, '--website-ref', 'c'.repeat(40)], [...args, '--timeout', '1']]) {
    const child = spawnSync(process.execPath, [cli, ...invalid], { cwd: TEMP, encoding: 'utf8', windowsHide: true })
    assert.equal(child.status, 2, child.stderr)
    assert.equal(child.stdout, '', 'invalid arguments must never emit an artifact verdict')
  }
  // Valid arguments enter the actual command, which refuses the absent private
  // context instead of interpreting metadata/refs as a successful verification.
  const absent = spawnSync(process.execPath, [cli, ...args], { cwd: TEMP, encoding: 'utf8', windowsHide: true })
  assert.equal(absent.status, 1, absent.stderr)
  assert.equal(absent.stdout, '')
  assert.match(absent.stderr, /Artifact integrity check failed:/)
})

// Protocol orchestration, not native acceptance: execute the actual entire
// maintained module against private real files, replacing only imported native
// implementations with fixed fixture observations. No fixture result is a
// production receipt; the real decoder/custody suites exercise those imports.
async function artifactOnlyProtocol(root, options = {}) {
  const events = [], file = path.join(root, 'candidate.deb')
  await writeFile(file, 'inert protocol fixture; never an installer')
  const context = { sourceRoots: {}, stageRoot: path.join(root, 'stage'), harnessRoot: path.join(root, 'harness'), evidenceRoot: path.join(root, 'evidence') }
  for (const name of ['app', 'engine']) context.sourceRoots[name] = path.join(root, name)
  for (const directory of [...Object.values(context.sourceRoots), context.stageRoot, context.harnessRoot, context.evidenceRoot]) await mkdir(directory)
  const modulePath = fileURLToPath(new URL('../lib/release-readiness.mjs', import.meta.url))
  let source = (await readFile(modulePath, 'utf8')).replace(/^import[\s\S]*?;\n/gm, '').replace(/^export /gm, '')
  if (options.omitReplay) source = source.replace('await verifyObservation(adapter, observation, subject);', '/* mutation: omit artifact replay */')
  const hash = '1'.repeat(64), target = { platform: process.platform, arch: process.arch }
  const scope = { fs, path, Buffer, userInfo: os.userInfo, createHash, randomUUID, process, setTimeout, clearTimeout, AbortController, structuredClone,
    getSourceSuiteAdapter: id => ({ id: `fixture-source:${id}`, sha256: hash, proofScope: 'complete-source-suite',
      execution: 'real', supportedProfiles: Object.freeze(['build']) }),
    INSTALLED_LIFECYCLE_IDS: ['fresh-install', 'durable-critical-journey', 'upgrade', 'uninstall-reinstall',
      'privilege-isolation-recovery', 'advertised-integrations', 'update-delivery'],
    getInstalledLifecycleAdapter: id => ({ id: `fixture-installed:${id}`, sha256: hash, execution: 'real',
      proofScope: ['durable-critical-journey', 'privilege-isolation-recovery', 'advertised-integrations'].includes(id)
        ? 'exact-installed-desktop' : 'exact-installer-lifecycle',
      supportedProfiles: Object.freeze(['windows-x64-standard', 'windows-x64-administrator']) }),
    artifactImplementationIdentity: () => hash,
    async measureArtifactSubject(input) {
      events.push('measure')
      if (events.filter(event => event === 'measure').length > 1 && options.finalSourceDrift) return { changed: true }
      return { product: input.product, artifact: input.artifact, sourceRefs: input.sourceRefs, target: input.target, context: input.context,
        sourceSha256: '2'.repeat(64), stageSha256: '3'.repeat(64), runtimeSha256: '4'.repeat(64), shellSha256: '5'.repeat(64),
        harness: { clean: true, ref: 'c'.repeat(40), sha256: '6'.repeat(64) } }
    },
    async executeArtifactIntegrity(input) {
      events.push('execute')
      if (options.executeFails) throw new Error('fixture native execution refused')
      const { required, profile, subjectSha256, run } = input
      const observation = { id: required.id, profile, scope: required.scope, adapterId: required.adapter.id, adapterSha256: hash,
        subjectSha256, runId: run.id, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
        execution: { command: ['fixture-not-a-native-acceptance'], complete: true, exitCode: 0, signal: null, cleanupConfirmed: true,
          synthetic: false, sourceOverlay: false, hostRuntime: false },
        environment: { ...target, profile, osBuild: 'fixture-only', isolated: true }, report: { bytes: 20, sha256: '7'.repeat(64) },
        assertions: required.assertions.map(id => ({ id, status: 'passed', evidenceSha256: '8'.repeat(64) })),
        counts: { tests: 3, passed: 3, failed: 0, skipped: 0, cancelled: 0, todo: 0, notRun: 0 } }
      options.changeObservation?.(observation)
      return observation
    },
    async verifyArtifactIntegrityEvidence() {
      events.push('replay-start')
      await new Promise(resolve => setTimeout(resolve, 5))
      if (options.replaceDuringReplay) {
        const next = path.join(root, 'replacement.deb')
        await writeFile(next, options.changedBytes ? 'different fixture bytes' : await readFile(file))
        await fs.promises.rename(next, file)
      }
      events.push('replay-settled')
      if (options.replayThrows) throw Object.assign(new Error('fixture unconfirmed native cleanup'), { cleanupUnconfirmed: true })
      return options.replayFalse ? false : true
    } }
  vm.runInNewContext(`${source}\nglobalThis.check = checkArtifactIntegrity`, scope, { filename: modulePath, timeout: 1000 })
  let result, error
  try { result = await scope.check({ product: 'toolsenabled', target, artifactPath: file,
    sourceRefs: { app: 'a'.repeat(40), engine: 'b'.repeat(40) }, context }) }
  catch (caught) { error = caught }
  return { result, error, events }
}

test('artifact-only shared orchestration awaits replay and cannot earn a full readiness receipt', async () => {
  await fixture(async root => {
    const { result, error, events } = await artifactOnlyProtocol(root)
    assert.equal(error, undefined, error?.stack)
    assert.deepEqual(events, ['measure', 'execute', 'replay-start', 'replay-settled', 'measure'])
    assert.equal(result.schema, 'toolsenabled.artifact-integrity-check')
    assert.equal(result.scope, 'artifact-integrity-only')
    assert.equal(result.run.scope, 'artifact-integrity-only')
    assert.equal(result.releaseReady, false)
    assert.equal(Object.hasOwn(result, 'ready'), false)
    assert.equal(Object.hasOwn(result, 'observations'), false)
    assert.equal(result.remainingRequirements.length, 9)
    assert.equal(result.remainingRequirements.every(row => row.status === 'not-run'), true)
    assert.deepEqual(Array.from(result.remainingRequirements, row => row.id), getReadinessContract('toolsenabled').requirements
      .filter(row => row.id !== 'artifact-integrity').map(row => row.id))
    await assert.rejects(assertReleaseReadiness(result, { product: 'toolsenabled', target: WINDOWS_READINESS_TARGET,
      artifact: result.subject.artifact, sourceRefs: result.subject.sourceRefs }), /receipt identity, policy or final verdict/)
  })
  await fixture(async root => {
    const mutation = await artifactOnlyProtocol(root, { omitReplay: true })
    assert.equal(mutation.error, undefined)
    assert.throws(() => assert.deepEqual(mutation.events, ['measure', 'execute', 'replay-start', 'replay-settled', 'measure']),
      'the positive oracle must detect deleting the awaited fresh replay')
  })
})

test('artifact-only shared orchestration refuses replay, cleanup, custody and final-source failures', async () => {
  for (const [name, options, expected] of [
    ['execution', { executeFails: true }, /native execution refused/],
    ['replay false', { replayFalse: true }, /execution evidence was not verified/],
    ['cleanup', { replayThrows: true }, /unconfirmed native cleanup/],
    ['same-byte replacement', { replaceDuringReplay: true }, /installer changed/],
    ['different bytes', { replaceDuringReplay: true, changedBytes: true }, /installer changed/],
    ['source drift', { finalSourceDrift: true }, /source, payload, runtime or harness changed/],
    ['wrong run', { changeObservation: row => { row.runId = 'different' } }, /wrong proof scope/],
    ['missing assertion', { changeObservation: row => { row.assertions.pop() } }, /required behavioral assertions/],
    ['wrong environment', { changeObservation: row => { row.environment.platform = 'unsupported' } }, /supported environment/],
    ['unfinished cleanup', { changeObservation: row => { row.execution.cleanupConfirmed = false } }, /execution or cleanup/],
  ]) await fixture(async root => {
    const { result, error, events } = await artifactOnlyProtocol(root, options)
    assert.equal(result, undefined, name)
    assert.match(error?.message || '', expected, name)
    if (name === 'cleanup') assert.equal(error.cleanupUnconfirmed, true)
    if (['execution', 'wrong run', 'missing assertion', 'wrong environment', 'unfinished cleanup'].includes(name))
      assert.equal(events.includes('replay-start'), false, 'invalid execution cannot start a replay')
  })
})

test('a supplied receipt naming an unregistered executor is refused before any candidate work', async () => {
  await fixture(async root => {
    const file = path.join(root, 'claimed-green.json')
    await writeFile(file, JSON.stringify(callerGreenReceipt()))
    assert.throws(() => assertReceiptNamesRegisteredAdapters(file, 'toolsenabled'), error => {
      assert.equal(error.code, 'RELEASE_READINESS_BLOCKED')
      assert.match(error.message, /names an executor this build does not register/)
      return true
    }, 'mutation `accept a receipt that names its own executor` survived: expected the registry refusal')
    assert.throws(() => assertReceiptNamesRegisteredAdapters(path.join(root, 'absent.json'), 'toolsenabled'),
      /readiness receipt could not be read \(ENOENT\)/)
    // Every observation of a real contract row must still carry the registered
    // adapter's own digest; a correct id with a wrong build is not evidence.
    const receipt = callerGreenReceipt()
    const contract = getReadinessContract('toolsenabled')
    for (const observation of receipt.observations) {
      const row = contract.requirements.find(item => item.id === observation.id)
      observation.adapterId = row.adapter.id
      observation.adapterSha256 = 'f'.repeat(64)
    }
    const drifted = path.join(root, 'drifted.json')
    await writeFile(drifted, JSON.stringify(receipt))
    assert.throws(() => assertReceiptNamesRegisteredAdapters(drifted, 'toolsenabled'),
      /names an executor this build does not register/,
      'mutation `accept a registered adapter id under a foreign digest` survived: expected the registry refusal')
  })
})

test('production tag and declaration writers cannot turn clean metadata into qualified output', async () => {
  await fixture(async root => {
    for (const readiness of [undefined, callerGreenReceipt()]) {
      const facts = factsFor(root, readiness)
      assert.match(prepareDeclarationArtifacts(root, facts).declarationMarkdown, /not full release qualification/i)
      assert.match(renderDeclaration(facts), /NOT QUALIFIED/)
      let calls = 0
      await assert.rejects(() => tagDeclaredCandidate(root, facts, () => { calls += 1 }), BLOCKED)
      assert.equal(calls, 0, 'the immutable tag callback must remain unreachable')
      await assert.rejects(() => writeDeclarationArtifacts(root, facts), BLOCKED)
      await assert.rejects(() => writeDeclaration(path.join(root, 'DECLARATION.md'), facts), BLOCKED)
      assert.deepEqual(await readdir(root), [], 'no complete or partial public document may be emitted')
      facts.test = true
      await assert.rejects(() => tagDeclaredCandidate(root, facts, () => { calls += 1 }, { test: true }), BLOCKED)
      assert.equal(calls, 0, '--test is not a release-readiness bypass')
    }
  })
})

test('real cutter CLI blocks absent and caller-green readiness before Git or staging side effects', async () => {
  await fixture(async root => {
    const evidence = path.join(root, 'claimed-green.json')
    await writeFile(evidence, JSON.stringify(callerGreenReceipt()))
    const staging = path.join(root, 'must-not-create')
    const source = await readFile(CUTTER, 'utf8')
    const invocations = [
      ['--repo', root, '--staging', staging],
      ['--repo', root, '--staging', staging, '--test', '--advance-branch'],
      ['--repo', root, '--staging', staging, '--readiness-evidence', evidence],
      ['--repo', root, '--staging', staging, '--readiness-output', path.join(root, 'private-output.json')],
    ]
    if (source.includes("else if (arg === '--resume-from')")) {
      await mkdir(path.join(root, 'release'))
      invocations.push(['--resume-from', root, '--repo', root, '--staging', staging, '--skip-verified', evidence])
    }
    for (const args of invocations) {
      const result = spawnSync(process.execPath, [CUTTER, ...args], {
        cwd: root, env: QUALIFICATION_ENV, windowsHide: true, encoding: 'utf8', timeout: 15000, maxBuffer: 256 * 1024,
      })
      assert.equal(result.status, 1, result.error?.message || result.stdout + result.stderr)
      assert.match(result.stderr, BLOCKED)
      assert.doesNotMatch(result.stderr, /not a git repository|cutter identity is missing/)
    }
    await assert.rejects(() => access(staging), { code: 'ENOENT' })
    assert.match(source, /const readiness = readinessPaths\.inputPath\s*\? await readReleaseReadiness\(readinessPaths\.inputPath, \{\s*product: 'toolsenabled', artifact: \{ sha256: stagedMeasured\.sha256, bytes: stagedMeasured\.bytes \},\s*sourceRefs: \{ app: buildRef, engine: engineSourceRef \}/)
    assert.match(source, /: await qualifyReleaseArtifact\(\{\s*product: 'toolsenabled', artifactPath: stagedExePath,\s*sourceRefs: \{ app: buildRef, engine: engineSourceRef \}/)
    assert.ok(source.indexOf('const readiness = readinessPaths.inputPath') < source.indexOf('preserveReadinessReceipt(readiness,'))
    assert.ok(source.indexOf('preserveReadinessReceipt(readiness,') < source.indexOf('tagDeclaredCandidate(stagingDir, facts,'))
    assert.ok(source.indexOf('const readinessPaths = assertReadinessHandoffPaths(') < source.indexOf('await mkdir(stagingDir,'))
  })
})

test('private receipt handoff preserves raw identity while public facts carry only a non-authoritative summary', async () => {
  await fixture(async root => {
    const privateDir = path.join(root, 'private-evidence')
    const publicDir = path.join(root, 'candidate')
    await mkdir(privateDir)
    await mkdir(publicDir)
    // Deliberately synthetic protocol metadata; storage is not qualification.
    const receipt = callerGreenReceipt()
    receipt.subject.localMeasurementPath = path.join(privateDir, 'measured-source')
    receipt.observations[0].execution = { command: [path.join(privateDir, 'private-command-fixture.exe')] }
    const untouched = structuredClone(receipt)
    const raw = Buffer.from(JSON.stringify(receipt, null, 4) + '\n\n')
    const original = path.join(privateDir, 'original.json')
    const copy = path.join(privateDir, 'copy.json')
    await writeFile(original, raw)
    const handoff = preserveReadinessReceipt(receipt, { inputPath: original, outputPath: copy, excludedRoots: [publicDir] })
    assert.deepEqual(await readFile(copy), raw, 'a supplied receipt must retain even its original JSON byte encoding')
    assert.deepEqual(receipt, untouched, 'evidence must not be sanitized or mutated')
    assert.equal(handoff.path, copy)
    const prepared = prepareDeclarationArtifacts(publicDir, factsFor(publicDir, receipt))
    const publicFacts = JSON.parse(prepared.factsJson)
    assert.equal(Object.hasOwn(publicFacts, 'readiness'), false)
    assert.equal(publicFacts.readinessSummary.receiptObjectSha256, readinessDigest(receipt))
    assert.equal(publicFacts.readinessSummary.subjectSha256, readinessDigest(receipt.subject))
    assert.match(publicFacts.readinessSummary.authority, /informational-only/)
    assert.doesNotMatch(prepared.factsJson, /private-command-fixture|localMeasurementPath|"observations"|"command"/)
    assert.deepEqual(JSON.parse((await readFile(copy)).toString('utf8')), untouched)
    assert.deepEqual(await readdir(publicDir), [], 'preparation does not publish files')
    assert.throws(() => preserveReadinessReceipt(receipt, { outputPath: copy, excludedRoots: [publicDir] }), /already exists/)
    assert.deepEqual(await readFile(copy), raw, 'retry must not overwrite the original evidence')
  })
})

test('private receipt destinations refuse public/source/build trees, links, missing parents and changed evidence', async () => {
  await fixture(async root => {
    const privateDir = path.join(root, 'private')
    const publicDir = path.join(root, 'public')
    await mkdir(privateDir)
    await mkdir(publicDir)
    const excludedRoots = [publicDir]
    assert.throws(() => assertReadinessHandoffPaths({ excludedRoots }), /--readiness-output is required/)
    assert.throws(() => assertPrivateReadinessPath(path.join(publicDir, 'raw.json'), { excludedRoots }), /outside candidate staging/)
    assert.throws(() => assertPrivateReadinessPath(path.join(privateDir, 'missing', 'raw.json')), { code: 'ENOENT' })
    const alias = path.join(root, 'linked-private')
    await symlink(privateDir, alias, process.platform === 'win32' ? 'junction' : 'dir')
    try { assert.throws(() => assertPrivateReadinessPath(path.join(alias, 'raw.json')), /non-linked private directory/) }
    finally { await unlink(alias) }
    const original = path.join(privateDir, 'original.json')
    const output = path.join(privateDir, 'must-not-create.json')
    await writeFile(original, JSON.stringify({ changed: true }))
    assert.throws(() => preserveReadinessReceipt(callerGreenReceipt(), { inputPath: original, outputPath: output, excludedRoots }), /changed or lost fields/)
    await assert.rejects(() => access(output), { code: 'ENOENT' })
    if (process.platform === 'win32') {
      assert.throws(() => assertPrivateReadinessPath('C:\\Users\\not-permitted-fixture\\raw.json'), /leaves the permitted profile/)
    }
  })
})

test('standalone declaration CLI requires readiness before reading or measuring candidate inputs', async () => {
  await fixture(async root => {
    for (const extra of [[], ['--readiness-evidence', path.join(root, 'claimed-green.json')]]) {
      const target = path.join(root, 'DECLARATION.md')
      const result = spawnSync(process.execPath, [GENERATOR, '--exe', path.join(root, 'absent.exe'),
        '--facts', path.join(root, 'absent-facts.json'), '--out', target, ...extra], {
        cwd: root, env: { ...process.env, TEMP, TMP: TEMP }, windowsHide: true, encoding: 'utf8', timeout: 15000, maxBuffer: 256 * 1024,
      })
      assert.equal(result.status, 1, result.stdout + result.stderr)
      assert.match(result.stderr, BLOCKED)
      await assert.rejects(() => access(target), { code: 'ENOENT' })
    }
  })
})

test('development build output is explicitly non-qualified and full qualification has a distinct entry', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.scripts.predist, 'node tools/report-build-scope.mjs')
  assert.equal(manifest.scripts['release:qualify'], 'npm run release:cut --')
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../report-build-scope.mjs', import.meta.url))], {
    encoding: 'utf8', windowsHide: true, timeout: 10000,
  })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /NOT full release qualification/)
})


test('strict wrapper command requires its context-aware action and retains every argument', () => {
  const command = ['node', 'tools/test-strict.mjs']
  const action = SOURCE_COMMAND_ACTIONS.app.find(row => row.id === 'app:strict-release')
  const inspect = (source, overrides = {}) => reconcileSourceCommands({ aliases: { 'verify:strict': source },
    selectedFiles: ['tools/test-strict.mjs'], coveredCommands: [command], ...overrides })
  assert.equal(inspect(command.join(' ')).complete, false)
  assert.equal(inspect(command.join(' '), { contextCommands: [action] }).complete, true)
  for (const args of ['--nightly', '--canonical-root elsewhere', '--scratch reused', '--unknown']) {
    assert.equal(inspect(`${command.join(' ')} ${args}`, { contextCommands: [action] }).complete, false)
  }
  assert.equal(inspect(command.join(' '), { contextCommands: [{ ...action, context: 'unchecked' }] }).complete, false)
  assert.deepEqual(action.satisfies, [['node', 'tools/test-ratchet.mjs', '--strict'], ['node', 'tools/test-ratchet.mjs']])
})

async function strictFixture(root) {
  const app = path.join(root, 'app'), engine = path.join(root, 'engine'), stage = path.join(root, 'stage')
  const evidence = path.join(root, 'evidence'), scratch = path.join(evidence, 'strict-scratch')
  for (const directory of [path.join(app, 'tools'), path.join(app, 'private'), path.join(app, 'capability'),
    path.join(app, 'node_modules/alpha'), path.join(app, 'node_modules/beta'), engine,
    path.join(stage, 'resources/capability'), path.join(scratch, 'temp/toolsenabled-test-output-fixture')]) await mkdir(directory, { recursive: true, mode: 0o700 })
  const refs = { app: 'a'.repeat(40), engine: 'b'.repeat(40) }
  await writeFile(path.join(app, 'private/capability-source.owner.json'), JSON.stringify({ path: engine, ref: refs.engine }))
  await writeFile(path.join(app, 'private/owner-data-patterns.owner.json'), '{}')
  await writeFile(path.join(app, 'capability/payload.js'), 'payload')
  await writeFile(path.join(stage, 'resources/capability/payload.js'), 'payload')
  await writeFile(path.join(app, 'node_modules/alpha/package.json'), '{}')
  await writeFile(path.join(app, 'node_modules/beta/package.json'), '{}')
  const context = { sourceRoots: { app, engine }, stageRoot: stage, evidenceRoot: evidence, harnessRoot: app }
  const subject = { sourceRefs: refs, context, stageSha256: measureTree(stage).sha256 }
  const selection = { id: 'app', root: app, canonicalRoot: engine, files: [], crossFiles: [],
    commands: [SOURCE_COMMAND_ACTIONS.app.find(row => row.id === 'app:strict-release')] }
  const strictInputs = measureStrictSourceInputs(selection, context, subject)
  const job = planSourceSuiteJobs(selection, evidence, { strictInputs })[0]
  const rawDirectory = path.join(scratch, 'temp/toolsenabled-test-output-fixture')
  const deps = `${path.join(app, 'node_modules')} (real directory, repository root, 2 entries)`
  const header = [
    '=== app strict release measurement ===', 'command             node tools/test-strict.mjs --canonical-root <engine checkout>',
    `repository          ${app}`, `app HEAD            ${refs.app}`, `canonical root      ${engine}`, `engine HEAD         ${refs.engine}`,
    `node                v22.19.0 at ${job.command}`, 'NODE_OPTIONS        (unset)', `dependencies        ${deps}`,
    `capability/         ${path.join(app, 'capability')} (1 entries)`, `state roots         ${path.join(scratch, 'state')}`,
    `vault path          ${path.join(scratch, 'state', 'vault', 'secrets.json')}`,
    `TEMP/TMP/TMPDIR     ${path.join(scratch, 'temp')}`, 'nightly suites      not enabled (they are unexecuted coverage, named)',
    'started             2026-09-10T00:00:00.000Z', '=======================================', '',
  ].join('\n')
  const captured = [ '', '> fixture@1.0.0 verify:release', '> node tools/test-ratchet.mjs --strict', '',
    `Dependency resolution: ${deps}.`,
    `Measurement environment: node v22.19.0 at ${job.command}; TOOLSENABLED_STATE_ROOT=${path.join(scratch, 'state')}; MC_CANONICAL_ROOT=${engine}; TOOLSENABLED_TEST_STRICT=1; TOOLSENABLED_NIGHTLY=(unset).`,
    'Test ratchet: running `npm test` ...', `Raw suite output retained at ${rawDirectory}`,
    'Ran 1 tests: 1 pass, 0 fail, 0 skipped (0 failing top-level test(s), suite exit 0).',
    'UNEXECUTED (skipped) tests: 0.', '',
    'Strict verification OK: 1 passed, no failures; no failure baseline was accepted; 1 required control(s) passed; 0 test(s) unexecuted and named, 0 unexecuted and unnamed.', '',
  ].join('\n')
  const footer = [ '', '=== app strict release counts ===', 'tests 1  pass 1  fail 0  skipped 0',
    'UNEXECUTED (skipped)  0', 'unexecuted and named  0', 'verify:release exit   0',
    'finished              2026-09-10T00:00:01.000Z', `full output           ${path.join(scratch, 'strict-output.log')}`, '=================================', '',
  ].join('\n')
  const rawOut = 'TAP version 13\nok 1 - parser fixture\n1..1\n# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n'
  const fingerprint = value => ({ bytes: Buffer.byteLength(value), sha256: createHash('sha256').update(value).digest('hex') })
  await writeFile(path.join(scratch, 'strict-header.txt'), header)
  await writeFile(path.join(scratch, 'strict-output.log'), captured)
  await writeFile(path.join(rawDirectory, 'stdout.log'), rawOut)
  await writeFile(path.join(rawDirectory, 'stderr.log'), '')
  await writeFile(path.join(rawDirectory, 'run.json'), JSON.stringify({ schemaVersion: 1, cwd: app,
    command: 'npm test', exitCode: 0, signal: null, stdout: fingerprint(rawOut), stderr: fingerprint('') }))
  return { app, engine, stage, evidence, scratch, context, subject, selection, strictInputs, job, rawDirectory, rawOut, output: header + captured + footer }
}

test('strict execution planning binds the exact engine and private scratch with a finite job budget', async () => {
  await fixture(async root => {
    const f = await strictFixture(root)
    assert.deepEqual(f.job.args, [path.join(f.app, 'tools/test-strict.mjs'), '--canonical-root', f.engine, '--scratch', f.scratch])
    assert.equal(f.job.timeoutMs, 30 * 60 * 1000)
    assert.deepEqual(f.job.env, { TOOLSENABLED_TEST_STRICT: '1', MC_CANONICAL_ROOT: f.engine })
    assert.throws(() => planSourceSuiteJobs(f.selection, f.evidence), /exact measured app\/engine/)
    assert.throws(() => planSourceSuiteJobs({ ...f.selection, canonicalRoot: root }, f.evidence, { strictInputs: f.strictInputs }), /exact measured app\/engine/)
    assert.throws(() => measureStrictSourceInputs(f.selection, f.context, { ...f.subject, context: {} }), /exact measured subject/)
    await writeFile(path.join(f.app, 'private/capability-source.owner.json'), JSON.stringify({ path: f.engine, ref: 'c'.repeat(40) }))
    assert.throws(() => measureStrictSourceInputs(f.selection, f.context, f.subject), /exact engine/)
  })
})

test('every App source job binds the measured Engine and refuses absent or substituted inputs', async () => {
  await fixture(async root => {
    const f = await strictFixture(root)
    const selection = { ...f.selection, files: ['tools/test/current-engine.test.mjs'], commands: [
      ...f.selection.commands, { id: 'fixture:ordinary', command: ['node', 'tools/check.mjs'] } ] }
    const jobs = planSourceSuiteJobs(selection, f.evidence, { strictInputs: f.strictInputs })
    assert.equal(jobs.length, 3)
    for (const job of jobs) {
      assert.equal(job.env.MC_CANONICAL_ROOT, f.engine)
      assert.deepEqual(job.sourceBinding, { root: f.app, canonicalRoot: f.engine, appRef: f.subject.sourceRefs.app,
        engineRef: f.subject.sourceRefs.engine, sourceRecord: f.strictInputs.sourceRecord })
      assert.equal(registeredToolEnvironment(job.env, { cwd: job.cwd, sourceBinding: job.sourceBinding }).MC_CANONICAL_ROOT, f.engine)
    }
    assert.throws(() => planSourceSuiteJobs({ ...selection, commands: [] }, f.evidence), /exact measured app\/engine/)
    assert.throws(() => planSourceSuiteJobs(selection, f.evidence, { strictInputs: { ...f.strictInputs, canonicalRoot: root } }), /exact measured app\/engine/)
    const job = jobs.at(-1), options = { cwd: job.cwd, sourceBinding: job.sourceBinding }
    assert.throws(() => registeredToolEnvironment(job.env), /source binding/)
    assert.throws(() => registeredToolEnvironment({ MC_CANONICAL_ROOT: f.engine }, options), /source binding/)
    assert.throws(() => registeredToolEnvironment({ TOOLSENABLED_TEST_STRICT: '1' }, options), /source binding/)
    assert.throws(() => registeredToolEnvironment({ ...job.env, MC_CANONICAL_ROOT: root }, options), /source binding/)
    assert.throws(() => registeredToolEnvironment(job.env, { ...options, cwd: f.engine }), /source binding/)
    assert.throws(() => registeredToolEnvironment({ ...job.env, mc_canonical_root: f.engine }, options), /source binding/)
    assert.throws(() => registeredToolEnvironment({ ...job.env, RESEARCH_BENCHMARK_TEST_ENGINE_ROOT: root }, options), /unregistered/)
    assert.throws(() => registeredToolEnvironment(job.env, { ...options, sourceBinding: { ...job.sourceBinding, engineRef: 'c'.repeat(40) } }), /source binding/)
    const alias = path.join(root, 'linked-engine')
    await symlink(f.engine, alias, process.platform === 'win32' ? 'junction' : 'dir')
    assert.throws(() => registeredToolEnvironment({ ...job.env, MC_CANONICAL_ROOT: alias }, {
      ...options, sourceBinding: { ...job.sourceBinding, canonicalRoot: alias },
    }), /linked/)
    const sourceRecordPath = path.join(f.app, 'private/capability-source.owner.json')
    await writeFile(sourceRecordPath, JSON.stringify({ path: f.engine, ref: f.subject.sourceRefs.engine, changed: true }))
    assert.throws(() => registeredToolEnvironment(job.env, options), /source binding/)
    await writeFile(sourceRecordPath, JSON.stringify({ path: f.engine, ref: 'c'.repeat(40) }))
    const { sha256, bytes } = fileIdentity(sourceRecordPath)
    assert.throws(() => registeredToolEnvironment(job.env, { ...options,
      sourceBinding: { ...job.sourceBinding, sourceRecord: { sha256, bytes } },
    }), /source binding/)
  })
})

test('an actual constrained App test child resolves the selected Engine despite stale ambient choices', {
  /* 240s, not 60s. This is the only case here that spawns a real owned job,
     and its cost tracks whatever else the host is doing. Measured by Worker 85
     on this build host, and NOT reproduced by review -- the case refuses another
     agent's node through registered-toolchain.mjs, and rebuilding 2x CPU load
     would breach the owner's CPU cap -- 4.8s idle and 35.4s with the CPU
     oversubscribed 2x (16 busy workers on 8 cores). That 7.3x inflation puts
     the old 60s budget inside reach of an ordinary concurrent strict ratchet,
     and a deadline that only holds on an idle machine reports a scheduling fact
     as an engine-resolution failure, which is the one thing this case measures.

     DURATION IS UNBOUNDED BELOW 240s, AND THAT IS A REAL GAP. The job's own
     deadline is 610s (planSourceSuiteJobs), so this harness timeout was the
     only cost signal and widening it made that signal four times looser: a
     regression that took 200s would pass here in silence. No idle upper bound
     is asserted instead, because on a shared build host that is the same flake
     in the other direction. The elapsed time is emitted as a diagnostic below
     so the cost stays visible in the TAP output rather than being unmeasured.
     Nothing this case asserts changed when the budget moved. */
  skip: !['linux', 'win32'].includes(process.platform), timeout: 240000,
}, async t => {
  const startedAtMs = Date.now();
  await fixture(async root => {
    const f = await strictFixture(root)
    await mkdir(path.join(f.engine, 'src/lib'), { recursive: true })
    await mkdir(path.join(f.app, 'tools/test'), { recursive: true })
    /* commandFor's real 'app' job now carries --import=./tools/test/lib/
       isolate-native-state-root.mjs (see source-suites.mjs); this fixture's
       synthetic app root needs the same file at the same relative path or
       the spawned child fails to resolve it before its own test ever runs. */
    await mkdir(path.join(f.app, 'tools/test/lib'), { recursive: true })
    await writeFile(path.join(f.app, 'tools/test/lib/isolate-native-state-root.mjs'),
      await readFile(new URL('./lib/isolate-native-state-root.mjs', import.meta.url), 'utf8'))
    await writeFile(path.join(f.engine, 'src/lib/agent-org.js'), 'module.exports = {}')
    await writeFile(path.join(f.engine, 'selection.cjs'), 'module.exports = "SELECTED_FROZEN_ENGINE"')
    await writeFile(path.join(f.app, 'capability/selection.cjs'), 'throw new Error("STALE_STAGED_ENGINE")')
    await writeFile(path.join(f.stage, 'resources/capability/selection.cjs'), 'throw new Error("STALE_STAGED_ENGINE")')
    f.subject.stageSha256 = measureTree(f.stage).sha256
    f.strictInputs = measureStrictSourceInputs(f.selection, f.context, f.subject)
    const resolver = new URL('../canonical-root.mjs', import.meta.url).href
    await writeFile(path.join(f.app, 'tools/test/current-engine.test.mjs'), `import test from 'node:test';
import assert from 'node:assert/strict'; import { createRequire } from 'node:module';
import { canonicalRootForTests } from ${JSON.stringify(resolver)};
test('loads only selected frozen Engine', () => {
  const root = canonicalRootForTests({ setting: null, requireConfigured: true });
  assert.equal(root, ${JSON.stringify(f.engine)});
  assert.equal(createRequire(import.meta.url)(root + '/selection.cjs'), 'SELECTED_FROZEN_ENGINE');
  assert.equal(process.env.RESEARCH_BENCHMARK_TEST_ENGINE_ROOT, undefined);
  assert.equal(process.env.TOOLSENABLED_SOURCE, undefined);
});`)
    const selection = { ...f.selection, files: ['tools/test/current-engine.test.mjs'], commands: [] }
    const job = planSourceSuiteJobs(selection, f.evidence, { strictInputs: f.strictInputs })[0]
    const names = ['MC_CANONICAL_ROOT', 'TOOLSENABLED_SOURCE', 'RESEARCH_BENCHMARK_TEST_ENGINE_ROOT']
    const before = Object.fromEntries(names.map(name => [name, process.env[name]]))
    try {
      for (const name of names) process.env[name] = path.join(f.app, 'capability')
      // Linux source qualification remains unregistered; this executes only the
      // selected command/input seam under its native owner's fixed grace.
      const result = await runOwnedJob({ ...job, cleanupGraceMs: process.platform === 'linux' ? 250 : job.cleanupGraceMs,
        evidenceRoot: f.evidence })
      assert.equal(result.complete, true, result.error)
      assert.equal(result.cleanupConfirmed, true)
      const stdout = await readFile(result.stdout.path, 'utf8')
      const stderr = await readFile(result.stderr.path, 'utf8')
      assert.equal(result.exitCode, 0, stdout + stderr)
      assert.equal(inspectSourceTap(stdout).counts.passed, 1)
      const expectedEnv = registeredToolEnvironment(job.env, { cwd: job.cwd, sourceBinding: job.sourceBinding })
      assert.equal(result.environmentSha256, process.platform === 'linux' ? digestRecord(expectedEnv)
        : createHash('sha256').update(JSON.stringify(expectedEnv)).digest('hex'))
      const launch = JSON.parse(await readFile(result.launchSpec.path, 'utf8')).jobs[result.jobIndex]
      assert.deepEqual(launch.sourceBinding, job.sourceBinding)
      assert.deepEqual(launch.environment, process.platform === 'linux' ? expectedEnv
        : Object.keys(expectedEnv).sort().map(key => `${key}=${expectedEnv[key]}`))
      await assert.rejects(runOwnedJob({ ...job, cleanupGraceMs: process.platform === 'linux' ? 250 : job.cleanupGraceMs,
        env: { ...job.env, MC_CANONICAL_ROOT: path.join(f.app, 'capability') }, evidenceRoot: f.evidence }), /source binding/)
      t.diagnostic(`constrained-engine owned job: ${Date.now() - startedAtMs} ms elapsed (harness budget 240000 ms, job deadline 610000 ms)`)
    } finally {
      for (const name of names) { if (before[name] === undefined) delete process.env[name]; else process.env[name] = before[name] }
    }
  })
})

test('strict input measurement refuses payload drift and dependencies reached through links', async () => {
  await fixture(async root => {
    const f = await strictFixture(root)
    await writeFile(path.join(f.app, 'capability/payload.js'), 'changed')
    assert.throws(() => measureStrictSourceInputs(f.selection, f.context, f.subject), /certified staged payload/)
    await writeFile(path.join(f.app, 'capability/payload.js'), 'payload')
    await rm(path.join(f.app, 'node_modules'), { recursive: true })
    await symlink(f.engine, path.join(f.app, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    assert.throws(() => measureStrictSourceInputs(f.selection, f.context, f.subject), /linked/)
  })
})

test('strict report verification requires its complete real format and matching retained raw TAP', async () => {
  await fixture(async root => {
    const f = await strictFixture(root)
    // Synthetic parser fixtures exercise verification; they are not execution
    // evidence and never enter the source observation/qualification consumer.
    assert.deepEqual(parseSourceOutput(f.output, '', f.job), { tests: 0, passed: 0, failed: 0, skipped: 0, cancelled: 0, todo: 0, notRun: 0 })
    assert.equal(verifyStrictReleaseFiles(f.output, '', f.job).length, 5)
    assert.deepEqual(parseSourceOutput(f.output.replaceAll('\n', '\r\n'), '', f.job), parseSourceOutput(f.output, '', f.job))
    for (const [from, to] of [
      ['verify:release exit   0', 'verify:release exit   1'],
      ['Ran 1 tests: 1 pass', 'Ran 0 tests: 0 pass'],
      ['1 required control(s) passed', '0 required control(s) passed'],
      ['0 skipped (0 failing', '1 skipped (0 failing'],
      [`engine HEAD         ${f.subject.sourceRefs.engine}`, `engine HEAD         ${'c'.repeat(40)}`],
      [`state roots         ${path.join(f.scratch, 'state')}`, 'state roots         inherited'],
      [`Raw suite output retained at ${f.rawDirectory}`, `Raw suite output retained at ${root}`],
      ['UNEXECUTED (skipped) tests: 0.', ''],
    ]) assert.throws(() => parseSourceOutput(f.output.replace(from, to), '', f.job), /Source qualification incomplete/)
    assert.throws(() => parseSourceOutput(f.output, 'unexplained child error', f.job), /Source qualification incomplete/)
    assert.throws(() => parseSourceOutput(f.output + 'late output\n', '', f.job), /Source qualification incomplete/)
    assert.throws(() => parseSourceOutput(f.output, '', { ...f.job, args: [...f.job.args, '--nightly'] }), /command or bound context/)
    await writeFile(path.join(f.rawDirectory, 'stdout.log'), f.rawOut.replace('ok 1 -', 'not ok 1 -'))
    assert.throws(() => verifyStrictReleaseFiles(f.output, '', f.job), /raw child execution metadata or output changed/)
    const metadataPath = path.join(f.rawDirectory, 'run.json')
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
    const edited = f.rawOut.replace('ok 1 -', 'not ok 1 -')
    metadata.stdout = { bytes: Buffer.byteLength(edited), sha256: createHash('sha256').update(edited).digest('hex') }
    await writeFile(metadataPath, JSON.stringify(metadata))
    assert.throws(() => verifyStrictReleaseFiles(f.output, '', f.job), /failed\/skipped\/TODO TAP test|TAP counts\/plan/)
    await writeFile(path.join(f.rawDirectory, 'stdout.log'), f.rawOut)
    metadata.stdout = { bytes: Buffer.byteLength(f.rawOut), sha256: createHash('sha256').update(f.rawOut).digest('hex') }
    metadata.exitCode = 1
    await writeFile(metadataPath, JSON.stringify(metadata))
    assert.throws(() => verifyStrictReleaseFiles(f.output, '', f.job), /raw child execution metadata or output changed/)
    assert.throws(() => assertSourceCleanupConfirmed([{ cleanupConfirmed: false }]), error => error.cleanupUnconfirmed === true)
  })
})

test('the actual strict wrapper refuses malformed arguments and absent canonical context before measuring', () => {
  const script = fileURLToPath(new URL('../test-strict.mjs', import.meta.url))
  for (const [args, refusal] of [[['--unsupported'], 'BAD_ARGUMENTS'], [[], 'NO_CANONICAL_ROOT']]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', windowsHide: true, timeout: 10000,
      env: { PATH: '', TEMP, TMP: TEMP } })
    assert.ifError(result.error)
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, new RegExp(`REFUSED ${refusal}`))
    assert.match(result.stderr, /NOTHING WAS MEASURED/)
  }
})


const ENGINE_BILLING_TRANSCRIPT = [
  'Billing provider tests passed.',
  'STRICT EVIDENCE: tests/providers.billing/billing-provider.js -- process-exit; assertion count not reported',
  'PASS L1 malformed license refuses', 'PASS L2 valid local fixture is accepted',
  'license-provider: 2 passed, 0 failed',
  'STRICT EVIDENCE: tests/providers.billing/license-provider.js -- process-exit; assertion count not reported',
  'PASS E1 unlicensed hosted relay refuses', 'hosted-relay-entitlement: 1 passed, 0 failed',
  'STRICT EVIDENCE: tests/providers.billing/hosted-relay-entitlement.js -- process-exit; assertion count not reported', '',
].join('\n')
const ENGINE_BILLING_OPTIONS = { reporter: 'engine:isolated-transcript', actionId: 'engine:billing-runner' }

test('engine source census preserves new assertions and classifies only named helpers and runners', () => {
  const inventory = new Map(SOURCE_MANIFESTS.engine.inventory.map(row => [row.file, row.reason]))
  for (const file of ['tests/agent-engine/resume-refuse-by-provider.test.js', 'tests/provider-session-isolation.test.js',
    'tests/agent-engine/claude-cli-image-turn.test.js', 'tests/agent-engine/turn-image-bytes.test.js',
    'tests/providers.sandbox/sandbox-admission-lock.test.js', 'tests/online-fra-admin-enrollment.test.js',
    'tests/mcp-call-exit-code-honesty.test.js', 'tests/mcp-call-permission-session.test.js',
    'tests/standing-orders-protected-write.js',
    'tests/helpers/isolated-state-root.test.js', 'tests/coordinator-audit-events.test.js',
    'tests/secrets/windows-device-credential-clear.js', 'tests/code.intel/allowlist.test.js']) {
    assert.equal(inventory.get(file), null, `${file} must execute`)
  }
  for (const file of ['tests/fixtures/resource-channel-child.js', 'tests/helpers/byte-authority-child.js',
    'tests/helpers/byte-authority-fixture.js', 'tests/lib/strict-lifecycle-fixture.js', 'tests/linux-native.js']) {
    assert.equal(typeof inventory.get(file), 'string', `${file} is an input or separately required runner`)
  }
  for (const file of ['tests/jarvis-audit-events.test.js', 'tests/iphone-handoff-broker-adapter.js', 'tests/private-vault-refusals.test.js']) {
    assert.equal(inventory.has(file), false, 'removed product paths cannot masquerade as existing assertion files')
  }
  const files = [...inventory.keys()]
  assert.deepEqual(files, [...files].sort())
  const aliases = SOURCE_MANIFESTS.engine.aliases
  assert.equal(aliases['test:provider-session-isolation'], 'node tests/run-isolated.js tests/provider-session-isolation.test.js')
  for (const alias of ['test:provider-release']) {
    const result = reconcileSourceCommands({ aliases: { [alias]: aliases[alias] }, selectedFiles: [] })
    assert.equal(result.complete, false)
    assert.ok(result.obligations.some(row => row.id === 'empty-required-command'))
  }
  const model = SOURCE_COMMAND_ACTIONS.engine.find(row => row.id === 'engine:models-runner')
  assert.equal(model.declaredPathInputs[0].paths.length, 8)
  assert.equal(model.declaredPathInputs[0].paths.includes('src/lib/providers/jarvis-control.js'), false)
  assert.ok(model.measuredInputs.includes('src/lib/tool-registry.js'), 'the direct registry guard remains measured')
  assert.deepEqual(SOURCE_RUNNER_REQUIREMENTS.engine[0].requiredFiles, [
    'tests/code.intel/code-intel.js', 'tests/code-intel-containment.test.js', 'tests/mcp-contract.js',
    'tests/code.intel/allowlist.test.js', 'tests/capability-recall/allowlist.test.js', 'tests/code.intel/gemini-mcp-profile.js',
  ])
  const desktop = SOURCE_RUNNER_REQUIREMENTS.engine.find(row => row.runner === 'tests/desktop.native/run.js')
  assert.deepEqual(desktop.requiredPlatforms, DESKTOP_NATIVE_SUITES)
  assert.deepEqual(desktop.requiredFiles, Object.values(DESKTOP_NATIVE_SUITES).flat())
  for (const file of desktop.requiredFiles) assert.equal(inventory.get(file), null, `${file} remains a required source suite`)
  const custody = SOURCE_RUNNER_REQUIREMENTS.engine.find(row => row.runner === 'tests/key-custody/run.js')
  assert.deepEqual(custody.requiredPlatforms, {
    linux: ['tests/linux-vault.test.js'], win32: ['tests/vault-native.test.js'],
  })
  for (const file of custody.requiredFiles) assert.equal(inventory.get(file), null, `${file} remains paired acceptance`)
  assert.equal(inventory.get(custody.runner), 'runner', 'dispatch is not a leaf assertion count')
})

const DESKTOP_NATIVE_SUITES = {
  linux: ['tests/linux-desktop.test.js', 'tests/linux-desktop-ask.test.js', 'tests/linux-desktop-temp.test.js'],
  win32: ['tests/desktop-advanced.js', 'tests/desktop-app-capture.js', 'tests/desktop-window-close-guard.js'],
}

test('the current Engine source selection reconciles renamed and newly landed assertion files', () => {
  const selection = inspectSourceSuite('engine', { sourceRoots: { engine: canonicalRootForTests() } })
  assert.deepEqual(selection.obligations.filter(row => ['missing-tests', 'unreconciled-tests',
    'unselected-required-test'].includes(row.id)), [])
  assert.deepEqual(selection.files, selection.discovered.filter(file =>
    !selection.exclusions.some(excluded => excluded.file === file)))
  for (const file of ['tests/blank-tree-role.test.js', 'tests/empty-role-directions.test.js',
    'tests/blank-role-continuation.test.js', 'tests/multi-account-codex-schema.test.js',
    'tests/mcp-call-exit-code-honesty.test.js', 'tests/mcp-call-permission-session.test.js',
    'tests/standing-orders-protected-write.js',
    'tests/linux-keyring-fixture-root.test.js', 'tests/key-custody-dispatch.test.js']) {
    assert.ok(selection.files.includes(file), `${file} must execute`)
  }
  // File reconciliation cannot silently discharge actual empty scripts or
  // native/context-dependent executors that the qualifier has not implemented.
  for (const alias of ['test:provider-release']) {
    assert.ok(selection.obligations.some(row => row.id === 'empty-required-alias' && row.alias === alias))
  }
  assert.ok(selection.obligations.some(row => row.id === 'unmapped-required-command'
    && row.alias === 'test:desktop.native'))
  assert.ok(selection.obligations.some(row => row.id === 'unmapped-required-command'
    && row.alias === 'test:strict'))
  assert.ok(selection.commands.some(row => row.id === 'engine:native-custody'
    && row.command[1] === 'tests/key-custody/run.js'))
  assert.ok(!selection.obligations.some(row => row.id === 'unmapped-required-command'
    && row.alias === 'test:key-custody'), 'fixed local execution now has its own transcript verifier')
  assert.deepEqual(selection.commands.find(row => row.id === 'engine:native-custody').requiredFiles,
    ['tests/linux-vault.test.js', 'tests/vault-native.test.js'], 'both native leaves remain required')
  assert.equal(selection.complete, false)
})

test('current desktop native runner dispatches exact native suites and preserves refusal without touching a desktop', async () => {
  const engine = canonicalRootForTests(), file = path.join(engine, 'tests/desktop.native/run.js')
  const source = await readFile(file, 'utf8')
  function run(platform, result = { status: 0 }) {
    const calls = [], errors = []
    const childProcess = { platform, execPath: process.execPath, exitCode: undefined,
      stderr: { write: value => errors.push(value) } }
    vm.runInNewContext(source, { __dirname: path.dirname(file), process: childProcess,
      require(name) {
        if (name === 'node:path') return path
        assert.equal(name, 'node:child_process')
        return { spawnSync: (...args) => { calls.push(args); return result } }
      } }, { filename: file, timeout: 1000 })
    return { calls, errors, code: childProcess.exitCode }
  }
  for (const platform of ['linux', 'win32']) {
    const success = run(platform)
    assert.equal(success.code, 0)
    assert.equal(success.calls.length, 1)
    const [command, args, options] = success.calls[0]
    assert.equal(command, process.execPath)
    assert.deepEqual(Array.from(args), [path.join(engine, 'tests/run-isolated.js'), ...DESKTOP_NATIVE_SUITES[platform]])
    assert.equal(options.cwd, engine)
    assert.equal(options.shell, false)
    assert.equal(options.windowsHide, true)
    assert.equal(options.stdio, 'inherit')
    assert.ok(Number.isSafeInteger(options.timeout) && options.timeout > 0)
    assert.equal(run(platform, { status: 17 }).code, 17)
    assert.equal(run(platform, { status: null, signal: 'SIGTERM' }).code, 1)
    const failed = run(platform, { status: 0, error: { message: 'fixture native launch failure' } })
    assert.equal(failed.code, 1)
    assert.match(failed.errors.join(''), /fixture native launch failure/)
  }
  const unsupported = run('darwin')
  assert.equal(unsupported.code, 1)
  assert.deepEqual(unsupported.calls, [])
  assert.match(unsupported.errors.join(''), /unsupported/i)
})

test('reconciled engine aliases retain selected additions and relocated builtin assertions', async () => {
  const engine = canonicalRootForTests()
  const scripts = JSON.parse(await readFile(path.join(engine, 'package.json'), 'utf8')).scripts
  for (const name of ['test', 'test:agent-engine', 'test:desktop', 'test:repo-protocol',
    'test:role-library', 'test:research-subsystem']) {
    assert.equal(SOURCE_MANIFESTS.engine.aliases[name], scripts[name], `${name} must name the reviewed current invocation`)
  }
  const selected = new Set(SOURCE_MANIFESTS.engine.inventory.filter(row => row.reason === null).map(row => row.file))
  for (const file of ['tests/host-byte-mediation.test.js', 'tests/isolated-runner-owned-process.test.js',
    'tests/linux-credential-prompt.test.js', 'tests/owner-host-socket-path-refusal.test.js',
    'tests/owner-prompt-shared-runner.test.js', 'tests/owner-prompt-windows-capture.test.js',
    'tests/vault-presence-cache-linux.test.js', 'tests/agent-engine/codex-turn-failure-details.test.js',
    'tests/approval-prompt-completeness.test.js']) assert.ok(selected.has(file), `${file} must remain selected`)
  const rootSuite = (await readFile(path.join(engine, 'tests/suites/root-suite.txt'), 'utf8'))
    .split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'))
  for (const file of ['tests/builtin-assertion-evidence.test.js', 'tests/builtin-assertion-scope.test.js']) {
    assert.ok(rootSuite.includes(file), `${file} left the duplicate repo-protocol alias but must remain in the root suite`)
    assert.ok(selected.has(file), `${file} must remain independently selected by release qualification`)
  }
})

test('desktop native contract refuses every missing companion-platform suite', async () => {
  await fixture(async root => {
    await mkdir(path.join(root, 'tests'), { recursive: true })
    await mkdir(path.join(root, 'tools'), { recursive: true })
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: {} }))
    const files = Object.values(DESKTOP_NATIVE_SUITES).flat()
    for (const file of files) await writeFile(path.join(root, file), 'throw Error("inspection must not execute a native fixture")')
    const missing = () => inspectSourceSuite('engine', { sourceRoots: { engine: root } }).obligations
      .filter(row => row.id === 'missing-required-runner-test' && row.runner === 'tests/desktop.native/run.js')
    assert.deepEqual(missing(), [])
    for (const file of files) {
      await unlink(path.join(root, file))
      assert.deepEqual(missing(), [{ id: 'missing-required-runner-test', runner: 'tests/desktop.native/run.js', file }])
      await writeFile(path.join(root, file), 'throw Error("inspection only")')
    }
  })
})

test('engine runner transcript requires every actual isolated child and its assertion report', () => {
  // Explicit synthetic parser fixture. It cannot be an owned execution record
  // or qualify a candidate; production also checks exact jobs and replays them.
  const observed = parseSourceOutput(ENGINE_BILLING_TRANSCRIPT, '', ENGINE_BILLING_OPTIONS)
  assert.deepEqual(observed, { tests: 0, passed: 0, failed: 0, skipped: 0, cancelled: 0, todo: 0, notRun: 0 })
  assert.deepEqual(parseSourceOutput(ENGINE_BILLING_TRANSCRIPT.replaceAll('\n', '\r\n'), '', ENGINE_BILLING_OPTIONS), observed)
  for (const [before, after] of [
    ['Billing provider tests passed.\n', ''],
    ['license-provider: 2 passed, 0 failed', 'license-provider: 0 passed, 0 failed'],
    ['license-provider: 2 passed, 0 failed', 'license-provider: 3 passed, 0 failed'],
    ['PASS L1 malformed license refuses', 'FAIL L1 malformed license refuses'],
    ['tests/providers.billing/license-provider.js --', 'tests/providers.billing/billing-provider.js --'],
    ['hosted-relay-entitlement: 1 passed, 0 failed', 'hosted-relay-entitlement: 1 passed, 1 failed'],
    ['process-exit; assertion count not reported', 'process-exit; 10 invented assertions'],
  ]) assert.throws(() => parseSourceOutput(ENGINE_BILLING_TRANSCRIPT.replace(before, after), '', ENGINE_BILLING_OPTIONS), /Source qualification incomplete/)
  for (const extra of ['STRICT EVIDENCE: unknown.js -- process-exit; assertion count not reported\n', 'unfinished child output\n']) {
    assert.throws(() => parseSourceOutput(ENGINE_BILLING_TRANSCRIPT + extra, '', ENGINE_BILLING_OPTIONS), /Source qualification incomplete/)
  }
  assert.throws(() => parseSourceOutput(ENGINE_BILLING_TRANSCRIPT, 'AssertionError: failed child\n', ENGINE_BILLING_OPTIONS), /reported failure/)
  assert.throws(() => parseSourceOutput(ENGINE_BILLING_TRANSCRIPT, '', { ...ENGINE_BILLING_OPTIONS, actionId: 'unregistered' }), /unknown fixed/)
  const action = SOURCE_COMMAND_ACTIONS.engine.find(row => row.id === 'engine:billing-runner')
  assert.equal(action.isolatedReports.length, 3)
  const full = reconcileSourceCommands({ aliases: { 'test:providers.billing': 'node tests/providers.billing/run.js' },
    selectedFiles: action.isolatedReports.map(row => row.file), coveredCommands: [action.command] })
  assert.equal(full.complete, true)
  assert.equal(reconcileSourceCommands({ aliases: { 'test:providers.billing': 'node tests/providers.billing/run.js --waive' },
    selectedFiles: action.isolatedReports.map(row => row.file), coveredCommands: [action.command] }).complete, false)
})

// Explicit synthetic parser input, never native execution or release evidence.
const ENGINE_GOOGLE_TRANSCRIPT = [
  'Google input hardening tests passed.',
  'STRICT EVIDENCE: tests/providers.google.suite/google-inputs.js -- process-exit; assertion count not reported',
  'google-oauth access-token absence: 7 checks passed',
  'STRICT EVIDENCE: tests/providers.google.suite/google-oauth-access-token.js -- process-exit; assertion count not reported',
  'Google Cloud selected-account inspector tests passed.',
  'STRICT EVIDENCE: tests/providers.google.suite/gcloud-account-inspector.js -- process-exit; assertion count not reported',
  'Firebase account login tests passed.',
  'STRICT EVIDENCE: tests/providers.google.suite/firebase-account-login.js -- process-exit; assertion count not reported',
  '  ok  unsafe attachment refuses', '  ok  fixed local attachment is read',
  'Gmail attachment tests passed (2 checks).',
  'STRICT EVIDENCE: tests/providers.google.suite/gmail-attachments.js -- process-exit; assertion count not reported',
  '  ok  escaped upload refuses', 'Drive upload containment tests passed (1 checks).',
  'STRICT EVIDENCE: tests/providers.google.suite/drive-upload-containment.js -- process-exit; assertion count not reported',
  'gmailSend failure-path audit tests passed (typed code classification, safe details, original error preserved, audit-write failure isolation, success regression).',
  'STRICT EVIDENCE: tests/providers.google.suite/gmail-send-failure.js -- process-exit; assertion count not reported',
  'Personal Calendar tests passed.',
  'STRICT EVIDENCE: tests/providers.google.suite/personal-calendar.js -- process-exit; assertion count not reported',
  'Provider untrusted-content envelope tests passed.',
  'STRICT EVIDENCE: tests/providers.google.suite/provider-untrusted-content.js -- process-exit; assertion count not reported', '',
].join('\n')

test('fixed Google runner binds all nine children and does not turn omitted or extra work into coverage', () => {
  const options = { reporter: 'engine:isolated-transcript', actionId: 'engine:google-suite-runner' }
  assert.deepEqual(parseSourceOutput(ENGINE_GOOGLE_TRANSCRIPT, '', options),
    { tests: 0, passed: 0, failed: 0, skipped: 0, cancelled: 0, todo: 0, notRun: 0 })
  for (const [before, after] of [
    ['Google input hardening tests passed.\n', ''],
    ['tests/providers.google.suite/google-inputs.js --', 'tests/providers.google.suite/firebase-account-login.js --'],
    ['Gmail attachment tests passed (2 checks).', 'Gmail attachment tests passed (3 checks).'],
    ['Gmail attachment tests passed (2 checks).', 'Gmail attachment tests passed (0 checks).'],
    ['  ok  fixed local attachment is read\n', ''],
    ['Personal Calendar tests passed.', 'SKIP unavailable calendar fixture'],
    ['Provider untrusted-content envelope tests passed.', 'FAIL content escaped'],
  ]) assert.throws(() => parseSourceOutput(ENGINE_GOOGLE_TRANSCRIPT.replace(before, after), '', options), /Source qualification incomplete/)
  assert.throws(() => parseSourceOutput(ENGINE_GOOGLE_TRANSCRIPT + 'unfinished child\n', '', options), /incomplete|complete every required child/)
  assert.throws(() => parseSourceOutput(ENGINE_GOOGLE_TRANSCRIPT, 'AssertionError: hidden failure\n', options), /reported failure/)
  const action = SOURCE_COMMAND_ACTIONS.engine.find(row => row.id === options.actionId)
  const expected = ['google-inputs.js', 'google-oauth-access-token.js', 'gcloud-account-inspector.js', 'firebase-account-login.js',
    'gmail-attachments.js', 'drive-upload-containment.js', 'gmail-send-failure.js', 'personal-calendar.js', 'provider-untrusted-content.js']
    .map(file => `tests/providers.google.suite/${file}`)
  assert.deepEqual(action.isolatedReports.map(row => row.file), expected)
  const reconcile = command => reconcileSourceCommands({ aliases: { 'test:providers.google.suite': command },
    selectedFiles: expected, coveredCommands: [action.command] })
  assert.equal(reconcile('node tests/providers.google.suite/run.js').complete, true)
  assert.equal(reconcile('node tests/providers.google.suite/run.js --waive').complete, false)
})

test('audit result fractions reconcile both populations and every actual reported check', () => {
  const cwd = path.join(TEMP, 'audit-report-fixture')
  const options = { reporter: 'engine:isolated-leaf', cwd, file: path.join(cwd, 'tests/audit-retention.test.js') }
  const output = 'ok - absent policy retains data\nok - invalid policy retains data\naudit-retention: 2/2 checks passed\n'
  assert.equal(parseSourceOutput(output, '', options).tests, 1)
  for (const changed of [output.replace('2/2', '1/2'), output.replace('2/2', '2/3'), output.replace('2/2', '0/0'),
    output.replace('ok - invalid policy retains data\n', ''), output.replace('ok - invalid', 'not ok - invalid')]) {
    assert.throws(() => parseSourceOutput(changed, '', options), /Source qualification incomplete/)
  }
})

test('engine isolated TAP completion must agree with the full per-child TAP plan', () => {
  const source = [
    'iPhone handoff status tests passed.',
    'STRICT EVIDENCE: tests/providers.iphone.handoff/iphone-handoff.js -- process-exit; assertion count not reported',
    'TAP version 13', 'ok 1 - parser fixture', '1..1', '# tests 1', '# suites 0', '# pass 1', '# fail 0',
    '# cancelled 0', '# skipped 0', '# todo 0',
    'STRICT EVIDENCE: tests/iphone-handoff-runtime-boundary.test.js -- reconciled-tap; 1 passed; 0 UNEXECUTED (within-suite skips)', '',
  ].join('\n')
  const options = { reporter: 'engine:isolated-transcript', actionId: 'engine:iphone-readiness-runner' }
  assert.equal(parseSourceOutput(source, '', options).tests, 0)
  for (const [before, after] of [['1 passed; 0 UNEXECUTED', '2 passed; 0 UNEXECUTED'],
    ['1 passed; 0 UNEXECUTED', '1 passed; 1 UNEXECUTED'], ['1..1', '1..2'], ['# tests 1\n', ''],
    ['reconciled-tap; 1 passed; 0 UNEXECUTED (within-suite skips)', 'process-exit; assertion count not reported']]) {
    assert.throws(() => parseSourceOutput(source.replace(before, after), '', options), /Source qualification incomplete/)
  }
})


test('engine legacy check populations retain indentation and must reconcile every emitted check', () => {
  const cwd = path.join(TEMP, 'engine-report-fixture')
  const output = '  ok absent configuration stays disabled\nAgent digest config-absence tests passed (1 checks).\n'
  const options = { reporter: 'engine:isolated-leaf', cwd, file: path.join(cwd, 'tests/agent-digest-config-absence.test.js') }
  assert.equal(parseSourceOutput(output, '', options).tests, 1)
  assert.throws(() => parseSourceOutput(output.replace('(1 checks)', '(2 checks)'), '', options), /result lines do not reconcile/)
  assert.throws(() => parseSourceOutput(output.split('\n').slice(1).join('\n'), '', options), /result lines do not reconcile/)
  assert.throws(() => parseSourceOutput(output.replace('(1 checks)', '(0 checks)'), '', options), /assertion footer/)
})

test('generic legacy source reports consume only fully reconciled isolated boundaries', () => {
  const marker = 'STRICT EVIDENCE: tests/legacy-example.js -- process-exit; assertion count not reported\n'
  const options = { isolatedFiles: ['tests/legacy-example.js'] }
  assert.equal(parseSourceOutput('2/2 checks passed\n' + marker, '', options).tests, 2)
  assert.throws(() => parseSourceOutput('1/2 checks passed\n' + marker, '', options), /does not reconcile/)
  assert.throws(() => parseSourceOutput(marker, '', options), /empty, extra, malformed or reordered/)
  assert.throws(() => parseSourceOutput('2/2 checks passed\n', '', options), /did not complete every required child/)
})

const NATIVE_ADMIN_NAME = 'trusted native actions read fixed private context and a matching signed-reply inbox'
const NATIVE_ADMIN_FILE = 'tools/test/owner-administration.test.mjs'
function scopeTap({ name = NATIVE_ADMIN_NAME, skipped = true, failed = false } = {}) {
  return `TAP version 13\n${failed ? 'not ok' : 'ok'} 1 - ${name}${skipped ? ' # SKIP native Linux required' : ''}\n1..1\n# tests 1\n# suites 0\n# pass ${!skipped && !failed ? 1 : 0}\n# fail ${failed ? 1 : 0}\n# cancelled 0\n# skipped ${skipped ? 1 : 0}\n# todo 0\n`
}

test('native companion requirements preserve unexecuted counts and cannot grant qualification', () => {
  const options = { suite: 'app', files: [NATIVE_ADMIN_FILE], platform: 'win32' }
  const analysis = inspectSourceExecutionCoverage(scopeTap(), options)
  assert.equal(analysis.ready, false)
  assert.deepEqual(analysis.counts, { tests: 1, passed: 0, failed: 0, skipped: 1, cancelled: 0, todo: 0, notRun: 1 })
  assert.equal(analysis.obligations[0].kind, 'companion-platform-required')
  assert.equal(analysis.obligations[0].requiredPlatform, 'linux')
  assert.equal(inspectSourceExecutionCoverage(scopeTap(), { ...options, platform: 'linux' }).obligations[0].kind, 'native-prerequisite-unmet')
  assert.throws(() => parseSourceOutput(scopeTap()), /skipped|deferred/)
  assert.equal(inspectSourceExecutionCoverage(scopeTap({ skipped: false }), { ...options, platform: 'linux' }).nativeCases[0].status, 'observed-pass')
  const foreignPass = inspectSourceExecutionCoverage(scopeTap({ skipped: false }), options)
  assert.equal(foreignPass.nativeCases[0].status, 'wrong-platform-observation')
  assert.equal(foreignPass.obligations.some(row => row.testName === NATIVE_ADMIN_NAME && row.kind === 'companion-platform-required'), true)
  assert.equal(foreignPass.obligations.some(row => row.kind === 'missing-required-native-case'), true,
    'the other four native admin cases cannot disappear from the selected file')
  assert.equal(inspectSourceExecutionCoverage(scopeTap({ name: 'new native Linux check' }), options).obligations[0].kind, 'unmapped-execution-prerequisite')
  assert.equal(inspectSourceExecutionCoverage(scopeTap(), { ...options, files: ['tools/test/unreviewed.test.mjs'] }).obligations[0].kind, 'unmapped-execution-prerequisite')
  assert.throws(() => inspectSourceTap(scopeTap().replace('# pass 0', '# pass 1')), /counts\/plan/)
  const failed = inspectSourceExecutionCoverage(scopeTap({ skipped: false, failed: true }), options)
  assert.equal(failed.counts.failed, 1)
  assert.deepEqual(failed.failures, [NATIVE_ADMIN_NAME])
  assert.equal(failed.nativeCases[0].status, 'failed')
})

test('diagnostic case accounting does not conceal failed suite containers from strict qualification', () => {
  const output = "TAP version 13\n    ok 1 - completed child\n    1..1\nnot ok 1 - parent hook failed\n  type: 'suite'\n1..1\n# tests 1\n# suites 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n"
  const analysis = inspectSourceExecutionCoverage(output, { suite: 'app', files: ['tools/test/fixture.test.mjs'], platform: 'linux' })
  assert.equal(analysis.counts.passed, 1)
  assert.deepEqual(analysis.failures, ['parent hook failed'])
  assert.throws(() => parseSourceOutput(output), /failed\/skipped\/TODO/)
})

test('nightly and device opt-ins remain prerequisites on both hosts, never companion waivers', () => {
  for (const platform of ['win32', 'linux']) {
    const result = sourceCaseExecutionRequirement({ suite: 'app', files: ['tools/test/accessibility-speech.test.mjs'],
      testName: 'real CUDA speech, WebRTC, local consent broker and native controls', platform })
    assert.equal(result.kind, 'explicit-prerequisite-unmet')
    assert.equal(result.prerequisite.environmentVariable, 'TOOLSENABLED_RUN_GPU_SPEECH_PROOF')
    assert.equal(result.status, 'unexecuted')
    assert.equal(Object.hasOwn(result, 'requiredPlatform'), false)
  }
  assert.throws(() => sourceCaseExecutionRequirement({ suite: 'app', files: ['../outside'], testName: NATIVE_ADMIN_NAME, platform: 'linux' }), /Invalid source case/)
})

test('execution scope binds the current native host, source pair, selection and helper closure', () => {
  const selection = { id: 'app', files: [NATIVE_ADMIN_FILE], crossFiles: [], aliases: { test: 'node --test' }, commands: [] }
  const subject = { sourceRefs: { app: 'a'.repeat(40), engine: 'b'.repeat(40) } }, inputs = { sha256: 'c'.repeat(64) }
  const scope = describeSourceExecutionScope(selection, subject, inputs)
  assert.equal(scope.platform, process.platform)
  assert.equal(scope.arch, process.arch)
  assert.equal(scope.ready, false)
  assert.match(scope.companionEvidence, /unimplemented.*independent native replay/)
  assertSourceExecutionScope(scope, selection, subject, inputs)
  for (const edit of [
    { platform: process.platform === 'linux' ? 'win32' : 'linux' }, { arch: 'invented' },
    { sourceRefs: { ...subject.sourceRefs, engine: 'd'.repeat(40) } }, { sourceInputsSha256: 'e'.repeat(64) },
    { selectionSha256: 'e'.repeat(64) }, { companionEvidence: 'caller says another host passed' },
  ]) assert.throws(() => assertSourceExecutionScope({ ...scope, ...edit }, selection, subject, inputs), /source binding or companion scope/)
  assert.throws(() => assertSourceExecutionScope(scope, { ...selection, files: [] }, subject, inputs), /source binding/)
})

test('strict raw coverage is retained with honest omitted counts while the qualification parser refuses it', async () => {
  await fixture(async root => {
    const f = await strictFixture(root)
    const rawOut = scopeTap()
    const fingerprint = value => ({ bytes: Buffer.byteLength(value), sha256: createHash('sha256').update(value).digest('hex') })
    await writeFile(path.join(f.rawDirectory, 'stdout.log'), rawOut)
    await writeFile(path.join(f.rawDirectory, 'run.json'), JSON.stringify({ schemaVersion: 1, cwd: f.app,
      command: 'npm test', exitCode: 0, signal: null, stdout: fingerprint(rawOut), stderr: fingerprint('') }))
    const stdout = f.output.replace('Ran 1 tests: 1 pass, 0 fail, 0 skipped', 'Ran 1 tests: 0 pass, 0 fail, 1 skipped')
    const outputPath = path.join(f.evidence, 'owned-stdout.log'), errorPath = path.join(f.evidence, 'owned-stderr.log')
    await writeFile(outputPath, stdout); await writeFile(errorPath, '')
    const record = { exitCode: 1, cleanupConfirmed: true, stdout: fileIdentity(outputPath), stderr: fileIdentity(errorPath) }
    const selection = { ...f.selection, files: [NATIVE_ADMIN_FILE] }
    const coverage = inspectSourceCoverageRecords(selection, [f.job], [record], f.evidence)[0]
    assert.equal(coverage.status, 'reconciled-raw-observation')
    assert.equal(coverage.exitCode, 1, 'the actual failed wrapper remains failed even with reconciled child TAP')
    assert.equal(coverage.analysis.counts.passed, 0)
    assert.equal(coverage.analysis.counts.skipped, 1)
    assert.equal(coverage.analysis.obligations[0].testName, NATIVE_ADMIN_NAME)
    assert.equal(coverage.retained.length, 3)
    assert.match(coverage.countScope, /not-added-to-leaf-counts/)
    assert.throws(() => verifyStrictReleaseFiles(stdout, '', f.job), /Source qualification incomplete/)
    await writeFile(outputPath, f.output)
    record.stdout = fileIdentity(outputPath)
    const mismatch = inspectSourceCoverageRecords(selection, [f.job], [record], f.evidence)[0]
    assert.equal(mismatch.status, 'incomplete-raw-observation')
    assert.match(mismatch.error.message, /wrapper and raw TAP counts differ/)
    record.stdout = { ...record.stdout, path: path.join(root, 'outside-report.log') }
    await writeFile(record.stdout.path, f.output)
    const escaped = inspectSourceCoverageRecords(selection, [f.job], [record], f.evidence)[0]
    assert.equal(escaped.status, 'incomplete-raw-observation')
    assert.match(escaped.error.message, /escaped its report/)
  })
})
