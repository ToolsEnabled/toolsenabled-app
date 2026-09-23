import { canonical, invariant, object } from './benchmark/prompts.mjs'
import { applyWorkflowDraft } from './benchmark/workflow.mjs'
import { validateStudy } from './benchmark/study.mjs'

const PROTOCOL_FIELDS = ['protocol', 'conditions', 'inputs', 'environment', 'requireReview', 'decisions']

// These editor groups constrain each other. Validate one private candidate,
// without publishing an invalid intermediate protocol or inventing fixtures.
export function applyWorkflowSetup(spec, draft) {
  invariant(object(draft) && Object.keys(draft).length === 3
    && ['protocolFields', 'workflow', 'observationPlan'].every(key => Object.hasOwn(draft, key)),
  'Workflow setup accepts only protocol fields, the workflow draft and the accounting plan.')
  const { protocolFields, workflow, observationPlan } = draft
  invariant(object(protocolFields) && Object.keys(protocolFields).length === PROTOCOL_FIELDS.length
    && PROTOCOL_FIELDS.every(key => Object.hasOwn(protocolFields, key)),
  'Workflow setup needs exactly the protocol, conditions, inputs, environment, review requirement and study decisions.')
  const staged = JSON.parse(canonical({ spec, protocolFields, workflow, observationPlan }))
  let next = { ...staged.spec, ...staged.protocolFields }
  if (staged.observationPlan === null) delete next.observationPlan
  else next.observationPlan = staged.observationPlan
  next = applyWorkflowDraft(next, staged.workflow)
  validateStudy(next)
  return next
}
