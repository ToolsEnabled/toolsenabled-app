import assert from 'node:assert/strict'
import test from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { createPipelineEditor } from '../../src/research-pipeline.js'
import { pipelineConditions, pipelineJudges } from '../../src/research-pipeline.mjs'
import { modelsForHarness, modelRequest } from '../../src/research-models.mjs'

const ids = [' vendor/model-with-spaces ', 'vendor/' + 'long-name-'.repeat(40), 'モデル/' + '版'.repeat(150)]
for (const id of ids) test('typed exact ID remains visible, retained and sent: ' + id.slice(0, 24), () => {
  const dom = installDomStandIn()
  try {
    let emitted
    const view = createPipelineEditor({ onChange: value => { emitted = value } })
    document.body.append(view.el, view.judgesEl)
    view.set({ rows: [{ surface: 'codex-cli', model: 'old', efforts: ['high'] }], judges: [{ surface: 'claude-cli', model: 'old', prompt: 'Read the answer' }], models: [{ id: 'fixture', name: 'Fixture endpoint', kind: 'openai-chat', model: 'old', credential: 'FIXTURE_KEY_NAME' }] })
    const field = name => view.el.querySelector('[data-pipe-' + name + '="0"]') || view.judgesEl.querySelector('[data-pipe-' + name + '="0"]')
    for (const name of ['model', 'judge-model', 'model-id']) {
      field(name).value = id
      field(name).dispatch('input')
    }
    assert.equal(emitted.rows[0].model, id)
    assert.equal(emitted.judges[0].model, id)
    assert.equal(emitted.models[0].model, id)
    view.set(emitted)
    for (const name of ['model', 'judge-model', 'model-id']) assert.equal(field(name).value, id, name + ' displays the retained value')
    const condition = pipelineConditions(view.value())[0]
    assert.equal(condition.adapter.args[condition.adapter.args.indexOf('--model') + 1], id)
    assert.equal(pipelineJudges(view.value())[0].model, id)
    assert.equal(modelRequest(modelsForHarness(view.value().models)[0], 'Fixture prompt', '', '', 10).body.model, id)
  } finally { dom.restore() }
})

test('picking a retained unregistered model ID keeps it exact for correction', () => {
  const dom = installDomStandIn()
  try {
    const id = ids[1]
    let emitted
    const view = createPipelineEditor({ onChange: value => { emitted = value } })
    document.body.append(view.el, view.judgesEl)
    view.set({ rows: [{ surface: 'http', model: id, efforts: ['high'] }], judges: [{ surface: 'http', model: id, prompt: 'Read the answer' }] })
    for (const [section, name] of [[view.el, 'model'], [view.judgesEl, 'judge-model']]) {
      const select = section.querySelector('[data-pipe-' + name + '="0"]')
      assert.ok([...select.querySelectorAll('option')].some(option => option.value === id))
      select.value = id
      select.dispatch('change')
    }
    assert.equal(emitted.rows[0].model, id)
    assert.equal(emitted.judges[0].model, id)
    view.set(emitted)
    assert.equal(view.el.querySelector('[data-pipe-model="0"] option[selected]').value, id)
    assert.equal(view.judgesEl.querySelector('[data-pipe-judge-model="0"] option[selected]').value, id)
  } finally { dom.restore() }
})
