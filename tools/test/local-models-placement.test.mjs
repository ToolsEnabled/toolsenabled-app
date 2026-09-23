/* WHERE THE MODEL ROWS ARE DRAWN, AND WHY IT IS NOT A SECOND LIST.
 *
 * The three rows that decide which model answers are written by the same
 * writer as every other engine-backed row, so they stay in the one writability
 * list -- PRODUCT_SETTING_IDS, which the standing gate holds deep-equal to the
 * shell's WRITABLE_IDS. What changes is only WHERE they are drawn. A second
 * list of "the local model rows" would disagree with the first the moment
 * either changed, which is the exact defect that gate exists to catch, so
 * placement is a function of the id and nothing more.
 *
 * A person hunting for the model their own computer answers with is not going
 * to look under "Research & Agents", which is the same reason the tool-note
 * switch was once unfindable: it was drawn under a heading that did not
 * describe it, and search could not reach it either.
 *
 * ASSERTED THROUGH THE MODULE, NOT THROUGH ITS SOURCE TEXT. Whether the page
 * routes and lists the new heading is already covered by the standing gate
 * "the sections the page lists are exactly the sections its rows are in", so
 * nothing here matches the view's source and no assertion pins a spelling.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

const {
  createResearchSettings, LOCAL_MODELS_SECTION, RESEARCH_SECTION, PRODUCT_SETTING_IDS, sectionOfRow,
} = await import('../../src/research-settings.js')
const { groupOfSection } = await import('../../src/settings-presentation.js')

const MODEL_IDS = ['model.provider', 'model.endpoint', 'model.name']

const row = (id, extra = {}) => ({
  id,
  present: true,
  control: 'toggle',
  label: `the ${id} row`,
  value: false,
  provenance: { source: 'user', atMs: 1, directive: null },
  enforcement: { declared: true, enforcedBy: 'a reader' },
  ...extra,
})

const ROWS = [
  row('research.pipeline', { value: true }),
  row('model.provider', { control: 'pick', value: 'Ollama', choices: ['Ollama', 'OpenAI compatible'] }),
  row('model.endpoint', { control: 'pick', value: 'http://127.0.0.1:11434', choices: ['http://127.0.0.1:11434'] }),
  row('model.name', { control: 'pick', value: 'qwen3.5:9b', choices: ['qwen3.5:9b'] }),
]

async function paint(section) {
  const controller = createResearchSettings({
    shell: { read: async () => ({ ok: true, available: true, rows: ROWS }), set: async () => ({ ok: true }) },
  })
  await controller.load()
  return controller.markup(section === undefined ? {} : { section })
}

test('the rows that decide which model answers are placed under their own heading', () => {
  for (const id of MODEL_IDS) {
    assert.equal(sectionOfRow(id), LOCAL_MODELS_SECTION,
      `${id} belongs under the local-models heading: a person hunting for the model their own`
      + ' computer answers with will not look under a heading about research')
  }
  assert.equal(sectionOfRow('research.pipeline'), RESEARCH_SECTION,
    'every row this module already drew keeps the heading it had')
})

test('placement is a function of the id, never a second list of rows', () => {
  for (const id of MODEL_IDS) {
    assert.ok(PRODUCT_SETTING_IDS.includes(id),
      `${id} stays in the one writability list; the heading it draws under is a separate question`)
  }
})

test('the local-models heading draws the model rows and nothing else', async () => {
  const html = await paint(LOCAL_MODELS_SECTION)
  assert.ok(html.includes('data-research-choice="model.name"'),
    'the model chooser is drawn under the heading a person would look under')
  assert.equal(html.includes('research.pipeline'), false,
    'and a research row is not: two headings that both draw everything are one heading')
})

test('the research heading keeps its own rows and does not take the model rows', async () => {
  const html = await paint(RESEARCH_SECTION)
  assert.ok(html.includes('research.pipeline'),
    'the rows this module already drew are still drawn where they were')
  for (const id of MODEL_IDS) {
    assert.equal(html.includes(`data-research-choice="${id}"`), false,
      `${id} is no longer drawn here, or it would be offered twice on one page`)
  }
})

test('a caller that names no heading gets the rows this module always drew', async () => {
  const html = await paint(undefined)
  assert.ok(html.includes('research.pipeline'),
    'the existing caller passes no heading and must keep getting exactly what it got before')
  assert.equal(html.includes('data-research-choice="model.name"'), false,
    'and must not silently acquire the model rows under its own heading')
})

test('the new heading is inside a group, so it cannot vanish from the page', () => {
  assert.notEqual(groupOfSection(LOCAL_MODELS_SECTION), null,
    'a section in no group is drawn ungrouped and is missing from the group head that advertises'
    + ' it, which is how a heading becomes unfindable without anything looking broken')
})

