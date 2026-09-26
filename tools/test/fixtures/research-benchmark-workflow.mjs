import { genericStarter } from '../../../src/benchmark/starters.mjs'
import { observationPlanFromSpec } from '../../../src/benchmark/observations.mjs'

export function workflowEnvelope(output, outputTokens = 3, amount = '0.01', toolCalls = []) {
  return { output, identity: { provider: 'fixture', id: 'arithmetic-v1', surface: 'recorded-fixture' }, completion: { status: 'complete', reason: 'synthetic control' },
    usage: { inputTokens: 10, outputTokens, toolCalls: toolCalls.length, generationMs: 1.25, cost: { amount, currency: 'USD' } }, workflow: { toolCalls } }
}
export function workflowFixture() {
  const spec = genericStarter()
  spec.id = 'workflow-controls'; spec.name = 'Frozen prompt workflow controls'
  spec.observationPlan = observationPlanFromSpec()
  spec.observationPlan.identity.policy = 'require-match'; spec.observationPlan.completion.policy = 'require-complete'
  spec.conditions[0].model.surface = 'recorded-fixture'
  spec.conditions[0].collection = { comparisonUnit: 'apparatus', instructions: { system: null, developer: null }, tools: [{ name: 'arithmetic', description: 'Synthetic arithmetic fixture; no external tool is called.', parameters: { type: 'object' } }], contextConstruction: 'Replaced by exact frozen stage projections.', sessionIsolation: 'Independent synthetic response fixtures.' }
  spec.conditions[0].workflowId = 'revise'
  spec.conditions[0].adapter.mode = 'envelope'
  spec.conditions[0].adapter.workflowResponses = {
    'addition-a': { draft: workflowEnvelope({ answer: '5', revise: false, scratch: 'PRIVATE INTERMEDIATE NOTE' }) },
    'addition-b': { draft: workflowEnvelope({ answer: '10', revise: true, scratch: 'DO NOT TRANSFER THIS NOTE' }, 4, '0.02'),
      revise: workflowEnvelope({ answer: '11' }, 5, '0.03', [{ id: 'tool-1', name: 'arithmetic', arguments: { a: 7, b: 4 }, result: 11, status: 'completed' }]) },
  }
  spec.workflowPlan = { version: 1, workflows: [{ id: 'revise', purpose: 'treatment', rationale: 'Synthetic branching and context controls; no model collection or treatment benefit is established.', entry: 'draft', failurePolicy: 'halt-study',
    budgets: { maxCalls: 2, maxRequestBytes: 65536, maxResponseBytes: 1048576, maxToolCalls: 1, maxOutputTokens: 20 }, stages: [
      { id: 'draft', instructions: { system: 'Synthetic system instruction.', developer: null, user: 'Return {answer, revise} for the disclosed task.' }, includeTaskPrompt: true, includeTaskInput: false,
        parents: [], allowedTools: [], timeoutMs: 5000, next: { branches: [{ path: ['revise'], equals: false, to: null }], otherwise: 'revise' }, resultPath: ['answer'] },
      { id: 'revise', instructions: { system: null, developer: 'Use only the declared parent output and task.', user: 'Revise the supplied answer and return {answer}.' }, includeTaskPrompt: true, includeTaskInput: true,
        parents: [{ stageId: 'draft', path: ['answer'] }], allowedTools: ['arithmetic'], timeoutMs: 5000, next: { branches: [], otherwise: null }, resultPath: ['answer'] },
    ] }] }
  return spec
}
