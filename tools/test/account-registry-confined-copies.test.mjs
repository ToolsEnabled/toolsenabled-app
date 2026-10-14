/* REMOVING AN ACCOUNT REACHES THE CONFINED COPIES OF ITS SIGN-IN.
 *
 * The engine hard-links an account's sign-in into every confined agent home it
 * prepares for that account (agent-session-confinement linkCredential), under
 * <services root>/agent-home, and nothing reaps those homes. So when the
 * accounts screen removed an app-made account and destroyed its sign-in, the
 * same file stayed alive -- a working sign-in -- under every one of those
 * homes. The store now hands the file's identity, captured BEFORE the removal,
 * to the engine's own sweep, which main.cjs binds to the fenced services root.
 *
 * The sweep itself is the engine's and is proved there
 * (tests/credential-fan-out-wiring.test.js). This file proves the store's half:
 * when the identity is taken, what is handed over, what the receipt says, and
 * that nothing changes for a removal with no revoker or no sign-in. Like every
 * removal test here it never deletes a fixture (R1225): the file layer records
 * the removal instead of performing it.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalRootForTests } from '../canonical-root.mjs'

const require_ = createRequire(import.meta.url)
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const { createAccountRegistryStore, PROVIDERS } = require_(path.join(REPO, 'shell', 'account-registry.cjs'))
const MAIN_FILE = path.join(REPO, 'shell', 'main.cjs')

/* Retained scratch fixture: R1225 forbids destructive test cleanup. */
function scratch() {
  const root = mkdtempSync(path.join(tmpdir(), 'account-confined-copies-'))
  const home = path.join(root, 'home')
  const services = path.join(root, 'services')
  mkdirSync(home, { recursive: true })
  mkdirSync(services, { recursive: true })
  return { root, home, services, file: path.join(root, 'accounts.json') }
}

function signInOf(directory, provider) {
  const spec = PROVIDERS[provider]
  return spec.signInSubdir
    ? path.join(directory, spec.signInSubdir, spec.signInFile)
    : path.join(directory, spec.signInFile)
}

/* A file layer that records the order of the three things that matter and
   performs no removal at all. */
function recordingFs(events) {
  const realFs = require_('node:fs')
  return {
    ...realFs,
    lstatSync(target, ...rest) { events.push(['lstat', path.resolve(target)]); return realFs.lstatSync(target, ...rest) },
    rmSync(target) { events.push(['rm', path.resolve(target)]) },
  }
}

function managedAccount({ home, services, file }, provider) {
  const seed = createAccountRegistryStore({ file, homedir: () => home, platform: process.platform, servicesRoot: services })
  const added = seed.addManaged({ provider, name: 'cloud' })
  assert.equal(added.homeCreatedByApp, true)
  const signIn = signInOf(added.directory, provider)
  mkdirSync(path.dirname(signIn), { recursive: true })
  writeFileSync(signIn, '{"fixture":"retained"}')
  return { signIn }
}

test('removing an app-made account hands the sign-in’s identity to the confined sweep, taken before the removal', () => {
  for (const provider of ['codex', 'claude']) {
    const area = scratch()
    const { signIn } = managedAccount(area, provider)
    const expected = lstatSync(signIn, { bigint: true })
    const events = []
    const handed = []
    const handedPaths = []
    const store = createAccountRegistryStore({
      file: area.file, homedir: () => area.home, platform: process.platform, servicesRoot: area.services,
      fsImpl: recordingFs(events),
      revokeConfinedCopies: (identity, signInPath) => {
        events.push(['revoke']); handed.push(identity); handedPaths.push(signInPath)
        return { removed: 3, failures: [] }
      },
    })
    const receipt = store.remove({ name: 'cloud', provider })
    assert.deepEqual(receipt, {
      ok: true, removed: true, credentialDestroyed: true, confinedCopiesRemoved: 3, confinedCopiesRevoked: true,
    })
    assert.equal(handed.length, 1)
    assert.equal(handed[0].dev, expected.dev, `${provider}: not the sign-in file’s device`)
    assert.equal(handed[0].ino, expected.ino, `${provider}: not the sign-in file’s identity`)
    assert.equal(path.resolve(handedPaths[0]), path.resolve(signIn), `${provider}: not the sign-in file’s path`)
    const order = events.filter(([kind, file]) => kind === 'revoke' || file === path.resolve(signIn)).map(([kind]) => kind)
    assert.deepEqual(order, ['lstat', 'rm', 'revoke'],
      `${provider}: the identity must be taken before the removal, and the sweep must run after it`)
    assert.equal(readFileSync(signIn, 'utf8'), '{"fixture":"retained"}', 'the fixture is retained (R1225)')
  }
})

test('a sweep that could not finish, or failed outright, is reported and does not undo the removal', () => {
  for (const revoke of [
    () => ({ removed: 1, failures: [{ operation: 'revoke-unlink', file: 'agent-home/x/auth.json', cause: 'EBUSY' }] }),
    () => null,
    () => { throw new Error('payload without the sweep') },
  ]) {
    const area = scratch()
    managedAccount(area, 'codex')
    const store = createAccountRegistryStore({
      file: area.file, homedir: () => area.home, platform: process.platform, servicesRoot: area.services,
      fsImpl: recordingFs([]), revokeConfinedCopies: revoke,
    })
    const receipt = store.remove({ name: 'cloud', provider: 'codex' })
    assert.equal(receipt.removed, true)
    assert.equal(receipt.credentialDestroyed, true)
    assert.equal(receipt.confinedCopiesRevoked, false, '"revoked" must not be heard when a copy may have survived')
  }
})

