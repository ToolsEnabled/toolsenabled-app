// Synthetic apparatus controls only. These records are never investigator approval.
import { informationFixture } from './research-benchmark-information.mjs'
import { developmentDraft } from './research-benchmark-development.mjs'
import { createReviewRecord } from '../../../src/benchmark/prompts.mjs'
import { compileTask } from '../../../src/benchmark/tasks.mjs'
import { createTaskReviewRecord } from '../../../src/benchmark/information.mjs'
import { observationPlanFromSpec } from '../../../src/benchmark/observations.mjs'
import { workflowDraft } from '../../../src/benchmark/workflow.mjs'

export const contextReviewer = 'SYNTHETIC INFORMATION CONTEXT CONTROL; NO INVESTIGATOR APPROVAL'
export const contextReviewTime = '2026-09-09T00:00:00.000Z'
export async function reviewInformationFixture(spec) {
  spec.requireReview = true
  spec.reviews = await Promise.all(spec.catalog.map(bundle => createReviewRecord(spec.catalog, bundle.id, contextReviewer, { at: contextReviewTime })))
  spec.taskReviews = [await createTaskReviewRecord(await compileTask(spec, spec.tasks[0], { requireTaskReview: false }), contextReviewer, contextReviewTime)]
  return spec
}
export async function informationContextFixture({ workflow = true, review = true } = {}) {
  const spec = developmentDraft(informationFixture())
  spec.id = 'information-context-control'
  spec.name = 'Synthetic information context regression'
  spec.protocol.maxTotalAttempts = 2
  spec.protocol.maxDurationMs = 60000
  spec.conditions = ['control', 'treatment'].map(id => ({
    id, model: { provider: 'fixture', id: 'saved-context-control', settings: { temperature: 0, enabled: false, optional: null, label: '0' } },
    collection: { comparisonUnit: 'apparatus', instructions: { system: null, developer: null }, tools: [{ name: 'inspect', description: 'Synthetic declared tool; no actual tool is called.' }],
      contextConstruction: workflow ? 'frozen-workflow-projection' : 'frozen-public-request', sessionIsolation: workflow ? 'fresh-call-requested' : 'fresh-request' },
    adapter: workflow ? { kind: 'replay', mode: 'envelope', responses: {}, workflowResponses: { 'number-task': {
      answer: { output: { answer: 1 }, workflow: { toolCalls: [] } }, finish: { output: { answer: 1 }, workflow: { toolCalls: [] } },
    } } } : { kind: 'replay', responses: { 'number-task': 1 } },
    ...(workflow ? { workflowId: id + '-flow' } : {}),
  }))
  if (workflow) {
    spec.observationPlan = observationPlanFromSpec()
    const base = workflowDraft(spec).plan.workflows[0]
    base.budgets.maxCalls = 2
    base.stages[0].next.otherwise = 'finish'
    base.stages[0].resultPath = ['answer']
    base.stages.push({ ...structuredClone(base.stages[0]), id: 'finish', parents: [{ stageId: 'answer', path: ['answer'] }], next: { branches: [], otherwise: null } })
    spec.workflowPlan = { version: 1, workflows: spec.conditions.map(condition => ({ ...structuredClone(base), id: condition.workflowId,
      purpose: 'treatment', rationale: 'Synthetic declared disclosure context; no scientific interpretation claim.' })) }
  }
  return review ? reviewInformationFixture(spec) : spec
}
