import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { mountLedgerCustodyControls } from '../../src/ledger-custody-controls.js'
const { createLedgerCustody } = createRequire(import.meta.url)('../../shell/ledger-custody.cjs')
const token = 'a'.repeat(64)
const preview = { ok: true, count: 4, revision: 12, token }
const person = { kind: 'window', owner: {}, mayWrite: true, label: 'Ledger fixture window' }
const settle = () => new Promise(resolve => setImmediate(resolve))

function service(overrides = {}) {
  const calls = []
  const store = {
    previewUnconfirmedHistory(value) { calls.push(['preview', value]); return { ...preview, path: 'internal-only', records: ['internal-only'] } },
    adoptUnconfirmedHistory(value) { calls.push(['confirm', value]); return { revision: 13, adopted: [{ id: 'T1' }], path: 'internal-only' } },
    ...overrides,
  }
  const api = createLedgerCustody({ resolveCapabilityRoot: () => 'payload', requireModule: () => store })
  return { api, calls }
}

test('native person preview is read-only and confirmation preserves the exact snapshot without leaking records or paths', async () => {
  const f = service()
  /* The preview names its records now (T1548), but only as checked
     id/kind/words/time rows: a malformed entry and the store's path stay
     behind, as they always did. */
  assert.deepEqual(await f.api.run('preview', {}, person), { ...preview, records: [] })
  assert.deepEqual(f.calls, [['preview', { actor: 'owner' }]])
  assert.deepEqual(await f.api.run('confirm', { revision: 12, token }, person), { ok: true, count: 1, revision: 13 })
  assert.deepEqual(f.calls[1], ['confirm', { actor: 'owner', revision: 12, token }])
})

for (const [name, principal] of Object.entries({ absent: null, agent: { ...person, kind: 'agent' }, relay: { ...person, kind: 'relay' }, readonly: { ...person, mayWrite: false }, unowned: { ...person, owner: null } })) {
  test('adoption refuses unauthorized principal ' + name, async () => {
    const f = service()
    for (const operation of ['preview', 'confirm']) {
      assert.equal((await f.api.run(operation, operation === 'preview' ? {} : { revision: 12, token }, principal)).code, 'AGENT_LEDGER_CUSTODY_PERSON_REQUIRED')
    }
    assert.deepEqual(f.calls, [])
  })
}

test('adoption rejects actor/path injection and malformed confirmations before loading any store', async () => {
  const f = service()
  for (const value of [null, [], { actor: 'owner' }, { root: 'elsewhere' }]) assert.equal((await f.api.run('preview', value, person)).ok, false)
  for (const value of [{}, { revision: -1, token }, { revision: 12, token: 'short' }, { revision: 12, token, actor: 'owner' }]) {
    assert.equal((await f.api.run('confirm', value, person)).ok, false)
  }
  assert.deepEqual(f.calls, [])
})

test('broken history, stale confirmation, missing payload and unexpected failure remain explicit safe refusals', async () => {
  for (const code of ['R_LEDGER_CHAIN_BROKEN', 'R_LEDGER_ADOPTION_STALE', 'UNEXPECTED_INTERNAL']) {
    const f = service({ adoptUnconfirmedHistory() { throw Object.assign(new Error('internal-only'), { code }) } })
    const result = await f.api.run('confirm', { revision: 12, token }, person)
    assert.equal(result.ok, false)
    assert.equal(result.code, code === 'UNEXPECTED_INTERNAL' ? 'AGENT_LEDGER_CUSTODY_UNAVAILABLE' : code)
    assert.doesNotMatch(result.reason, /internal-only/)
    assert.ok(result.reason.endsWith('.'))
  }
  const api = createLedgerCustody({ resolveCapabilityRoot: () => null })
  assert.equal((await api.run('preview', {}, person)).code, 'AGENT_LEDGER_CUSTODY_UNAVAILABLE')
})

