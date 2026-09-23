import assert from 'node:assert/strict'
import test from 'node:test'
import { createSettingsDraft, draftSettingsBridge, settingsSaveFailureMessage } from '../../src/settings-draft.js'

test('edits are private until Save, latest edits win, and discard performs no writes', async () => {
  const writes = [], draft = createSettingsDraft()
  draft.stage('theme', 'black', value => writes.push(value))
  draft.stage('theme', 'tan', value => writes.push(value))
  assert.deepEqual(writes, [])
  assert.equal(draft.value('theme', 'white'), 'tan')
  draft.discard()
  assert.equal(draft.value('theme', 'white'), 'white')
  await draft.save()
  assert.deepEqual(writes, [])
  draft.stage('theme', 'black', value => writes.push(value))
  await draft.save()
  assert.deepEqual(writes, ['black'])
  assert.equal(draft.dirty, false)
})

test('failed Save keeps unsaved work and retry does not repeat successful writes', async () => {
  const writes = [], draft = createSettingsDraft()
  let fail = true
  draft.stage('a', 1, value => { writes.push(value); return { ok: true } })
  draft.stage('b', 2, value => fail ? { ok: false, reason: 'disk unavailable' } : writes.push(value))
  await assert.rejects(draft.save(), /disk unavailable/)
  assert.equal(draft.dirty, true)
  assert.equal(draft.saving, false)
  fail = false
  await draft.save()
  assert.deepEqual(writes, [1, 2])
})

test('product-setting controls read their draft while the host remains unchanged', async () => {
  const draft = createSettingsDraft(), writes = []
  const shell = { read: async () => ({ ok: true, rows: [{ id: 'agent.enabled', value: false }] }),
    set: async (id, value) => { writes.push([id, value]); return { ok: true } } }
  const staged = draftSettingsBridge(shell, draft)
  assert.deepEqual(await staged.set('agent.enabled', true), { ok: true, value: true, draft: true, pending: true })
  assert.equal((await staged.read()).rows[0].value, true)
  assert.equal((await staged.read()).rows[0].savedValue, false, 'the readback identifies the saved policy independently of the pending value')
  assert.equal((await shell.read()).rows[0].value, false)
  assert.deepEqual(writes, [])
  await draft.save()
  assert.deepEqual(writes, [['agent.enabled', true]])
})

test('a save in progress refuses new drafts instead of losing concurrent edits', async () => {
  let finish
  const draft = createSettingsDraft()
  draft.stage('a', 1, () => new Promise(resolve => { finish = resolve }))
  const save = draft.save()
  assert.throws(() => draft.stage('b', 2, () => {}), /finish saving/)
  finish({ ok: true })
  await save
  assert.equal(draft.dirty, false)
})

test('invalid drafts prevent every write and remain correctable or discardable', async () => {
  const writes = [], draft = createSettingsDraft()
  draft.stage('policy', 8, value => writes.push(value))
  draft.setError('policy', 'Enter 64 or less.')
  assert.equal(draft.valid, false)
  await assert.rejects(draft.save(), /64 or less/)
  assert.deepEqual(writes, [])
  assert.equal(draft.dirty, true)
  draft.stage('policy', 16, value => writes.push(value))
  assert.equal(draft.valid, true)
  await draft.save()
  assert.deepEqual(writes, [16])
  draft.setError('policy', 'Enter a whole number.')
  draft.discard()
  assert.equal(draft.dirty, false)
  assert.equal(draft.valid, true)
})

test('restoring the saved product value removes the pending change without writing', async () => {
  let value = true
  const writes = [], draft = createSettingsDraft()
  const staged = draftSettingsBridge({ read: async () => ({ ok: true, rows: [{ id: 'approval', value }] }),
    set: async (id, next) => { writes.push(next); value = next; return { ok: true, value } } }, draft)
  await staged.read()
  await staged.set('approval', false)
  assert.equal(draft.size, 1)
  await staged.set('approval', true)
  assert.equal(draft.size, 0)
  assert.equal(draft.dirty, false)
  await draft.save()
  assert.deepEqual(writes, [])
})

