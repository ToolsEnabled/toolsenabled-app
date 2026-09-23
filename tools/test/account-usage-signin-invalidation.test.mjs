import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import path from 'node:path'
import { readAccountList, readUsageReply, mergeAccounts, needsSignIn, loadUsage } from '../../src/account-switcher-state.js'

const require = createRequire(import.meta.url)
const source = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
const bindingA = 'a'.repeat(64), bindingB = 'b'.repeat(64)
const generation = token => ({ kind: 'file', token: token.repeat(64) })
const accountA = { name: 'work', provider: 'claude', directory: '/fictional/work', allowanceBinding: bindingA, authGeneration: generation('c') }
const accountB = { name: 'school', provider: 'codex', directory: '/fictional/school', allowanceBinding: bindingB, authGeneration: generation('d') }
const reading = (account, overrides = {}) => ({ ...account, status: 'healthy', canServe: true,
  readAt: '2031-01-01T00:00:00.000Z', usageStatus: 'measured', email: `${account.name}@example.test`,
  windows: { hourly: { usedPercent: 40, remainingPercent: 60 }, weekly: null, weeklyWindows: [] }, ...overrides })
const answer = accounts => ({ ok: true, readAt: '2031-01-01T00:00:00.000Z', accounts,
  orders: accounts.map(account => ({ provider: account.provider, names: [account.name], why: 'Fictional order' })), policy: {} })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const closedReading = (account, overrides = {}) => Object.defineProperty(reading(account, overrides),
  'probeLifecycle', { value: 'closed' })

const bucketFixture = { schemaVersion: 1, provider: 'claude', source: 'synthetic-independent-limit', sourceVersion: '1',
  observedAt: '2031-01-01T00:00:00.000Z', status: 'measured', issues: [],
  buckets: [{ key: '["model-a","REQUESTS"]', modelId: 'model-a', tokenType: 'REQUESTS', remainingFraction: 0.5,
    remainingAmount: '9007199254740993.125', resetsAt: null, status: 'measured', issues: [] }] }

test('independent allowance buckets obey actual shell sign-in, generation and home binding invalidation', async () => {
  const original = answer([reading(accountA, { allowanceBuckets: bucketFixture }), reading(accountB)])
  const watched = harness(original, async () => original)
  assert.deepEqual((await watched.cached()).accounts[0].allowanceBuckets, bucketFixture)
  await watched.changed()
  assert.equal((await watched.cached()).accounts.some(row => row.allowanceBuckets), false)

  const changed = harness(original, async () => {
    changed.setGeneration(bindingA, generation('e'))
    return original
  })
  const fresh = await changed.read()
  const rejected = fresh.accounts.find(row => row.allowanceBinding === bindingA)
  assert.equal(rejected.usageCode, 'ACCOUNT_USAGE_AUTH_CHANGED')
  assert.equal(rejected.allowanceBuckets, null)
  assert.equal(JSON.stringify(await changed.cached()).includes('9007199254740993.125'), false)

  const rebound = harness(original, async () => original)
  rebound.setAccounts([{ ...accountA, allowanceBinding: 'f'.repeat(64) }, accountB])
  assert.equal((await rebound.cached()).accounts.some(row => row.allowanceBuckets), false)
})

