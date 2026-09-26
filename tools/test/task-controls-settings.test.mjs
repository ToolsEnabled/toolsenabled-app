import test from 'node:test'
import assert from 'node:assert/strict'
import { createResearchSettings, PRODUCT_SETTING_IDS } from '../../src/research-settings.js'
import { PRODUCT_SETTING_PRESENTATION, sectionOfRow } from '../../src/product-settings-layout.js'
import { createDocument } from './lib/dom-stand-in.mjs'
import { createRequire } from 'node:module'

const ID = 'agent.task_difficulty_enabled'
function fixture({ saved = false, reply, present = true } = {}) {
  let value = saved
  const writes = []
  let reads = 0
  const section = createResearchSettings({ shell: {
    async read() {
      reads++
      return { ok: true, available: true, rows: [{
        id: ID, present, control: 'toggle', value, default: false,
        provenance: { source: 'user' }, enforcement: { declared: true },
      }] }
    },
    async set(id, next) {
      writes.push({ id, value: next })
      if (reply) return reply(id, next)
      value = next
      return { ok: true, id, value: next, provenance: { source: 'user' }, recorded: { ok: true } }
    },
  } })
  return { section, writes, value: () => value, reads: () => reads }
}
function render(section) {
  const document = createDocument(), body = document.createElement('div')
  document.body.appendChild(body)
  body.innerHTML = section.markup({ section: 'Agents & delegation' })
  return body
}
const control = body => body.querySelector(`[data-research-setting="${ID}"]`)

test('the grading setting is a Settings row the shell may write, under Agents & delegation', () => {
  assert.ok(PRODUCT_SETTING_IDS.includes(ID))
  assert.equal(sectionOfRow(ID), 'Agents & delegation')
  assert.equal(PRODUCT_SETTING_PRESENTATION[ID].title, 'Grade task difficulty')
  const { WRITABLE_IDS } = createRequire(import.meta.url)('../../shell/product-settings.cjs')
  assert.ok(WRITABLE_IDS.includes(ID), 'the shell writes the setting the page offers')
})

test('the grading control shows the saved value and makes no write when opened', async () => {
  for (const saved of [false, true]) {
    const f = fixture({ saved })
    await f.section.load()
    const body = render(f.section)
    assert.equal(control(body).checked, saved)
    assert.equal(control(body).disabled, false)
    assert.deepEqual(f.writes, [])
    assert.match(body.textContent, /Grade task difficulty/)
    assert.match(body.textContent, /One failed review raises Easy to Medium/)
  }
})

test('turning grading on persists through the writer and the reread', async () => {
  const f = fixture()
  await f.section.load()
  await f.section.setValue(ID, true)
  assert.deepEqual(f.writes, [{ id: ID, value: true }])
  assert.equal(f.reads(), 2, 'the page rereads the saved value after the write')
  assert.equal(control(render(f.section)).checked, true)
  assert.match(render(f.section).textContent, /Turned on/)
  await f.section.load({ force: true })
  assert.equal(control(render(f.section)).checked, true)
  assert.equal(f.writes.length, 1, 'reading again never reapplies the default')
})

test('a refused write keeps the saved choice and shows the reason', async () => {
  const f = fixture({ reply: () => ({ ok: false, reason: 'The host kept the previous choice.' }) })
  await f.section.load()
  await f.section.setValue(ID, true)
  const body = render(f.section)
  assert.equal(control(body).checked, false)
  assert.match(body.textContent, /host kept the previous choice/)
  assert.equal(f.value(), false)
})

test('an engine without the grading row offers no working control', async () => {
  const f = fixture({ present: false })
  await f.section.load()
  const input = control(render(f.section))
  assert.ok(!input || input.disabled)
  await f.section.setValue(ID, true)
  assert.deepEqual(f.writes, [])
})

/* T1139: "Assign work only through tasks" (off by default) and "Let agents
   message each other" (agent comms, on by default) are ordinary Settings rows
   beside grading, written through the same shell writer. */
const DELEGATION = { 'agent.task_only_delegation': ['Assign work only through tasks', false], 'agent.comms_enabled': ['Let agents message each other', true] }
function delegationFixture(values) {
  const saved = { ...values }, writes = []
  const section = createResearchSettings({ shell: {
    async read() {
      return { ok: true, available: true, rows: Object.entries(saved).map(([id, value]) => ({
        id, present: true, control: 'toggle', value, default: DELEGATION[id][1],
        provenance: { source: 'user' }, enforcement: { declared: true },
      })) }
    },
    async set(id, value) { writes.push({ id, value }); saved[id] = value; return { ok: true, id, value, provenance: { source: 'user' }, recorded: { ok: true } } },
  } })
  return { section, saved, writes }
}

test('the two delegation settings are Settings rows the shell may write, under Agents & delegation', () => {
  const { WRITABLE_IDS } = createRequire(import.meta.url)('../../shell/product-settings.cjs')
  for (const [id, [title]] of Object.entries(DELEGATION)) {
    assert.ok(PRODUCT_SETTING_IDS.includes(id), id)
    assert.ok(WRITABLE_IDS.includes(id), id)
    assert.equal(sectionOfRow(id), 'Agents & delegation', id)
    assert.equal(PRODUCT_SETTING_PRESENTATION[id].title, title, id)
  }
})

test('the delegation settings show their defaults and each one saves on its own', async () => {
  const defaults = Object.fromEntries(Object.entries(DELEGATION).map(([id, [, value]]) => [id, value]))
  for (const id of Object.keys(DELEGATION)) {
    const f = delegationFixture(defaults)
    await f.section.load()
    let body = render(f.section)
    for (const [other, value] of Object.entries(defaults)) {
      const input = body.querySelector(`[data-research-setting="${other}"]`)
      assert.equal(input.checked, value, other)
      assert.equal(input.disabled, false, other)
    }
    assert.match(body.textContent, /Assign work only through tasks/)
    assert.match(body.textContent, /Let agents message each other/)
    await f.section.setValue(id, !defaults[id])
    assert.deepEqual(f.writes, [{ id, value: !defaults[id] }])
    body = render(f.section)
    for (const [other, value] of Object.entries(defaults)) {
      assert.equal(body.querySelector(`[data-research-setting="${other}"]`).checked, other === id ? !value : value, other)
    }
  }
})
