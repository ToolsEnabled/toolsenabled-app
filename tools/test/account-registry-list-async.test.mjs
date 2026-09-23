/* listAsync() -- THE PER-ACCOUNT SIGN-IN PROBE, OFF ELECTRON'S MAIN THREAD.
 *
 * shell/main.cjs's mc-accounts:list handler used to call the fully
 * synchronous accountRegistry.list(), which lstatSync()s once per account to
 * answer "signed in?" for its row -- N blocking syscalls, serially, on the
 * one thread every window's IPC and the fleet tree's own timers share.
 * listAsync() answers the identical question by awaiting those N stats
 * concurrently instead.
 *
 * THIS SUITE IS NOT A PERFORMANCE TEST -- see tools/account-list-signin-
 * probe-bench.mjs for the measured numbers. It is a correctness suite for
 * one specific risk: that converting a probe to async quietly changes an
 * ANSWER. The risk named right above signedInAt() in shell/account-
 * registry.cjs is the one this file is built around: "merging 'could not
 * look' into 'not there' is the defect this codebase keeps re-finding."
 * listAsync() has its own inspectOwnedPathAsync() rather than routing
 * through the synchronous form, precisely so it could grow that exact bug
 * independently -- this suite is what would catch it if it did.
 *
 * Run: node --test tools/test/account-registry-list-async.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'

const require_ = createRequire(import.meta.url)
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const MODULE_FILE = path.join(REPO, 'shell', 'account-registry.cjs')

const { createAccountRegistryStore, accountsRegistryFile, signInFilePath, PROVIDERS } = require_(MODULE_FILE)

/* Same shape as account-registry.test.mjs's withScratchProfileAsync(), kept
   local rather than imported: every test file in this suite owns its
   fixtures. ASYNC, and awaits `run` before cleanup runs -- every test below
   passes an async callback that keeps using `home`/`file` deep into the
   function, and a synchronous try/finally here would rmSync() the scratch
   directory out from under a still-pending listAsync() call. */
async function withScratchProfile(run) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'mc-accounts-listasync-'))
  const userData = path.join(scratch, 'roaming', 'ToolsEnabled')
  const stateRoot = path.join(userData, 'capability')
  const localAppData = path.join(scratch, 'local')
  const servicesRoot = path.join(localAppData, 'ToolsEnabled')
  const stateFile = path.join(servicesRoot, 'multi-account-state.json')
  const home = path.join(scratch, 'home')
  mkdirSync(path.join(stateRoot, 'config'), { recursive: true })
  mkdirSync(servicesRoot, { recursive: true })
  mkdirSync(home, { recursive: true })

  const previousLocalAppData = process.env.LOCALAPPDATA
  const previousStateRoot = process.env.TOOLSENABLED_STATE_ROOT
  process.env.LOCALAPPDATA = localAppData
  process.env.TOOLSENABLED_STATE_ROOT = stateRoot
  try {
    const file = accountsRegistryFile()
    return await run({ scratch, home, servicesRoot, stateFile, file })
  } finally {
    if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = previousLocalAppData
    if (previousStateRoot === undefined) delete process.env.TOOLSENABLED_STATE_ROOT
    else process.env.TOOLSENABLED_STATE_ROOT = previousStateRoot
    rmSync(scratch, { recursive: true, force: true })
  }
}

function makeHome(home, leaf) {
  const directory = path.join(home, leaf)
  mkdirSync(directory, { recursive: true })
  return directory
}

