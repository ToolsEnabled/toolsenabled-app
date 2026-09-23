import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { register } from 'node:module'
import test, { after } from 'node:test'

register('./css-loader.mjs', import.meta.url)

const domModule = process.env.DOM_STAND_IN_MODULE
  ? await import(pathToFileURL(process.env.DOM_STAND_IN_MODULE).href)
  : await import('./lib/dom-stand-in.mjs')
const installed = domModule.installDomStandIn(globalThis)
after(() => installed.restore())

// Production writes styles through CSSStyleDeclaration. Observe that boundary
// without replacing shared nodes or changing their deliberately zero geometry.
const styleWrites = new WeakMap()
const sharedCreateElement = document.createElement.bind(document)
document.createElement = tag => {
  const node = sharedCreateElement(tag)
  const originalSetProperty = node.style.setProperty.bind(node.style)
  node.style.setProperty = (name, value) => {
    originalSetProperty(name, value)
    let writes = styleWrites.get(node)
    if (!writes) styleWrites.set(node, writes = new Map())
    writes.set(name, String(value))
  }
  return node
}

const { createMetricsLayout } = await import('../../src/metrics-layout.js')

function mount({ stored = null, getError = null, researchHead = false } = {}) {
  document.body.replaceChildren()
  const container = document.createElement('main')
  const filterRow = document.createElement('div')
  const editBtn = document.createElement('button')
  document.body.append(filterRow, container)
  const component = (id, options) => {
    const node = document.createElement('section')
    node.dataset.mc = id
    return { id, title: '', el: node, ...options }
  }
  const components = [
    component('fixture-a', { size: 'full' }),
    component('fixture-b', { size: 'slot', weight: 1.25, slimClass: 'is-slim' }),
    component('fixture-c', { size: 'slot', maxShare: 2 }),
    component('fixture-d', { size: 'slot', optional: true }),
  ]
  if (researchHead) {
    const head = document.createElement('div')
    head.className = 'research-section-head'
    const title = document.createElement('h2')
    title.textContent = 'Experiment designer'
    head.appendChild(title)
    components[0].el.appendChild(head)
    components[0].title = title.textContent
    components[0].headSelector = ':scope > .research-section-head'
  }
  const calls = []
  globalThis.localStorage = {
    getItem() { if (getError) throw getError; return stored },
    setItem(key, value) { calls.push(['set', key, value]) },
    removeItem(key) { calls.push(['remove', key]) },
  }
  const editReadings = []
  const layout = createMetricsLayout({
    container, filterRow, editBtn, components,
    standard: [['fixture-a'], ['fixture-b', 'fixture-c']],
    onEditChange: value => editReadings.push(value),
  })
  return { layout, container, editBtn, components, editReadings, calls, filterRow }
}

test('the direct-child selector excludes a nested shared row', () => {
  const fixture = document.createElement('div')
  const direct = document.createElement('div')
  direct.className = 'm-srow'
  const wrapper = document.createElement('div')
  const nested = document.createElement('div')
  nested.className = 'm-srow'
  wrapper.appendChild(nested)
  fixture.append(direct, wrapper)

  const matches = fixture.querySelectorAll(':scope > .m-srow')
  assert.equal(matches.length, 1, 'the child form must not include matching descendants')
  assert.equal(matches[0], direct, 'the child form must return the caller-owned direct node')
})

test('uses the callers’ persisted row model while preserving sharing constraints and component identity', () => {
  const persisted = JSON.stringify({ v: 1, rows: [['fixture-b', 'fixture-d'], ['fixture-a']] })
  const { layout, container, components } = mount({ stored: persisted })

  assert.deepEqual(layout.rows(), [['fixture-b', 'fixture-d'], ['fixture-a']],
    'a valid caller-shaped saved arrangement should be the exported row reading')
  const shared = container.querySelector(':scope > .m-srow')
  assert.equal(shared.children.length, 2, 'the persisted shared row should contain exactly its two components')
  assert.equal(shared.children[0], components[1].el,
    'the first shared child should be the caller-owned component object')
  assert.equal(shared.children[1], components[3].el,
    'the second shared child should be the caller-owned component object')
  assert.equal(shared.ownerDocument, document, 'the generated row should belong to the installed document')
  assert.equal(shared.parentNode, container, 'the generated row should retain its actual container parent')
  for (const component of [components[1].el, components[3].el]) {
    assert.equal(component.ownerDocument, document, 'a moved component should belong to the installed document')
    assert.equal(component.parentNode, shared, 'a moved component should link back to the shared row')
  }
  assert.equal(styleWrites.get(shared)?.get('--srow-cols'), 'minmax(0, 1.25fr) minmax(0, 1fr)',
    'slot weights should remain proportional without exposing a min-content overflow floor')
  assert.equal(components[1].el.classList.contains('is-slim'), true,
    'a component should receive its caller-provided slim skin only while sharing a row')
  layout.destroy()
})

