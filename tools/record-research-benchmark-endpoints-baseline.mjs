#!/usr/bin/env node
// Recorder for tools/test/fixtures/research-benchmark-endpoints-baseline.json.
//
// WHY THIS EXISTS. That fixture is the byte-identity control for a frozen research
// study: 3 identity digests, 32 journal events and 130 report-file digests. Four
// suites read it. Until now it had no writer at all, so every re-recording was a
// hand-copy of thirty-odd hex strings (31d02b93, and 6d29f00b before it). A
// hand-edited digest fixture with no reproducible path is how these rot: nobody can
// tell afterwards whether a digest was measured or typed.
//
// WHY IT IS NOT JUST A DUMP. A recorder that writes whatever the code currently does
// launders a real regression into a "pass". This one cannot be run blind:
//
//   1. With no flags it WRITES NOTHING. It prints every digest that would move, and
//      for each moved report file it says whether the change is fully explained by
//      the application version string -- by substituting the live version back to the
//      recorded one and checking the recorded digest reappears -- or whether it is
//      UNEXPLAINED and the caller has to go and read the file.
//   2. It prints a confirmation token derived from that exact diff. `--write` refuses
//      without `--confirm <token>`, and the token is recomputed at write time, so a
//      token from a diff you read no longer matches a diff that has since changed.
//      You cannot bless a change you have not seen.
//   3. `--write` also requires `--reason`, because the fixture's own provenance block
//      is the only record of why a digest moved, and the two precedents both carry one.
//
// The identity digests get the loudest treatment: projectSha256, journalSha256 and
// summarySha256 moving means the frozen project itself re-froze differently, which for
// this fixture should now be impossible -- it pins its own generator
// (research-benchmark-endpoints.mjs RECORDED_GENERATOR), so nothing about the running
// release reaches its identity. If they move, a compiler changed. Read it, do not record it.
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { canonical } from '../src/benchmark/prompts.mjs'
import { freezeStudy, GENERATOR } from '../src/benchmark/study.mjs'
import { runStudy } from '../src/benchmark/runner.mjs'
import { researchReportFiles } from '../src/benchmark/report.mjs'
import { endpointStudy, FIXED_NOW, RECORDED_GENERATOR } from './test/fixtures/research-benchmark-endpoints.mjs'

const FIXTURE = new URL('./test/fixtures/research-benchmark-endpoints-baseline.json', import.meta.url)
const digest = text => createHash('sha256').update(text).digest('hex')
const flag = name => process.argv.includes('--' + name)
const value = name => { const at = process.argv.indexOf('--' + name); return at === -1 ? null : process.argv[at + 1] ?? null }

const baseline = JSON.parse(await readFile(FIXTURE, 'utf8'))
const project = await freezeStudy(endpointStudy(baseline.runtimeSources))
const result = await runStudy(project, { now: () => FIXED_NOW })
const files = await researchReportFiles(project, result.events)

const measured = { projectSha256: project.sha256, journalSha256: digest(canonical(result.events)),
  summarySha256: digest(canonical(result.summary)), events: result.events.length,
  files: Object.fromEntries(Object.keys(files).sort().map(name => [name, digest(files[name])])) }

// Is this file's move fully accounted for by the application version string? The
// version reaches report prose through TEMPLATE_GENERATOR, a module constant printed
// as provenance rather than a recorded field, so it cannot be injected the way the
// stamp can. Substituting the running version back to the one the baseline recorded
// under and recovering the recorded digest is the check; report.md escapes the dots,
// so both spellings are substituted.
const explainedByVersion = (name, recorded) => {
  if (GENERATOR.version === RECORDED_GENERATOR.version) return false
  const [from, to] = [GENERATOR.version, RECORDED_GENERATOR.version]
  const escape = version => version.replaceAll('.', '\\.')
  const text = files[name]
  const sites = [...text.matchAll(new RegExp(escape(from).replaceAll('\\', '\\\\') + '|' + escape(from), 'g'))]
  const back = text.replaceAll(escape(from), escape(to)).replaceAll(from, to)
  return digest(back) === recorded ? sites.length : false
}

const identityMoves = ['projectSha256', 'journalSha256', 'summarySha256', 'events']
  .filter(key => measured[key] !== baseline[key]).map(key => ({ key, from: baseline[key], to: measured[key] }))
const added = Object.keys(measured.files).filter(name => !(name in baseline.files))
const removed = Object.keys(baseline.files).filter(name => !(name in measured.files))
const moved = Object.keys(measured.files).filter(name => name in baseline.files && measured.files[name] !== baseline.files[name])
  .map(name => ({ name, from: baseline.files[name], to: measured.files[name], sites: explainedByVersion(name, baseline.files[name]) }))