test('opt-in usage generation follows the credential file, not labels, sibling writes or directory timestamps', () => withScratchProfile(async ({ home, file, stateFile, servicesRoot }) => {
  const directory = makeHome(home, '.claude-generation')
  const credential = path.join(directory, '.credentials.json')
  writeFileSync(credential, 'fictional metadata fixture only')
  let revision = 0n, leafStats = 0
  const guardedFs = { ...fs, openSync(target, ...args) {
    assert.notEqual(target, credential, 'a generation check opened credential bytes')
    return fs.openSync(target, ...args)
  } }
  const store = createAccountRegistryStore({ file, stateFile, servicesRoot, homedir: () => home, fsImpl: guardedFs,
    fspImpl: { async lstat(target, options) {
      const stat = await fsp.lstat(target, options)
      if (target !== credential) return stat
      leafStats++
      return Object.assign(Object.create(stat), { mtimeNs: stat.mtimeNs + revision })
    } },
  })
  store.add({ name: 'before rename', provider: 'claude', directory })
  const read = async () => (await store.listAsync({ includeAuthGeneration: true })).accounts[0]
  const first = await read()
  assert.equal(first.signedIn, 'yes')
  assert.deepEqual(Object.keys(first.authGeneration).sort(), ['kind', 'token'])
  assert.equal(first.authGeneration.kind, 'file')
  assert.match(first.authGeneration.token, /^[a-f0-9]{64}$/)
  store.rename({ name: 'before rename', provider: 'claude', newName: 'after rename' })
  writeFileSync(path.join(directory, 'unrelated-note.txt'), 'not a sign-in')
  const renamed = await read()
  assert.equal(renamed.name, 'after rename')
  assert.deepEqual(renamed.authGeneration, first.authGeneration, 'sibling writes or a label change invalidated the account')
  revision = 1n
  assert.notEqual((await read()).authGeneration.token, first.authGeneration.token, 'one nanosecond was rounded away')
  assert.equal(leafStats, 6, 'the leaf was not rechecked after ancestor validation')
}))

test('opt-in usage generation refuses missing, unreadable, linked, raced and malformed metadata without credential reads', () => withScratchProfile(async ({ home, file, stateFile, servicesRoot }) => {
  const directory = makeHome(home, '.claude-generation-unknown')
  const credential = path.join(directory, '.credentials.json')
  writeFileSync(credential, 'fictional metadata fixture only')
  const seed = createAccountRegistryStore({ file, stateFile, servicesRoot, homedir: () => home })
  seed.add({ name: 'work', provider: 'claude', directory })
  for (const mode of ['missing', 'unreadable', 'linked-parent', 'replaced-parent', 'malformed-leaf']) {
    let parentReads = 0, leafReads = 0
    const store = createAccountRegistryStore({ file, stateFile, servicesRoot, homedir: () => home,
      fsImpl: { ...fs, openSync(target, ...args) {
        assert.notEqual(target, credential, 'credential bytes were opened')
        return fs.openSync(target, ...args)
      } },
      fspImpl: { async lstat(target, options) {
        if (target === credential) {
          leafReads++
          if (mode === 'missing' || mode === 'unreadable') throw Object.assign(new Error('fictional metadata failure'), { code: mode === 'missing' ? 'ENOENT' : 'EACCES' })
        }
        const stat = await fsp.lstat(target, options)
        if (target === directory) {
          parentReads++
          if (mode === 'linked-parent') return Object.assign(Object.create(stat), { isSymbolicLink: () => true })
          if (mode === 'replaced-parent' && parentReads > 1) return Object.assign(Object.create(stat), { ino: stat.ino + 1n })
        }
        if (mode === 'malformed-leaf' && target === credential) return Object.assign(Object.create(stat), { mtimeNs: Number.MAX_SAFE_INTEGER + 1 })
        return stat
      } },
    })
    const row = (await store.listAsync({ includeAuthGeneration: true })).accounts[0]
    assert.deepEqual(row.authGeneration, { kind: mode === 'missing' ? 'absent' : 'unavailable', token: null }, mode)
    if (mode === 'linked-parent') assert.equal(leafReads, 0, 'the linked parent was followed to a credential leaf')
  }
}))

/* ------------------------------------------------------------------
   1. listAsync() answers exactly what list() answers.
   ------------------------------------------------------------------ */

