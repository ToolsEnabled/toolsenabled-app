/* CF31 -- the packer must refuse without an owner identity profile, AND the
 * refusal must be diagnosable.
 *
 * private/owner-data-patterns.owner.json is an owner-supplied private input.
 * /private/ is gitignored, so a FRESH clone or worktree has never had it, and
 * tools/check-no-owner-data.mjs exits 2 ("could not run") rather than passing a
 * payload it has no identity to search for. tools/pack-capability-layer.mjs
 * then refuses the whole pack. That refusal is correct and this file exists to
 * keep it: every case below asserts a NON-ZERO exit.
 *
 * What was not correct was the diagnosis. The packer named the missing path
 * only by forwarding the child guard's stderr, and its own remedy sentence was
 * "Fix the guard's setup and re-run", which names no file and points nowhere.
 * The packer's own `|| \`... exited N without a message.\`` fallback proves the
 * child may say nothing at all -- and in that case the refusal named no file,
 * no cause and no remedy, leaving the next engineer to guess. The silent-guard
 * case below covers exactly that.
 *
 * These tests DELIBERATELY OMIT private/owner-data-patterns.owner.json from
 * their fixture. They therefore need no owner data of any kind, create none,
 * and -- unlike capability-index-pack-gate.test.mjs, which copies the real
 * owner file into its fixture and skips without it -- they run unskipped in a
 * fresh worktree, which is the very condition CF31 is about.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const OWNER_PATTERNS = 'private/owner-data-patterns.owner.json'
const MARKER = 'UNSHIPPABLE-OWNER-DATA.txt'

const created = []
after(() => {
  for (const root of created) rmSync(root, { recursive: true, force: true })
})

function put(root, relative, bytes) {
  const target = path.join(root, relative)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, bytes)
}

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr || result.error?.message}`)
  return result.stdout.trim()
}

/* A minimal app root plus a minimal capability source, built so the packer gets
 * all the way to the owner-data guard. Everything here is fixture data: the
 * source contains one comment-only entrypoint and a stand-in index builder, so
 * nothing in this file can execute an agent, a provider or the real engine.
 *
 * The ONE thing the fixture app does not contain is the owner identity profile.
 * That absence is the subject under test.
 */
function fixture({ silentGuard = false } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pack-owner-profile-'))
  created.push(root)
  const app = path.join(root, 'app')
  const source = path.join(root, 'engine')
  const out = path.join(root, 'staged')

  const appFiles = [
    'package.json',
    'tools/pack-capability-layer.mjs',
    'tools/lib/capability-source-git.mjs',
    'tools/lib/capability-index-check.mjs',
    'tools/lib/provider-runtime-payload.mjs',
    'tools/lib/sterile-launch.cjs',
    'shell/install-profile-guard.cjs',
    'shell/capability-path-environment.cjs',
    'capability-defaults/config/agent-org.json',
  ]
  for (const relative of appFiles) put(app, relative, readFileSync(path.join(APP, relative)))

  /* The real guard, unless the case under test needs a guard that fails without
   * explaining itself. Copying the real one matters: a fixture app MISSING the
   * guard script would make Node exit 1, which runOwnerDataGuard reads as "the
   * scan ran and found offenders" -- a different branch than the one here. */
  put(app, 'tools/check-no-owner-data.mjs',
    silentGuard ? 'process.exitCode = 2\n' : readFileSync(path.join(APP, 'tools/check-no-owner-data.mjs')))

  put(app, 'tools/capability-manifest.json', JSON.stringify({
    entrypoints: ['tools/mission-bridge.js'],
    hostModules: [], spawnedPrograms: [], helperPrograms: [], dynamicRequires: [],
    dataFiles: ['config/capability-index.json'],
    neutralDefaults: ['config/agent-org.json', 'config/managed-processes.json'],
  }))
  put(app, 'capability-defaults/config/managed-processes.json', JSON.stringify({
    processes: { fixture: { entryPoint: '', entryPattern: '' } },
  }))

  put(source, 'tools/mission-bridge.js', '// fixture entrypoint\n')
  put(source, 'config/agent-org.example.json',
    readFileSync(path.join(app, 'capability-defaults/config/agent-org.json')))
  put(source, 'config/capability-index.json', `${JSON.stringify({ N: 3, docs: [] }, null, 2)}\n`)
  // Stand-in for the engine's index builder: prints the one line the checker
  // looks for and writes nothing, so the source tree stays clean for the
  // packer's post-staging re-binding check.
  put(source, 'tools/build-capability-index.js', [
    'const flag = process.argv.indexOf("--out");',
    'const out = flag >= 0 ? process.argv[flag + 1] : "";',
    'process.stdout.write(`CURRENT -- ${out} matches the 3-tool registry.\\n`);',
    '',
  ].join('\n'))

  git(source, 'init', '--initial-branch=main')
  git(source, 'config', 'user.email', 'fixture@example.test')
  git(source, 'config', 'user.name', 'Owner Profile Refusal Fixture')
  git(source, 'add', '--all')
  git(source, 'commit', '--no-gpg-sign', '-m', 'owner profile refusal fixture')

  assert.equal(existsSync(path.join(app, OWNER_PATTERNS)), false,
    'the fixture must not contain an owner identity profile -- that absence is the subject under test')

  return { app, source, out, sourceRef: git(source, 'rev-parse', 'HEAD') }
}

