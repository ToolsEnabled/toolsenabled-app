import assert from 'node:assert/strict'
import test from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { mountLedgerResetControls, RESET_REFUSAL } from '../../src/ledger-reset-controls.js'

const settle = () => new Promise(resolve => setImmediate(resolve))
function fixture(t, overrides = {}, { adoptAfterMount = false } = {}) {
  const dom = installDomStandIn()
  const doc = dom.document
  const create = doc.createElement.bind(doc)
  doc.createElement = tag => {
    const node = create(tag)
    if (tag === 'dialog') { node.showModal = () => { node.open = true }; node.close = () => { node.open = false } }
    return node
  }
  const root = doc.createElement('main')
  root.innerHTML = '<div data-ledger-resets>' + ['T', 'R', 'A', 'P'].map(kind => `<button data-reset-kind="${kind}">${kind}</button>`).join('') + '</div><p data-ledger-reset-status></p>'
  if (adoptAfterMount) root.ownerDocument = { body: null, createElement: doc.createElement }
  else doc.body.append(root)
  const calls = [], refreshed = []
  const bridge = {
    ledgerResetPreview: async ({ kind }) => { calls.push(['preview', kind]); return { kind, count: 14, revision: 25, token: 'a'.repeat(64), promptCount: 3 } },
    ledgerResetConfirm: async value => { calls.push(['confirm', value]); return { ok: true, kind: value.kind, count: 14 } },
    ...overrides,
  }
  const controls = mountLedgerResetControls(root, { bridge, onReset: value => refreshed.push(value) })
  if (adoptAfterMount) doc.body.append(root)
  controls.update({ enabled: true })
  t.after(() => { controls.destroy(); dom.restore() })
  return { root, doc, calls, controls, refreshed,
    button: kind => root.querySelector(`[data-reset-kind="${kind}"]`),
    dialog: () => doc.body.querySelector('dialog') }
}

test('a view adopted from a template uses its current page document for the warning', async t => {
  const f = fixture(t, {}, { adoptAfterMount: true })
  f.button('T').click(); await settle()
  assert.ok(f.dialog(), 'the warning opens in the mounted page')
  assert.equal(f.dialog().ownerDocument, f.doc)
  f.dialog().querySelector('[data-reset-cancel]').click(); await settle()
  assert.deepEqual(f.calls, [['preview', 'T']])
})

test('all four category warnings use the server count, Cancel has focus, and cancel makes no write', async t => {
  const f = fixture(t)
  for (const [kind, name] of [['T', 'tasks'], ['R', 'rules'], ['A', 'asks'], ['P', 'purchases']]) {
    f.button(kind).click(); await settle()
    assert.equal(f.dialog().querySelector('h2').textContent, `Reset all ${name}?`)
    const copy = f.dialog().querySelector('#ledger-reset-description').textContent
    assert.match(copy, /14.*across every scope and status, including removed records/)
    if (kind === 'P') assert.match(copy, /3 pending purchase prompts.*does not cancel or refund/)
    assert.equal(f.doc.activeElement, f.dialog().querySelector('[data-reset-cancel]'))
    f.dialog().querySelector('[data-reset-cancel]').click(); await settle()
    assert.equal(f.dialog(), null)
    assert.equal(f.doc.activeElement, f.button(kind))
  }
  assert.deepEqual(f.calls, ['T', 'R', 'A', 'P'].map(kind => ['preview', kind]))
})

test('Escape cancels; a confirmed reset preserves its exact challenge and refreshes once', async t => {
  let resolveWrite
  const f = fixture(t, { ledgerResetConfirm: value => {
    f.calls.push(['confirm', value]); return new Promise(resolve => { resolveWrite = resolve })
  } })
  f.button('R').click(); await settle()
  f.dialog().dispatchEvent({ type: 'cancel' }); await settle()
  assert.equal(f.dialog(), null)
  f.button('T').click(); await settle()
  const confirm = f.dialog().querySelector('[data-reset-confirm]')
  confirm.click(); confirm.click(); f.button('A').click()
  assert.equal(f.calls.filter(([name]) => name === 'confirm').length, 1)
  assert.equal(f.dialog().querySelector('[data-reset-cancel]').disabled, true)
  f.dialog().dispatchEvent({ type: 'cancel' })
  assert.ok(f.dialog(), 'an in-flight durable reset is not reported as canceled')
  resolveWrite({ ok: true, kind: 'T', count: 14 }); await settle()
  assert.equal(f.dialog(), null)
  assert.deepEqual(f.calls.at(-1), ['confirm', { kind: 'T', revision: 25, token: 'a'.repeat(64) }])
  assert.equal(f.refreshed.length, 1)
  assert.equal(f.doc.activeElement, f.button('T'))
})

