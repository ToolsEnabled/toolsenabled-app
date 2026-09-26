/* The first-run walkthrough and the Settings permission row, mounted in a real
   document, pressed the way a keyboard does (focus, then activate), with the
   focused element read after each press. */
import { setupView } from '../../../src/views/setup.js'
import { createSetupProfileSettings } from '../../../src/setup-profile-settings.js'
import { SETUP_RESOLUTION } from '../../../src/setup-state.js'

const settle = async () => { for (let turn = 0; turn < 5; turn += 1) await new Promise(resolve => setTimeout(resolve, 0)) }
const describe = element => !element || element === document.body
  ? { tag: element ? 'BODY' : null, data: {} }
  : { tag: element.tagName, data: Object.fromEntries(element.getAttributeNames().filter(name => name.startsWith('data-') || name === 'aria-pressed').map(name => [name, element.getAttribute(name)])) }
async function press(selector) {
  const target = document.querySelector(selector)
  if (!target) return { missing: selector }
  target.focus()
  target.click()
  await settle()
  return describe(document.activeElement)
}

function resetMachine() {
  window.riskGateMachine.tier = 'guided'
  window.riskGateMachine.writes.length = 0
  window.mcSetup.bootstrap.tier = 'guided'
  SETUP_RESOLUTION.tier = 'guided'
  SETUP_RESOLUTION.configured = true
  localStorage.setItem('mc.setup.profile', JSON.stringify({ schemaVersion: 1, status: 'in-progress', step: 'tier', answers: { autonomy: 'autonomous', screens: 'live', workspaceRoots: [] }, updatedAtMs: 1 }))
}

window.riskGateFocus = {
  async walkthrough(answer) {
    resetMachine()
    document.body.innerHTML = ''
    const view = setupView({ navigate: () => {} })
    document.body.appendChild(view.el)
    await settle()
    const opened = await press('[data-setup-tier="unrestricted"]')
    const answered = await press(answer === 'yes' ? '[data-unrestricted-confirm]' : '[data-unrestricted-decline]')
    const lit = [...document.querySelectorAll('[data-setup-tier][aria-pressed="true"]')].map(card => card.getAttribute('data-setup-tier'))
    view.destroy()
    return { opened, answered, lit, writes: [...window.riskGateMachine.writes] }
  },
  async settings(answer) {
    resetMachine()
    document.body.innerHTML = '<div class="settings-page"><div data-settings-host></div></div>'
    const host = document.querySelector('[data-settings-host]')
    const controller = createSetupProfileSettings()
    host.innerHTML = controller.markup()
    controller.bind(host)
    controller.afterRender(host)
    await settle()
    const opened = await press('[data-setup-profile-set="tier"][data-setup-profile-value="unrestricted"]')
    const answered = await press(answer === 'yes' ? '[data-unrestricted-confirm]' : '[data-unrestricted-decline]')
    await settle()
    const after = describe(document.activeElement)
    const lit = [...document.querySelectorAll('[data-setup-profile-set="tier"][aria-pressed="true"]')].map(rung => rung.getAttribute('data-setup-profile-value'))
    controller.destroy?.()
    return { opened, answered, after, lit, writes: [...window.riskGateMachine.writes] }
  },
}
