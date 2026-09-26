// The exported README promises "The same project and journal always produce the
// same bytes". That promise is what makes an exported project an instrument
// rather than a convenience: a third party re-running the export must get the
// archive the paper cites. Refactoring the compiler can break it silently,
// because nothing else compares exported bytes against a frozen expectation.
//
// Three separate questions, kept apart on purpose:
//   A. Do the COMPILED artifacts (prompts, schedule, checklists, README,
//      specification, provenance...) still have the bytes they had when the
//      baseline was frozen? A behaviour-preserving change must not move these.
//   B. Does the compiled PROJECT still describe the same study, ignoring the
//      digests of the runtime source files? Editing src/benchmark/*.mjs is
//      expected to move project.spec.runtimeSources and the project digest that
//      covers them; it is NOT expected to move anything else in the project.
//   C. Is the export deterministic at all?
//
// A and B are golden-byte comparisons against fixtures/
// research-benchmark-export-bytes-baseline.json. If a change is deliberate,
// re-freeze with `node tools/research-benchmark-export-baseline.mjs` and say in
// the commit why the exported bytes moved. Do not relax the test.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { canonical, sha256 } from '../../src/benchmark/prompts.mjs'
import { FIXTURES, apparatusDigests, compiledArtifacts, exportFixture, projectShape, whyBytesMoved } from './fixtures/research-benchmark-export-bytes.mjs'

const baseline = JSON.parse(await readFile(
  new URL('./fixtures/research-benchmark-export-bytes-baseline.json', import.meta.url), 'utf8'))

/* WHY A MOVED BYTE NEEDS A SECOND QUESTION ASKED.
 *
 * "exported bytes moved for: README.md, ..." is the same sentence for two
 * opposite situations: a baseline frozen before somebody edited the apparatus
 * (STALE -- re-freeze it), and an apparatus that started producing different
 * output on its own (a REGRESSION -- do not re-freeze it). Two investigations
 * have already gone into telling those apart by hand, and on one of them the
 * convenient reading -- "it must be the thing I just did" -- was wrong in both
 * directions.
 *
 * The baseline now records the digest of every module the export is produced
 * by, so the gate can answer it. Neither answer is an excuse: the assertion is
 * the same assertion and every branch below stays RED. What changes is only
 * what the failure SAYS, which is the difference between a two-minute re-freeze
 * and an afternoon of bisecting.
 *
 * Baselines frozen before the field existed still load. The gate then says the
 * field is absent rather than guessing, because "could not tell" and "nothing
 * changed" are different answers.
 */
for (const fixture of FIXTURES) {
  const expected = baseline.fixtures[fixture]

  test(`A. ${fixture}: every compiled artifact still has its frozen bytes`, async () => {
    const { files } = await exportFixture(fixture)
    const names = compiledArtifacts(files)
    assert.deepEqual(names, Object.keys(expected.artifacts),
      'the set of compiled artifacts changed; a file was added to or dropped from the export')
    const moved = []
    for (const name of names) if (await sha256(files[name]) !== expected.artifacts[name]) moved.push(name)
    // Asked only when something moved, so the green path reads no source files.
    const why = moved.length
      ? whyBytesMoved(moved, baseline.apparatus, await apparatusDigests(),
          await sha256(canonical(projectShape(files['project.json']))) !== expected.projectShape)
      : ''
    assert.deepEqual(moved, [], why)
  })

  test(`B. ${fixture}: the compiled project still describes the same study`, async () => {
    const { files } = await exportFixture(fixture)
    assert.equal(await sha256(canonical(projectShape(files['project.json']))), expected.projectShape)
  })

  test(`C. ${fixture}: exporting the same project twice produces identical bytes`, async () => {
    const first = await exportFixture(fixture)
    const second = await exportFixture(fixture)
    assert.deepEqual(Object.keys(first.files).sort(), Object.keys(second.files).sort())
    const differing = Object.keys(first.files).filter(name => first.files[name] !== second.files[name])
    assert.deepEqual(differing, [], `nondeterministic export for: ${differing.join(', ')}`)
  })
}
