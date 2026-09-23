/* WHICH PLATFORMS THE RELEASE SHIPS IS THE RELEASE'S PROPERTY, NOT THE CUTTER'S.
 *
 * tools/check-release-notes.mjs refuses an install record for a platform the
 * release does not ship, because a record with a `pending` digest reads as a
 * promise that a package is coming. The guard cannot know which platforms those
 * are; only the caller can tell it. The Linux cutter told it `linux`, as a
 * literal, because 1.0.44 really was Linux-only (R1212).
 *
 * 1.0.45 ships Windows and Linux from one source pair. Against a correct
 * two-record note that literal refused the Windows record -- a red final step
 * recorded against a note that was right, on a release whose whole point is
 * that both platforms ship. So the scope is an argument now.
 *
 * The default is unchanged and that is the load-bearing half: a caller that
 * says nothing still gets `--platform linux`, so 1.0.44's behaviour and every
 * existing invocation are exactly as they were. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { parseArgs } from '../release-packager/cut-linux-release-candidate.mjs'

const REQUIRED = [
  '--repo', '/repo', '--engine-repo', '/engine',
  '--source-ref', 'a'.repeat(40), '--engine-source-ref', 'b'.repeat(40),
  '--version', '1.0.45', '--worktree', '/worktree', '--output', '/output',
]

test('a release that says nothing about platforms is still the Linux-only release', () => {
  assert.deepEqual(parseArgs(REQUIRED).releasePlatforms, ['linux'],
    'mutation `change the default release scope` survived: every caller written before this flag existed '
    + 'passes no --release-platform, and each of them is cutting the Linux-only shape the literal was written for')
})

test('a two-platform release names both, once each and in the order given', () => {
  assert.deepEqual(parseArgs([...REQUIRED, '--release-platform', 'linux', '--release-platform', 'windows']).releasePlatforms,
    ['linux', 'windows'],
    'mutation `keep only the last platform` survived: the guard needs every platform the release ships, '
    + 'and a dropped one turns a correct install record into a refusal')
  assert.deepEqual(parseArgs([...REQUIRED, '--release-platform', 'Linux', '--release-platform', 'linux']).releasePlatforms,
    ['linux'],
    'mutation `stop folding case and duplicates` survived: the guard lowercases its own names, so two spellings '
    + 'of one platform must reach it as one')
})

test('a platform this cutter cannot honour is refused at the argument, not at the step', () => {
  assert.throws(() => parseArgs([...REQUIRED, '--release-platform', 'plan9']), /must be one of linux, windows, macos/,
    'mutation `accept any platform name` survived: a name the notes guard does not know would travel all the way '
    + 'to a refusal nobody could act on')
  assert.throws(() => parseArgs([...REQUIRED, '--release-platform', 'windows']), /must include linux/,
    'mutation `let the Linux cutter cut a release without Linux in it` survived: this cutter builds the Linux '
    + 'package, so a scope that omits it describes a run with nothing to do')
  assert.throws(() => parseArgs([...REQUIRED, '--release-platform']), /requires one platform name/,
    'mutation `accept the flag with no value` survived')
})

test('the two platform vocabularies are the same list', () => {
  /* A name this cutter accepts and the guard does not is a flag that reaches a
     refusal nobody asked for; the reverse is a platform nobody can declare. */
  const cutter = readFileSync(new URL('../release-packager/cut-linux-release-candidate.mjs', import.meta.url), 'utf8')
  const guard = readFileSync(new URL('../check-release-notes.mjs', import.meta.url), 'utf8')
  const names = source => {
    const match = /(?:RELEASE_PLATFORMS|KNOWN_PLATFORMS)\s*=\s*(?:Object\.freeze\()?\[([^\]]*)\]/.exec(source)
    assert.ok(match, 'expected a platform list to still be declared')
    return match[1].split(',').map(part => part.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).sort()
  }
  assert.deepEqual(names(cutter), names(guard),
    'mutation `let the cutter and the notes guard disagree about what a platform is` survived')
})

test('the final step asks the guard about exactly the platforms it was given', () => {
  /* Read from the source rather than a plan run: building a plan needs a real
     repo, and the property under test is which argv the step is composed with. */
  const source = readFileSync(new URL('../release-packager/cut-linux-release-candidate.mjs', import.meta.url), 'utf8')
  const step = /const releasePlatforms =[\s\S]{0,600}?check-release-notes[\s\S]{0,400}?\)\n/.exec(source)
  assert.ok(step, 'expected the check-release-notes step to still exist')
  assert.doesNotMatch(step[0], /'--platform',\s*'linux'/,
    'mutation `hardcode the platform again` survived: that literal is what refused 1.0.45\'s Windows record')
  assert.match(step[0], /releasePlatforms\.flatMap\(/,
    'mutation `stop passing the release scope to the guard` survived: with no --platform the guard accepts any '
    + 'record at all, which is the hole this whole mechanism closed')
  assert.match(step[0], /ctx\.releasePlatforms\?\.length \? ctx\.releasePlatforms : DEFAULT_RELEASE_PLATFORMS/,
    'mutation `require every context to carry a scope` survived: planSteps() is called with a synthesized '
    + 'context by the tests that hold this chain equal to package.json\'s, and reading a missing field there '
    + 'threw before any gate could be compared')
})
