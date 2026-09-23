/* ADDING A CODEX CLOUD ACCOUNT: ONE PRESS, AND A NAME IS ALL THEY TYPE.
 *
 * WHAT THIS GUARDS. Launching a task on Codex Cloud is a real, working feature.
 * Getting to the point where it could work took four manual steps, three of
 * which are ours and none of which a customer can perform: the registry the
 * cloud lane reads was hand-authored in an editor, the per-account home
 * directories were made by hand, and the sign-in had to be run with CODEX_HOME
 * set in the right shell -- the owner was handed the PowerShell form, was in
 * cmd.exe, and it failed four times in a row.
 *
 * shell/cloud-account-setup.cjs is the composition that ends all three. It
 * implements neither half: the engine's registry-write.js creates the directory
 * and records the entry, and shell/provider-login.cjs -- the ONE place this
 * product opens a sign-in -- opens the window with that account's home set. So
 * everything below is about the COMPOSITION, and each assertion is one of the
 * ways a composition quietly stops being safe:
 *
 *   1. The name is the only thing that crosses inward.
 *   2. Nothing crosses back that a renderer must not hold: no directory, no
 *      registry path, no credential.
 *   3. An account is never recorded that cannot then be signed in.
 *   4. A refusal from the engine becomes a sentence a person can act on, never
 *      the engine's own sentence -- those name absolute paths.
 *   5. An account that was recorded is reported as recorded even when the
 *      window did not open, because it really does exist.
 *
 * NOTHING REAL IS TOUCHED. Both halves are injected. No registry is read, no
 * directory is created, no window is opened, and no provider is contacted.
 *
 * Run: node --test tools/test/cloud-account-setup.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require_ = createRequire(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const MODULE_FILE = path.join(REPO_ROOT, 'shell', 'cloud-account-setup.cjs')

const { createCloudAccountSetup } = require_(MODULE_FILE)

const HOME = 'C:\\Users\\someone\\AppData\\Roaming\\ToolsEnabled\\capability\\codex-homes\\work'
const REGISTRY = 'C:\\Users\\someone\\AppData\\Roaming\\ToolsEnabled\\capability\\config\\accounts.json'

function refusal(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * `writer` stands in for the engine's addAccount; `login` for the shell's own
 * provider-login service. Both record what they were called with, because the
 * arguments ARE the contract between the two halves.
 */
function harness({ installed = true, writer = null, signIn = { ok: true, terminal: 'command-prompt' } } = {}) {
  const added = []
  const starts = []
  const setup = createCloudAccountSetup({
    addAccount: writer || (request => {
      added.push(request)
      return Object.freeze({
        name: String(request.name).trim(),
        provider: 'codex',
        home: HOME,
        homeEnv: 'CODEX_HOME',
        priority: 1,
        registryPath: REGISTRY,
      })
    }),
    providerLogin: {
      installed: () => installed,
      start: (providerId, options) => { starts.push({ providerId, options }); return signIn },
    },
  })
  return { setup, added, starts }
}

/* ------------------------------------------------------------------
   1. The happy path, which is the whole point of the change.
   ------------------------------------------------------------------ */

test('one call creates the account and opens its sign-in, from a name alone', () => {
  const { setup, added, starts } = harness()
  const answer = setup.add({ name: 'work' })
  assert.equal(answer.ok, true)
  assert.equal(answer.name, 'work')
  assert.equal(answer.signInOpened, true)

  /* THE NAME IS THE ONLY THING THAT CROSSES INWARD. Where the home goes, what
     the provider calls that field and what priority the entry takes are all
     the writer's to decide -- every one of them is a thing a person had to
     know before this existed, and a caller that passed one would be a second
     opinion about it. */
  assert.deepEqual(added, [{ name: 'work', provider: 'codex' }])

  /* AND THE SIGN-IN IS OPENED FOR THAT ACCOUNT'S OWN HOME, UNDER THAT
     ACCOUNT'S OWN NAME. Both are handed straight from the writer's answer:
     this module never works a directory out for itself, so it cannot work out
     a different one, and the name on the window is therefore the name the new
     row will carry rather than whatever crossed in (the person may have typed
     nothing, or a name the writer had to number).

     THE LABEL IS NOT DECORATION. shell/provider-login.cjs signInWindowTitle()
     falls back to the program's own command when no account is named -- right
     for the Install button in Settings, which names no account, and wrong here: two
     cloud accounts added one after the other opened two windows both titled
     "ToolsEnabled sign-in: codex", running the same command, and a Codex Cloud
     sign-in finished in the wrong one bills the wrong subscription for every
     task launched afterwards. */
  assert.deepEqual(starts, [{ providerId: 'codex', options: { home: HOME, label: 'work' } }])
})