function harness(initial, probe, { filterVersion = 1 } = {}) {
  let disk = JSON.stringify(initial), watch, handler, writeHold = null, started = 0, writeFails = false
  let currentAccounts = structuredClone([accountA, accountB])
  const notices = []
  const actualDurableFile = require('../../shell/durable-file.cjs')
  const context = vm.createContext({
    nodePath: path, app: { getPath: () => '/fictional/userdata' },
    durableFile: { serialQueue: actualDurableFile.serialQueue, PRESENT: actualDurableFile.PRESENT,
      readBoundedFile: async () => ({ state: actualDurableFile.PRESENT, text: disk }),
      replaceFileAtomically: async (_file, text) => { if (writeHold) { const hold = writeHold; writeHold = null; started++; await hold.promise } if (writeFails) throw new Error('fictional cache write failed'); disk = text },
    },
    accountRegistry: {
      listAsync: async () => ({ ok: true, damaged: false, accounts: structuredClone(currentAccounts) }),
      watchSignIn(_account, listener) { watch = listener; return { stop() {} } },
    },
    asyncSingleFlight: require('../../shell/async-single-flight.cjs').asyncSingleFlight,
    ACCOUNT_REGISTRY_FILE: '/fictional/accounts.json', ACCOUNT_HOME_DIR: '/fictional/home',
    loadRotation: () => ({ ACCOUNT_USAGE_BINDING_FILTER_VERSION: filterVersion,
      accountUsageBinding: account => account.allowanceBinding || (account.directory === accountA.directory ? bindingA : bindingB),
      readAccountUsage: options => probe(options) }),
    ipcMain: { handle(name, fn) { assert.equal(name, 'mc-accounts:usage'); handler = fn } },
    assertTrustedAgentSender(event) { assert.equal(event.trusted, true) },
  })
  const cacheAt = source.indexOf('const ACCOUNT_USAGE_CACHE_FILE =')
  const usageAt = source.indexOf('const readAccountsUsage = asyncSingleFlight(')
  const handlerAt = source.indexOf("ipcMain.handle('mc-accounts:usage'")
  const watchAt = source.indexOf('function armSignInWatch(')
  assert.ok([cacheAt, usageAt, handlerAt, watchAt].every(index => index > 0))
  vm.runInContext([
    source.slice(cacheAt, source.indexOf("ipcMain.handle('mc-accounts:rename'", cacheAt)),
    source.slice(usageAt, source.indexOf('\n})\n', handlerAt) + 4),
    source.slice(watchAt, source.indexOf("ipcMain.handle('mc-provider-login:start'", watchAt)),
  ].join('\n'), context)
  context.fixtureAccount = accountA
  context.fixtureSender = { isDestroyed: () => false, once() {}, send(_channel, packet) { notices.push(structuredClone(packet)) } }
  assert.equal(vm.runInContext('armSignInWatch(fixtureSender, fixtureAccount)', context), true)
  return {
    read: async () => structuredClone(await handler({ trusted: true })),
    cached: async () => structuredClone(await vm.runInContext('readAccountUsageCache()', context)),
    async changed(signedIn = 'yes') { await watch({ name: accountA.name, provider: accountA.provider, signedIn }); await new Promise(resolve => setImmediate(resolve)) },
    holdNextWrite() { writeHold = deferred(); return writeHold },
    writeStarted: () => started,
    failWrites() { writeFails = true },
    disk: () => JSON.parse(disk),
    accounts: () => structuredClone(currentAccounts),
    setGeneration(binding, value) { currentAccounts = currentAccounts.map(account => account.allowanceBinding === binding ? { ...account, authGeneration: value } : account) },
    setAccounts(accounts) { currentAccounts = structuredClone(accounts) },
    notices,
  }
}

test('a sign-in change removes the prior native cache identity before a fresh panel reads it', async () => {
  let probes = 0
  const original = answer([reading(accountA, { status: 'signed_out', canServe: false, email: 'previous@example.test' }), reading(accountB)])
  const fixture = harness(original, async () => { probes++; return original })
  await fixture.changed()
  const cached = await fixture.cached()
  assert.deepEqual(cached.accounts.map(row => row.allowanceBinding), [bindingB], 'a new panel received the old sign-in result from disk')
  assert.deepEqual(cached.orders.map(row => row.provider), ['codex'], 'the changed account kept a stale provider ordering')
  const list = readAccountList({ ok: true, accounts: [accountA, accountB].map(row => ({ ...row, signedIn: 'yes' })) })
  const rows = mergeAccounts(list, readUsageReply(cached))
  assert.equal(rows[0].status, null)
  assert.equal(rows[0].email, null)
  assert.equal(needsSignIn(rows[0]), false)
  assert.equal(rows[1].measured, true, 'another account lost its reading')
  assert.equal(probes, 0, 'the invalidation started provider work')
  assert.equal(fixture.notices.length, 1)
})