// The token covers exactly what is being blessed and nothing else, so it changes the
// moment the diff does -- including a file moving from explained to unexplained.
const token = digest(canonical({ identityMoves, added, removed,
  moved: moved.map(row => ({ ...row, sites: row.sites === false ? 'unexplained' : row.sites })) })).slice(0, 12)
const unexplained = moved.filter(row => row.sites === false)
const clean = !identityMoves.length && !added.length && !removed.length && !moved.length

console.log('Fixture: ' + FIXTURE.pathname)
console.log('Recorded under ToolsEnabled ' + RECORDED_GENERATOR.version + ', running ToolsEnabled ' + GENERATOR.version
  + ' (the fixture pins its own generator, so the running release must not reach its identity)')
console.log('')
if (clean) { console.log('Nothing to record: every digest in the fixture matches what this tree produces.'); process.exit(0) }

if (identityMoves.length) {
  console.log('THE FROZEN IDENTITY MOVED. This fixture pins its generator, so no application bump can')
  console.log('cause this. A compiler, the runner or the analysis changed. Read the change before recording it.')
  for (const row of identityMoves) console.log('  ' + row.key + '\n    was ' + row.from + '\n    now ' + row.to)
  console.log('')
}
if (added.length || removed.length) {
  console.log('THE REPORT FILE SET CHANGED, which is a product change, not a re-recording:')
  for (const name of added) console.log('  added   ' + name)
  for (const name of removed) console.log('  removed ' + name)
  console.log('')
}
if (moved.length) {
  console.log(moved.length + ' report file digest(s) moved:')
  for (const row of moved) console.log('  ' + (row.sites === false ? 'UNEXPLAINED   ' : 'version only  ')
    + row.name + (row.sites === false ? '' : ' (' + row.sites + ' provenance site' + (row.sites === 1 ? '' : 's') + ')')
    + '\n    was ' + row.from + '\n    now ' + row.to)
  console.log('')
}
if (unexplained.length) {
  console.log('The ' + unexplained.length + ' file(s) marked UNEXPLAINED did not come back to their recorded digest when the')
  console.log('application version was substituted back. Something else moved them. Render them and read the')
  console.log('difference before you record it; if it is a real product change, say so in --reason.')
  console.log('')
}

if (!flag('write')) {
  console.log('Nothing was written. To record this exact diff:')
  console.log('  node tools/record-research-benchmark-endpoints-baseline.mjs --write \\')
  console.log('    --confirm ' + token + ' \\')
  console.log('    --reason "what moved these digests and why that is not a regression"')
  process.exit(0)
}
if (value('confirm') !== token) {
  console.error('Refusing to write: --confirm ' + (value('confirm') ?? '(missing)') + ' does not match this diff, whose token is ' + token + '.')
  console.error('Run the command with no flags, read the diff above, then pass the token it prints. A token that')
  console.error('no longer matches means the diff changed since you read it.')
  process.exit(1)
}
if (!value('reason')?.trim()) {
  console.error('Refusing to write: pass --reason "<what moved and why it is not a regression>". The fixture\'s')
  console.error('provenance block is the only record of why a digest moved, and a blank one makes the next')
  console.error('reader guess.')
  process.exit(1)
}

// Written by replacing values in place, never by re-serialising the whole document: the
// runtimeSources block and the recorded event count are inputs, not measurements, and a
// reformat would bury the one-line diff a reviewer needs to see.
let text = await readFile(FIXTURE, 'utf8')
const swap = (was, now) => {
  const before = text
  text = text.replace('"' + was + '"', '"' + now + '"')
  if (text === before) { console.error('Refusing to write: could not find ' + was + ' in the fixture to replace.'); process.exit(1) }
}
for (const row of identityMoves) if (row.key !== 'events') swap(row.from, row.to)
for (const row of moved) swap(row.from, row.to)
const recorded = JSON.parse(text)
recorded.filesRecorded = { commit: value('commit')?.trim() || 'uncommitted working tree', tracked: 'clean', reason: value('reason').trim() }
// One rewrite of that block only, matched on its old text, so the rest of the file is byte-untouched.
text = text.replace(/  "filesRecorded": \{[\s\S]*?\n  \}/, '  "filesRecorded": ' + JSON.stringify(recorded.filesRecorded, null, 2).split('\n').join('\n  '))
await writeFile(FIXTURE, text)
console.log('Recorded ' + (identityMoves.length + moved.length) + ' digest(s) and the provenance reason into the fixture.')
console.log('Re-run the four suites that read it: research-benchmark-endpoints, -tool-policy, -citation-record, -runtime-integrity.')