test('falls back to the caller standard when storage cannot be read or claims an impossible layout', () => {
  const unreadable = mount({ getError: new Error('disk unavailable') })
  assert.deepEqual(unreadable.layout.rows(), [['fixture-a'], ['fixture-b', 'fixture-c']],
    'a could-not-read saved layout must remain non-authoritative and use the caller standard')
  unreadable.layout.destroy()

  const impossible = mount({ stored: JSON.stringify({ v: 1, rows: [['fixture-a', 'fixture-b']] }) })
  assert.deepEqual(impossible.layout.rows(), [['fixture-a'], ['fixture-b', 'fixture-c']],
    'a full-size component claiming a shared row must not become a definite arrangement')
  impossible.layout.destroy()
})

/* The injected edit caption exists to name an OTHERWISE UNLABELLED component
   while it is movable. A component that already carries its own accessible name
   renders that name itself, so captioning it again printed the title twice --
   observed on the research page, whose nine sections are `aria-labelledby` their
   own <h2>. This asserts the rendered reading, not the markup spelling: it counts
   how many times the title is actually readable inside the component. */
test('edit mode does not repeat the title of a component that already names itself', () => {
  document.body.replaceChildren()
  const container = document.createElement('main')
  const filterRow = document.createElement('div')
  const editBtn = document.createElement('button')
  document.body.append(filterRow, container)

  const TITLE = 'Experiment designer'
  const BARE_TITLE = 'Account pools'

  // shaped exactly like a research section: the element points at its own heading
  const labelled = document.createElement('section')
  labelled.dataset.mc = 'labelled'
  labelled.setAttribute('aria-labelledby', 'labelled-title')
  const heading = document.createElement('h2')
  heading.id = 'labelled-title'
  heading.textContent = TITLE
  labelled.appendChild(heading)

  // shaped like metrics' stats/pools: no heading of its own, so it still needs one
  const bare = document.createElement('section')
  bare.dataset.mc = 'bare'

  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
  const layout = createMetricsLayout({
    container,
    filterRow,
    editBtn,
    components: [
      { id: 'labelled', title: TITLE, el: labelled, size: 'full' },
      { id: 'bare', title: BARE_TITLE, el: bare, size: 'full' },
    ],
    standard: [['labelled'], ['bare']],
  })

  layout.setEdit(true)

  const readings = labelled.textContent.split(TITLE).length - 1
  assert.equal(readings, 1,
    'a component that names itself should read its title once in edit mode, not once per source')

  assert.equal(labelled.querySelector('#labelled-title')?.textContent, TITLE,
    'the component’s own heading must keep its accessible name and stay referenceable')
  assert.equal(labelled.getAttribute('aria-labelledby'), 'labelled-title',
    'the component must still point at the heading that names it')

  assert.ok(labelled.querySelector('.m-grip'), 'the move control must still be injected')
  assert.ok(labelled.querySelector('.m-x'), 'the remove control must still be injected')
  assert.match(labelled.querySelector('.m-grip').getAttribute('aria-label'), /Experiment designer/,
    'the grip must still name the component it moves, even with no visible caption')

  assert.equal(bare.textContent.split(BARE_TITLE).length - 1, 1,
    'a component with no heading of its own must still be captioned while it is movable')

  layout.destroy()
})

/* DROPPING THE CAPTION LEFT THE ROW BEHIND. Suppressing the duplicate title (the
   test above) means a self-naming component gets an injected head holding only the
   spacer and the grip/x pair -- a ~22px band of blank space above a section that
   already prints its own heading, nine times over on the research page in edit mode.
   The row cannot simply be collapsed: the controls live in it and must stay
   reachable. So the row is MARKED when it carries no caption, and the stylesheet
   lifts that marked row out of flow instead of letting it occupy a line of its own.

   `:empty` cannot express this -- the row still contains the spacer and the control
   group, so it is empty of CAPTION, not empty of DOM. A rule keyed on `:empty` would
   never match and would look applied while the band stayed. This asserts the hook the
   stylesheet keys on, and asserts it in both directions. */