test('sensitive confirmation is prepared at Save and cancellation retains the edit', async () => {
  const events = [], draft = createSettingsDraft()
  let cancel = true
  const staged = draftSettingsBridge({ read: async () => ({ ok: true, rows: [] }),
    set: async (id, value, confirmation) => { events.push({ id, value, confirmation }); return { ok: true, value } },
  }, draft, { confirmWrite: async () => {
    events.push('confirm')
    if (cancel) throw new Error('Keep pending')
    return { confirmationId: 'fixture', code: '1234' }
  } })
  await staged.set('purchases.require_owner_approval', false)
  assert.deepEqual(events, [])
  await assert.rejects(draft.save(), /Keep pending/)
  assert.equal(draft.dirty, true)
  assert.deepEqual(events, ['confirm'])
  cancel = false
  await draft.save()
  assert.deepEqual(events, ['confirm', 'confirm', { id: 'purchases.require_owner_approval', value: false,
    confirmation: { confirmationId: 'fixture', code: '1234' } }])
  assert.equal(draft.dirty, false)
})

test('ordinary product edits batch durably around a separately confirmed purchase change', async () => {
  const calls = [], draft = createSettingsDraft()
  const staged = draftSettingsBridge({
    read: async () => ({ ok: true, rows: [] }),
    setMany: async changes => {
      calls.push({ batch: changes })
      return { ok: true, results: changes.map((change, index) => ({ ...change, ok: true, recorded: { ok: true, sequence: 10 + index, eventHash: 'a'.repeat(64) } })) }
    },
    set: async (id, value, confirmation) => { calls.push({ single: id, value, confirmation }); return { ok: true, value } },
  }, draft, { confirmWrite: async id => { calls.push({ confirm: id }); return { code: '1234' } } })
  for (const [id, value] of [['a', 1], ['b', 2], ['purchases.require_owner_approval', false], ['c', 3], ['d', 4]]) await staged.set(id, value)
  assert.deepEqual(calls, [])
  await draft.save()
  assert.deepEqual(calls, [
    { batch: [{ id: 'a', value: 1 }, { id: 'b', value: 2 }] },
    { confirm: 'purchases.require_owner_approval' },
    { single: 'purchases.require_owner_approval', value: false, confirmation: { code: '1234' } },
    { batch: [{ id: 'c', value: 3 }, { id: 'd', value: 4 }] },
  ])
  assert.equal(draft.dirty, false)
})

test('a batch refusal keeps every edit pending; acknowledged prefix writes are not repeated on retry', async () => {
  const draft = createSettingsDraft(), calls = []
  let attempt = 0
  const staged = draftSettingsBridge({ read: async () => ({ ok: true, rows: [] }),
    set: async (id, value) => { calls.push({ single: id }); return { ok: true, value } },
    setMany: async changes => {
      calls.push(changes.map(change => change.id))
      attempt += 1
      if (attempt === 1) return { ok: false, results: [], reason: 'Candidate refused' }
      if (attempt === 2) return { ok: false, results: [{ ...changes[0], ok: true }, { id: changes[1].id, ok: false, reason: 'Disk unavailable' }] }
      return { ok: true, results: changes.map(change => ({ ...change, ok: true })) }
    },
  }, draft)
  for (const id of ['a', 'b', 'c']) await staged.set(id, id)
  await assert.rejects(draft.save(), /Candidate refused/)
  assert.equal(draft.size, 3)
  await assert.rejects(draft.save(), /Disk unavailable/)
  assert.equal(draft.has('product:a'), false)
  assert.equal(draft.size, 2)
  await draft.save()
  assert.deepEqual(calls, [['a', 'b', 'c'], ['a', 'b', 'c'], ['b', 'c']])
  assert.equal(draft.dirty, false)
})

test('mismatched batch receipts preserve all edits and cannot acknowledge a different setting', async () => {
  const draft = createSettingsDraft()
  const staged = draftSettingsBridge({ set: async () => ({ ok: true }),
    setMany: async () => ({ ok: true, results: [{ id: 'foreign', ok: true }] }),
  }, draft)
  await staged.set('a', 1)
  await staged.set('b', 2)
  await assert.rejects(draft.save(), /did not identify/)
  assert.equal(draft.size, 2)
  assert.equal(draft.saving, false)
})

