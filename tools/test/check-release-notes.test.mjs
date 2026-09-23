import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const GUARD = path.join(REPO_ROOT, 'tools', 'check-release-notes.mjs')
const VERSION = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version

function runGuard(notes) {
  return spawnSync(process.execPath, [GUARD, '--notes', notes], { cwd: REPO_ROOT, encoding: 'utf8' })
}

/* A note that meets the whole contract. Every mutation below starts from this, so
 * a test that goes red names one missing thing rather than a pile of them. */
function completeNotes() {
  return `# ToolsEnabled \`${VERSION}\`

*Released \`2026-09-09\`*

## Highlights

- The agent tree remembers a stopped circle's conversation when you resume it.

## Added

- A Ledger page filter for tasks that are still open.

## Changed

- Settings groups its rows under headings instead of one long list.

## Fixed

- The Messages page no longer blanks when a reply arrives while you scroll.

## Known issues

- Linux packaging is not yet qualified; the .deb is unbuilt.

## Install

[Download](https://example.invalid/ToolsEnabled-Setup.exe) - \`ToolsEnabled-Setup.exe\`

| | |
| --- | --- |
| SHA-256 | \`${'a'.repeat(64)}\` |
| Signed | no, unsigned |

## Publisher and copyright

> **ToolsEnabled**
> Published by ToolsEnabled, Inc. (in formation)
> Copyright © 2026 Joshua Pinckard
>
> ToolsEnabled was founded and created by Joshua Pinckard. The original platform was
> developed by directing autonomous AI-agent fleets through the system's own evolving
> coordination architecture.

Contributors to this release are credited in [\`CONTRIBUTORS.md\`](../CONTRIBUTORS.md).
Contributors and maintainers are never founders.
`
}

async function noteFile(t, text) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'check-release-notes-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'notes.md')
  await writeFile(file, text, 'utf8')
  return file
}

test('a note meeting the whole contract passes', async (t) => {
  const file = await noteFile(t, completeNotes())
  const result = runGuard(file)
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  assert.match(result.stdout, /Complete\./)
})

test('a missing note is a setup problem, never a pass', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'check-release-notes-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const result = runGuard(path.join(directory, 'no-such-note.md'))
  assert.equal(result.status, 2, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  assert.match(result.stderr, /Release-notes guard error: no release notes at/)
})

test('an empty note is a setup problem', async (t) => {
  const file = await noteFile(t, '   \n')
  const result = runGuard(file)
  assert.equal(result.status, 2)
  assert.match(result.stderr, /is empty/)
})

/* One mutation per rule. Each removes exactly one thing from a passing note, so a
 * failure names the rule that stopped working. */
