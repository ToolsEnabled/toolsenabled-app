import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import test from 'node:test'
import { Element, installDomStandIn } from './lib/dom-stand-in.mjs'

register('./css-loader.mjs', import.meta.url)
const { researchView } = await import('../../src/views/research.js')
const schema = JSON.parse(readFileSync(new URL('../../public/data/schema/research.schema.json', import.meta.url)))
const catalog = JSON.parse(readFileSync(new URL('../../public/data/research.json', import.meta.url)))
const pause = () => new Promise(resolve => setTimeout(resolve, 5))
async function until(predicate) {
  for (let attempt = 0; attempt < 200; attempt++) { if (predicate()) return; await pause() }
  assert.fail('the project activity UI did not settle')
}

test('project choices show current work by ID and retain selection through idle, outage and account changes', async () => {
  const originals = new Map(['localStorage', 'getComputedStyle', 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const priorInsert = Element.prototype.insertAdjacentHTML
  const installed = installDomStandIn(globalThis)
  Element.prototype.insertAdjacentHTML = function (position, html) {
    const template = this.ownerDocument.createElement('template')
    template.innerHTML = html
    const children = [...template.children]
    if (position === 'afterend' || position === 'afterbegin') children.reverse()
    for (const child of children) this.insertAdjacentElement(position, child)
  }
  let view, busy = true, unavailable = false, holdSnapshot = false
  const pending = [], listeners = new Set(), values = new Map()
  const first = 'rp-' + 'a'.repeat(36), second = 'rp-' + 'b'.repeat(36)
  const projects = [{ projectId: first, name: 'Same project name', enabled: true },
    { projectId: second, name: 'Same project name', enabled: true }]
  const assignments = [{ projectId: first, kind: 'observed', ref: 'working-session', active: true, assignmentId: 'activity-assignment' }]
  const bridge = async path => {
    if (path.endsWith('/research-snapshot')) {
      if (holdSnapshot) await new Promise(resolve => pending.push(resolve))
      return { ok: true, receipt: { projects, assignments, experiments: {}, settings: { pipelineEnabled: false }, lifecycle: { running: false } } }
    }
    if (path.endsWith('/research-findings')) return { ok: true, receipt: { findings: [] } }
    return { ok: false, reason: 'Synthetic read unavailable' }
  }
  window.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) }
  globalThis.localStorage = window.localStorage
  window.mcShell = {
    getBridgeProof: () => assert.fail('no native bootstrap'),
    getBridgeTransport: async () => bridge,
    captureResearchAssignmentDestination: async () => ({ ok: true, key: 'activity-account/activity-computer',
      request: action => bridge('/v1/actions/' + action) }),
  }
  window.mcAgent = { onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener) } }
  window.mcDesktopTree = { async read() {
    if (unavailable) return { ok: false, code: 'MC_AGENT_DESKTOP_TREE_UNAVAILABLE' }
    return { ok: true, desktopTree: { version: 1, computerId: 'activity-computer',
      trees: [{ id: 'activity-tree' }],
      nodes: [{ id: 'activity-node', treeId: 'activity-tree', sessionId: 'working-session', status: 'running' }] },
      sessions: [{ sessionId: 'working-session', nodeId: 'activity-node', busy }] }
  } }
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '', overflowY: 'visible', display: 'block' })
  globalThis.fetch = async input => {
    const path = String(input)
    if (path.endsWith('/data/schema/research.schema.json')) return new Response(JSON.stringify(schema))
    if (path.endsWith('/data/research.json')) return new Response(JSON.stringify(catalog))
    if (path.endsWith('/data/research-queue.json')) return new Response(JSON.stringify({ schemaVersion: 1, items: [] }))
    return new Response('{}', { status: 404 })
  }
  try {
    view = researchView(); document.body.appendChild(view.el)
    const select = view.el.querySelector('[data-project-select]')
    const option = id => select.querySelectorAll('option').find(node => node.getAttribute('value') === id)
    await until(() => option(first)?.textContent.endsWith(' — active'))
    assert.equal(option(second).textContent, 'Same project name', 'names cannot join two projects')
    select.value = second; select.dispatch('change')
    assert.equal(select.value, second)
    busy = false
    for (const listener of listeners) listener({ sessionId: 'working-session', event: { type: 'turn_completed', status: 'completed' } })
    await until(() => !option(first).textContent.includes(' — active'))
    assert.equal(select.value, second, 'an idle update keeps the selected project')
    busy = true; window.dispatch('focus')
    await until(() => option(first).textContent.endsWith(' — active'))
    unavailable = true; window.dispatch('focus')
    await until(() => !option(first).textContent.includes(' — active'))
    assert.equal(select.value, second, 'an unavailable read keeps selection and removes the claim')
    unavailable = false; window.dispatch('focus')
    await until(() => option(first).textContent.endsWith(' — active'))
    holdSnapshot = true; window.dispatch('mc:data-source-changed')
    assert.equal(option(first).textContent.includes(' — active'), false, 'account or computer changes clear activity before asynchronous reads')
    assert.equal(listeners.size, 0, 'the old activity subscription is released at the account boundary')
  } finally {
    view?.destroy(); view?.el.remove()
    pending.splice(0).forEach(resolve => resolve())
    await pause(); installed.restore()
    if (priorInsert) Element.prototype.insertAdjacentHTML = priorInsert
    else delete Element.prototype.insertAdjacentHTML
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  }
})
