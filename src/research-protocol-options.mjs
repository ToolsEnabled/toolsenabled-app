// Presentation only: keep the registered field ids, defaults and frozen text
// intact so existing studies and generated harnesses retain their meaning.
import { effectiveValue, normalizeProtocolDecisions, protocolField } from './research-protocol.mjs'

const group = (id, title, fields, extra = {}) => ({ id, title, fields: fields.split(' '), ...extra })
export const PROTOCOL_OPTION_SECTIONS = [
  { id: 'study', title: 'Study design and registration', groups: [
    group('registration', 'Registration', 'study-kind hypotheses-first scope-closed owner-gates'),
    group('provenance', 'Versioning and retention', 'push-daily keep-everything dated-amendments version-bump docs-current'),
    group('eligibility', 'Prompts and task eligibility', 'frozen-hash growth-rule admission-gate fair-readings'),
  ] },
  { id: 'collection', title: 'Collection and environment', groups: [
    group('isolation', 'Isolation', 'cleanroom direct-cli second-home env-allowlist no-shell safe-paths'),
    group('preflight', 'Preflight validation', 'canary-required canary-cadence canary-scope canary-sides certificate'),
    group('model-contract', 'Model and response limits', 'exact-ids symmetric output-cap max-turns dead-surface decoding-contract'),
    group('evidence', 'Evidence to retain', 'isolation-record argv-record served-model stage-instrumentation'),
    group('funding', 'Funding', 'funding'),
  ] },
  { id: 'scheduling', title: 'Scheduling and sample sizes', groups: [
    group('concurrency', 'Order and concurrency', 'quota-order lane-order in-flight per-cell engine-workers drop-concurrency single-entry'),
    group('cloud', 'Remote tasks', 'cloud-one-task cloud-attempts'),
    group('sampling', 'Sampling', 'cell-factors n-anchor n-donor n-exploratory completion overdraw'),
  ] },
  { id: 'failures', title: 'Failures and retries', groups: [
    group('interruptions', 'Interrupted attempts', 'fairness provider-notices truncation infra-not-model unreachable quota-attrition auth-outage', { preset: 'interruptions' }),
    group('retry-selection', 'Retry and response selection', 'engine-retry late-response no-best-of-k', { preset: 'retry-selection' }),
    group('recovery', 'Detection and recovery', 'statuses shape-test resume-key batch-pooling cleanup-nonfatal single-parse safe-ids'),
  ] },
  { id: 'scoring', title: 'Scoring and reference checks', groups: [
    group('reference', 'Reference answers', 'bank-method matching extractor-role bank-verify bank-gate'),
    group('execution', 'Execution checks', 'execution-control stride engine-timeout completion-detect data-coverage'),
    group('data-rules', 'Data freeze policy', 'data-freeze freeze-change'),
    group('classification', 'Response classification', 'extraction ask-rule refusals pass-def strict-and'),
  ] },
  { id: 'reporting', title: 'Analysis and reporting', groups: [
    group('analysis', 'Measures and uncertainty', 'primary-measure uncertainty tests family-units subsets formal-claims'),
    group('reporting', 'Reporting requirements', 'counts-reported separation resources deviations'),
  ] },
  { id: 'judging', title: 'Judges and external audit', groups: [
    group('judges', 'Judge evaluation', 'judge-threshold judge-pool hitl'),
    group('audit', 'External judge audit', 'audit-included refs-k determinacy repair canonical-defaults ambiguity-taxonomy judge-replication stability paid-budget'),
  ] },
]

export const PROTOCOL_PRESETS = {
  interruptions: {
    label: 'Interruption policy',
    options: [
      { id: 'exclude-retry', label: 'Exclude interrupted attempts and retry', values: { fairness: 'yes', 'provider-notices': 'never', truncation: 'harness-error', 'infra-not-model': 'yes', unreachable: 'yes', 'quota-attrition': 'yes', 'auth-outage': 'yes' } },
      { id: 'as-outcomes', label: 'Retain interruptions as model outcomes', values: { fairness: 'no', 'provider-notices': 'no-program', truncation: 'no-program', 'infra-not-model': 'no', unreachable: 'no', 'quota-attrition': 'no', 'auth-outage': 'no' } },
    ],
  },
  'retry-selection': {
    label: 'Retry policy',
    options: [
      { id: 'fixed', label: 'Retry infrastructure errors; use a fixed response rule', values: { 'engine-retry': 'harness-error', 'late-response': 'fixed-rule', 'no-best-of-k': 'yes' } },
      { id: 'best', label: 'Retry any failure; choose the best response', values: { 'engine-retry': 'all', 'late-response': 'best', 'no-best-of-k': 'no' } },
    ],
  },
}