test('a pre-sign-in sweep cannot return or repopulate the changed account; a later explicit refresh can', async () => {
  const old = answer([closedReading(accountA, { email: 'previous@example.test' }), closedReading(accountB)])
  const held = deferred()
  let next = held.promise, probes = 0
  const fixture = harness(old, () => { probes++; return next })
  const first = fixture.read(), second = fixture.read()
  await new Promise(resolve => setImmediate(resolve))
  await fixture.changed()
  held.resolve(old)
  const [one, two] = await Promise.all([first, second])
  const refused = one.accounts.find(row => row.allowanceBinding === bindingA)
  assert.equal(refused.email, null, 'the old sweep returned the pre-sign-in identity')
  assert.equal(refused.windows.hourly, null)
  assert.equal(refused.usageCode, 'ACCOUNT_USAGE_AUTH_CHANGED')
  assert.match(refused.usageReason, /check.*again/i)
  const visible = mergeAccounts(readAccountList({ ok: true, accounts: fixture.accounts() }), readUsageReply(one))[0]
  assert.equal(visible.usageState, 'failed', 'a watched sign-in change produced a blanket successful check')
  assert.deepEqual(two, one, 'coalesced readers disagreed')
  assert.deepEqual((await fixture.cached()).accounts.map(row => row.allowanceBinding), [bindingB])
  assert.equal(probes, 1)
  next = Promise.resolve(answer([reading(accountA, { email: 'new@example.test' }), reading(accountB)]))
  const fresh = await fixture.read()
  assert.equal(fresh.accounts.find(row => row.allowanceBinding === bindingA).email, 'new@example.test')
  assert.equal((await fixture.cached()).accounts.find(row => row.allowanceBinding === bindingA).email, 'new@example.test')
  assert.equal(probes, 2, 'only the later explicit refresh may start another sweep')
})

test('a sign-in change during a pending cache write also removes the stale direct reply', async () => {
  const old = answer([reading(accountA, { email: 'previous@example.test' }), reading(accountB)])
  const fixture = harness(old, async () => old)
  const hold = fixture.holdNextWrite()
  const pending = fixture.read()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(fixture.writeStarted(), 1)
  const changed = fixture.changed('unknown')
  hold.resolve()
  const reply = await pending
  await changed
  const refused = reply.accounts.find(row => row.allowanceBinding === bindingA)
  assert.equal(refused.email, null, 'completion of a write let an obsolete identity escape')
  assert.equal(refused.usageCode, 'ACCOUNT_USAGE_AUTH_CHANGED')
  assert.deepEqual((await fixture.cached()).accounts.map(row => row.allowanceBinding), [bindingB])
})

test('durable generation rejects an unwatched replacement after restart even when invalidation could not be written', async () => {
  const old = answer([reading(accountA, { email: 'previous@example.test' }), reading(accountB)])
  const original = harness(old, () => { throw new Error('listing must not probe a provider') })
  original.failWrites()
  await original.changed()
  assert.equal(original.disk().accounts.length, 2, 'the fixture did not preserve the failed-write disk cache')
  const restarted = harness(original.disk(), () => { throw new Error('restart must not probe a provider') })
  restarted.setGeneration(bindingA, generation('e'))
  const cached = await restarted.cached()
  assert.deepEqual(cached.accounts.map(row => row.allowanceBinding), [bindingB])
  assert.deepEqual(cached.orders.map(row => row.provider), ['codex'])
  const list = readAccountList({ ok: true, accounts: restarted.accounts(), usageCache: cached })
  const rows = mergeAccounts(list, list.cachedUsage)
  assert.equal(rows[0].email, null)
  assert.equal(rows[0].status, null)
  assert.equal(rows[1].measured, true)
})

test('durable generation never validates absent or unreadable sign-in metadata with old cache data', async () => {
  for (const kind of ['absent', 'unavailable']) {
    const fixture = harness(answer([reading(accountA), reading(accountB)]), async () => { throw new Error('no probe') })
    fixture.setGeneration(bindingA, { kind, token: null })
    const cached = await fixture.cached()
    assert.deepEqual(cached.accounts.map(row => row.allowanceBinding), [bindingB], kind)
  }
})

test('durable generation rejects a mid-probe token rewrite and accepts only the next explicit stable reading', async () => {
  const old = answer([reading(accountA), reading(accountB)])
  const held = deferred()
  let next = held.promise, probes = 0
  const fixture = harness(old, () => { probes++; return next })
  const pending = fixture.read()
  await new Promise(resolve => setImmediate(resolve))
  fixture.setGeneration(bindingA, generation('e'))
  held.resolve(old)
  const refused = (await pending).accounts.find(row => row.allowanceBinding === bindingA)
  assert.equal(refused.email, null)
  assert.equal(refused.usedPercent, null)
  assert.equal(refused.status, 'transient')
  assert.equal(refused.usageStatus, 'unavailable')
  assert.equal(refused.readAt, null, 'the discarded identity measurement acquired a new account timestamp')
  assert.equal(refused.usageCode, 'ACCOUNT_USAGE_AUTH_CHANGED')
  assert.match(refused.usageReason, /check.*again/i)
  assert.equal(probes, 1, 'the ambiguous check must not automatically retry')
  next = Promise.resolve(answer([reading(accountA, { email: 'current@example.test' }), reading(accountB)]))
  const stable = (await fixture.read()).accounts.find(row => row.allowanceBinding === bindingA)
  assert.equal(stable.email, 'current@example.test')
  assert.deepEqual(stable.authGeneration, generation('e'))
  assert.equal((await fixture.cached()).accounts.find(row => row.allowanceBinding === bindingA).email, 'current@example.test')
  assert.equal(probes, 2)
})

