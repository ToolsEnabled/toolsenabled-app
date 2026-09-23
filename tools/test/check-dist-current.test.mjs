/* The gate for the stale-dist hole, asserted by reproducing the real failure.
 *
 * Run: node --test tools/test/check-dist-current.test.mjs
 *
 * TODAY'S CASE, which every other gate passed: a dist/ built at 05:58 from base
 * 4ba0ceac was packaged after the branch was rebased onto 8d89678e at 10:44. The
 * bundle predated two commits it claimed to contain, check-renderer-payload,
 * check-payload-current, check-payload-boundary, check-artifact-private and
 * check-no-owner-data all passed, and the artefact sealed cleanly -- because each
 * of those asks whether the bytes are self-consistent, not whether they match the
 * source. A person reading two timestamps caught it.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync, readFileSync, utimesSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ownedFixtureTempRoot } from './lib/owned-fixture-temp.mjs'

import { checkDistCurrent, recordDistSource } from '../check-dist-current.mjs'

let repo

/* A real git repo, because the check reads real tracked content through
   `git ls-files -s`. A fixture that stubbed git would prove nothing about the
   thing under test. */
function git(args, root = repo) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
}

function rendererFixture(t) {
  const root = mkdtempSync(path.join(ownedFixtureTempRoot(), 'dist-renderer-inputs-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const put = (relative, contents) => {
    const target = path.join(root, relative)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, contents)
  }
  const commit = message => {
    git(['add', '--', '.'], root)
    git(['commit', '--quiet', '-m', message], root)
    assert.equal(git(['status', '--porcelain'], root), '', 'control: the source commit is clean')
  }
  git(['init', '--quiet'], root)
  git(['config', 'user.email', 'fixture@example.com'], root)
  git(['config', 'user.name', 'fixture'], root)
  put('.gitignore', 'dist/\nnode_modules/\n')
  put('package.json', '{"name":"renderer-input-fixture","version":"1.0.0","type":"module"}\n')
  put('index.html', '<!doctype html><script src="/durable-storage.js"></script><script type="module" src="/src/main.js"></script>\n')
  put('src/main.js', 'document.body.dataset.buildSource = __BUILD_SOURCE__\n')
  put('public/durable-storage.js', 'globalThis.settingsBridgeVersion = "before"\n')
  put('vite.config.mjs', 'export default { define: { __BUILD_SOURCE__: JSON.stringify("before") } }\n')
  commit('initial renderer')
  const dist = path.join(root, 'dist')
  const build = () => {
    // Exercise Vite's real public-file copying and config loading. No product
    // dependencies, installer, browser, or provider is created by this fixture.
    execFileSync(process.execPath, [fileURLToPath(new URL('../../node_modules/vite/bin/vite.js', import.meta.url)),
      'build', '--logLevel', 'silent'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30_000 })
    recordDistSource(dist, { root })
  }
  build()
  return { root, dist, put, commit, build }
}

for (const change of ['edit', 'add', 'delete', 'rename']) {
  test(`a clean committed public-file ${change} invalidates the actual Vite dist`, t => {
    const made = rendererFixture(t)
    const oldCopiedScript = readFileSync(path.join(made.dist, 'durable-storage.js'), 'utf8')
    assert.match(oldCopiedScript, /"before"/)
    if (change === 'edit') made.put('public/durable-storage.js', 'globalThis.settingsBridgeVersion = "after"\n')
    if (change === 'add') made.put('public/new-runtime.js', 'globalThis.newRuntime = true\n')
    if (change === 'delete') rmSync(path.join(made.root, 'public/durable-storage.js'))
    if (change === 'rename') renameSync(path.join(made.root, 'public/durable-storage.js'), path.join(made.root, 'public/renamed-runtime.js'))
    made.commit(`public ${change} after build`)

    assert.equal(readFileSync(path.join(made.dist, 'durable-storage.js'), 'utf8'), oldCopiedScript,
      'control: the copied runtime still contains the earlier source')
    assert.throws(() => checkDistCurrent(made.dist, { root: made.root }), /built from different source/,
      'a clean source repair must not qualify an earlier copied runtime')
    made.build()
    assert.equal(checkDistCurrent(made.dist, { root: made.root }).method, 'content-marker')
  })
}

test('a clean committed Vite config change invalidates the actual renderer build', t => {
  const made = rendererFixture(t)
  made.put('vite.config.mjs', 'export default { define: { __BUILD_SOURCE__: JSON.stringify("after") } }\n')
  made.commit('change the bundled definition')
  assert.throws(() => checkDistCurrent(made.dist, { root: made.root }), /built from different source/)
  made.build()
  assert.equal(checkDistCurrent(made.dist, { root: made.root }).method, 'content-marker')
})

test('a commit outside renderer inputs does not invalidate unchanged renderer bytes', t => {
  const made = rendererFixture(t)
  made.put('docs/note.md', 'A documentation-only repair.\n')
  made.commit('document behavior')
  assert.equal(checkDistCurrent(made.dist, { root: made.root }).method, 'content-marker')
})

