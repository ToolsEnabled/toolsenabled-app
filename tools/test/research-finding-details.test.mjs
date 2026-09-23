import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import test from 'node:test'
import { findingDetailsModel } from '../../src/research-findings.js'
import { Element, installDomStandIn } from './lib/dom-stand-in.mjs'

const field = (model, label) => model.fields.find(item => item.label === label).text

test('finding context preserves structured evidence and dissent without inferring review', () => {
  const input = {
    status: 'confirmed', evidence: { runId: 'run-1', values: [0, false], nested: { score: -3 } },
    method: 'Compare the two runs.', confidence: 'Tentative; one sample.',
    falsifier: 'Repeat with an independent sample.',
    dissents: [{ claim: 'The comparison lacks a control.', findingId: 'F-2026-0908-001' }],
    supersedes: 'F-2026-0907-001', createdAtMs: 0, updatedAtMs: 1000,
  }
  const model = findingDetailsModel(input)
  assert.deepEqual(JSON.parse(field(model, 'Evidence')), input.evidence)
  assert.deepEqual(JSON.parse(field(model, 'Dissent')), input.dissents)
  assert.equal(field(model, 'Method'), input.method)
  assert.equal(field(model, 'Recorded confidence'), input.confidence)
  assert.equal(field(model, 'What would disprove this claim'), input.falsifier)
  assert.equal(field(model, 'Supersedes finding'), input.supersedes)
  assert.equal(field(model, 'Created (UTC)'), '1970-01-01T00:00:00.000Z')
  assert.equal(field(model, 'Updated (UTC)'), '1970-01-01T00:00:01.000Z')
  assert.match(model.reviewNote, /Independent review is not tracked/)
  assert.deepEqual(model, findingDetailsModel({ ...input, status: 'open' }), 'a saved status cannot upgrade evidence to a review verdict')
})

test('missing records, recorded empty values and false values remain distinct', () => {
  assert.equal(field(findingDetailsModel(null), 'Evidence'), 'No evidence recorded.')
  assert.equal(field(findingDetailsModel({}), 'Dissent'), 'Dissent was not recorded.')
  assert.equal(field(findingDetailsModel({ dissents: [] }), 'Dissent'), 'No dissent recorded.')
  for (const evidence of [false, 0, '', {}, []]) {
    assert.deepEqual(JSON.parse(field(findingDetailsModel({ evidence }), 'Evidence')), evidence)
  }
  for (const createdAtMs of [null, undefined, '2026-09-08', NaN, Infinity, 1e20]) {
    assert.equal(field(findingDetailsModel({ createdAtMs }), 'Created (UTC)'), 'Not recorded.')
  }
  const cycle = {}; cycle.self = cycle
  assert.match(field(findingDetailsModel({ evidence: cycle }), 'Evidence'), /could not be displayed/)
})

register('./css-loader.mjs', import.meta.url)
const { researchView } = await import('../../src/views/research.js')
const schema = JSON.parse(readFileSync(new URL('../../public/data/schema/research.schema.json', import.meta.url)))
const catalog = JSON.parse(readFileSync(new URL('../../public/data/research.json', import.meta.url)))
const pause = () => new Promise(resolve => setTimeout(resolve, 5))
async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) { if (predicate()) return; await pause() }
  assert.fail('finding details did not become reachable')
}

test('the Research Evidence area renders service finding context and read failures without writes', async () => {
  const originals = new Map(['localStorage', 'getComputedStyle', 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const installed = installDomStandIn(globalThis)
  const priorInsert = Element.prototype.insertAdjacentHTML
  Element.prototype.insertAdjacentHTML = function (position, html) {
    const template = this.ownerDocument.createElement('template')
    template.innerHTML = html
    const children = [...template.children]
    if (position === 'afterend' || position === 'afterbegin') children.reverse()
    for (const child of children) this.insertAdjacentElement(position, child)
  }
  const projectId = 'rp-' + 'a'.repeat(36)
  const values = new Map([['mc.research.project', projectId]])
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) }
  // Entity decoding and native details keyboard behavior are covered by the
  // browser fixture; the shared stand-in deliberately does not model them.
  const recorded = 'Stored finding context'
  const finding = { findingId: 'F-2026-0908-001', claim: recorded, status: 'confirmed',
    evidence: { okay: false }, method: recorded, confidence: 'Not measured.',
    falsifier: 'A failed replication.', dissents: [false], supersedes: 'F-2026-0907-001' }
  const calls = []
  let response = { ok: true, receipt: { findings: [finding] } }
  let view
  try {
    window.localStorage = globalThis.localStorage = storage
    globalThis.getComputedStyle = () => ({ getPropertyValue: () => '', overflowY: 'visible', display: 'block' })
    window.mcShell = { getBridgeProof: () => assert.fail('no native bootstrap'), getBridgeTransport: async () => async pathname => {
      calls.push(pathname)
      if (pathname.endsWith('/research-snapshot')) return { ok: true, receipt: { projects: [{ projectId, name: 'Synthetic project', enabled: true }], experiments: {}, assignments: [], settings: { pipelineEnabled: false }, lifecycle: { running: false } } }
      if (pathname.endsWith('/research-findings')) return response
      return { ok: false, reason: 'Synthetic service unavailable' }
    } }
    globalThis.fetch = async input => {
      const url = String(input)
      const data = url.endsWith('/data/schema/research.schema.json') ? schema
        : url.endsWith('/data/research.json') ? catalog
          : url.endsWith('/data/research-queue.json') ? { schemaVersion: 1, items: [] } : null
      assert.notEqual(data, null, 'unexpected fetch: ' + url)
      return new Response(JSON.stringify(data))
    }
    view = researchView(); document.body.appendChild(view.el)
    await until(() => view.el.getAttribute('aria-busy') === 'false' && view.el.querySelector('.research-finding-details'))
    view.el.querySelector('[data-research-area="library"]').click()
    assert.equal(view.el.querySelector('[data-mc="worklists"]').hidden, false)
    const record = view.el.querySelector('.research-finding-record')
    assert.match(record.textContent, /Recorded status: confirmed/)
    assert.ok(record.textContent.includes(recorded), 'the stored text is visible')
    assert.equal(record.querySelector('summary').getAttribute('aria-label'), 'Evidence and reasoning for F-2026-0908-001')
    const entries = new Map(record.querySelector('dl').children.map(row => [row.querySelector('dt').textContent, row.querySelector('dd').textContent]))
    assert.match(entries.get('Evidence'), /false/)
    assert.deepEqual(JSON.parse(entries.get('Dissent')), finding.dissents)
    assert.equal(entries.get('Method'), recorded)
    assert.match(record.textContent, /Independent review is not tracked/)
    response = { ok: false, reason: 'Synthetic findings storage unavailable' }
    window.dispatch('mc:data-source-changed')
    await until(() => /Synthetic findings storage unavailable/.test(view.el.querySelector('[data-research-findings-list]').textContent))
    assert.equal(view.el.querySelector('.research-finding-record'), null, 'unavailable findings cannot retain stale records')
    assert.ok(calls.every(path => /research-snapshot|research-findings|local-tiers-status/.test(path)), 'detail inspection performs only reads')
  } finally {
    view?.destroy(); view?.el.remove()
    await pause()
    installed.restore()
    if (priorInsert) Element.prototype.insertAdjacentHTML = priorInsert
    else delete Element.prototype.insertAdjacentHTML
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  }
})
