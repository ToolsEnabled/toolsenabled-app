import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const require_ = createRequire(import.meta.url)
const { readComposeLayoutCss, selectCssEntry } = require_('../lib/compose-layout-css.cjs')

test('compose layout CSS selection refuses ambiguity and prefers the packaged primary sheet', () => {
  assert.equal(selectCssEntry(['/dist/assets/index-abcd.css']), 'dist/assets/index-abcd.css')
  assert.equal(selectCssEntry(['/dist/assets/chunk.css', '/dist/assets/index-abcd.css']), 'dist/assets/index-abcd.css')
  assert.throws(() => selectCssEntry(['/dist/assets/index-a.css', '/dist/assets/index-b.css']), /2 unambiguous/)
  assert.throws(() => selectCssEntry(['/dist/assets/app.js']), /0 unambiguous/)
})

test('an explicit compose layout release reads only that candidate app.asar', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'compose-layout-css-'))
  try {
    const repo = path.join(root, 'repo')
    const release = path.join(root, 'candidate')
    mkdirSync(path.join(repo, 'dist', 'assets'), { recursive: true })
    mkdirSync(path.join(release, 'resources'), { recursive: true })
    writeFileSync(path.join(repo, 'dist', 'assets', 'index-source.css'), '.source{}')
    const archive = path.join(release, 'resources', 'app.asar')
    writeFileSync(archive, 'fixture archive')
    const seen = []
    const asarApi = {
      listPackage(file) { seen.push(['list', file]); return ['/dist/assets/index-candidate.css'] },
      extractFile(file, entry) { seen.push(['extract', file, entry]); return Buffer.from('.candidate{}') },
    }
    for (const argv of [
      ['electron', 'driver', '--release', release],
      ['electron', 'driver', `--release=${release}`],
    ]) {
      const result = readComposeLayoutCss({ argv, repoRoot: repo, asarApi })
      assert.equal(result.mode, 'exact-release')
      assert.equal(result.css, '.candidate{}')
      assert.equal(result.origin, archive)
      assert.equal(result.entry, 'dist/assets/index-candidate.css')
    }
    assert.equal(seen.every(call => call[1] === archive), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('compose layout keeps checkout CSS only when no release was requested', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'compose-layout-source-css-'))
  try {
    mkdirSync(path.join(root, 'dist', 'assets'), { recursive: true })
    writeFileSync(path.join(root, 'dist', 'assets', 'index-source.css'), '.source{}')
    const asarApi = {
      listPackage() { assert.fail('an unbound source fixture must not claim a candidate archive') },
      extractFile() { assert.fail('an unbound source fixture must not claim candidate bytes') },
    }
    const result = readComposeLayoutCss({ argv: ['electron', 'driver'], repoRoot: root, asarApi })
    assert.equal(result.mode, 'source-overlay')
    assert.equal(result.css, '.source{}')
    assert.equal(result.origin, path.join(root, 'dist', 'assets', 'index-source.css'))
    assert.equal(result.release, undefined, 'checkout CSS is not a bound release')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('missing or ambiguous requested compose candidates refuse instead of using valid checkout CSS', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'compose-layout-refusals-'))
  try {
    const repo = path.join(root, 'repo')
    const release = path.join(root, 'candidate')
    mkdirSync(path.join(repo, 'dist', 'assets'), { recursive: true })
    writeFileSync(path.join(repo, 'dist', 'assets', 'index-source.css'), '.source{}')
    const archive = path.join(release, 'resources', 'app.asar')
    let entries = []
    const seen = []
    const asarApi = {
      listPackage(file) { seen.push(['list', file]); return entries },
      extractFile(file) { seen.push(['extract', file]); throw new Error('candidate stylesheet is unreadable') },
    }
    const read = argv => readComposeLayoutCss({ argv, repoRoot: repo, asarApi })
    const argv = ['electron', 'driver', '--release', release]

    assert.throws(() => read(['electron', 'driver', '--release']), /requires a directory/)
    assert.throws(() => read(['electron', 'driver', '--release=']), /requires a directory/)
    assert.throws(() => read(argv), /no packaged app archive/)
    assert.deepEqual(seen, [], 'missing candidate input cannot reach extraction or use source CSS')

    mkdirSync(path.dirname(archive), { recursive: true })
    writeFileSync(archive, 'fixture archive')
    for (const sheets of [[], ['/dist/assets/index-a.css', '/dist/assets/index-b.css']]) {
      entries = sheets
      assert.throws(() => read(argv), /unambiguous compose stylesheet candidates/)
    }
    assert.deepEqual(seen, [['list', archive], ['list', archive]],
      'ambiguous candidate input cannot be resolved by extracting a guessed sheet')

    entries = ['/dist/assets/index-candidate.css']
    assert.throws(() => read(argv), /candidate stylesheet is unreadable/,
      'an unreadable requested stylesheet must not fall back to valid checkout CSS')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
