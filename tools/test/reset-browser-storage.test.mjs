import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import browserStorage from '../../shell/reset-browser-storage.cjs'

const { captureResetBrowserStorage, INSPECTION_TIMEOUT_MS } = browserStorage
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-reset-'))
  const userData = path.join(base, 'owned-data')
  fs.mkdirSync(userData)
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const calls = []
  const session = { storagePath: userData, clearStorageData: async options => { calls.push(options) } }
  const plan = { ok: true, roots: [{ kind: 'user-data', directory: userData, guarded: true, present: true }] }
  const capture = options => captureResetBrowserStorage({ session, userData, plan, ...options })
  return { base, userData, session, plan, calls, capture }
}

test('owned Session clear requests all localStorage origins and returns only after actual completion', async t => {
  const f = fixture(t), waiting = deferred()
  f.session.clearStorageData = options => { f.calls.push(options); return waiting.promise }
  const captured = f.capture()
  assert.deepEqual(captured.snapshot(), { attempted: false, cleared: false })
  const clearing = captured.clear()
  assert.deepEqual(f.calls, [{ storages: ['localstorage'] }])
  assert.deepEqual(captured.snapshot(), { attempted: true, cleared: false })
  let completed = false
  clearing.then(() => { completed = true })
  await Promise.resolve()
  assert.equal(completed, false)
  waiting.resolve()
  assert.deepEqual(await clearing, { attempted: true, cleared: true })
  assert.equal(captured.clear(), clearing, 'repeat must retain the original operation')
  assert.equal(f.calls.length, 1)
  assert.equal(captured.revalidate({ session: f.session, userData: f.userData }), true)
  assert.equal(captured.validatePlan(f.plan), true)
})

for (const problem of ['null-session', 'null-path', 'foreign-path', 'throwing-path', 'unguarded-plan', 'missing-plan-root']) {
  test(`${problem} refuses before any filesystem lookup or native clear`, t => {
    const f = fixture(t)
    let inspected = 0
    const options = { fs: { lstatSync() { inspected += 1; assert.fail('unowned filesystem path was inspected') } } }
    if (problem === 'null-session') options.session = null
    if (problem === 'null-path') f.session.storagePath = null
    if (problem === 'foreign-path') f.session.storagePath = path.join(f.base, 'foreign-data')
    if (problem === 'throwing-path') Object.defineProperty(f.session, 'storagePath', { get() { throw new Error('storage path unavailable') } })
    if (problem === 'unguarded-plan') f.plan.roots[0].guarded = false
    if (problem === 'missing-plan-root') f.plan.roots = []
    assert.throws(() => f.capture(options))
    assert.equal(inspected, 0)
    assert.equal(f.calls.length, 0)
  })
}

for (const source of ['user-data', 'session', 'windows-user-data']) test(`${source} dot-component alias is rejected before normalizing away a traversed ancestor`, t => {
  const f = fixture(t)
  const options = { fs: { lstatSync() { assert.fail('a lexical alias must be refused before IO') } } }
  if (source === 'user-data') {
    options.userData = `${f.userData}/linked/..`
    options.session = { ...f.session, storagePath: options.userData }
  }
  if (source === 'session') f.session.storagePath = `${f.userData}/ignored/..`
  if (source === 'windows-user-data') {
    options.path = path.win32
    options.platform = 'win32'
    options.userData = 'C:\\ResetFixture\\linked\\..\\owned-data'
    options.session = { ...f.session, storagePath: options.userData }
    options.guard = directory => ({ ok: true, resolved: path.win32.resolve(directory) })
    options.plan = { ok: true, roots: [{ kind: 'user-data', directory: path.win32.resolve(options.userData), guarded: true, present: true }] }
    options.checkWindowsAttributes = () => assert.fail('a lexical alias must be refused before native IO')
  }
  assert.throws(() => f.capture(options), { code: source === 'session' ? 'RESET_BROWSER_SESSION_UNCONFIRMED' : 'RESET_BROWSER_ROOT_UNCONFIRMED' })
  assert.equal(f.calls.length, 0)
})

test('a linked ancestor is rejected before the child or its target is inspected', t => {
  const f = fixture(t)
  const target = path.join(f.base, 'private-target')
  fs.mkdirSync(target)
  fs.mkdirSync(path.join(target, 'data'))
  const link = path.join(f.base, 'linked-parent')
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  const userData = path.join(link, 'data')
  const session = { storagePath: userData, clearStorageData: () => assert.fail('linked Session must never clear') }
  const seen = []
  assert.throws(() => captureResetBrowserStorage({ userData, session,
    plan: { ok: true, roots: [{ kind: 'user-data', directory: userData, guarded: true, present: true }] },
    fs: { ...fs, lstatSync: (...args) => { seen.push(args[0]); return fs.lstatSync(...args) } },
  }))
  assert.equal(seen.includes(userData), false)
  assert.equal(seen.includes(target), false)
})

