// A benchmark ToolsEnabled did not write, living entirely outside src/.
//
// This is the same shape as src/benchmark/lean-plugin.mjs -- a module that
// declares a benchmark to registry.mjs and nothing more -- except that it is
// NOT in the tree the core can import, is not listed in plugins.mjs, and is not
// in RUNTIME_FILES. Nothing under src/benchmark/ mentions SQL, `sql-bench` or
// `sql-compare`. That is the point: if the core has to learn any of those three
// names for the admission suite to pass, the seam has regressed.
//
// It is deliberately neither of the two domains the core used to allowlist. It
// is not `lean-bench` (so it inherits none of the vertical's branches) and it is
// not `generic` (so it inherits none of the core's own domain's affordances).
//
// Registration is a MODULE SIDE EFFECT, exactly as lean-plugin.mjs does it,
// because that is what a third party actually writes. `SQL_BENCHMARK` is also
// exported so a suite that calls resetRegistry() can put it back: ESM caches a
// module, so a second import would not re-run the side effect.
import { registerBenchmark } from '../../../src/benchmark/registry.mjs'
import { declareExtractionPolicy } from '../../../src/benchmark/extraction.mjs'
import { invariant } from '../../../src/benchmark/prompts.mjs'

export const SQL_BENCHMARK_ID = 'sql-bench-thirdparty'
export const SQL_DOMAIN = 'sql-bench'

// Its own extraction rule, and deliberately not the core default and not Lean
// Bench's. Lean froze pick:'only'/prose:'refuse'; this one explains first and
// takes the LAST fenced block, so a reply that satisfies one refuses under the
// other. A test can therefore tell which policy actually governed.
export const SQL_EXTRACTION_POLICY = declareExtractionPolicy({
  mode: 'fenced', language: 'sql', label: 'SQL', pick: 'last', prose: 'allow',
  note: 'Third-party benchmark: reason first, then give the final query.',
})

// Its own grading contract. The core implements exact/json/judge-audit/module/
// resource-action-plan; `sql-compare` is this benchmark's, and its precondition
// belongs to whoever implemented it rather than to the core.
//
// assertReady IS A THUNK: study.mjs calls it while validating a study.
export const SQL_GRADING_KIND = Object.freeze({
  value: 'sql-compare',
  title: 'SQL comparison',
  label: 'Normalised SQL comparison',
  help: 'Compares the returned query after normalising whitespace and case. Declare environment.sqlDialect so the normalisation rule is frozen with the study.',
  assertReady: spec => invariant(typeof spec.environment?.sqlDialect === 'string' && spec.environment.sqlDialect.trim(),
    'Declare environment.sqlDialect before freezing SQL comparison grading.'),
})

export const SQL_DESCRIPTOR = Object.freeze({
  id: SQL_BENCHMARK_ID,
  label: 'SQL Bench (third party)',
  domains: [SQL_DOMAIN],
  // No `fallback` and no `firstParty`. Omitting firstParty is what puts this
  // study under readiness' third-party-declared-endpoint profile instead of one
  // of the profiles that carry ToolsEnabled's own scientific admission.
  matches: spec => spec?.domain === SQL_DOMAIN,
  extraction: SQL_EXTRACTION_POLICY,
  gradingKinds: [SQL_GRADING_KIND],
  // Its own frozen configuration key. readiness.mjs used to allow only a fixed
  // list of core keys plus Lean Bench's own, so this line is what makes the
  // study runnable rather than merely freezable.
  environmentKeys: ['sqlDialect'],
  page: { fields: ['combinations'] },
  // create IS A THUNK, and it imports dynamically, so listing starters costs
  // nothing and this module's own import graph stays two files wide.
  starters: [{ id: 'sql-basic', label: 'SQL Bench: single-table counts', create: () => newSqlBenchDraft() }],
})

// The side effect. A third party's plugin module does exactly this line.
export const SQL_BENCHMARK = registerBenchmark(SQL_DESCRIPTOR)

// Re-register after a resetRegistry(). Importing this module again would not,
// because ESM runs a module body once per process.
export function registerSqlBench() {
  return registerBenchmark(SQL_DESCRIPTOR)
}

// The draft a suite freezes. Built here rather than in the test so the starter
// thunk above and the suite freeze the same study. `starters.mjs` is imported
// dynamically because a starter's `create` must stay free of work at
// registration time.
export async function newSqlBenchDraft() {
  const { newExperimentDraft, genericStarter } = await import('../../../src/benchmark/starters.mjs')
  return sqlBenchDraft(newExperimentDraft(genericStarter(), { initializePopulation: true }))
}

// A reply shaped the way this benchmark's declared policy expects and Lean
// Bench's does not: prose first, then the final fenced block.
export const SQL_FENCED_REPLY = 'Count every row in the table.\n\n```sql\nSELECT COUNT(*) FROM orders;\n```'

export function sqlBenchDraft(draft) {
  invariant(draft, 'sqlBenchDraft needs the generic experiment draft to build on; see the admission suite.')
  draft.id = 'sql-bench-study'
  draft.name = 'SQL Bench'
  draft.domain = SQL_DOMAIN
  draft.environment = { ...(draft.environment || {}), sqlDialect: 'ansi-1999' }
  draft.catalog = [{
    id: 'ask', version: '1', kind: 'atom', role: 'node',
    text: 'Write one SQL query that answers: {{question}}',
    parameters: { question: 'how many rows are in orders?' },
    semantics: { kind: 'sql-ask', question: '{{question}}' },
  }]
  draft.tasks = [
    { id: 'count-orders', root: { use: 'ask' }, input: null, expected: 'SELECT COUNT(*) FROM orders;', split: 'development' },
    { id: 'count-users', root: { use: 'ask', params: { question: 'how many rows are in users?' } }, input: null, expected: 'SELECT COUNT(*) FROM users;', split: 'held-out' },
  ]
  draft.conditions = [{
    ...draft.conditions[0],
    adapter: { kind: 'replay', responses: {
      'count-orders': 'SELECT COUNT(*) FROM orders;',
      'count-users': 'SELECT COUNT(*) FROM users;',
    } },
  }]
  return draft
}
