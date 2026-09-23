#!/usr/bin/env node
// The exported-bytes baseline used by
// tools/test/research-benchmark-export-bytes.test.mjs: report on it, or
// re-freeze it.
//
//   node tools/research-benchmark-export-baseline.mjs --check
//       Reports and writes NOTHING. Exit 0 if the baseline on disk is already
//       what a re-freeze would produce, exit 1 if it is not.
//
//   node tools/research-benchmark-export-baseline.mjs
//       Reports, then re-freezes if anything differs. Run this ONLY when the
//       exported bytes were meant to change, and record why in the commit.
//
// WHY IT READS BEFORE IT WRITES. This tool used to call writeFile
// unconditionally and print one line per fixture saying how many artifacts it
// had frozen. That destroyed the only evidence of what had moved before anybody
// could read it: after the re-freeze the old hashes are gone, so "say in the
// commit why the exported bytes moved" had to be answered from memory, and the
// instruction not to re-freeze a REGRESSION could not be followed from the tool
// at all -- you had to run the gate, read its failure, and come back.
//
// So it now loads the baseline first and prints the verdict per fixture with
// the files named, and the reading of that verdict comes from whyBytesMoved --
// the same function the gate prints -- so the tool and the gate cannot give
// different accounts of the same tree.
import { readFile, writeFile } from 'node:fs/promises'
import { canonical, sha256 } from '../src/benchmark/prompts.mjs'
import { apparatusDigests, apparatusDrift, compiledArtifacts, exportFixture, projectShape, whyBytesMoved, FIXTURES }
  from './test/fixtures/research-benchmark-export-bytes.mjs'

const CHECK = process.argv.slice(2).some(argument => argument === '--check' || argument === '--dry-run')
const BASELINE = new URL('./test/fixtures/research-benchmark-export-bytes-baseline.json', import.meta.url)

const onDisk = await readFile(BASELINE, 'utf8').catch(() => null)
let previous = null
try { previous = onDisk === null ? null : JSON.parse(onDisk) } catch { previous = null }
if (onDisk === null) console.log('no baseline on disk; everything below is a first freeze')
else if (!previous) console.log('the baseline on disk is not readable JSON; everything below is a first freeze')

const apparatus = await apparatusDigests()
const baseline = { note: 'Frozen bytes of the compiled export. Regenerate only for a deliberate change.', fixtures: {} }

for (const fixture of FIXTURES) {
  const { files } = await exportFixture(fixture)
  const artifacts = {}
  for (const name of compiledArtifacts(files)) artifacts[name] = await sha256(files[name])
  const shape = await sha256(canonical(projectShape(files['project.json'])))
  baseline.fixtures[fixture] = { artifacts, projectShape: shape }

  const before = previous?.fixtures?.[fixture]
  const names = Object.keys(artifacts)
  const prior = Object.keys(before?.artifacts || {})
  const added = names.filter(name => !prior.includes(name))
  const dropped = prior.filter(name => !names.includes(name))
  const moved = names.filter(name => prior.includes(name) && before.artifacts[name] !== artifacts[name])
  const shapeVerdict = !before ? 'NO PRIOR BASELINE' : before.projectShape === shape ? 'IDENTICAL' : 'MOVED'

  console.log(`${fixture}: artifacts ${names.length} | added ${added.length} | dropped ${dropped.length}`
    + ` | hash-changed ${moved.length} | projectShape ${shapeVerdict}`)
  if (added.length) console.log(`  added:   ${added.join(', ')}`)
  if (dropped.length) console.log(`  dropped: ${dropped.join(', ')}`)
  if (moved.length) console.log(`  moved:   ${moved.join(', ')}`)
  // The same sentences the gate prints, indented under the fixture they belong
  // to. Read it before deciding to re-freeze: one of them says do not.
  if (moved.length) {
    console.log(whyBytesMoved(moved, previous?.apparatus, apparatus, shapeVerdict === 'MOVED')
      .split('\n').map(line => '  ' + line).join('\n'))
  }
}

baseline.apparatus = apparatus
const total = Object.keys(apparatus).length
const drift = previous?.apparatus ? apparatusDrift(previous.apparatus, apparatus) : null
if (drift === null) console.log(`apparatus: ${total} files digested; the baseline on disk records none, so nothing can be compared`)
else if (!drift.length) console.log(`apparatus: ${total} files digested; none differs from the ones the baseline on disk was frozen against`)
else console.log(`apparatus: ${drift.length} of ${total} differ since the baseline on disk: ${drift.join(', ')}`)

// The exact question, asked exactly: would a re-freeze change the file on disk?
// Anything softer would let --check pass on a baseline that is about to move.
const serialized = JSON.stringify(baseline, null, 2) + '\n'
const current = onDisk === serialized

if (CHECK) {
  console.log(current
    ? 'check: the baseline on disk is current; a re-freeze would change nothing.'
    : 'check: the baseline on disk is NOT current. Nothing was written.')
  process.exitCode = current ? 0 : 1
} else if (current) {
  console.log('the baseline on disk is already current; leaving it untouched.')
} else {
  await writeFile(BASELINE, serialized)
  console.log('re-froze the baseline. Say in the commit why the exported bytes moved.')
}