function fixture(t, overrides = {}) {
  const dom = installDomStandIn()
  const doc = dom.document, create = doc.createElement.bind(doc)
  doc.createElement = tag => {
    const node = create(tag)
    if (tag === 'dialog') { node.showModal = () => { node.open = true }; node.close = () => { node.open = false } }
    return node
  }
  const root = doc.createElement('main')
  root.innerHTML = '<div data-ledger-custody><button data-ledger-custody-review>Review history</button><p data-ledger-custody-status></p></div>'
  doc.body.append(root)
  const calls = [], adopted = []
  const bridge = {
    ledgerCustodyPreview: async value => { calls.push(['preview', value]); return preview },
    ledgerCustodyConfirm: async value => { calls.push(['confirm', value]); return { ok: true, count: 4, revision: 13 } },
    ...overrides,
  }
  const controls = mountLedgerCustodyControls(root, { bridge, onAdopt: value => adopted.push(value) })
  controls.update({ enabled: true })
  t.after(() => { controls.destroy(); dom.restore() })
  return { controls, calls, adopted, root, doc, review: () => root.querySelector('[data-ledger-custody-review]').click(),
    dialog: () => doc.body.querySelector('dialog'), status: () => root.querySelector('[data-ledger-custody-status]').textContent }
}

test('opening the page never adopts; Review shows counted consequences and Cancel performs no write', async t => {
  const f = fixture(t)
  await settle(); assert.deepEqual(f.calls, [])
  f.review(); await settle()
  assert.deepEqual(f.calls, [['preview', {}]])
  assert.match(f.dialog().textContent, /4 Ledger records/)
  assert.match(f.dialog().textContent, /does not reconstruct or verify the missing history/)
  assert.equal(f.doc.activeElement, f.dialog().querySelector('[data-custody-cancel]'))
  f.dialog().querySelector('[data-custody-cancel]').click(); await settle()
  assert.equal(f.dialog(), null)
  assert.deepEqual(f.calls, [['preview', {}]])
})

test('only explicit confirmation adopts once using the preview and refreshes the Ledger', async t => {
  const f = fixture(t)
  f.review(); await settle()
  const confirm = f.dialog().querySelector('[data-custody-confirm]')
  confirm.click(); confirm.click(); await settle()
  assert.deepEqual(f.calls, [['preview', {}], ['confirm', { revision: 12, token }]])
  assert.equal(f.adopted.length, 1)
  assert.equal(f.dialog(), null)
  assert.match(f.status(), /Earlier unconfirmed history remains marked as unverified/)
})

test('healthy history offers no adoption', async t => {
  const f = fixture(t, { ledgerCustodyPreview: async () => ({ ...preview, count: 0 }) })
  f.review(); await settle()
  assert.equal(f.dialog(), null)
  assert.match(f.status(), /No Ledger records need history adoption/)
  assert.equal(f.adopted.length, 0)
})

test('a rejected history preview stays visible and never opens confirmation', async t => {
  const f = fixture(t, { ledgerCustodyPreview: async () => { throw new Error('Saved history could not be read.') } })
  f.review(); await settle()
  assert.equal(f.dialog(), null)
  assert.equal(f.status(), 'Saved history could not be read.')
  assert.equal(f.adopted.length, 0)
})

for (const action of ['disable', 'destroy']) {
  test('late preview after ' + action + ' never opens or adopts', async t => {
    let resolve
    const f = fixture(t, { ledgerCustodyPreview: () => new Promise(done => { resolve = done }) })
    f.review()
    if (action === 'disable') f.controls.update({ enabled: false }); else f.controls.destroy()
    resolve(preview); await settle()
    assert.equal(f.dialog(), null)
    assert.equal(f.adopted.length, 0)
  })
}

test('leaving live data invalidates an open confirmation without writing', async t => {
  const f = fixture(t)
  f.review(); await settle()
  const confirm = f.dialog().querySelector('[data-custody-confirm]')
  f.controls.update({ enabled: false }); confirm.click(); await settle()
  assert.equal(f.dialog(), null)
  assert.deepEqual(f.calls, [['preview', {}]])
})

test('a refused or uncertain adoption requires a fresh review and never reports success', async t => {
  const f = fixture(t, { ledgerCustodyConfirm: async () => ({ ok: false, reason: 'The Ledger changed. Review it again.' }) })
  f.review(); await settle()
  const confirm = f.dialog().querySelector('[data-custody-confirm]')
  confirm.click(); await settle()
  assert.equal(confirm.disabled, true)
  assert.match(f.dialog().querySelector('[role="status"]').textContent, /The Ledger changed/)
  assert.equal(f.adopted.length, 0)
})

