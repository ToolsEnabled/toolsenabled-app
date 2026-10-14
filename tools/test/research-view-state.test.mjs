import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import test, { afterEach, beforeEach } from 'node:test'
import { Element, installDomStandIn } from './lib/dom-stand-in.mjs'

register('./css-loader.mjs', import.meta.url)
const { researchView } = await import('../../src/views/research.js')
const { createAssignmentStore } = await import('../../src/research-assignments.js')
const experiments = await import('../../src/research-experiments.js')
const { DATA_SOURCE_EVENT } = await import('../../src/data-source.js')
const catalogSchema = JSON.parse(readFileSync(new URL('../../public/data/schema/research.schema.json', import.meta.url)))
const shippedCatalog = JSON.parse(readFileSync(new URL('../../public/data/research.json', import.meta.url)))
const DESTINATION = 'synthetic-account/synthetic-relay/synthetic-device'
const ASSIGNMENT_FIXTURE_KEY = 'mc.research.assignments.destination.v1.' + encodeURIComponent(DESTINATION)
const views = []
const originalMatches = Element.prototype.matches
const originalQueryAll = Element.prototype.querySelectorAll
let fixture, installed, originals
const pause = () => new Promise(resolve => setTimeout(resolve, 5))
async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) { if (predicate()) return; await pause() }
  assert.fail('the research view did not settle')
}
const answer = (value, status = 200) => new Response(JSON.stringify(value), { status })
async function bridge(path, { body } = {}) {
  const state = fixture
  if (path.endsWith('/research-run-submit')) {
    const index = state.submissions.push(structuredClone(body))
    if (index === 1) await new Promise(resolve => state.pendingSubmissions.push(resolve))
    return { ok: true, receipt: { disposition: 'created', run: { runId: 'scope-run-' + index }, experiment: { experimentId: 'scope-experiment' } } }
  }
  if (path.endsWith('/research-snapshot')) {
    const result = state.snapshotUnavailable ? { ok: false, reason: 'Synthetic snapshot unavailable' } : { ok: true, receipt: {
      projects: [...state.projects], experiments: state.serviceExperiments || {}, assignments: structuredClone(state.assignments),
      settings: { pipelineEnabled: false }, lifecycle: { running: false },
    } }
    if (state.holdSnapshot) await new Promise(resolve => state.pendingSnapshots.push(resolve))
    return result
  }
  if (path.endsWith('/research-session-assign')) {
    state.assignmentCalls.push(structuredClone(body))
    if (state.holdAssignments) await new Promise(resolve => state.pendingAssignments.push(resolve))
    if (!state.assignmentsOnline) return { ok: false, code: 'BRIDGE_UNREACHABLE', reason: 'Synthetic assignment service unavailable' }
    assert.deepEqual(body.assign, [])
    const unassigned = []
    for (const removal of body.unassign) {
      const row = state.assignments.find(row => row.projectId === body.projectId
        && (removal.assignmentId ? row.assignmentId === removal.assignmentId : row.kind === removal.kind && row.ref === removal.ref))
      if (!row) return { ok: false, code: 'RESEARCH_ASSIGNMENT_NOT_FOUND' }
      unassigned.push(row)
      state.assignments = state.assignments.filter(entry => entry !== row)
    }
    return { ok: true, receipt: { projectId: body.projectId, assigned: [], unassigned } }
  }
  if (path.endsWith('/research-project-save')) {
    state.saves.push(structuredClone(body))
    const result = await new Promise(resolve => state.pending.push(resolve))
    if (result?.ok === false) return result
    const project = { projectId: 'rp-' + state.saves.length.toString(16).padStart(36, '0'), name: body.name, enabled: true }
    state.projects.push(project)
    return { ok: true, receipt: { project } }
  }
  if (path.endsWith('/research-finding-save')) {
    const index = state.findingSaves.push(structuredClone(body))
    const result = await new Promise((resolve, reject) => state.pendingFindings.push({ resolve, reject }))
    if (result?.ok === false) return result
    const findingId = 'finding-fixture-' + index
    state.findings.push({ ...body, findingId })
    return { ok: true, receipt: { findingId } }
  }
  if (path.endsWith('/research-findings')) {
    state.findingReads++
    return { ok: true, receipt: { findings: state.findings.filter(row => row.projectId === body.projectId) } }
  }
  if (state.serviceExperiments && path.endsWith('/research-runs')) {
    return { ok: true, receipt: { runs: [{ runId: 'run-' + body.experimentId, experimentId: body.experimentId,
      params: {}, task: { status: 'succeeded' } }], pagination: { version: 1, experimentId: body.experimentId,
      total: 1, offset: 0, snapshot: 'fixture-history', nextCursor: null } } }
  }
  if (state.serviceExperiments && path.endsWith('/research-results')) return { ok: true, receipt: { results: [] } }
  return { ok: false, reason: 'Synthetic read unavailable' }
}

