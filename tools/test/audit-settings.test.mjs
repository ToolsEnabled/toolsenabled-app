import assert from 'node:assert/strict'
import test from 'node:test'
import { createAuditSettings } from '../../src/audit-settings.js'

test('an absent audit bridge explains availability without an actionable rotation', () => {
  const controller = createAuditSettings({ shell: {} })
  assert.match(controller.markup(), /updated ToolsEnabled desktop app/)
  assert.doesNotMatch(controller.markup(), /data-audit-action="rotate"/)
  controller.destroy()
})

test('inspection is read-only and unknown custody never enables rotation', async () => {
  const calls = []
  const controller = createAuditSettings({ shell: {
    auditProbe: async () => { calls.push('probe'); return { ok: true, canRotate: false, reason: 'The encrypted signing key could not be read.' } },
    auditConfirmation: async () => { calls.push('confirmation'); return { ok: true } },
    auditRotate: async () => { calls.push('rotate'); return { ok: true } },
  }, confirmation: { confirmAction: async () => ({}) } })
  await controller.inspect()
  await controller.execute('rotate')
  assert.deepEqual(calls, ['probe'])
  assert.match(controller.markup(), /encrypted signing key could not be read/)
  assert.doesNotMatch(controller.markup(), /data-audit-action="rotate"/)
  controller.destroy()
})

test('canceling a local confirmation leaves the native audit identity untouched', async () => {
  const calls = [], busy = []
  const controller = createAuditSettings({ shell: {
    auditProbe: async () => ({ ok: true, canRotate: true }),
    auditConfirmation: async request => { calls.push(request); return { ok: true, code: '1234', confirmationId: 'one-use' } },
    auditRotate: async () => { calls.push('rotate'); return { ok: true } },
  }, confirmation: { confirmAction: async () => { throw new Error('The audit identity was not changed.') } }, onBusy: value => busy.push(value) })
  await controller.inspect()
  await controller.execute('rotate')
  assert.deepEqual(calls, [{ operation: 'rotate' }])
  assert.deepEqual(busy, [true, false])
  assert.match(controller.markup(), /The audit identity was not changed/)
  controller.destroy()
})

test('recovery carries the one-use confirmation once and displays verified archive and restart results', async () => {
  const calls = []
  let probe = { ok: true, canRotate: false, canRecover: true, headSequence: 9000 }
  let release
  const controller = createAuditSettings({ shell: {
    auditProbe: async () => probe,
    auditConfirmation: async request => { calls.push(request); return { ok: true, code: '1234', confirmationId: 'recovery-receipt' } },
    auditRotate: async code => { calls.push(code); probe = { ok: true, canRotate: true, lastArchivePath: '/archive/<untrusted>.json' }; return { ok: true, archivePath: probe.lastArchivePath, restartRequired: true } },
  }, confirmation: { confirmAction: challenge => new Promise(resolve => { release = () => resolve({ confirmationId: challenge.confirmationId, code: challenge.code }) }) } })
  await controller.inspect()
  const recovery = controller.execute('recover')
  await Promise.resolve()
  await controller.execute('recover')
  release()
  await recovery
  assert.deepEqual(calls, [{ operation: 'recover' }, { confirmationId: 'recovery-receipt', code: '1234' }])
  assert.match(controller.markup(), /Audit recovery completed/)
  assert.match(controller.markup(), /Restart ToolsEnabled/)
  assert.match(controller.markup(), /&lt;untrusted&gt;/)
  assert.doesNotMatch(controller.markup(), /<untrusted>/)
  controller.destroy()
})

test('a stale probe cannot re-enable rotation after a newer custody refusal', async () => {
  let first, reads = 0
  const controller = createAuditSettings({ shell: { auditProbe: () => ++reads === 1
    ? new Promise(resolve => { first = resolve }) : Promise.resolve({ ok: true, canRotate: false, reason: 'Vault is locked.' }) } })
  const old = controller.inspect()
  await controller.inspect({ force: true })
  first({ ok: true, canRotate: true })
  await old
  assert.match(controller.markup(), /Vault is locked/)
  assert.doesNotMatch(controller.markup(), /data-audit-action="rotate"/)
  controller.destroy()
})

test('a pending global Save and unrecognized operations never reach audit execution', async () => {
  const calls = []
  const controller = createAuditSettings({ draft: { saving: true }, shell: {
    auditProbe: async () => ({ ok: true, canRotate: true }),
    auditConfirmation: async () => { calls.push('confirmation') }, auditRotate: async () => { calls.push('rotate') },
  }, confirmation: { confirmAction: async () => ({}) } })
  await controller.inspect()
  await controller.execute('rotate')
  await controller.execute('delete')
  assert.deepEqual(calls, [])
  controller.destroy()
})

