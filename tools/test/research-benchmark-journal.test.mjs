import test from 'node:test'
import assert from 'node:assert/strict'
import { RUNTIME_FILES } from '../../src/benchmark/study.mjs'
import { leanBenchRun, LEAN_BENCH_RUN_PROJECT_SHA256 } from './fixtures/lean-bench-run-efaa64a2.mjs'
import { scheduleRows, conditionRows, apparatusRows, runtimePinRows, runHeaderRows, dispositionRows, nativeVerificationRows,
  frozenInspectionMarkup, runJournalMarkup, nativeVerificationMarkup } from '../../src/research-benchmark-journal.mjs'

// The owner's standard for the Research page: every important step of a lean-bench run must be
// explicit. These derivations read the frozen project, the attempt journal, the summary and the
// native verification receipt that a run already retains, and the page renders them. Measured
// against the run of record efaa64a2: before this module the page showed one count line after
// Freeze and per-condition rates after import, and nothing below.

const run = await leanBenchRun()
const rows = markup => [...markup.matchAll(/<tr>/g)].length
const value = (table, label) => { const row = table.find(([name]) => name === label); assert.ok(row, label + ' is a row'); return row[1] }

test('the fixture is the run of record, unchanged', () => {
  assert.equal(run.project.sha256, LEAN_BENCH_RUN_PROJECT_SHA256)
  assert.equal(run.events.length, 6)
  assert.equal(run.summary.projectSha256, LEAN_BENCH_RUN_PROJECT_SHA256)
  assert.equal(run.nativeVerification.projectSha256, LEAN_BENCH_RUN_PROJECT_SHA256)
})

test('schedule rows name every frozen trial with its task, condition and replicate', () => {
  assert.deepEqual(scheduleRows(run.project), [
    { trial: 'flat-canary.claude-cli.1', task: 'flat-canary', condition: 'claude-cli', replicate: 1 },
    { trial: 'flat-canary.recorded.1', task: 'flat-canary', condition: 'recorded', replicate: 1 },
    { trial: 'flat-canary.reference-program.1', task: 'flat-canary', condition: 'reference-program', replicate: 1 },
  ])
})

test('condition rows show the declared identity, adapter, target and environment variable names, never a value', () => {
  const conditions = conditionRows(run.project)
  // The frozen order of the conditions, not the schedule's order.
  assert.deepEqual(conditions.map(row => row.id), ['recorded', 'reference-program', 'claude-cli'])
  const claude = conditions.find(row => row.id === 'claude-cli')
  assert.equal(claude.provider, 'anthropic-claude-cli')
  assert.equal(claude.model, 'claude-sonnet-5')
  assert.equal(claude.surface, 'local-cli-print-mode')
  assert.equal(claude.adapter, 'command')
  assert.equal(claude.target, 'node adapters/claude-cli.mjs')
  assert.equal(claude.environment, 'HOME')
  assert.equal(claude.credential, 'none')
  assert.match(claude.settings, /"allowedTools":"none"/)
  const recorded = conditions.find(row => row.id === 'recorded')
  assert.equal(recorded.adapter, 'replay')
  assert.equal(recorded.target, 'Saved responses; no provider call')
  assert.equal(recorded.surface, 'Not declared')
  assert.equal(recorded.environment, 'none')
  // A replay condition's saved responses are evidence, not configuration; they never appear here.
  assert.ok(!JSON.stringify(conditions).includes('priceCents'), 'saved responses are not part of the condition table')
})