beforeEach(() => {
  originals = new Map(['localStorage', 'getComputedStyle', 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  installed = installDomStandIn(globalThis)
  // Supply the browser selectors exercised by this mounted form. The shared
  // stand-in intentionally omits compound attributes and these two pseudos.
  Element.prototype.matches = function (selector) {
    const compound = selector.match(/^([\w-]+)(\[[^\]]+\])$/)
    return compound
      ? this.tagName === compound[1].toUpperCase() && originalMatches.call(this, compound[2])
      : originalMatches.call(this, selector)
  }
  Element.prototype.querySelectorAll = function (selector) {
    const pseudo = selector.match(/^(.*):(checked|last-child)$/)
    if (!pseudo) return originalQueryAll.call(this, selector)
    return originalQueryAll.call(this, pseudo[1]).filter(node => pseudo[2] === 'checked'
      ? node.checked : node.parentNode?.lastElementChild === node)
  }
  // The shared stand-in has insertion and parsing primitives, but no HTML
  // convenience method. Supply that browser operation locally, not product
  // behavior or a transformed copy of researchView.
  Element.prototype.insertAdjacentHTML = function (position, html) {
    const template = this.ownerDocument.createElement('template')
    template.innerHTML = html
    const children = [...template.children]
    if (position === 'afterend' || position === 'afterbegin') children.reverse()
    for (const child of children) this.insertAdjacentElement(position, child)
  }
  fixture = { values: new Map(), projects: [], saves: [], pending: [], catalog: 'shipped',
    assignments: [], assignmentCalls: [], assignmentsOnline: true, pendingAssignments: [], pendingSnapshots: [],
    submissions: [], pendingSubmissions: [], findingSaves: [], pendingFindings: [], findings: [], findingReads: 0 }
  const storage = {
    getItem: key => {
      if (key === ASSIGNMENT_FIXTURE_KEY) {
        fixture.assignmentReads = (fixture.assignmentReads || 0) + 1
        if (fixture.assignmentReads === fixture.failAssignmentReadAt) throw Error('Synthetic assignment cache read refused')
      }
      return fixture.values.get(key) ?? null
    },
    setItem: (key, value) => fixture.values.set(key, String(value)),
    removeItem: key => fixture.values.delete(key),
  }
  window.localStorage = storage
  window.mcShell = { getBridgeProof: () => assert.fail('no native bootstrap'), getBridgeTransport: async () => bridge,
    captureResearchAssignmentDestination: async () => ({ ok: true, key: DESTINATION,
      request: (action, body) => bridge('/v1/actions/' + action, { body }) }),
  }
  globalThis.localStorage = storage
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '', overflowY: 'visible', display: 'block' })
  globalThis.fetch = async input => {
    const path = String(input)
    if (path.endsWith('/data/schema/research.schema.json')) return answer(fixture.catalog === 'schema' ? {} : catalogSchema)
    if (path.endsWith('/data/research-queue.json')) return answer({ schemaVersion: 1, items: [] })
    if (path.endsWith('/data/research.json')) {
      if (fixture.catalog === 'http') return answer({}, 503)
      if (fixture.catalog === 'json') return new Response('{invalid')
      if (fixture.catalog === 'unavailable') return answer({ ...shippedCatalog, generatedAt: '2026-09-08T00:00:00.000Z', reason: 'Synthetic catalog storage unavailable' })
      return answer(shippedCatalog)
    }
    assert.fail('unexpected non-fixture request: ' + path)
  }
})
afterEach(async () => {
  for (const view of views.splice(0)) { view.destroy(); view.el.remove() }
  fixture.pending.splice(0).forEach(resolve => resolve({ ok: false, reason: 'Fixture cleanup' }))
  fixture.pendingAssignments.splice(0).forEach(resolve => resolve())
  fixture.pendingSnapshots.splice(0).forEach(resolve => resolve())
  fixture.pendingSubmissions.splice(0).forEach(resolve => resolve())
  fixture.pendingFindings.splice(0).forEach(({ resolve }) => resolve({ ok: false, reason: 'Fixture cleanup' }))
  await pause()
  installed.restore()
  delete Element.prototype.insertAdjacentHTML
  Element.prototype.matches = originalMatches
  Element.prototype.querySelectorAll = originalQueryAll
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else delete globalThis[key]
  }
})
async function mount() {
  const view = researchView()
  views.push(view)
  document.body.appendChild(view.el)
  await until(() => view.el.getAttribute('aria-busy') === 'false' && !view.el.querySelector('[data-project-select]').disabled)
  return view
}
const moduleIds = view => view.el.querySelectorAll('[data-mc]').map(node => node.dataset.mc)

async function mountFindingForms(count = 1) {
  const projectId = 'rp-' + 'b'.repeat(36)
  fixture.projects.push({ projectId, name: 'Finding custody fixture', enabled: true })
  fixture.values.set('mc.research.project', projectId)
  fixture.serviceExperiments = { [projectId]: Array.from({ length: count }, (_, index) => ({
    experimentId: 'finding-experiment-' + index, name: 'Finding experiment ' + index,
    axes: {}, resultSchema: [],
  })) }
  const view = await mount()
  await until(() => view.el.querySelectorAll('[data-finding-form]').length === count)
  return { view, forms: view.el.querySelectorAll('[data-finding-form]'), projectId }
}
const findingStatus = form => form.querySelector('[data-finding-status]')
const findingButton = form => form.querySelector('button')
function submitFinding(form, claim) {
  if (claim !== undefined) form.elements.claim.value = claim
  form.dispatch('submit')
}
function editFinding(form, claim) { form.elements.claim.value = claim; form.elements.claim.dispatch('input') }

test('finding submit holds one pending save through the real mounted form and client', async () => {
  const { forms: [form], projectId } = await mountFindingForms()
  submitFinding(form, '  Preserve one submitted claim.  ')
  submitFinding(form)
  await until(() => fixture.pendingFindings.length > 0)
  assert.equal(fixture.findingSaves.length, 1, 'repeated pending submits must not create two durable findings')
  assert.deepEqual(fixture.findingSaves[0], { projectId, claim: 'Preserve one submitted claim.', status: 'open' })
  assert.equal(findingButton(form).disabled, true)
  fixture.pendingFindings.shift().resolve()
  await until(() => findingStatus(form).textContent.includes('Recorded as finding-fixture-1.'))
  assert.equal(form.elements.claim.value, '')
  assert.equal(findingButton(form).disabled, false)
  assert.equal(fixture.findings.length, 1)
})

for (const sameAgain of [false, true]) test(`finding success preserves edits made while pending (same text again: ${sameAgain})`, async () => {
  const { forms: [form] } = await mountFindingForms()
  submitFinding(form, 'First submitted claim.')
  await until(() => fixture.pendingFindings.length === 1)
  editFinding(form, 'A newer claim being composed.')
  if (sameAgain) editFinding(form, 'First submitted claim.')
  const draft = form.elements.claim.value
  fixture.pendingFindings.shift().resolve()
  await until(() => findingStatus(form).textContent.includes('Recorded as'))
  assert.equal(form.elements.claim.value, draft, 'a late receipt must not erase a newer input revision')
  assert.equal(fixture.findings[0].claim, 'First submitted claim.')
  assert.equal(findingButton(form).disabled, false)
})