test('stale or partial failures stay visible and never claim completion', async t => {
  const f = fixture(t, { ledgerResetConfirm: async () => ({ ok: false, pending: true, reason: 'The reset is partly saved. Retry to finish.' }) })
  f.button('T').click(); await settle()
  f.dialog().querySelector('[data-reset-confirm]').click(); await settle()
  assert.match(f.dialog().querySelector('[role="status"]').textContent, /partly saved/)
  assert.equal(f.refreshed.length, 0)
  assert.equal(f.dialog().querySelector('[data-reset-confirm]').disabled, false)
})

test('unverified counts and a disabled source never open a destructive warning', async t => {
  const f = fixture(t, { ledgerResetPreview: async ({ kind }) => ({ kind, count: -1, revision: 0, token: 'a'.repeat(64) }) })
  f.button('T').click(); await settle()
  assert.equal(f.dialog(), null)
  assert.match(f.root.querySelector('[data-ledger-reset-status]').textContent, /could not be verified/)
  f.controls.update({ enabled: false })
  for (const kind of ['T', 'R', 'A', 'P']) assert.equal(f.button(kind).disabled, true)
})

test('leaving the view during preview cannot open a late dialog or confirm a reset', async t => {
  let resolvePreview
  const f = fixture(t, { ledgerResetPreview: () => new Promise(resolve => { resolvePreview = resolve }) })
  f.button('T').click(); f.controls.destroy()
  resolvePreview({ kind: 'T', count: 14, revision: 25, token: 'a'.repeat(64) }); await settle()
  assert.equal(f.dialog(), null)
  assert.deepEqual(f.calls, [])
})

test('reopening a pending purchase reset explains the original batch and keeps its challenge', async t => {
  const f = fixture(t, { ledgerResetPreview: async () => ({ kind: 'P', count: 0, promptCount: 0,
    revision: 25, token: 'a'.repeat(64), pending: true }) })
  f.button('P').click(); await settle()
  assert.equal(f.dialog().querySelector('h2').textContent, 'Finish the previous purchase reset?')
  assert.match(f.dialog().querySelector('#ledger-reset-description').textContent, /already confirmed.*Purchases added afterwards will stay/)
  assert.equal(f.dialog().querySelector('[data-reset-confirm]').textContent, 'Finish reset')
  f.dialog().querySelector('[data-reset-cancel]').click(); await settle()
  assert.match(f.root.querySelector('[data-ledger-reset-status]').textContent, /still unfinished/)
  f.button('P').click(); await settle()
  f.dialog().querySelector('[data-reset-confirm]').click(); await settle()
  assert.deepEqual(f.calls.at(-1), ['confirm', { kind: 'P', revision: 25, token: 'a'.repeat(64) }])
  assert.equal(f.refreshed.length, 1)
})

test('closing a partial reset never reports that the durable work was canceled', async t => {
  const f = fixture(t, { ledgerResetConfirm: async () => ({ ok: false, pending: true }) })
  f.button('P').click(); await settle()
  f.dialog().querySelector('[data-reset-confirm]').click(); await settle()
  assert.equal(f.dialog().querySelector('[data-reset-confirm]').textContent, 'Finish reset')
  f.dialog().querySelector('[data-reset-cancel]').click(); await settle()
  assert.match(f.root.querySelector('[data-ledger-reset-status]').textContent, /still unfinished/)
  assert.equal(f.refreshed.length, 0)
})

test('a recovered reset that aborts before saving no longer reports unfinished work', async t => {
  const f = fixture(t, {
    ledgerResetPreview: async () => ({ kind: 'P', count: 1, promptCount: 1, revision: 25, token: 'a'.repeat(64), pending: true }),
    ledgerResetConfirm: async () => ({ ok: false, pending: false, aborted: true, reason: 'Review the current count.' }),
  })
  f.button('P').click(); await settle()
  f.dialog().querySelector('[data-reset-confirm]').click(); await settle()
  f.dialog().querySelector('[data-reset-cancel]').click(); await settle()
  assert.doesNotMatch(f.root.querySelector('[data-ledger-reset-status]').textContent, /unfinished/)
  assert.equal(f.refreshed.length, 0)
})