test('the name on the window is the writer\'s, not the one that crossed in', () => {
  /* The two differ exactly when it matters: an empty box, or a name already
     taken. A window wearing the typed name would then name an account that is
     not the one being signed in -- which is worse than the untitled window
     this replaced, because it is confidently wrong. */
  const { setup, starts } = harness({
    writer: request => Object.freeze({
      name: `${String(request.name || 'codex').trim()}-2`,
      provider: 'codex',
      home: HOME,
      homeEnv: 'CODEX_HOME',
      priority: 1,
      registryPath: REGISTRY,
    }),
  })
  const answer = setup.add({ name: 'work' })
  assert.equal(answer.name, 'work-2')
  assert.equal(starts[0].options.label, 'work-2',
    'the window is titled with the name the person typed rather than the one the account was recorded under')
})

test('nothing that comes back names a directory, a file or a credential', () => {
  const { setup } = harness()
  const answer = setup.add({ name: 'work' })
  const text = JSON.stringify(answer)
  assert.ok(!text.includes('codex-homes'), `a directory reached the renderer: ${text}`)
  assert.ok(!text.includes('accounts.json'), `the registry path reached the renderer: ${text}`)
  assert.ok(!/[A-Za-z]:\\\\|[A-Za-z]:\//.test(text), `a path reached the renderer: ${text}`)
  assert.deepEqual(Object.keys(answer).sort(), ['name', 'ok', 'signInOpened', 'terminal'])
})

test('the module cannot read a file or open anything of its own', () => {
  /* It composes two halves that are each held to this rule already. The way it
     could stop being a composition is by growing a shortcut, and a shortcut
     would show up as one of these. */
  const source = readFileSync(MODULE_FILE, 'utf8')
  for (const forbidden of [
    'readFileSync', 'writeFileSync', 'mkdirSync', 'existsSync',
    "require('node:fs')", "require('node:child_process')", 'spawn', 'openTerminal',
  ]) {
    assert.ok(!source.includes(forbidden), `cloud-account-setup.cjs contains ${forbidden}`)
  }
})

/* ------------------------------------------------------------------
   2. An account is never recorded that cannot be signed in.
   ------------------------------------------------------------------ */

test('a program that is not on this computer is refused before anything is created', () => {
  const { setup, added, starts } = harness({ installed: false })
  const answer = setup.add({ name: 'work' })
  assert.equal(answer.ok, false)
  assert.equal(answer.code, 'PROVIDER_LOGIN_NOT_INSTALLED')
  /* THE ORDER IS THE ASSERTION. Recorded first and refused at the window, the
     person is left with an account they cannot sign in and cannot add again,
     because the name is now taken. */
  assert.deepEqual(added, [], 'an account was recorded for a program that is not here')
  assert.deepEqual(starts, [], 'a window was opened for a program that is not here')
  assert.ok(answer.reason.trim().length > 0, 'the refusal did not explain what the person can do next')
})

test('a failed install check is not reported as definitely not installed or thrown to the caller', () => {
  const added = []
  const setup = createCloudAccountSetup({
    addAccount: request => { added.push(request); return { name: 'work', home: HOME } },
    providerLogin: {
      installed: () => { throw new Error('the machine could not be inspected') },
      start: () => { throw new Error('must not open') },
    },
  })

  const answer = setup.add({ name: 'work' })
  assert.equal(answer.ok, false)
  assert.equal(answer.code, 'PROVIDER_LOGIN_INSTALL_CHECK_FAILED')
  assert.doesNotMatch(answer.reason, /not on this computer/i)
  assert.deepEqual(added, [], 'an account was recorded after its install check failed')
})

test('without both halves the surface says so instead of throwing at somebody', () => {
  for (const missing of [
    { addAccount: null, providerLogin: { installed: () => true, start: () => ({ ok: true }) } },
    { addAccount: () => ({}), providerLogin: null },
    { addAccount: () => ({}), providerLogin: { start: () => ({ ok: true }) } },
    {},
  ]) {
    const setup = createCloudAccountSetup(missing)
    assert.equal(setup.available(), false)
    const answer = setup.add({ name: 'work' })
    assert.equal(answer.ok, false)
    assert.equal(answer.code, 'CLOUD_ACCOUNT_ADD_UNAVAILABLE')
    assert.ok(answer.reason.length > 0)
  }
})

/* ------------------------------------------------------------------
   3. Refusals: the engine's code, this product's sentence.
   ------------------------------------------------------------------ */

test('every refusal the writer can raise becomes a sentence with no path in it', () => {
  /* The engine's own messages name the registry's absolute path, because they
     are written for a developer with the file in front of them. A path in a
     sentence goes straight to the glass. */
  const codes = [
    'ACCOUNTS_ENTRY_INVALID', 'ACCOUNTS_NAME_DUPLICATE', 'ACCOUNTS_PROFILE_DIR_SHARED',
    'ACCOUNTS_ROLE_DUPLICATE', 'ACCOUNTS_PROVIDER_UNSUPPORTED', 'ACCOUNTS_REGISTRY_UNREADABLE',
    'ACCOUNTS_REGISTRY_UNPARSABLE', 'ACCOUNTS_REGISTRY_INVALID', 'ACCOUNTS_HOME_NOT_CREATED',
    'ACCOUNTS_REGISTRY_WRITE_FAILED',
  ]
  for (const code of codes) {
    const engineReason = `Something at ${REGISTRY} went wrong, so nothing was changed.`
    const { setup, starts } = harness({
      writer: () => { throw refusal(code, engineReason) },
    })
    const answer = setup.add({ name: 'work' })
    assert.equal(answer.ok, false, `${code} was treated as a success`)
    assert.equal(answer.code, code, `${code} lost its code on the way out`)
    assert.notEqual(answer.reason, engineReason, `${code} exposed the engine's refusal`)
    assert.ok(!answer.reason.includes('accounts.json'), `${code} carried the registry path: ${answer.reason}`)
    assert.ok(!/[A-Za-z]:\\/.test(answer.reason), `${code} carried a path: ${answer.reason}`)
    assert.ok(answer.reason.trim().length > 0, `${code} did not explain the refusal`)
    assert.deepEqual(starts, [], `${code} still opened a sign-in window`)
  }
})

test('a duplicate name and a shared folder say different things, because they are', () => {
  const say = code => harness({ writer: () => { throw refusal(code, 'engine words') } })
    .setup.add({ name: 'work' }).reason
  assert.notEqual(
    say('ACCOUNTS_NAME_DUPLICATE'),
    say('ACCOUNTS_PROFILE_DIR_SHARED'),
    'duplicate-name and shared-folder refusals became indistinguishable',
  )
})

test('a refusal with no code at all is still a sentence and never the engine\'s words', () => {
  const { setup } = harness({ writer: () => { throw new Error(`ENOENT: open ${REGISTRY}`) } })
  const answer = setup.add({ name: 'work' })
  assert.equal(answer.ok, false)
  assert.equal(answer.code, 'CLOUD_ACCOUNT_ADD_REFUSED')
  assert.ok(!answer.reason.includes('ENOENT'), answer.reason)
  assert.ok(!answer.reason.includes('accounts.json'), answer.reason)
})

/* ------------------------------------------------------------------
   4. The half-done case, reported as what it is.
   ------------------------------------------------------------------ */

test('an account that was recorded is reported as recorded even if no window opened', () => {
  const { setup, added } = harness({
    signIn: { ok: false, code: 'PROVIDER_LOGIN_SPAWN_FAILED', reason: 'The window could not be opened. Press the button again in a moment.' },
  })
  const answer = setup.add({ name: 'work' })
  /* `ok: true` is not optimism. The account exists: the directory was made and
     the entry was written. Reporting it as a failure would send the person to
     add it again under a name that is now taken, which is a refusal they would
     have no way to understand. */
  assert.equal(answer.ok, true)
  assert.equal(answer.signInOpened, false)
  assert.equal(answer.code, 'PROVIDER_LOGIN_SPAWN_FAILED')
  assert.ok(answer.reason.length > 0)
  assert.equal(added.length, 1)
})

test('a sign-in seam that answers with nothing at all is still not a crash', () => {
  const { setup } = harness({ signIn: null })
  const answer = setup.add({ name: 'work' })
  assert.equal(answer.ok, true)
  assert.equal(answer.signInOpened, false)
  assert.ok(answer.reason.length > 0)
})