for (const failure of ['refusal', 'rejection']) test(`finding ${failure} preserves the draft and releases one explicit retry`, async () => {
  const { forms: [form] } = await mountFindingForms()
  submitFinding(form, 'Retry this claim only when asked.')
  await until(() => fixture.pendingFindings.length === 1)
  const pending = fixture.pendingFindings.shift()
  if (failure === 'refusal') pending.resolve({ ok: false, reason: 'Synthetic save refusal' })
  else pending.reject(new Error('Synthetic save transport rejection'))
  await until(() => findingStatus(form).textContent.length > 0 && !findingButton(form).disabled)
  assert.doesNotMatch(findingStatus(form).textContent, /Recorded as/)
  assert.equal(form.elements.claim.value, 'Retry this claim only when asked.')
  assert.equal(fixture.findingSaves.length, 1, 'failure must not automatically retry')
  assert.equal(fixture.findings.length, 0)
  submitFinding(form); submitFinding(form)
  await until(() => fixture.pendingFindings.length > 0)
  assert.equal(fixture.findingSaves.length, 2)
  fixture.pendingFindings.shift().resolve()
  await until(() => findingStatus(form).textContent.includes('Recorded as finding-fixture-2.'))
  assert.equal(findingButton(form).disabled, false)
})

test('independent finding forms can save concurrently without blocking or clearing each other', async () => {
  const { forms: [first, second] } = await mountFindingForms(2)
  submitFinding(first, 'First experiment claim.')
  submitFinding(second, 'Second experiment claim.')
  await until(() => fixture.pendingFindings.length === 2)
  assert.equal(fixture.findingSaves.length, 2)
  fixture.pendingFindings[1].resolve()
  await until(() => findingStatus(second).textContent.includes('Recorded as'))
  assert.equal(second.elements.claim.value, '')
  assert.equal(first.elements.claim.value, 'First experiment claim.')
  assert.equal(findingButton(first).disabled, true)
  fixture.pendingFindings[0].resolve()
  fixture.pendingFindings = []
  await until(() => findingStatus(first).textContent.includes('Recorded as'))
  assert.equal(first.elements.claim.value, '')
})

for (const replaced of ['destroyed', 'replaced', 'source-epoch']) test(`finding completion cannot repaint a ${replaced} form context`, async () => {
  const { view, forms: [form] } = await mountFindingForms()
  submitFinding(form, 'Claim from the old context.')
  await until(() => fixture.pendingFindings.length === 1)
  const pending = fixture.pendingFindings.shift()
  if (replaced === 'destroyed') { view.destroy(); view.el.remove() }
  else if (replaced === 'replaced') {
    const select = view.el.querySelector('[data-project-select]')
    select.value = 'all'; select.dispatch('change')
    await until(() => !form.isConnected && view.el.querySelector('[data-finding-form]'))
    editFinding(view.el.querySelector('[data-finding-form]'), 'Current replacement draft.')
  } else {
    fixture.holdSnapshot = true
    window.dispatchEvent(new CustomEvent(DATA_SOURCE_EVENT))
    await until(() => fixture.pendingSnapshots.length > 0)
  }
  const oldStatus = findingStatus(form).textContent
  const reads = fixture.findingReads
  pending.resolve()
  await until(() => fixture.findings.length === 1)
  await pause()
  assert.equal(form.elements.claim.value, 'Claim from the old context.')
  assert.equal(findingStatus(form).textContent, oldStatus)
  assert.equal(fixture.findingReads, reads, 'retired save must not initiate fresh reads in another context')
  if (replaced === 'replaced') assert.equal(view.el.querySelector('[data-finding-form]').elements.claim.value, 'Current replacement draft.')
})

test('a locally refused empty finding releases the same form for a valid save', async () => {
  const { forms: [form] } = await mountFindingForms()
  submitFinding(form, '   ')
  await until(() => findingStatus(form).textContent.includes('Write the claim first'))
  assert.equal(fixture.findingSaves.length, 0)
  assert.equal(findingButton(form).disabled, false)
  submitFinding(form, 'Now a valid claim.')
  await until(() => fixture.pendingFindings.length === 1)
  fixture.pendingFindings.shift().resolve()
  await until(() => findingStatus(form).textContent.includes('Recorded as'))
})

for (const changed of ['unchanged', 'project', 'account', 'view']) test(`manual Research queue submission respects its ${changed} context`, async t => {
  experiments.resetExperimentTracking()
  t.after(() => experiments.resetExperimentTracking())
  const projectId = 'rp-' + 'a'.repeat(36)
  fixture.projects.push({ projectId, name: 'Synthetic submission project', enabled: true })
  const built = experiments.buildExperiment({ name: 'Dispatch context', projectId,
    axes: [{ id: 'fixture', values: ['first', 'second'] }],
    runner: { kind: 'process', command: 'never-executed-fixture', args: [] }, runsPerCell: 1 }, { experiments: [] })
  assert.equal(built.ok, true)
  let row = built.serialized
  const writes = []
  window.mcAccount = {
    getSetting: async key => ({ ok: true, accountId: 'scope-account', value: key === experiments.RESEARCH_EXPERIMENTS_ROW_KEY ? row : null }),
    putSetting: async (key, value, options) => {
      if (key === experiments.RESEARCH_EXPERIMENTS_ROW_KEY) {
        assert.equal(options.expectedAccountId, 'scope-account')
        writes.push(value)
      }
      return { ok: true }
    },
  }
  const view = await mount()
  const select = view.el.querySelector('[data-project-select]')
  select.value = projectId
  select.dispatchEvent(new Event('change'))
  view.el.querySelector('[data-exp-run]').click()
  await until(() => fixture.pendingSubmissions.length === 1)
  if (changed === 'project') { select.value = 'all'; select.dispatchEvent(new Event('change')) }
  if (changed === 'account') {
    row = null
    window.dispatchEvent(new CustomEvent(DATA_SOURCE_EVENT))
    await until(() => experiments.experimentsSnapshot().experiments.length === 0)
  }
  if (changed === 'view') { view.destroy(); view.el.remove() }
  fixture.pendingSubmissions.shift()()
  await pause()
  assert.equal(fixture.submissions.length, changed === 'unchanged' ? 2 : 1)
  assert.equal(writes.length, changed === 'unchanged' ? 1 : 0)
  if (changed === 'unchanged') {
    assert.deepEqual(experiments.parseExperimentsRow(writes[0]).experiments[0].cells.map(cell => cell.runId), ['scope-run-1', 'scope-run-2'])
  }
  if (changed === 'account') assert.deepEqual(experiments.experimentsSnapshot().experiments, [])
})