test('apparatus rows state the frozen protocol, the native grading contract and the pinned image', () => {
  const table = apparatusRows(run.project)
  assert.equal(value(table, 'Schedule'), '1 tasks × 3 conditions × 1 replicates = 3 trials')
  assert.equal(value(table, 'Execution purpose'), 'apparatus-development')
  assert.equal(value(table, 'Seed'), '42')
  assert.equal(value(table, 'Attempts per trial'), '2')
  assert.equal(value(table, 'Attempts overall'), '12')
  assert.equal(value(table, 'Attempt timeout ms'), '900000')
  assert.equal(value(table, 'Study duration budget ms'), '5400000')
  assert.equal(value(table, 'Grading'), 'lean-python')
  assert.equal(value(table, 'Engine execution timeout ms'), '420000')
  assert.equal(value(table, 'Pinned engine image'), 'quantconnect/lean@sha256:cc27d5608d209fc9276c8419af3dd8e598ba49075c6f5c44ca38bf637eaef216')
  assert.equal(value(table, 'Image pinned by digest'), 'yes')
  assert.equal(value(table, 'Native execution contract'), 'lean-grade.mjs pinned at SHA-256 ' + run.project.spec.runtimeSources['lean-grade.mjs'] + '; its container flags and mounts are listed in the exported report, not measured per attempt')
  assert.equal(value(table, 'Runtime pins'), Object.keys(run.project.spec.runtimeSources).length + ' files')
})

test('a project without native grading or an image says so instead of guessing', () => {
  const project = structuredClone(run.project)
  project.spec.protocol.grading = { kind: 'json' }
  project.spec.environment.leanImage = ''
  delete project.spec.executionPlan
  const table = apparatusRows(project)
  assert.equal(value(table, 'Grading'), 'json')
  assert.equal(value(table, 'Execution purpose'), 'legacy (no execution plan)')
  assert.ok(!table.some(([name]) => name === 'Pinned engine image'), 'no image row outside lean-python')
  assert.ok(!table.some(([name]) => name === 'Engine execution timeout ms'), 'no engine timeout row outside lean-python')
  assert.ok(!table.some(([name]) => name === 'Native execution contract'), 'no native contract row outside lean-python')
  const unpinned = structuredClone(run.project)
  unpinned.spec.environment.leanImage = 'quantconnect/lean:latest'
  assert.equal(value(apparatusRows(unpinned), 'Image pinned by digest'), 'no')
})

test('runtime pin rows list every pinned runtime file digest, sorted by name', () => {
  const pins = runtimePinRows(run.project)
  assert.equal(pins.length, Object.keys(run.project.spec.runtimeSources).length)
  assert.deepEqual(pins.map(([file]) => file), [...pins.map(([file]) => file)].sort())
  assert.equal(pins.find(([file]) => file === 'report.mjs')[1], run.project.spec.runtimeSources['report.mjs'])
})

test('the run header derives identity, purpose, counts, timing and runtime from the journal and summary only', () => {
  const header = runHeaderRows(run.project, run.events, run.summary)
  assert.equal(value(header, 'Frozen project SHA-256'), LEAN_BENCH_RUN_PROJECT_SHA256)
  assert.equal(value(header, 'Execution purpose'), 'apparatus-development')
  assert.equal(value(header, 'Evidence class'), 'development-computations')
  assert.equal(value(header, 'Experimental collection'), 'not-admitted')
  assert.equal(value(header, 'Journal events'), '6')
  assert.equal(value(header, 'Trials'), '3 scheduled · 3 completed · 0 failed · 0 interrupted · 0 pending')
  assert.equal(value(header, 'Attempts'), '3')
  assert.equal(value(header, 'First attempt started'), '2026-09-10T21:20:55.643Z')
  // finished events carry no timestamp: the end is the last start plus that attempt's elapsed time, and says so.
  assert.equal(value(header, 'Last attempt ended (start plus elapsed)'), '2026-09-10T21:22:33.646Z')
  assert.equal(value(header, 'Journal span ms'), '98003')
  assert.equal(value(header, 'Runtime'), 'node v22.19.0 on linux/x64')
  assert.equal(value(header, 'Readiness contract'), run.events[0].readinessSha256)
})