test('the announced mtime fallback also measures public runtime files', t => {
  const made = rendererFixture(t)
  rmSync(path.join(made.dist, '.dist-source.json'))
  const newer = new Date(Date.now() + 60_000)
  utimesSync(path.join(made.root, 'public/durable-storage.js'), newer, newer)
  assert.throws(() => checkDistCurrent(made.dist, { root: made.root }), /dist\/ is OLDER than the source/)
})

before(() => {
  repo = mkdtempSync(path.join(os.tmpdir(), 'check-dist-current-'))
  git(['init', '--quiet'])
  git(['config', 'user.email', 'fixture@example.com'])
  git(['config', 'user.name', 'fixture'])
  mkdirSync(path.join(repo, 'src'), { recursive: true })
  writeFileSync(path.join(repo, 'index.html'), '<!doctype html><body></body>\n')
  writeFileSync(path.join(repo, 'src', 'app.js'), 'export const version = 1\n')
  writeFileSync(path.join(repo, 'package.json'), '{ "name": "fixture", "version": "1.0.0" }\n')
  git(['add', '-A'])
  git(['commit', '--quiet', '-m', 'base'])
})

after(() => rmSync(repo, { recursive: true, force: true }))

function buildDist(name) {
  const dist = path.join(repo, name)
  mkdirSync(dist, { recursive: true })
  writeFileSync(path.join(dist, 'index.html'), '<!doctype html><body>built</body>\n')
  return dist
}

test('a dist built from the current source passes, and says it used the content marker', () => {
  const dist = buildDist('dist-fresh')
  recordDistSource(dist, { root: repo })

  const result = checkDistCurrent(dist, { root: repo })

  assert.equal(result.method, 'content-marker')
  assert.ok(result.trackedInputs > 0, 'the check must have seen tracked inputs')
})

/* THE RED CASE: build, then move the source on underneath it — exactly what a
   rebase does. mtimes here are NOT stale (the dist was written after the source
   files), so an mtime-only guard would pass this. The content marker catches it. */
test('a dist built before the source moved is refused BY NAME', () => {
  const dist = buildDist('dist-stale')
  recordDistSource(dist, { root: repo })

  writeFileSync(path.join(repo, 'src', 'app.js'), 'export const version = 2\n')
  git(['add', '-A'])
  git(['commit', '--quiet', '-m', 'source moved after the build'])

  assert.throws(
    () => checkDistCurrent(dist, { root: repo }),
    (error) => {
      assert.match(error.message, /REFUSING: dist\/ was built from different source/)
      assert.match(error.message, /dist was built from:/)
      assert.match(error.message, /tree is now at:/)
      return true
    },
    'a bundle built from superseded source was accepted',
  )
})

/* And it must catch the case with NO commit at all — a staged edit after the
   build — because the defect is "the bundle does not match the source", not
   "the branch moved". */
test('a staged source change after the build is also refused', () => {
  const dist = buildDist('dist-staged')
  recordDistSource(dist, { root: repo })

  writeFileSync(path.join(repo, 'src', 'app.js'), 'export const version = 3\n')
  git(['add', '-A'])

  assert.throws(() => checkDistCurrent(dist, { root: repo }), /built from different source/)
  git(['commit', '--quiet', '-m', 'settle'])
})

/* THE FALLBACK MUST ANNOUNCE ITSELF. A weaker check that reports itself is
   usable; one that looks like the strong check is not. */
test('with no marker it falls back to mtimes and SAYS so', () => {
  const dist = buildDist('dist-nomarker')

  const result = checkDistCurrent(dist, { root: repo })

  assert.equal(result.method, 'mtime-fallback', 'the fallback must name itself, not pass as a content check')
})

test('the mtime fallback still refuses a dist older than its source', () => {
  const dist = buildDist('dist-old')
  /* Age the bundle: the fallback exists for trees built before the marker, and
     this is the only signal it has. */
  const old = new Date(Date.now() - 86_400_000)
  utimesSync(path.join(dist, 'index.html'), old, old)
  writeFileSync(path.join(repo, 'src', 'app.js'), 'export const version = 4\n')

  assert.throws(() => checkDistCurrent(dist, { root: repo }), /dist\/ is OLDER than the source/)
})

test('an absent dist is refused rather than treated as nothing to check', () => {
  assert.throws(
    () => checkDistCurrent(path.join(repo, 'no-such-dist'), { root: repo }),
    /no built renderer at/,
  )
})

/* The marker records what a reader needs to act: which head, which content, when. */
test('the marker names the head, the source hash and the build time', () => {
  const dist = buildDist('dist-marker-shape')
  const record = recordDistSource(dist, { root: repo })
  const onDisk = JSON.parse(readFileSync(path.join(dist, '.dist-source.json'), 'utf8'))

  assert.equal(onDisk.schemaVersion, 1)
  assert.match(onDisk.appHead, /^[0-9a-f]{40}$/)
  assert.match(onDisk.sourceHash, /^[0-9a-f]{64}$/)
  assert.ok(Date.parse(onDisk.builtAt) > 0, 'builtAt must be a real timestamp')
  assert.equal(onDisk.sourceHash, record.sourceHash)
})