const mutations = [
  {
    name: 'a dropped Known issues section',
    mutate: text => text.replace(/## Known issues\n\n- [^\n]*\n/, ''),
    expect: /the "Known issues" section is missing\./
  },
  {
    name: 'a Known issues heading with nothing under it',
    mutate: text => text.replace(/(## Known issues\n\n)- [^\n]*\n/, '$1'),
    expect: /"Known issues" has no entries/
  },
  {
    name: 'an unreplaced template placeholder',
    mutate: text => text.replace(/- Linux packaging[^\n]*/, '- `<what is still broken, named plainly>`'),
    expect: /template placeholder was never replaced/
  },
  {
    name: 'a title version that disagrees with package.json',
    mutate: text => text.replace(/^# ToolsEnabled `[^`]+`/m, '# ToolsEnabled `0.0.1`'),
    expect: /the title says "0\.0\.1" but package\.json says/
  },
  {
    name: 'no released date',
    mutate: text => text.replace(/^\*Released [^\n]*\n/m, ''),
    expect: /there is no "\*Released YYYY-MM-DD\*" line/
  },
  {
    /* Updated with the two-record contract: `pending` is no longer "no SHA-256", it is
     * its own state, because the fix differs. A missing digest a cutter will fill is not
     * the same problem as a digest a person has to repair. */
    name: 'a pending digest is reported as pending, not as a missing one',
    mutate: text => text.replace(new RegExp(`\`${'a'.repeat(64)}\``), '`pending`'),
    expect: /install digest pending/
  },
  {
    name: 'a digest that is neither hex nor pending is malformed, and says so',
    mutate: text => text.replace(new RegExp(`\`${'a'.repeat(64)}\``), '`to be confirmed`'),
    expect: /where a 64-character SHA-256 or the word "pending" belongs/
  },
  {
    name: 'an unfilled Signed row',
    mutate: text => text.replace(/\| Signed \| no, unsigned \|/, '| Signed | |'),
    expect: /Install has no filled "Signed" row/
  },
  {
    name: 'a reworded publisher line',
    mutate: text => text.replace(/Published by ToolsEnabled, Inc\. \(in formation\)/, 'Published by ToolsEnabled'),
    expect: /the publisher line is not the fixed wording/
  },
  {
    name: 'a reworded founding line',
    mutate: text => text.replace(/ToolsEnabled was founded and created by Joshua Pinckard\./, 'ToolsEnabled was built by a team.'),
    expect: /the founding line is missing or reworded/
  },
  {
    name: 'a dropped contributors-are-not-founders rule',
    mutate: text => text.replace(/Contributors and maintainers are never founders\.\n/, ''),
    expect: /"Contributors and maintainers are never founders\." rule is missing/
  },
  {
    name: 'a claim the company already exists',
    mutate: text => text.replace(/Published by ToolsEnabled, Inc\. \(in formation\)/, 'Published by ToolsEnabled, Inc. today'),
    expect: /ToolsEnabled, Inc\. is claimed without "\(in formation\)"/
  },
  {
    name: 'a registered-trademark symbol',
    mutate: text => text.replace(/\*\*ToolsEnabled\*\*/, '**ToolsEnabled®**'),
    expect: /registered-trademark symbol/
  },
  {
    name: 'the pre-publication checklist left attached',
    mutate: text => `${text}\n## Pre-publication checklist\n\n- [ ] npm run dist completed\n`,
    expect: /"Pre-publication checklist" section is still attached/
  }
]

for (const mutation of mutations) {
  test(`the guard catches ${mutation.name}`, async (t) => {
    const before = completeNotes()
    const after = mutation.mutate(before)
    assert.notEqual(after, before, 'the mutation changed nothing, so this test proves nothing')
    const result = runGuard(await noteFile(t, after))
    assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    assert.match(result.stderr, mutation.expect)
  })
}

/* The template's own closing parenthetical names the company twice and qualifies
 * both with one "(in formation)" between them, and the template tells the release
 * team to keep that sentence. A forward-only proximity window called the second
 * mention a false claim, so every note that followed the template was told it had
 * claimed a company that does not exist. These two pin the fix in both directions:
 * the qualified sentence passes, and an unqualified claim still fails. */
test('the incorporation parenthetical is not a false claim', async (t) => {
  const parenthetical =
    '*(Once ToolsEnabled, Inc. is incorporated, drop "(in formation)" and change the copyright\n' +
    'holder to ToolsEnabled, Inc. - see ATTRIBUTION.md.)*'
  const text = completeNotes().replace(
    /Contributors and maintainers are never founders\./,
    `Contributors and maintainers are never founders.\n\n${parenthetical}`
  )
  const result = runGuard(await noteFile(t, text))
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
})

test('an unqualified claim far from any "(in formation)" still fails', async (t) => {
  const filler = 'This release changes nothing about the company. '.repeat(4)
  const text = completeNotes().replace(
    /Contributors and maintainers are never founders\./,
    `Contributors and maintainers are never founders.\n\n${filler}ToolsEnabled, Inc. ships this build.`
  )
  const result = runGuard(await noteFile(t, text))
  assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  assert.match(result.stderr, /ToolsEnabled, Inc\. is claimed without "\(in formation\)"/)
})

/* The template is the contract, and it is not itself a publishable note. This
 * pins that the guard reads it as incomplete rather than crashing on it. */
test('the shipped template is reported incomplete, not accepted and not a crash', () => {
  const result = runGuard(path.join(REPO_ROOT, 'docs', 'RELEASE-NOTES-TEMPLATE.md'))
  assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  assert.match(result.stderr, /template placeholders were never replaced/)
})


/* THE TWO-RECORD INSTALL CONTRACT.
 *
 * One source tip is cut for both platforms, so the note at that tip carries a record
 * for each and each cutter fills only its own in the packet copy. These four cases are
 * the whole state space that matters -- both filled, one filled, none filled, and a
 * record that is broken rather than merely unfilled -- because the guard's job is to
 * tell an operator WHICH of those they are looking at. */

function installSection(windowsDigest, linuxDigest) {
  const record = (name, platform, digest) => [
    `### ${name}`,
    '',
    '| Item | Value |',
    '| --- | --- |',
    `| Package | ToolsEnabled-${platform} |`,
    `| Platform | ${platform} |`,
    '| Bytes | 1 |',
    `| SHA-256 | ${digest} |`,
    '| Signed | no, unsigned |',
    ''
  ].join('\n')
  return ['## Install', '', 'Prose about why these are pending. It is not a record.', '',
    record('Windows installer', 'Windows', windowsDigest),
    record('Linux package', 'Linux', linuxDigest)].join('\n')
}

function withTwoRecords(windowsDigest, linuxDigest) {
  const text = completeNotes()
  const start = text.indexOf('## Install')
  const end = text.indexOf('## Publisher and copyright')
  return text.slice(0, start) + installSection(windowsDigest, linuxDigest) + '\n' + text.slice(end)
}

const FILLED = '`' + 'b'.repeat(64) + '`'

test('both install records filled passes', async (t) => {
  const file = await noteFile(t, withTwoRecords(FILLED, '`' + 'c'.repeat(64) + '`'))
  const result = runGuard(file)
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
})

test('one record filled and one pending fails, and names only the pending one', async (t) => {
  const file = await noteFile(t, withTwoRecords(FILLED, 'pending'))
  const result = runGuard(file)
  assert.equal(result.status, 1)
  const output = `${result.stdout}${result.stderr}`
  assert.match(output, /install digest pending: Install record "Linux package"\./)
  assert.ok(!/Windows installer/.test(output.split('install digest pending')[1] ?? ''),
    'a record that IS filled must not be listed as pending; an operator would go looking for a receipt they already used')
})

test('neither record filled fails and names both', async (t) => {
  const file = await noteFile(t, withTwoRecords('pending', 'pending'))
  const result = runGuard(file)
  assert.equal(result.status, 1)
  assert.match(`${result.stdout}${result.stderr}`,
    /install digest pending: Install record "Windows installer", Install record "Linux package"/)
})

test('a named record with no SHA-256 row is malformed, never pending', async (t) => {
  const broken = withTwoRecords(FILLED, 'pending').replace(/\| SHA-256 \| pending \|\n/, '')
  const file = await noteFile(t, broken)
  const result = runGuard(file)
  assert.equal(result.status, 1)
  const output = `${result.stdout}${result.stderr}`
  assert.match(output, /Install record "Linux package" has no "SHA-256" row at all/)
  assert.ok(!/install digest pending/.test(output),
    'a broken record must not be reported as pending: waiting for a cutter that will never fix it is the wrong instruction')
})

test('the single-record shape still passes, so a one-platform packet note is valid', async (t) => {
  const file = await noteFile(t, completeNotes())
  const result = runGuard(file)
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
})
