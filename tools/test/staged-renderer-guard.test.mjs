// EVERY HARNESS THAT STAGES dist/ REFUSES TO MEASURE A STALE OR TORN RENDERER.
//
// THE MEASUREMENT DEFECT THIS IS ABOUT, in one sentence: on 2026-08-12 a harness
// staged dist/ and drove a bundle compiled EIGHT MINUTES BEFORE the fix it was
// testing existed, and reported the fix as failing. The wasted run is not the
// danger -- the danger is that "your fix does not work", with an apparent
// measurement behind it, gets a correct change REVERTED.
//
// tools/lib/staged-renderer.mjs is the guard. This file is the RULE, in the same
// shape as tools/test/electron-run-as-node-harness-guard.test.mjs: a per-file
// test only proves the file it names and cannot notice a harness that does not
// exist yet, so the set of dist/-staging harnesses is DERIVED from the tree and
// every member must call the guard.
//
// Two halves, and both are needed:
//   1. THE RULE. Derive the stagers, require the guard in each. Fail closed:
//      finding zero stagers, or losing one of the pinned ones, is a failure.
//   2. THE GUARD ITSELF, proven against fixtures -- stale, missing bundle,
//      zero-byte bundle, healthy -- and proven to EXIT 2 rather than throw a
//      verdict, because the exit code is the whole of what tells a caller
//      "the harness could not run" apart from "the product is broken".

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { assertRendererMeasurable, assertStagedRendererConsistent, RendererStagingRefusal }
  from '../lib/staged-renderer.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const TOOLS = path.join(REPO_ROOT, 'tools')
const GUARD_MODULE = 'lib/staged-renderer.mjs'

/* THE HARNESSES MEASURED TO STAGE dist/ ON THE DAY THIS WAS WRITTEN.
   Pinned so that a detector which silently stops detecting fails here instead
   of going quietly green -- the same anchoring the ELECTRON_RUN_AS_NODE guard
   uses. If one is renamed, update this list in the same commit; that edit is
   the point, because it forces the rename to be seen. */
const PINNED_STAGERS = [
  'a11y-keyboard-qa.mjs',
  'agent-route-reachability.mjs',
  'agent-start-flow-qa.mjs',
  'agent-subpage-qa.mjs',
  'chatbox-settings-qa.mjs',
  'checkout-privacy-packaged-qa.mjs',
  'example-page-write-fence-qa.mjs',
  'first-run-contract-qa.mjs',
  'first-run-recovery-qa.mjs',
  'google-signin-live-qa.mjs',
  'google-signin-packaged-qa.mjs',
  'guided-permissions-qa.mjs',
  'loop-packaged-qa.mjs',
  'offline-routes-qa.mjs',
  'onboarding-doc-qa.mjs',
  'owner-account-live-wire-in.mjs',
  'owner-account-packaged-qa.mjs',
  'page2-native-audit.cjs',
  'performance-budget-qa.mjs',
  'recommended-path-packaged-qa.mjs',
  'refusal-copy-qa.mjs',
  'setup-deadend-recommended-qa.mjs',
  'setup-walkthrough-qa.mjs',
  'stranger-onboarding-qa.mjs',
  'team-panel-packaged-qa.mjs',
  'test-account-harness.mjs',
  'window-size-sweep-qa.mjs',
]

/* Comment lines are removed before detection, for the same reason the
   ELECTRON_RUN_AS_NODE guard removes them: prose about staging dist/ (and this
   repo's harnesses are full of it) is not staging dist/, and prose about the
   guard is not calling the guard. */
function withoutCommentLines(source) {
  return source.split('\n').filter(line => {
    const trimmed = line.trim()
    return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'))
  }).join('\n')
}

/* WHAT COUNTS AS STAGING dist/: a copy call whose SOURCE is this tree's dist/.
   Both shapes in use here are covered --
     a) the loop:  for (const directory of ['dist', 'shell']) { ... cpSync(from, ...) }
     b) direct:    cpSync(path.join(REPO_ROOT, 'dist'), target, ...)
   Serving dist/ over a static server (tools/page2-qa.cjs and friends) is a
   different hazard and is deliberately not in scope here: those never copy, so
   they cannot take a torn copy, and they are named in the module header rather
   than silently folded in. */