for (const previous of ['runs', 'evidence']) test(`the former ${previous} page opens Run & review without discarding its saved choice`, async () => {
  fixture.values.set('mc.research.workflow', previous)
  const view = await mount()
  assert.equal(view.el.dataset.researchArea, 'run')
  assert.equal(view.el.querySelector('[data-research-area="run"]').getAttribute('aria-pressed'), 'true')
  assert.equal(fixture.values.get('mc.research.workflow'), previous)
})

test('refused remote account reads keep both research forms closed and show the actual connection reason', async () => {
  const reason = 'The account signed in on this computer does not own its browser connection.'
  window.mcAccount = {
    getSetting: async () => ({ ok: false, code: 'HOSTED_ACCOUNT_DEVICE_REFUSED', reason }),
    putSetting: () => assert.fail('a failed read must not expose a writable form'),
  }
  const view = await mount()
  assert.equal(view.el.querySelector('[data-queue-form]'), null)
  assert.match(view.el.querySelector('[data-mc="queue"]').textContent, /does not own its browser connection/)
  assert.match(view.el.querySelector('[data-research-designer]').textContent, /does not own its browser connection/)
  assert.doesNotMatch(view.el.querySelector('[data-research-designer]').textContent, /needs somebody signed in/)
})

test('disabled modules stay detached on fresh visits while all-on restores their controls', async () => {
  fixture.values.set('mc.research.modules', JSON.stringify({ v: 1, disabled: ['queue', 'library'] }))
  const first = await mount()
  assert.ok(!moduleIds(first).includes('queue'))
  assert.ok(!moduleIds(first).includes('library'))
  assert.ok(moduleIds(first).includes('designer'))
  first.destroy(); first.el.remove()
  const next = await mount()
  assert.ok(!moduleIds(next).includes('queue'))
  next.el.querySelector('[data-modules-all-on]').click()
  assert.ok(moduleIds(next).includes('queue'))
  assert.ok(moduleIds(next).includes('library'))
  assert.equal(next.el.querySelector('[data-research-edit]').hidden, false)
})

test('all-off survives a new view without displaying disabled sections or stuck catalog loaders', async () => {
  const first = await mount()
  first.el.querySelector('[data-modules-all-off]').click()
  assert.deepEqual(moduleIds(first), [])
  first.destroy(); first.el.remove()
  const next = await mount()
  assert.deepEqual(moduleIds(next), [])
  assert.equal(next.el.querySelector('[data-research-none]').hidden, false)
  next.el.querySelector('[data-modules-all-on]').click()
  assert.ok(moduleIds(next).includes('designer'))
  assert.match(next.el.querySelector('[data-research-library]').textContent, /not shipped/)
  assert.doesNotMatch(next.el.querySelector('[data-research-library]').textContent, /Reading/)
})

test('the shipped placeholder keeps its absence explanation without blaming a service failure', async () => {
  const view = await mount()
  assert.match(view.el.querySelector('[data-research-unavailable]').textContent, /not shipped/)
  assert.doesNotMatch(view.el.querySelector('[data-research-unavailable]').textContent, /could not be read/)
})
for (const failure of ['http', 'json', 'schema', 'unavailable']) {
  test(`a ${failure} catalog failure stays unavailable while projects remain usable`, async () => {
    fixture.catalog = failure
    const view = await mount()
    const notice = view.el.querySelector('[data-research-unavailable]').textContent
    assert.match(notice, /could not be read|unavailable/i)
    assert.doesNotMatch(notice, /not shipped|nothing.*missing or broken/i)
    assert.equal(view.el.querySelector('[data-project-select]').disabled, false)
    assert.doesNotMatch(view.el.querySelector('[data-research-library]').textContent, /not shipped/)
  })
}
test('a later catalog failure replaces earlier absence wording in the library as well as the mast', async () => {
  const view = await mount()
  fixture.catalog = 'http'
  window.dispatch('mc:data-source-changed')
  await until(() => /could not be read|unavailable/i.test(view.el.querySelector('[data-research-source]').textContent))
  assert.doesNotMatch(view.el.querySelector('[data-research-library]').textContent, /not shipped/)
})