for (const invalidation of ['disable-and-enable', 'destroy']) for (const outcome of ['success', 'refusal']) {
  test(`in-flight adoption ${outcome} after ${invalidation} cannot repaint or refresh the stale view`, async t => {
    let resolve, reject, submissions = 0
    const f = fixture(t, { ledgerCustodyConfirm: () => {
      submissions += 1
      return new Promise((done, fail) => { resolve = done; reject = fail })
    } })
    f.review(); await settle()
    f.dialog().querySelector('[data-custody-confirm]').click(); await settle()
    assert.equal(submissions, 1)
    const before = f.status()
    if (invalidation === 'destroy') f.controls.destroy()
    else { f.controls.update({ enabled: false }); f.controls.update({ enabled: true }) }
    if (outcome === 'success') resolve({ ok: true, count: 4, revision: 13 })
    else reject(new Error('Synthetic stale refusal.'))
    await settle()
    assert.deepEqual(f.adopted, [], 'a stale adoption must not reload a different view')
    assert.equal(f.status(), before, 'a stale result replaced the current status')
    assert.equal(f.dialog(), null)
    assert.equal(submissions, 1)
    if (invalidation !== 'destroy') {
      f.review(); await settle()
      assert.ok(f.dialog(), 'the current view must allow a fresh review')
    }
  })
}

test('shipped preload and native handlers reach the person-only adoption service with an exact preview', async () => {
  const { readFileSync } = await import('node:fs')
  const { default: vm } = await import('node:vm')
  const { parseAst } = await import('rollup/parseAst')
  const require = createRequire(import.meta.url)
  const { createAgentCommandSurface, REQUIRED_DEPS } = require('../../shell/agent-command-surface.cjs')
  const mainSource = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
  const parserNames = ['agentIpcError', 'agentPayload', 'boundedAgentString', 'rendererSafeAgentError']
  const ast = parseAst(mainSource).body
  const parsers = ast.filter(node => node.type === 'FunctionDeclaration' && parserNames.includes(node.id.name))
  const parsed = vm.runInNewContext(parsers.map(node => mainSource.slice(node.start, node.end)).join('\n') + '\n({' + parserNames.join(',') + '})')
  const unexpected = () => assert.fail('adoption reached an unrelated agent, session or provider')
  const deps = Object.fromEntries(Object.entries(REQUIRED_DEPS).map(([name, type]) =>
    [name, type === 'function' ? unexpected : type === 'number' ? 128 : type === 'string' ? 'fixture' : {}]))
  const calls = []
  Object.assign(deps, parsed, { agentSessions: new Map(), AGENT_EFFORT_VALUES: [], dialog: { showOpenDialog: unexpected },
    resolveCapabilityRoot: () => 'installed-payload',
    requireModule: name => {
      assert.match(name.replaceAll('\\', '/'), /installed-payload\/src\/lib\/owner-request-store.js$/)
      return {
        previewUnconfirmedHistory: value => { calls.push(['preview', value]); return preview },
        adoptUnconfirmedHistory: value => { calls.push(['confirm', value]); return { revision: 13, adopted: [{ id: 'T1' }] } },
      }
    },
  })
  const surface = createAgentCommandSurface(deps)
  const handlers = new Map()
  const registration = ast.filter(node => node.type === 'ExpressionStatement'
    && node.expression?.callee?.object?.name === 'ipcMain' && node.expression.callee.property?.name === 'handle'
    && ['mc-agent:ledger-custody-preview', 'mc-agent:ledger-custody-confirm'].includes(node.expression.arguments[0]?.value))
  let trusted = 0
  vm.runInNewContext(registration.map(node => mainSource.slice(node.start, node.end)).join('\n'), {
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    assertTrustedAgentSender: event => { assert.equal(event.sender, person.owner); trusted += 1 },
    getAgentCommandSurface: () => surface,
    windowPrincipal: () => person,
  })
  const exposed = new Map()
  const electron = { contextBridge: { exposeInMainWorld: (name, value) => exposed.set(name, value) }, ipcRenderer: {
    on() {}, removeListener() {}, send() {}, sendSync: () => ({ ok: false }),
    invoke: (channel, value) => {
      const handle = handlers.get(channel)
      assert.equal(typeof handle, 'function', 'the installed main process must register the adoption route')
      return handle({ sender: person.owner }, value)
    },
  } }
  vm.runInNewContext(readFileSync(new URL('../../shell/fleet-profile-preload.cjs', import.meta.url), 'utf8'), {
    require: name => { assert.equal(name, 'electron'); return electron },
    process: { platform: process.platform }, window: { addEventListener() {} },
  })
  const bridge = exposed.get('mcAgent')
  assert.equal(typeof bridge?.ledgerCustodyPreview, 'function', 'the installed preload must expose adoption review')
  const snapshot = await bridge.ledgerCustodyPreview({})
  assert.equal(snapshot.count, 4)
  assert.deepEqual(calls, [['preview', { actor: 'owner' }]])
  const result = await bridge.ledgerCustodyConfirm({ revision: snapshot.revision, token: snapshot.token })
  assert.equal(result.count, 1)
  assert.deepEqual(calls[1], ['confirm', { actor: 'owner', revision: 12, token }])
  assert.equal(trusted, 2)
  assert.equal((await surface.run('agent:ledger-custody-confirm', { revision: 12, token }, { ...person, kind: 'relay' })).code,
    'AGENT_LEDGER_CUSTODY_PERSON_REQUIRED')
  await assert.rejects(surface.run('agent:ledger-custody-confirm', { revision: 12, token }, { ...person, mayWrite: false }),
    error => error.code === 'MC_AGENT_PRINCIPAL_READ_ONLY')
  assert.equal(calls.length, 2, 'nonlocal and read-only attempts must never reach the store')
})

