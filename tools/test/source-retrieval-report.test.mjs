import assert from 'node:assert/strict'
import { ownedFixtureTempRoot } from './lib/owned-fixture-temp.mjs'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { parseSourceOutput, planSourceSuiteJobs } from '../lib/adapters/source-suites.mjs'
import { SOURCE_COMMAND_ACTIONS, SOURCE_MANIFESTS } from '../lib/adapters/source-suite-manifests.mjs'

const LEAF = 'tests/retrieval/honest-retrieval.test.js'
const CLI_PROOF = '  ok  tools/recall.js proves HIT, MISS and UNKNOWN using a disposable real CLI corpus'
const OLD_CLI_PROOF = '  ok  tools/recall.js exits 3 on a real MISS and 0 on a real HIT, against real files'
const FOOTER = 'R1246 retrieval: all 35 behavioural checks passed.'
const ONE_FILE = { tests: 1, passed: 1, failed: 0, skipped: 0, cancelled: 0, todo: 0, notRun: 0 }
const TEMP = ownedFixtureTempRoot()
const CWD = path.join(TEMP, 'source-retrieval-report-fixture')
const OPTIONS = [
  { reporter: 'engine:retrieval-runner' },
  { reporter: 'engine:registered-leaf', cwd: CWD, file: path.join(CWD, LEAF) },
]
// Actual native Windows stdout from the repaired 35-check suite, also observed
// on Linux. Keep this independent of the registry's expected marker array:
// deriving an expected report from that array would conceal a missing marker.
const REPORT = [
  "R1246 retrieval: the absence case, before the presence case",
  "  ok  no settings file at all withholds the surface and touches nothing",
  "  ok  a non-boolean in the settings FILE is refused by name, and the surface stays withheld",
  "  ok  the GATE itself withholds anything that is not exactly true, without trusting the loader",
  "  ok  a registry DEFAULT of true cannot enable the surface -- only a user or installer choice can",
  "  ok  a source with no settings-registry entry is UNCLASSIFIED and withheld, master toggle notwithstanding",
  "  ok  settings-gate blindness census fails closed for every reproduced shape",
  "R1246 retrieval: hit / miss / unknown / withheld, and their exit codes",
  "  ok  a real hit cites the exact ledger request that carries the wording",
  "  ok  a genuine gap is MISS with exit 3, and says every source was read in full",
  "  ok  a source switched OFF turns an empty answer into UNKNOWN, never MISS",
  "  ok  a source that cannot be READ turns an empty answer into UNKNOWN, and names the code",
  "  ok  a hit still declares what was NOT searched",
  "  ok  no outcome other than hit can ever produce exit 0",
  "R1246 retrieval: real process exit codes from the real CLI",
  "  ok  tools/recall.js exits 5 when the surface is withheld, 2 with no topic",
  "  ok  tools/recall.js proves HIT, MISS and UNKNOWN using a disposable real CLI corpus",
  "  ok  the CLI renders a withheld answer as WITHHELD and never as an empty result list",
  "  ok  tools/recall-index.js refuses to index a withheld source and exits 5",
  "  ok  tools/recall-index.js reports 4, not 0, when an enabled source cannot be indexed",
  "  ok  tools/recall-index.js refuses a refresh report that omits an enabled source",
  "R1246 retrieval: the index itself",
  "  ok  the ledger is indexed one document PER REQUEST, not as one file",
  "  ok  a secret-shaped line in a verbatim never reaches the index",
  "  ok  the index self-heals: a request added after the first query is found by the second",
  "  ok  an unwritable index falls back to memory and still answers correctly",
  "  ok  the query tokenizer splits the way FTS5 unicode61 splits, so a term can never be unfindable",
  "R1246 retrieval: docs stays owned by tools/prior-work-index.js",
  "  ok  docs results come from the prior-work index and are NOT copied into the FTS store",
  "  ok  an UNKNOWN from the delegated index propagates as UNKNOWN, not as an empty docs corpus",
  "R1246 retrieval: the post-launch embedding seam",
  "  ok  meaning search OFF says so, and keyword ranking is what ran",
  "  ok  meaning search ON with no backend installed reports UNAVAILABLE in the answer, and still answers",
  "  ok  a registered, available backend actually re-ranks and is named",
  "  ok  a backend that invents a result is refused and the baseline order is kept",
  "  ok  a backend that duplicates one result and drops another is refused",
  "  ok  registerBackend refuses a backend that is not gated by a retrieval.* control",
  "R1246 retrieval: the gate as a unit",
  "  ok  surface-off and every-source-off are reported as DIFFERENT reasons",
  "  ok  the master toggle is a fence: an ON source under an OFF surface is still withheld",
  "  ok  decideToggle distinguishes unclassified from withheld",
  "  ok  every registered source names a control that exists in the shipped settings registry",
  "",
  "R1246 retrieval: all 35 behavioural checks passed.",
].join('\n') + '\n'

function refused(report, stderr = '') {
  for (const options of OPTIONS) {
    assert.throws(() => parseSourceOutput(report, stderr, options), error => error.code === 'SOURCE_QUALIFICATION_INCOMPLETE')
  }
}

test('both real retrieval report entry points require the complete observed leaf and count one file', () => {
  for (const options of OPTIONS) {
    for (const newline of ['\n', '\r\n']) {
      const report = REPORT.replaceAll('\n', newline)
      assert.deepEqual(parseSourceOutput(report, '', options), ONE_FILE)
      assert.deepEqual(parseSourceOutput(report,
        '(node:1234) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n', options), ONE_FILE)
    }
  }
})

