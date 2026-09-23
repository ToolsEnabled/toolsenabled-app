#!/usr/bin/env node

/* A BUILD IS PROVEN BY TWO THINGS, AND A WRAPPER'S EXIT CODE IS NEITHER OF THEM.
 *
 * MEASURED on the 1.0.45 Windows cut (REPORT-CUT-1045-MANAGER-20260918): two
 * background build runs both reported "completed, exit code 0" with NOTHING
 * BUILT. The cause is mundane and will recur -- a wrapper whose last statement
 * is an ordinary shell command exits with THAT command's status, and that one
 * ended in a `tail`. npm's own exit had read 2. It was caught only because the
 * wrapper happened to echo npm's own exit code and because somebody looked for
 * the artifact and found it absent.
 *
 * The live twin of the same defect: a candidate assembled without running
 * `node node_modules/vite/bin/vite.js build` opens a TITLE-BAR-ONLY WINDOW,
 * because shell/main.cjs serves dist/ and there is no dist/. Nothing refuses,
 * and the reader concludes the product has no such page.
 *
 * SO THIS STEP MEASURES BOTH, ALWAYS, AND NAMES WHICH ONE IT CAUGHT:
 *
 *   1. THE BUILD TOOL'S OWN EXIT CODE, observed from the build process itself
 *      rather than from whatever shell wrapped it. Where the tool can be
 *      reached without a shell it is run without one, so there is no shell
 *      between its exit and this measurement; where a shell is unavoidable
 *      (npm.cmd on Windows) the receipt says so, so a reader never has to guess
 *      which kind of exit code they are looking at.
 *   2. THE ARTIFACT, on disk, after the run: present, whole, and not older than
 *      the sources it is built from. That check is imported from
 *      tools/lib/staged-renderer.mjs rather than restated -- it already owns
 *      "index.html names a bundle that is not beside it", which is the exact
 *      shape that produces the silent title-bar-only window.
 *
 * ONE PASSING AND THE OTHER FAILING IS THE INTERESTING CASE, which is why the
 * refusal carries a RULE CLASS: `[build-exit-nonzero]` and `[artifact-absent]`
 * have different remedies, and `[build-exit-unknown]` -- the build tool's exit
 * never observed at all -- is a third answer again. Could-not-measure is not
 * the same answer as measured-and-clean (R1228).
 *
 * TWO MODES, because a background wrapper is still how long builds get run:
 *
 *   node tools/build-receipt.mjs                     run the build, then judge it
 *   node tools/build-receipt.mjs --command "node node_modules/vite/bin/vite.js build"
 *   node tools/build-receipt.mjs --verify            judge the recorded receipt again
 *
 * `--verify` re-measures the artifact NOW and re-reads the recorded exit code,
 * so a promote precondition can be met without trusting the exit status of the
 * task that ran the build. The receipt is written under release/, which the cut
 * does not ship, and carries no absolute path and no environment.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { assertRendererMeasurable } from './lib/staged-renderer.mjs'

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_RECEIPT = path.join('release', 'build-receipt.json')
export const DEFAULT_ARTIFACT = 'dist'

/* Every refusal names its class on the first line, so a red build is
   actionable from the log line alone. */
export const BUILD_RULE_CLASS = Object.freeze({
  exitUnknown: '[build-exit-unknown]',
  exitNonZero: '[build-exit-nonzero]',
  artifactAbsent: '[artifact-absent]',
})

/* THE JUDGEMENT, SEPARATED FROM THE RUNNING, so both halves are provable
   without building anything. `exit` is what the BUILD TOOL returned; a wrapper's
   status must never be passed in here. */
export function assessBuild({
  exit,
  repoRoot = REPO_ROOT,
  artifactDir = DEFAULT_ARTIFACT,
  assertArtifact = assertRendererMeasurable,
} = {}) {
  const sourceDist = path.resolve(repoRoot, artifactDir)

  if (exit?.error) {
    return refusal(BUILD_RULE_CLASS.exitUnknown,
      `the build tool never ran, so its exit code was never observed: ${exit.error.message ?? exit.error}.`
      + '\nA wrapper that reports success here is reporting its own last statement, not a build.')
  }
  if (exit?.signal) {
    return refusal(BUILD_RULE_CLASS.exitUnknown,
      `the build tool was killed by ${exit.signal} and produced no exit code of its own.`
      + '\nKilled is not the same answer as failed and neither is the same answer as built.')
  }
  if (!Number.isInteger(exit?.status)) {
    return refusal(BUILD_RULE_CLASS.exitUnknown,
      'no integer exit code was observed from the build tool itself.'
      + '\nThe exit status of the shell, task or wrapper that ran it is not evidence that it built.')
  }
  if (exit.status !== 0) {
    return refusal(BUILD_RULE_CLASS.exitNonZero,
      `the build tool exited ${exit.status}.`
      + `${exit.observedThrough === 'shell' ? '\n(observed through a shell; the code is the build tool\'s own only if that shell propagates it)' : ''}`
      + '\nNothing downstream may treat this tree as built, whatever a wrapper reported.')
  }

  /* The build tool said 0. That is half the answer: an artifact that is absent,
     torn or older than its sources makes the same silent window. */
  try {
    const measured = assertArtifact({ repoRoot, sourceDist, onRefusal: 'throw' })
    return { ok: true, status: exit.status, observedThrough: exit.observedThrough ?? 'direct', artifact: measured }
  } catch (error) {
    return refusal(BUILD_RULE_CLASS.artifactAbsent,
      `the build tool exited 0 and there is no usable artifact at ${path.relative(repoRoot, sourceDist) || artifactDir}.`
      + `\n${error.message.trim()}`
      + '\nExit 0 with nothing built is the defect this step exists to catch: a green build task and a'
      + '\ntitle-bar-only window are the same event seen from two sides.')
  }
}

