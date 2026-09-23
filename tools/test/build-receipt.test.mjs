/* "It built" is two measurements, and this pins both of them.
 *
 * Run: node --test tools/test/build-receipt.test.mjs
 *
 * The defect being pinned was measured on the 1.0.45 Windows cut: a build task
 * reported "completed, exit code 0" twice with nothing built, because the
 * wrapper's last statement was an ordinary shell command and its status became
 * the wrapper's. npm's own exit had read 2.
 *
 * Every end-to-end case here runs the real step against a real throwaway tree
 * with a real build command, so what is pinned is behaviour rather than the
 * wording of a message: a build that exits 0 and leaves no artifact must refuse,
 * and it must say WHICH of the two it caught.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { BUILD_RULE_CLASS, assessBuild, parseArgs } from '../build-receipt.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const STEP = path.join(REPO_ROOT, 'tools', 'build-receipt.mjs')

let root

/* A tree with sources and the two fake build commands the cases select between:
   one that writes a whole renderer, one that writes nothing and exits 2. */
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'build-receipt-'))
  await mkdir(path.join(root, 'src'), { recursive: true })
  await writeFile(path.join(root, 'src', 'main.js'), 'export const value = 1\n')
  await writeFile(path.join(root, 'build-ok.mjs'),
    'import { mkdirSync, writeFileSync } from "node:fs"\n'
    + 'mkdirSync("dist/assets", { recursive: true })\n'
    + 'writeFileSync("dist/assets/index-abc123.js", "console.log(1)\\n")\n'
    + 'writeFileSync("dist/index.html", "<!doctype html><script type=\\"module\\" src=\\"/assets/index-abc123.js\\"></script>")\n')
  await writeFile(path.join(root, 'build-nothing.mjs'), 'process.exit(0)\n')
  await writeFile(path.join(root, 'build-fails.mjs'), 'process.exit(2)\n')
})

after(async () => { await rm(root, { recursive: true, force: true }) })

const runStep = (args, tree = root) =>
  spawnSync(process.execPath, [STEP, '--root', tree, ...args], { cwd: tree, encoding: 'utf8', windowsHide: true })

const clearDist = () => rm(path.join(root, 'dist'), { recursive: true, force: true })

/* ------------------------------------------------------------- judgement */

const wholeArtifact = () => ({ builtAt: new Date().toISOString(), newestSource: 'src/main.js', assets: 1 })
const missingArtifact = () => { throw new Error('There is no built renderer at dist/index.html.') }

test('exit 0 and a whole artifact is the only pass', () => {
  const verdict = assessBuild({ exit: { status: 0 }, assertArtifact: wholeArtifact })
  assert.equal(verdict.ok, true)
})

test('exit 0 with nothing built is refused, and the refusal names the artifact', () => {
  const verdict = assessBuild({ exit: { status: 0 }, assertArtifact: missingArtifact })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.ruleClass, BUILD_RULE_CLASS.artifactAbsent)
})

test("the build tool's own non-zero exit is refused even when an artifact is there", () => {
  /* The measured case: a stale dist/ from an earlier run sits on disk while the
     build that was just asked for exited 2. */
  const verdict = assessBuild({ exit: { status: 2 }, assertArtifact: wholeArtifact })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.ruleClass, BUILD_RULE_CLASS.exitNonZero)
  assert.match(verdict.message, /exited 2/)
})

test('an exit code that was never observed is its own answer, not a pass', () => {
  for (const exit of [{ error: new Error('spawn npm ENOENT') }, { signal: 'SIGKILL' }, { status: null }, {}]) {
    const verdict = assessBuild({ exit, assertArtifact: wholeArtifact })
    assert.equal(verdict.ok, false)
    assert.equal(verdict.ruleClass, BUILD_RULE_CLASS.exitUnknown)
  }
})

test('a wrapper exit code cannot be passed off as the build tool exit code', () => {
  /* assessBuild takes the build tool's own exit only. Handing it the shell's
     status is exactly the 1.0.45 defect, so the artifact half still has to
     hold before anything passes. */
  const verdict = assessBuild({ exit: { status: 0, observedThrough: 'shell' }, assertArtifact: missingArtifact })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.ruleClass, BUILD_RULE_CLASS.artifactAbsent)
})

/* ---------------------------------------------------------- end to end */

test('a real build that writes a renderer passes and records its receipt', async () => {
  await clearDist()
  const result = runStep(['--command', 'node build-ok.mjs'])
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const receipt = JSON.parse(await readFile(path.join(root, 'release', 'build-receipt.json'), 'utf8'))
  assert.equal(receipt.status, 0)
  assert.equal(receipt.verdict, 'built')
  assert.equal(receipt.observedThrough, 'direct')
})

test('a real build that exits 0 and builds nothing REFUSES, naming the artifact', async () => {
  await clearDist()
  const result = runStep(['--command', 'node build-nothing.mjs'])
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stderr, /\[artifact-absent\]/)
  const receipt = JSON.parse(await readFile(path.join(root, 'release', 'build-receipt.json'), 'utf8'))
  assert.equal(receipt.status, 0, 'the build tool really did exit 0; that is the whole point')
  assert.equal(receipt.verdict, BUILD_RULE_CLASS.artifactAbsent)
})

test("a real build that fails REFUSES naming the build tool's exit", async () => {
  await clearDist()
  runStep(['--command', 'node build-ok.mjs'])
  const result = runStep(['--command', 'node build-fails.mjs'])
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stderr, /\[build-exit-nonzero\]/)
  assert.match(result.stderr, /exited 2/)
})

test('--verify re-measures the artifact now, so a recorded pass cannot outlive it', async () => {
  await clearDist()
  assert.equal(runStep(['--command', 'node build-ok.mjs']).status, 0)
  assert.equal(runStep(['--verify']).status, 0)
  await clearDist()
  const result = runStep(['--verify'])
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stderr, /\[artifact-absent\]/)
})

test('--verify without a receipt says the exit code was never recorded', async () => {
  const bare = await mkdtemp(path.join(os.tmpdir(), 'build-receipt-bare-'))
  try {
    const result = runStep(['--verify'], bare)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /\[build-exit-unknown\]/)
  } finally { await rm(bare, { recursive: true, force: true }) }
})

test('arguments are read exactly, and an unknown one is refused', () => {
  assert.equal(parseArgs(['--command', 'npm run build', '--artifact', 'dist']).command, 'npm run build')
  assert.equal(parseArgs(['--verify']).verify, true)
  assert.throws(() => parseArgs(['--nonsense']), /unknown argument/)
  assert.throws(() => parseArgs(['--command']), /needs a value/)
})

test('the pre-cut build check judges the build through this step, not the exit code alone', async () => {
  /* A guard nothing calls is the defect it was written for. The pre-cut check
     ran `npm run build` and asserted its status only -- the exact half-
     measurement that reported two 1.0.45 builds as successful. */
  const source = await readFile(path.join(REPO_ROOT, 'tools', 'precut-committed-bytes-check.mjs'), 'utf8')
  assert.match(source, /import \{ assessBuild \} from '\.\/build-receipt\.mjs'/)
  assert.match(source, /assessBuild\(\{ exit:/)
  assert.doesNotMatch(source, /assert\.equal\(built\.status, 0/)
})