function enterProject(view, name) {
  view.el.querySelector('[data-project-new]').click()
  const input = view.el.querySelector('[data-project-new-name]')
  input.value = name
  input.dispatch('keydown', { key: 'Enter' })
  return input
}
test('repeated Enter and a Create click share one pending project creation, then permit the next creation', async () => {
  const view = await mount()
  const input = enterProject(view, 'First project')
  await until(() => fixture.saves.length > 0)
  input.dispatch('keydown', { key: 'Enter' })
  view.el.querySelector('[data-project-new-save]').click()
  await pause()
  assert.deepEqual(fixture.saves, [{ name: 'First project', enabled: true }])
  assert.equal(view.el.querySelector('[data-project-new-save]').disabled, true)
  fixture.pending.shift()()
  await until(() => view.el.querySelector('[data-project-new-form]').hidden)
  assert.doesNotMatch(view.el.querySelector('[data-project-status]').textContent, /not created|Nothing was saved/)
  enterProject(view, 'Next project')
  await until(() => fixture.saves.length === 2)
  fixture.pending.shift()()
  await until(() => fixture.projects.length === 2)
  assert.deepEqual(fixture.projects.map(project => project.name), ['First project', 'Next project'])
})
test('a refused project creation releases its pending state so a deliberate retry can succeed', async () => {
  const view = await mount()
  const input = enterProject(view, 'Retry project')
  await until(() => fixture.pending.length > 0)
  fixture.pending.shift()({ ok: false, reason: 'Synthetic refusal' })
  await until(() => !view.el.querySelector('[data-project-new-save]').disabled)
  assert.match(view.el.querySelector('[data-project-status]').textContent, /Synthetic refusal/)
  input.dispatch('keydown', { key: 'Enter' })
  await until(() => fixture.pending.length > 0)
  fixture.pending.shift()()
  await until(() => fixture.projects.length === 1)
  assert.equal(fixture.projects[0].name, 'Retry project')
})

const visibleModuleIds = view => view.el.querySelectorAll('[data-mc]').filter(node => !node.hidden && !node.closest('.m-stash')).map(node => node.dataset.mc)
const chooseArea = (view, area) => view.el.querySelector(`[data-research-area="${area}"]`).click()
function signedInFixture() {
  window.mcAccount = { getSetting: async () => ({ ok: true, accountId: 'navigation-account', value: null }), putSetting: async () => assert.fail('Navigation must not save account data') }
}

test('workflow areas retain the same typed form and project without changing saved arrangement or enabled modules', async () => {
  signedInFixture()
  const projectId = 'rp-' + 'a'.repeat(36)
  fixture.projects.push({ projectId, name: 'Retained project', enabled: true })
  fixture.values.set('mc.research.project', projectId)
  const arrangement = JSON.stringify({ v: 1, rows: [['methods'], ['designer'], ['runboard'], ['results'], ['library']] })
  fixture.values.set('mc.research.layout', arrangement)
  const view = await mount()
  await until(() => view.el.querySelector('[data-exp-form]'))
  const form = view.el.querySelector('[data-exp-form]')
  form.querySelector('[name="name"]').value = 'Unfinished design'
  assert.deepEqual(visibleModuleIds(view), [])
  chooseArea(view, 'experiments')
  assert.deepEqual(visibleModuleIds(view), ['designer'])
  for (const area of ['protocol', 'run', 'library', 'design']) {
    chooseArea(view, area)
    assert.equal(view.el.querySelector('[data-exp-form]'), form)
    assert.equal(form.querySelector('[name="name"]').value, 'Unfinished design')
    assert.equal(fixture.values.get('mc.research.project'), projectId)
    assert.equal(fixture.values.get('mc.research.layout'), arrangement)
    assert.equal(fixture.values.has('mc.research.modules'), false)
    assert.equal(view.el.querySelector(`[data-research-area="${area}"]`).getAttribute('aria-pressed'), 'true')
  }
  assert.equal(view.el.querySelector('button[data-research-area="all"]'), null)
  view.el.querySelector('[data-research-edit]').click()
  assert.deepEqual(visibleModuleIds(view), ['methods', 'designer', 'runboard', 'results', 'library'])
  view.el.querySelector('[data-research-edit]').click()
  assert.equal(view.el.dataset.researchArea, 'design')
})

test('workflow remembers the area on returning, keeps disabled modules off and explains an empty area', async () => {
  fixture.values.set('mc.research.modules', JSON.stringify({ v: 1, disabled: ['queue', 'methods', 'worklists'] }))
  const first = await mount()
  chooseArea(first, 'library')
  assert.deepEqual(visibleModuleIds(first), [])
  assert.equal(first.el.querySelector('[data-workflow-empty]').hidden, false)
  first.destroy(); first.el.remove()
  const returned = await mount()
  assert.equal(returned.el.dataset.researchArea, 'library')
  assert.deepEqual(visibleModuleIds(returned), [])
  assert.ok(!moduleIds(returned).includes('queue'))
  returned.el.querySelector('[data-research-edit]').click()
  assert.ok(!moduleIds(returned).includes('queue'))
})

test('workflow keyboard navigation moves focus between the areas', async () => {
  const view = await mount()
  const design = view.el.querySelector('[data-research-area="design"]')
  view.el.querySelector('[data-workflow-nav]').dispatch('keydown', { target: design, key: 'ArrowRight' })
  assert.equal(view.el.dataset.researchArea, 'protocol')
  assert.equal(document.activeElement, view.el.querySelector('[data-research-area="protocol"]'))
  // Owner, 2026-09-21: the "next step" strip (Open designer / Inspect runs /
  // Read evidence) described the older page and is gone; the areas are the
  // navigation.
  assert.equal(view.el.querySelector('[data-workflow-evidence]'), null)
})

test('Edit layout reveals the complete arrangement and selecting an area exits editing', async () => {
  const view = await mount()
  chooseArea(view, 'run')
  view.el.querySelector('[data-research-edit]').click()
  assert.equal(view.el.dataset.researchArea, 'all')
  assert.equal(visibleModuleIds(view).length, 11)
  assert.ok(visibleModuleIds(view).includes('data'))
  assert.equal(view.el.querySelector('[data-research-modules]').classList.contains('m-editing'), true)
  chooseArea(view, 'experiments')
  assert.equal(view.el.querySelector('[data-research-modules]').classList.contains('m-editing'), false)
  assert.deepEqual(visibleModuleIds(view), ['designer', 'tiers'])
})

function assignedSession() {
  const projectId = 'rp-' + 'a'.repeat(36)
  fixture.projects.push({ projectId, name: 'Removal fixture', enabled: true })
  fixture.assignments.push({ projectId, assignmentId: 'ra-original', kind: 'observed', ref: 'session-fixture', active: true })
  return fixture.assignments[0]
}
const sessionsText = view => view.el.querySelector('[data-research-sessions]').textContent
const removalPending = view => view.el.querySelector('[data-session-removals-pending]')