test('installed engine preserves unconfirmed history until the person confirms the exact adoption preview', async t => {
  const fs = await import('node:fs')
  const path = (await import('node:path')).default
  const { Module } = await import('node:module')
  const { randomUUID } = await import('node:crypto')
  const { testScratchRoot } = await import('../lib/test-scratch-root.mjs')
  const app = path.resolve(import.meta.dirname, '..', '..')
  const engine = process.env.MC_CANONICAL_ROOT || path.join(app, 'capability')
  const storeFile = path.join(engine, 'src/lib/owner-request-store.js')
  const root = fs.mkdtempSync(testScratchRoot('ledger-custody-person-'))
  t.diagnostic('Retained synthetic adoption fixture: ' + root)
  const retained = path.join(root, 'retained-removals')
  fs.mkdirSync(retained)
  // The real store runs against owned synthetic files. Preserve removals by
  // renaming them away, retaining the product's absent-path/lock semantics.
  const fixtureFs = { ...fs, unlinkSync(target) {
    const chosen = path.resolve(target)
    assert.ok(chosen.startsWith(root + path.sep), 'store removal escaped its fixture')
    fs.renameSync(chosen, path.join(retained, randomUUID()))
  } }
  const actualRequire = createRequire(storeFile)
  const loaded = new Module(storeFile)
  loaded.filename = storeFile
  loaded.paths = Module._nodeModulePaths(path.dirname(storeFile))
  loaded.require = name => name === 'node:fs' ? fixtureFs : actualRequire(name)
  loaded._compile(fs.readFileSync(storeFile, 'utf8'), storeFile)
  const store = loaded.exports
  const options = name => ({ rootPath: (...parts) => path.join(root, name, ...parts),
    loadSettings: () => ({ values: { 'ledger.verify_history': false }, provenance: {}, rejected: [] }) })
  const origin = options('origin'), imported = options('imported')
  store.fileTask({ scope: 'global', words: 'Synthetic adoption fixture.', filedBy: 'codex' }, origin)
  const ledger = selected => selected.rootPath('reports', 'OWNER-REQUEST-LEDGER.json')
  const history = selected => selected.rootPath('state', 'owner-request-record-events.jsonl')
  fs.mkdirSync(path.dirname(ledger(imported)), { recursive: true })
  fs.copyFileSync(ledger(origin), ledger(imported))
  const before = fs.readFileSync(ledger(imported), 'utf8')
  const ordinary = () => store.fileTask({ scope: 'global', words: 'Synthetic next task.', filedBy: 'codex' }, imported)
  assert.throws(ordinary, { code: 'R_LEDGER_CHAIN_APPEND_UNCONFIRMED' })
  const api = createLedgerCustody({ resolveCapabilityRoot: () => engine, requireModule: selected => {
    assert.equal(selected, storeFile)
    return {
      previewUnconfirmedHistory: input => store.previewUnconfirmedHistory(input, imported),
      adoptUnconfirmedHistory: input => store.adoptUnconfirmedHistory(input, imported),
    }
  } })
  const snapshot = await api.run('preview', {}, person)
  assert.equal(snapshot.ok, true, snapshot.reason)
  assert.equal(snapshot.count, 1)
  assert.equal(fs.readFileSync(ledger(imported), 'utf8'), before, 'review changed the current records')
  assert.equal(fs.existsSync(history(imported)), false, 'review invented a journal')
  assert.throws(ordinary, { code: 'R_LEDGER_CHAIN_APPEND_UNCONFIRMED' }, 'ordinary work must never adopt implicitly')
  const stale = await api.run('confirm', { revision: snapshot.revision, token: 'b'.repeat(64) }, person)
  assert.equal(stale.ok, false)
  assert.equal(fs.readFileSync(ledger(imported), 'utf8'), before, 'a stale decision changed records')
  const confirmed = await api.run('confirm', { revision: snapshot.revision, token: snapshot.token }, person)
  assert.equal(confirmed.ok, true, confirmed.reason)
  assert.equal(confirmed.count, 1)
  assert.equal(ordinary().id, 'T2', 'writing did not resume after explicit adoption')
  assert.equal(store.verifyHistory(imported).ok, true)
  assert.equal(fs.readFileSync(ledger(origin), 'utf8'), before, 'adopting a copy rewrote its source')
})

