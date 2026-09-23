import assert from 'node:assert/strict'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { ownedFixtureTempRoot } from './lib/owned-fixture-temp.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const GATE = path.join(REPO_ROOT, 'tools', 'check-plain-language.mjs')
const CLEAN_LINE = /Every visible string is either plain or a finding the baseline already accepts\./

function run(nodeArgs) {
  return spawnSync(process.execPath, nodeArgs, { cwd: REPO_ROOT, encoding: 'utf8' })
}

/* WHAT THIS PROVES: the gate's main-module guard compares FILESYSTEM IDENTITY,
   not path spelling. Invoked under a spelling that is not byte-identical to its
   own path, it must still recognise itself and RUN. A guard that compares
   strings fails to match, main() never executes, and the gate exits 0 having
   checked nothing -- a pass that means "I could not look".

   The respelling is a redundant /./ segment naming the SAME file: realpath
   collapses it, string equality does not. This runs on any platform and needs no
   privilege, unlike a symlink.

   THIS TEST DELIBERATELY TOUCHES NO REPOSITORY FILE. An earlier version proved
   the same property by renaming tools/plain-language-baseline.json aside for the
   duration of one spawn. node --test runs files CONCURRENTLY, so during that
   window any neighbour reading the baseline saw it missing:
   plain-language.test.mjs failed on "no string a person reads is denser than the
   baseline already accepts" while passing when run alone. A test that mutates
   shared repository state does not fail by itself -- it fails whichever
   neighbour happens to be running beside it. */
test('check-plain-language runs for the same file through a redundant path spelling', () => {
  const respelled = `${path.dirname(GATE).replaceAll(path.sep, '/')}/./${path.basename(GATE)}`
  const respelledRun = run([
    '--import',
    `data:text/javascript,${encodeURIComponent(`process.argv[1] = ${JSON.stringify(respelled)}`)}`,
    GATE,
  ])

  assert.match(
    respelledRun.stdout,
    CLEAN_LINE,
    'the same gate respelled with a redundant /./ segment must execute main() and report its own result, '
      + `not exit silently having checked nothing:\n${respelledRun.stdout}${respelledRun.stderr}`,
  )
  assert.equal(respelledRun.status, 0, `gate output:\n${respelledRun.stdout}${respelledRun.stderr}`)
})

test('check-plain-language passes against the current repository', () => {
  const healthy = run([GATE])
  assert.equal(healthy.status, 0, `gate output:\n${healthy.stdout}${healthy.stderr}`)
  assert.match(healthy.stdout, CLEAN_LINE)
})

