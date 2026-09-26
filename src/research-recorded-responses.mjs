import { invariant } from './benchmark/prompts.mjs'

// Discard saved outputs, preserving the declared response interpretation and
// workflow configuration. This authoring operation provides no fresh evidence.
export function resetRecordedResponses(conditions) {
  invariant(Array.isArray(conditions), 'Recorded response reset needs a condition list.')
  const reset = conditions.map(condition => condition?.adapter?.kind === 'replay'
    ? { ...condition, adapter: { ...condition.adapter, responses: {},
      ...(condition.adapter.workflowResponses !== undefined ? { workflowResponses: {} } : {}) } }
    : condition)
  // Clone after removing discarded payloads, so large obsolete response pools
  // are not copied again. Remaining configuration has no caller-owned aliases.
  return structuredClone(reset)
}