test('saved settings with failed audit receipts are acknowledged without falsely claiming a complete Save', async () => {
  const draft = createSettingsDraft()
  const staged = draftSettingsBridge({ set: async () => ({ ok: true }),
    setMany: async changes => ({ ok: false, reason: 'The settings were saved but audit recording failed.',
      results: changes.map(change => ({ ...change, ok: true, recorded: { ok: false } })) }),
  }, draft)
  await staged.set('a', 1)
  await staged.set('b', 2)
  await assert.rejects(draft.save(), /audit recording failed/)
  assert.equal(draft.dirty, false)
  assert.match(draft.warning, /activity record could not be confirmed/)
})

test('a saved profile waits for its current canonical policy even when that policy was edited later', async () => {
  const draft = createSettingsDraft(), writes = []
  let refuse = true
  draft.stage('policy', 'first', () => writes.push('stale policy'))
  draft.stage('profile', 'mirror', () => writes.push('profile'), { after: ['policy', 'editor-policy'] })
  draft.stage('editor-policy', 'ask', () => writes.push('editor'))
  draft.stage('policy', 'last', () => {
    writes.push('policy')
    return refuse ? { ok: false, reason: 'Policy refused' } : { ok: true }
  })
  await assert.rejects(draft.save(), /Policy refused/)
  assert.deepEqual(writes, ['editor', 'policy'])
  assert.equal(draft.has('profile'), true)
  refuse = false
  await draft.save()
  assert.deepEqual(writes, ['editor', 'policy', 'policy', 'profile'])
  assert.equal(draft.dirty, false)
})

test('cyclic save dependencies fail before any write', async () => {
  const writes = [], draft = createSettingsDraft()
  draft.stage('a', 1, () => writes.push('a'), { after: ['b'] })
  draft.stage('b', 2, () => writes.push('b'), { after: ['a'] })
  await assert.rejects(draft.save(), /conflicting save dependencies/)
  assert.deepEqual(writes, [])
  assert.equal(draft.size, 2)
  assert.equal(draft.saving, false)
})

test('global failure reports the actual earlier save and scopes a later product batch no-change refusal', async () => {
  const draft = createSettingsDraft(), writes = []
  const stored = { resourceLimit: 8, first: false, second: false }
  let refuse = true
  draft.stage('resources:policy', 2, value => { writes.push('resources'); stored.resourceLimit = value; return { ok: true } })
  const product = draftSettingsBridge({ set: async () => ({ ok: true }), setMany: async changes => {
    writes.push('product')
    if (refuse) return { ok: false, results: [], reason: 'The proposed settings could not be validated (EACCES). No setting was changed.' }
    for (const { id, value } of changes) stored[id] = value
    return { ok: true, results: changes.map(change => ({ ...change, ok: true })) }
  } }, draft)
  await product.set('first', true); await product.set('second', true)
  await assert.rejects(draft.save(), error => {
    assert.deepEqual(stored, { resourceLimit: 2, first: false, second: false })
    assert.deepEqual(draft.saveResult, { total: 3, savedKeys: ['resources:policy'], currentKeys: ['product:first', 'product:second'], complete: false })
    assert.equal(settingsSaveFailureMessage(error, draft), 'Some changes were saved before Save stopped. Unsaved changes remain. Retry saves only the remaining changes. The product settings save reported: “The proposed settings could not be validated (EACCES). No setting was changed.”')
    return true
  })
  assert.equal(draft.has('resources:policy'), false)
  await assert.rejects(draft.save(), error => {
    assert.deepEqual(draft.saveResult.savedKeys, [], 'a retry does not claim that it repeated the earlier resource write')
    assert.match(settingsSaveFailureMessage(error, draft), /^No changes were confirmed saved in this attempt\./)
    assert.deepEqual(stored, { resourceLimit: 2, first: false, second: false })
    return true
  })
  refuse = false
  await draft.save()
  assert.deepEqual(writes, ['resources', 'product', 'product', 'product'])
  assert.deepEqual(stored, { resourceLimit: 2, first: true, second: true })
  assert.deepEqual(draft.saveResult, { total: 2, savedKeys: ['product:first', 'product:second'], currentKeys: [], complete: true })
})