function stagesDist(source) {
  const code = withoutCommentLines(source)
  const loop = /for \(const \w+ of [^)]*\['dist'/.test(code)
    && /cpSync\(|copyFileSync\(|cp\(/.test(code)
  const direct = /cpSync\(\s*path\.(?:join|resolve)\([^)]*['"]dist['"]\s*\)/.test(code)
  return loop || direct
}

function callsTheGuard(source) {
  const code = withoutCommentLines(source)
  return {
    imports: code.includes(GUARD_MODULE),
    current: /assertRendererMeasurable\s*\(/.test(code),
    consistent: /assertStagedRendererConsistent\s*\(/.test(code),
  }
}

function harnessFiles() {
  return readdirSync(TOOLS, { withFileTypes: true })
    .filter(entry => entry.isFile() && /\.(mjs|cjs)$/.test(entry.name))
    .map(entry => entry.name)
    .sort()
}

function stagers() {
  const found = []
  for (const name of harnessFiles()) {
    const source = readFileSync(path.join(TOOLS, name), 'utf8')
    if (stagesDist(source)) found.push({ name, ...callsTheGuard(source) })
  }
  return found
}

test('the scan reads real harnesses (a vacuous pass is not a pass)', () => {
  const files = harnessFiles()
  assert.ok(files.length > 20, `only ${files.length} harness files found in tools/ -- this guard would pass while checking nothing`)
  assert.ok(stagers().length > 0, 'no harness in tools/ was detected as staging dist/, so this rule is policing nothing')
})

test('every harness measured to stage dist/ is still detected', () => {
  const detected = new Set(stagers().map(entry => entry.name))
  const missing = PINNED_STAGERS.filter(name => !detected.has(name))
  assert.deepEqual(missing, [],
    `these were measured to stage dist/ and the detector no longer sees them: ${missing.join(', ')}. `
    + 'A detector that has lost a file leaves that harness free to publish a verdict about a stale bundle.')
})

test('every harness that stages dist/ refuses a stale or torn renderer', () => {
  const offenders = stagers()
    .filter(entry => !(entry.imports && entry.current && entry.consistent))
    .map(entry => `${entry.name} (${[
      entry.imports ? null : 'no import',
      entry.current ? null : 'no assertRendererMeasurable',
      entry.consistent ? null : 'no assertStagedRendererConsistent',
    ].filter(Boolean).join(', ')})`)
  assert.deepEqual(offenders, [],
    `These harnesses stage dist/ without the guard: ${offenders.join('; ')}.\n`
    + 'A harness that stages dist/ can drive a bundle older than the fix it is testing and report '
    + 'the fix as failing -- which gets a correct change reverted. It can also take a copy mid-build, '
    + 'whose index.html names a bundle that is not beside it: the shell serves index.html with a '
    + 'text/html type, the browser refuses the module on the MIME check, and the window paints a '
    + 'title, a settings drawer, an empty stage and NO exception -- indistinguishable from "the page '
    + 'does not exist".\n'
    + `Fix: import { assertRendererMeasurable, assertStagedRendererConsistent } from './${GUARD_MODULE}', `
    + 'call the first at the top of stage() and the second on the staged copy. Do not reimplement it.')
})

/* ---------- the guard itself, against fixtures ----------
 *
 * Everything above measures the tree as it is today and would go green if the
 * guard silently stopped guarding. These pin the DISCRIMINATION. */

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'staged-renderer-guard-'))
  const dist = path.join(root, 'dist')
  const assets = path.join(dist, 'assets')
  const src = path.join(root, 'src')
  mkdirSync(assets, { recursive: true })
  mkdirSync(src, { recursive: true })
  writeFileSync(path.join(src, 'views.js'), 'export const x = 1\n')
  writeFileSync(path.join(assets, 'index-a1b2c3d4.js'), 'console.log(1)\n')
  writeFileSync(path.join(dist, 'index.html'),
    '<!doctype html><html><head><script type="module" crossorigin src="/assets/index-a1b2c3d4.js"></script>'
    + '</head><body><main id="stage"></main></body></html>\n')
  /* The source is deliberately OLDER than the build, which is the healthy state. */
  const older = new Date(Date.now() - 60_000)
  utimesSync(path.join(src, 'views.js'), older, older)
  return { root, dist, src }
}

test('a healthy tree is measured, not refused', () => {
  const { root, dist } = fixture()
  try {
    const facts = assertRendererMeasurable({ repoRoot: root, sourceDist: dist, onRefusal: 'throw' })
    assert.equal(facts.assets, 1)
    assert.equal(facts.newestSource, path.join('src', 'views.js'))
    assert.equal(assertStagedRendererConsistent({ stagedDist: dist, onRefusal: 'throw' }).assets, 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a source file newer than the bundle is refused, with BOTH timestamps', () => {
  const { root, dist, src } = fixture()
  try {
    const later = new Date(Date.now() + 60_000)
    utimesSync(path.join(src, 'views.js'), later, later)
    assert.throws(
      () => assertRendererMeasurable({ repoRoot: root, sourceDist: dist, onRefusal: 'throw' }),
      error => {
        assert.ok(error instanceof RendererStagingRefusal, 'a stale bundle must refuse as a HARNESS problem')
        assert.match(error.message, /HARNESS REFUSAL/)
        assert.match(error.message, /views\.js changed at \d{4}-/, 'the refusal must name the source file and when it changed')
        assert.match(error.message, /index\.html was built at \d{4}-/, 'the refusal must name when the bundle was built')
        assert.match(error.message, /npm run build/, 'the refusal must carry the instruction that fixes it')
        return true
      },
    )
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('an index.html naming a bundle that is not beside it is refused, and the silent symptom is named', () => {
  // THE MID-BUILD COPY. vite writes a fresh index.html naming a content-hashed
  // bundle and deletes the previous one, so a copy taken mid-build names a file
  // that never arrived. Left undetected this paints an empty stage with no
  // exception, which reads as "the page does not exist".
  const { root, dist } = fixture()
  try {
    rmSync(path.join(dist, 'assets', 'index-a1b2c3d4.js'))
    assert.throws(
      () => assertStagedRendererConsistent({ stagedDist: dist, onRefusal: 'throw' }),
      error => {
        assert.match(error.message, /HARNESS REFUSAL/)
        assert.match(error.message, /index-a1b2c3d4\.js/, 'the refusal must name the file that is missing')
        assert.match(error.message, /MIME check/, 'the refusal must name the symptom, so it is recognised on the glass next time')
        assert.match(error.message, /empty stage and no exception/i)
        return true
      },
    )
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a bundle caught mid-write at zero bytes is refused too', () => {
  // Present, named, and empty: the copy raced the write rather than the rename.
  // An existence check alone passes this and the page is just as blank.
  const { root, dist } = fixture()
  try {
    writeFileSync(path.join(dist, 'assets', 'index-a1b2c3d4.js'), '')
    assert.throws(
      () => assertStagedRendererConsistent({ stagedDist: dist, onRefusal: 'throw' }),
      error => {
        assert.match(error.message, /ZERO BYTES/)
        return true
      },
    )
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('an index.html that references no built asset at all is refused', () => {
  const { root, dist } = fixture()
  try {
    writeFileSync(path.join(dist, 'index.html'), '<!doctype html><html><body></body></html>\n')
    assert.throws(
      () => assertRendererMeasurable({ repoRoot: root, sourceDist: dist, onRefusal: 'throw' }),
      RendererStagingRefusal,
    )
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('an index.html that exists but cannot be read is a harness refusal, not an uncaught filesystem error', () => {
  const { root, dist } = fixture()
  try {
    rmSync(path.join(dist, 'index.html'))
    mkdirSync(path.join(dist, 'index.html'))
    assert.throws(
      () => assertStagedRendererConsistent({ stagedDist: dist, onRefusal: 'throw' }),
      error => {
        assert.ok(error instanceof RendererStagingRefusal)
        assert.match(error.message, /index\.html could not be read/)
        assert.match(error.message, /HARNESS REFUSAL/)
        return true
      },
    )
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('the refusal EXITS 2 and says HARNESS REFUSAL, rather than failing like a verdict', () => {
  // The exit code is the load-bearing part: 1 means "an assertion about the
  // product failed", and that is the sentence that gets a correct fix reverted.
  // Proven in a child process, because process.exit cannot be observed in-process.
  const { root, dist, src } = fixture()
  try {
    const later = new Date(Date.now() + 60_000)
    utimesSync(path.join(src, 'views.js'), later, later)
    const guard = path.join(REPO_ROOT, 'tools', 'lib', 'staged-renderer.mjs').split(path.sep).join('/')
    const script = `import { assertRendererMeasurable } from ${JSON.stringify(`file:///${guard}`)}\n`
      + `assertRendererMeasurable({ repoRoot: ${JSON.stringify(root)}, sourceDist: ${JSON.stringify(dist)} })\n`
      + 'console.log("REACHED THE CODE AFTER THE GUARD")\n'
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8' })
    assert.equal(result.status, 2,
      `a stale renderer must exit 2 (the harness could not run), not ${result.status}. stderr: ${result.stderr}`)
    assert.match(result.stderr, /HARNESS REFUSAL/)
    assert.ok(!result.stdout.includes('REACHED THE CODE AFTER THE GUARD'),
      'the guard let the harness carry on and measure the stale bundle anyway')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
