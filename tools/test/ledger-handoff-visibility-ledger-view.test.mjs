/* Mounted Ledger proof for T1642. The supplied rows are already the
   canonical-ledger-read projection, so this exercises the real Ledger view,
   copy and handoff classifier together without task writes. */

import assert from 'node:assert/strict'
import { register } from 'node:module'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { installDomStandIn } from './lib/dom-stand-in.mjs'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const repoRootUrl = pathToFileURL(repoRoot).href
// The RED baseline is opt-in and names a commit from the history that
// preceded this fix; a checkout without that history skips it by name.
const BASELINE_REF = process.env.T1642_HANDOFF_BASELINE_REF || '0000000'
const baselineRequested = process.env.T1642_HANDOFF_BASELINE === '1'
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
const stored = new Map([['mc.ledger.mode', 't']])
const storage = {
  get length() { return stored.size },
  key: index => [...stored.keys()][index] ?? null,
  getItem: key => stored.get(key) ?? null,
  setItem: (key, value) => stored.set(key, String(value)),
  removeItem: key => stored.delete(key),
}
globalThis.localStorage = storage
window.localStorage = storage

const { ledgerView } = useBaseline
  ? await import('test:ledger-view-baseline')
  : await import('../../src/views/ledger.js')

test.after(() => { dom.restore(); delete globalThis.localStorage })

const settle = async () => { for (let index = 0; index < 12; index += 1) await Promise.resolve() }

const committedOwnerGone = Object.freeze({
  operationId: 'op-1642-owner-gone',
  phase: 'committed',
  sourceBarrier: 'retained',
  sourceTombstone: false,
  sourcePreimageRetained: true,
  publicationState: 'uncertain',
  publicationReasonCode: 'T_LEDGER_HANDOFF_TOPOLOGY_UNCONFIRMED',
  sourceNodeId: 'node-old',
  ownerState: 'owner-gone',
  ownerNodeId: null,
  destination: { kind: 'verified-no-parent', parentNodeId: null, parentLabel: null },
  reason: 'The previous owner circle is no longer available.',
  journal: { sequence: 7, ledgerRevision: 4, eventSha256: 'e'.repeat(64), operationSha256: 'a'.repeat(64) },
})

const row = (id, handoff) => ({
  id,
  kind: 'T',
  status: 'in-progress',
  state: 'in-progress',
  scope: 'global',
  scopeKey: null,
  scopeLabel: null,
  words: `Task ${id}`,
  filedBy: 'live-owner',
  filedAt: new Date().toISOString(),
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
  handoff,
})

function mount(rows) {
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

test('mounted Tasks detail shows owner loss and unconfirmed removal together without raw machine code', async () => {
  const page = mount([row('T-owner-gone', committedOwnerGone)])
  await settle()

  const detail = page.root.querySelector('[data-row-id="T-owner-gone"]')
  assert.ok(detail, 'the mounted task row must be present before inspecting its details')
  const owner = detail.querySelector('[data-row-detail="handoff"]')
  const publication = detail.querySelector('[data-row-detail="handoff-publication"]')
  assert.ok(owner, 'owner-gone must be visible on the task row')
  assert.ok(publication, 'uncertain removal must remain visible on the task row')
  assert.ok(owner.textContent.includes('This task has no available owner.'))
  assert.ok(owner.textContent.includes('The previous owner circle is no longer available.'))
  assert.ok(publication.textContent.includes('Removal is not yet confirmed.'))
  assert.equal(detail.textContent.includes('T_LEDGER_HANDOFF_TOPOLOGY_UNCONFIRMED'), false)

  page.view.destroy()
  page.root.remove()
})

test('mounted Tasks detail makes malformed handoff evidence visibly unknown', async () => {
  const malformed = { ...committedOwnerGone, phase: 'nonsense', publicationState: 'unknown', destination: null }
  const page = mount([row('T-unknown-handoff', malformed)])
  await settle()

  const detail = page.root.querySelector('[data-row-id="T-unknown-handoff"]')
  assert.ok(detail, 'the mounted malformed task row must be present before inspection')
  const marker = detail.querySelector('[data-row-detail="handoff"]')
  assert.ok(marker, 'malformed evidence must not disappear silently')
  assert.ok(marker.textContent.includes('The handoff state could not be confirmed.'))
  assert.equal(marker.textContent.includes('This task has no available owner.'), false)
  assert.equal(detail.querySelector('[data-row-detail="handoff-publication"]'), null)

  page.view.destroy()
  page.root.remove()
})
