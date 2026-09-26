// Mechanical checks: deterministic grading the researcher writes as table rows
// (a pattern, an exact text, a JSON value at a path, a length) or as code (a
// module exporting grade(project, task, output)). Either way the result is a
// pinned grading module under checks/ in the frozen input manifest, run by the
// exported CLI's module host, plus fixtures (an output and the verdict it must
// get) the page evaluates for table rows and the run computer evaluates with
// node checks/run-fixtures.mjs. Nothing here is a judge: no model reads anything.
const text = value => String(value ?? '').trim()
const slug = value => text(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
export const CHECK_LIMIT = 32
export const FIXTURE_LIMIT = 32
export const CHECK_CODE_LIMIT = 200000
export const CHECK_KINDS = Object.freeze([
  ['regex', 'Matches a pattern', 'pattern'],
  ['not-regex', 'Does not match a pattern', 'pattern'],
  ['contains', 'Contains the text', 'expected'],
  ['exact', 'Equals the text exactly', 'expected'],
  ['expected', "Equals the task's expected answer", 'none'],
  ['json-valid', 'Is valid JSON', 'none'],
  ['json-path', 'A JSON value at a path equals the expected value', 'path'],
  ['max-chars', 'Is at most this many characters', 'expected'],
])
export const CHECKS_GRADER_FILE = 'checks/mechanical.mjs'
export const CUSTOM_GRADER_FILE = 'checks/custom-grader.mjs'
export function emptyCheck() { return { id: '', name: '', kind: 'regex', pattern: '', flags: '', expected: '', path: '', required: true, weight: 1 } }
export function emptyFixture() { return { name: '', output: '', expected: '', expect: 'pass' } }
export function emptyChecksDraft() { return { version: 1, mode: 'table', checks: [], fixtures: [], code: '' } }
export function normalizeCheck(raw, index) {
  if (!raw || typeof raw !== 'object') return null
  const check = emptyCheck()
  check.name = text(raw.name).slice(0, 80)
  check.id = /^[a-z][a-z0-9_-]{0,39}$/.test(text(raw.id)) ? text(raw.id) : slug(raw.id || check.name) || 'check-' + (index + 1)
  check.kind = CHECK_KINDS.some(([id]) => id === raw.kind) ? raw.kind : 'regex'
  check.pattern = String(raw.pattern ?? '').slice(0, 2000)
  check.flags = text(raw.flags).replace(/[^imsu]/g, '').slice(0, 4)
  check.expected = String(raw.expected ?? '').slice(0, 20000)
  check.path = text(raw.path).slice(0, 400)
  check.required = raw.required !== false
  const weight = Number(raw.weight)
  check.weight = Number.isFinite(weight) && weight > 0 && weight <= 100 ? weight : 1
  return check
}
export function normalizeChecksDraft(raw) {
  const draft = emptyChecksDraft()
  if (!raw || typeof raw !== 'object') return draft
  draft.mode = raw.mode === 'code' ? 'code' : 'table'
  const ids = new Set()
  for (const check of (Array.isArray(raw.checks) ? raw.checks : []).slice(0, CHECK_LIMIT).map(normalizeCheck)) if (check && !ids.has(check.id)) { ids.add(check.id); draft.checks.push(check) }
  draft.fixtures = (Array.isArray(raw.fixtures) ? raw.fixtures : []).slice(0, FIXTURE_LIMIT).filter(item => item && typeof item === 'object')
    .map(item => ({ name: text(item.name).slice(0, 80), output: String(item.output ?? '').slice(0, 20000), expected: String(item.expected ?? '').slice(0, 20000), expect: item.expect === 'fail' ? 'fail' : 'pass' }))
  draft.code = String(raw.code ?? '').slice(0, CHECK_CODE_LIMIT)
  return draft
}

// Runs the checks against one output. Free of outside references so the
// generated grading module embeds this very function; `expected` is the
// task's expected answer (a string, JSON, or null).
export function runMechanicalChecks(checks, output, expected) {
  const s = typeof output === 'string' ? output : output == null ? '' : JSON.stringify(output)
  const results = []
  let weight = 0, earned = 0, requiredFailed = 0, optionalFailed = 0
  for (const check of Array.isArray(checks) ? checks : []) {
    let passed = false, detail = ''
    try {
      if (check.kind === 'regex' || check.kind === 'not-regex') { const hit = new RegExp(String(check.pattern || ''), String(check.flags || '')).test(s); passed = check.kind === 'regex' ? hit : !hit; detail = hit ? 'pattern matched' : 'pattern did not match' }
      else if (check.kind === 'contains') { passed = s.indexOf(String(check.expected || '')) >= 0; detail = passed ? 'text found' : 'text not found' }
      else if (check.kind === 'exact') { passed = s === String(check.expected || ''); detail = passed ? 'equal' : 'differs' }
      else if (check.kind === 'expected') { const want = typeof expected === 'string' ? expected : expected == null ? '' : JSON.stringify(expected); passed = s === want; detail = passed ? 'equals the expected answer' : 'differs from the expected answer' }
      else if (check.kind === 'json-valid') { JSON.parse(s); passed = true; detail = 'valid JSON' }
      else if (check.kind === 'json-path') {
        let value = JSON.parse(s)
        for (const part of String(check.path || '').split('.').filter(Boolean)) value = value == null ? undefined : value[/^\d+$/.test(part) ? Number(part) : part]
        let want; try { want = JSON.parse(String(check.expected)) } catch (error) { want = String(check.expected) }
        passed = JSON.stringify(value) === JSON.stringify(want); detail = passed ? 'value equals' : 'value is ' + (value === undefined ? 'absent' : JSON.stringify(value).slice(0, 80))
      }
      else if (check.kind === 'max-chars') { const max = Number(check.expected); passed = Number.isFinite(max) && s.length <= max; detail = s.length + ' characters' }
      else detail = 'unknown check kind ' + String(check.kind)
    } catch (error) { passed = false; detail = String(error && error.message || error).slice(0, 120) }
    const w = Number(check.weight) > 0 ? Number(check.weight) : 1
    weight += w; if (passed) earned += w
    if (!passed) { if (check.required !== false) requiredFailed++; else optionalFailed++ }
    results.push({ id: check.id, name: check.name, kind: check.kind, required: check.required !== false, passed, detail })
  }
  const score = weight ? Math.round(earned / weight * 10000) / 10000 : 0
  const passed = results.length > 0 && requiredFailed === 0
  return { passed, score, classification: !results.length ? 'no-checks' : requiredFailed ? 'required-check-failed' : optionalFailed ? 'optional-check-failed' : 'all-checks-pass', checks: results }
}
export function evaluateFixtures(draft) {
  const current = normalizeChecksDraft(draft)
  if (current.mode !== 'table') return current.fixtures.map(fixture => ({ name: fixture.name, expect: fixture.expect, actual: null, ok: null, detail: 'Code graders are checked on the run computer: node checks/run-fixtures.mjs' }))
  return current.fixtures.map(fixture => {
    const grade = runMechanicalChecks(current.checks, fixture.output, fixture.expected || null), actual = grade.passed ? 'pass' : 'fail'
    return { name: fixture.name, expect: fixture.expect, actual, ok: actual === fixture.expect, detail: grade.checks.filter(check => !check.passed).map(check => (check.name || check.id) + ': ' + check.detail).join('; ') || 'every check passed' }
  })
}
export function checksProblems(draft) {
  const current = normalizeChecksDraft(draft), problems = []
  if (current.mode === 'table') {
    if (!current.checks.length) problems.push({ kind: 'empty', text: 'Add at least one check, or switch to code.' })
    else if (!current.checks.some(check => check.required)) problems.push({ kind: 'no-required', text: 'No check is required, so every response passes; mark at least one check as required.' })
    current.checks.forEach((check, index) => {
      const label = check.name || check.id || 'Check ' + (index + 1), needs = CHECK_KINDS.find(([id]) => id === check.kind)[2]
      if (needs === 'pattern') { if (!check.pattern) problems.push({ kind: 'pattern', index, text: label + ' needs a pattern.' }); else { try { new RegExp(check.pattern, check.flags) } catch (error) { problems.push({ kind: 'pattern', index, text: label + ': the pattern is not a valid regular expression: ' + error.message }) } } }
      if (needs === 'expected' && !check.expected) problems.push({ kind: 'expected', index, text: label + ' needs the text or number to compare with.' })
      if (needs === 'path' && !check.path) problems.push({ kind: 'path', index, text: label + ' needs a JSON path such as answer.value.' })
    })
  } else {
    if (!current.code.trim()) problems.push({ kind: 'code', text: 'Paste the grading module: it must export grade(project, task, output).' })
    else if (!/export\s+(?:async\s+)?function\s+grade\b|export\s+(?:const|let)\s+grade\b|export\s*\{[^}]*\bgrade\b/.test(current.code)) problems.push({ kind: 'code', text: 'The module must export a function named grade(project, task, output) that returns { passed, score }.' })
  }
  for (const fixture of evaluateFixtures(current)) if (fixture.ok === false) problems.push({ kind: 'fixture', text: 'Fixture ' + (fixture.name || '(unnamed)') + ' expects ' + fixture.expect + ' but gets ' + fixture.actual + ': ' + fixture.detail })
  return problems
}
export function checksGrading(draft) {
  const current = normalizeChecksDraft(draft)
  return { kind: 'module', file: current.mode === 'code' ? CUSTOM_GRADER_FILE : CHECKS_GRADER_FILE }
}
// The pinned files: the grader, the fixtures and the fixture runner.
export function checksFiles(draft) {
  const current = normalizeChecksDraft(draft), files = {}
  const fixtures = current.fixtures.map(fixture => ({ name: fixture.name, output: fixture.output, expected: fixture.expected || null, expect: fixture.expect }))
  if (current.mode === 'code') files[CUSTOM_GRADER_FILE] = current.code.replace(/\r\n/g, '\n').replace(/\n?$/, '\n')
  else files[CHECKS_GRADER_FILE] = [
    '// Generated by the Research page (Protocol → Scoring → Mechanical checks). Pinned in the frozen input manifest;',
    '// the exported CLI runs grade(project, task, output) in its module host. No network, no model, no randomness.',
    'export const CHECKS = ' + JSON.stringify(current.checks, null, 1),
    'export ' + runMechanicalChecks.toString(),
    'export async function grade(project, task, output) { return runMechanicalChecks(CHECKS, output, task && task.expected !== undefined ? task.expected : null) }',
    '',
  ].join('\n')
  files['checks/fixtures.json'] = JSON.stringify(fixtures, null, 1) + '\n'
  files['checks/run-fixtures.mjs'] = [
    '// Generated by the Research page. Runs the pinned grader against the registered fixtures:',
    '//   node checks/run-fixtures.mjs',
    '// Exits non-zero when a fixture does not get the verdict registered for it.',
    "import { readFileSync } from 'node:fs'",
    "import { grade } from './" + (current.mode === 'code' ? 'custom-grader.mjs' : 'mechanical.mjs') + "'",
    "const fixtures = JSON.parse(readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8'))",
    'let missed = 0',
    'for (const fixture of fixtures) {',
    '  const result = await grade({}, { expected: fixture.expected }, fixture.output), actual = result && result.passed ? \'pass\' : \'fail\', ok = actual === fixture.expect',
    '  if (!ok) missed++',
    "  console.log((ok ? 'ok   ' : 'MISS ') + fixture.name + ': expects ' + fixture.expect + ', gets ' + actual)",
    '}',
    "console.log(fixtures.length + ' fixtures, ' + missed + ' missed')",
    'process.exit(missed ? 1 : 0)',
    '',
  ].join('\n')
  return files
}