for (const kind of ['T', 'R', 'A', 'P']) {
  test(`${kind}: an unsubmitted warning is invalidated when live reset availability is lost`, async t => {
    const f = fixture(t)
    f.button(kind).click(); await settle()
    const staleConfirm = f.dialog().querySelector('[data-reset-confirm]')
    f.controls.update({ enabled: false })
    const warningClosed = f.dialog() === null
    // Explicit event dispatch also exercises the handler, rather than relying
    // on the browser refusing clicks on a disabled/detached button.
    staleConfirm.dispatchEvent({ type: 'click' }); await settle()
    assert.equal(f.calls.filter(([name]) => name === 'confirm').length, 0)
    assert.equal(warningClosed, true, 'a warning for unavailable data must close')
    f.controls.update({ enabled: true })
    staleConfirm.dispatchEvent({ type: 'click' }); await settle()
    assert.equal(f.calls.filter(([name]) => name === 'confirm').length, 0, 'restoring availability cannot revive the old warning')
    assert.match(f.root.querySelector('[data-ledger-reset-status]').textContent, /unavailable/)
    f.button(kind).click(); await settle()
    assert.ok(f.dialog(), 'a fresh explicit preview can open a new warning')
    assert.deepEqual(f.calls, [['preview', kind], ['preview', kind]])
    f.dialog().querySelector('[data-reset-cancel]').click(); await settle()
  })

  test(`${kind}: a deferred preview cannot outlive a reset availability change`, async t => {
    let resolvePreview
    const f = fixture(t, { ledgerResetPreview: () => new Promise(resolve => { resolvePreview = resolve }) })
    f.button(kind).click()
    f.controls.update({ enabled: false })
    f.controls.update({ enabled: true })
    resolvePreview({ kind, count: 14, revision: 25, token: 'a'.repeat(64), promptCount: 3 })
    await settle()
    assert.equal(f.dialog() === null, true, 'even unchanged server revision needs a new warning after availability changes')
    assert.deepEqual(f.calls, [])
    assert.match(f.root.querySelector('[data-ledger-reset-status]').textContent, /unavailable/)
    assert.equal(f.button(kind).disabled, false, 'the invalidated attempt must release its busy state')
  })

  test(`${kind}: failed submitted reset cannot re-enable confirmation after availability is lost`, async t => {
    let resolveWrite
    const f = fixture(t, { ledgerResetConfirm: value => {
      f.calls.push(['confirm', value]); return new Promise(resolve => { resolveWrite = resolve })
    } })
    f.button(kind).click(); await settle()
    const warning = f.dialog(), confirm = warning.querySelector('[data-reset-confirm]')
    confirm.click()
    f.controls.update({ enabled: false })
    assert.equal(f.dialog() === warning, true, 'an already-submitted request must not be labeled canceled')
    assert.equal(warning.querySelector('[data-reset-cancel]').disabled, true)
    resolveWrite({ ok: false, pending: kind === 'P', reason: kind === 'P' ? 'The reset is partly saved.' : 'The reset failed.' })
    await settle()
    assert.equal(f.dialog() === warning, true, 'the actual failed or partial outcome stays visible')
    assert.match(warning.querySelector('[role="status"]').textContent, kind === 'P' ? /partly saved/ : /failed/)
    assert.equal(confirm.disabled, true)
    assert.equal(warning.querySelector('[data-reset-cancel]').disabled, false)
    confirm.dispatchEvent({ type: 'click' }); await settle()
    assert.equal(f.calls.filter(([name]) => name === 'confirm').length, 1)
    f.controls.update({ enabled: true })
    confirm.dispatchEvent({ type: 'click' }); await settle()
    assert.equal(f.calls.filter(([name]) => name === 'confirm').length, 1, 'an invalidated challenge cannot be retried')
    assert.equal(f.refreshed.length, 0)
    warning.querySelector('[data-reset-cancel]').click(); await settle()
    if (kind === 'P') assert.match(f.root.querySelector('[data-ledger-reset-status]').textContent, /still unfinished/)
  })

  test(`${kind}: a submitted success remains truthful after reset availability is lost`, async t => {
    let resolveWrite
    const f = fixture(t, { ledgerResetConfirm: value => {
      f.calls.push(['confirm', value]); return new Promise(resolve => { resolveWrite = resolve })
    } })
    f.button(kind).click(); await settle()
    f.dialog().querySelector('[data-reset-confirm]').click()
    f.controls.update({ enabled: false })
    assert.ok(f.dialog(), 'the in-flight reset is still displayed')
    assert.doesNotMatch(f.root.querySelector('[data-ledger-reset-status]').textContent, /canceled/)
    resolveWrite({ ok: true, kind, count: 14 }); await settle()
    assert.equal(f.dialog() === null, true)
    assert.equal(f.refreshed.length, 1)
    assert.match(f.root.querySelector('[data-ledger-reset-status]').textContent, /completed/)
    assert.equal(f.button(kind).disabled, true)
  })
}

