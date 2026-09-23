// Area changes filter the existing elements. They never rebuild forms, alter
// module preferences, or write the saved arrangement. Browser Back remains
// page navigation; a return/reload remembers only the last area, never inputs.
export const RESEARCH_WORKFLOW_KEY = 'mc.research.workflow'
/* THE PAGES. Owner, 2026-09-10: "seperate the pages cleanly instead of bunching
   too much per page, and then have a final generation/run/review page for
   finalizing". Each page has one job and the builder's eleven steps are split
   across them (research-benchmark.css shows a page's own steps; the view
   lands the builder on one of them when the page changes). 'run' is the
   finalising page: analysis, generate and export, run, review. */
export const RESEARCH_AREAS = Object.freeze([
  { id: 'data', label: 'Files & data', modules: ['data'], description: 'Open your research folder, inspect its files, and import typed tables for your experiments.' },
  { id: 'design', label: 'Prompt design', modules: ['benchmark'], description: 'Author snippets, compositions and nests, create omission variants, then select the prompt distribution for your benchmark.' },
  { id: 'protocol', label: 'Protocol', modules: ['benchmark'], description: 'Fix the rules before anything runs: qualification, judge audit, decisions and pipeline, prompt workflow and accounting.' },
  { id: 'experiments', label: 'Experiments', modules: ['designer', 'tiers'], description: 'Define runs: the task, the dataset, the model tiers and the repeats, and see which local tiers can answer.' },
  { id: 'run', label: 'Review & Run', modules: ['benchmark', 'runboard', 'sessions', 'results', 'library'], description: 'Review every selection, freeze the benchmark, start the runs, watch them as they happen, then read the results and reports.' },
  { id: 'library', label: 'Library', modules: ['queue', 'methods', 'worklists'], description: 'Things you noticed that wait to be researched, the method rules you follow, and your working lists.' },
  { id: 'resources', label: 'Resource action', modules: ['resource'], description: 'Define resource environments, allowed changes, reference plans and effect measurements.' },
  { id: 'all', label: 'All modules', modules: null, description: 'Every enabled module in your saved arrangement. Edit layout to place or move modules.' },
])

export function createResearchWorkflow({ root, container, registry, storage, stopEditing, onReveal = () => {} }) {
  const buttons = [...root.querySelectorAll('[data-research-area]')]
  const description = root.querySelector('[data-workflow-description]')
  const empty = root.querySelector('[data-workflow-empty]')
  let area = 'data'
  try {
    const saved = storage?.getItem(RESEARCH_WORKFLOW_KEY)
    const current = saved === 'all' ? 'design' : saved === 'runs' || saved === 'evidence' ? 'run' : saved
    if (RESEARCH_AREAS.some(item => item.id === current)) area = current
  } catch {} // Navigation still works when browser preferences are unavailable.
  let returnArea = area

  function apply() {
    const current = RESEARCH_AREAS.find(item => item.id === area)
    root.dataset.researchArea = area
    for (const button of buttons) {
      button.setAttribute('aria-pressed', String(button.dataset.researchArea === area))
      if (button.dataset.researchArea === 'resources') button.hidden = !registry.isEnabled('resource') && area !== 'resources'
    }
    description.textContent = current.description
    let placed = 0
    for (const module of registry.all()) {
      module.el.hidden = !!current.modules && !current.modules.includes(module.id)
      if (!module.el.hidden && registry.isEnabled(module.id) && container.contains(module.el) && !module.el.closest('.m-stash')) placed++
    }
    // A saved row can contain modules from different areas. Collapse empty
    // rows and let the remaining modules fill that row without saving a move.
    for (const row of container.querySelectorAll(':scope > .m-srow')) {
      const count = [...row.children].filter(child => !child.hidden).length
      row.hidden = count === 0
      if (area === 'all') row.style.removeProperty('grid-template-columns')
      else row.style.setProperty('grid-template-columns', `repeat(${Math.max(1, count)}, minmax(0, 1fr))`)
    }
    onReveal()
    empty.hidden = placed > 0 || registry.enabled().length === 0
    empty.textContent = `No ${current.label.toLowerCase()} modules are placed in this layout. Use Modules to check what is enabled, or Edit layout to place them.`
  }
  function select(id) {
    if (!RESEARCH_AREAS.some(item => item.id === id)) return
    if (id !== 'all') stopEditing()
    area = id
    try { if (area !== 'all') storage?.setItem(RESEARCH_WORKFLOW_KEY, area) } catch {}
    apply()
  }
  for (const button of buttons) button.addEventListener('click', () => select(button.dataset.researchArea))
  // Native buttons provide Tab, Enter and Space; arrow keys are an additional
  // convenience, not a tab-widget contract over these filtered layout rows.
  root.querySelector('[data-workflow-nav]').addEventListener('keydown', event => {
    const available = buttons.filter(button => !button.hidden)
    const index = available.indexOf(event.target)
    if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? available.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : -1) + available.length) % available.length
    available[next].focus()
    available[next].click()
  })
  function focusModule(id, areaId) {
    select(areaId)
    const module = registry.all().find(item => item.id === id)
    if (!module || !registry.isEnabled(id) || module.el.closest('.m-stash')) {
      empty.hidden = false
      empty.textContent = 'That module is switched off or not placed in your layout. Use Modules or Edit layout to make it available.'
      empty.focus()
      return
    }
    const heading = module.el.querySelector('h2')
    heading?.setAttribute('tabindex', '-1')
    heading?.focus()
  }
  return { apply, select, focusModule, setLayoutEditing(editing) {
    if (editing) { if (area !== 'all') returnArea = area; select('all') }
    else if (area === 'all') select(returnArea)
  } }
}