function refusal(ruleClass, message) {
  return { ok: false, ruleClass, message: `${ruleClass} ${message}` }
}

/* THE BUILD COMMAND, RUN WITH AS LITTLE BETWEEN IT AND US AS THE PLATFORM
   ALLOWS. A command given with --command is split on whitespace and run with no
   shell at all, so its exit code is its own. The default `npm run build` needs
   npm, and on Windows npm is a .cmd that node will not spawn without a shell;
   that case is recorded as observedThrough: 'shell' rather than hidden. */
export function runBuild({ command = null, repoRoot = REPO_ROOT, spawn = spawnSync } = {}) {
  const startedAt = new Date().toISOString()
  const started = Date.now()
  const parts = command ? command.trim().split(/\s+/) : null
  const plan = parts
    ? { file: parts[0] === 'node' ? process.execPath : parts[0], args: parts.slice(1), shell: false, observedThrough: 'direct' }
    : process.platform === 'win32'
      ? { file: 'npm.cmd', args: ['run', 'build'], shell: true, observedThrough: 'shell' }
      : { file: 'npm', args: ['run', 'build'], shell: false, observedThrough: 'direct' }

  const result = spawn(plan.file, plan.args, {
    cwd: repoRoot, stdio: 'inherit', shell: plan.shell, windowsHide: true,
  })

  return {
    command: command ?? 'npm run build',
    status: result?.status ?? null,
    signal: result?.signal ?? null,
    error: result?.error ?? null,
    observedThrough: plan.observedThrough,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
  }
}

export function writeReceipt(receiptPath, receipt) {
  mkdirSync(path.dirname(receiptPath), { recursive: true })
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
}

export function readReceipt(receiptPath) {
  if (!existsSync(receiptPath)) {
    throw new Error(`${BUILD_RULE_CLASS.exitUnknown} there is no build receipt at ${receiptPath}, so the build tool's own`
      + '\nexit code was never recorded. Run the build through this step, or record one beside it.')
  }
  return JSON.parse(readFileSync(receiptPath, 'utf8'))
}

export function parseArgs(argv) {
  const options = { verify: false, command: null, artifact: DEFAULT_ARTIFACT, receipt: DEFAULT_RECEIPT, root: null, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = () => {
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} needs a value`)
      index += 1
      return next
    }
    if (arg === '--verify') options.verify = true
    else if (arg === '--command') options.command = value()
    else if (arg === '--artifact') options.artifact = value()
    else if (arg === '--receipt') options.receipt = value()
    /* The tree to build and judge. It defaults to the checkout this file lives
       in, which is the tree a cut worktree runs its own copy from. */
    else if (arg === '--root') options.root = value()
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

const USAGE = `run a build so that neither half of "it built" can be assumed

  node tools/build-receipt.mjs [--command "<build command>"] [--artifact dist] [--receipt release/build-receipt.json]
  node tools/build-receipt.mjs --verify [--artifact dist] [--receipt release/build-receipt.json]

Exits 0 only when the build tool's own exit was 0 AND the artifact is present and whole.
Every refusal names which of the two it caught: ${Object.values(BUILD_RULE_CLASS).join(' ')}`

export function main(argv, { repoRoot: defaultRoot = REPO_ROOT, log = console.log, error = console.error, spawn = spawnSync } = {}) {
  const options = parseArgs(argv)
  if (options.help) { log(USAGE); return 0 }
  const repoRoot = options.root ? path.resolve(options.root) : defaultRoot
  const receiptPath = path.resolve(repoRoot, options.receipt)

  let exit
  if (options.verify) {
    const receipt = readReceipt(receiptPath)
    exit = { status: receipt.status, signal: receipt.signal, error: null, observedThrough: receipt.observedThrough }
    log(`[build-receipt] verifying the recorded build: ${receipt.command} -> exit ${receipt.status} at ${receipt.finishedAt}`)
  } else {
    log(`[build-receipt] running ${options.command ?? 'npm run build'} and measuring its own exit code`)
    exit = runBuild({ command: options.command, repoRoot, spawn })
  }

  const verdict = assessBuild({ exit, repoRoot, artifactDir: options.artifact })

  if (!options.verify) {
    writeReceipt(receiptPath, {
      command: exit.command,
      status: exit.status,
      signal: exit.signal,
      error: exit.error ? String(exit.error.message ?? exit.error) : null,
      observedThrough: exit.observedThrough,
      startedAt: exit.startedAt,
      finishedAt: exit.finishedAt,
      durationMs: exit.durationMs,
      artifact: options.artifact,
      verdict: verdict.ok ? 'built' : verdict.ruleClass,
    })
    log(`[build-receipt] receipt: ${path.relative(repoRoot, receiptPath).split(path.sep).join('/')}`)
  }

  if (!verdict.ok) {
    error(`[build-receipt] REFUSING: ${verdict.message}`)
    return 1
  }
  log(`[build-receipt] built: exit 0 (${verdict.observedThrough}) and ${verdict.artifact.assets} asset(s) present, built at ${verdict.artifact.builtAt}`)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (failure) {
    console.error(`[build-receipt] REFUSING: ${failure.message}`)
    process.exitCode = 1
  }
}
