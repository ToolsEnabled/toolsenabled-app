/* The setup view owns the folder controls a first-time customer can press.
 * Exercise the real view with the same workspaceState payload shape supplied by
 * the preload bridge; the DOM stand-in records what reaches the glass without
 * pinning the full markup or its prose. */

import assert from 'node:assert/strict'
import { register } from 'node:module'
import { test } from 'node:test'

register('./helpers/css-stub-loader.mjs', import.meta.url)

const store = new Map()
globalThis.localStorage = {
  getItem: key => store.get(key) ?? null,
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: key => store.delete(key),
}
globalThis.window = { addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true }

let workspaceReply
globalThis.mcSetup = {
  bootstrap: { ok: true, available: true, configured: true, tier: 'standard' },
  chooseTier: async tier => ({ ok: true, tier }),
  workspaceState: async () => workspaceReply,
}

let section
globalThis.document = {
  createElement(tag) {
    assert.equal(tag, 'template', 'setupView requested an unexpected DOM element')
    const template = { content: { firstElementChild: null } }
    Object.defineProperty(template, 'innerHTML', {
      set() {
        const listeners = new Map()
        section = {
          innerHTML: '',
          addEventListener: (type, listener) => listeners.set(type, listener),
          removeEventListener: type => listeners.delete(type),
          querySelector: () => null,
          querySelectorAll: () => [],
        }
        template.content.firstElementChild = {
          querySelector: selector => selector === '[data-setup-section]' ? section : null,
        }
      },
    })
    return template
  },
}

const { setupView } = await import('../../src/views/setup.js')

const settle = async () => { for (let turn = 0; turn < 6; turn += 1) await Promise.resolve() }

async function renderWorkspace(reply, { chooser = true } = {}) {
  workspaceReply = reply
  if (chooser) globalThis.mcSetup.chooseWorkspace = async () => ({ canceled: true })
  else delete globalThis.mcSetup.chooseWorkspace
  store.set('mc.setup.profile', JSON.stringify({
    schemaVersion: 1,
    status: 'in-progress',
    step: 'workspace',
    answers: { autonomy: 'assisted', screens: 'real', workspaceRoots: [] },
  }))
  const view = setupView()
  await settle()
  const markup = section.innerHTML
  view.destroy()
  return markup
}

function control(markup, attribute) {
  const match = markup.match(new RegExp(`<button[^>]*${attribute}[^>]*>`))
  assert.ok(match, `setup did not render the ${attribute} control`)
  return match[0]
}

test('Continue is disabled with a reason until the caller supplies a working folder', async () => {
  const empty = await renderWorkspace({ ok: true, available: true, roots: [], suggested: null })
  const blocked = control(empty, 'data-setup-next="account"')
  assert.match(blocked, /\sdisabled(?:\s|>)/, 'Continue stayed enabled although setup has no working folder')
  assert.match(blocked, /title="[^"]+"/, 'a control that cannot continue does not carry its reason')

  const ready = await renderWorkspace({ ok: true, available: true, roots: ['/work/customer'], suggested: null })
  const enabled = control(ready, 'data-setup-next="account"')
  assert.doesNotMatch(enabled, /\sdisabled(?:\s|>)/, 'Continue stayed disabled after the caller supplied a working folder')
})

test('the wizard folder step offers Use this folder to accept the suggestion the start gate needs chosen for', async () => {
  // Fresh install: a folder is suggested and recorded, but chosen is false -- and chosen is the start gate (setup-record.cjs). Without an accept control the wizard dead-ends.
  const suggested = await renderWorkspace({ ok: true, available: true, roots: ['/work/suggested'], suggested: '/work/suggested', chosen: false })
  const accept = control(suggested, 'data-setup-confirm-root')
  assert.doesNotMatch(accept, /\sdisabled(?:\s|>)/, 'the accept control is disabled although a folder is suggested and its chooser is present')
  assert.match(suggested, /Use this folder/, 'the accept control is not labelled for a person to recognise')
  // Once the folder is chosen the accept control is gone -- there is nothing left to accept.
  const chosen = await renderWorkspace({ ok: true, available: true, roots: ['/work/suggested'], suggested: '/work/suggested', chosen: true })
  assert.doesNotMatch(chosen, /data-setup-confirm-root/, 'the accept control still shows after the folder is already chosen')
})

