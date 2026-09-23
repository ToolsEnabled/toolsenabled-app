import { STUDY_VERSION } from './study-schema.mjs'
// Version-1 seed retained for exact historical fixture reconstruction. New
// investigator drafts enter through newExperimentDraft and the v2 contract.
export function genericStarter() {
  return {
    schemaVersion: 1, id: 'my-benchmark', name: 'My benchmark', domain: 'generic', requireReview: false,
    catalog: [
      { id: 'task', version: '1', kind: 'atom', role: 'node', text: 'Return only the result of {{a}} + {{b}}.', parameters: { a: 2, b: 3 }, semantics: { kind: 'addition', a: '{{a}}', b: '{{b}}' } },
      { id: 'context', version: '1', kind: 'template', role: 'node', text: '{{instruction}}\n\n{{slot:task}}', parameters: { instruction: 'Answer the task precisely.' }, slots: { task: 'node' }, semantics: { kind: 'prompt' } },
    ],
    tasks: [
      { id: 'addition-a', root: { use: 'context', slots: { task: { use: 'task' } } }, input: null, expected: '5', split: 'development' },
      { id: 'addition-b', root: { use: 'context', slots: { task: { use: 'task', params: { a: 7, b: 4 } } } }, input: null, expected: '11', split: 'held-out' },
    ],
    conditions: [{ id: 'recorded', label: 'Known responses', model: { provider: 'fixture', id: 'arithmetic-v1', settings: {} }, adapter: { kind: 'replay', responses: { 'addition-a': '5', 'addition-b': '11' } } }],
    protocol: { seed: 42, replicates: 1, maxAttemptsPerTrial: 1, maxTotalAttempts: 100, timeoutMs: 60000, maxDurationMs: 1800000,
      grading: { kind: 'exact' }, selection: 'All frozen tasks; first completed attempt. Transport failures alone may retry.', stopping: 'Stop at the fixed attempt or elapsed-time budget.', analysis: 'Per-condition scores over completed trials; report scheduled, failed, interrupted, and pending counts separately.' },
    inputs: [], environment: { node: '>=22', dependencies: [], instructions: 'No installation is required for the replay runner. Declare and pin any external tools and datasets before a counted study.' },
    analysisPlan: { version: 1, cohort: 'qualification', primaryDenominator: 'scheduled', uncertainty: null, contrasts: [], multiplicity: 'none-descriptive',
      rationale: 'These recorded responses check consistency with an authored answer key. They do not independently qualify that key. Report every scheduled trial and keep unmeasured dispositions visible.' },
    decisions: 'Replace the starter tasks, conditions, scoring, and study decisions with your protocol.'
  }
}

export function newExperimentDraft(source = genericStarter(), { purpose = 'experiment', initializePopulation = false } = {}) {
  const draft = structuredClone(source)
  draft.schemaVersion = STUDY_VERSION
  draft.executionPlan = { version: 1, purpose, ...(purpose === 'experiment' ? { design: {
    schedule: 'crossed-task-condition', replicates: 'repeated-measurements', primaryOutcome: 'binary-pass',
    dependence: draft.analysisPlan?.uncertainty?.kind === 'family-bootstrap' ? 'family-clusters' : 'descriptive-only',
  } } : {}) }
  // A newly selected starter displays this population explicitly. An imported
  // design must supply its missing population rather than receive an upgrade.
  if (initializePopulation && draft.analysisPlan && draft.analysisPlan.primaryPopulation === undefined) draft.analysisPlan.primaryPopulation = 'all'
  return draft
}
