#!/usr/bin/env node

/* Read-only installer publication preflight.
 *
 * This file deliberately contains no release policy of its own. Each result is
 * produced by the existing gate named in `command`; this file only supplies the
 * release inputs, preserves the gate's output, classifies whether it passed,
 * failed, or could not run, and refuses an overall green for an incomplete run.
 *
 * It never invokes the mutating forms of the release chain: no build, payload
 * pack, electron-builder, --prepare, --record, packaged smoke, install-directory
 * exercise, isolated install, release cut, or publication command appears here.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RESULT = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  COULD_NOT_CHECK: 'COULD-NOT-CHECK',
})

const DELIBERATELY_NOT_COVERED = Object.freeze([
  'building the renderer or packing the capability payload',
  'clearing prior output with check-electron-runtime-files --prepare',
  'running electron-builder or creating an installer',
  'recording a new artifact seal with seal-artifact --record',
  'the packaged smoke run (it launches the application and a capability process)',
  'the install-directory immutability exercise (it launches against scratch state)',
  'isolated install, uninstall, upgrade, registry, shortcut, and machine lifecycle checks',
  'packaged QA, release-candidate cutting, signing, upload, or publication',
])

function parseArguments(argv, packageJson) {
  const outputRoot = path.resolve(REPO_ROOT, packageJson.build?.directories?.output || 'release')
  let artifact = path.join(outputRoot, 'win-unpacked')
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--artifact') {
      if (!argv[index + 1]) throw new Error('--artifact needs a directory')
      artifact = path.resolve(argv[index + 1])
      index += 1
      continue
    }
    throw new Error(`unknown argument: ${argument}`)
  }
  return { artifact, outputRoot: path.dirname(artifact) }
}

function requiredPathProblem(requirement) {
  if (!existsSync(requirement.path)) return `required ${requirement.kind} is absent: ${requirement.path}`
  const info = statSync(requirement.path)
  if (requirement.kind === 'file' && !info.isFile()) return `required file is not a file: ${requirement.path}`
  if (requirement.kind === 'directory' && !info.isDirectory()) return `required directory is not a directory: ${requirement.path}`
  return null
}

/* A few existing gates predate the shared exit-code convention and use exit 1
 * for an explicitly named "could not run" outcome. Preserve their own words
 * instead of relabelling an unperformed comparison as a failed comparison. */
export function classifyExit({ status, error, output = '' }) {
  if (error || status === null || status === undefined) return RESULT.COULD_NOT_CHECK
  if (status === 0) return RESULT.PASS
  if (status === 2) return RESULT.COULD_NOT_CHECK
  if (/\bCOULD NOT RUN\b|\bREFUSING TO REPORT\b|nothing to check:|cannot be compared against anything/i.test(output)) {
    return RESULT.COULD_NOT_CHECK
  }
  return RESULT.FAIL
}

export function overallVerdict(results) {
  if (results.some((result) => result.result === RESULT.FAIL)) return { result: RESULT.FAIL, exitCode: 1 }
  if (results.some((result) => result.result === RESULT.COULD_NOT_CHECK)) {
    return { result: RESULT.COULD_NOT_CHECK, exitCode: 2 }
  }
  return { result: RESULT.PASS, exitCode: 0 }
}

export function runCheck(check, { runner = spawnSync } = {}) {
  try {
    const prerequisiteProblem = check.requires
      ?.map(requiredPathProblem)
      .find(Boolean)
    if (prerequisiteProblem) {
      return { ...check, result: RESULT.COULD_NOT_CHECK, output: prerequisiteProblem }
    }

    const execution = runner(process.execPath, check.command, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    })
    const output = [execution.stdout, execution.stderr].filter(Boolean).join('\n').trim()
    return {
      ...check,
      result: classifyExit({ status: execution.status, error: execution.error, output }),
      output: execution.error ? `${execution.error.message}${output ? `\n${output}` : ''}` : output,
    }
  } catch (error) {
    return {
      ...check,
      result: RESULT.COULD_NOT_CHECK,
      output: `preflight could not start or classify this check: ${error.message}`,
    }
  }
}

