/* One causal path for T1281: the engine writes a task checkpoint and a later
 * review, the shell projects both decisions, the live row adapter preserves
 * the task's latest progress, and the mounted Ledger refreshes it.  This file
 * is intentionally separate from the canonical shape suite so a baseline run
 * can name the missing task projection rather than failing on unrelated keys.
 *
 * IMAGE_ENGINE_ROOT is the parent runner's composed real engine.  The ledger
 * root and settings reader below are private scratch seams, created before
 * the engine module is loaded; no ambient profile or customer settings enter
 * this fixture. */

import assert from 'node:assert/strict'
import { createRequire, register } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { installDomStandIn } from './lib/dom-stand-in.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const repoRootUrl = pathToFileURL(repoRoot).href

/* Keep the view real while replacing only its browser-only feed and write
 * adapters.  The row adapter used by the retained case is imported directly
 * below, after its private state root has been established. */
register(`data:text/javascript,${encodeURIComponent(`
  const stub = source => ({ format: 'module', source, shortCircuit: true })
  export async function resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.css')) return { url: 'test:css', shortCircuit: true }
    const replacements = {
      '../components.js': 'components', '../ledger-live.js': 'ledger-live',
      '../data-source.js': 'data-source', '../refusal-copy.js': 'refusal-copy',
      '../sample-ledger.js': 'sample-ledger', '../write-surfaces.js': 'write-surfaces',
      '../first-run-needs.js': 'first-run-needs',
    }
    if (context.parentURL?.endsWith('/src/views/ledger.js') && replacements[specifier])
      return { url: 'test:' + replacements[specifier], shortCircuit: true }
    return nextResolve(specifier, context)
  }
  export async function load(url, context, nextLoad) {
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

const { ledgerView, LEDGER_REFRESH_MS } = await import('../../src/views/ledger.js')

test.after(() => { dom.restore(); delete globalThis.localStorage })

const settle = async () => { for (let index = 0; index < 12; index += 1) await Promise.resolve() }

function catchRefreshTimer() {
  const real = globalThis.setTimeout
  const fired = []
  globalThis.setTimeout = (callback, ms, ...rest) => {
    if (ms === LEDGER_REFRESH_MS) { fired.push(callback); return { unref() {} } }
    return real(callback, ms, ...rest)
  }
  return {
    fired,
    next: async () => {
      const callback = fired.shift()
      assert.ok(callback, 'the open page scheduled no quiet re-read')
      await callback()
    },
    restore() { globalThis.setTimeout = real },
  }
}

function mountView() {
  stored.clear()
  stored.set('mc.ledger.mode', 't')
  globalThis.__ledgerAsked = []
  window.mcAgent = null
  const view = ledgerView()
  document.body.appendChild(view.el)
  return {
    view,
    root: view.el,
    record: id => view.el.querySelector(`[data-row-id="${id}"]`),
    done() { view.destroy(); view.el.remove(); stored.clear() },
  }
}

const retain = process.env.TOOLSENABLED_TEST_RETAIN_FIXTURES === '1'
const scratchParent = path.join(os.tmpdir(), '.toolsenabled-ledger-task-progress-composition')
mkdirSync(scratchParent, { recursive: true })
const scratchParentReal = realpathSync.native(scratchParent)
test.after(() => { if (!retain) rmSync(scratchParent, { recursive: true, force: true }) })

test('a real task progress survives a later review through canonical read, rowOf and quiet refresh', async t => {
  const engineRoot = process.env.IMAGE_ENGINE_ROOT
  if (!engineRoot) {
    t.skip('IMAGE_ENGINE_ROOT must name the parent\'s composed engine for the retained causal fixture')
    return
  }
  const storeModule = path.join(engineRoot, 'src', 'lib', 'owner-request-store.js')
  assert.equal(existsSync(storeModule), true, `composed engine store is missing: ${storeModule}`)

  /* Establish every private state seam before loading either real CommonJS
   * payload.  The settings reader deliberately reports the default, grading
   * off configuration and never consults a user profile. */
  const root = mkdtempSync(path.join(scratchParentReal, 'ledger-'))
  const rootPath = (...parts) => path.join(root, ...parts)
  const loadSettings = () => Object.freeze({
    values: Object.freeze({ 'agent.task_difficulty_enabled': false }),
    rejected: Object.freeze([]),
    provenance: Object.freeze({}),
  })
  const storeOptions = { rootPath, loadSettings }
  const require_ = createRequire(import.meta.url)
  const { readCanonicalLedger } = require_(path.join(repoRoot, 'shell', 'canonical-ledger-read.cjs'))
  const engine = require_(storeModule)
  const { rowOf } = await import('../../src/ledger-live.js')
  const read = () => readCanonicalLedger({
    root,
    engineRoot,
    readPolicy: () => ({ verifyHistory: true, configurationAvailable: true }),
  })
  const at = value => () => new Date(value)
  let page = null
  let timer = null

  try {
    const filed = engine.fileTask({
      scope: 'global', key: null, words: 'The owner must approve the access request.', filedBy: 'codex',
      difficulty: 'easy', now: at('2026-09-23T10:00:00.000Z'),
    }, storeOptions)
    engine.progressTask({
      id: filed.id, status: 'blocked-external', reason: 'needs the owner to sign in', actor: 'codex',
      now: at('2026-09-23T10:00:01.000Z'),
    }, storeOptions)
    engine.recordTaskReview({
      id: filed.id, reviewId: 'review-1', outcome: 'failed', reason: 'The owner action is still required.', actor: 'reviewer',
      now: at('2026-09-23T10:00:02.000Z'),
    }, storeOptions)

    const project = () => {
      const answer = read()
      assert.equal(answer.ok, true, answer.reason || 'the real canonical read refused the task')
      const source = answer.records.find(record => record.id === filed.id)
      assert.ok(source, 'the real canonical read dropped the task')
      const projected = rowOf(source)
      return {
        answer,
        row: projected,
        result: { ok: true, data: {
          requests: [projected],
          questions: { ok: true, reason: null, observedAt: null, value: [] },
          revision: answer.revision,
          updatedAt: answer.updatedAt,
          exists: answer.exists,
          chain: answer.chain,
        } },
      }
    }

    const initial = project()
    assert.equal(initial.row.latestDecision?.decision, 'review', 'the real generic latest decision is not the later review')
    assert.equal(initial.row.latestProgressDecision?.decision, 'progress', 'the real task progress projection is missing')
    assert.equal(initial.row.latestProgressDecision.reason, 'needs the owner to sign in')

    globalThis.__ledgerReply = () => project().result
    timer = catchRefreshTimer()
    page = mountView()
    await settle()
    const detail = () => page.record(filed.id)?.querySelector('[data-row-detail="progress"]')?.textContent || ''
    assert.equal(detail(), 'Waiting on: needs the owner to sign in', 'the first real blocker did not reach the mounted row')

    const before = project()
    engine.progressTask({
      id: filed.id, status: 'blocked-external', reason: 'needs the owner to approve the access request', actor: 'codex',
      now: at('2026-09-23T10:00:03.000Z'),
    }, storeOptions)
    engine.recordTaskReview({
      id: filed.id, reviewId: 'review-2', outcome: 'failed', reason: 'The approval is still pending.', actor: 'reviewer',
      now: at('2026-09-23T10:00:04.000Z'),
    }, storeOptions)
    const after = project()
    assert.ok(after.answer.revision > before.answer.revision, 'the real write did not advance the ledger revision')
    assert.ok(after.row.history.length > before.row.history.length, 'the real write did not append task history')
    assert.equal(after.row.latestDecision?.decision, 'review', 'generic latest decision semantics changed')
    assert.equal(after.row.latestProgressDecision.reason, 'needs the owner to approve the access request')

    globalThis.__ledgerReply = () => project().result
    await timer.next()
    await settle()
    assert.equal(detail(), 'Waiting on: needs the owner to approve the access request', 'the real quiet refresh lost the newer blocker')
  } finally {
    timer?.restore()
    page?.done()
    if (!retain) rmSync(root, { recursive: true, force: true })
  }
})
