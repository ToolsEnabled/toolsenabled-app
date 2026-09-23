import test from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { PUBLISHED_DOCUMENTS } from '../check-product-naming.mjs'
import { ownedFixtureTempRoot } from './lib/owned-fixture-temp.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const HELP_PAGE = path.join(REPO_ROOT, 'public', 'help', 'getting-started.html')

function run(script, root) {
  return spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: 'utf8',
  })
}

test('check-github-claims runs for the same file through a redundant path spelling', () => {
  const originalHelp = readFileSync(HELP_PAGE, 'utf8')
  const sourceBefore = statSync(HELP_PAGE, { bigint: true })
  const root = mkdtempSync(path.join(ownedFixtureTempRoot(), 'github-claims-'))
  const gate = path.join(root, 'tools', 'check-github-claims.mjs')
  const help = path.join(root, 'public', 'help', 'getting-started.html')

  try {
    // Exercise the unchanged CLI and its real imports without ever editing
    // the source under qualification. Interrupted tests must not leave a
    // false product claim in the next renderer build.
    for (const relative of ['tools/check-github-claims.mjs', 'tools/check-product-naming.mjs',
      'tools/lib/user-visible-strings.mjs', ...PUBLISHED_DOCUMENTS]) {
      const target = path.join(root, relative)
      mkdirSync(path.dirname(target), { recursive: true })
      copyFileSync(path.join(REPO_ROOT, relative), target)
    }
    mkdirSync(path.join(root, 'src', 'views'), { recursive: true })
    mkdirSync(path.dirname(help), { recursive: true })
    writeFileSync(path.join(root, 'src', 'main.js'), "export const label = 'Connect your GitHub account'\n")
    writeFileSync(path.join(root, 'docs', 'RELEASE-NOTES-1.0.45.md'), 'Connect your GitHub account to read your projects.\n')
    writeFileSync(help, `${originalHelp}\n<p>ToolsEnabled runs on GitHub.</p>\n`)
    const respelledGate = `${path.dirname(gate).replaceAll(path.sep, '/')}/./${path.basename(gate)}`
    const nodeArgs = ['--import', `data:text/javascript,${encodeURIComponent(`process.argv[1] = ${JSON.stringify(respelledGate)}`)}`, gate]

    const refused = spawnSync(process.execPath, nodeArgs, { cwd: root, encoding: 'utf8' })
    assert.match(
      refused.stdout,
      /A user-facing sentence claims this product uses GitHub:/,
      'the same gate respelled with a redundant /./ segment must execute main() and report the GitHub claim',
    )
    assert.match(refused.stdout, /\[runs-on-github\]/)
    assert.equal(
      refused.status,
      1,
      `the gate did not refuse the claim:\n${refused.stdout}${refused.stderr}`,
    )

    writeFileSync(help, originalHelp)
    const healthy = run(gate, root)
    assert.equal(healthy.status, 0, `the healthy fixture did not pass:\n${healthy.stdout}${healthy.stderr}`)
    assert.match(healthy.stdout, /No user-facing sentence claims this product uses, runs on or is GitHub\./)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  const sourceAfter = statSync(HELP_PAGE, { bigint: true })
  for (const field of ['dev', 'ino', 'size', 'mtimeNs']) {
    assert.equal(sourceAfter[field], sourceBefore[field], 'the gate fixture must never rewrite source under qualification')
  }
  assert.equal(readFileSync(HELP_PAGE, 'utf8'), originalHelp)
})

// TOOLSENABLED_TEST_RETAIN_FIXTURES=1 keeps these fixtures for failure
// inspection, as the other suites here do.
function releaseNotesFixture(t, notes = { 'RELEASE-NOTES-1.0.45.md': 'Your work stays on your computer.' }) {
  const root = mkdtempSync(path.join(ownedFixtureTempRoot(), 'github release notes '))
  t.after(() => {
    if (process.env.TOOLSENABLED_TEST_RETAIN_FIXTURES === '1') t.diagnostic(`RETAINED_RELEASE_NOTES_FIXTURE ${root}`)
    else rmSync(root, { recursive: true, force: true })
  })
  for (const relative of ['tools/check-github-claims.mjs', 'tools/check-product-naming.mjs',
    'tools/lib/user-visible-strings.mjs']) {
    const target = path.join(root, relative)
    mkdirSync(path.dirname(target), { recursive: true })
    copyFileSync(path.join(REPO_ROOT, relative), target)
  }
  for (const relative of PUBLISHED_DOCUMENTS) {
    const target = path.join(root, relative)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, 'The source code is published on GitHub.\n')
  }
  mkdirSync(path.join(root, 'src', 'views'), { recursive: true })
  writeFileSync(path.join(root, 'src', 'main.js'), "export const label = 'Connect your GitHub account'\n")
  mkdirSync(path.join(root, 'public', 'help'), { recursive: true })
  writeFileSync(path.join(root, 'public', 'help', 'getting-started.html'), '<p>Connect your GitHub account.</p>\n')
  for (const [name, words] of Object.entries(notes)) writeFileSync(path.join(root, 'docs', name), words)
  const gate = path.join(root, 'tools', 'check-github-claims.mjs')
  return {
    root,
    run({ respelled = false } = {}) {
      const spelling = `${path.dirname(gate).replaceAll(path.sep, '/')}/./${path.basename(gate)}`
      const args = respelled
        ? ['--import', `data:text/javascript,${encodeURIComponent(`process.argv[1] = ${JSON.stringify(spelling)}`)}`, gate]
        : [gate]
      return spawnSync(process.execPath, args, {
        cwd: path.dirname(root), encoding: 'utf8', windowsHide: true, timeout: 30_000,
      })
    },
  }
}