test('the folder chooser is disabled and explains the refusal when the bridge cannot provide it', async () => {
  const unavailable = await renderWorkspace(
    { ok: true, available: true, roots: ['/work/customer'], suggested: null },
    { chooser: false },
  )
  const chooser = control(unavailable, 'data-setup-choose-root')
  assert.match(chooser, /\sdisabled(?:\s|>)/, 'the folder chooser stayed enabled although no caller exists to service it')
  assert.match(chooser, /title="[^"]+"/, 'the disabled folder chooser does not carry its refusal reason')
  assert.match(unavailable, /role="alert"/, 'the folder-chooser refusal never reaches an alert a customer can read')

  const available = await renderWorkspace({ ok: true, available: true, roots: ['/work/customer'], suggested: null })
  assert.doesNotMatch(
    control(available, 'data-setup-choose-root'),
    /\sdisabled(?:\s|>)/,
    'the folder chooser stayed disabled when its caller is present',
  )
})

/* T1587: 'Use this folder' removes itself once the folder is accepted, so the
   repaint had no replacement for the focused control and keyboard focus fell to
   the page: the one press in the wizard that lost the person's place. Focus
   must go on to the step's way forward (Continue), which is now usable. Run
   against the DOM stand-in, with the one attribute listing the view reads
   supplied to it for the length of this test. */
test('after Use this folder, keyboard focus moves on to Continue instead of falling to the page', async () => {
  const { installDomStandIn, Element } = await import('./lib/dom-stand-in.mjs')
  const harnessDocument = globalThis.document
  const addedNames = typeof Element.prototype.getAttributeNames !== 'function'
  if (addedNames) Element.prototype.getAttributeNames = function () { return [...this.attributes.keys()] }
  const installed = installDomStandIn(globalThis)
  globalThis.window.addEventListener = () => {}
  globalThis.window.removeEventListener = () => {}
  globalThis.window.dispatchEvent = () => true
  let view
  try {
    workspaceReply = { ok: true, available: true, roots: ['/work/suggested'], suggested: '/work/suggested', chosen: false }
    globalThis.mcSetup.chooseWorkspace = async () => ({ canceled: true })
    globalThis.mcSetup.checkWorkspace = async root => ({ ok: true, resolved: root })
    store.set('mc.setup.profile', JSON.stringify({
      schemaVersion: 1, status: 'in-progress', step: 'workspace',
      answers: { autonomy: 'assisted', screens: 'real', workspaceRoots: [] },
    }))
    view = setupView()
    document.body.appendChild(view.el)
    await settle()
    const stage = view.el.querySelector('[data-setup-section]')
    const accept = [...stage.querySelectorAll('button')].find(button => button.hasAttribute('data-setup-confirm-root'))
    assert.ok(accept, 'the step does not offer Use this folder')
    accept.focus()
    accept.click()
    await settle()
    const next = [...stage.querySelectorAll('button')].find(button => button.hasAttribute('data-setup-next'))
    assert.ok(next && !next.hasAttribute('disabled'), 'Continue is not usable after the folder was accepted')
    assert.ok(![...stage.querySelectorAll('button')].some(button => button.hasAttribute('data-setup-confirm-root')), 'Use this folder is still offered')
    assert.equal(document.activeElement, next, 'focus stayed on the removed Use this folder button, which a browser drops to the page')
  } finally {
    view?.destroy()
    installed.restore()
    globalThis.document = harnessDocument
    delete globalThis.mcSetup.checkWorkspace
    if (addedNames) delete Element.prototype.getAttributeNames
  }
})