test('durable generation rechecks direct replies after a pending cache write without relying on a watch', async () => {
  const old = answer([reading(accountA), reading(accountB)])
  const fixture = harness(old, async () => old)
  const hold = fixture.holdNextWrite()
  const pending = fixture.read()
  while (!fixture.writeStarted()) await new Promise(resolve => setImmediate(resolve))
  fixture.setGeneration(bindingA, generation('e'))
  hold.resolve()
  const refused = (await pending).accounts.find(row => row.allowanceBinding === bindingA)
  assert.equal(refused.email, null)
  assert.equal(refused.usageCode, 'ACCOUNT_USAGE_AUTH_CHANGED')
  assert.deepEqual((await fixture.cached()).accounts.map(row => row.allowanceBinding), [bindingB])
})

test('durable generation keeps a native-store direct check usable without allowing its disk replay', async () => {
  const current = answer([reading(accountA), reading(accountB)])
  const fixture = harness(current, async () => current)
  fixture.setGeneration(bindingA, { kind: 'unsupported', token: null })
  const scope = { mcProviders: { accounts: async () => ({ ok: true, accounts: fixture.accounts() }), accountUsage: () => fixture.read() } }
  const usage = await loadUsage(scope)
  const list = readAccountList({ ok: true, accounts: fixture.accounts() })
  assert.equal(mergeAccounts(list, usage)[0].email, 'work@example.test', 'the explicit native provider reading was hidden')
  assert.deepEqual((await fixture.cached()).accounts.map(row => row.allowanceBinding), [bindingB])
  const replay = readAccountList({ ok: true, accounts: fixture.accounts(), usageCache: {
    ...current, accounts: current.accounts.map(row => row.allowanceBinding === bindingA
      ? { ...row, authGeneration: { kind: 'unsupported', token: null }, fresh: true } : row),
  } })
  assert.equal(mergeAccounts(replay, replay.cachedUsage)[0].email, null, 'disk JSON manufactured a fresh native check')
  const failed = await loadUsage({ mcProviders: { accounts: scope.mcProviders.accounts, accountUsage: async () => { throw new Error('fictional transport failure') } } }, { previousUsage: usage })
  assert.equal(mergeAccounts(list, failed)[0].email, null, 'a whole-request failure replayed an old direct-only reading')
})

test('durable generation preserves a rename but does not deliver an in-flight result to a removed or rebound home', async () => {
  const old = answer([reading(accountA), reading(accountB)])
  const held = deferred()
  let next = held.promise
  const fixture = harness(old, () => next)
  const pending = fixture.read()
  await new Promise(resolve => setImmediate(resolve))
  fixture.setAccounts([{ ...accountA, name: 'renamed' }, accountB])
  held.resolve(old)
  const renamed = (await pending).accounts.find(row => row.allowanceBinding === bindingA)
  assert.equal(renamed.name, 'renamed')
  assert.equal(renamed.email, 'work@example.test')
  assert.deepEqual(renamed.authGeneration, accountA.authGeneration)
  const removed = deferred()
  next = removed.promise
  const obsolete = fixture.read()
  await new Promise(resolve => setImmediate(resolve))
  fixture.setAccounts([accountB])
  removed.resolve(old)
  assert.deepEqual((await obsolete).accounts.map(row => row.allowanceBinding), [bindingB])
  assert.deepEqual((await fixture.cached()).accounts.map(row => row.allowanceBinding), [bindingB])
  fixture.setAccounts([accountA, accountB])
  const rebound = deferred()
  next = rebound.promise
  const oldHome = fixture.read()
  await new Promise(resolve => setImmediate(resolve))
  fixture.setAccounts([{ ...accountA, directory: '/fictional/rebound', allowanceBinding: 'f'.repeat(64), authGeneration: generation('f') }, accountB])
  rebound.resolve(old)
  assert.deepEqual((await oldHome).accounts.map(row => row.allowanceBinding), [bindingB], 'a reused row name received the old home result')
})