export function protocolPresetValue(state, id) {
  return PROTOCOL_PRESETS[id]?.options.find(preset => Object.entries(preset.values).every(([field, value]) => effectiveValue(state, protocolField(field)) === value))?.id || 'custom'
}

export function withProtocolPreset(state, id, value) {
  const next = normalizeProtocolDecisions(state)
  const preset = PROTOCOL_PRESETS[id]?.options.find(option => option.id === value)
  if (preset) Object.assign(next.values, preset.values)
  return next
}

export const PROTOCOL_ORIGIN_LABELS = { owner: 'Recorded decision', measured: 'Observed issue', registry: 'Imported protocol', proposal: 'Proposal', assumed: 'Assumption' }

// Short control labels; the original registered wording remains available in
// each option's details and is still used in the frozen decisions record.
export const PROTOCOL_OPTION_LABELS = {
  'study-kind': 'Study type', 'hypotheses-first': 'Register hypotheses before collection', 'scope-closed': 'Require approval for scope changes',
  'push-daily': 'Publish commits daily', 'keep-everything': 'Retain excluded and superseded records', 'dated-amendments': 'Hash artifacts and record amendments',
  'owner-gates': 'Actions requiring approval', 'frozen-hash': 'Verify prompt hashes for each attempt', 'growth-rule': 'Task-set expansion',
  'admission-gate': 'Screen tasks before collection', 'fair-readings': 'Require reviewed admissible interpretations',
  cleanroom: 'Use an isolated collection environment', 'canary-required': 'Require a passing preflight check', 'canary-cadence': 'Validation frequency',
  'canary-scope': 'Validation scope', 'canary-sides': 'Validation method', certificate: 'Attach validation evidence to each batch',
  'env-allowlist': 'Allowed environment variables', 'isolation-record': 'Record environment isolation', funding: 'Funding policy',
  'direct-cli': 'Launch collectors directly', 'second-home': 'Separate account environments', 'exact-ids': 'Require exact model IDs',
  symmetric: 'Require comparable collection surfaces', 'argv-record': 'Record commands and diagnostics', 'no-shell': 'Spawn collectors without a shell',
  'output-cap': 'Output token limit', 'max-turns': 'Turns per attempt', 'served-model': 'Record the served model', 'dead-surface': 'Unavailable collection surface',
  'quota-order': 'Collection order', 'lane-order': 'Lane order of record', 'in-flight': 'Concurrent cells', 'per-cell': 'Serialize attempts within each cell',
  'engine-workers': 'Execution workers', 'drop-concurrency': 'Reduce concurrency after errors', 'single-entry': 'Prevent duplicate starts',
  'cloud-one-task': 'Use one remote task per attempt', 'cloud-attempts': 'Remote attempt ladder', statuses: 'Response status labels',
  fairness: 'Exclude unfinished attempts and retry', 'provider-notices': 'Provider error notices', 'shape-test': 'Detect provider notices by response shape',
  truncation: 'Truncated responses', 'resume-key': 'Resume identifier', 'batch-pooling': 'Batch accounting', 'engine-retry': 'Eligible execution retries',
  'late-response': 'Choose among multiple responses', unreachable: 'Exclude unreachable tasks from outcomes', 'cleanup-nonfatal': 'Keep results after cleanup errors',
  'cell-factors': 'Cell factors', 'n-anchor': 'Samples per control cell', 'n-donor': 'Samples per auxiliary cell', 'n-exploratory': 'Samples per exploratory cell',
  completion: 'Completion target', overdraw: 'Extra samples', tests: 'Registered tests and thresholds', 'bank-method': 'Enumerate registered implementation choices',
  matching: 'Reference matching', 'extractor-role': 'Extractor authority', 'bank-verify': 'Verify reference integrity', 'execution-control': 'Run positive and repeatability controls',
  stride: 'Repeatability check interval', 'data-freeze': 'Freeze data before reference execution', 'freeze-change': 'Changes to frozen data',
  'engine-timeout': 'Reference execution timeout', 'completion-detect': 'Execution completion evidence', 'bank-gate': 'Require independent review and execution approval',
  extraction: 'Response extraction', 'ask-rule': 'Clarification classification rule', refusals: 'Refusal and clarification categories', 'pass-def': 'Pass criterion',
  'infra-not-model': 'Separate infrastructure failures from model outcomes', 'no-best-of-k': 'Stop resubmitting completed answers', 'strict-and': 'Require every scoring gate to pass',
  'judge-threshold': 'Judge score threshold', 'judge-pool': 'Judge independence', hitl: 'Use a fixed human-validation sample', 'stage-instrumentation': 'Record stage outcomes and revisions',
  'primary-measure': 'Success denominator', 'counts-reported': 'Report counts at every processing stage', uncertainty: 'Uncertainty method',
  'family-units': 'Account for related variants', separation: 'Report study cohorts separately', resources: 'Report resource use separately', subsets: 'Subset selection',
  deviations: 'Record deviations and reasons', 'formal-claims': 'Formal claims policy', 'audit-included': 'Include an external judge audit',
  'refs-k': 'References per task', determinacy: 'Reference agreement', repair: 'Reference repair policy', 'canonical-defaults': 'Fix reference environment defaults',
  'ambiguity-taxonomy': 'Ambiguity categories', 'judge-replication': 'Replicate the source judge exactly', stability: 'Stability repeats', 'paid-budget': 'Require a hard judging budget',
  'decoding-contract': 'Unsupported decoding parameters', 'quota-attrition': 'Pause and retry after quota limits', 'auth-outage': 'Identify and recover authentication failures',
  'safe-paths': 'Use portable configuration paths', 'single-parse': 'Parse each response once', 'safe-ids': 'Use collision-free file IDs',
  'data-coverage': 'Check required data before execution', 'version-bump': 'Version scoring changes', 'docs-current': 'Keep documentation current',
}