test('repair is offered only for explicitly repairable custody and makes the history break clear', async () => {
  const calls = []
  let options
  const controller = createAuditSettings({ shell: {
    auditProbe: async () => ({ ok: true, canRepair: true, canRotate: false, status: 'repairable', repairReason: 'missing-key' }),
    auditConfirmation: async request => { calls.push(request); return { ok: true, confirmationId: 'repair-receipt', code: '4321' } },
    auditRotate: async code => { calls.push(code); return { ok: true, status: 'repaired', archivePath: '/archive/old', restartRequired: true } },
  }, confirmation: { confirmAction: async (challenge, copy) => {
    options = copy
    return { confirmationId: challenge.confirmationId, code: challenge.code }
  } } })
  await controller.inspect()
  assert.match(controller.markup(), /data-audit-action="repair"/)
  assert.doesNotMatch(controller.markup(), /data-audit-action="rotate"/)
  assert.match(controller.markup(), /unverified archive/)
  await controller.execute('rotate')
  assert.deepEqual(calls, [])
  await controller.execute('repair')
  assert.deepEqual(calls, [{ operation: 'repair' }, { confirmationId: 'repair-receipt', code: '4321' }])
  assert.match(options.description, /does not verify or restore earlier history/)
  assert.match(options.description, /Unrelated vault records will be preserved/)
  assert.match(controller.markup(), /Earlier records remain archived and unverified/)
  assert.match(controller.markup(), /Restart ToolsEnabled/)
  await controller.execute('repair')
  assert.equal(calls.length, 2, 'a restart-required result blocks another maintenance request')
  controller.destroy()
})

test('repair cancellation does not execute a native write', async () => {
  const calls = []
  const controller = createAuditSettings({ shell: {
    auditProbe: async () => ({ ok: true, canRepair: true }),
    auditConfirmation: async request => { calls.push(request); return { ok: true } },
    auditRotate: async () => { calls.push('write') },
  }, confirmation: { confirmAction: async () => { throw new Error('The audit identity was not changed.') } } })
  await controller.inspect()
  await controller.execute('repair')
  assert.deepEqual(calls, [{ operation: 'repair' }])
  assert.match(controller.markup(), /was not changed/)
  controller.destroy()
})

test('unreadable whole custody, unsaved settings, and restart state never request a repair challenge', async () => {
  for (const condition of ['custody', 'draft', 'restart']) {
    const calls = []
    const controller = createAuditSettings({ draft: { dirty: condition === 'draft' }, shell: {
      auditProbe: async () => ({ ok: true, canRepair: condition !== 'custody', restartRequired: condition === 'restart' }),
      auditConfirmation: async () => { calls.push('challenge') }, auditRotate: async () => { calls.push('write') },
    }, confirmation: { confirmAction: async () => ({}) } })
    await controller.inspect()
    await controller.execute('repair')
    assert.deepEqual(calls, [], condition)
    if (condition === 'draft') assert.match(controller.markup(), /Save or discard pending settings/)
    controller.destroy()
  }
})

test('a failed inspection after maintenance cannot forget the required restart', async () => {
  let fail = false, writes = 0
  const controller = createAuditSettings({ shell: {
    auditProbe: async () => { if (fail) throw new Error('Inspection interrupted'); return { ok: true, canRotate: true } },
    auditConfirmation: async () => ({ ok: true, confirmationId: 'once', code: '4321' }),
    auditRotate: async () => { writes++; fail = true; return { ok: true, restartRequired: true } },
  }, confirmation: { confirmAction: async challenge => challenge } })
  await controller.inspect()
  await controller.execute('rotate')
  assert.match(controller.markup(), /Inspection interrupted/)
  assert.match(controller.markup(), /Restart ToolsEnabled/)
  fail = false
  await controller.inspect()
  await controller.execute('rotate')
  assert.equal(writes, 1)
  controller.destroy()
})

test('failed native replies latch their restart requirement before any later inspection failure', async () => {
  for (const failureAt of ['probe', 'repair']) {
    let requests = 0, phase = 'initial'
    const controller = createAuditSettings({ shell: {
      auditProbe: async () => {
        if (phase === 'failed') throw new Error('Worker unavailable')
        if (failureAt === 'probe' && phase === 'initial') { phase = 'failed'; return { ok: false, restartRequired: true, reason: 'Worker cleanup failed' } }
        return { ok: true, canRepair: true }
      },
      auditConfirmation: async () => { requests++; return { ok: true, confirmationId: 'once', code: '4321' } },
      auditRotate: async () => { phase = 'failed'; return { ok: false, restartRequired: true, reason: 'Writers could not all close' } },
    }, confirmation: { confirmAction: async challenge => challenge } })
    await controller.inspect()
    if (failureAt === 'repair') await controller.execute('repair')
    assert.match(controller.markup(), /Restart ToolsEnabled/)
    await controller.inspect()
    phase = 'retry'
    await controller.inspect()
    await controller.execute('repair')
    assert.equal(requests, failureAt === 'repair' ? 1 : 0, failureAt)
    controller.destroy()
  }
})
