import '../../../src/styles.css'
import '../../../src/role-studio.css'
import '../../../src/first-use-guidance.css'
import { mountFirstUseGuidance } from '../../../src/first-use-guidance.js'
import { buildRoleLibraryBox, readOrg } from '../../../src/org-controls.js'

// Component fixture only: navigation remounts the actual library component.
// Its bridge calls the actual App organization record and isolated Engine stores.
document.body.innerHTML = '<nav aria-label="Primary navigation"><a href="#/metrics">Metrics</a><a href="#/computers">Computers</a></nav><section data-fixture-route></section>'
const slot = document.querySelector('[data-fixture-route]')
const guidance = mountFirstUseGuidance({ entryHost: document.querySelector('nav') })
async function mount() {
  slot.replaceChildren()
  if (location.hash !== '#/computers') {
    slot.innerHTML = '<h1>Fixture route</h1>'
    guidance.visit(location.hash === '#/metrics' ? 'metrics' : 'home', slot)
    return
  }
  const availability = await readOrg()
  if (availability.state !== 'ready') throw new Error(availability.reason)
  const wrapper = document.createElement('section')
  wrapper.className = 'stats-page is-active'
  wrapper.hidden = true
  wrapper.innerHTML = '<details data-fleet-details="configuration"><summary>Configuration</summary><div data-library-slot></div></details>'
  wrapper.querySelector('[data-library-slot]').replaceWith(buildRoleLibraryBox({ availability,
    onCreate: request => window.mcOrg.createRole(request),
    onEdit: request => window.mcOrg.editRole(request),
    onReset: request => window.mcOrg.resetRole(request) }))
  const door = document.createElement('button')
  door.textContent = 'Roles'
  door.addEventListener('click', () => {
    wrapper.hidden = false
    wrapper.querySelector('details').open = true
    wrapper.querySelector('.board-roles-box').openStudio()
  })
  slot.append(door, wrapper)
  guidance.visit('computers', wrapper)
}
window.addEventListener('hashchange', () => { void mount() })
if (!location.hash) location.hash = '#/'
else void mount()
