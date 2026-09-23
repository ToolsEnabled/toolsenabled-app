import '@fontsource-variable/ibm-plex-sans'
import '@fontsource-variable/jetbrains-mono'
import '../../../src/styles.css'
import '../../../src/theme-refinements.css'
import '../../../src/tree-graph.css'
import '../../../src/board.css'
import { StaticTreeGraph } from '../../../src/tree-graph.js'
import { applyRoleColors } from '../../../src/role-colors.js'

// A live design sample using the actual renderer. No shell or agent sessions.
const style = document.createElement('style')
style.textContent = `
  #fixture { height:100%; padding:16px; }
  .fixture-pane { height:100%; display:flex; flex-direction:column; background:var(--sheet); }
  .fixture-slot { position:relative; flex:1; min-height:0; overflow:hidden; }
  .fixture-graph { position:absolute; inset:0; }
  .fixture-breadcrumb { display:flex; gap:8px; flex-wrap:wrap; padding:10px 16px; border-bottom:1px solid var(--line-2); }
  .fixture-breadcrumb:empty { display:none; }
  .fixture-controls { display:flex; gap:8px; align-items:center; }
  .fixture-pane .graph-bar-lead { gap:12px; }
`
document.head.append(style)
document.documentElement.dataset.theme = 'cobalt'
applyRoleColors()
document.querySelector('#fixture').innerHTML = `
  <section class="computers graph-wrap glass fixture-pane">
    <div class="graph-bar">
      <div class="graph-bar-lead"><strong>Tree navigation</strong><span>Example data</span></div>
      <div class="fixture-controls"><label>Tree size <select aria-label="Tree size"><option value="20">20 agents</option><option value="1000">1,000 agents</option></select></label><a href="/#/computers">Back to Computers</a></div>
      <div class="graph-tools"></div>
    </div>
    <nav class="fixture-breadcrumb" aria-label="Tree ancestry"></nav>
    <div class="fixture-slot"><div class="fixture-graph"></div></div>
  </section>`
const breadcrumb = document.querySelector('.fixture-breadcrumb')
const picker = document.querySelector('select')
const count = Number(new URLSearchParams(location.search).get('count')) === 1000 ? 1000 : 20
picker.value = String(count)
let graph
function mount(count) {
  graph?.destroy()
  breadcrumb.replaceChildren()
  const agents = Array.from({ length: count }, (_, i) => ({
    id: `example-${i}`, name: i === 0 ? 'Controller' : i === 6 ? 'Manager' : `Builder ${i}`,
    parentId: i === 0 ? null : count === 20 ? i < 7 ? 'example-0' : 'example-6' : `example-${Math.floor((i - 1) / 8)}`,
    role: i === 0 ? 'coordinator' : i === 6 ? 'manager' : 'builder',
    state: i % 3 ? 'finished' : 'interrupted',
  }))
  graph = new StaticTreeGraph(document.querySelector('.fixture-graph'), {
    computer: { id: 'navigation-example', agents }, emptySlots: false, screenChips: true,
    contextFeed: agent => ({ current: agent.state, previous: 'Review the assigned component and report the result to the parent agent.' }),
    onOpenControls: () => {},
    onRootChange(root, trail) {
      breadcrumb.replaceChildren()
      if (!root) return
      for (const entry of [{ id: null, name: 'Whole tree' }, ...trail]) {
        const button = document.createElement('button')
        button.textContent = entry.name
        button.addEventListener('click', () => entry.id ? graph.setRoot(entry.id) : graph.clearRoot())
        breadcrumb.append(button)
      }
    },
  })
  window.navigationGraph = graph
}
picker.addEventListener('change', () => mount(Number(picker.value)))
mount(count)
