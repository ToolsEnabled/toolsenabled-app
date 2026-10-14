import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { randomBytes } from 'node:crypto'
import { SOURCE_MANIFESTS } from '../lib/adapters/source-suite-manifests.mjs'
import { screenMarkup } from '../../src/account-markup.js'
import { readAccountState } from '../../src/account-state.js'

const modulePath = fileURLToPath(new URL('../../shell/product-account.cjs', import.meta.url))
const source = fs.readFileSync(modulePath, 'utf8')
const require = createRequire(modulePath)
const damaged = Buffer.from('{"version":1,"accounts":[')
const readable = Buffer.from(JSON.stringify({ version: 1, accounts: [] }))
const priorArchive = Buffer.from('synthetic earlier archive; must be retained')

// Load the unmodified production module with only its filesystem dependency
// wrapped. Hooks model a competing process at the actual filesystem boundary.
function service(directory, hooks = {}) {
  const injected = Object.create(fs)
  // Even an unexpected production error must retain this suite's fixtures.
  injected.rmSync = () => { throw new Error('Fixture deletion is not admitted') }
  Object.assign(injected, hooks)
  const module = { exports: {} }
  new Function('require', 'module', 'exports', source)(
    name => name === 'node:fs' ? injected : require(name), module, module.exports)
  return module.exports.createAccountStore({ directory })
}
function fixture(t, name) {
  const directory = fs.mkdtempSync(path.join(process.env.TOOLSENABLED_STATE_ROOT || os.tmpdir(), 't1520-set-aside-'))
  t.diagnostic(`Retained synthetic fixture: ${directory}`)
  const file = path.join(directory, name)
  fs.writeFileSync(file, damaged)
  const unrelated = path.join(directory, 'renderer-prefs.json')
  fs.writeFileSync(unrelated, 'synthetic settings retained')
  return { directory, file, unrelated }
}
function containsBytes(directory, expected) {
  return fs.readdirSync(directory, { withFileTypes: true }).some(entry => {
    const file = path.join(directory, entry.name)
    return entry.isDirectory() ? containsBytes(file, expected)
      : entry.isFile() && fs.readFileSync(file).equals(expected)
  })
}
function emptyFixture(t, label) {
  const directory = fs.mkdtempSync(path.join(process.env.TOOLSENABLED_STATE_ROOT || os.tmpdir(), `t1876-${label}-`))
  t.diagnostic(`Retained synthetic fixture: ${directory}`)
  fs.writeFileSync(path.join(directory, 'renderer-prefs.json'), 'synthetic settings retained')
  return directory
}
function storeBytes(accounts) {
  return Buffer.from(JSON.stringify({ version: 1, accounts }))
}
function containsBasename(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[^A-Za-z0-9_.-])${escaped}(?:$|[^A-Za-z0-9_.-])`).test(text)
}
function hostedAccountFrom(localAccount, { id = localAccount.id, subject = 'shared-subject', email = 'shared@example.com' } = {}) {
  const hosted = {
    ...localAccount,
    id,
    username: `hosted:${subject}`,
    displayName: email,
    identity: { provider: 'hosted', subject, email },
  }
  delete hosted.verifier
  return hosted
}
async function seededLocalAccount(t, label) {
  const directory = emptyFixture(t, label)
  const account = service(directory)
  const created = await account.createAccount({ username: 'seed-account', password: randomBytes(24).toString('hex') })
  assert.equal(created.ok, true, created.code)
  const file = path.join(directory, 'product-accounts.json')
  const store = JSON.parse(fs.readFileSync(file, 'utf8'))
  return { account, directory, file, localAccount: store.accounts[0] }
}

for (const name of ['product-accounts.json', 'hosted-product-accounts.json']) {
  test(`${name}: ordinary recovery keeps damaged bytes and unrelated settings`, t => {
    const { directory, file, unrelated } = fixture(t, name)
    const account = service(directory)
    assert.equal(account.availability().ok, false)
    const answer = account.setAsideDamagedStore()
    assert.equal(answer.ok, true)
    assert.equal(answer.keptAs.length, 1)
    assert.deepEqual(fs.readFileSync(path.join(directory, answer.keptAs[0])), damaged)
    assert.equal(fs.existsSync(file), false)
    assert.equal(account.availability().ok, true)
    assert.equal(fs.readFileSync(unrelated, 'utf8'), 'synthetic settings retained')
  })
  test(`${name}: a readable file stays in place`, t => {
    const { directory, file } = fixture(t, name)
    fs.writeFileSync(file, readable)
    const answer = service(directory).setAsideDamagedStore()
    assert.equal(answer.ok, false)
    assert.equal(answer.code, 'ACCOUNT_STORE_READABLE')
    assert.deepEqual(fs.readFileSync(file), readable)
  })
  for (const replacement of ['in-place writer', 'path replacement']) {
    test(`${name}: ${replacement} before move preserves reviewed and newer bytes`, t => {
      const { directory, file } = fixture(t, name)
      let fired = false
      const account = service(directory, {
        renameSync(from, to) {
          if (from === file && !fired) {
            fired = true
            if (replacement === 'in-place writer') fs.writeFileSync(file, readable)
            else {
              const next = path.join(directory, 'competing-next.json')
              fs.writeFileSync(next, readable)
              fs.renameSync(next, file)
            }
          }
          return fs.renameSync(from, to)
        },
      })
      const answer = account.setAsideDamagedStore()
      assert.equal(fired, true, 'the competing writer must reach the move boundary')
      assert.equal(answer.ok, false, 'a changed account file must refuse recovery')
      assert.deepEqual(fs.readFileSync(file), readable, 'the new readable store remains usable')
      assert.equal(containsBytes(directory, damaged), true, 'reviewed damaged bytes stay recoverable')
    })
  }
  test(`${name}: an archive appearing at creation is never overwritten`, t => {
    const { directory, file } = fixture(t, name)
    let collided = null
    function compete(target) {
      if (!collided && typeof target === 'string' && path.basename(target).includes('.damaged-')) {
        collided = target
        fs.writeFileSync(target, priorArchive, { flag: 'wx' })
      }
    }
    const account = service(directory, {
      renameSync(from, to) { if (from === file) compete(to); return fs.renameSync(from, to) },
      openSync(target, flags, ...rest) {
        if (typeof flags === 'string' && flags.includes('w')) compete(target)
        return fs.openSync(target, flags, ...rest)
      },
      writeFileSync(target, bytes, options) { compete(target); return fs.writeFileSync(target, bytes, options) },
      copyFileSync(from, to, ...rest) { if (from === file) compete(to); return fs.copyFileSync(from, to, ...rest) },
    })
    const answer = account.setAsideDamagedStore()
    assert.ok(collided, 'archive collision must occur before its filesystem creation')
    assert.equal(answer.ok, false)
    assert.deepEqual(fs.readFileSync(collided), priorArchive)
    assert.deepEqual(fs.readFileSync(file), damaged)
  })
}

for (const name of ['product-accounts.json', 'hosted-product-accounts.json']) {
  test(`${name}: source changed after backup stays at its active name`, t => {
    const { directory, file } = fixture(t, name)
    let copied = false, moves = 0
    const account = service(directory, {
      writeFileSync(target, bytes, ...options) {
        const result = fs.writeFileSync(target, bytes, ...options)
        if (!copied && typeof target === 'number') { copied = true; fs.writeFileSync(file, readable) }
        return result
      },
      renameSync(from, to) { if (from === file) moves++; return fs.renameSync(from, to) },
    })
    const answer = account.setAsideDamagedStore()
    assert.equal(copied, true)
    assert.equal(answer.ok, false)
    assert.equal(moves, 0)
    assert.deepEqual(fs.readFileSync(file), readable)
    assert.equal(containsBytes(directory, damaged), true)
  })
  test(`${name}: restoration never overwrites another live writer`, t => {
    const { directory, file } = fixture(t, name)
    const latest = Buffer.from('{"version":1,"accounts":[]}\n')
    let fired = false
    const account = service(directory, {
      renameSync(from, to) {
        if (from !== file) return fs.renameSync(from, to)
        fired = true
        fs.writeFileSync(file, readable)
        fs.renameSync(from, to)
        fs.writeFileSync(file, latest, { flag: 'wx' })
      },
    })
    const answer = account.setAsideDamagedStore()
    assert.equal(fired, true)
    assert.equal(answer.ok, false)
    assert.deepEqual(fs.readFileSync(file), latest)
    assert.equal(containsBytes(directory, damaged), true)
    assert.equal(containsBytes(directory, readable), true)
  })
}

test('a copy that cannot be verified prevents the source move', t => {
  const { directory, file } = fixture(t, 'product-accounts.json')
  let wrote = false, moved = false
  const answer = service(directory, {
    writeFileSync(target, bytes, ...options) {
      wrote = true
      return fs.writeFileSync(target, Buffer.from('synthetic incorrect copy'), ...options)
    },
    renameSync(from, to) { moved = true; return fs.renameSync(from, to) },
  }).setAsideDamagedStore()
  assert.equal(wrote, true)
  assert.equal(moved, false)
  assert.equal(answer.ok, false)
  assert.deepEqual(fs.readFileSync(file), damaged)
})

test('an archive write failure retains the active damaged file', t => {
  const { directory, file } = fixture(t, 'product-accounts.json')
  let moved = false
  const answer = service(directory, {
    writeFileSync() { throw Object.assign(new Error('synthetic full device'), { code: 'ENOSPC' }) },
    renameSync(from, to) { moved = true; return fs.renameSync(from, to) },
  }).setAsideDamagedStore()
  assert.equal(answer.ok, false)
  assert.equal(moved, false)
  assert.deepEqual(fs.readFileSync(file), damaged)
})

test('linked files are refused without disturbing either name', t => {
  const { directory, file } = fixture(t, 'product-accounts.json')
  const alias = path.join(directory, 'same-file.json')
  fs.linkSync(file, alias)
  const answer = service(directory).setAsideDamagedStore()
  assert.equal(answer.ok, false)
  assert.deepEqual(fs.readFileSync(file), damaged)
  assert.deepEqual(fs.readFileSync(alias), damaged)
})

test('a file beyond the 256 KiB recovery bound is left untouched', t => {
  const { directory, file } = fixture(t, 'product-accounts.json')
  const oversized = Buffer.alloc(256 * 1024 + 1, 120)
  fs.writeFileSync(file, oversized)
  const answer = service(directory).setAsideDamagedStore()
  assert.equal(answer.ok, false)
  assert.deepEqual(fs.readFileSync(file), oversized)
})

test('an unsupported schema is kept exactly and the other readable store is untouched', t => {
  const { directory, file } = fixture(t, 'product-accounts.json')
  const unsupported = Buffer.from('{"version":999,"accounts":[]}')
  const hosted = path.join(directory, 'hosted-product-accounts.json')
  fs.writeFileSync(file, unsupported)
  fs.writeFileSync(hosted, readable)
  const answer = service(directory).setAsideDamagedStore()
  assert.equal(answer.ok, true)
  assert.deepEqual(fs.readFileSync(path.join(directory, answer.keptAs[0])), unsupported)
  assert.deepEqual(fs.readFileSync(hosted), readable)
})

test('both damaged stores get independent preserved copies', t => {
  const { directory } = fixture(t, 'product-accounts.json')
  const hosted = path.join(directory, 'hosted-product-accounts.json')
  const hostedBytes = Buffer.from('synthetic torn hosted file')
  fs.writeFileSync(hosted, hostedBytes)
  const account = service(directory)
  const answer = account.setAsideDamagedStore()
  assert.equal(answer.ok, true)
  assert.equal(answer.keptAs.length, 2)
  assert.equal(containsBytes(directory, damaged), true)
  assert.equal(containsBytes(directory, hostedBytes), true)
  assert.equal(account.availability().ok, true)
})

test('local account creation works after recovery without changing the kept damaged bytes', async t => {
  const { directory } = fixture(t, 'product-accounts.json')
  const account = service(directory)
  const answer = account.setAsideDamagedStore()
  assert.equal(answer.ok, true)
  // Generated only in memory; no credential value appears in source or reports.
  const created = await account.createAccount({ username: 'synthetic-account', password: randomBytes(24).toString('hex') })
  assert.equal(created.ok, true, created.code)
  assert.equal(account.availability().accountCount, 1)
  assert.deepEqual(fs.readFileSync(path.join(directory, answer.keptAs[0])), damaged)
})

test('valid local and hosted stores with the same account id are both set aside without choosing a winner', async t => {
  const { account, directory, file, localAccount } = await seededLocalAccount(t, 'duplicate-id')
  const hostedFile = path.join(directory, 'hosted-product-accounts.json')
  const localBytes = fs.readFileSync(file)
  const hostedBytes = storeBytes([hostedAccountFrom(localAccount)])
  fs.writeFileSync(hostedFile, hostedBytes)

  const state = account.availability()
  assert.equal(state.ok, false)

  const answer = account.setAsideDamagedStore()
  assert.equal(answer.ok, true)
  assert.equal(answer.keptAs.length, 2)
  assert.equal(fs.existsSync(file), false)
  assert.equal(fs.existsSync(hostedFile), false)
  assert.equal(containsBytes(directory, localBytes), true, 'the local conflict store remains byte-exact')
  assert.equal(containsBytes(directory, hostedBytes), true, 'the hosted conflict store remains byte-exact')

  const created = await account.createAccount({ username: 'fresh-after-conflict', password: randomBytes(24).toString('hex') })
  assert.equal(created.ok, true, created.code)
  assert.notEqual(created.account.id, localAccount.id, 'no conflicting account was selected as the winner')
  const active = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(active.accounts.some(entry => entry.id === localAccount.id), false)
  assert.equal(account.availability().ok, true)
})

test('aggregate duplicate-id availability and rendered feedback name both conflicting stores', async t => {
  const { account, directory, localAccount } = await seededLocalAccount(t, 'duplicate-id-feedback')
  const hostedFile = path.join(directory, 'hosted-product-accounts.json')
  fs.writeFileSync(hostedFile, storeBytes([hostedAccountFrom(localAccount, {
    subject: 'feedback-hosted',
    email: 'feedback@example.com',
  })]))

  const state = account.availability()
  assert.equal(state.ok, false)
  assert.equal(containsBasename(state.reason, 'product-accounts.json'), true)
  assert.equal(containsBasename(state.reason, 'hosted-product-accounts.json'), true)
  const rendered = screenMarkup({ state: readAccountState(state, null) })
  assert.equal(containsBasename(rendered, 'product-accounts.json'), true)
  assert.equal(containsBasename(rendered, 'hosted-product-accounts.json'), true)
  assert.match(rendered, /data-account-set-aside/)
})

test('a hosted writer after the local conflict move keeps both reviewed stores and the writer bytes', async t => {
  const { account, directory, file, localAccount } = await seededLocalAccount(t, 'duplicate-id-writer-race')
  const hostedFile = path.join(directory, 'hosted-product-accounts.json')
  const localBytes = fs.readFileSync(file)
  const hostedBytes = storeBytes([hostedAccountFrom(localAccount, { subject: 'original-hosted', email: 'original@example.com' })])
  const writerBytes = storeBytes([hostedAccountFrom(localAccount, {
    id: 'c'.repeat(32),
    subject: 'writer-hosted',
    email: 'writer@example.com',
  })])
  fs.writeFileSync(hostedFile, hostedBytes)
  let localMoveCompleted = false
  const raced = service(directory, {
    renameSync(from, to) {
      const result = fs.renameSync(from, to)
      if (from === file && !localMoveCompleted) {
        localMoveCompleted = true
        // The competing writer lands only after the local archive/move has
        // begun. It must not be mistaken for the reviewed hosted bytes.
        fs.writeFileSync(hostedFile, writerBytes)
      }
      return result
    },
  })

  const answer = raced.setAsideDamagedStore()
  assert.equal(localMoveCompleted, true, 'the writer must race after the local conflict move')
  assert.equal(containsBytes(directory, localBytes), true, 'the reviewed local store remains byte-exact')
  assert.equal(containsBytes(directory, hostedBytes), true, 'the reviewed hosted store remains byte-exact')
  assert.equal(containsBytes(directory, writerBytes), true, 'the competing hosted writer bytes remain byte-exact')
  assert.equal(answer.ok === false || raced.availability().ok, true,
    'recovery must refuse or leave a readable non-conflicting active state')
})

test('a second conflict-copy sync failure leaves both active stores untouched', async t => {
  const { directory, file, localAccount } = await seededLocalAccount(t, 'duplicate-id-second-copy-failure')
  const hostedFile = path.join(directory, 'hosted-product-accounts.json')
  const localBytes = fs.readFileSync(file)
  const hostedBytes = storeBytes([hostedAccountFrom(localAccount, {
    subject: 'second-copy-hosted',
    email: 'second-copy@example.com',
  })])
  fs.writeFileSync(hostedFile, hostedBytes)
  let syncCalls = 0
  let activeRenames = 0
  const account = service(directory, {
    fsyncSync(fd) {
      syncCalls++
      if (syncCalls === 2) throw new Error('Synthetic second recovery-copy sync failure')
      return fs.fsyncSync(fd)
    },
    renameSync(from, to) {
      if (from === file || from === hostedFile) activeRenames++
      return fs.renameSync(from, to)
    },
  })

  const answer = account.setAsideDamagedStore()
  assert.equal(syncCalls, 2, 'the second required conflict copy must reach its sync boundary')
  assert.equal(activeRenames, 0, 'no active conflict source may move before both copies are durable')
  assert.equal(answer.ok, false, 'a failed required copy must refuse recovery')
  assert.deepEqual(fs.readFileSync(file), localBytes, 'the local live store remains byte-exact')
  assert.deepEqual(fs.readFileSync(hostedFile), hostedBytes, 'the hosted live store remains byte-exact')
})

for (const name of ['product-accounts.json', 'hosted-product-accounts.json']) {
  test(`${name}: an invalid duplicate-username file is refused while its healthy sibling stays intact`, async t => {
    const { account, directory, file, localAccount } = await seededLocalAccount(t, `duplicate-username-${name.replaceAll('.', '-')}`)
    const hostedFile = path.join(directory, 'hosted-product-accounts.json')
    const target = name === 'product-accounts.json' ? file : hostedFile
    const sibling = name === 'product-accounts.json' ? hostedFile : file
    const duplicate = name === 'product-accounts.json'
      ? { ...localAccount, id: 'b'.repeat(32) }
      : hostedAccountFrom(localAccount, { id: 'b'.repeat(32), subject: 'duplicate-subject' })
    const duplicateBytes = name === 'product-accounts.json'
      ? storeBytes([localAccount, duplicate])
      : storeBytes([hostedAccountFrom(localAccount, { subject: 'duplicate-subject' }), duplicate])
    const healthyBytes = name === 'product-accounts.json'
      ? storeBytes([hostedAccountFrom(localAccount, {
        id: 'd'.repeat(32),
        subject: 'healthy-sibling',
        email: 'healthy@example.com',
      })])
      : fs.readFileSync(sibling)
    fs.writeFileSync(target, duplicateBytes)
    fs.writeFileSync(sibling, healthyBytes)

    const state = account.availability()
    assert.equal(state.ok, false)
    const answer = account.setAsideDamagedStore()
    assert.equal(answer.ok, true)
    assert.equal(answer.keptAs.length, 1)
    assert.equal(fs.readFileSync(sibling).equals(healthyBytes), true)
    assert.equal(containsBytes(directory, duplicateBytes), true)
    assert.equal(account.availability().ok, true)
    const created = await account.createAccount({ username: `fresh-${name === 'product-accounts.json' ? 'local' : 'hosted'}`, password: randomBytes(24).toString('hex') })
    assert.equal(created.ok, true, created.code)
  })
}

for (const name of ['product-accounts.json', 'hosted-product-accounts.json']) {
  test(`${name}: availability and rendered account feedback identify the damaged basename`, async t => {
    const { directory, localAccount } = await seededLocalAccount(t, `basename-${name.replaceAll('.', '-')}`)
    const file = path.join(directory, name)
    const sibling = path.join(directory, name === 'product-accounts.json' ? 'hosted-product-accounts.json' : 'product-accounts.json')
    fs.writeFileSync(file, damaged)
    if (name === 'product-accounts.json') {
      fs.writeFileSync(sibling, storeBytes([hostedAccountFrom(localAccount, {
        id: 'e'.repeat(32),
        subject: 'basename-sibling',
        email: 'basename@example.com',
      })]))
    }
    const state = service(directory).availability()
    assert.equal(state.ok, false)
    assert.equal(containsBasename(state.reason, name), true, `service feedback names ${name}`)
    const rendered = screenMarkup({ state: readAccountState(state, null) })
    assert.equal(containsBasename(rendered, name), true, `rendered feedback names ${name}`)
    assert.match(rendered, /data-account-damaged/)
    assert.match(rendered, /data-account-set-aside/)
  })
}

test('source inventory requires the account recovery behavior suite', () => {
  const rows = SOURCE_MANIFESTS.app.inventory.filter(row => row.file === 'tools/test/product-account-set-aside.test.mjs')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].reason, null)
})