test('a split family: the store hands the engine the path its confined homes recorded, not only the identity', () => {
  /* After a confined CLI refreshed, the confined copies holding the live token
     are a NEW file: none of them shares the identity taken here, so an
     identity-only sweep reached none of them while the receipt said revoked.
     The engine finds them by the source each confined home records at prepare
     -- credentialSourceKey(<account folder>/<sign-in file>) -- so the store must
     hand over a path that keys to that same source. Read-only: the engine's key
     function is asked, nothing is swept here (the sweep is proved in the
     engine's tests/credential-fan-out-wiring.test.js). */
  const engine = require_(path.join(canonicalRootForTests({ requireConfigured: true }), 'src', 'lib', 'agent-session-confinement.js'))
  assert.equal(typeof engine.credentialSourceKey, 'function', 'the engine half of this fix is missing from the configured engine')
  for (const provider of ['codex', 'claude']) {
    const area = scratch()
    const { signIn } = managedAccount(area, provider)
    const directory = path.dirname(signIn)
    const recordedByPrepare = engine.credentialSourceKey(path.join(directory, PROVIDERS[provider].signInFile))
    const handedPaths = []
    const store = createAccountRegistryStore({
      file: area.file, homedir: () => area.home, platform: process.platform, servicesRoot: area.services,
      fsImpl: recordingFs([]),
      // The live copy survived: an engine that could not reach it says so.
      revokeConfinedCopies: (identity, signInPath) => {
        handedPaths.push(signInPath)
        return { removed: 0, failures: [{ operation: 'revoke-unlink', file: 'agent-home/x/auth.json', cause: 'EBUSY' }] }
      },
    })
    const receipt = store.remove({ name: 'cloud', provider })
    assert.equal(handedPaths.length, 1)
    assert.equal(engine.credentialSourceKey(handedPaths[0]), recordedByPrepare,
      `${provider}: the path handed to the sweep does not key to the source the confined homes recorded`)
    assert.equal(receipt.confinedCopiesRevoked, false, 'a surviving live copy must not be reported revoked')
  }
})

test('the control: no revoker, no sign-in, or a home the app did not make changes nothing', () => {
  // No revoker: the receipt this store has always answered.
  const plain = scratch()
  managedAccount(plain, 'codex')
  const unwired = createAccountRegistryStore({
    file: plain.file, homedir: () => plain.home, platform: process.platform, servicesRoot: plain.services,
    fsImpl: recordingFs([]),
  })
  assert.deepEqual(unwired.remove({ name: 'cloud', provider: 'codex' }), { ok: true, removed: true, credentialDestroyed: true })

  // A registered account that never signed in: nothing to revoke, and no sign-in reported deleted (REVIEW-1050 #13).
  const empty = scratch()
  createAccountRegistryStore({ file: empty.file, homedir: () => empty.home, platform: process.platform, servicesRoot: empty.services })
    .addManaged({ provider: 'codex', name: 'cloud' })
  let calls = 0
  const store = createAccountRegistryStore({
    file: empty.file, homedir: () => empty.home, platform: process.platform, servicesRoot: empty.services,
    fsImpl: recordingFs([]), revokeConfinedCopies: () => { calls += 1; return { removed: 0, failures: [] } },
  })
  assert.deepEqual(store.remove({ name: 'cloud', provider: 'codex' }),
    { ok: true, removed: true, credentialDestroyed: false, credentialDisposition: 'no-saved-sign-in' })
  assert.equal(calls, 0)

  // A home the person made: its sign-in is preserved, so nothing is swept.
  const theirs = scratch()
  const directory = path.join(theirs.home, '.codex-theirs')
  mkdirSync(directory, { recursive: true })
  writeFileSync(path.join(directory, 'auth.json'), '{"fixture":"retained"}')
  createAccountRegistryStore({ file: theirs.file, homedir: () => theirs.home, platform: process.platform })
    .add({ name: 'theirs', provider: 'codex', directory })
  let theirCalls = 0
  const theirStore = createAccountRegistryStore({
    file: theirs.file, homedir: () => theirs.home, platform: process.platform,
    fsImpl: recordingFs([]), revokeConfinedCopies: () => { theirCalls += 1; return { removed: 0, failures: [] } },
  })
  assert.equal(theirStore.remove({ name: 'theirs', provider: 'codex' }).credentialDestroyed, false)
  assert.equal(theirCalls, 0)
})

test('the application binds the store to the engine’s own sweep under the fenced services root', () => {
  const source = readFileSync(MAIN_FILE, 'utf8')
  const store = source.slice(source.indexOf('const accountRegistry = createAccountRegistryStore({'), source.indexOf('/* The renderer\'s settings'))
  assert.match(store, /revokeConfinedCopies: revokeConfinedAccountCopies,/)
  const helper = source.slice(source.indexOf('function revokeConfinedAccountCopies('), source.indexOf('const accountRegistry = createAccountRegistryStore({'))
  assert.match(helper, /require\(path\.join\(root, 'src', 'lib', 'agent-session-confinement\.js'\)\)/,
    'the sweep is the payload’s, from the host module the manifest already declares')
  assert.match(helper, /function revokeConfinedAccountCopies\(identity, signIn\)/)
  assert.match(helper, /confinement\.revokeConfinedCopies\(path\.join\(accountServicesRoot, confinement\.CONFINED_HOME_LEAF\), identity, \{ source: signIn \}\)/,
    'bound to agent-home under the same services root the store and the engine use, with the sign-in path as the source')
  assert.doesNotMatch(helper, /homedir\(|LOCALAPPDATA|\.toolsenabled/, 'no second answer to where agent-home is')
  const manifest = JSON.parse(readFileSync(path.join(REPO, 'tools', 'capability-manifest.json'), 'utf8'))
  assert.ok(manifest.hostModules.includes('src/lib/agent-session-confinement.js'))
})