test('losing reset availability preserves the truthful pending-purchase warning outcome', async t => {
  const f = fixture(t, { ledgerResetPreview: async () => ({ kind: 'P', count: 1, promptCount: 1,
    revision: 25, token: 'a'.repeat(64), pending: true }) })
  f.button('P').click(); await settle()
  f.controls.update({ enabled: false }); await settle()
  assert.equal(f.dialog() === null, true)
  assert.match(f.root.querySelector('[data-ledger-reset-status]').textContent, /still unfinished/)
  assert.doesNotMatch(f.root.querySelector('[data-ledger-reset-status]').textContent, /canceled/)
  assert.deepEqual(f.calls, [])
})

/* A REFUSED RESET IS A SENTENCE, NEVER THE TRANSPORT'S ERROR (T1431). */
test('a refused reset or count says what happened in words, never "Error invoking remote method" or a code', async t => {
  const ipc = code => { throw new Error(`Error invoking remote method 'mc-agent:ledger-reset-confirm': Error: ${code}`) }
  const f = fixture(t, { ledgerResetConfirm: async () => ipc('R_LEDGER_CHAIN_APPEND_UNCONFIRMED') })
  f.button('A').click(); await settle()
  f.dialog().querySelector('[data-reset-confirm]').click(); await settle()
  const said = f.dialog().querySelector('[role="status"]').textContent
  assert.equal(said, RESET_REFUSAL.historyUnconfirmed)
  assert.doesNotMatch(said, /Error invoking|remote method|R_LEDGER_/)
  assert.equal(f.refreshed.length, 0)
  f.dialog().querySelector('[data-reset-cancel]').click(); await settle()

  const g = fixture(t, { ledgerResetPreview: async () => { throw new Error("Error invoking remote method 'mc-agent:ledger-reset-preview': Error: R_LEDGER_CHAIN_BROKEN") } })
  g.button('T').click(); await settle()
  assert.equal(g.dialog(), null)
  assert.equal(g.root.querySelector('[data-ledger-reset-status]').textContent, RESET_REFUSAL.historyDamaged)
})

/* A STALE RESET RE-CHECKS IN PLACE (T1534): the same confirmation can only
   fail again, so the button reads the current count instead of sending it,
   and the sentence says agents may be changing the Ledger. */
test('a stale reset turns its button into Check again, reads a fresh count in place, and then resets with the fresh challenge', async t => {
  let previews = 0
  const f = fixture(t, {
    ledgerResetPreview: async ({ kind }) => { previews += 1; f.calls.push(['preview', kind]); return { kind, count: 14 + previews, revision: 25 + previews, token: String(previews).repeat(64) } },
    ledgerResetConfirm: async value => { f.calls.push(['confirm', value]); return value.revision === 26 ? { ok: false, code: 'R_LEDGER_RESET_STALE', reason: 'The Ledger changed. Close this warning and review the current count.' } : { ok: true, kind: 'T', count: 16 } },
  })
  f.button('T').click(); await settle()
  const confirm = () => f.dialog().querySelector('[data-reset-confirm]')
  confirm().click(); await settle()
  assert.equal(f.dialog().querySelector('[role="status"]').textContent, RESET_REFUSAL.stale)
  assert.match(RESET_REFUSAL.stale, /Agents may be filing or changing records/)
  assert.equal(confirm().textContent, 'Check again', 'the dialog still offers the Reset that can only fail again')
  confirm().click(); await settle()
  assert.equal(previews, 2, 'Check again did not read a fresh count')
  assert.match(f.dialog().querySelector('#ledger-reset-description').textContent, /all 16 tasks/)
  assert.equal(confirm().textContent, 'Reset tasks')
  confirm().click(); await settle()
  assert.deepEqual(f.calls.at(-1), ['confirm', { kind: 'T', revision: 27, token: '2'.repeat(64) }])
  assert.equal(f.refreshed.length, 1)
})