test('a closed first check crossing one unwatched refresh rechecks only that binding and preserves unrelated readings', async () => {
  const old = answer([closedReading(accountA, { email: 'discard@example.test' }), closedReading(accountB)])
  const held = deferred(), calls = []
  const fresh = closedReading(accountA, { email: 'fresh@example.test', readAt: '2031-01-01T00:01:00.000Z',
    windows: { hourly: { usedPercent: 17, remainingPercent: 83 }, weekly: null, weeklyWindows: [] } })
  const fixture = harness(old, options => {
    calls.push(structuredClone(options))
    return calls.length === 1 ? held.promise : Promise.resolve(answer([fresh]))
  })
  const one = fixture.read(), two = fixture.read()
  await new Promise(resolve => setImmediate(resolve))
  fixture.setGeneration(bindingA, generation('e')); held.resolve(old)
  const [result, coalesced] = await Promise.all([one, two])
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1].accountBindings, [bindingA])
  assert.deepEqual(coalesced, result)
  const updated = result.accounts.find(row => row.allowanceBinding === bindingA)
  assert.equal(updated.email, 'fresh@example.test', 'the old result must be discarded, not relabeled with a new generation')
  assert.equal(updated.windows.hourly.usedPercent, 17)
  assert.deepEqual(updated.authGeneration, generation('e'))
  assert.equal(updated.readAt, '2031-01-01T00:01:00.000Z')
  assert.equal(result.accounts.find(row => row.allowanceBinding === bindingB).email, 'school@example.test')
  assert.deepEqual(result.orders.map(row => row.provider), ['codex'], 'a subset retry cannot supply a full provider ranking')
  assert.equal((await fixture.cached()).accounts.find(row => row.allowanceBinding === bindingA).email, 'fresh@example.test')
  assert.equal(JSON.stringify(fixture.disk()).includes('probeLifecycle'), false, 'closure receipt must not become durable proof')
})

test('all changed bindings share one filtered retry batch with one fresh measurement per binding', async () => {
  const old = answer([closedReading(accountA), closedReading(accountB)])
  const held = deferred(), calls = []
  const fixture = harness(old, options => {
    calls.push(structuredClone(options))
    return calls.length === 1 ? held.promise : Promise.resolve(answer([closedReading(accountB), closedReading(accountA)]))
  })
  const pending = fixture.read(); await new Promise(resolve => setImmediate(resolve))
  fixture.setGeneration(bindingA, generation('e')); fixture.setGeneration(bindingB, generation('f')); held.resolve(old)
  const result = await pending
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1].accountBindings.sort(), [bindingA, bindingB])
  assert.equal(result.accounts.length, 2)
  assert.ok(result.accounts.every(row => row.status === 'healthy'))
  assert.deepEqual(result.orders, [])
})

test('missing, unproven, not-started, durable-looking receipts and an older Engine never authorize automatic refresh recovery', async () => {
  for (const mode of ['missing', 'unproven', 'not-started', 'enumerable', 'older-engine']) {
    let row = reading(accountA)
    if (mode !== 'missing') Object.defineProperty(row, 'probeLifecycle', {
      value: ['unproven', 'not-started'].includes(mode) ? mode : 'closed', enumerable: mode === 'enumerable'
    })
    const old = answer([row, reading(accountB)]), held = deferred(); let calls = 0
    const fixture = harness(old, () => { calls++; return held.promise }, { filterVersion: mode === 'older-engine' ? 0 : 1 })
    const pending = fixture.read(); await new Promise(resolve => setImmediate(resolve))
    fixture.setGeneration(bindingA, generation('e')); held.resolve(old)
    const result = await pending
    assert.equal(calls, 1, mode)
    assert.equal(result.accounts.find(row => row.allowanceBinding === bindingA).usageCode, 'ACCOUNT_USAGE_AUTH_CHANGED', mode)
  }
})

test('a second credential mutation or watched sign-in during recovery rejects the fresh result without a third probe', async () => {
  for (const mode of ['mutation', 'watched-sign-in']) {
    const old = answer([closedReading(accountA), closedReading(accountB)])
    const first = deferred(), second = deferred(); let calls = 0
    const fixture = harness(old, () => ++calls === 1 ? first.promise : second.promise)
    const pending = fixture.read(); await new Promise(resolve => setImmediate(resolve))
    fixture.setGeneration(bindingA, generation('e')); first.resolve(old)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(calls, 2, 'one fresh owned check must start')
    if (mode === 'mutation') fixture.setGeneration(bindingA, generation('f'))
    else await fixture.changed()
    second.resolve(answer([closedReading(accountA, { email: 'must-discard@example.test' })]))
    const result = await pending, refused = result.accounts.find(row => row.allowanceBinding === bindingA)
    assert.equal(calls, 2)
    assert.equal(refused.usageCode, 'ACCOUNT_USAGE_AUTH_CHANGED', mode)
    assert.equal(refused.email, null)
    assert.equal(refused.readAt, null)
    assert.equal(refused.windows.hourly, null)
    assert.equal(result.accounts.find(row => row.allowanceBinding === bindingB).email, 'school@example.test')
  }
})