test('a journal with no started event reports timing and runtime as unavailable rather than inventing them', () => {
  const header = runHeaderRows(run.project, [], { ...run.summary, scheduled: 3, completed: 0, failed: 0, interrupted: 0, pending: 3, attempts: 0 })
  assert.equal(value(header, 'First attempt started'), 'Unavailable')
  assert.equal(value(header, 'Journal span ms'), 'Unavailable')
  assert.equal(value(header, 'Runtime'), 'Unavailable')
  assert.equal(value(header, 'Trials'), '3 scheduled · 0 completed · 0 failed · 0 interrupted · 3 pending')
})

test('disposition rows separate why each trial ended, per condition, as the report table does', () => {
  assert.deepEqual(dispositionRows(run.summary), [
    { condition: 'recorded', disposition: 'no-program', trials: 1 },
    { condition: 'reference-program', disposition: 'correct', trials: 1 },
    { condition: 'claude-cli', disposition: 'correct', trials: 1 },
  ])
})

test('native verification rows show the receipt status, every attempt and every limitation', () => {
  const view = nativeVerificationRows(run.nativeVerification)
  assert.equal(value(view.header, 'Evidence status'), 'retained-artifact-consistency')
  assert.equal(value(view.header, 'Receipt journal SHA-256'), run.nativeVerification.journalSha256)
  assert.equal(value(view.header, 'Attempts checked'), '3')
  assert.equal(view.attempts.length, 3)
  const claude = view.attempts.find(row => row.trial === 'flat-canary.claude-cli.1')
  assert.equal(claude.disposition, 'observed')
  assert.equal(claude.grade, 'correct (passed)')
  assert.equal(claude.candidateSha256, '344e11e451054d1210d7942d31254dec01e2c21cae32994a9d84b0a56dafd17f')
  assert.equal(claude.artifactFiles, 5)
  assert.equal(claude.sourceFiles, 47)
  const recorded = view.attempts.find(row => row.trial === 'flat-canary.recorded.1')
  assert.equal(recorded.disposition, 'no-program')
  assert.equal(recorded.grade, 'no-program (failed): The system did not return Python source (maximum 1 MiB).')
  assert.equal(recorded.candidateSha256, 'Unavailable')
  assert.equal(view.limitations.length, 4)
})

test('the markup renders every row, escapes text and carries hooks the page tests can find', () => {
  const project = structuredClone(run.project)
  project.spec.conditions[0].label = 'Local <script>alert(1)</script> CLI'
  const frozen = frozenInspectionMarkup(project)
  for (const hook of ['data-bench-journal-schedule', 'data-bench-journal-conditions', 'data-bench-journal-apparatus', 'data-bench-journal-pins']) assert.ok(frozen.includes(hook), hook)
  assert.ok(!frozen.includes('<script>'), 'condition labels are escaped')
  assert.ok(frozen.includes('Local &lt;script&gt;alert(1)&lt;/script&gt; CLI'))
  assert.ok(frozen.includes('flat-canary.reference-program.1'))
  assert.ok(frozen.includes('quantconnect/lean@sha256:cc27d5608d209fc9276c8419af3dd8e598ba49075c6f5c44ca38bf637eaef216'))
  assert.equal(rows(frozen.slice(frozen.indexOf('data-bench-journal-pins'))), Object.keys(run.project.spec.runtimeSources).length + 1)
  const journal = runJournalMarkup(run.project, run.events, run.summary)
  assert.ok(journal.includes('data-bench-journal-run') && journal.includes('data-bench-journal-dispositions'))
  assert.ok(journal.includes('2026-09-10T21:20:55.643Z') && journal.includes('no-program') && journal.includes('node v22.19.0 on linux/x64'))
  const receipt = nativeVerificationMarkup(run.nativeVerification)
  assert.ok(receipt.includes('data-bench-journal-native-attempts') && receipt.includes('retained-artifact-consistency'))
  assert.equal(rows(receipt.slice(receipt.indexOf('data-bench-journal-native-attempts'))), 4)
  assert.ok(receipt.includes('do not authenticate who produced the artifacts'))
})