test('a pending session removal stays visible across a new view and clears only after the retry confirms', async () => {
  const original = assignedSession()
  fixture.assignmentsOnline = false
  const first = await mount()
  first.el.querySelector('[data-session-unassign]').click()
  await until(() => fixture.assignmentCalls.length === 1 && removalPending(first))
  assert.match(sessionsText(first), /1 removal is saved in this browser.*not confirmed/)
  assert.doesNotMatch(sessionsText(first), /No sessions are filed/)
  assert.equal(fixture.assignments.length, 1)
  first.destroy(); first.el.remove()
  const next = await mount()
  await until(() => fixture.assignmentCalls.length === 2)
  assert.ok(removalPending(next))
  fixture.assignmentsOnline = true
  window.dispatch('mc:data-source-changed')
  await until(() => fixture.assignments.length === 0 && !removalPending(next))
  assert.match(sessionsText(next), /No sessions are filed/)
  assert.ok(fixture.assignmentCalls.every(body => body.projectId === original.projectId
    && body.unassign[0].assignmentId === original.assignmentId))
})

test('a complete service outage still displays the browser-kept removal instead of a confirmed empty state', async () => {
  assignedSession(); fixture.assignmentsOnline = false
  const first = await mount()
  first.el.querySelector('[data-session-unassign]').click()
  await until(() => removalPending(first))
  fixture.snapshotUnavailable = true
  window.dispatch('mc:data-source-changed')
  await until(() => /Synthetic snapshot unavailable/.test(sessionsText(first)))
  assert.match(sessionsText(first), /removal.*saved in this browser.*not confirmed/)
  assert.doesNotMatch(sessionsText(first), /No sessions are filed/)
})

test('the actual view refuses a late pre-removal snapshot after the service confirmed removal', async () => {
  assignedSession()
  const view = await mount()
  fixture.holdSnapshot = true
  window.dispatch('mc:data-source-changed')
  await until(() => fixture.pendingSnapshots.length === 1)
  view.el.querySelector('[data-session-unassign]').click()
  await until(() => fixture.assignments.length === 0 && /No sessions are filed/.test(sessionsText(view)))
  fixture.holdSnapshot = false; fixture.pendingSnapshots.shift()()
  await pause(); await pause()
  assert.equal(Boolean(view.el.querySelector('[data-session-unassign]')), false, 'a stale snapshot must not restore the unassignable row')
  assert.match(sessionsText(view), /No sessions are filed/)
})

test('a removal confirmation after unmount cannot repaint its retired view or clear a successor assignment', async () => {
  const original = assignedSession()
  fixture.holdAssignments = true
  const first = await mount()
  first.el.querySelector('[data-session-unassign]').click()
  await until(() => fixture.pendingAssignments.length === 1)
  first.destroy(); first.el.remove()
  const retired = sessionsText(first)
  fixture.assignments = [{ ...original, assignmentId: 'ra-successor' }]
  const next = await mount()
  await until(() => fixture.pendingAssignments.length === 2)
  fixture.holdAssignments = false
  fixture.pendingAssignments.splice(0).forEach(resolve => resolve())
  await until(() => !removalPending(next))
  assert.equal(sessionsText(first), retired)
  assert.equal(fixture.assignments[0].assignmentId, 'ra-successor')
  assert.ok(next.el.querySelector('[data-session-unassign]'))
})

test('an initially unreadable assignment version stays unavailable until a new current read succeeds', async () => {
  assignedSession()
  fixture.failAssignmentReadAt = 2
  const view = await mount()
  assert.match(sessionsText(view), /session assignments could not be read/)
  assert.doesNotMatch(sessionsText(view), /No sessions are filed/)
  assert.equal(Boolean(view.el.querySelector('[data-session-unassign]')), false)
  window.dispatch('mc:data-source-changed')
  await until(() => view.el.querySelector('[data-session-unassign]'))
  assert.doesNotMatch(sessionsText(view), /could not be read/)
})

test('a stale Unassign button cannot select a newer service assignment with the same session reference', async () => {
  const original = assignedSession()
  const view = await mount()
  const button = view.el.querySelector('[data-session-unassign]')
  fixture.assignments = [{ ...original, assignmentId: 'ra-successor' }]
  const other = createAssignmentStore({ storage: window.localStorage,
    postAction: async () => assert.fail('the second fixture store only adopts') })
  const read = await other.readServiceSnapshot(async () => ({ ok: true, assignments: fixture.assignments }))
  other.adoptServiceRows(fixture.assignments, { readVersion: read.assignmentReadVersion, assignmentDestination: read.assignmentDestination })
  button.click()
  await until(() => !button.disabled)
  assert.equal(fixture.assignmentCalls.length, 0, 'the stale button must not remove the successor generation')
  assert.equal(fixture.assignments[0].assignmentId, 'ra-successor')
  assert.match(button.textContent, /assignment changed.*Read the service/i)
})

test('an Unassign button rendered without a known assignment ID cannot adopt a later generation on click', async () => {
  const original = assignedSession()
  fixture.assignments = []
  fixture.assignmentsOnline = false
  fixture.values.set(ASSIGNMENT_FIXTURE_KEY, JSON.stringify({ v: 1, rows: [{
    projectId: original.projectId, kind: original.kind, ref: original.ref, pending: true,
  }] }))
  const view = await mount()
  const button = view.el.querySelector('[data-session-unassign]')
  assert.equal(button.dataset.assignmentId, '')
  fixture.assignments = [{ ...original, assignmentId: 'ra-successor' }]
  const other = createAssignmentStore({ storage: window.localStorage,
    postAction: async () => assert.fail('the second fixture store only adopts') })
  const read = await other.readServiceSnapshot(async () => ({ ok: true, assignments: fixture.assignments }))
  other.adoptServiceRows(fixture.assignments, { readVersion: read.assignmentReadVersion, assignmentDestination: read.assignmentDestination })
  fixture.assignmentsOnline = true
  const before = fixture.assignmentCalls.length
  button.click(); await until(() => !button.disabled)
  assert.equal(fixture.assignmentCalls.length, before, 'an explicit unknown displayed ID must not broaden into the current membership')
  assert.equal(fixture.assignments[0].assignmentId, 'ra-successor')
  assert.match(button.textContent, /Read the service.*current assignments/)
})

