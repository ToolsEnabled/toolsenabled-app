import '../../../src/styles.css'
import '../../../src/role-studio.css'
import '../../../src/tree-graph.css'
import '@fontsource-variable/ibm-plex-sans/index.css'
import '@fontsource-variable/jetbrains-mono/index.css'
import { buildRoleStudio } from '../../../src/role-studio.js'
import { applyTextSize } from '../../../src/text-size.js'
import { applyFontChoice, FONT_CHOICES } from '../../../src/font-choice.js'

// Real component and sheets; role operations are deliberately unavailable.
const operations = []
let box, tree
const settle = async () => {
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  // Mounting a view can request additional font subsets after the initial load.
  await document.fonts.ready
  await new Promise(resolve => requestAnimationFrame(resolve))
}
const press = selector => box.querySelector(selector).click()
const write = (field, value) => {
  const input = box.querySelector(`[data-field="${field}"]`)
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
const common = ['[data-action="close"]', '[data-action="canvas"]', '[data-role-search]', '[data-action="new"]', '[data-action="import"]']
const editor = [...common, '[data-tab="directions"]', '[data-tab="functions"]', '[data-tab="preview"]', '[data-action="save"]', '[data-action="discard"]']
window.roleLayout = {
  operations,
  async open(font, size) {
    if (box?.querySelector('dialog').open) box.querySelector('dialog').close()
    tree?.remove()
    applyTextSize(String(size))
    applyFontChoice(font)
    await document.fonts.load('14px ' + FONT_CHOICES.find(choice => choice.id === font).stack)
    await document.fonts.ready
    box = buildRoleStudio({
      availability: { state: 'ready', overlayFile: 'isolated-layout-fixture', functionCatalog: [], org: { agents: [] },
        roles: [{ id: 'worker', name: 'Fixture worker', summary: 'An isolated role layout fixture.', revision: 1,
          owns: 'Inspect the requested task.', mustNot: 'Change files.', handoff: 'Return the observations.' }] },
      onCreate: value => { operations.push(['create', value]); return { ok: false } },
      onEdit: value => { operations.push(['edit', value]); return { ok: false } },
      onReset: value => { operations.push(['reset', value]); return { ok: false } },
      onRead: async () => null,
    })
    // The production Roles button opens a library inside the hidden sidebar
    // of the wide tree workspace. A body-mounted dialog missed that failure.
    tree = document.createElement('div')
    tree.className = 'computers'
    tree.innerHTML = '<div class="comp-body tree-workspace-wide"><aside class="rail glass"><div class="rail-page stats-page is-active"><details open><summary>Configuration</summary><div data-library-slot></div></details></div></aside></div>'
    tree.querySelector('[data-library-slot]').replaceWith(box)
    document.body.append(tree)
    const sidebarInitiallyHidden = getComputedStyle(tree.querySelector('.rail')).display === 'none'
    press('[data-open-studio]')
    await settle()
    return { font, size, sidebarInitiallyHidden, viewport: { width: innerWidth, height: innerHeight }, bodyZoom: getComputedStyle(document.body).zoom,
      fontFamily: getComputedStyle(box.querySelector('dialog')).fontFamily, fontStatus: document.fonts.status }
  },
  async measure(view) {
    let selectors = common
    if (view === 'canvas') selectors = [...common, '[data-action="zoom-out"]', '[data-action="zoom-in"]', '[data-action="fit"]', '[data-action="arrange"]']
    if (view === 'directions') {
      press('[data-select-role="worker"]')
      write('owns', 'This is an unsaved layout fixture draft.')
    }
    if (view === 'functions' || view === 'preview') press(`[data-tab="${view}"]`)
    if (view === 'reset') press('[data-action="reset"]')
    if (view === 'new') {
      press('[data-action="cancel-reset"]')
      press('[data-action="new"]')
      write('id', 'layout-fixture')
      for (const field of ['owns', 'mustNot', 'handoff']) write(field, 'Unsaved fixture ' + field)
    }
    if (view !== 'canvas') selectors = [...editor, ...(view === 'new' ? ['[data-field="id"]', '[data-field="base"]'] : ['[data-action="duplicate"]', '[data-action="reset"]'])]
    if (view === 'reset') selectors.push('[data-action="confirm-reset"]', '[data-action="cancel-reset"]')
    const main = box.querySelector('[data-studio-main]')
    main.scrollTop = 0
    await settle()
    const dialog = box.querySelector('dialog')
    const controls = selectors.map(selector => {
      const control = box.querySelector(selector)
      const initial = control.getBoundingClientRect().toJSON()
      // A footer may scroll on a short window, but must be reachable inside it.
      control.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      control.focus({ preventScroll: true })
      const rect = control.getBoundingClientRect().toJSON()
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return { selector, initial, rect, enabled: !control.disabled, focused: document.activeElement === control,
        hittable: hit === control || control.contains(hit) }
    })
    return { view, nativeModal: dialog.matches(':modal'), dialog: dialog.getBoundingClientRect().toJSON(), controls,
      horizontalOverflow: main.scrollWidth - main.clientWidth }
  },
  closePoint() {
    const control = box.querySelector('[data-action="close"]')
    const r = control.getBoundingClientRect()
    const point = { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    const hit = document.elementFromPoint(point.x, point.y)
    return { ...point, hittable: hit === control || control.contains(hit) }
  },
  isOpen: () => box.querySelector('dialog').open,
  sidebarHidden: () => getComputedStyle(tree.querySelector('.rail')).display === 'none',
}