test('listAsync() matches list() account for account: signed in, signed out, and an unresolvable home', () => withScratchProfile(async ({ home, file, stateFile, servicesRoot }) => {
  const store = createAccountRegistryStore({ file, stateFile, servicesRoot, homedir: () => home })

  makeHome(home, '.codex-signed-in')
  writeFileSync(path.join(home, '.codex-signed-in', 'auth.json'), '{"token":"not-a-real-token"}')
  store.add({ name: 'signed-in', provider: 'codex', directory: '.codex-signed-in' })

  makeHome(home, '.claude-signed-out')
  store.add({ name: 'signed-out', provider: 'claude', directory: '.claude-signed-out' })

  /* An empty credential file reads as 'no' (present, but nothing usable in
     it), the same as no file at all -- both are "not signed in" per the
     comment on signedInAt(). */
  makeHome(home, '.codex-empty')
  writeFileSync(path.join(home, '.codex-empty', 'auth.json'), '')
  store.add({ name: 'empty-credential', provider: 'codex', directory: '.codex-empty' })

  const sync = store.list()
  const asynced = await store.listAsync()

  assert.equal(sync.accounts.length, 3)
  assert.deepEqual(asynced, sync, 'listAsync() must answer the identical record list() does')
  assert.deepEqual(asynced.accounts.map(a => a.name), ['signed-in', 'signed-out', 'empty-credential'],
    'default priority is insertion order')
  assert.deepEqual(asynced.accounts.map(a => a.signedIn), ['yes', 'no', 'no'])
}))

test('listAsync() matches list() on an absent registry (first launch): empty, not damaged', () => withScratchProfile(async ({ home, file, stateFile, servicesRoot }) => {
  const store = createAccountRegistryStore({ file, stateFile, servicesRoot, homedir: () => home })
  const sync = store.list()
  assert.deepEqual(sync.accounts, [])
  assert.equal(sync.damaged, false)
  assert.deepEqual(await store.listAsync(), sync)
}))

test('listAsync() matches list() on a damaged (unparseable) registry file', () => withScratchProfile(async ({ home, file, stateFile, servicesRoot }) => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, '{ not json')
  const store = createAccountRegistryStore({ file, stateFile, servicesRoot, homedir: () => home })
  const sync = store.list()
  assert.equal(sync.damaged, true)
  assert.deepEqual(await store.listAsync(), sync)
}))

/* ------------------------------------------------------------------
   2. THE ONE DEFECT THIS FILE EXISTS TO CATCH: "could not look" folded
      into "not there".
   ------------------------------------------------------------------ */

test('a stat failure that is not ENOENT/ENOTDIR reads as unknown, never as signed-out, in the async probe', () => withScratchProfile(async ({ home, file, stateFile, servicesRoot }) => {
  makeHome(home, '.codex-blocked')
  const blockedPath = signInFilePath(path.resolve(path.join(home, '.codex-blocked')), PROVIDERS.codex)
  const realFsp = require_('node:fs/promises')

  const fspImpl = {
    ...realFsp,
    async lstat(target, options) {
      if (path.resolve(target) === path.resolve(blockedPath)) {
        throw Object.assign(new Error('access is denied'), { code: 'EPERM' })
      }
      return realFsp.lstat(target, options)
    },
  }
  const store = createAccountRegistryStore({ file, stateFile, servicesRoot, fspImpl, homedir: () => home })
  store.add({ name: 'blocked', provider: 'codex', directory: '.codex-blocked' })

  const answer = await store.listAsync()
  assert.equal(answer.accounts.length, 1)
  assert.equal(answer.accounts[0].signedIn, 'unknown',
    'EPERM is "could not look", and must not be reported as "no" (not signed in)')
}))

test('a genuinely absent credential file still reads as no in the async probe (ENOENT stays ENOENT)', () => withScratchProfile(async ({ home, file, stateFile, servicesRoot }) => {
  makeHome(home, '.codex-absent')
  const store = createAccountRegistryStore({ file, stateFile, servicesRoot, homedir: () => home })
  store.add({ name: 'absent', provider: 'codex', directory: '.codex-absent' })
  const answer = await store.listAsync()
  assert.equal(answer.accounts[0].signedIn, 'no')
}))