export const PROTOCOL_OPTION_CHOICES = {
  'study-kind': ['Exploratory', 'Confirmatory', 'Apparatus check'], 'growth-rule': ['Reviewed mechanical variants', 'Any reviewed source', 'Open during collection'],
  'canary-cadence': ['Before and after each batch', 'Daily', 'Once per study'], 'canary-scope': ['Each surface independently', 'All surfaces must pass'],
  'canary-sides': ['Positive and negative controls', 'Negative control only'], funding: ['Subscriptions only', 'Approved metered cells', 'Metered API'],
  'dead-surface': ['Document unavailable cells', 'Use a separately labelled substitute'], 'quota-order': ['Lowest effort first, alternate models', 'Registered order', 'As available'],
  'provider-notices': ['Exclude, pause and retry', 'Classify as no program'], truncation: ['Exclude and retry', 'Classify as no program'],
  'resume-key': ['Prompt hash', 'Row index'], 'batch-pooling': ['Count targets across batches', 'One batch per lane'],
  'engine-retry': ['Infrastructure errors only', 'All failures'], 'late-response': ['Predefined selection rule', 'Best available response'],
  completion: ['Per cell', 'Lane totals'], overdraw: ['Keep extra samples', 'Trim to target'], matching: ['Match all registered references', 'Nearest match'],
  'extractor-role': ['Report only', 'Determine classification'], 'freeze-change': ['Rebuild the entire reference bank', 'Rebuild affected cells'],
  'completion-detect': ['Result contents or logs', 'Output file presence'], extraction: ['One shared extraction rule', 'Rules by surface'],
  refusals: ['Combined category', 'Separate categories'], 'pass-def': ['Execution and specified observations agree', 'Execution with any trade'],
  'judge-pool': ['Outside the contestant pool', 'Disclosed overlap'], 'primary-measure': ['Scheduled trials', 'Completed trials'],
  uncertainty: ['Wilson 95% interval', 'Exact binomial', 'Family bootstrap', 'Descriptive only'], subsets: ['Metadata only', 'Outcomes for secondary analyses'],
  'formal-claims': ['Require computed evidence', 'Allow narrative claims'], determinacy: ['Unanimity with dissent adjudication', 'Majority'],
  repair: ['One repair round', 'Until convergence'], 'decoding-contract': ['Use a compatible model tier', 'Drop and disclose the parameter', 'Exclude the model'],
}