test('removing a design while another worker finishes preserves both the deletion and result', async t => {
  experiments.resetExperimentTracking()
  t.after(() => experiments.resetExperimentTracking())
  signedInFixture()
  const projectId = 'rp-' + 'd'.repeat(36)
  fixture.projects.push({ projectId, name: 'Concurrency fixture', enabled: true })
  fixture.values.set('mc.research.project', projectId)
  const spec = { name: 'Running experiment', projectId, axes: [{ id: 'tier', values: ['luna'] }],
    runner: { kind: 'agent', briefTemplate: 'Harmless synthetic answer' }, runsPerCell: 1 }
  const first = experiments.buildExperiment(spec, { experiments: [] })
  const second = experiments.buildExperiment({ ...spec, name: 'Remove this design' }, first.next)
  Object.assign(first.experiment.cells[0], { status: 'running', sessionId: 'concurrent-result', nodeId: 'synthetic-worker-node' })
  let row = experiments.serializeExperimentsRow(second.next), releaseRemoval
  const writes = [], listeners = new Set()
  const receive = event => { for (const listener of listeners) listener(event) }
  window.mcAgent = {
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    async sessionActivity() { return { ok: true, busy: true } },
  }
  window.mcAccount = {
    getSetting: async key => ({ ok: true, accountId: 'same-account', value: key === experiments.RESEARCH_EXPERIMENTS_ROW_KEY ? row : null }),
    putSetting: async (key, value) => {
      assert.equal(key, experiments.RESEARCH_EXPERIMENTS_ROW_KEY)
      row = value; writes.push(value)
      if (writes.length === 1) await new Promise(resolve => { releaseRemoval = resolve })
      return { ok: true }
    },
  }
  const view = await mount()
  const remove = () => view.el.querySelector(`[data-exp-remove="${second.experiment.id}"]`)
  const removeButton = remove()
  removeButton.click()
  removeButton.click()
  await until(() => typeof releaseRemoval === 'function')
  receive({ sessionId: 'concurrent-result', event: { type: 'assistant_text_delta', text: 'Preserve this result.' } })
  receive({ sessionId: 'concurrent-result', event: { type: 'turn_completed', status: 'completed' } })
  await pause()
  releaseRemoval()
  await until(() => experiments.parseExperimentsRow(row).experiments[0].cells[0].status === 'finished')
  await pause()
  const durable = experiments.parseExperimentsRow(row).experiments
  assert.deepEqual(durable.map(experiment => experiment.id), [first.experiment.id], 'a result write must not resurrect the removed design')
  assert.equal(durable[0].cells[0].replyExcerpt, 'Preserve this result.')
})


test('mounted clean-room designer imports into the form without saving or starting, and preserves invalid/cancelled input', async () => {
  signedInFixture()
  const projectId = 'rp-' + 'c'.repeat(36)
  fixture.projects.push({ projectId, name: 'Clean-room fixture', enabled: true })
  fixture.values.set('mc.research.project', projectId)
  const view = await mount()
  chooseArea(view, 'experiments')
  await until(() => view.el.querySelector('[data-exp-form]'))
  const form = view.el.querySelector('[data-exp-form]')
  assert.ok(form)
  form.elements.name.value = 'Prior draft'
  const input = view.el.querySelector('[data-exp-import-file]')
  assert.ok(input)
  const escaped = 'quote " slash \\ newline\n'
  const spec = {
    name: 'Imported clean room',
    axes: [{ id: 'tier', values: ['astra'] }, { id: 'prompt_style', values: ['quoted, value', 'plain'] }],
    runner: { kind: 'agent', briefTemplate: 'Run the cell.' },
    resultSchema: { fields: { answer: 'string' }, required: [] },
    runsPerCell: 1,
    datasetPath: 'inputs/data.json',
    agentSetup: { mode: 'clean-room', access: 'read-write', files: [{ path: 'input.txt', content: escaped }] },
  }
  input.files = [{ name: 'clean-room.json', size: 512, async text() { return JSON.stringify({ format: 'toolsenabled-research-experiment', version: 1, spec }) } }]
  input.dispatch('change')
  await pause()
  assert.equal(form.elements.name.value, 'Imported clean room')
  assert.equal(form.elements.agentSetupEnabled.checked, true)
  assert.equal(form.elements.agentSetupAccess.value, 'read-write')
  assert.deepEqual([...form.querySelectorAll('input[name="tier"]')].filter(input => input.checked).map(input => input.value), ['astra'])
  assert.match(form.elements.moreAxes.value, /quoted, value/)
  assert.equal(form.elements.runnerKind.value, 'agent')
  assert.match(form.elements.runnerDetail.value, /Run the cell/)
  assert.match(form.elements.agentSetupFiles.value, /quote/)
  assert.equal(fixture.saves.length, 0)
  assert.equal(fixture.submissions.length, 0)

  const importedName = form.elements.name.value
  input.files = [{ async text() { return '{invalid' } }]
  input.dispatch('change')
  await pause()
  assert.equal(form.elements.name.value, importedName)
  input.files = []
  input.dispatch('change')
  await pause()
  assert.equal(form.elements.name.value, importedName)
})


async function mountEditableExperiment() {
  signedInFixture()
  const projectId = 'rp-' + 'd'.repeat(36)
  fixture.projects.push({ projectId, name: 'Editable experiment', enabled: true })
  fixture.values.set('mc.research.project', projectId)
  const view = await mount()
  chooseArea(view, 'experiments')
  await until(() => view.el.querySelector('[data-exp-form]'))
  return { view, form: view.el.querySelector('[data-exp-form]'), input: view.el.querySelector('[data-exp-import-file]') }
}