test('a failure with an unknown write outcome never claims that nothing changed', async () => {
  const draft = createSettingsDraft()
  let stored = false
  draft.stage('row:notify_agent_finished', true, value => { stored = value; throw new Error('The connection closed before the save reply.') })
  await assert.rejects(draft.save(), error => {
    assert.equal(stored, true)
    assert.deepEqual(draft.saveResult.savedKeys, [])
    assert.match(settingsSaveFailureMessage(error, draft), /^No changes were confirmed saved in this attempt\./)
    assert.match(settingsSaveFailureMessage(error, draft), /interrupted save step reported/)
    assert.doesNotMatch(settingsSaveFailureMessage(error, draft), /Nothing changed|No setting was changed|Some changes were saved/)
    return true
  })
})

test('an acknowledged batch prefix counts as saved while unacknowledged and mismatched receipts do not', async () => {
  for (const identified of [true, false]) {
    const draft = createSettingsDraft()
    const product = draftSettingsBridge({ set: async () => ({ ok: true }), setMany: async changes => ({ ok: false,
      results: [{ ...changes[0], id: identified ? changes[0].id : 'foreign', ok: true }, { ...changes[1], ok: false, reason: 'Locked' }] }) }, draft)
    await product.set('first', true); await product.set('second', true)
    await assert.rejects(draft.save(), error => {
      assert.deepEqual(draft.saveResult.savedKeys, identified ? ['product:first'] : [])
      assert.equal(settingsSaveFailureMessage(error, draft).startsWith('Some changes were saved'), identified)
      return true
    })
  }
})

test('all saved values and audit or subsequent readback failures are distinct from a partial save', async () => {
  const draft = createSettingsDraft()
  const product = draftSettingsBridge({ set: async () => ({ ok: true }), setMany: async changes => ({ ok: false,
    reason: 'Activity recording failed.', results: changes.map(change => ({ ...change, ok: true, recorded: { ok: false } })) }) }, draft)
  await product.set('first', true); await product.set('second', true)
  await assert.rejects(draft.save(), error => {
    assert.equal(draft.dirty, false)
    const message = settingsSaveFailureMessage(error, draft)
    assert.match(message, /^Your changes were saved\./)
    assert.match(message, /activity record could not be confirmed/)
    assert.doesNotMatch(message, /Unsaved changes remain|Retry saves/)
    return true
  })
  draft.stage('resources:policy', 4, () => ({ ok: true }))
  await draft.save()
  const message = settingsSaveFailureMessage(new Error('Saved values could not be read.'), draft)
  assert.match(message, /^Your changes were saved\. The check after saving reported:/)
  assert.doesNotMatch(message, /activity record|Unsaved changes/)
})

test('a new validation failure clears previous save-result context and result snapshots cannot alter accounting', async () => {
  const draft = createSettingsDraft()
  draft.stage('first', 1, () => ({ ok: true, recorded: { ok: false } }))
  await draft.save()
  assert.match(draft.warning, /activity record/)
  const snapshot = draft.saveResult
  snapshot.savedKeys.push('invented'); snapshot.currentKeys.push('invented'); snapshot.total = 90
  assert.deepEqual(draft.saveResult, { total: 1, savedKeys: ['first'], currentKeys: [], complete: true })
  draft.stage('second', 2, () => { throw new Error('Must not write') })
  draft.setError('second', 'Correct the value.')
  await assert.rejects(draft.save(), error => {
    assert.deepEqual(draft.saveResult, { total: 1, savedKeys: [], currentKeys: [], complete: false })
    assert.match(settingsSaveFailureMessage(error, draft), /^No changes were confirmed saved in this attempt\./)
    assert.match(settingsSaveFailureMessage(error, draft), /check before saving reported: “Correct the value\.”/)
    assert.doesNotMatch(settingsSaveFailureMessage(error, draft), /activity record/)
    return true
  })
})

/* AUDIT OFF IS NOT A FAILED RECORD (owner direction 2026-09-20, T782; M10's
   host contract, read through mission-bridge auditReceiptDisposition). An
   intentional audit-off save answers with the EXACT not-required object for
   this setting -- { ok: true, disposition: 'not-required', required: false,
   recorded: false, durable: false, anchored: false, signed: false,
   sequence: null, eventId: null, eventHash: null, action: 'settings.set',
   target: <id> } and nothing else: no record was requested, so the save is
   complete and quiet. A recorded receipt { ok: true, sequence, eventHash } is
   quiet. Everything else present is NOT quiet -- a refused record, and every
   contradictory or malformed reply: ok: false beside 'not-required', a
   'not-required' with a field missing or added or made for another setting,
   ok: true with nothing to show. The setting is acknowledged as saved either
   way; the answer is read as it came back for that operation. */
