/* Mounted Ledger proof for T1632. The rows below are already the app's
   ledger-live projection, so this exercises the real view and helper together
   without touching the engine task writer or any task state. */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { register } from 'node:module'
import test from 'node:test'

import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { TASK_STALENESS } from '../../src/ledger-copy.js'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const repoRootUrl = pathToFileURL(repoRoot).href
// The RED baseline is opt-in and names a commit from the history that
// preceded this fix; a checkout without that history skips it by name.
const BASELINE_REF = process.env.TASK_STALENESS_BASELINE_REF || '0000000'
const baselineRequested = process.env.TASK_STALENESS_BASELINE === '1'
const baselineAvailable = baselineRequested
  && spawnSync('git', ['cat-file', '-e', `${BASELINE_REF}^{commit}`], { cwd: repoRoot }).status === 0
const useBaseline = baselineRequested && baselineAvailable
if (baselineRequested && !baselineAvailable)
  test('the RED baseline comparison', t => t.skip(`baseline ref ${BASELINE_REF} is not in this checkout`))

register(`data:text/javascript,${encodeURIComponent(`
  import { execFileSync } from 'node:child_process'
  const baselineRepoRoot = ${JSON.stringify(repoRoot)}
  const baselineLedgerUrl = new URL('src/views/ledger.js', ${JSON.stringify(repoRootUrl)})
  const stub = source => ({ format: 'module', source, shortCircuit: true })
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === 'test:ledger-view-baseline') return { url: specifier, shortCircuit: true }
    if (specifier.endsWith('.css')) return { url: 'test:css', shortCircuit: true }
    const replacements = {
      '../components.js': 'components', '../ledger-live.js': 'ledger-live',
      '../data-source.js': 'data-source', '../refusal-copy.js': 'refusal-copy',
      '../sample-ledger.js': 'sample-ledger', '../write-surfaces.js': 'write-surfaces',
      '../first-run-needs.js': 'first-run-needs',
    }
    const isLedgerView = context.parentURL?.endsWith('/src/views/ledger.js') || context.parentURL === 'test:ledger-view-baseline'
    if (isLedgerView && replacements[specifier])
      return { url: 'test:' + replacements[specifier], shortCircuit: true }
    if (context.parentURL === 'test:ledger-view-baseline' && (specifier.startsWith('../') || specifier.startsWith('./')))
      return { url: new URL(specifier, baselineLedgerUrl).href, shortCircuit: true }
    return nextResolve(specifier, context)
  }
  export async function load(url, context, nextLoad) {
    if (url === 'test:ledger-view-baseline') {
      const source = execFileSync('git', ['show', ${JSON.stringify(BASELINE_REF + ':src/views/ledger.js')}], { cwd: baselineRepoRoot, encoding: 'utf8' })
      return stub(source)
    }
    if (url === 'test:css') return stub('')
    if (url === 'test:components') return stub(\`export const el = html => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild }; export const attachSeg = () => () => {}\`)
    if (url === 'test:ledger-live') return stub(\`export const fetchLiveLedger = options => Promise.resolve(globalThis.__ledgerReply(options))\`)
    if (url === 'test:data-source') return stub(\`export const DATA_SOURCE_EVENT='source'; export const resolveDataSource=async()=> 'local'; export const sourceIsBadged=()=>false; export const currentDataSource=()=>'local'; export const exampleWasChosen=()=>false\`)
    if (url === 'test:refusal-copy') return stub(\`export const readerRemedy=s=>s\`)
    if (url === 'test:sample-ledger') return stub(\`export const sampleLedgerData=()=>({ requests: [], questions: { ok: true, reason: null, observedAt: null, value: [] }, chain: { ok: true, drift: [] } })\`)
    if (url === 'test:write-surfaces') return stub(\`export function mountLedgerWriteSurface(r,{onMount}) { const form = document.createElement('form'); form.setAttribute('data-decision-form', ''); r.appendChild(form); onMount({showRegister:()=>{}}); return ()=>{} }\`)
    if (url === 'test:first-run-needs') return stub(\`export const GUIDE_ACTION={href:'#guide',label:'Guide'}\`)
    return nextLoad(url, context)
  }
`)}`, import.meta.url)

const dom = installDomStandIn()
const stored = new Map()
let refuseStorageReads = false
let refuseStorageWrites = false
const storage = {
  get length() { return stored.size },
  key: index => [...stored.keys()][index] ?? null,
  getItem: key => {
    if (refuseStorageReads) throw new Error('storage read refused')
    return stored.has(key) ? stored.get(key) : null
  },
  setItem: (key, value) => {
    if (refuseStorageWrites) return
    stored.set(key, String(value))
  },
  removeItem: key => {
    if (refuseStorageWrites) return
    stored.delete(key)
  },
}
globalThis.localStorage = storage
window.localStorage = storage

const { ledgerView } = useBaseline
  ? await import('test:ledger-view-baseline')
  : await import('../../src/views/ledger.js')

test.after(() => { dom.restore(); delete globalThis.localStorage })

const settle = async () => { for (let index = 0; index < 12; index += 1) await Promise.resolve() }
const hoursAgo = hours => new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()

function task(id, status, ageHours, extra = {}) {
  return {
    id,
    kind: 'T',
    status,
    state: status,
    scope: 'global',
    scopeKey: null,
    scopeLabel: null,
    words: `Task ${id}`,
    filedBy: 'live-owner',
    filedAt: hoursAgo(ageHours),
    decisions: 0,
    decisionHistory: [],
    latestDecision: null,
    history: [],
    removed: false,
    removedAt: null,
    recurrence: null,
    completedAt: null,
    completedBy: null,
    answer: null,
    purchase: null,
    ...extra,
  }
}

function mount(rows, storedHours = null, { resetStorage = true } = {}) {
  refuseStorageReads = false
  refuseStorageWrites = false
  if (resetStorage) stored.clear()
  stored.set('mc.ledger.mode', 't')
  if (storedHours !== null) stored.set('mc.ledger.task-staleness-hours', String(storedHours))
  globalThis.__ledgerReply = () => ({ ok: true, data: {
    requests: rows,
    questions: { ok: true, reason: null, observedAt: null, value: [] },
    revision: 1,
    updatedAt: new Date().toISOString(),
    exists: true,
    chain: { ok: true, events: rows.length, drift: [], unchained: [], code: null },
  } })
  window.mcAgent = null
  const view = ledgerView()
  document.body.appendChild(view.el)
  return { view, root: view.el }
}

test('mounted Tasks page marks every live-owned active status, keeps terminals/recent rows clear, and retains a confirmed setting', async () => {
  const page = mount([
    task('T-open', 'open', 30),
    task('T-progress', 'in-progress', 30),
    task('T-blocked', 'blocked-external', 30),
    task('T-recurring', 'recurring', 30),
    task('T-recent', 'open', 30, { decisionHistory: [{ at: hoursAgo(1) }] }),
    task('T-done', 'done', 30),
  ])
  await settle()

  const control = page.root.querySelector('[data-task-staleness-hours]')
  assert.ok(control, 'the task inactivity control must be present before its value is read')
  assert.equal(control.value, '24')
  assert.ok(page.root.querySelector('[data-task-staleness-control]').textContent.includes('Flag tasks inactive for'))
  assert.equal(page.root.querySelectorAll('[data-task-stale="true"]').length, 4)
  assert.equal(page.root.querySelector('[data-row-id="T-recent"] [data-task-stale]'), null)
  assert.equal(page.root.querySelector('[data-row-id="T-done"] [data-task-stale]'), null)

  control.value = '48'
  control.dispatchEvent({ type: 'change', target: control })
  await settle()
  assert.equal(control.value, '48')
  assert.equal(page.root.querySelectorAll('[data-task-stale="true"]').length, 0)
  assert.equal(page.root.querySelector('[data-task-staleness-status]').hidden, true)

  control.value = '0'
  control.dispatchEvent({ type: 'change', target: control })
  assert.equal(control.value, '48', 'an invalid update must retain the confirmed value')
  assert.equal(page.root.querySelectorAll('[data-task-stale="true"]').length, 0)
  const status = page.root.querySelector('[data-task-staleness-status]')
  assert.equal(status.hidden, false)
  assert.ok(status.textContent.includes('previous setting remains in use'))
  assert.ok(status.textContent.includes(TASK_STALENESS.saveFailed('Choose a whole number from 1 to 8760 hours.').split(' The previous')[0]))

  page.view.destroy()
  page.root.remove()
  stored.clear()
})

test('mounted Tasks page refuses to mark rows when a saved threshold is invalid', async () => {
  const page = mount([task('T-invalid-setting', 'open', 72)], 'not-a-number')
  await settle()
  const control = page.root.querySelector('[data-task-staleness-hours]')
  const status = page.root.querySelector('[data-task-staleness-status]')
  assert.ok(control, 'the task inactivity control must be present before its value is read')
  assert.equal(control.value, '')
  assert.equal(control.getAttribute('aria-invalid'), 'true')
  assert.equal(status.hidden, false)
  assert.ok(status.textContent.includes('could not be confirmed'))
  assert.equal(page.root.querySelectorAll('[data-task-stale="true"]').length, 0)
  page.view.destroy()
  page.root.remove()
  stored.clear()
})

test('mounted preference refusal retains the current display and a later valid setting survives remount', async () => {
  const rows = [task('T-storage', 'open', 30)]
  const page = mount(rows, 48)
  await settle()

  const control = page.root.querySelector('[data-task-staleness-hours]')
  assert.ok(control, 'the task inactivity control must be present before its value is read')
  assert.equal(control.value, '48')
  assert.equal(page.root.querySelectorAll('[data-task-stale="true"]').length, 0)

  refuseStorageReads = true
  control.value = '72'
  control.dispatchEvent({ type: 'change', target: control })
  await settle()
  assert.equal(control.value, '48', 'a refused read retains the confirmed mounted value')
  assert.equal(page.root.querySelectorAll('[data-task-stale="true"]').length, 0)
  assert.equal(page.root.querySelector('[data-task-staleness-status]').hidden, false)

  refuseStorageReads = false
  page.view.destroy()
  page.root.remove()

  const writePage = mount(rows, 48)
  await settle()
  const writeControl = writePage.root.querySelector('[data-task-staleness-hours]')
  assert.ok(writeControl, 'the task inactivity control must be present before a write refusal')
  refuseStorageWrites = true
  writeControl.value = '72'
  writeControl.dispatchEvent({ type: 'change', target: writeControl })
  await settle()
  assert.equal(writeControl.value, '48', 'a discarded write retains the confirmed mounted value')
  assert.equal(writePage.root.querySelectorAll('[data-task-stale="true"]').length, 0)
  assert.equal(writePage.root.querySelector('[data-task-staleness-status]').hidden, false)

  refuseStorageWrites = false
  writeControl.value = '72'
  writeControl.dispatchEvent({ type: 'change', target: writeControl })
  await settle()
  assert.equal(writeControl.value, '72')
  assert.equal(writePage.root.querySelector('[data-task-staleness-status]').hidden, true)

  writePage.view.destroy()
  writePage.root.remove()
  const remounted = mount(rows, null, { resetStorage: false })
  await settle()
  const remountedControl = remounted.root.querySelector('[data-task-staleness-hours]')
  assert.ok(remountedControl, 'the task inactivity control must be present after remount')
  assert.equal(remountedControl.value, '72')
  assert.equal(remounted.root.querySelectorAll('[data-task-stale="true"]').length, 0)
  remounted.view.destroy()
  remounted.root.remove()
  stored.clear()
})