function editableImport(name) {
  return JSON.stringify({ format: 'toolsenabled-research-experiment', version: 1, spec: {
    name, axes: [{ id: 'tier', values: ['astra'] }],
    runner: { kind: 'agent', briefTemplate: 'Return one answer.' },
    resultSchema: { fields: { answer: 'string' }, required: [] },
    runsPerCell: 1, datasetPath: null,
  } })
}

for (const cleanRoom of [false, true]) test('mounted designer downloads the current manual draft without saving (clean room: ' + cleanRoom + ')', async t => {
  const { view, form } = await mountEditableExperiment()
  assert.equal(form.elements.agentSetupEnabled.checked, false, 'clean rooms are optional and initially off')
  const files = [{ path: 'input.txt', content: 'quote " slash \\ newline\n' }]
  form.elements.name.value = 'Manual draft'
  form.elements.runnerKind.value = 'agent'
  form.elements.runnerDetail.value = 'Read the explicit input and return one answer.'
  form.elements.datasetPath.value = ''
  form.elements.runsPerCell.value = '1'
  form.elements.moreAxes.value = JSON.stringify({ style: ['quoted, value', 'plain'] })
  for (const tier of form.querySelectorAll('[name="tier"]')) tier.checked = tier.value === 'astra'
  form.elements.agentSetupEnabled.checked = cleanRoom
  form.elements.agentSetupAccess.value = 'read-write'
  form.elements.agentSetupFiles.value = JSON.stringify(files)
  const blobs = [], downloads = [], revoked = []
  t.mock.method(URL, 'createObjectURL', blob => { blobs.push(blob); return 'blob:experiment-' + blobs.length })
  t.mock.method(URL, 'revokeObjectURL', url => revoked.push(url))
  const click = Element.prototype.click
  t.mock.method(Element.prototype, 'click', function () {
    if (this.tagName === 'A') { downloads.push({ href: this.href, download: this.download }); return }
    return click.call(this)
  })
  view.el.querySelector('[data-exp-export]').click()
  assert.equal(blobs.length, 1, form.querySelector('[data-exp-form-status]').textContent)
  const parsed = experiments.parseExperimentImport(await blobs[0].text())
  assert.equal(parsed.ok, true, parsed.sentence)
  assert.equal(parsed.spec.name, 'Manual draft')
  assert.deepEqual(parsed.spec.axes, [{ id: 'tier', values: ['astra'] }, { id: 'style', values: ['quoted, value', 'plain'] }])
  if (cleanRoom) assert.deepEqual(parsed.spec.agentSetup, { mode: 'clean-room', access: 'read-write', files })
  else assert.equal(Object.hasOwn(parsed.spec, 'agentSetup'), false)
  assert.deepEqual(downloads, [{ href: 'blob:experiment-1', download: 'toolsenabled-research-experiment.json' }])
  assert.deepEqual(revoked, ['blob:experiment-1'])
  assert.equal(form.querySelector('[data-exp-form-status]').textContent, 'Editable experiment downloaded. Nothing was saved or started.')
  assert.equal(fixture.saves.length, 0)
  assert.equal(fixture.submissions.length, 0)

  form.elements.name.value = ''
  view.el.querySelector('[data-exp-export]').click()
  assert.equal(blobs.length, 1, 'an invalid draft must not download a different saved experiment')
})

test('mounted experiment imports keep the newest selection and ignore cancelled or edited pending reads', async () => {
  const { form, input } = await mountEditableExperiment()
  let release
  input.files = [{ size: 512, text: () => new Promise(resolve => { release = resolve }) }]
  input.dispatch('change')
  input.files = [{ size: 512, text: async () => editableImport('Newer selection') }]
  input.dispatch('change')
  await until(() => form.elements.name.value === 'Newer selection')
  release(editableImport('Stale selection'))
  await pause()
  assert.equal(form.elements.name.value, 'Newer selection')

  input.files = [{ size: 512, text: () => new Promise(resolve => { release = resolve }) }]
  input.dispatch('change')
  input.files = []
  input.dispatch('change')
  release(editableImport('Cancelled selection'))
  await pause()
  assert.equal(form.elements.name.value, 'Newer selection')

  input.files = [{ size: 512, text: () => new Promise(resolve => { release = resolve }) }]
  input.dispatch('change')
  form.elements.name.value = 'Newer hand edit'
  form.elements.name.dispatch('input')
  release(editableImport('Before hand edit'))
  await pause()
  assert.equal(form.elements.name.value, 'Newer hand edit')

  input.files = [{ size: 60001, text: () => assert.fail('oversized files must refuse before reading') }]
  input.dispatch('change')
  await pause()
  assert.equal(form.elements.name.value, 'Newer hand edit')
  assert.match(form.querySelector('[data-exp-form-status]').textContent, /60000 bytes/)
  assert.equal(fixture.saves.length, 0)
  assert.equal(fixture.submissions.length, 0)
})

test('mounted experiment import cannot change a replacement project form', async () => {
  const { view, form, input } = await mountEditableExperiment()
  const nextProjectId = 'rp-' + 'e'.repeat(36)
  fixture.projects.push({ projectId: nextProjectId, name: 'Next project', enabled: true })
  let release
  input.files = [{ size: 512, text: () => new Promise(resolve => { release = resolve }) }]
  input.dispatch('change')
  const select = view.el.querySelector('[data-project-select]')
  select.value = nextProjectId
  select.dispatch('change')
  await until(() => view.el.querySelector('[data-exp-form]') !== form)
  const next = view.el.querySelector('[data-exp-form]')
  next.elements.name.value = 'Next project draft'
  release(editableImport('Previous project import'))
  await pause()
  assert.equal(next.elements.name.value, 'Next project draft')
  assert.equal(fixture.saves.length, 0)
  assert.equal(fixture.submissions.length, 0)
})