test('an intentional audit-off save is complete and quiet; a contradictory or malformed record answer is neither quiet nor a record', async () => {
  const { settingRecordDisposition, SETTING_RECORD_ACTION } = await import('../../src/settings-draft.js')
  assert.equal(SETTING_RECORD_ACTION, 'settings.set')
  const exact = id => ({ ok: true, disposition: 'not-required', required: false, recorded: false, durable: false, anchored: false, signed: false, sequence: null, eventId: null, eventHash: null, action: 'settings.set', target: id })
  const recorded = { ok: true, sequence: 12, eventHash: 'b'.repeat(64) }
  assert.equal(settingRecordDisposition(exact('first'), 'first'), 'not-required')
  assert.equal(settingRecordDisposition(recorded, 'first'), 'recorded')
  assert.equal(settingRecordDisposition(undefined, 'first'), 'absent', 'an older host that never reported a record')
  for (const [answer, why] of [
    [{ ok: false, disposition: 'not-required', required: false }, 'ok: false beside not-required is a contradiction, not a quiet answer'],
    [{ ok: true, required: false }, 'required: false alone is not the not-required object'],
    [{ ...exact('first'), recorded: true }, 'a not-required object that claims a record'],
    [{ ...exact('first'), extra: 1 }, 'a field the contract does not have'],
    [(() => { const { eventId, ...rest } = exact('first'); return rest })(), 'a field the contract has, missing'],
    [exact('second'), 'a not-required claim made for another setting'],
    [{ ...exact('first'), action: 'settings.reset' }, 'a not-required claim for another action'],
    [{ ok: false }, 'a refused record'],
    [{ ok: false, code: 'AUDIT_UNAVAILABLE', reason: 'The saved setting was not recorded in the signed ledger.' }, 'the host\'s own refused shape'],
    [{ ok: true }, 'ok with nothing to show'],
    [{ ok: true, signed: true, sequence: 12 }, 'a sequence without its hash'],
    [{ ok: true, sequence: 12, eventHash: 'b'.repeat(64), signed: false }, 'signed: false beside a recorded receipt'],
    [null, 'null'],
    ['recorded', 'a string'],
  ]) assert.equal(settingRecordDisposition(answer, 'first'), 'unconfirmed', why)

  /* THE KEY THE PAGE STAGES IS 'product:<id>' AND THE HOST'S TARGET IS <id>
     (Controller review of v3, F4). The classifier is handed the id. */
  const { productSettingId } = await import('../../src/settings-draft.js')
  assert.equal(productSettingId('product:audit.activity'), 'audit.activity')
  assert.equal(productSettingId('product:'), null)
  assert.equal(productSettingId('transcripts:settings'), null, 'another writer\'s key is not a product row')
  assert.equal(productSettingId(undefined), null)

  const quiet = createSettingsDraft()
  quiet.stage('product:first', 1, () => ({ ok: true, recorded: exact('first') }))
  quiet.stage('product:second', 2, () => ({ ok: true, recorded: recorded }))
  quiet.stage('product:third', 3, () => ({ ok: true }))
  quiet.stage('transcripts:settings', 4, () => ({ ok: true, transcript: {} }))
  await quiet.save()
  assert.equal(quiet.dirty, false)
  assert.equal(quiet.warning, '', 'no warning for a record that was never requested, a recorded one, an older host that reports none, or another writer\'s own answer')
  assert.deepEqual(quiet.saveResult, { total: 4, savedKeys: ['product:first', 'product:second', 'product:third', 'transcripts:settings'], currentKeys: [], complete: true })

  for (const [answer, why] of [
    [{ ok: false, required: true, disposition: 'refused' }, 'a required record that failed'],
    [{ ok: false, disposition: 'not-required', required: false }, 'a contradictory answer'],
    [{ ...exact('first'), signed: true }, 'a malformed not-required object'],
    [exact('other'), 'another setting\'s not-required object'],
    [exact('product:first'), 'a not-required object for the draft KEY rather than the setting id'],
    [{ ok: true }, 'ok with nothing to show'],
  ]) {
    const draft = createSettingsDraft()
    draft.stage('product:first', 1, () => ({ ok: true, recorded: answer }))
    await draft.save()
    assert.match(draft.warning, /Settings were saved, but their activity record could not be confirmed/, why)
    assert.equal(draft.dirty, false, why + ': the saved setting is still acknowledged')
    assert.deepEqual(draft.saveResult, { total: 1, savedKeys: ['product:first'], currentKeys: [], complete: true }, why)
  }
  const other = createSettingsDraft()
  other.stage('transcripts:settings', 1, () => ({ ok: true, recorded: { ok: false, code: 'AUDIT_UNAVAILABLE' } }))
  await other.save()
  assert.match(other.warning, /could not be confirmed/, 'another writer\'s explicit ok: false record still warns')
})