/* THE WARNING SENDS NOBODY LOOKING FOR A RESTORE THE APP DOES NOT OFFER
   (T1299): nothing on the Ledger or in Settings restores a history copy. */
test('the adoption warning does not tell the person to restore a copy the app cannot restore', async t => {
  const f = fixture(t)
  f.review(); await settle()
  assert.doesNotMatch(f.dialog().textContent, /restore it first|preserved history copy/i)
  assert.match(f.dialog().textContent, /Adopting keeps the current records/)
})

/* WHICH RECORDS BEFORE ADOPTING (T1548): the preview's rows reach the dialog,
   checked and bounded, and the dialog lists them, folded away when many. */
test('the adoption review lists the records it covers, checked and bounded, and folds a long list', async t => {
  const rows = [
    { id: 'R3', kind: 'R', words: 'Keep the release notes short.', changedAt: '2026-09-22T11:10:00.000Z', path: '/secret' },
    { id: 'T7', kind: 'T', words: 'x'.repeat(400), changedAt: 'not a time at all, and far too long to be one: 2026' },
    { id: '../../etc', kind: 'R', words: 'not an id' },
  ]
  const f = service({ previewUnconfirmedHistory() { return { ...preview, records: rows } } })
  const answer = await f.api.run('preview', {}, person)
  assert.deepEqual(answer.records.map(row => row.id), ['R3', 'T7'], 'a record that is not a Ledger id crossed')
  assert.equal(answer.records[1].words.length, 160)
  assert.equal(answer.records[1].changedAt, null)
  assert.doesNotMatch(JSON.stringify(answer), /secret/)

  const g = fixture(t, { ledgerCustodyPreview: async () => ({ ...preview, records: answer.records }) })
  g.review(); await settle()
  const items = g.dialog().querySelectorAll('[data-custody-record]').map(item => item.textContent)
  assert.equal(items.length, 2)
  assert.match(items[0], /^R3 \(rule\): Keep the release notes short\., last changed /)
  assert.match(g.dialog().textContent, /And 2 more not listed here\./, 'the count beyond the listed records is not said')

  const many = Array.from({ length: 12 }, (_, index) => ({ id: `R${index + 1}`, kind: 'R', words: `Rule ${index + 1}`, changedAt: null }))
  const h = fixture(t, { ledgerCustodyPreview: async () => ({ ...preview, count: 12, records: many }) })
  h.review(); await settle()
  assert.equal(h.dialog().querySelector('details')?.querySelector('summary')?.textContent, 'Show the 12 records this covers')
  assert.equal(h.dialog().querySelectorAll('[data-custody-record]').length, 12)
})