test('the async probe never opens or reads the credential file, only lstats it', () => withScratchProfile(async ({ home, file, stateFile, servicesRoot }) => {
  makeHome(home, '.codex-a')
  writeFileSync(path.join(home, '.codex-a', 'auth.json'), 'a real looking token, if this were real')
  makeHome(home, '.claude-b')
  writeFileSync(path.join(home, '.claude-b', '.credentials.json'), 'another one')

  const realFsp = require_('node:fs/promises')
  const calls = []
  const fspImpl = new Proxy(realFsp, {
    get(target, prop, receiver) {
      calls.push(prop)
      return Reflect.get(target, prop, receiver)
    },
  })
  const store = createAccountRegistryStore({ file, stateFile, servicesRoot, fspImpl, homedir: () => home })
  store.add({ name: 'a', provider: 'codex', directory: '.codex-a' })
  store.add({ name: 'b', provider: 'claude', directory: '.claude-b' })

  const answer = await store.listAsync()
  assert.deepEqual(answer.accounts.map(a => a.signedIn), ['yes', 'yes'])
  assert.deepEqual([...new Set(calls)], ['lstat'],
    `the async probe called fspImpl.${calls.find(c => c !== 'lstat')}, not just lstat: a screen that reports a sign-in must never read one`)
}))

/* ------------------------------------------------------------------
   3. THE REASON TO HAVE listAsync() AT ALL: it does not hold the thread,
      and it runs the N stats concurrently rather than one after another.
   ------------------------------------------------------------------ */

test('listAsync() yields the event loop while its stats are in flight, instead of holding it shut', () => withScratchProfile(async ({ home, file, stateFile, servicesRoot }) => {
  for (let index = 0; index < 4; index += 1) makeHome(home, `.account-${index}`)
  const realFsp = require_('node:fs/promises')
  const fspImpl = {
    ...realFsp,
    async lstat(target, options) {
      await new Promise(resolve => setTimeout(resolve, 40))
      return realFsp.lstat(target, options) // genuinely absent: rejects ENOENT, handled by inspectOwnedPathAsync
    },
  }
  const store = createAccountRegistryStore({ file, stateFile, servicesRoot, fspImpl, homedir: () => home })
  for (let index = 0; index < 4; index += 1) {
    store.add({ name: `account-${index}`, provider: index % 2 === 0 ? 'codex' : 'claude', directory: `.account-${index}` })
  }

  let heartbeats = 0
  const timer = setInterval(() => { heartbeats += 1 }, 5)
  try {
    await store.listAsync()
  } finally {
    clearInterval(timer)
  }
  assert.ok(heartbeats > 0,
    'a 5ms heartbeat never fired while a 40ms stat was pending: listAsync() held the thread instead of yielding it')
}))

test('listAsync() answers N accounts in about one stat, not N of them end to end', () => withScratchProfile(async ({ home, file, stateFile, servicesRoot }) => {
  const ACCOUNT_COUNT = 5
  const DELAY_MS = 30
  for (let index = 0; index < ACCOUNT_COUNT; index += 1) makeHome(home, `.account-${index}`)
  const realFsp = require_('node:fs/promises')
  const fspImpl = {
    ...realFsp,
    async lstat(target, options) {
      await new Promise(resolve => setTimeout(resolve, DELAY_MS))
      return realFsp.lstat(target, options) // genuinely absent: rejects ENOENT, handled by inspectOwnedPathAsync
    },
  }
  const store = createAccountRegistryStore({ file, stateFile, servicesRoot, fspImpl, homedir: () => home })
  for (let index = 0; index < ACCOUNT_COUNT; index += 1) {
    store.add({ name: `account-${index}`, provider: index % 2 === 0 ? 'codex' : 'claude', directory: `.account-${index}` })
  }

  const started = performance.now()
  const answer = await store.listAsync()
  const elapsed = performance.now() - started
  assert.equal(answer.accounts.length, ACCOUNT_COUNT)
  /* Serial would cost ACCOUNT_COUNT * DELAY_MS = 150ms; concurrent costs
     about one DELAY_MS plus scheduling slack. 3 delays of headroom is
     generous against CI/agent-load jitter and still nowhere near serial. */
  assert.ok(elapsed < DELAY_MS * 3,
    `listAsync() took ${elapsed.toFixed(1)}ms for ${ACCOUNT_COUNT} accounts at a ${DELAY_MS}ms stat each -- that is serial, not concurrent`)
}))
