import test from 'node:test'
import assert from 'node:assert/strict'
import { createResearchSettings, PRODUCT_SETTING_IDS, sectionOfRow } from '../../src/research-settings.js'
const ids = ['model.local_agent_name', 'model.tool_name', 'model.local_gpu_policy', 'model.local_context_tokens', 'model.local_thinking', 'model.local_keep_alive_minutes']
test('GPU, latency and separate model defaults are visible local-model controls', async () => {
  const rows = [
    { id: 'model.endpoint', control: 'text', value: 'http://127.0.0.1:11434' },
    { id: ids[0], control: 'pick', value: '' }, { id: ids[1], control: 'pick', value: '' },
    { id: ids[2], control: 'select', options: ['Require GPU', 'Allow CPU fallback', 'CPU only'], value: 'Require GPU' },
    { id: ids[3], control: 'number', value: 8192 },
    { id: ids[4], control: 'select', options: ['Fast', 'Reasoning', 'Model default'], value: 'Fast' },
    { id: ids[5], control: 'number', value: 10 },
  ].map(row => ({ present: true, label: row.id, enforcement: { declared: true }, ...row }))
  const written = []
  const panel = createResearchSettings({
    shell: { read: async () => ({ ok: true, available: true, rows }), set: async (id, value) => { written.push({ id, value }); return { ok: true } } },
    readLocalRuntimes: async () => ({ ok: true, runtimes: [{ runtime: 'ollama', host: '127.0.0.1', port: 11434, listening: true, models: ['qwen3.5:9b'] }] }),
  })
  await panel.load()
  const html = panel.markup({ section: 'Local models' })
  for (const id of ids) { assert.ok(PRODUCT_SETTING_IDS.includes(id)); assert.equal(sectionOfRow(id), 'Local models'); assert.ok(html.includes(id)) }
  assert.match(html, /data-research-number="model.local_context_tokens"/)
  assert.match(html, /data-research-value="Require GPU"/)
  assert.match(html, /data-research-value="Fast"/)
  for (const id of ids.slice(0, 2)) {
    assert.ok(html.includes(`data-research-choice="${id}" data-research-value="qwen3.5:9b"`))
    assert.ok(html.includes(`data-research-choice="${id}" data-research-value=""`))
  }
  await panel.setValue(ids[3], 8192)
  await panel.setValue(ids[0], '')
  assert.deepEqual(written, [{ id: ids[3], value: 8192 }, { id: ids[0], value: '' }])
})
