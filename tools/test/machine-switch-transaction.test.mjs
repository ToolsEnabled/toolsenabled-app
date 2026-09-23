import assert from 'node:assert/strict'
import test from 'node:test'
import { DATA_SOURCE_EVENT } from '../../src/data-source.js'
import { MACHINE_CHOICE_INTENT_EVENT, MACHINE_TAB_NOT_CHECKED, machineTabSwitchState, machineTabSwitchResultIsCurrent,
  subscribeMachineTabSwitch, switchMachineTab } from '../../src/machine-tabs.js'

const a = { relayPairId: 'pair-a', devicePairId: 'device-a', name: 'Private Computer A' }
const b = { relayPairId: 'pair-b', devicePairId: 'device-b', name: 'Computer B' }
const c = { relayPairId: 'pair-c', devicePairId: 'device-c', name: 'Computer C' }
const refused = { ok: false, reason: 'This computer did not answer. Try again in a moment.' }
const deferred = () => { let resolve; const promise = new Promise(go => { resolve = go }); return { promise, resolve } }
const turn = () => new Promise(resolve => setImmediate(resolve))

function fixture({ choose, check, forget, version = 1 } = {}) {
  const scope = new EventTarget()
  const calls = []
  const events = []
  const emit = (type, detail) => { events.push([type, detail]); scope.dispatchEvent(new CustomEvent(type, { detail })) }
  const intent = input => emit(MACHINE_CHOICE_INTENT_EVENT, {
    machineChoiceIntent: input?.machineChoiceIntent || null,
    relayPairId: input?.relayPairId || null, devicePairId: input?.devicePairId || null,
  })
  const commit = (input, why = 'machine-chosen') => emit(DATA_SOURCE_EVENT, {
    why, machineChoiceIntent: input?.machineChoiceIntent || null,
    relayPairId: input?.relayPairId || null, devicePairId: input?.devicePairId || null,
  })
  scope.mcAccount = {
    machineChoiceIntentVersion: version,
    machines: async () => ({ ok: true, machines: [] }),
    chooseMachine: async input => {
      calls.push(['choose', input])
      intent(input)
      if (choose) return choose(input, commit, calls)
      commit(input)
      return { ok: true, ...input }
    },
    forgetMachine: async input => {
      calls.push(['forget', input])
      intent(input)
      if (forget) return forget(input, commit)
      commit(input, 'machine-forgotten')
      return { ok: true }
    },
    checkMachine: async (...input) => { calls.push(['check', ...input]); return check ? check(...input) : { ok: true } },
  }
  return { scope, calls, events, intent, commit,
    fence: why => emit(DATA_SOURCE_EVENT, { why }),
    state: () => machineTabSwitchState(scope),
    switch: (row = b, previous = a) => switchMachineTab(scope, row, { previous }),
  }
}

test('one transaction survives subscriber replacement and blocks a competing press', async () => {
  const answer = deferred()
  const f = fixture({ check: () => answer.promise })
  const retired = []
  const remove = subscribeMachineTabSwitch(f.scope, state => retired.push(state))
  const result = f.switch()
  await turn()
  assert.deepEqual(f.state(), { busy: true, sentence: 'Opening Computer B…' })
  remove()
  const mounted = []
  const detach = subscribeMachineTabSwitch(f.scope, state => mounted.push(state))
  const retiredCount = retired.length
  assert.deepEqual(await f.switch(c), { ok: false, cancelled: true })
  assert.equal(f.calls.filter(([name]) => name === 'choose').length, 1)
  answer.resolve(refused)
  const finished = await result
  assert.equal(finished.ok, false)
  assert.equal(f.state().sentence, `${refused.reason} You are still driving Private Computer A.`)
  assert.equal(mounted.at(-1).busy, false)
  assert.equal(retired.length, retiredCount, 'destroyed views receive no completion')
  assert.equal(f.calls.filter(([name]) => name === 'choose').length, 2, 'own rollback still occurs')
  detach()
})

for (const why of ['sign-out-started', 'account-session-changed', 'session-ended', 'example-toggle']) {
  test(`${why} cancels the delayed check before rollback or private outcome`, async () => {
    const answer = deferred()
    const f = fixture({ check: () => answer.promise })
    const pending = f.switch()
    await turn()
    f.fence(why)
    assert.deepEqual(f.state(), { busy: false, sentence: '' }, 'fence is synchronous')
    answer.resolve(refused)
    assert.deepEqual(await pending, { ok: false, cancelled: true })
    assert.equal(f.calls.filter(([name]) => name === 'choose').length, 1, 'old account is not restored')
    assert.deepEqual(f.state(), { busy: false, sentence: '' })
  })
}