function checksFor({ artifact, outputRoot }) {
  const tool = (name) => path.join(REPO_ROOT, 'tools', name)
  const stagedPayload = path.join(REPO_ROOT, 'capability')
  const packagedPayload = path.join(artifact, 'resources', 'capability')
  const appAsar = path.join(artifact, 'resources', 'app.asar')
  const electronDist = path.join(REPO_ROOT, 'node_modules', 'electron', 'dist')
  const installerTests = readdirSync(path.join(REPO_ROOT, 'tools', 'test'))
    .filter((name) => /^installer-.*\.test\.mjs$/u.test(name))
    .sort()
    .map((name) => path.join(REPO_ROOT, 'tools', 'test', name))

  return [
    {
      /* FIRST, BECAUSE IT DECIDES WHETHER THE REST MEAN ANYTHING.
       *
       * Measured 2026-08-24: a full suite run reported three failures, and all
       * three passed when re-run alone. Nothing was flaky -- roughly twenty
       * agents were editing the working tree WHILE the suite ran, so tests read
       * files mid-write. That number was then quoted as a regression verdict,
       * which it was not.
       *
       * Every other check below reads the tree. If the tree is moving, each of
       * them is a snapshot of a thing that no longer exists, and a green
       * preflight over a moving tree is worse than no preflight because it is
       * believed. So this runs first.
       *
       * quiescent-check exits 0 QUIET, 1 MOVING, 2 UNKNOWN, and holds MOVING
       * over UNKNOWN so a failed process census cannot be read as calm. Under
       * this preflight's mapping that makes MOVING a FAIL and UNKNOWN a
       * COULD-NOT-CHECK, and both block. FAIL is the right reading of MOVING
       * rather than a harsh one: you cannot publish from a tree somebody is
       * still editing, so the precondition really has failed, not merely gone
       * unobservable. */
      name: 'Working tree is quiet enough to trust a result',
      command: [tool('quiescent-check.mjs')],
      requires: [{ kind: 'file', path: tool('quiescent-check.mjs') }],
    },
    {
      name: 'Staged payload is current',
      command: [tool('check-payload-current.mjs'), stagedPayload],
      requires: [{ kind: 'directory', path: stagedPayload }],
    },
    {
      name: 'Packaged payload is current',
      command: [tool('check-payload-current.mjs'), packagedPayload],
      requires: [{ kind: 'directory', path: packagedPayload }],
    },
    {
      name: 'Staged payload boundary',
      command: [tool('check-payload-boundary.mjs'), stagedPayload],
      requires: [{ kind: 'directory', path: stagedPayload }],
    },
    {
      name: 'Packaged payload boundary',
      command: [tool('check-payload-boundary.mjs'), packagedPayload],
      requires: [{ kind: 'directory', path: packagedPayload }],
    },
    {
      name: 'ASAR manifest and provenance',
      command: [tool('check-asar-manifest.mjs'), artifact],
      requires: [{ kind: 'file', path: appAsar }],
    },
    {
      name: 'Renderer payload (source, build, and ASAR)',
      command: [tool('check-renderer-payload.mjs'), artifact],
      requires: [{ kind: 'file', path: appAsar }],
    },
    {
      name: 'Owner data in unpacked application',
      command: [tool('check-no-owner-data.mjs'), artifact],
      requires: [{ kind: 'directory', path: artifact }],
    },
    {
      name: 'Owner data in release output',
      command: [tool('check-no-owner-data.mjs'), outputRoot],
      requires: [{ kind: 'directory', path: outputRoot }],
    },
    {
      name: 'Licence notices (repository and package)',
      command: [tool('check-license-notices.mjs'), artifact],
      requires: [{ kind: 'directory', path: path.join(artifact, 'resources') }],
    },
    {
      name: 'Electron runtime files',
      command: [tool('check-electron-runtime-files.mjs'), artifact, electronDist],
      requires: [
        { kind: 'directory', path: artifact },
        { kind: 'directory', path: electronDist },
      ],
    },
    {
      name: 'Artifact seal verification',
      command: [tool('seal-artifact.mjs'), '--verify', artifact],
      requires: [{ kind: 'directory', path: artifact }],
    },
    {
      name: 'Product naming',
      command: [tool('check-product-naming.mjs')],
      requires: [],
    },
    {
      name: 'Release installer identity resolution',
      command: [tool('installer-identity.mjs'), '--channel', 'release'],
      requires: [],
    },
    {
      name: `Installer identity tests (${installerTests.length} files)`,
      command: ['--test', '--test-concurrency=1', ...installerTests],
      requires: installerTests.length
        ? installerTests.map((testPath) => ({ kind: 'file', path: testPath }))
        : [{ kind: 'file', path: path.join(REPO_ROOT, 'tools', 'test', 'NO-INSTALLER-TESTS-DISCOVERED') }],
    },
  ]
}

function printDiagnostic(output) {
  if (!output) return
  for (const line of output.split(/\r?\n/u)) console.log(`    ${line}`)
}

export function main(argv = process.argv.slice(2)) {
  let settings
  try {
    const packageJson = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'))
    settings = parseArguments(argv, packageJson)
  } catch (error) {
    console.error(`[${RESULT.COULD_NOT_CHECK}] Preflight setup\n    ${error.message}`)
    console.error(`\nINSTALLER PREFLIGHT VERDICT: ${RESULT.COULD_NOT_CHECK}`)
    return 2
  }

  let checks
  try {
    checks = checksFor(settings)
  } catch (error) {
    console.error(`[${RESULT.COULD_NOT_CHECK}] Preflight check discovery\n    ${error.message}`)
    console.error(`\nINSTALLER PREFLIGHT VERDICT: ${RESULT.COULD_NOT_CHECK}`)
    return 2
  }

  console.log(`Installer publication preflight (read-only)\nArtifact: ${settings.artifact}\n`)
  const results = []
  for (const check of checks) {
    const result = runCheck(check)
    results.push(result)
    console.log(`[${result.result}] ${result.name}`)
    if (result.result !== RESULT.PASS) printDiagnostic(result.output)
  }

  console.log('\nDeliberately not covered by this read-only preflight:')
  for (const exclusion of DELIBERATELY_NOT_COVERED) console.log(`  - ${exclusion}`)

  const verdict = overallVerdict(results)
  const counts = Object.values(RESULT)
    .map((result) => `${result}=${results.filter((entry) => entry.result === result).length}`)
    .join(' ')
  console.log(`\nINSTALLER PREFLIGHT VERDICT: ${verdict.result} (${counts})`)
  return verdict.exitCode
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) process.exitCode = main()