function githubResult(result, expected, message) {
  assert.ifError(result.error)
  assert.equal(result.status, expected, `${message}\n${result.stdout}${result.stderr}`)
  if (expected === 0) assert.match(result.stdout, /No user-facing sentence claims this product uses, runs on or is GitHub\./)
}

test('release notes: false GitHub claims fail and legitimate publication and integration pass', t => {
  const fixture = releaseNotesFixture(t)
  const note = path.join(fixture.root, 'docs', 'RELEASE-NOTES-1.0.45.md')
  for (const words of ['ToolsEnabled runs on GitHub.', 'Your work is stored on GitHub.',
    'ToolsEnabled runs\non GitHub.', 'Filekeeper is GitHub.']) {
    writeFileSync(note, words)
    const refused = fixture.run({ respelled: true })
    githubResult(refused, 1, `false release-note claim: ${words}`)
    assert.ok(refused.stdout.includes('docs/RELEASE-NOTES-1.0.45.md'), refused.stdout)
    assert.match(refused.stdout, /A user-facing sentence claims this product uses GitHub:/)
    writeFileSync(note, 'The source code is published on GitHub.\n\nConnect your GitHub account to read your projects.')
    githubResult(fixture.run(), 0, 'publication and personal-account integration remain permitted')
  }
})

test('release notes: future filenames count and only the requested docs glob is added', t => {
  const fixture = releaseNotesFixture(t)
  const before = fixture.run()
  githubResult(before, 0, 'clean collection')
  const future = path.join(fixture.root, 'docs', 'RELEASE-NOTES-9.8.7.md')
  writeFileSync(future, 'Connect your GitHub account to read your projects.')
  const after = fixture.run()
  githubResult(after, 0, 'future notes')
  const count = result => Number(result.stdout.match(/GitHub claims: (\d+) user-facing file\(s\)/)?.[1])
  assert.ok(Number.isFinite(count(before)) && count(before) > 0, before.stdout)
  assert.equal(count(after), count(before) + 1)
  writeFileSync(future, 'ToolsEnabled runs on GitHub.')
  githubResult(fixture.run(), 1, 'future false claim')
  writeFileSync(future, 'Connect your GitHub account to read your projects.')
  for (const relative of ['docs/DEVELOPER-NOTES.md', 'docs/RELEASE-NOTES-control.txt',
    'docs/archive/RELEASE-NOTES-archived.md', 'docs/RELEASE-NOTES-folder.md/README.md', 'RELEASE-NOTES-root.md']) {
    const target = path.join(fixture.root, relative)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, 'ToolsEnabled runs on GitHub.')
  }
  const bounded = fixture.run()
  githubResult(bounded, 0, 'developer documents are outside the added surface')
  assert.equal(count(bounded), count(after))
})

test('release notes: Markdown examples keep existing publication treatment on CRLF paths', t => {
  const fixture = releaseNotesFixture(t, { 'RELEASE-NOTES-1.0.45.md': [
    '# Changes', '', 'The source code is published on GitHub.', '',
    '```text', 'ToolsEnabled runs on GitHub.', '```', '',
    'The command is `github.example`.',
  ].join('\r\n') })
  githubResult(fixture.run({ respelled: true }), 0, 'CRLF prose with non-prose examples')
})

test('release notes: a missing collection is a setup refusal', t => {
  const fixture = releaseNotesFixture(t, {})
  const refused = fixture.run()
  githubResult(refused, 2, 'a missing release-note collection must not report clean')
  assert.match(`${refused.stdout}${refused.stderr}`, /SETUP.*release|SETUP.*RELEASE-NOTES/i)
})