for (const newer of [b, c, null]) {
  test(`a newer ${newer?.name || 'forget'} intent supersedes a held check before selection commits`, async () => {
    const answer = deferred()
    const f = fixture({ check: () => answer.promise })
    const pending = f.switch()
    await turn()
    f.intent(newer)
    assert.deepEqual(f.state(), { busy: false, sentence: '' }, 'intent does not wait for accepted authority')
    answer.resolve(refused)
    assert.deepEqual(await pending, { ok: false, cancelled: true })
    assert.equal(f.calls.filter(([name]) => name === 'choose').length, 1)
    f.commit(newer, newer ? 'machine-chosen' : 'machine-forgotten')
    assert.deepEqual(f.state(), { busy: false, sentence: '' })
  })
}

test('late first completion cannot overwrite a newer completed switch', async () => {
  const first = deferred()
  const f = fixture({ check: pair => pair === b.relayPairId ? first.promise : { ok: true } })
  const old = f.switch()
  await turn()
  f.intent(c)
  assert.equal((await f.switch(c)).ok, true)
  first.resolve(refused)
  assert.deepEqual(await old, { ok: false, cancelled: true })
  assert.deepEqual(f.state(), { busy: false, sentence: '' })
  assert.deepEqual(f.calls.filter(([name]) => name === 'choose').map(([, input]) => input.devicePairId), ['device-b', 'device-c'])
})

test('an event gap preserves the same pending switch and own forget completes honestly', async () => {
  const answer = deferred()
  const f = fixture({ check: () => answer.promise })
  const pending = f.switch(b, null)
  await turn()
  f.fence('agent-events-gap')
  assert.equal(f.state().busy, true)
  answer.resolve(refused)
  const result = await pending
  assert.match(result.sentence, /No computer is chosen now/)
  const chose = f.calls.find(([name]) => name === 'choose')[1]
  const forgot = f.calls.find(([name]) => name === 'forget')[1]
  assert.equal(forgot.machineChoiceIntent, chose.machineChoiceIntent)
  assert.equal(f.state().busy, false)
})

test('a matching token with a different committed target does not prove ownership', async () => {
  const f = fixture({ choose: (input, commit) => { commit({ ...input, devicePairId: 'different-device' }); return { ok: true } } })
  assert.deepEqual(await f.switch(), { ok: false, cancelled: true })
  assert.equal(f.calls.filter(([name]) => name === 'check').length, 0)
  assert.deepEqual(f.state(), { busy: false, sentence: '' })
})

test('an intent with the old token but another target cancels before its commit', async () => {
  const answer = deferred()
  const f = fixture({ check: () => answer.promise })
  const pending = f.switch()
  await turn()
  const input = f.calls.find(([kind]) => kind === 'choose')[1]
  f.intent({ ...input, devicePairId: c.devicePairId })
  assert.deepEqual(f.state(), { busy: false, sentence: '' })
  answer.resolve(refused)
  assert.deepEqual(await pending, { ok: false, cancelled: true })
  assert.equal(f.calls.filter(([kind]) => kind === 'choose').length, 1)
})

test('a failed or throwing own forget never reports a confirmed empty selection', async () => {
  for (const forget of [() => ({ ok: false }), () => { throw new Error('held connection refused') }]) {
    const f = fixture({ check: () => refused, forget })
    const result = await f.switch(b, null)
    assert.equal(result.ok, false)
    assert.doesNotMatch(result.sentence, /No computer is chosen now/)
    assert.match(result.sentence, /back/)
    assert.equal(f.state().busy, false)
  }
})

test('account change after accepted choice but before its continuation prevents check', async () => {
  let f
  f = fixture({ choose: (input, commit) => {
    commit(input)
    f.fence('account-session-changed')
    return { ok: true }
  } })
  assert.deepEqual(await f.switch(), { ok: false, cancelled: true })
  assert.equal(f.calls.filter(([name]) => name === 'check').length, 0)
})

test('a delayed rollback cannot publish after sign-out', async () => {
  const restore = deferred()
  const f = fixture({ check: () => refused, choose: (input, commit) => {
    if (input.devicePairId === a.devicePairId) return restore.promise
    commit(input)
    return { ok: true }
  } })
  const pending = f.switch()
  await turn()
  assert.equal(f.calls.filter(([name]) => name === 'choose').length, 2)
  f.fence('sign-out-started')
  restore.resolve({ ok: false, reason: 'The newer authority cancelled this selection.' })
  assert.deepEqual(await pending, { ok: false, cancelled: true })
  assert.deepEqual(f.state(), { busy: false, sentence: '' })
})

