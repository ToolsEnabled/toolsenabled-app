/* Behavioural checks for the customer-facing Agent comms view.
 *
 * Run: node --test tools/test/comms.test.mjs
 *
 * The browser fixture is installed before the production view is imported.
 * Its shared parser therefore owns the production tree; this file supplies
 * only the asynchronous browser/bridge edges needed to hold first paint.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.css')) return { url: new URL(specifier, context.parentURL).href, shortCircuit: true }
    return nextResolve(specifier, context)
  }
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)

const moduleUrl = process.env.DOM_STAND_IN_MODULE
  ? pathToFileURL(process.env.DOM_STAND_IN_MODULE).href
  : new URL('./lib/dom-stand-in.mjs', import.meta.url).href
const { installDomStandIn } = await import(moduleUrl)
const installed = installDomStandIn(globalThis)

const scenarioNames = ['visibilityState']
const scenarioBefore = new Map(scenarioNames.map(name => [name, Object.getOwnPropertyDescriptor(document, name)]))
Object.defineProperty(document, 'visibilityState', { value: 'hidden', writable: true, configurable: true })
window.mcShell = { getBridgeProof() {} }
window.mcAgent = { localMessages: () => new Promise(() => {}) }
window.innerHeight = 0

const { commsView } = await import('../../src/views/comms.js')

const views = new Set()
function mountView() {
  const view = commsView()
  document.body.appendChild(view.el)
  views.add(view)
  return view
}
function destroyView(view) {
  view.destroy()
  view.el.remove()
  views.delete(view)
}
function pressed(button) { return button.getAttribute('aria-pressed') }

test.after(() => {
  for (const view of views) destroyView(view)
  delete window.mcShell
  delete window.mcAgent
  delete window.innerHeight
  for (const name of scenarioNames) {
    const descriptor = scenarioBefore.get(name)
    if (descriptor) Object.defineProperty(document, name, descriptor)
    else delete document[name]
  }
  installed.restore()
})

test('the first paint stays explicitly loading in the channels workspace', () => {
  const view = mountView()
  try {
    assert.equal(view.el.dataset.projectionState, 'loading',
      'a comms read that has not answered must remain named loading')
    assert.equal(view.el.dataset.mode, 'channels', 'the customer lands directly on channels')
  } finally { destroyView(view) }
})

test('the page has one channels view with accessible search and refresh controls', () => {
  const view = mountView()
  try {
    assert.equal(view.el.querySelector('.mode-seg'), null)
    assert.equal(view.el.querySelector('.watch-pane'), null)
    assert.equal(view.el.querySelector('.size-seg'), null)
    assert.equal(view.el.querySelector('.ch-filter').getAttribute('aria-label'), 'Find a conversation')
    assert.equal(view.el.querySelector('.comms-search').getAttribute('aria-label'), 'Search messages')
    assert.equal(view.el.querySelector('.comms-refresh').getAttribute('aria-label'), 'Refresh messages')
    assert.equal(view.el.querySelector('.ch-log').getAttribute('role'), 'region')
    assert.equal(view.el.querySelector('.jump-chip').tabIndex, -1)
  } finally { destroyView(view) }
})

test('unknown selectors fail closed instead of creating fixture nodes', () => {
  const view = mountView()
  try {
    assert.equal(view.el.querySelector('.neutral-unknown-selector'), null)
    assert.deepEqual(view.el.querySelectorAll('.neutral-unknown-selector'), [])
  } finally { destroyView(view) }
})