test('Windows reparse attributes are checked from root to leaf before Node filesystem traversal', () => {
  const userData = 'C:\\ResetFixture\\owned-data'
  let queried = 0
  assert.throws(() => captureResetBrowserStorage({ userData, platform: 'win32', path: path.win32,
    guard: directory => ({ ok: true, resolved: directory }),
    session: { storagePath: userData, clearStorageData: () => assert.fail('reparse storage must not clear') },
    plan: { ok: true, roots: [{ kind: 'user-data', directory: userData, guarded: true, present: true }] },
    fs: { lstatSync() { assert.fail('Node must not descend after the Windows reparse refusal') } },
    checkWindowsAttributes(chain) {
      queried += 1
      assert.deepEqual(chain, ['C:\\', 'C:\\ResetFixture', userData])
      throw new Error('fixture non-symbolic-link reparse tag')
    },
  }), /reparse tag/)
  assert.equal(queried, 1)
})

test('a linked Session root is refused before the actual preliminary inventory callback', t => {
  const f = fixture(t)
  const link = path.join(f.base, 'linked-storage')
  fs.symlinkSync(f.userData, link, process.platform === 'win32' ? 'junction' : 'dir')
  let measurements = 0
  assert.throws(() => captureResetBrowserStorage({ userData: link,
    session: { storagePath: link, clearStorageData: () => assert.fail('linked Session must not clear') },
    measurePlan() { measurements += 1; assert.fail('a linked root must not reach recursive inventory') },
  }))
  assert.equal(measurements, 0)
})

test('a supplied plan cannot bypass the lexical root guard', t => {
  const f = fixture(t)
  let guarded = 0
  assert.throws(() => f.capture({
    guard() { guarded += 1; return { ok: false } },
    fs: { lstatSync() { assert.fail('a refused root must not be inspected') } },
  }), { code: 'RESET_BROWSER_ROOT_UNCONFIRMED' })
  assert.equal(guarded, 1)
  assert.equal(f.calls.length, 0)
})

