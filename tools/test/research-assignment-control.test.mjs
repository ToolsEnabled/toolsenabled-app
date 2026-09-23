import test from 'node:test'
import assert from 'node:assert/strict'

const decode = value => value
  .replace(/&quot;/g, '"')
  .replace(/&gt;/g, '>')
  .replace(/&lt;/g, '<')
  .replace(/&amp;/g, '&')

class StandInElement {
  constructor({ html = '', text = '', value = '' } = {}) {
    this.innerHTML = html
    this.textContent = text
    this.value = value
    this.disabled = false
    this.listeners = new Map()
  }

  addEventListener(type, listener) { this.listeners.set(type, listener) }
  async click() { await this.listeners.get('click')?.({ target: this }) }
}

function elementFrom(html) {
  const root = new StandInElement({ html })
  const state = html.match(/data-assign-state="([^"]+)"/)?.[1]
  root.dataset = { assignState: state }
  const paragraph = html.match(/<p[^>]*>([\s\S]*?)<\/p>/)?.[1]
  const status = new StandInElement()
  const apply = new StandInElement()
  const options = [...html.matchAll(/<option value="([^"]*)"([^>]*)>([\s\S]*?)<\/option>/g)]
    .map(match => ({ value: decode(match[1]), selected: /\sselected(?:\s|$)/.test(match[2]), textContent: decode(match[3]) }))
  const select = new StandInElement({ value: options.find(option => option.selected)?.value ?? options[0]?.value ?? '' })
  select.options = options
  const nodes = {
    '[data-assign-select]': options.length ? select : null,
    '[data-assign-apply]': options.length ? apply : null,
    '[data-assign-status]': options.length ? status : null,
    '.research-observed-empty': paragraph == null ? null : new StandInElement({ text: decode(paragraph) }),
  }
  root.querySelector = selector => nodes[selector] ?? null
  return root
}

globalThis.document = {
  createElement(tag) {
    assert.equal(tag, 'template')
    const template = { content: { firstElementChild: null } }
    Object.defineProperty(template, 'innerHTML', {
      set(html) { template.content.firstElementChild = elementFrom(html) },
    })
    return template
  },
}

const { createAssignmentControl } = await import('../../src/research-assignment-control.js')

test('a failed project read remains an explicit unavailable answer', () => {
  const root = createAssignmentControl({
    projects: [],
    unavailableReason: 'the service returned <untrusted> details',
  })

  assert.equal(root.dataset.assignState, 'unavailable', 'read failures must render the unavailable state')
  assert.match(
    root.querySelector('.research-observed-empty').textContent,
    /could not be read.*service returned <untrusted> details/i,
    'read failures must explain that projects could not be read and preserve the reason',
  )
})

test('a successful empty read gives the user a next step', () => {
  const root = createAssignmentControl({ projects: [] })

  assert.equal(root.dataset.assignState, 'empty', 'a successful empty read must render the empty state')
  assert.match(
    root.querySelector('.research-observed-empty').textContent,
    /no research projects.*create one.*research page/i,
    'the empty state must say there are no projects and where to create one',
  )
})

test('real caller project data produces a labelled selection with filing context', () => {
  const root = createAssignmentControl({
    projects: [
      { projectId: 'alpha&one', name: 'Alpha <One>' },
      { projectId: 'paused', name: 'Paused', enabled: false },
    ],
    label: 'File this scope under',
    currentProjectIds: ['paused'],
    onAssign: async () => ({ ok: true }),
  })
  const select = root.querySelector('[data-assign-select]')

  assert.equal(root.dataset.assignState, 'ready', 'readable projects must render the ready assignment state')
  assert.deepEqual(
    select.options,
    [
      { value: 'alpha&one', selected: false, textContent: 'Alpha <One>' },
      { value: 'paused', selected: true, textContent: 'Paused (switched off)' },
    ],
    'project choices must preserve ids and names, mark existing filing, and disclose switched-off projects',
  )
  assert.match(root.innerHTML, /File this scope under[\s\S]*aria-label="File this scope under"/, 'the caller label must name both the visible control and its accessible select')
})

test('assigning passes the selected project and reports store outcomes', async () => {
  const calls = []
  let resolveAssignment
  const root = createAssignmentControl({
    projects: [{ projectId: 'project-1', name: 'One' }, { projectId: 'project-2', name: 'Two' }],
    onAssign: projectId => {
      calls.push(projectId)
      return new Promise(resolve => { resolveAssignment = resolve })
    },
  })
  const select = root.querySelector('[data-assign-select]')
  const apply = root.querySelector('[data-assign-apply]')
  const status = root.querySelector('[data-assign-status]')
  select.value = 'project-2'
  const click = apply.click()

  assert.equal(apply.disabled, true, 'the apply button must stay disabled while assignment is pending')
  assert.deepEqual(calls, ['project-2'], 'assignment must receive the project selected by the user')
  resolveAssignment({ ok: true, alreadyAssigned: true })
  await click
  assert.match(status.textContent, /already filed/i, 'an existing assignment must be reported as already filed')
  assert.equal(apply.disabled, false, 'the apply button must be restored after assignment settles')
})

test('refusals and thrown writes remain visible instead of looking successful', async () => {
  let outcome = { ok: false, sentence: 'The project is switched off.' }
  const root = createAssignmentControl({
    projects: [{ projectId: 'paused', name: 'Paused' }],
    onAssign: async () => {
      if (outcome instanceof Error) throw outcome
      return outcome
    },
  })
  const apply = root.querySelector('[data-assign-apply]')
  const status = root.querySelector('[data-assign-status]')

  await apply.click()
  assert.match(status.textContent, /project is switched off/i, 'a store refusal must show its reason')
  outcome = new Error('Assignment service is unreachable.')
  await apply.click()
  assert.match(status.textContent, /service is unreachable/i, 'a thrown assignment must show its failure reason')
})