test('a delayed own forget cannot publish after a newer selection intent', async () => {
  const forget = deferred()
  const f = fixture({ check: () => refused, forget: () => forget.promise })
  const pending = f.switch(b, null)
  await turn()
  assert.equal(f.calls.filter(([kind]) => kind === 'forget').length, 1)
  f.intent(c)
  forget.resolve({ ok: false })
  assert.deepEqual(await pending, { ok: false, cancelled: true })
  assert.deepEqual(f.state(), { busy: false, sentence: '' })
})

test('a thrown check keeps the original uncertainty and performs one owned rollback', async () => {
  const f = fixture({ check: () => { throw new Error('connection closed') } })
  const result = await f.switch()
  assert.equal(result.ok, false)
  assert.match(result.sentence, /could not find out/)
  assert.match(result.sentence, /still driving Private Computer A/)
  assert.equal(f.calls.filter(([kind]) => kind === 'choose').length, 2)
  assert.equal(f.state().busy, false)
})

test('old bridges are refused only by the transactional UI path before any mutation', async () => {
  const f = fixture({ version: undefined })
  delete f.scope.mcAccount.machineChoiceIntentVersion
  const result = await f.switch()
  assert.equal(result.ok, false)
  assert.match(result.sentence, /Reload the page/)
  assert.match(result.sentence, /account page/)
  assert.deepEqual(f.calls, [])
})

test('verified success clears progress; an older check capability remains explicitly unverified', async () => {
  const f = fixture()
  assert.equal((await f.switch()).verified, true)
  assert.deepEqual(f.state(), { busy: false, sentence: '' })
  delete f.scope.mcAccount.checkMachine
  const result = await f.switch(c)
  assert.equal(result.ok, true)
  assert.equal(result.verified, false)
  assert.equal(f.state().sentence, MACHINE_TAB_NOT_CHECKED)
})

test('a completed answer superseded before its consumer resumes has no view effects', async () => {
  const f = fixture()
  let wasBusy = false
  const off = subscribeMachineTabSwitch(f.scope, state => {
    if (state.busy) wasBusy = true
    else if (wasBusy) { wasBusy = false; f.intent(c) }
  })
  const result = await f.switch()
  assert.equal(result.ok, true, 'the old transaction did complete')
  assert.equal(machineTabSwitchResultIsCurrent(f.scope, result), false, 'its consumer must not restore stale tabs or notes')
  assert.deepEqual(f.state(), { busy: false, sentence: '' })
  off()
})

test('a fence while progress is announced prevents the first mutation', async () => {
  const f = fixture()
  const off = subscribeMachineTabSwitch(f.scope, state => {
    if (state.busy) f.fence('account-session-changed')
  })
  assert.deepEqual(await f.switch(), { ok: false, cancelled: true })
  assert.deepEqual(f.calls, [])
  assert.deepEqual(f.state(), { busy: false, sentence: '' })
  off()
})

test('an incomplete versioned bridge cannot claim it forgot a silent first choice', async () => {
  const f = fixture({ check: () => refused })
  delete f.scope.mcAccount.forgetMachine
  const result = await f.switch(b, null)
  assert.equal(result.ok, false)
  assert.doesNotMatch(result.sentence, /No computer is chosen now/)
  assert.match(result.sentence, /back/)
})

test('a newer same-target entry reusing the optional token cancels held readiness before rollback', async () => {
  const answer = deferred()
  const f = fixture({ check: () => answer.promise })
  const pending = f.switch()
  await turn()
  const input = f.calls.find(([kind]) => kind === 'choose')[1]
  await f.scope.mcAccount.chooseMachine({ ...input })
  assert.deepEqual(f.state(), { busy: false, sentence: '' }, 'a second entry is not the original prepared call')
  answer.resolve(refused)
  assert.deepEqual(await pending, { ok: false, cancelled: true })
  assert.equal(f.calls.filter(([kind]) => kind === 'choose').length, 2, 'no old rollback may follow the newer choice')
})

test('a repeated accepted event cannot stand in for a new prepared choice', async () => {
  const answer = deferred()
  const f = fixture({ check: () => answer.promise })
  const pending = f.switch()
  await turn()
  const input = f.calls.find(([kind]) => kind === 'choose')[1]
  f.commit(input)
  answer.resolve(refused)
  assert.deepEqual(await pending, { ok: false, cancelled: true })
  assert.equal(f.calls.filter(([kind]) => kind === 'choose').length, 1)
})

test('an accepted event without its preceding prepared intent does not authorize the continuation', async () => {
  const f = fixture()
  f.scope.mcAccount.chooseMachine = async input => {
    f.calls.push(['choose', input])
    f.commit(input)
    return { ok: true, ...input }
  }
  assert.deepEqual(await f.switch(), { ok: false, cancelled: true })
  assert.equal(f.calls.filter(([kind]) => kind === 'check').length, 0)
  assert.deepEqual(f.state(), { busy: false, sentence: '' })
})