for (const link of ['store-directory', 'descendant-directory', 'descendant-file', 'hardlink']) {
  test(`browser storage ${link} is refused before inventory or native mutation`, t => {
    const f = fixture(t)
    const target = path.join(f.base, 'private-link-target')
    fs.mkdirSync(target)
    const outside = path.join(target, 'sentinel.txt')
    fs.writeFileSync(outside, 'private target must stay untouched')
    const local = path.join(f.userData, 'Local Storage')
    if (link === 'store-directory') fs.symlinkSync(target, local, process.platform === 'win32' ? 'junction' : 'dir')
    else {
      const leveldb = path.join(local, 'leveldb')
      fs.mkdirSync(leveldb, { recursive: true })
      if (link === 'descendant-directory') fs.symlinkSync(target, path.join(leveldb, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
      if (link === 'descendant-file') fs.symlinkSync(outside, path.join(leveldb, 'linked.txt'), 'file')
      if (link === 'hardlink') fs.linkSync(outside, path.join(leveldb, 'shared.txt'))
    }
    const enumerated = []
    let measurements = 0
    assert.throws(() => f.capture({
      measurePlan() { measurements += 1; return f.plan },
      fs: { ...fs, readdirSync: (...args) => { enumerated.push(args[0]); return fs.readdirSync(...args) } },
    }))
    assert.equal(measurements, 0)
    assert.equal(f.calls.length, 0)
    assert.equal(enumerated.includes(target), false)
    assert.equal(enumerated.some(directory => directory.endsWith(`${path.sep}linked`)), false)
    assert.equal(fs.readFileSync(outside, 'utf8'), 'private target must stay untouched')
  })
}

test('Windows rejects a non-symbolic-link child reparse tag before inspecting or descending into it', () => {
  const userData = 'C:\\ResetFixture\\owned-data'
  const local = path.win32.join(userData, 'Local Storage')
  const linkedChild = path.win32.join(local, 'junction')
  const seen = [], checked = []
  const directoryStat = { isSymbolicLink: () => false, isDirectory: () => true, dev: 1n, ino: 2n }
  assert.throws(() => captureResetBrowserStorage({ userData, platform: 'win32', path: path.win32,
    guard: directory => ({ ok: true, resolved: directory }),
    session: { storagePath: userData, clearStorageData: () => assert.fail('reparse storage must not clear') },
    plan: { ok: true, roots: [{ kind: 'user-data', directory: userData, guarded: true, present: true }] },
    fs: {
      lstatSync(directory) { seen.push(directory); return directoryStat },
      realpathSync: directory => directory,
      readdirSync(directory) {
        assert.equal(directory, local)
        assert.deepEqual(checked.at(-1), [local], 'check the actual parent before listing children')
        return ['junction']
      },
    },
    checkWindowsAttributes(chain, options) {
      checked.push(chain)
      if (chain.includes(linkedChild)) {
        assert.equal(options.requireDirectory, false)
        throw new Error('fixture child reparse tag')
      }
    },
  }), /child reparse tag/)
  assert.deepEqual(checked[0], ['C:\\', 'C:\\ResetFixture', userData])
  assert.equal(seen.includes(linkedChild), false)
})

test('an unreadable browser subtree is an ownership refusal, not an empty store', t => {
  const f = fixture(t), local = path.join(f.userData, 'Local Storage')
  fs.mkdirSync(local)
  let measurements = 0
  assert.throws(() => f.capture({
    measurePlan() { measurements += 1; return f.plan },
    fs: { ...fs, readdirSync(directory) {
      assert.equal(directory, local)
      throw Object.assign(new Error('fixture unreadable browser directory'), { code: 'EACCES' })
    } },
  }), { code: 'EACCES' })
  assert.equal(measurements, 0)
  assert.equal(f.calls.length, 0)
})

test('the total inspection deadline refuses before a slow directory listing can lead to child traversal', t => {
  const f = fixture(t), local = path.join(f.userData, 'Local Storage')
  fs.mkdirSync(local)
  const child = path.join(local, 'entry')
  fs.writeFileSync(child, 'fixture data')
  let clock = 0, measured = false
  assert.throws(() => f.capture({
    now: () => clock,
    measurePlan() { measured = true; return f.plan },
    fs: { ...fs,
      lstatSync(entry, options) {
        assert.notEqual(entry, child, 'do not inspect a child after the total budget expired')
        return fs.lstatSync(entry, options)
      },
      readdirSync(directory) { clock = INSPECTION_TIMEOUT_MS; return fs.readdirSync(directory) },
    },
  }), { code: 'RESET_BROWSER_INSPECTION_TIMEOUT' })
  assert.equal(measured, false)
  assert.equal(f.calls.length, 0)
})

test('Windows native attribute calls consume one shared inspection budget', () => {
  const userData = 'C:\\ResetFixture\\owned-data'
  let clock = 0, calls = 0
  assert.throws(() => captureResetBrowserStorage({ userData, platform: 'win32', path: path.win32,
    now: () => clock,
    guard: directory => ({ ok: true, resolved: directory }),
    session: { storagePath: userData, clearStorageData: () => assert.fail('expired inspection must not clear') },
    plan: { ok: true, roots: [{ kind: 'user-data', directory: userData, guarded: true, present: true }] },
    fs: {
      lstatSync: () => ({ isSymbolicLink: () => false, isDirectory: () => true, dev: 1n, ino: 2n }),
      realpathSync: directory => directory,
      readdirSync() { assert.fail('do not enumerate after the total native inspection deadline') },
    },
    checkWindowsAttributes(chain, options) {
      calls += 1
      assert.equal(options.timeoutMs, calls === 1 ? INSPECTION_TIMEOUT_MS : 1000)
      clock = calls === 1 ? INSPECTION_TIMEOUT_MS - 1000 : INSPECTION_TIMEOUT_MS
    },
  }), { code: 'RESET_BROWSER_INSPECTION_TIMEOUT' })
  assert.equal(calls, 2)
})

for (const timing of ['during-measurement', 'after-clear']) test(`a new browser hardlink ${timing} invalidates cleanup ownership`, async t => {
  const f = fixture(t), local = path.join(f.userData, 'Local Storage')
  fs.mkdirSync(local)
  const outside = path.join(f.base, 'retained-file')
  fs.writeFileSync(outside, 'untouched')
  const addLink = () => fs.linkSync(outside, path.join(local, 'shared-file'))
  const captured = f.capture(timing === 'during-measurement' ? { measurePlan() { addLink(); return f.plan } } : {})
  if (timing === 'during-measurement') {
    assert.throws(() => captured.clear(), { code: 'RESET_BROWSER_ROOT_UNCONFIRMED' })
    assert.deepEqual(captured.snapshot(), { attempted: false, cleared: false })
    assert.equal(f.calls.length, 0)
  } else {
    await captured.clear()
    addLink()
    assert.throws(() => captured.revalidate({ session: f.session, userData: f.userData }), { code: 'RESET_BROWSER_ROOT_UNCONFIRMED' })
    assert.deepEqual(captured.snapshot(), { attempted: true, cleared: true })
  }
  assert.equal(fs.readFileSync(outside, 'utf8'), 'untouched')
})

test('legitimate native browser-file replacement and removal preserves the captured user-data authority', async t => {
  const f = fixture(t), local = path.join(f.userData, 'Local Storage')
  fs.mkdirSync(path.join(local, 'leveldb'), { recursive: true })
  fs.writeFileSync(path.join(local, 'leveldb', 'old.log'), 'old browser state')
  const captured = f.capture()
  f.session.clearStorageData = async options => {
    f.calls.push(options)
    fs.rmSync(local, { recursive: true })
    fs.mkdirSync(path.join(local, 'leveldb'), { recursive: true })
    fs.writeFileSync(path.join(local, 'leveldb', 'new.log'), 'empty browser metadata')
  }
  await captured.clear()
  assert.equal(captured.revalidate({ session: f.session, userData: f.userData }), true)
  fs.rmSync(local, { recursive: true })
  assert.equal(captured.revalidate({ session: f.session, userData: f.userData }), true)
  assert.deepEqual(f.calls, [{ storages: ['localstorage'] }])
})

test('a directory replaced during preliminary inventory cannot reach browser deletion', t => {
  const f = fixture(t)
  const captured = f.capture({ measurePlan() {
    fs.renameSync(f.userData, path.join(f.base, 'old-directory'))
    fs.mkdirSync(f.userData)
    return f.plan
  } })
  assert.throws(() => captured.clear(), { code: 'RESET_BROWSER_ROOT_CHANGED' })
  assert.deepEqual(captured.snapshot(), { attempted: false, cleared: false })
  assert.equal(f.calls.length, 0)
})

test('replacement directory identity is refused even when storagePath and realpath still match', t => {
  const f = fixture(t), captured = f.capture()
  fs.renameSync(f.userData, path.join(f.base, 'retained-original'))
  fs.mkdirSync(f.userData)
  assert.throws(() => captured.revalidate({ session: f.session, userData: f.userData }), { code: 'RESET_BROWSER_ROOT_CHANGED' })
  assert.throws(() => captured.clear(), { code: 'RESET_BROWSER_ROOT_CHANGED' })
  assert.deepEqual(captured.snapshot(), { attempted: false, cleared: false })
  assert.equal(f.calls.length, 0)
})

test('copied Session and changed final root set cannot reuse captured ownership', t => {
  const f = fixture(t), captured = f.capture()
  assert.throws(() => captured.revalidate({ session: { ...f.session }, userData: f.userData }), { code: 'RESET_BROWSER_SESSION_CHANGED' })
  const changed = { ...f.plan, roots: [...f.plan.roots, { kind: 'installation', directory: path.join(f.base, 'late-root'), guarded: true, present: true }] }
  assert.throws(() => captured.validatePlan(changed), { code: 'RESET_BROWSER_PLAN_CHANGED' })
  assert.equal(f.calls.length, 0)
})

for (const failure of ['throw', 'reject', 'missing-promise']) test(`a native clear ${failure} is attempted and remains a refusal on repeat`, async t => {
  const f = fixture(t)
  f.session.clearStorageData = () => {
    f.calls.push('called')
    if (failure === 'throw') throw new Error('native throw')
    if (failure === 'reject') return Promise.reject(new Error('native rejection'))
  }
  const captured = f.capture(), pending = captured.clear()
  await assert.rejects(pending, { code: 'RESET_BROWSER_CLEAR_FAILED' })
  assert.equal(captured.snapshot().attempted, true)
  assert.equal(captured.snapshot().cleared, false)
  assert.equal(captured.clear(), pending)
  await assert.rejects(captured.clear(), { code: 'RESET_BROWSER_CLEAR_FAILED' })
  assert.equal(f.calls.length, 1)
})

for (const late of ['resolve', 'reject']) test(`deadline refusal retains the pending operation and ignores its later ${late}`, async t => {
  const f = fixture(t), gate = deferred()
  f.session.clearStorageData = () => { f.calls.push('called'); return gate.promise }
  const captured = f.capture({ timeoutMs: 15 }), pending = captured.clear()
  await assert.rejects(pending, { code: 'RESET_BROWSER_CLEAR_TIMEOUT' })
  const refused = captured.snapshot()
  gate[late](late === 'reject' ? new Error('late failure') : undefined)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(captured.snapshot(), refused)
  assert.equal(captured.clear(), pending)
  assert.equal(f.calls.length, 1)
})

test('completion delivered after the monotonic deadline is refused before its timer runs', async t => {
  const f = fixture(t), gate = deferred()
  let clock = 0
  f.session.clearStorageData = () => gate.promise
  const captured = f.capture({ timeoutMs: 50, now: () => clock }), pending = captured.clear()
  clock = 51
  gate.resolve()
  await assert.rejects(pending, { code: 'RESET_BROWSER_CLEAR_TIMEOUT' })
  assert.equal(captured.snapshot().cleared, false)
})