/* THE ACTUAL BRIDGE → DRAFT PATH (Controller review of v3, F4). The page
   stages product rows through draftSettingsBridge, which keys them
   'product:<id>' and writes them through the shell's set (one row) or setMany
   (a batch), whose answers carry recorded as shell/main.cjs returns it: with
   auditing off, the engine's exact not-required object for 'settings.set' on
   the row id; with auditing on, { ok: true, sequence, eventHash }. Both single
   and batch saves must be quiet; a record for the wrong row must not. */
test('through draftSettingsBridge, single and batch product saves with the host\'s exact record answers are quiet, and a wrong-row record is not', async () => {
  const exact = id => ({ ok: true, disposition: 'not-required', required: false, recorded: false, durable: false, anchored: false, signed: false, sequence: null, eventId: null, eventHash: null, action: 'settings.set', target: id })
  const shell = (answer, single = answer) => ({
    read: async () => ({ ok: true, rows: [{ id: 'audit.activity', value: 'Full' }, { id: 'tools.throughput', value: 'Fast' }, { id: 'agent.tool_summary', value: false }] }),
    set: async (id, value) => ({ ok: true, id, value, revision: 3, recorded: single(id) }),
    setMany: async changes => ({ ok: true, results: changes.map((change, index) => ({ id: change.id, value: change.value, ok: true, revision: 4 + index, recorded: answer(change.id) })) }),
  })

  for (const [name, answer] of [['audit off: the exact not-required object per row', exact], ['audit on: the recorded receipt per row', () => ({ ok: true, sequence: 42, eventHash: 'c'.repeat(64) })]]) {
    const single = createSettingsDraft(), bridge = draftSettingsBridge(shell(answer), single)
    await bridge.set('audit.activity', 'Off')
    assert.equal(single.has('product:audit.activity'), true, name + ': the page stages the prefixed key')
    await single.save()
    assert.equal(single.warning, '', name + ': one row through set() is quiet')
    assert.deepEqual(single.saveResult, { total: 1, savedKeys: ['product:audit.activity'], currentKeys: [], complete: true })

    const batch = createSettingsDraft(), batchBridge = draftSettingsBridge(shell(answer), batch)
    await batchBridge.set('tools.throughput', 'Strict')
    await batchBridge.set('agent.tool_summary', true)
    await batch.save()
    assert.equal(batch.warning, '', name + ': two rows through setMany() are quiet')
    assert.deepEqual(batch.saveResult, { total: 2, savedKeys: ['product:tools.throughput', 'product:agent.tool_summary'], currentKeys: [], complete: true })
  }

  const swapped = createSettingsDraft(), swappedBridge = draftSettingsBridge(shell(id => exact(id === 'tools.throughput' ? 'agent.tool_summary' : 'tools.throughput')), swapped)
  await swappedBridge.set('tools.throughput', 'Strict')
  await swappedBridge.set('agent.tool_summary', true)
  await swapped.save()
  assert.match(swapped.warning, /could not be confirmed/, 'a not-required object made for another row is not this row\'s record')
  assert.equal(swapped.dirty, false, 'the rows are still acknowledged as saved')

  const keyed = createSettingsDraft(), keyedBridge = draftSettingsBridge(shell(id => exact(`product:${id}`)), keyed)
  await keyedBridge.set('audit.activity', 'Off')
  await keyed.save()
  assert.match(keyed.warning, /could not be confirmed/, 'a record naming the draft key instead of the row id is not this row\'s record')
})
