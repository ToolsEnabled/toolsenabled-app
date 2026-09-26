import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
register('./css-loader.mjs', import.meta.url)
const { toolsView } = await import('../../src/views/tools.js')

for (const failedKey of ['agent_tool_states', 'agent_tools_disabled']) {
  test(`a refused ${failedKey} read shows an explanation and disables every tool mutation`, async () => {
    const installed = installDomStandIn(globalThis)
    let view
    try {
      window.mcAgent = { tools: async () => ({ ok: true, tools: [{ name: 'fixture.read', allowed: true, gated: false, description: 'Fixture tool' }] }) }
      window.mcAccount = {
        getSetting: async key => key === failedKey
          ? { ok: false, code: 'HOSTED_ACCOUNT_DEVICE_REFUSED', reason: 'The paired account could not be verified.' }
          : { ok: true, key, value: null },
        putSetting: () => assert.fail('unverified choices must stay disabled'),
      }
      view = toolsView()
      document.body.appendChild(view.el)
      for (let n = 0; n < 10; n++) await Promise.resolve()
      const status = view.el.querySelector('[data-tool-status]').textContent
      assert.match(status, /choices below show defaults/)
      assert.match(status, /paired account could not be verified/)
      const buttons = [...view.el.querySelectorAll('.tools-bulk button'), ...view.el.querySelectorAll('[data-tool-state]')]
      assert.ok(buttons.length >= 6)
      assert.ok(buttons.every(button => button.disabled))
    } finally { view?.destroy(); view?.el.remove(); installed.restore() }
  })
}

/* T1453: signed out, both reads answer ACCOUNT_NOT_SIGNED_IN. That is the
   normal state of a fresh install whose setup was skipped, not a failure: the
   page asks for a sign-in and does not say the saved choices could not be
   read. A real refusal (above) keeps its 'could not be read' sentence. */
test('signed out, the Tools page asks for a sign-in instead of reporting a read failure', async () => {
  const installed = installDomStandIn(globalThis)
  let view
  try {
    window.mcAgent = { tools: async () => ({ ok: true, tools: [{ name: 'fixture.read', allowed: true, gated: false, description: 'Fixture tool' }] }) }
    window.mcAccount = {
      getSetting: async () => ({ ok: false, code: 'ACCOUNT_NOT_SIGNED_IN', reason: 'Nobody is signed in.' }),
      putSetting: () => assert.fail('signed out, nothing may be written'),
    }
    view = toolsView()
    document.body.appendChild(view.el)
    for (let n = 0; n < 10; n++) await Promise.resolve()
    const status = view.el.querySelector('[data-tool-status]').textContent
    assert.match(status, /Sign in to change these/)
    assert.doesNotMatch(status, /could not be read/)
    assert.doesNotMatch(status, /Nobody is signed in\./, 'the raw reason is printed instead of what to do')
    const buttons = [...view.el.querySelectorAll('.tools-bulk button'), ...view.el.querySelectorAll('[data-tool-state]')]
    assert.ok(buttons.length >= 6)
    assert.ok(buttons.every(button => button.disabled), 'signed out, the answers must stay unusable')
  } finally { view?.destroy(); view?.el.remove(); installed.restore() }
})