// Real CLI and real rule dependencies, in an owned fixture. Only the existing
// baseline identities for the copied support modules are accepted; release-note
// controls never enter a baseline. TOOLSENABLED_TEST_RETAIN_FIXTURES=1 keeps
// these fixtures for failure inspection, as the other suites here do.
function releaseNotesFixture(t, notes = { 'RELEASE-NOTES-1.0.45.md': 'Your work stays on your computer.' }) {
  const root = mkdtempSync(path.join(ownedFixtureTempRoot(), 'plain language release notes '))
  t.after(() => {
    if (process.env.TOOLSENABLED_TEST_RETAIN_FIXTURES === '1') t.diagnostic(`RETAINED_RELEASE_NOTES_FIXTURE ${root}`)
    else rmSync(root, { recursive: true, force: true })
  })
  const support = ['src/refusal-copy.js', 'src/subscription-availability.js', 'src/terminal-name.js']
  for (const relative of ['package.json', 'tools/check-plain-language.mjs', 'tools/check-github-claims.mjs',
    'tools/check-product-naming.mjs', 'tools/lib/user-visible-strings.mjs', ...support]) {
    const target = path.join(root, relative)
    mkdirSync(path.dirname(target), { recursive: true })
    copyFileSync(path.join(REPO_ROOT, relative), target)
  }
  mkdirSync(path.join(root, 'src', 'views'), { recursive: true })
  mkdirSync(path.join(root, 'shell'), { recursive: true })
  for (const name of ['agent-notifications.cjs', 'account-registry.cjs', 'provider-login.cjs']) {
    writeFileSync(path.join(root, 'shell', name), "module.exports = 'Open Settings to try again.'\n")
  }
  const baseline = JSON.parse(readFileSync(path.join(REPO_ROOT, 'tools', 'plain-language-baseline.json'), 'utf8'))
  writeFileSync(path.join(root, 'tools', 'plain-language-baseline.json'), JSON.stringify({
    accepted: baseline.accepted.filter(identity => support.includes(identity.split('\t')[0])),
  }))
  mkdirSync(path.join(root, 'docs'), { recursive: true })
  for (const [name, words] of Object.entries(notes)) writeFileSync(path.join(root, 'docs', name), words)
  const gate = path.join(root, 'tools', 'check-plain-language.mjs')
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

function plainResult(result, expected, message) {
  assert.ifError(result.error)
  assert.equal(result.status, expected, `${message}\n${result.stdout}${result.stderr}`)
  if (expected === 0) assert.match(result.stdout, CLEAN_LINE)
}

test('release notes: all plain-language rules refuse bad prose and accept its repair', t => {
  const fixture = releaseNotesFixture(t)
  const note = path.join(fixture.root, 'docs', 'RELEASE-NOTES-1.0.45.md')
  const controls = [
    ['jargon', 'The renderer now reads the payload schema.'],
    ['identifier', 'The page shows RELEASE_NOTE_CONTROL_ERROR.'],
    ['internal-id', 'Choose hosted-relay to continue.'],
    ['dead-end', 'An error occurred.'],
    ['long-sentence', 'You can now open the page and read all of your saved work\nwhile the other people on your team continue to use their own computers at home.'],
  ]
  for (const [rule, words] of controls) {
    writeFileSync(note, words)
    const refused = fixture.run({ respelled: true })
    plainResult(refused, 1, `release-note ${rule} control must fail`)
    assert.ok(refused.stdout.includes('docs/RELEASE-NOTES-1.0.45.md'))
    assert.ok(refused.stdout.includes(`[${rule}]`), refused.stdout)
    writeFileSync(note, 'Open the page to read your saved work.\n\nYour team can keep working.')
    plainResult(fixture.run(), 0, `release-note ${rule} repair must pass`)
  }
})

test('release notes: future files join the scan and unrelated docs remain outside it', t => {
  const fixture = releaseNotesFixture(t)
  const before = fixture.run()
  plainResult(before, 0, 'clean release-note collection')
  const future = path.join(fixture.root, 'docs', 'RELEASE-NOTES-9.8.7.md')
  writeFileSync(future, 'Your saved work is ready to read.')
  const after = fixture.run()
  plainResult(after, 0, 'future release notes')
  const count = result => Number(result.stdout.match(/across (\d+) file\(s\)/)?.[1])
  assert.ok(Number.isFinite(count(before)) && count(before) > 0, before.stdout)
  assert.equal(count(after), count(before) + 1, 'a future release file must increase measured coverage')
  writeFileSync(future, 'The renderer now reads the payload.')
  plainResult(fixture.run(), 1, 'bad future release notes')
  writeFileSync(future, 'Your saved work is ready to read.')
  for (const relative of ['docs/DEVELOPER-NOTES.md', 'docs/RELEASE-NOTES-control.txt',
    'docs/archive/RELEASE-NOTES-archived.md', 'docs/RELEASE-NOTES-folder.md/README.md', 'RELEASE-NOTES-root.md']) {
    const target = path.join(fixture.root, relative)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, 'The renderer now reads the payload schema.')
  }
  const bounded = fixture.run()
  plainResult(bounded, 0, 'only top-level matching Markdown notes are added')
  assert.equal(count(bounded), count(after))
})

test('release notes: readable prose is checked without treating code examples as copy', t => {
  const fixture = releaseNotesFixture(t, { 'RELEASE-NOTES-1.0.45.md': [
    '# Changes', '', 'Open Settings to try again.', '',
    '```text', 'The renderer now reads the payload schema.', '```', '',
    'The command is `RELEASE_NOTE_CONTROL_ERROR`.',
  ].join('\r\n') })
  plainResult(fixture.run({ respelled: true }), 0, 'legitimate CRLF Markdown and code examples')
})

test('release notes: a missing collection and unreadable prose refuse setup', t => {
  const empty = releaseNotesFixture(t, {})
  const noNotes = empty.run()
  plainResult(noNotes, 2, 'missing release-note collection')
  assert.match(`${noNotes.stdout}${noNotes.stderr}`, /SETUP.*release|SETUP.*RELEASE-NOTES/i)
  const blank = releaseNotesFixture(t, { 'RELEASE-NOTES-1.0.45.md': '' })
  plainResult(blank.run(), 2, 'an empty note cannot silently escape the scan')
})
