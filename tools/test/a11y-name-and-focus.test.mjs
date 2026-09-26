import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

import { installDomStandIn } from './lib/dom-stand-in.mjs'

register(new URL('./css-loader.mjs', import.meta.url), import.meta.url)

const dom = installDomStandIn()
/* Node 22 defines navigator as a getter-only global, so a plain assignment
   throws before any assertion runs. defineProperty is the only way to give
   the module under test the shape it reads. */
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: '' }, configurable: true, writable: true })
const { buildChat } = await import('../../src/components.js')
const { commsView } = await import('../../src/views/comms.js')
const { restoreProjectFormFocus } = await import('../../src/views/research.js')

test.after(() => { dom.restore(); delete globalThis.navigator })

test('the channels refresh icon has a non-empty accessible action name', () => {
  const view = commsView()
  const root = view.el
  document.body.appendChild(root)
  const restack = root.querySelector('.comms-refresh')

  assert.ok(restack, 'the channels workspace did not render its refresh control')
  assert.equal(restack.getAttribute('aria-label'), 'Refresh messages',
    'an empty label leaves the SVG-only refresh control unnamed')
  assert.notEqual(restack.getAttribute('aria-label').trim(), '',
    'bad value: an empty label is not an accessible name')
  view.destroy()
  root.remove()
})

test('closing the actions popup returns focus to its opener', () => {
  const root = buildChat({
    title: 'Focus fixture',
    history: [],
    onSend() {},
    actions: () => [{ id: 'inspect', label: 'Inspect', run() {} }],
  })
  document.body.appendChild(root)
  const opener = root.querySelector('[data-chat-actions]')
  opener.click()
  const popup = root.querySelector('.chat-actions-pop')
  const focusedInside = document.activeElement
  assert.ok(popup?.contains(focusedInside), 'the opened actions popup did not take focus')

  opener.click()

  assert.equal(root.querySelector('.chat-actions-pop'), null, 'the actions popup stayed open')
  assert.equal(document.activeElement, opener,
    'bad value: focus left on a removed node instead of the actions opener')
  assert.notEqual(document.activeElement, focusedInside,
    'bad value: focus left on a removed node')
  root.dispose()
  root.remove()
})

test('closing the project form returns focus to its opener', () => {
  const opener = document.createElement('button')
  const form = document.createElement('span')
  const field = document.createElement('input')
  form.appendChild(field)
  document.body.append(opener, form)
  field.focus()
  assert.equal(document.activeElement, field, 'the project form fixture did not hold focus')

  form.hidden = true
  restoreProjectFormFocus(form, opener)

  assert.equal(document.activeElement, opener,
    'bad value: focus left on a removed node instead of the New project opener')
  assert.notEqual(document.activeElement, field,
    'bad value: focus left on a removed node')
  opener.remove()
  form.remove()
})