test('the legacy green report cannot substitute UNKNOWN for the required successful CLI search', () => {
  const legacy = REPORT.replace(CLI_PROOF, OLD_CLI_PROOF)
  refused(legacy)
  refused(legacy.replace(OLD_CLI_PROOF,
    '           (real-tree HIT half NOT exercised: ledger=LEDGER_FILE_ABSENT; the UNKNOWN contract was checked instead)\n' + OLD_CLI_PROOF))
  refused(REPORT.replace(CLI_PROOF, ''))
  refused(FOOTER + '\n')
})

test('every observed assertion must appear once in order with its matching terminal count', () => {
  const assertions = REPORT.split('\n').filter(line => line.startsWith('  ok  '))
  assert.equal(assertions.length, 35)
  for (const line of assertions) {
    refused(REPORT.replace(line + '\n', ''))
    refused(REPORT.replace(line, line + '\n' + line))
    refused(REPORT.replace(line, line.replace('  ok  ', '  FAIL ')))
  }
  refused(REPORT.replace(assertions[0] + '\n' + assertions[1], assertions[1] + '\n' + assertions[0]))
  for (const count of [0, 34, 36]) refused(REPORT.replace(FOOTER, `R1246 retrieval: all ${count} behavioural checks passed.`))
  refused(REPORT.replace(FOOTER, ''))
  refused(REPORT + FOOTER + '\n')
  refused('')
})

test('extra success claims, failures and unexplained skips remain release blockers', () => {
  for (const extra of ['  ok  unassigned extra check\n', 'FAIL hidden failure\n', 'not ok 1 - failure\n', 'SKIP required path\n']) {
    refused(extra + REPORT)
    refused(REPORT, extra)
  }
  refused(REPORT + 'incomplete trailing output\n')
  refused(REPORT, 'real-tree HIT half NOT exercised: ledger=LEDGER_FILE_ABSENT\n')
})

test('the fixed qualification plan executes the production runner and binds the individual leaf reporter', t => {
  const root = mkdtempSync(path.join(TEMP, 'source-retrieval-jobs-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(path.join(root, 'tests/retrieval'), { recursive: true })
  writeFileSync(path.join(root, LEAF), "throw new Error('planning must never execute this file')\n")
  writeFileSync(path.join(root, 'tests/retrieval/run.js'), "throw new Error('planning must never execute this runner')\n")
  writeFileSync(path.join(root, 'tests/run-isolated.js'), "throw new Error('planning must never execute this wrapper')\n")
  const action = SOURCE_COMMAND_ACTIONS.engine.find(entry => entry.id === 'engine:retrieval-runner')
  assert.ok(action, 'retrieval cannot silently disappear from the fixed qualification actions')
  assert.deepEqual(action.command, ['node', 'tests/retrieval/run.js'])
  assert.deepEqual(action.measuredInputs, ['config/settings-registry.json'])
  const jobs = planSourceSuiteJobs({ id: 'engine', root, files: [LEAF], commands: [action], crossFiles: [] }, path.join(root, 'evidence'))
  assert.equal(jobs.length, 2)
  assert.equal(jobs[0].reporter, 'engine:retrieval-runner')
  assert.deepEqual(jobs[0].isolatedFiles, [LEAF])
  assert.deepEqual(jobs[1].isolatedFiles, [LEAF])
  assert.deepEqual(jobs[0].args, [path.join(root, 'tests/retrieval/run.js')])
  assert.equal(jobs[1].reporter, 'engine:registered-leaf')
  assert.deepEqual(jobs[1].args.slice(0, 5), [path.join(root, 'tests/run-isolated.js'), '--config-integrity', '--timeout-ms', '600000', '--summary'])
  assert.equal(jobs[1].args.at(-1), path.join(root, LEAF))
  assert.equal(SOURCE_MANIFESTS.app.inventory.filter(entry => entry.file === 'tools/test/source-retrieval-report.test.mjs' && entry.reason === null).length, 1)
})


test('the current strict isolated completion line retains the exact retrieval leaf report', () => {
  const marker = `STRICT EVIDENCE: ${LEAF} -- process-exit; assertion count not reported\n`
  for (const options of OPTIONS) {
    const expected = { ...options, isolatedFiles: [LEAF] }
    assert.deepEqual(parseSourceOutput(REPORT + marker, '', expected), ONE_FILE)
    assert.throws(() => parseSourceOutput(marker, '', expected), /empty, extra, malformed or reordered child/)
    assert.throws(() => parseSourceOutput(REPORT + marker.replace(LEAF, 'tests/another.js'), '', expected), /empty, extra, malformed or reordered child/)
    assert.throws(() => parseSourceOutput(REPORT + marker + marker, '', expected), /empty, extra, malformed or reordered child/)
    assert.throws(() => parseSourceOutput(REPORT, '', expected), /did not complete every required child/)
  }
})


test('the direct Vertex assertion shim is not relabeled as an isolated child runner', () => {
  const action = SOURCE_COMMAND_ACTIONS.engine.find(entry => entry.id === 'engine:vertex-report-shim')
  const jobs = planSourceSuiteJobs({ id: 'engine', root: CWD, files: [], commands: [action], crossFiles: [] }, path.join(CWD, 'evidence'))
  assert.equal(Object.hasOwn(jobs[0], 'isolatedFiles'), false)
  assert.equal(action.isolatedRunner, undefined)
})