test('removal or home rebinding during the recovery probe cannot receive that result', async () => {
  for (const mode of ['removed', 'rebound']) {
    const old = answer([closedReading(accountA), closedReading(accountB)])
    const first = deferred(), second = deferred(); let calls = 0
    const fixture = harness(old, () => ++calls === 1 ? first.promise : second.promise)
    const pending = fixture.read(); await new Promise(resolve => setImmediate(resolve))
    fixture.setGeneration(bindingA, generation('e')); first.resolve(old)
    await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 2)
    fixture.setAccounts(mode === 'removed' ? [accountB] : [{ ...accountA, directory: '/fictional/new-home',
      allowanceBinding: 'f'.repeat(64), authGeneration: generation('f') }, accountB])
    second.resolve(answer([closedReading(accountA)]))
    assert.deepEqual((await pending).accounts.map(row => row.allowanceBinding), [bindingB])
    assert.equal(calls, 2)
  }
})

test('a filtered recovery must return one matching, closed row; unrelated and duplicate rows cannot be substituted', async () => {
  for (const mode of ['unrelated', 'duplicate', 'no-receipt']) {
    const old = answer([closedReading(accountA), closedReading(accountB)])
    const first = deferred(); let calls = 0
    const rows = mode === 'unrelated' ? [closedReading(accountB, { email: 'wrong@example.test' })]
      : mode === 'duplicate' ? [closedReading(accountA), closedReading(accountA)] : [reading(accountA)]
    const fixture = harness(old, () => ++calls === 1 ? first.promise : Promise.resolve(answer(rows)))
    const pending = fixture.read(); await new Promise(resolve => setImmediate(resolve))
    fixture.setGeneration(bindingA, generation('e')); first.resolve(old)
    const result = await pending
    assert.equal(calls, 2)
    assert.equal(result.accounts.find(row => row.allowanceBinding === bindingA).email, null, mode)
    assert.equal(result.accounts.find(row => row.allowanceBinding === bindingB).email, 'school@example.test', mode)
  }
})

test('a generation change during the recovered cache write still rejects the direct reply', async () => {
  const old = answer([closedReading(accountA), closedReading(accountB)])
  const first = deferred(); let calls = 0
  const fixture = harness(old, () => ++calls === 1 ? first.promise : Promise.resolve(answer([closedReading(accountA)])))
  const hold = fixture.holdNextWrite(), pending = fixture.read()
  await new Promise(resolve => setImmediate(resolve))
  fixture.setGeneration(bindingA, generation('e')); first.resolve(old)
  while (!fixture.writeStarted()) await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 2)
  fixture.setGeneration(bindingA, generation('f')); hold.resolve()
  const refused = (await pending).accounts.find(row => row.allowanceBinding === bindingA)
  assert.equal(refused.email, null)
  assert.equal(refused.usageCode, 'ACCOUNT_USAGE_AUTH_CHANGED')
  assert.deepEqual((await fixture.cached()).accounts.map(row => row.allowanceBinding), [bindingB])
  assert.equal(calls, 2)
})

test('a failed filtered recovery preserves unrelated measurements and cannot authorize another retry', async () => {
  const old = answer([closedReading(accountA), closedReading(accountB)])
  const first = deferred(); let calls = 0
  const fixture = harness(old, () => ++calls === 1 ? first.promise : Promise.reject(new Error('fictional closed provider failure')))
  const pending = fixture.read(); await new Promise(resolve => setImmediate(resolve))
  fixture.setGeneration(bindingA, generation('e')); first.resolve(old)
  const result = await pending
  assert.equal(calls, 2)
  assert.equal(result.ok, true)
  assert.equal(result.accounts.find(row => row.allowanceBinding === bindingA).email, null)
  assert.equal(result.accounts.find(row => row.allowanceBinding === bindingB).email, 'school@example.test')
})
