import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeCustomModels, modelsForHarness, modelRequest, modelProblems } from '../../src/research-models.mjs'
import { normalizePipelineDraft, pipelineConditions, pipelineJudges, judgeProblems } from '../../src/research-pipeline.mjs'
import { normalizePendingEditorFork } from '../../src/editor-attachment-drafts.js'

const ids = ['vendor/model-v3.7:latest', ' vendor/model-with-spaces ', 'vendor/' + 'long-name-'.repeat(40), 'モデル/' + '版'.repeat(150)]
for (const id of ids) test('pipeline retains and sends the exact model ID: ' + id.slice(0, 24), () => {
  const draft = { rows: [{ surface: 'codex-cli', model: id, efforts: ['high'] }], judges: [{ surface: 'claude-cli', model: id, effort: 'high', prompt: 'Read the answer' }] }
  const normalized = normalizePipelineDraft(draft)
  assert.equal(normalized.rows[0].model, id)
  assert.equal(normalized.judges[0].model, id)
  const conditions = pipelineConditions(draft)
  assert.equal(conditions[0].model, id)
  assert.equal(conditions[0].identity.id, id)
  assert.equal(conditions[0].adapter.args[conditions[0].adapter.args.indexOf('--model') + 1], id)
  assert.equal(pipelineJudges(draft)[0].model, id)
})

for (const id of ids) test('custom endpoint requests retain the exact model ID: ' + id.slice(0, 24), () => {
  const model = { id: 'fixture-endpoint', name: 'Fixture endpoint', kind: 'openai-chat', model: id, credential: 'FIXTURE_KEY_NAME' }
  const normalized = normalizeCustomModels([model])[0]
  assert.equal(normalized.model, id)
  const exported = modelsForHarness([model])[0]
  assert.equal(exported.model, id)
  for (const kind of ['openai-chat', 'openai-responses', 'anthropic-messages', 'http-json']) {
    const request = modelRequest({ ...exported, kind }, 'Fixture prompt', '', '', 10)
    assert.equal(request.body.model, id)
  }
})

test('whitespace-only contestant models are refused', () => {
  assert.equal(pipelineConditions({ rows: [{ surface: 'codex-cli', model: '   ', efforts: ['high'] }] }).length, 0)
})
test('blank requested IDs do not produce a self-grading warning', () => {
  const draft = { rows: [{ surface: 'codex-cli', model: '   ', efforts: ['high'] }], judges: [{ surface: 'claude-cli', model: '   ', prompt: 'Read the answer' }] }
  assert.ok(!judgeProblems(draft).some(problem => problem.kind === 'contestant'))
})
test('whitespace-only judge models remain incomplete', () => {
  assert.ok(judgeProblems({ judges: [{ surface: 'claude-cli', model: '   ', prompt: 'Read the answer' }] }).some(problem => problem.kind === 'incomplete'))
})
test('whitespace-only judge models are excluded from the harness', () => {
  assert.equal(pipelineJudges({ judges: [{ surface: 'claude-cli', model: '   ', prompt: 'Read the answer' }] }).length, 0)
})
test('whitespace-only endpoint model IDs remain incomplete', () => {
  assert.ok(modelProblems([{ id: 'fixture', name: 'Fixture endpoint', model: '   ', credential: 'FIXTURE_KEY_NAME', kind: 'openai-chat' }]).some(problem => problem.kind === 'incomplete'))
})

test('editor copy metadata keeps the entire observed model ID', () => {
  const model = ids[2]
  const pending = normalizePendingEditorFork({ provider: 'codex', sourceSessionId: '00000000-0000-4000-8000-000000000000', workspace: '/fixture-workspace', model })
  assert.equal(pending.model, model)
})