function pack(made, ...extraArgs) {
  const env = { ...process.env }
  for (const name of Object.keys(env)) {
    if (/^(TOOLSENABLED_SOURCE|TOOLSENABLED_SOURCE_REF|MC_CANONICAL_ROOT)$/i.test(name)) delete env[name]
  }
  const result = spawnSync(process.execPath, [
    path.join(made.app, 'tools/pack-capability-layer.mjs'),
    '--source', made.source, '--source-ref', made.sourceRef, '--out', made.out, '--quiet', ...extraArgs,
  ], { cwd: made.app, env, encoding: 'utf8', windowsHide: true, timeout: 120000 })
  assert.equal(result.error, undefined, String(result.error))
  return result
}

/* Proves the run reached the intended branch. Without this a fixture that broke
 * on an EARLIER precondition would still exit non-zero and the refusal
 * assertions would be measuring the wrong refusal. */
function reachedGuardBranch(result) {
  assert.match(result.stderr, /Owner-data guard COULD NOT RUN/,
    `pack did not reach the owner-data guard branch. stderr was:\n${result.stderr}`)
}

test('the packer refuses to pack when the owner identity profile is absent', () => {
  const made = fixture()
  const result = pack(made)
  reachedGuardBranch(result)
  assert.notEqual(result.status, 0, 'a pack with no owner identity profile must fail closed')
  assert.equal(result.status, 1)
  assert.equal(existsSync(path.join(made.out, MARKER)), true, 'the staged payload must be marked unshippable')
})

test('the refusal names the missing owner profile path', () => {
  const result = pack(fixture())
  reachedGuardBranch(result)
  assert.notEqual(result.status, 0)
  assert.ok(result.stderr.includes(OWNER_PATTERNS),
    `the refusal must name ${OWNER_PATTERNS}. stderr was:\n${result.stderr}`)
})

/* THE CASE THAT BITES. The packer's own fallback text ("exited N without a
 * message") admits the child guard may explain nothing. When it does not, the
 * packer must still name the file itself rather than emitting a bare non-zero
 * exit the reader cannot act on. */
test('the refusal names the missing owner profile even when the guard itself says nothing', () => {
  const made = fixture({ silentGuard: true })
  const result = pack(made)
  reachedGuardBranch(result)
  assert.notEqual(result.status, 0, 'a silent guard must still fail closed')
  assert.match(result.stderr, /without a message/,
    'this case is only meaningful while the child guard is contributing no explanation')
  assert.ok(result.stderr.includes(OWNER_PATTERNS),
    `the packer must name ${OWNER_PATTERNS} from its own check, not only by forwarding the ` +
    `child guard's stderr. stderr was:\n${result.stderr}`)
})

test('the refusal says the profile is owner-supplied, deliberately uncommitted, and how to proceed', () => {
  const result = pack(fixture())
  reachedGuardBranch(result)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /OWNER-SUPPLIED PRIVATE INPUT/,
    'the refusal must say the file is owner-supplied')
  assert.match(result.stderr, /deliberately\s+NOT committed/,
    'the refusal must say the absence is by design, not a broken checkout')
  assert.match(result.stderr, /gitignored/,
    'the refusal must explain WHY a fresh checkout never has it')
  assert.ok(result.stderr.includes('config/owner-data-patterns.example.json'),
    'the refusal must name the committed template to copy')
  assert.ok(result.stderr.includes('docs/REPRODUCIBLE-BUILD.md'),
    'the refusal must point at the documented remedy')
})

/* The fence, restated as a test: the escape hatch for KNOWN owner data must not
 * become an escape hatch for an UNSCANNED payload. */
test('--allow-owner-data does not bypass the refusal when the profile is absent', () => {
  const made = fixture()
  const result = pack(made, '--allow-owner-data')
  reachedGuardBranch(result)
  assert.notEqual(result.status, 0, '--allow-owner-data must not turn an unscanned payload into a shippable one')
  assert.equal(result.status, 1)
  assert.equal(existsSync(path.join(made.out, MARKER)), true)
  assert.match(readFileSync(path.join(made.out, MARKER), 'utf8'), /Unchecked is not clean/)
})
