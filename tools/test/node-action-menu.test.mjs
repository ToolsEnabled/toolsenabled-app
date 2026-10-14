import test from 'node:test'
import assert from 'node:assert/strict'
import { createDocument, Element } from './lib/dom-stand-in.mjs'
import { openNodeActionMenu, nodeMenuRows, bindNodeMenuGestures } from '../../src/node-action-menu.js'

// Geometry and native event propagation are verified separately in Chromium.
function fixture(t) {
  const doc = createDocument(), win = new Element('window', doc)
  const mutations = []
  Object.assign(win, { innerWidth: 800, innerHeight: 600, getComputedStyle: () => ({ zoom: '1' }),
    MutationObserver: class { constructor(fn) { mutations.push(fn) } observe() {} disconnect() {} },
  })
  doc.defaultView = win
  doc.querySelector = selector => selector.includes(',') ? null : doc.body.querySelector(selector)
  const anchor = doc.createElement('button'); doc.body.append(anchor); anchor.focus()
  let menu
  t.after(() => menu?.close())
  return { doc, anchor, mutations, open: options => (menu = openNodeActionMenu({ anchor, title: 'Fixture agent', keyboard: true, ...options })) }
}
const press = (element, key) => element.dispatchEvent({ type: 'keydown', key, preventDefault() {}, stopPropagation() {} })
const settle = () => new Promise(resolve => queueMicrotask(resolve))

test('short menu retains shared action values and leaves full actions reachable', () => {
  const shared = [{ id: 'stop', enabled: false, disabledHint: 'No session is running.' }, { id: 'attach' }, { id: 'model', enabled: true }]
  const result = nodeMenuRows(shared, [{ id: 'open-chat' }, { id: 'all-actions' }, { id: 'close-tab' }])
  assert.deepEqual(result.map(row => row.id), ['open-chat', 'stop', 'model', 'all-actions', 'close-tab'])
  assert.equal(result[1], shared[0]); assert.equal(result[2], shared[2])
})

test('keyboard includes disabled reasons, moves focus, and Escape can restore the opener', async t => {
  const f = fixture(t); let runs = 0
  const menu = f.open({ rows: () => [
    { id: 'open', label: 'Open chat', run: () => { runs++ } },
    { id: 'stop', label: 'Stop agent', enabled: false, disabledHint: 'No session is running.', run: () => { runs++ } },
    { id: 'clear', label: 'Start over', run: () => { runs++ } },
  ] })
  assert.equal(menu.root.getAttribute('role'), 'menu')
  assert.equal(f.doc.activeElement.dataset.menuAction, 'open')
  press(menu.root, 'ArrowDown')
  assert.equal(f.doc.activeElement.dataset.menuAction, 'stop')
  assert.equal(f.doc.activeElement.getAttribute('aria-disabled'), 'true')
  f.doc.activeElement.click(); await settle()
  assert.equal(runs, 0)
  assert.equal(menu.root.querySelector('[role="status"]').textContent, 'No session is running.')
  press(menu.root, 'End'); assert.equal(f.doc.activeElement.dataset.menuAction, 'clear')
  press(menu.root, 'Home'); assert.equal(f.doc.activeElement.dataset.menuAction, 'open')
  menu.close(); assert.equal(f.doc.activeElement, f.anchor)
})

test('an enabled item that becomes unavailable cannot run from a stale menu', async t => {
  const f = fixture(t); let enabled = true, runs = 0, notify
  const menu = f.open({ rows: () => [{ id: 'stop', label: 'Stop', enabled, disabledHint: 'Session already ended.', run: () => { runs++ } }],
    subscribe: listener => { notify = listener; return () => { notify = null } } })
  const oldButton = f.doc.activeElement
  enabled = false
  oldButton.click(); await settle()
  assert.equal(runs, 0)
  assert.equal(menu.root.querySelector('button').getAttribute('aria-disabled'), 'true')
  enabled = true; notify(); menu.root.querySelector('button').click(); await settle()
  assert.equal(runs, 1)
  menu.close(); assert.equal(notify, null)
})

test('confirmation is cancellable and a builder failure is an explained item', async t => {
  const f = fixture(t); let commits = 0, broken = false
  const menu = f.open({ rows: () => {
    if (broken) throw new Error('Actions changed. Reopen the menu.')
    return [{ id: 'clear', label: 'Start over', run: ctx => ctx.show([
      { id: 'confirm', label: 'Confirm', run: () => { commits++ } },
    ], { title: 'Confirm restart' }) }]
  } })
  f.doc.activeElement.click(); await settle()
  assert.equal(commits, 0)
  assert.equal(f.doc.activeElement.dataset.menuAction, 'menu-back')
  press(menu.root, 'ArrowLeft'); assert.equal(commits, 0)
  broken = true; menu.refresh()
  const failure = menu.root.querySelector('button')
  assert.equal(failure.getAttribute('aria-disabled'), 'true')
  assert.equal(failure.querySelector('small').textContent, 'Actions changed. Reopen the menu.')
})

test('long press requires 550 ms without movement, release, or another pointer', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const doc = createDocument(), host = doc.createElement('div'), node = doc.createElement('div')
  node.className = 'static-tree-node'; host.append(node); doc.body.append(host)
  const opens = [], dispose = bindNodeMenuGestures(host, (event, keyboard) => opens.push({ x: event.clientX, keyboard }), { matches: target => target === node })
  t.after(dispose)
  const down = () => host.dispatchEvent({ type: 'pointerdown', target: node, pointerType: 'touch', pointerId: 1, clientX: 30, clientY: 40 })
  down(); t.mock.timers.tick(549); assert.equal(opens.length, 0)
  t.mock.timers.tick(1); assert.deepEqual(opens, [{ x: 42, keyboard: false }])
  down(); host.dispatchEvent({ type: 'pointermove', pointerId: 1, clientX: 41, clientY: 40 }); t.mock.timers.tick(600)
  down(); host.dispatchEvent({ type: 'pointerup' }); t.mock.timers.tick(600)
  down(); host.dispatchEvent({ type: 'pointerdown', target: node, pointerType: 'touch', pointerId: 2, isPrimary: false }); t.mock.timers.tick(600)
  assert.equal(opens.length, 1)
})
