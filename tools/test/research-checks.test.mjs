// Mechanical checks: table rows or code become a pinned grading module with
// fixtures. The generated files are written to a retained scratch directory
// (printed below, never removed) and run there as the exported CLI would.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { CHECKS_GRADER_FILE, CUSTOM_GRADER_FILE, checksFiles, checksGrading, checksProblems, evaluateFixtures, normalizeChecksDraft, runMechanicalChecks } from '../../src/research-checks.mjs'

const table = () => normalizeChecksDraft({ mode: 'table', checks: [
  { name: 'Has a python block', kind: 'regex', pattern: '```python' },
  { name: 'No apologies', kind: 'not-regex', pattern: 'sorry', flags: 'i', required: false, weight: 0.5 },
  { name: 'Short', kind: 'max-chars', expected: '5000' },
  { name: 'Answer value', kind: 'json-path', path: 'answer.value', expected: '42' },
], fixtures: [
  { name: 'good', output: '{"answer":{"value":42},"code":"```python\\nprint(1)\\n```"}', expect: 'pass' },
  { name: 'bad', output: 'sorry, no code', expect: 'fail' },
] })

test('rows normalize with ids, kinds and weights; the checks grade an output deterministically', () => {
  const draft = table()
  assert.deepEqual(draft.checks.map(check => check.id), ['has-a-python-block', 'no-apologies', 'short', 'answer-value'])
  const grade = runMechanicalChecks(draft.checks, '{"answer":{"value":42},"code":"```python\\nprint(1)\\n```"}', null)
  assert.equal(grade.passed, true); assert.equal(grade.score, 1); assert.equal(grade.classification, 'all-checks-pass')
  const partial = runMechanicalChecks(draft.checks, 'sorry ```python x``` {"answer":{"value":42}}', null)
  assert.equal(partial.passed, false, 'invalid JSON fails the required path check')
  assert.equal(partial.classification, 'required-check-failed')
  assert.deepEqual(partial.checks.map(check => check.passed), [true, false, true, false])
  assert.equal(partial.score, Math.round(2 / 3.5 * 10000) / 10000, 'weights count')
  const optional = runMechanicalChecks([{ id: 'a', kind: 'contains', expected: 'x', required: false }], 'y', null)
  assert.deepEqual([optional.passed, optional.score, optional.classification], [true, 0, 'optional-check-failed'], 'optional checks move the score, never the verdict')
  assert.equal(runMechanicalChecks([{ id: 'e', kind: 'expected' }], '5', '5').passed, true)
  assert.equal(runMechanicalChecks([], 'anything', null).classification, 'no-checks')
})

test('fixtures are evaluated live for table rows and problems name what is missing', () => {
  assert.deepEqual(evaluateFixtures(table()).map(fixture => [fixture.name, fixture.ok]), [['good', true], ['bad', true]])
  assert.deepEqual(checksProblems(table()), [])
  const broken = checksProblems({ mode: 'table', checks: [{ name: 'A', kind: 'regex', pattern: '(' }, { name: 'B', kind: 'contains' }, { name: 'C', kind: 'json-path', expected: '1' }], fixtures: [{ name: 'f', output: 'x', expect: 'pass' }] })
  assert.deepEqual(broken.map(problem => problem.kind), ['pattern', 'expected', 'path', 'fixture'])
  assert.deepEqual(checksProblems({ mode: 'table' }).map(problem => problem.kind), ['empty'])
  assert.deepEqual(checksProblems({ mode: 'table', checks: [{ name: 'Soft', kind: 'contains', expected: 'x', required: false }] }).map(problem => problem.kind), ['no-required'])
  assert.match(checksProblems({ mode: 'code', code: 'export const x = 1' })[0].text, /export a function named grade/)
  assert.deepEqual(checksProblems({ mode: 'code', code: 'export async function grade() { return { passed: true, score: 1 } }' }), [])
  assert.equal(evaluateFixtures({ mode: 'code', code: 'x', fixtures: [{ name: 'f', output: 'o' }] })[0].ok, null, 'code fixtures are checked on the run computer')
})

test('the generated grader and fixture runner work as files, for table rows and for pasted code', t => {
  const root = join('/tmp/te-research-tests', 'checks-' + Date.now() + '-' + process.pid)
  t.diagnostic('retained scratch directory: ' + root)
  for (const [name, draft] of [['table', table()], ['code', normalizeChecksDraft({ mode: 'code', code: 'export function grade(project, task, output) { return { passed: /ok/.test(output), score: /ok/.test(output) ? 1 : 0 } }\n', fixtures: [{ name: 'yes', output: 'ok', expect: 'pass' }, { name: 'no', output: 'nope', expect: 'fail' }, { name: 'wrong', output: 'ok', expect: 'fail' }] })]]) {
    const directory = join(root, name), files = checksFiles(draft)
    mkdirSync(join(directory, 'checks'), { recursive: true })
    for (const [path, contents] of Object.entries(files)) writeFileSync(join(directory, path), contents)
    assert.equal(checksGrading(draft).file, name === 'table' ? CHECKS_GRADER_FILE : CUSTOM_GRADER_FILE)
    assert.ok(Object.keys(files).includes(checksGrading(draft).file))
    const ran = spawnSync(process.execPath, ['checks/run-fixtures.mjs'], { cwd: directory, encoding: 'utf8', timeout: 30000 })
    if (name === 'table') { assert.equal(ran.status, 0, ran.stderr); assert.match(ran.stdout, /2 fixtures, 0 missed/) }
    else { assert.equal(ran.status, 1, 'a fixture that gets the wrong verdict fails the run'); assert.match(ran.stdout, /MISS wrong: expects fail, gets pass/); assert.match(ran.stdout, /3 fixtures, 1 missed/) }
  }
  const grader = spawnSync(process.execPath, ['--input-type=module', '-e', "import { grade } from './checks/mechanical.mjs'; console.log(JSON.stringify(await grade({}, { expected: null }, 'sorry')))"], { cwd: join(root, 'table'), encoding: 'utf8', timeout: 30000 })
  assert.equal(grader.status, 0, grader.stderr)
  const result = JSON.parse(grader.stdout)
  assert.equal(result.passed, false); assert.equal(result.classification, 'required-check-failed'); assert.equal(result.checks.length, 4)
})