test('a caption-less edit head is marked so it can be lifted out of flow, and a captioned one is not', () => {
  document.body.replaceChildren()
  const container = document.createElement('main')
  const filterRow = document.createElement('div')
  const editBtn = document.createElement('button')
  document.body.append(filterRow, container)

  // names itself, exactly as the nine research sections do -> no caption is written
  const labelled = document.createElement('section')
  labelled.dataset.mc = 'labelled'
  labelled.setAttribute('aria-labelledby', 'labelled-title')
  const heading = document.createElement('h2')
  heading.id = 'labelled-title'
  heading.textContent = 'Experiment designer'
  labelled.appendChild(heading)

  // no heading of its own, like metrics' stats/pools -> the caption is still written
  const bare = document.createElement('section')
  bare.dataset.mc = 'bare'

  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
  const layout = createMetricsLayout({
    container,
    filterRow,
    editBtn,
    components: [
      { id: 'labelled', title: 'Experiment designer', size: 'full', el: labelled },
      { id: 'bare', title: 'Account pools', size: 'full', el: bare },
    ],
    standard: [['labelled'], ['bare']],
  })

  layout.setEdit(true)

  const labelledHead = labelled.querySelector(':scope > .m-edit-head')
  const bareHead = bare.querySelector(':scope > .m-edit-head')
  assert.ok(labelledHead, 'a self-naming component should still get a row for its controls')
  assert.ok(bareHead, 'a component with no heading should still get a row')

  assert.equal(labelledHead.classList.contains('m-edit-head-bare'), true,
    'a row carrying no caption must be marked, so the stylesheet can lift it out of flow')
  assert.equal(labelledHead.querySelector('.mt'), null,
    'the marked row is marked precisely because it holds no caption')

  assert.equal(bareHead.classList.contains('m-edit-head-bare'), false,
    'a row that does carry a caption must NOT be marked -- it needs its own line')
  assert.ok(bareHead.querySelector('.mt'), 'the unmarked row should still caption an unlabelled component')

  // the controls are the reason the row cannot just be deleted
  for (const [name, node] of [['self-naming', labelled], ['unlabelled', bare]]) {
    assert.ok(node.querySelector('.m-grip'), `${name}: the move control must survive`)
    assert.ok(node.querySelector('.m-x'), `${name}: the remove control must survive`)
  }

  layout.destroy()
})

test('reports both edit-control states and gives a removed component a reason-bearing recovery control', () => {
  const { layout, editBtn, editReadings, components, filterRow } = mount()
  assert.equal(layout.editing, false, 'the exported initial control reading should be disabled')
  assert.equal(editBtn.getAttribute('aria-pressed'), 'false', 'the edit control should expose its disabled reading')

  layout.setEdit(true)
  assert.equal(layout.editing, true, 'setEdit should expose the enabled control reading')
  assert.equal(editBtn.getAttribute('aria-pressed'), 'true', 'the edit control should expose its enabled reading')
  assert.deepEqual(editReadings, [true], 'the caller should be told about the actual state transition')

  components[0]._ctl.querySelector('.m-x').click()
  assert.deepEqual(layout.rows(), [['fixture-b', 'fixture-c']],
    'activating remove should change the module’s named row output, not merely a truthy UI marker')
  const chip = filterRow.parentNode.querySelector('[data-chip="fixture-a"]')
  assert.match(chip.getAttribute('aria-label'), /removed.*(?:re-add|back onto the page)/i,
    'a currently unusable component should say why it is absent and how its recovery control succeeds')

  layout.setEdit(false)
  assert.equal(layout.editing, false, 'setEdit should return the exported control reading to disabled')
  assert.deepEqual(editReadings, [true, false], 'the caller should receive both control-state readings')
  layout.destroy()
})

test('uses the caller heading for layout controls and retains it after editing', () => {
  const { layout, components } = mount({ researchHead: true })
  const section = components[0].el
  const head = section.querySelector('.research-section-head')
  layout.setEdit(true)
  assert.equal(section.querySelector('.m-edit-head'), null, 'the existing module title must not be duplicated')
  assert.equal(head.querySelectorAll('.m-editctl').length, 1)
  layout.setEdit(false)
  assert.equal(section.querySelector('.research-section-head'), head, 'the original heading survives Done')
  assert.equal(head.querySelectorAll('.m-editctl').length, 0)
  assert.equal(head.classList.contains('m-layout-head'), false)
  layout.destroy()
})

test('destroy removes edit controls and detaches the shared button without saving or responding later', () => {
  const { layout, container, components, editBtn, filterRow, calls, editReadings } = mount({ researchHead: true })
  layout.setEdit(true)
  const staleRemove = components[0]._ctl.querySelector('.m-x')
  const before = layout.rows()
  layout.destroy()
  assert.equal(container.querySelectorAll('.m-editctl,.m-edit-head').length, 0)
  assert.equal(container.classList.contains('m-editing'), false)
  assert.equal(editBtn.getAttribute('aria-pressed'), 'false')
  assert.equal(layout.editing, false)
  staleRemove.click()
  layout.setEdit(true)
  editBtn.click()
  assert.deepEqual(layout.rows(), before)
  assert.deepEqual(calls, [], 'teardown and stale controls must not write layout preferences')
  assert.deepEqual(editReadings, [true], 'a destroyed instance must not answer the shared button')
  const next = createMetricsLayout({ container, filterRow, editBtn, components, standard: before })
  editBtn.click()
  assert.equal(next.editing, true)
  assert.equal(container.querySelectorAll('.m-editctl').length, components.length)
  editBtn.click()
  assert.equal(next.editing, false)
  assert.equal(container.querySelectorAll('.m-editctl,.m-edit-head').length, 0)
  next.destroy()
})
