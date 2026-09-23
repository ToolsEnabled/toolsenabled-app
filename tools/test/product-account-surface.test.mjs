// THE SIGN-IN SURFACE, AND THE WIRING BEHIND IT.
//
// The store itself is covered by product-account.test.mjs. These are the two
// ways a correct store still ships a broken product:
//
//   1. THE RENDERER DECIDES IT IS SIGNED IN WHEN IT IS NOT. src/account-state.js
//      turns a shell reply into what the screen shows. Every malformed, absent
//      or surprising reply has to resolve to SIGNED OUT, and each is asserted
//      separately -- one test covering all of them can be satisfied by one early
//      return, which is the shape that hides a fail-open branch behind a
//      fail-closed one.
//   2. THE WIRING IS NOT THERE. A store nothing calls, a bridge nothing exposes,
//      or -- the one that matters most -- an audit principal the PAGE can name.
//
// The wiring assertions read source text, and that is a weaker instrument than
// running the code, so they are deliberately written to catch REMOVAL rather
// than to certify behaviour: shell/main.cjs cannot be imported without Electron,
// and a channel that has been deleted is exactly what a source match can see.
// The behavioural half lives in product-account.test.mjs, which runs for real.

import assert from 'node:assert/strict'
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { parseAst } from 'rollup/parseAst'
import { parseRoute } from '../../src/route-parse.js'

import {
  ACCOUNT_SCOPE_LEAD,
  ACCOUNT_SCOPE_NOTICE,
  ACCOUNT_SCOPE_SUBJECT_REMOTE,
  MIN_PASSWORD_LENGTH,
  accountBridge,
  accountStep,
  isPlainObject,
  loadAccountState,
  readAccountState,
  readActionResult,
} from '../../src/account-state.js'
import {
  belongingsMarkup,
  changeDisplayNameMarkup,
  esc,
  formMarkup,
  googleOptionMarkup,
  scopeMarkup,
  screenMarkup,
  setupAccountStepMarkup,
  signedInMarkup,
} from '../../src/account-markup.js'
import {
  MIN_PASSWORD_LENGTH as SHELL_MIN_PASSWORD_LENGTH,
} from '../../shell/product-account.cjs'
import { SIGNIN_SCOPES } from '../../shell/google-signin.cjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = relative => readFileSync(path.join(REPO_ROOT, relative), 'utf8')

/**
 * The source with its comments removed.
 *
 * WITHOUT THIS, EVERY PROHIBITION BELOW IS SATISFIED BY ITS OWN DOCUMENTATION.
 * These files explain at length why there is no channel that sets the principal
 * and why the sign-in screen touches no web storage -- and a search for
 * `setPrincipal` or `localStorage` then matches the sentence saying it must
 * never appear. Both assertions failed exactly that way when first written, on
 * prose rather than on code, which is the same defect class as a vacuous green:
 * the test would have passed forever while the real thing was added.
 *
 * A character scanner rather than a regex, because a regex that strips comments
 * eats the contents of any string containing `//` -- including a URL -- and
 * would quietly delete the code being examined.
 */
// Let the maintained JavaScript parser identify literals and template quasis.
// A flat quote scanner loses its place on nested template interpolations and
// can misclassify later comments as shipped account promises.
function stripComments(source) {
  const protectedRanges = new Map()
  function visit(node) {
    if (!node || typeof node !== 'object') return
    if (node.type === 'Literal' || node.type === 'TemplateElement') {
      protectedRanges.set(node.start, node.end)
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit)
      else if (value && typeof value === 'object') visit(value)
    }
  }
  visit(parseAst(source, { allowReturnOutsideFunction: true }))
  let output = '', index = 0
  while (index < source.length) {
    const protectedEnd = protectedRanges.get(index)
    if (protectedEnd > index) { output += source.slice(index, protectedEnd); index = protectedEnd; continue }
    if (source.startsWith('//', index)) {
      const end = source.indexOf('\n', index + 2)
      index = end < 0 ? source.length : end
      continue
    }
    if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2) + 2
      const newlines = source.slice(index, end).replace(/[^\n]/g, '')
      output += newlines
      // Removing a comment between two words must not join their tokens.
      if (!newlines && /[\w$]$/.test(output) && /^[\w$]/.test(source.slice(end))) output += ' '
      index = end
      continue
    }
    output += source[index++]
  }
  return output
}

test('the comment stripper removes comments and keeps code, including strings that look like comments', () => {
  assert.equal(stripComments('const a = 1 // no\nconst b = 2'), 'const a = 1 \nconst b = 2')
  assert.equal(stripComments('/* no */const a = 1'), 'const a = 1')
  assert.equal(stripComments('const url = "https://example.com/x"'), 'const url = "https://example.com/x"')
  assert.equal(stripComments("const s = 'a /* b */ c'"), "const s = 'a /* b */ c'")
  assert.equal(stripComments('const s = "he said \\" // "'), 'const s = "he said \\" // "')
  /* The property this whole helper exists for. */
  assert.ok(!stripComments('// never call setPrincipal\nconst a = 1').includes('setPrincipal'))
  assert.ok(stripComments('setPrincipal() // do not').includes('setPrincipal'))
})

test('a regex literal with a quote character in its class does not desync every quote-pairing after it', () => {
  /* THE EXACT SHAPE MEASURED IN src/account-switcher.js. Before the fix, the
     `"` inside the class was read as a string opener, and stripComments hunted
     for the next `"` to close it -- landing on the unrelated `'"'` object key
     two "statements" later and swallowing everything between as string
     content, never as code or a stripped comment. */
  const escaper = 'str.replace(/[&<>"\']/g, character => ({\'&\':\'&amp;\',\'"\':\'&quot;\'}[character]))'
  assert.equal(stripComments(escaper), escaper, 'the regex literal and the object literal after it are both still code')

  /* THE CONSEQUENCE THAT MATTERS: a real comment placed after such a regex
     used to be read as still being inside the desynced "string" and was
     never stripped -- which is how three fragments of a real comment reached
     proseLiterals as though they were shipped copy. This is that shape,
     collapsed to its essentials: the regex, then a comment with the same
     contraction apostrophe ("row's") that closed the runaway string in the
     real file. */
  const withCommentAfter = `x.replace(/[&<>"']/g, c => c)\n/* a comment with an apostrophe: it's here */\nconst kept = 1`
  const stripped = stripComments(withCommentAfter)
  assert.ok(!stripped.includes('apostrophe'), 'a real comment after a quote-bearing regex literal was not stripped')
  assert.ok(stripped.includes('const kept = 1'), 'code after the comment survived the strip')

  /* NOT OVER-EAGER: a "/" that is genuinely division must stay division, or
     this fix would trade one desync for another -- reading the rest of the
     file as an unterminated regex instead of an unterminated string. */
  assert.equal(stripComments('const x = a / b // divide, not regex\nconst y = 2'), 'const x = a / b \nconst y = 2')
  assert.equal(stripComments('const rate = total / count'), 'const rate = total / count')
  /* Division after a closing paren or bracket -- the other shapes a value
     can end with -- must stay division too. */
  assert.equal(stripComments('const half = (a + b) / 2'), 'const half = (a + b) / 2')
  assert.equal(stripComments('const per = list[0] / 2'), 'const per = list[0] / 2')
  /* A regex literal is still recognised after the punctuation and keywords
     that put the parser in a value position. */
  assert.equal(stripComments('return /^a$/.test(x)'), 'return /^a$/.test(x)')
  assert.equal(stripComments('if (/^a$/.test(x)) { /* ok */ }'), 'if (/^a$/.test(x)) {  }')
})

const MAIN = read('shell/main.cjs')
const PRELOAD = read('shell/fleet-profile-preload.cjs')
const VIEW = read('src/views/account.js')
const ROUTER = read('src/main.js')
const SETTINGS = read('src/fleet-profile-settings.js')

const READY = Object.freeze({ ok: true, code: 'ACCOUNT_READY', accountCount: 1, canPersistSession: true })
const SIGNED_IN = Object.freeze({
  signedIn: true,
  principal: 'account:0123456789abcdef0123456789abcdef',
  account: { id: '0123456789abcdef0123456789abcdef', username: 'josh', displayName: 'Josh P' },
  session: { issuedAtMs: 1, expiresAtMs: 2 },
})

/* ------------------------- the renderer fails closed ------------------------- */

test('an array is not a plain object, on this channel as on the setup channel', () => {
  /* `typeof [] === 'object'`, so the obvious guard lets one through, and an
     array then answers `undefined` to every field -- which on the sibling setup
     channel read as "available, nothing recorded yet" and opened a question with
     a button guaranteed to fail. */
  assert.equal(isPlainObject([]), false)
  assert.equal(isPlainObject([1, 2]), false)
  assert.equal(isPlainObject(null), false)
  assert.equal(isPlainObject(undefined), false)
  assert.equal(isPlainObject('text'), false)
  assert.equal(isPlainObject(0), false)
  assert.equal(isPlainObject({}), true)
  assert.equal(isPlainObject({ signedIn: true }), true)
})

test('a signed-in reply is read as signed in', () => {
  const state = readAccountState(READY, SIGNED_IN)
  assert.equal(state.available, true)
  assert.equal(state.signedIn, true)
  assert.equal(state.displayName, 'Josh P')
  assert.equal(state.username, 'josh')
})

for (const [name, reply] of [
  ['undefined', undefined],
  ['null', null],
  ['an array', []],
  ['a string', 'signed in'],
  ['a number', 1],
  ['true', true],
  ['an empty object', {}],
  ['signedIn as the string "true"', { signedIn: 'true', account: { username: 'josh' } }],
  ['signedIn as 1', { signedIn: 1, account: { username: 'josh' } }],
  ['signedIn true with no account', { signedIn: true }],
  ['signedIn true with a null account', { signedIn: true, account: null }],
  ['signedIn true with an array account', { signedIn: true, account: [] }],
  ['signedIn true with no username', { signedIn: true, account: { displayName: 'Josh P' } }],
  ['signedIn true with a blank username', { signedIn: true, account: { username: '   ' } }],
  ['signedIn true with a non-string username', { signedIn: true, account: { username: 42 } }],
]) {
  test(`fails closed: current() as ${name} reads as signed out`, () => {
    const state = readAccountState(READY, reply)
    assert.equal(state.signedIn, false, `${name} must not read as signed in`)
    assert.equal(state.displayName, null)
  })
}

for (const [name, reply] of [
  ['undefined', undefined],
  ['null', null],
  ['an array', []],
  ['a string', 'ready'],
  ['ok as the string "true"', { ok: 'true', accountCount: 1 }],
  ['ok missing', { accountCount: 1 }],
  ['ok false', { ok: false, code: 'ACCOUNT_STORE_CORRUPT', reason: 'unreadable' }],
]) {
  test(`fails closed: availability() as ${name} makes the surface unavailable`, () => {
    const state = readAccountState(reply, SIGNED_IN)
    assert.equal(state.available, false, `${name} must not read as available`)
    assert.equal(state.signedIn, false, `${name} must not read as signed in`)
    assert.ok(typeof state.code === 'string' && state.code.length > 0, 'it must carry a code')
  })
}

test('a corrupt store still reports that accounts exist, so nothing offers a fresh start', () => {
  const state = readAccountState({ ok: false, code: 'ACCOUNT_STORE_CORRUPT', reason: 'unreadable', accountCount: 3 }, null)
  assert.equal(state.available, false)
  assert.equal(state.accountCount, 3,
    'a surface that showed "create your first account" here would invite overwriting the unreadable one')
})

test('a bridge that throws reads as signed out with a code, not as a crash', async () => {
  const scope = { mcAccount: { current: async () => SIGNED_IN, signIn: async () => ({ ok: true }), availability: async () => { throw new Error('gone') } } }
  const state = await loadAccountState(scope)
  assert.equal(state.signedIn, false)
  assert.equal(state.available, false)
  assert.equal(state.code, 'MC_ACCOUNT_READ_FAILED')
})

test('a bridge whose current() throws is signed out, not signed in from a stale read', async () => {
  const scope = { mcAccount: { availability: async () => READY, current: async () => { throw new Error('gone') }, signIn: async () => ({}) } }
  const state = await loadAccountState(scope)
  assert.equal(state.available, true)
  assert.equal(state.signedIn, false)
})

test('no bridge at all is signed out and says why', async () => {
  assert.equal(accountBridge({}), null)
  assert.equal(accountBridge({ mcAccount: {} }), null, 'a partial bridge is not a bridge')
  assert.equal(accountBridge({ mcAccount: { current: () => {} } }), null)
  const state = await loadAccountState({})
  assert.equal(state.signedIn, false)
  assert.equal(state.available, false)
  assert.equal(state.code, 'MC_ACCOUNT_SHELL_ABSENT')
})

test('an action reply that is not a well-formed success is a refusal', () => {
  for (const value of [undefined, null, [], 'ok', 1, {}, { ok: 'true' }, { ok: 1 }]) {
    const result = readActionResult(value)
    assert.equal(result.ok, false, `${JSON.stringify(value)} must not read as success`)
    assert.ok(result.reason.length > 0)
  }
  assert.equal(readActionResult({ ok: true }).ok, true)
  assert.equal(readActionResult({ ok: true }).persisted, true)
  assert.equal(readActionResult({ ok: true, persisted: false }).persisted, false)
})

test('the walkthrough seam refuses rather than throwing when there is no bridge', async () => {
  const step = accountStep({})
  assert.equal(step.available, false)
  assert.equal((await step.create({ username: 'josh', password: 'x' })).ok, false)
  assert.equal((await step.signIn({ username: 'josh', password: 'x' })).ok, false)
  assert.equal((await step.signOut()).ok, false)
})

test('the walkthrough seam exposes no field that could carry a credential', () => {
  const step = accountStep({})
  /* The three google* entries take NO ARGUMENTS, which is why they are safe
     additions to a seam whose whole purpose is having nowhere to put a
     credential: there is no parameter on any of them for one to arrive in. The
     identity is decided in the main process from a token Google signed. */
  for (const name of Object.keys(step)) {
    assert.ok(!/(?:password|credential|token|secret|key)/i.test(name),
      `the walkthrough seam exposes a credential-shaped field: ${name}`)
  }
  for (const name of ['googleSignIn', 'googleCancel', 'googleAvailability']) {
    assert.equal(step[name].length, 0, `${name} takes an argument, so a page could aim the sign-in`)
  }
  /* src/views/setup.js serialises its answers to localStorage and renders them
     on a review page. A password reaching that object would be written to disk
     in the clear, so the seam must have nowhere to put one. */
  const encoded = JSON.stringify(step)
  assert.ok(!encoded.includes('password'), 'the seam must not carry a password field')
})

/* --------------------------- the copy tells the truth --------------------------- */

test('the renderer and the shell agree on the minimum password length', () => {
  assert.equal(MIN_PASSWORD_LENGTH, SHELL_MIN_PASSWORD_LENGTH,
    'a form that states a different rule than the one enforced refuses passwords it invited')
})

test('the surface says what the account is not, where the account is made', () => {
  const notice = ACCOUNT_SCOPE_NOTICE.join(' ').toLowerCase()
  /* Each of these corrects an assumption the words "create an account" produce
     by default. Dropping one leaves the product implying something untrue. */
  assert.ok(notice.includes('this computer'), 'it must say the account is local')
  assert.ok(/no password reset|there is also no password reset|no server holds it/.test(notice),
    'it must say there is no reset, because there is no server to do one')
  assert.ok(notice.includes('claude') && notice.includes('chatgpt'),
    'it must say this is not a provider login -- SHIPMENT-PLAN B14')
  assert.ok(notice.includes('subscription to those services'), 'it must distinguish provider subscriptions from the ToolsEnabled account')
  assert.ok(notice.includes('toolsenabled verifies that sign-in online'), 'hosted sign-in must not inherit a local-only privacy promise')
  /* The second way in has to be described where the first one is, or the
     screen offers a Google button the copy never explains. */
  assert.ok(notice.includes('google'), 'it must say what signing in with Google does')
  assert.ok(VIEW.includes('ACCOUNT_SCOPE_NOTICE'), 'and the view must actually render it')
})

/* THE PROVIDER-TERMS FENCE. SHIPMENT-PLAN B14: a Claude subscription login
   inside a third-party product is barred. The screen may NAME those providers
   in order to say it is not them; what it must never do is collect for them. */
test('the sign-in screen never asks for a provider credential', () => {
  for (const source of [VIEW, read('src/account-state.js')]) {
    assert.ok(!/anthropic|api[_-]?key|sk-ant|openai/i.test(stripComments(source)),
      'the product sign-in must not touch provider credentials')
  }
  assert.ok(/not a login to Claude/i.test(read('src/account-state.js')),
    'and it must say so where a person reads it')
})

test('the settings surface no longer claims there is no account system', () => {
  assert.ok(!/no accounts, sign-in, or licence check/i.test(SETTINGS),
    'that sentence became false the moment the account system existed')
  assert.ok(!/nothing here to log into/i.test(SETTINGS))
  assert.ok(SETTINGS.includes('href="#/account"'), 'settings must reach the sign-in screen')
  /* The search synonyms are what route somebody typing "login" to that row.
     Changing the copy without them makes the new sign-in unfindable. */
  for (const term of ['login', 'password', 'signin', 'sign out']) {
    assert.ok(SETTINGS.includes(term), `settings search must still match "${term}"`)
  }
})

/* ---------------- every absolute promise, and what pins it true ----------------
 *
 * WHY THIS EXISTS AS A TABLE AND NOT AS FIVE ASSERTIONS. The sign-in copy makes
 * promises of the strongest possible shape -- "nothing", "never", "nowhere", "no
 * server" -- because the honest description of a local account IS a list of
 * things that do not happen. Every one of them was true when written and none
 * was checked by anything, which is the exact shape of promise that a later lane
 * falsifies without ever reading the sentence: somebody adds a telemetry ping,
 * or an email field, or a password-reset flow, and the screen goes on
 * reassuring the user in words that have quietly become lies.
 *
 * The pattern is borrowed from setup-profile-build's walkthrough rules, and the
 * reason it is HERE is the lesson that produced them: they fixed the two
 * sentences a test happened to name and then found twenty-nine more unwatched in
 * the same file. One instance is not a class. Their rules walk
 * src/views/setup.js; these sentences live in src/account-state.js and
 * src/fleet-profile-settings.js, which their walker does not cover, so the same
 * gap existed in my files until this table.
 *
 * EACH ENTRY REGISTERS THE CLAIM WITH THE MECHANICAL FACT THAT KEEPS IT TRUE.
 * The claim text is asserted to still be on screen, so the registry cannot rot
 * into a list of sentences nobody ships; and the pin is asserted to still hold,
 * so the sentence cannot outlive its own truth. Changing the copy fails this
 * test until somebody re-registers it, which is the two-minute speed bump that
 * is the whole point.
 *
 * SCOPE, STATED RATHER THAN IMPLIED: the pins scan the three account modules.
 * They do not prove the rest of the application sends nothing -- that is not
 * what the sentence claims. It claims the ACCOUNT does not, and that is what is
 * checked. */

/* THE FILE SET IS DISCOVERED, NOT LISTED, and this is the third time tonight
 * that a hand-written list turned out to be the defect. The first version named
 * three files. Then I extracted the markup into src/account-markup.js to make it
 * testable -- a fix for a coverage hole -- and every form field moved OUT of the
 * listed set. Planted afterwards: an email field, a network call and a provider
 * key hint in the new module all survived, 0 of 5 killed. The guards stayed
 * pointed at the file the code had left.
 *
 * Coverage that is written down does not follow the code. So the set is derived
 * from the tree: everything under src/ and shell/ whose name contains "account",
 * plus the view. A new account-*.js file is covered the moment it exists, and
 * the floor below fails if discovery ever returns less than the tree holds. */
function discoverAccountSources() {
  const found = {}
  for (const directory of ['src', 'shell', 'src/views']) {
    const absolute = path.join(REPO_ROOT, directory)
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      if (!/account/i.test(entry.name)) continue
      if (!/\.(js|cjs|mjs)$/.test(entry.name)) continue
      const relative = `${directory}/${entry.name}`
      found[relative] = stripComments(read(relative))
    }
  }
  return found
}

const ACCOUNT_SOURCES = discoverAccountSources()

test('the account file set is discovered, and covers every account module in the tree', () => {
  const names = Object.keys(ACCOUNT_SOURCES).sort()
  /* Named explicitly so that a file DISAPPEARING from discovery is a failure
     rather than a quietly smaller scan. Add to this list when you add a module;
     the discovery above is what makes forgetting it impossible to miss. */
  for (const required of ['src/account-state.js', 'src/account-markup.js', 'shell/product-account.cjs', 'src/views/account.js']) {
    assert.ok(names.includes(required), `${required} is no longer being scanned by the account guards`)
  }
  assert.ok(names.length >= 4, `only ${names.length} account modules were discovered`)
  for (const [name, text] of Object.entries(ACCOUNT_SOURCES)) {
    assert.ok(text.length > 200, `${name} was discovered but read as ${text.length} characters`)
  }
})
const SHIPPED_COPY = [
  read('src/account-state.js'),
  SETTINGS,
  VIEW,
  read('shell/product-account.cjs'),
  read('src/account-markup.js'),
  /* The words on the removal surface. It is a separate module for the same
     reason src/account-markup.js is -- so a test can CALL the copy rather than
     search for it -- and it is named account-* so the discovery above picks it
     up without anybody remembering to add it. */
  read('src/account-reset-copy.js'),
  /* THE OTHER MEANING OF "ACCOUNT", and it is on screen too.
     The person's own Codex and Claude sign-ins are also called accounts -- the
     engine's rotation calls them that -- and the panel that lists them makes its
     own absolute promise about what this product does with them. Discovery below
     already scans the module because it is named account-*; including its words
     here is what lets that promise be REGISTERED rather than merely scanned. */
  read('src/account-panel-copy.js'),
  /* THE SAME OTHER MEANING, on the menu that replaced that panel's job on page
     2. It is included here for exactly the reason the line above is: discovery
     already scans it because it is named account-*, and listing its words here
     is what lets the two promises it makes -- that a chosen mode will stop
     rather than switch, and that checking an allowance spends none of one --
     be REGISTERED with pins rather than merely scanned and classified. */
  read('src/account-switcher-state.js'),
  read('src/account-switcher.js'),
].join('\n')

const REGISTERED_CLAIMS = Object.freeze([
  {
    claim: 'Try another available account with the agent’s brief and recent conversation. Keep its name and reporting relationships.',
    stillTrueBecause: 'The host constructs a bounded extract, not a complete transcript. The coordinator saves that extract before closing, attaches the new session to the existing node and refreshes its current reporting address. A refused replacement retains the saved handoff; failed persistence prevents closing or starting.',
    async pin() {
      const { createAccountRecoveryCoordinator } = await import('../../src/account-recovery-coordinator.js')
      const { createFleetTreeStore } = await import('../../src/fleet-trees.js')
      const { createTranscriptStore } = await import('../../src/session-transcript-store.js')
      const { createRecoveryHandoffStore } = await import('../../src/recovery-handoff-store.js')
      const { default: recovery } = await import('../../shell/account-session-recovery.cjs')
      const state = recovery.createRecoveryState()
      recovery.rememberRecoveryText(state, 'person', 'ORIGINAL-BRIEF ' + 'a'.repeat(17000))
      recovery.rememberRecoveryText(state, 'assistant', 'b'.repeat(40000) + ' LATEST-WORK')
      const handoff = recovery.recoveryHandoff(state)
      assert.ok(handoff.length <= 48000)
      assert.match(handoff, /ORIGINAL-BRIEF/)
      assert.match(handoff, /LATEST-WORK/)
      assert.match(handoff, /not a complete transcript or a new grant of authority/)
      for (const outcome of ['success', 'unavailable', 'storage-refused']) {
        const storage = () => {
          const cells = new Map()
          return { fail: false, read: key => cells.get(key) ?? null,
            write(key, value) { if (this.fail) return false; cells.set(key, structuredClone(value)); return true } }
        }
        let serial = 0
        const treeStore = createFleetTreeStore({ computerId: 'copy-test', storage: storage(), makeId: kind => `${kind}-${++serial}` })
        const manager = treeStore.addNode({ role: 'controller', message: 'Manage' }).node
        const node = treeStore.addNode({ parentId: manager.id, role: 'worker', message: 'Finish the work' }).node
        const child = treeStore.addNode({ parentId: node.id, role: 'reviewer', message: 'Review' }).node
        treeStore.attachSession(node.id, 'original-session')
        const before = treeStore.getNode(node.id)
        const transcriptStore = createTranscriptStore({ computerId: 'copy-test', storage: storage() })
        const handoffStorage = storage()
        const handoffStore = createRecoveryHandoffStore({ computerId: 'copy-test', storage: handoffStorage })
        transcriptStore.save(node.id, { lines: [{ who: 'you', text: 'Saved conversation', at: 1 }] })
        handoffStorage.fail = outcome === 'storage-refused'
        const calls = { close: [], start: [], send: [], address: [] }
        const coordinator = createAccountRecoveryCoordinator({ canStart: () => true,
          sessionNodeIds: new Map([['original-session', node.id]]), bridge: {
            async close(value) { calls.close.push(value); return { closed: true, sessionId: value.sessionId } },
            async start(value) { calls.start.push(value); return outcome === 'unavailable'
              ? { ok: false, reason: 'No eligible account' } : { ok: true, sessionId: 'replacement-session' } },
            async updateTreeAddress(value) { calls.address.push(value); return { ok: true } },
            async send(value) { calls.send.push(value); return { ok: true } },
            async sendAutomatic(value) { calls.send.push(value); return { ok: true } },
          } })
        try {
          coordinator.register('copy-test', { treeStore, transcriptStore, handoffStore })
          await coordinator.recover({ sessionId: 'original-session', event: {
            type: 'account_recovery_needed', recoveryId: 'copy-ticket', handoff } })
          const after = treeStore.getNode(node.id)
          for (const key of ['id', 'parentId', 'treeId', 'role', 'nameOrdinal']) assert.equal(after[key], before[key], key)
          assert.equal(treeStore.getNode(child.id).parentId, node.id)
          if (outcome === 'storage-refused') {
            assert.deepEqual(calls.close, []); assert.deepEqual(calls.start, []); assert.deepEqual(calls.send, [])
          } else {
            assert.equal(handoffStore.get(node.id).handoff, handoff)
            assert.equal(calls.close.length, 1)
            assert.equal(calls.start.length, 1)
            if (outcome === 'success') {
              assert.deepEqual(calls.address[0].requestKeys.treeAnchors, [manager.id, node.id])
              assert.equal(after.sessionId, 'replacement-session')
              assert.equal(calls.send.length, 1)
              assert.ok(calls.send[0].text.includes(handoff))
            } else {
              assert.equal(after.sessionId, 'original-session')
              assert.equal(after.status, 'turn-failed')
              assert.deepEqual(calls.send, [])
            }
          }
          assert.equal(transcriptStore.get(node.id).lines[0].text, 'Saved conversation')
        } finally { coordinator.destroy() }
      }
    },
  },
  {
    claim: 'Nothing is sent anywhere',
    stillTrueBecause: 'no account module can reach the network: no fetch, no XHR, no WebSocket, no beacon, and no node networking module is imported anywhere in the three of them.',
    pin() {
      const network = /\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|navigator\.connection|require\(\s*['"](?:node:)?(?:http|https|net|dns|tls|dgram)['"]\s*\)|from\s+['"](?:node:)?(?:http|https|net|dns|tls|dgram)['"]/
      for (const [name, source] of Object.entries(ACCOUNT_SOURCES)) {
        assert.ok(!network.test(source), `${name} can reach the network, so "Nothing is sent anywhere" is no longer true`)
      }
    },
  },
  {
    claim: 'No email address is asked for',
    stillTrueBecause: 'no surface in the account flow declares an email input, an email autocomplete hint, or a field named email.',
    pin() {
      const emailField = /type="email"|autocomplete="email"|name="email"|account-field="email"/i
      for (const [name, source] of Object.entries(ACCOUNT_SOURCES)) {
        assert.ok(!emailField.test(source), `${name} collects an email address, so "no email address is asked for" is no longer true`)
      }
      assert.ok(!emailField.test(stripComments(read('src/views/setup.js'))),
        'the first-run step collects an email address, so "no email address is asked for" is no longer true')
    },
  },
  {
    claim: 'There is also no password reset',
    stillTrueBecause: 'the store exposes no reset, recovery or forgotten-password operation, and no mc-account channel offers one. Changing a password requires the current one.',
    pin() {
      /* Deliberately narrow. A first draft matched /reset[A-Z_]/ and flagged
         `resetSharedAccountStoreForTests`, which resets a module singleton and
         has nothing to do with a password -- a guard that cries wolf on correct
         code gets widened by the next person until it catches nothing. */
      const recovery = /resetPassword|resetCredential|recoverAccount|forgotPassword|passwordReset|mc-account:[a-z-]*(?:reset|recover|forgot)/i
      for (const [name, source] of Object.entries(ACCOUNT_SOURCES)) {
        assert.ok(!recovery.test(source), `${name} offers a password recovery path, so "there is also no password reset" is no longer true`)
      }
      assert.ok(!/mc-account:[a-z-]*(?:reset|recover|forgot)/i.test(stripComments(MAIN)),
        'the shell offers an account recovery channel, so "there is also no password reset" is no longer true')
      /* And the one password change that DOES exist still demands the old one. */
      assert.ok(ACCOUNT_SOURCES['shell/product-account.cjs'].includes('currentPassword'),
        'changing a password no longer requires the current one, which would be a reset by another name')
      /* The test-only singleton reset is exported, so it is reachable. Nothing
         in a shipped path may call it: an app that can swap its own account
         store mid-flight is an app whose audit principal can be swapped
         mid-flight. */
      assert.ok(!/resetSharedAccountStoreForTests/.test(stripComments(MAIN)),
        'the shell calls the test-only store reset, which would let the signed-in identity be swapped at runtime')
      assert.ok(!/resetSharedAccountStoreForTests/.test(stripComments(PRELOAD)),
        'the preload exposes the test-only store reset to the page')
    },
  },
  {
    /* RE-REGISTERED, BECAUSE THE PROMISE CHANGED. It used to read "not a login
       to Claude, ChatGPT or Google". Google sign-in now exists, so the old
       sentence would have been false the moment it shipped -- and the pin below
       would NOT have caught it, because a regex for credential names says
       nothing about a sentence's truth. It was changed in the copy first and
       re-registered here, which is the two-minute speed bump working.

       WHAT DID NOT CHANGE is the thing B14 is actually about: no PROVIDER
       SUBSCRIPTION login. Google sign-in asks for `openid email profile`,
       which buys access to nothing and carries no plan anybody pays for. */
    claim: 'not a login to Claude or ChatGPT',
    stillTrueBecause: 'no account module names an Anthropic or OpenAI credential, key format, or auth environment variable, and the only OAuth on the sign-in path asks for openid/email/profile -- scopes that grant access to no service and carry no subscription. SHIPMENT-PLAN B14 bars taking a provider subscription login; it does not reach an identity assertion.',
    pin() {
      /* The providers B14 is about. `oauth`/`access_token` are deliberately
         NOT in this list any more: an identity flow legitimately names them,
         and a guard that fires on correct code gets widened until it catches
         nothing. What must stay absent is a credential belonging to a paid
         plan. */
      /* CREDENTIAL SHAPES, NOT PROVIDER NAMES. The first draft of this list
         included `chatgpt`, and it fired on the sentence it was guarding --
         the copy names those providers precisely in order to say it is not
         them. A guard that refuses its own promise gets deleted by the next
         person. What must stay absent is a KEY. */
      /* THE SAME NARROWING THIS ENTRY ALREADY MADE FOR `chatgpt`, NOW FOR THE
         COMPANY NAMES, and it is made for the second time by the same defect.
         A bare /anthropic/ fired on src/account-panel-copy.js -- the provider
         risk warning, whose whole job is to name the company that can act on a
         person's own subscription. That is prose naming a provider in order to
         be honest about it, which is exactly the case the paragraph above
         describes, and satisfying the guard by deleting the company's name would
         be satisfying it by saying less.

         SO THE COMPANY NAMES ARE MATCHED IN CODE SHAPES ONLY -- an import, a
         require, a constructor, a host name, an environment variable -- the
         technique the licensing pin two entries up already uses and for the same
         stated reason. Every CREDENTIAL shape stays a bare match, because those
         appear in no honest sentence. And a provider API call remains impossible
         here whatever it is named: the network pin above bars fetch, sockets and
         every node networking module in these same files. */
      const subscriptionCredential = [
        /sk-ant/i,
        /api[_-]?key/i,
        /ANTHROPIC_API_KEY|OPENAI_API_KEY/,
        /from\s+['"][^'"]*(?:anthropic|openai)[^'"]*['"]/i,
        /require\(\s*['"][^'"]*(?:anthropic|openai)[^'"]*['"]/i,
        /\bnew\s+(?:Anthropic|OpenAI)\b/,
        /api\.(?:anthropic|openai)\.com/i,
      ]
      for (const [name, source] of Object.entries(ACCOUNT_SOURCES)) {
        for (const pattern of subscriptionCredential) {
          assert.ok(!pattern.test(source),
            `${name} touches a provider subscription credential (${pattern}), so "not a login to Claude or ChatGPT" is no longer true`)
        }
      }
      /* And the scopes, checked against the constant the flow actually sends
         rather than against the sentence. A widened scope list is what would
         turn the identity flow into an access grant. */
      assert.deepEqual([...SIGNIN_SCOPES], ['openid', 'email', 'profile'],
        'the Google sign-in scopes are no longer openid/email/profile, so this is no longer only an identity assertion')
    },
  },
  {
    claim: 'this one never asks for them',
    stillTrueBecause: 'the account flow has no field, channel, or storage key for a Claude or ChatGPT credential, and the Google account record has no token field of any kind -- only a subject identifier and a verified address.',
    pin() {
      const store = ACCOUNT_SOURCES['shell/product-account.cjs']
      /* NARROWED, AND SAID WHY. The old pin refused the bare word "provider"
         anywhere in the store. That was a fine proxy while the store knew about
         no identity provider at all; it is a false alarm now that a record
         legitimately says `provider: 'google'`. The promise was never about the
         WORD -- it is about not asking anybody for a provider's password or key,
         so that is what is checked. */
      const asksForOne = /claude|chatgpt|gemini|anthropic|openai|apiKey|api_key|providerPassword|providerToken/i
      assert.ok(!asksForOne.test(store),
        'the store now names a provider credential, so "this one never asks for them" needs re-checking')
      /* THE GOOGLE RECORD HOLDS NO TOKEN. This is the specific thing that would
         make the sentence false, and it is checked on the field names the
         record could store one in. */
      /* A FIELD, not the word. `REQUIRED_IDENTITY_ASSURANCE = "id_token-verified"`
         is the name of a check that has to have happened -- the opposite of a
         stored token -- and a bare-word scan flags it. What a stored token
         would look like is an assignment, so that is what this matches. */
      const tokenField = /(?:accessToken|access_token|refreshToken|refresh_token|idToken|id_token|bearerToken)\s*[:=]/i
      assert.ok(!tokenField.test(store),
        'the account store now holds a Google token, which it must never do -- the product calls no Google API on anybody\'s behalf')
    },
  },
  {
    /* THE ACCOUNTS MENU'S ONE PROMISE, and the only mode on it that makes one.
       Every other selection mode describes an ordering; `manual` promises an
       ABSENCE -- that this computer will stop rather than move onto another of
       your subscriptions without being asked. That is a promise about money,
       so it is pinned rather than parked with the reports. */
    claim: 'Never changes account on its own',
    stillTrueBecause: 'the mode the sentence describes is marked `automatic: false` in the engine\'s own selection table, rotation.js decides whether to move by asking that table rather than by re-deriving it, and the not-automatic branch returns ACCOUNT_EXHAUSTED_MANUAL with the ready account named instead of committing a switch.',
    pin() {
      /* THE PACKAGED COPY, not the engine checkout beside it, and the same one
         tools/test/account-registry.test.mjs reads. What ships decides whether
         the sentence is true; a checkout the customer does not have cannot. */
      const modes = stripComments(read('capability/src/lib/multi-account/selection-modes.js'))
      /* The table entry itself. `manual` promising automatic:true would make
         the sentence false while every other test stayed green. */
      const manual = modes.slice(modes.indexOf("id: MODE.MANUAL"), modes.indexOf('id: MODE.PRIORITY'))
      assert.match(manual, /automatic:\s*false/,
        'the manual mode is no longer marked non-automatic, so "Never changes account on its own" is no longer true')

      const rotation = stripComments(read('capability/src/lib/multi-account/rotation.js'))
      /* And that the decision is TAKEN from that table. A copy of the rule
         here is a copy that can drift; asking isAutomatic is what keeps the
         sentence and the behaviour the same fact. */
      assert.match(rotation, /const automatic = isAutomatic\(chosenSelection\)/,
        'rotation no longer reads the mode table to decide whether it may switch')
      assert.match(rotation, /if \(selection\.switched && !automatic\)/,
        'rotation no longer gates the switch on the chosen mode being automatic')
      assert.match(rotation, /CODE\.EXHAUSTED_MANUAL/,
        'the stop-and-tell-them branch is gone, so a non-automatic mode would switch silently')
    },
  },
  {
    /* THE OTHER PROMISE ON THAT MENU, and the one most likely to stop being
       true by accident. "Check allowances" is a button on a surface about
       spending, pressed by somebody deciding which subscription to spend; the
       obvious way to find out whether an account can serve is to make it serve
       something, and that would silently start charging the person for looking.
       So the promise is pinned to the METHODS the check is allowed to use. */
    claim: 'Checks the latest allowance information for each account. This does not start an agent.',
    stillTrueBecause: 'the Codex side asks only the two zero-token account questions over the app-server protocol and never a completion, exec or turn method; the installed Claude reader sends only a get_usage control request without a user message, and its auth check disables capability probing; the Grok side opens its agent only to authenticate with the cached sign-in and ask `_x.ai/billing`, the read behind Grok\'s own /usage screen, and never opens a session; the Antigravity side runs only `agy models` and the print-mode `/quota`, which agy documents as starting no turn and spending no quota; and the panel read never commits a selection, writes rotation state, or starts a session.',
    async pin() {
      /* COMMENTS STRIPPED FIRST, for the inverse of the reason stripComments
         exists further up. There a prohibition passed because its own
         documentation satisfied it; here a prohibition FAILED because the
         module explains at length why it does not take a `--print` turn, and
         the word appeared in the sentence saying so. Both are the same mistake:
         reading prose as code. */
      const health = stripComments(read('capability/src/lib/multi-account/health.js'))
      /* A METHOD THIS PIN CANNOT READ IS REFUSED OUTRIGHT. The lists below are
         read off quoted literals, so a method sent through a constant or a
         variable would pass every one of them unseen -- which is how the Grok
         billing read first shipped (engine 67e2741a named it through a
         constant). Every method must be spelled where this pin can see it. */
      const opaque = [...health.matchAll(/\bmethod:\s*(?!')[^\s,}]+/g)].map(match => match[0])
      assert.deepEqual(opaque, [],
        'a health probe now names a JSON-RPC method through an identifier this pin cannot read, so a paid call could hide behind it')
      const methodsIn = source => [...source.matchAll(/method:\s*'([^']+)'/g)].map(match => match[1]).sort()
      /* THE CODEX TRANSPORT, EXACTLY AS IT ALWAYS WAS. `initialize` is the
         handshake; the other two are the account surface, both documented as
         costing zero tokens. A fourth appearing here is the thing this promise
         is about, whatever it is called. */
      const codex = health.slice(health.indexOf('function appServerRequest'), health.indexOf('async function probeAccount'))
      assert.ok(codex.length > 400, 'appServerRequest was not found, so the Codex half of this promise is pinned to nothing')
      assert.deepEqual(methodsIn(codex), ['account/rateLimits/read', 'account/read', 'initialize'],
        'the Codex health probe now calls a method beyond the two free account reads, so "spends none of your allowance" is no longer true')
      /* THE GROK READ, ADDED ON THE OWNER'S REQUEST (2026-09-10 23:18Z, "also
         gemini and grok need usage available to see"; engine 67e2741a). Three
         methods and no others: the ACP `initialize` handshake, the
         `authenticate` the agent itself advertises for its cached sign-in
         (`cached_token`, headless -- no model call), and `_x.ai/billing`, the
         read behind Grok CLI 1.0.25's own /usage screen, which its docs say
         works from the dashboard where "there is no session". Measured
         2026-09-10 (claude-finish-20260910/usage/evidence/
         grok-billing-probe-result-underscore.json): the three answered without
         a session ever being opened. `session/new` or `session/prompt` is what
         would start work, and the next assertion refuses any session method. */
      const grok = health.slice(health.indexOf('function grokBillingExchange'), health.indexOf('async function probeGrokAccount'))
      assert.ok(grok.length > 400, 'grokBillingExchange was not found, so the Grok half of this promise is pinned to nothing')
      assert.deepEqual(methodsIn(grok), ['_x.ai/billing', 'authenticate', 'initialize'],
        'the Grok allowance read now calls a method beyond its handshake, cached sign-in and billing read, so "spends none of your allowance" is no longer true')
      /* AND NOTHING ELSE, ANYWHERE IN THE FILE: the whole list is exactly the
         two transports above, so a method added outside either still fails. */
      assert.deepEqual(methodsIn(health), ['_x.ai/billing', 'account/rateLimits/read', 'account/read', 'authenticate', 'initialize', 'initialize'],
        'a health probe now calls a method outside the Codex account reads and the Grok billing read, so "spends none of your allowance" is no longer true')
      assert.ok(!/session\//.test(health),
        'a health probe now names an ACP session method, which opens a conversation, so "starts no work" is no longer true')
      /* THE ANTIGRAVITY READ, SAME REQUEST AND COMMIT. It is a command line,
         not a JSON-RPC method, so it is pinned by its arguments: the catalogue
         (`agy models`) and the print-mode `/quota`, which agy 1.2.0's own
         changelog says answers "without starting an agent turn, spending
         quota, or leaving a conversation behind" (measured: num_turns 0,
         total_tokens 0 -- usage/evidence/agy-quota-json.stdout). Any other
         print-mode prompt would be a paid turn. */
      assert.match(health, /const AGY_QUOTA_ARGS = Object\.freeze\(\['-p', '\/quota', '--output-format', 'json'\]\)/,
        'the Antigravity allowance read is no longer the print-mode /quota, so it may start a turn')
      assert.match(health, /const ANTIGRAVITY_CATALOG_ARGS = Object\.freeze\(\['models'\]\)/,
        'the Antigravity catalogue read is no longer `agy models`')
      assert.deepEqual([...health.matchAll(/\brun\(([A-Z_]+)\)/g)].map(match => match[1]), ['ANTIGRAVITY_CATALOG_ARGS', 'AGY_QUOTA_ARGS'],
        'the Antigravity probe now runs agy with arguments other than the catalogue and /quota')
      assert.equal((health.match(/'-p'/g) || []).length, 1,
        'a health probe now passes a second print-mode prompt, which would start a turn')
      assert.deepEqual([...health.matchAll(/args:\s*\[([^\]]*)\]/g)].map(match => match[1]),
        ["'--no-auto-update', 'inspect', '--json'", "'--no-auto-update', 'agent', '--no-leader', 'stdio'"],
        'the Grok allowance read now runs grok with arguments other than its inspection and the stdio agent')

      const rotation = stripComments(read('capability/src/lib/multi-account/rotation.js'))
      const usage = rotation.slice(rotation.indexOf('async function readAccountUsage'),
        rotation.indexOf('function activeAccountRecord'))
      assert.ok(usage.length > 400, 'readAccountUsage was not found, so this promise is pinned to nothing')
      for (const forbidden of ['resolveForLaunch', 'commitLaunchSelection', 'writeState', 'switchTo']) {
        assert.ok(!usage.includes(forbidden),
          `readAccountUsage now calls ${forbidden}, so reading the menu changes which account runs and "starts no work" is no longer true`)
      }

      /* The installed dependency is the live control reader. The old cache
         diagnostic is no longer shipped. Pin that wiring, then run the actual
         packed reader against a synthetic transport: its sole stdin message
         must ask for usage, never supply a prompt. No provider is executed. */
      const rotationAst = parseAst(rotation)
      const functionSource = name => {
        const node = rotationAst.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === name)
        assert.ok(node, `${name} is missing from the installed rotation module`)
        return rotation.slice(node.start, node.end)
      }
      const loader = functionSource('defaultClaudeUsageProbe')
      assert.match(loader, /require\('\.\.\/providers\/claude-usage-probe\.js'\)/)
      assert.match(loader, /return loaded && typeof loaded\.claudeUsageProbe === 'function' \? loaded\.claudeUsageProbe : null/)
      const factory = functionSource('claudeProbeFactory')
      assert.match(factory, /const liveProbe = usageProbe === undefined \? defaultClaudeUsageProbe\(\) : usageProbe/)
      assert.deepEqual([...factory.matchAll(/\baskAuth\s*\(([^)]*)\)/g)].map(match => match[1]),
        ['{ capability: false, configDir, fsImpl }'], 'allowance checking must not enable a paid auth capability probe')

      const { claudeUsageProbe } = createRequire(import.meta.url)('../../capability/src/lib/providers/claude-usage-probe.js')
      const root = mkdtempSync(path.join(tmpdir(), 'account-allowance-contract-'))
      const configDir = path.join(root, 'empty-account'), cwd = path.join(root, 'empty-project')
      mkdirSync(configDir, { mode: 0o700 }); mkdirSync(cwd, { mode: 0o700 })
      const command = path.join(root, 'never-executed-claude')
      const calls = [], writes = [], ends = [], kills = []
      let closed = false
      try {
        const result = await claudeUsageProbe({
          configDir, cwd, executable: { command, prefixArgs: [] }, timeoutMs: 1000, exitGraceMs: 20,
          baseEnvironment: { HOME: root, USERPROFILE: root, CLAUDECODE: 'synthetic-parent', ANTHROPIC_API_KEY: 'synthetic-never-used' },
          now: () => 1234,
          spawnImpl(command, args, options) {
            calls.push({ command, args, options })
            const child = new EventEmitter()
            child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter()
            // Match the installed retained-child contract (Engine 49d3424e):
            // direct close alone does not prove descendant and pipe closure.
            // These receipts describe this fake transport only; no OS child
            // or authenticated native process receipt is claimed by this test.
            let finishJob, finishPipes
            child.jobOutcome = new Promise(resolve => { finishJob = resolve })
            child.jobClosed = new Promise(resolve => { finishPipes = resolve })
            const close = code => {
              if (closed) return
              closed = true
              child.emit('close', code)
              finishJob({ type: 'exit', activeProcesses: 0, exitCode: code })
              finishPipes({ failure: null })
            }
            child.terminateJob = () => {
              assert.equal(closed, true, 'this normal reply must close on stdin end before cleanup confirmation')
              return child.jobOutcome
            }
            child.stdin.write = text => {
              writes.push(String(text))
              const request = JSON.parse(text)
              queueMicrotask(() => child.stdout.emit('data', Buffer.from(JSON.stringify({
                type: 'control_response', response: { subtype: 'success', request_id: request.request_id,
                  response: { rate_limits_available: true, subscription_type: 'synthetic-plan',
                    rate_limits: { five_hour: { utilization: 17, resets_at: '2031-01-01T01:00:00Z' } } } }
              }) + '\n')))
              return true
            }
            child.stdin.end = (...args) => {
              ends.push(args)
              queueMicrotask(() => close(0))
            }
            child.kill = signal => { kills.push(signal); close(null) }
            return child
          },
        })
        assert.equal(result.status, 'MEASURED')
        assert.equal(result.source, 'claude-get-usage')
        assert.equal(result.limits[0].percent, 17, 'the installed reader must consume its matching usage reply')
        assert.equal(calls.length, 1)
        assert.equal(calls[0].command, command)
        assert.deepEqual(calls[0].args, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'])
        assert.equal(calls[0].options.cwd, cwd)
        assert.equal(calls[0].options.env.CLAUDE_CONFIG_DIR, configDir)
        assert.equal(calls[0].options.env.ANTHROPIC_API_KEY, undefined)
        assert.equal(calls[0].options.env.CLAUDECODE, undefined)
        assert.equal(calls[0].options.shell, false)
        assert.deepEqual(calls[0].options.stdio, ['pipe', 'pipe', 'pipe'])
        assert.equal(writes.length, 1, 'allowance checking must send exactly one control request')
        const request = JSON.parse(writes[0])
        assert.match(request.request_id, /^usage-\d+-\d+$/)
        assert.equal(writes[0], JSON.stringify({ type: 'control_request', request_id: request.request_id,
          request: { subtype: 'get_usage' } }) + '\n', 'allowance checking must not send a user message or another control action')
        assert.deepEqual(ends, [[]], 'stdin must close without a final prompt')
        assert.deepEqual(kills, [])
        assert.equal(closed, true, 'the reader must await the synthetic transport closing')
        assert.deepEqual(readdirSync(configDir), [])
        assert.deepEqual(readdirSync(cwd), [])
      } finally { rmSync(root, { recursive: true, force: true }) }
    },
  },
  {
    claim: 'so no account was created',
    stillTrueBecause: 'every refusal in createAccount returns before the single writeStore call, so a refused creation leaves the account file byte-identical. Verified behaviourally for every reachable refusal, and by call order for the one that needs a failing keystore to reach.',
    pin() {
      const store = ACCOUNT_SOURCES['shell/product-account.cjs']
      const create = store.slice(store.indexOf('async function createAccount'), store.indexOf('const BAD_CREDENTIALS'))
      assert.equal((create.match(/writeStore\(/g) || []).length, 1, 'createAccount writes more than once, so a refusal could leave a partial account')
      assert.ok(create.indexOf("ACCOUNT_HASH_FAILED") < create.indexOf('writeStore('),
        'the hash-failure refusal now comes after the write, so "no account was created" would be false')
    },
  },
  {
    claim: 'so nothing was changed',
    stillTrueBecause: 'changePassword returns on every refusal before its single writeStore call, so a refused change leaves the old verifier and the old epoch intact. The behavioural half is proved in product-account.test.mjs: after a refused change the old password still works and the session is untouched.',
    pin() {
      const store = ACCOUNT_SOURCES['shell/product-account.cjs']
      /* BOUNDED AT BOTH ENDS, and it was not. This used to slice to the end of
         the file, which counted every later `writeStore` as one of
         changePassword's -- correct only for as long as changePassword happened
         to be the last mutation in the file. `changeDisplayName` was added
         after it and the pin failed on code that is not the code it is about.
         An assertion whose subject depends on file order is an assertion that
         reports the wrong function. It is pinned by its own end marker now, and
         changeDisplayName gets its own pin below because it makes the SAME
         promise and therefore owes the same proof. */
      const change = store.slice(store.indexOf('async function changePassword'), store.indexOf('function changeDisplayName'))
      assert.ok(change.length > 400, 'the changePassword slice is empty or unbounded; its end marker moved')
      assert.equal((change.match(/writeStore\(/g) || []).length, 1, 'changePassword writes more than once, so a refusal could leave a partial change')
      assert.ok(change.indexOf("ACCOUNT_HASH_FAILED") < change.indexOf('writeStore('),
        'the hash-failure refusal now comes after the write, so "nothing was changed" would be false')
      /* THIS ASSERTION WAS VACUOUS AND MUTATION TESTING CAUGHT IT.
         It used to be `change.includes('currentPassword')`, which stays true
         when the actual proof is deleted -- the name survives in the
         signature and the type check. Planting `|| false` in place of the
         verify call left it green; only the behavioural suite noticed. An
         assertion that cannot fail is worse than none, because it is counted
         as coverage. This one matches the awaited call itself. */
      assert.ok(/await verifyPassword\(currentPassword/.test(change),
        'changePassword no longer proves the current password before changing it')

      /* THE SAME SENTENCE, SAID BY THE RENAME PATH, PROVED THE SAME WAY.
         `changeDisplayName` refuses with "so nothing was changed" four times.
         Each refusal must return before its single write, or the sentence is
         false on whichever branch does not. */
      const rename = store.slice(store.indexOf('function changeDisplayName'), store.indexOf('/* ------------------------- the account partition'))
      assert.ok(rename.length > 400, 'the changeDisplayName slice is empty; its markers moved')
      assert.equal((rename.match(/writeStore\(/g) || []).length, 1,
        'changeDisplayName writes more than once, so a refusal could leave a partial change')
      const firstWrite = rename.indexOf('writeStore(')
      for (const code of ['ACCOUNT_NOT_SIGNED_IN', 'ACCOUNT_DISPLAY_NAME_INVALID', 'ACCOUNT_STORE_CORRUPT', 'ACCOUNT_DISPLAY_NAME_UNCHANGED']) {
        const at = rename.indexOf(code)
        assert.ok(at !== -1 && at < firstWrite,
          `${code} is gone or now comes after the write, so "nothing was changed" would be false on that branch`)
      }
    },
  },
  {
    /* THE PROMISE THE FIRST-RUN WALKTHROUGH MAKES, added when the "Shown as"
       field landed there. It is the strongest promise on that screen and it is
       made at the worst moment to break one: a person is ninety seconds into
       the product, deciding whether to type a name at all. The walkthrough used
       to pass a hardcoded empty display name, so the USERNAME became the
       permanent label on every record of their work -- the exact defect this
       sentence now promises does not exist. If the rename path ever goes, this
       sentence becomes a lie told to first-time users, so it is pinned to the
       thing that makes it true rather than to its own wording. */
    claim: 'nothing you choose here is permanent',
    stillTrueBecause: 'the walkthrough now passes the typed name (src/views/setup.js hands `displayName` to account.create instead of the empty string it used to hardcode), and changeDisplayName in shell/product-account.cjs is what lets it be changed afterwards -- which is the same mechanism the rename promise above is pinned to.',
    pin() {
      /* READ FROM DISK, NOT FROM ACCOUNT_SOURCES. discoverAccountSources only
         collects files whose NAME matches /account/, so src/views/setup.js is
         not in it -- and the first version of this pin did
         `ACCOUNT_SOURCES['src/views/setup.js'] || ''`, which made the
         hardcoded-empty-name check pass vacuously against an empty string. That
         is the absence-read-as-consent defect this suite exists to catch,
         committed inside a guard written to catch it. Read the file, and fail
         loudly if it is not there. */
      const setupPath = path.join(REPO_ROOT, 'src', 'views', 'setup.js')
      let setupRaw
      try {
        setupRaw = readFileSync(setupPath, 'utf8')
      } catch (error) {
        assert.fail(`src/views/setup.js could not be read (${error.code}), so this promise cannot be checked -- absent is not proof`)
      }
      assert.ok(setupRaw.length > 200,
        `src/views/setup.js read as ${setupRaw.length} characters, which is not the walkthrough`)
      const setup = stripComments(setupRaw)
      assert.ok(!/displayName:\s*''/.test(setup),
        'the walkthrough hardcodes an empty display name again, so the username becomes the permanent label and this promise is false')
      assert.ok(/account\.create\(\{[^)]*displayName[^)]*\)/.test(setup),
        'the walkthrough no longer passes a display name to create, so what the person typed is discarded')
      const markup = ACCOUNT_SOURCES['src/account-markup.js'] || ''
      assert.ok(markup.includes('data-setup-account-field="displayName"'),
        'the "Shown as" field is gone from the walkthrough, so the sentence promises about a field that no longer exists')
      const store = ACCOUNT_SOURCES['shell/product-account.cjs']
      assert.ok(store.includes('function changeDisplayName'),
        'the rename path is gone, so "nothing you choose here is permanent" is no longer true')
    },
  },
  {
    /* THE PROMISE THE RENAME SCREEN MAKES, and the one a person actually acts
       on: they will only press Save if renaming themselves is safe for what
       they already did. */
    claim: 'never re-labels or hides anything you already did',
    stillTrueBecause: 'a run is recorded against `account:<id>` -- shell/spawn-record.cjs writes the principal the main process read from the store -- and changeDisplayName writes exactly one field, `displayName`. It cannot reach `id`, and the account screen counts a person\'s own runs by comparing the id, so no past record changes hands or changes label when the name changes.',
    pin() {
      const store = ACCOUNT_SOURCES['shell/product-account.cjs']
      const rename = store.slice(store.indexOf('function changeDisplayName'), store.indexOf('/* ------------------------- the account partition'))
      assert.ok(rename.length > 400, 'the rename path is gone, so this promise is about nothing')
      /* The write must be a spread that replaces ONE field. A rename that
         assigned a whole record could take the id with it. */
      assert.ok(/\{ \.\.\.entry, displayName: next \}/.test(rename),
        'changeDisplayName no longer writes exactly one field, so it may now touch the id a record is filed under')
      for (const field of ['id:', 'epoch:', 'username:', 'identity:', 'verifier:']) {
        assert.ok(!rename.includes(field),
          `changeDisplayName now writes ${field} -- renaming must not touch the identity a past record is filed under`)
      }
      /* And the page must not be able to name the account it renames. */
      assert.ok(!/accountId|account\.id\s*=/.test(stripComments(ACCOUNT_SOURCES['src/views/account.js']).slice(
        stripComments(ACCOUNT_SOURCES['src/views/account.js']).indexOf("kind === 'display-name'"),
        stripComments(ACCOUNT_SOURCES['src/views/account.js']).indexOf("const currentPassword"),
      )), 'the rename action now sends an account id, which would let a page rename somebody else')
    },
  },
  {
    claim: 'kept for you and not for whoever else uses the computer you are driving',
    stillTrueBecause: 'the account partition is one file per account id under <userData>/accounts/. The id comes from the main-process session; a renderer may provide only an expectedAccountId comparison fence, never an account selector, and the synchronous store refuses it unless it equals that session id. A second account therefore cannot be handed the first one\'s file.',
    pin() {
      const store = ACCOUNT_SOURCES['shell/product-account.cjs']
      /* The file name IS the account id, so the id must be shape-checked
         immediately before it is joined to a path. Without this, a record's own
         field becomes a path traversal. */
      const dataPath = store.slice(store.indexOf('function accountDataPath'))
      assert.ok(/\^\[0-9a-f\]\{32\}\$/.test(dataPath.slice(0, 400)),
        'accountDataPath no longer validates the account id before joining it to a path')
      /* Every partition read and write starts from `current()`, which reads the
         main-process session. A function that took an account id from its
         caller would be one a page could aim. */
      for (const name of ['function accountDataForRenderer', 'function getSetting', 'function putSetting', 'function attachPaymentMethod']) {
        const slice = store.slice(store.indexOf(name), store.indexOf(name) + 300)
        assert.ok(/const state = current\(\)/.test(slice),
          `${name} no longer takes the account from the signed-in session, so a caller could choose whose data it reads`)
      }
      /* A supplied expectedAccountId is permitted only as a comparison fence.
         The two setting handlers forward it unchanged to the store; neither
         takes accountId as a selector or derives a partition from page input. */
      const main = stripComments(MAIN)
      const settingHandlers = main.match(/ipcMain\.handle\('mc-account:setting-(?:get|put)'[\s\S]*?\n  \}\)\)/g) || []
      assert.equal(settingHandlers.length, 2, 'the two fenced setting handlers are no longer discoverable')
      for (const handler of settingHandlers) {
        assert.ok(/Object\.hasOwn\(value, 'expectedAccountId'\)/.test(handler)
          && /request\.expectedAccountId = value\.expectedAccountId/.test(handler),
        'a supplied account comparison fence is no longer forwarded verbatim to the synchronous store')
        assert.ok(!/accountId\s*=\s*value/.test(handler),
          'a setting IPC handler now accepts an account selector from the page')
      }
    },
  },
  {
    claim: 'no number, expiry or security code is shown here or anywhere else in this program',
    stillTrueBecause: 'the only payment value any account module holds is a vault KEY NAME. No account module, and no account IPC channel, names a card number, expiry, CVC, PAN, last-four or token field -- there is nowhere for one to arrive from and nowhere to put it.',
    pin() {
      /* A field-name scan, not a value scan: a value cannot be searched for,
         but the FIELD it would have to arrive in can. If none of these names
         exists anywhere in the account surface, no branch can render one. */
      /* FIELD NAMES, not English. The first draft of this list included the
         bare word `expiry`, which matched the very sentence it is guarding --
         "no number, expiry or security code is shown" -- and failed the suite
         on its own copy. Every entry here is a shape a card field would be
         NAMED, and none of them is a word that appears in prose. */
      const cardDetail = /\b(?:cardNumber|card_number|cardnum|pan|cvc|cvv|securityCode|expiryMonth|expiryYear|expMonth|expYear|lastFour|last4|cardToken|paymentToken)\b/i
      for (const [name, source] of Object.entries(ACCOUNT_SOURCES)) {
        assert.ok(!cardDetail.test(stripComments(source)),
          `${name} now names a card-detail field, so "no number, expiry or security code is shown" is no longer true`)
      }
      const main = stripComments(MAIN)
      const paymentChannels = (main.match(/ipcMain\.handle\('mc-account:payment[^;]*\}\)\)/g) || []).join('\n')
      assert.ok(paymentChannels.length > 0, 'the payment channels are no longer discoverable, so this guard is checking air')
      assert.ok(!cardDetail.test(paymentChannels),
        'a payment channel now carries a card detail rather than only a vault key name')
      /* The presence verb answers through an exit code with no stdout, so the
         shell-side reader must not be capturing output either. */
      const presence = stripComments(read('shell/vault-presence.cjs'))
      assert.ok(/stdio: \['ignore', 'ignore', 'ignore'\]/.test(presence),
        'the vault presence check now captures output from the vault program, which is where a value could appear')
    },
  },
  {
    claim: 'Nothing in this program can charge anything without one, and attaching one is not a payment',
    stillTrueBecause: 'attachment writes a vault key name into a JSON file and nothing else. No account module imports or references a payment provider, a charge, a checkout session or a transaction, and the shell attach channel reaches exactly one function whose whole body is a file write.',
    pin() {
      const spend = /\b(?:stripe|paddle|chargeCard|createCharge|createPaymentIntent|captureP(?:ayment|urchase)|billing_checkout|checkout_create|transaction_create|refund)\b/i
      for (const [name, source] of Object.entries(ACCOUNT_SOURCES)) {
        assert.ok(!spend.test(stripComments(source)),
          `${name} can now reach a payment provider, so "attaching one is not a payment" is no longer true`)
      }
      const store = ACCOUNT_SOURCES['shell/product-account.cjs']
      const attach = store.slice(store.indexOf('function attachPaymentMethod'))
      const body = attach.slice(0, attach.indexOf('\n  }\n') + 5)
      assert.ok(!spend.test(body), 'attachPaymentMethod now reaches a payment path')
      /* It must not read the vault either. Attachment names a record; reading
         one is a different capability with a different review. */
      assert.ok(!/getSecret|readSecret|decrypt|Unprotect/i.test(body),
        'attachPaymentMethod now reads the vault record it is only supposed to name')
      /* And the key it will accept is an allowlist, not a pattern -- so a page
         cannot widen what counts as "a payment method". */
      assert.ok(/PAYMENT_VAULT_KEYS\.includes\(vaultKey\)/.test(body),
        'attachPaymentMethod no longer checks the vault key against the fixed allowlist')
      assert.ok(!store.includes("PAYMENT_VAULT_KEYS = Object.freeze(['payment_card_default', 'owner_legal_identity_v1'"),
        'the identity record is now attachable as a payment method')
    },
  },
  {
    /* ---- the three promises Google sign-in adds ---- */
    claim: 'never into this program',
    stillTrueBecause: 'the authorization URL is handed to the operating system\'s browser through shell.openExternal. No account module and no part of the sign-in flow opens a BrowserWindow, a webview or an iframe on a Google address, and there is no password field anywhere on the Google path -- so there is nowhere for a Google password to be typed into this program.',
    pin() {
      const flow = stripComments(read('shell/google-signin.cjs'))
      /* An embedded window showing Google's sign-in page is the exact thing
         this sentence promises does not happen, and it is what Google itself
         refuses. The flow must not be able to build one. */
      assert.ok(!/BrowserWindow|webContents|<webview|createElement\(.iframe.\)/i.test(flow),
        'the Google sign-in flow can now open a window of its own, so the password would be typed into this program after all')
      assert.ok(/openExternal/.test(stripComments(MAIN)),
        'the shell no longer hands the sign-in URL to the system browser')
      /* AND THE GOOGLE OPTION ITSELF COLLECTS NOTHING. Rendered rather than
         searched: the first version of this scanned every source line that
         mentioned Google for the word `password`, and it fired on the sentence
         'there is no password here to change' -- a guard matching the copy that
         states the promise. What it should check is that the option a person
         presses has no field on it, and that can only be seen by building it. */
      for (const google of [null, { available: false, code: 'X', reason: 'no id' }, { available: true, source: 'shipped', testProvider: null }]) {
        for (const busy of [false, true]) {
          const rendered = googleOptionMarkup({ google, busy })
          assert.ok(!/<input|type="password"|autocomplete=/i.test(rendered),
            `the Google option renders an input field when google=${JSON.stringify(google)} busy=${busy}`)
        }
      }
    },
  },
  {
    claim: 'It gets no access to your Drive, your Gmail or your Calendar',
    stillTrueBecause: 'the scope list sent to Google is the frozen constant SIGNIN_SCOPES = openid, email, profile. None of them grants read or write access to any Google service, and the flow refuses to start if the list ever contains a service marker.',
    pin() {
      assert.deepEqual([...SIGNIN_SCOPES], ['openid', 'email', 'profile'],
        'the requested scopes changed, so the promise about Drive, Gmail and Calendar needs re-checking')
      /* The runtime guard, not just the constant: a widened list must stop the
         flow rather than quietly ask for more. */
      const flow = stripComments(read('shell/google-signin.cjs'))
      assert.ok(/GOOGLE_SIGNIN_SCOPE_REFUSED/.test(flow),
        'the flow no longer refuses to start when the scopes reach a service')
    },
  },
  {
    claim: 'Nothing is signed in until you do',
    stillTrueBecause: 'the view awaits the shell\'s reply and only calls refresh() -- the read that decides what the screen says -- after it. Every failure path repaints from the same read, so a sign-in that did not complete leaves the screen showing signed out.',
    pin() {
      const view = ACCOUNT_SOURCES['src/views/account.js']
      const start = view.slice(view.indexOf('async function startGoogleSignIn'), view.indexOf('function onClick'))
      assert.ok(start.length > 200, 'the Google sign-in action is gone, so this promise is about nothing')
      /* There must be no assignment that makes the screen say signed-in
         without going through the state read. */
      assert.ok(!/states*=s*{/.test(start), 'the Google action now writes the signed-in state directly instead of re-reading it')
      assert.ok(/await refresh\(\)/.test(start), 'the Google action no longer re-reads who is signed in')
      /* And the failure branch must repaint from that read too. */
      const failure = start.slice(start.indexOf('if (!result.ok)'))
      assert.ok(/await refresh\(\)/.test(failure), 'a failed Google sign-in no longer re-reads the account state')
    },
  },

  /* ---- removing this computer's data ----
   *
   * These four are the strongest sentences on the whole surface, because the act
   * they describe is the only irreversible one the product offers. Each is
   * pinned to a mechanical fact in shell/local-data-reset.cjs, which is the
   * module that does the deleting; the behavioural half -- that the sweep really
   * removes what it says and really reports what it could not -- is
   * tools/test/local-data-reset.test.mjs, and the packaged half is
   * tools/uninstall-reset-packaged-qa.mjs. */
  {
    claim: 'Nothing has been deleted.',
    stillTrueBecause: 'the measuring step and the deleting step are two separate IPC channels. mc-reset:plan reaches planReset(), which reads and stats and nothing else -- there is no rm, unlink, rmdir or truncate anywhere in the plan path -- so the first press cannot destroy anything.',
    pin() {
      const module = stripComments(read('shell/local-data-reset.cjs'))
      /* planReset'S OWN BODY, bounded by the next function of ANY name rather
         than by one particular later function. This ended at
         `function eraseDirectory`, which held only while nothing sat between the
         two -- a helper landed there (removeTree, the leaf-by-leaf sweep that
         stops one locked file sheltering its siblings) and the pin began reading
         ITS deletes as the measuring path's, reporting as false a sentence that is
         still exactly true. A boundary that depends on what happens to be next in
         the file is not a boundary. */
      const planStart = module.indexOf('function planReset')
      const nextFunction = module.indexOf('\nfunction ', planStart + 1)
      const plan = module.slice(planStart, nextFunction === -1 ? module.length : nextFunction)
      assert.ok(plan.length > 400, 'planReset is gone, so the sentence shown while measuring is about nothing')
      assert.ok(!/\b(?:rmSync|unlinkSync|rmdirSync|truncateSync|writeFileSync|renameSync)\b/.test(plan),
        'the measuring path now writes or deletes, so "Nothing has been deleted" is no longer true')
      /* And the two channels must still be two. */
      const main = stripComments(MAIN)
      assert.ok(main.includes("ipcMain.handle('mc-reset:plan'") && main.includes("ipcMain.handle('mc-reset:erase'"),
        'the measure and the act are no longer separate channels')
      const planHandler = main.slice(main.indexOf("ipcMain.handle('mc-reset:plan'"), main.indexOf("ipcMain.handle('mc-reset:erase'"))
      assert.ok(!/eraseLocalData|eraseDirectory/.test(planHandler), 'the measuring channel now deletes')
    },
  },
  {
    claim: 'It cannot be undone, and it does not uninstall the program.',
    stillTrueBecause: 'the module keeps no copy of what it removes -- no copy, no rename, no archive, no recycle bin -- so there is nothing to restore from; and it starts no process, so it cannot run the uninstaller either. Both halves are absences in the same file.',
    pin() {
      const module = stripComments(read('shell/local-data-reset.cjs'))
      assert.ok(!/\b(?:copyFileSync|cpSync|renameSync|createWriteStream|archive|backup)\b/i.test(module),
        'the reset now keeps a copy somewhere, so "it cannot be undone" needs re-checking')
      /* Narrow on purpose: requiring shell/uninstall-retention.cjs for its
         measurement is exactly what this module is supposed to do, so the
         pattern names ways of STARTING something rather than the word
         "uninstall". */
      assert.ok(!/child_process|spawnSync|spawn\(|exec(?:File)?Sync|\.exe\b|shell\.openPath|app\.relaunch/i.test(module),
        'the reset now starts a process, so "it does not uninstall the program" needs re-checking')
    },
  },
  {
    claim: 'There is no undo and no copy anywhere else.',
    stillTrueBecause: 'the same absence as above, said where it matters most -- immediately above the button that destroys the data. Nothing in the reset path writes a copy of anything it deletes.',
    pin() {
      const module = stripComments(read('shell/local-data-reset.cjs'))
      assert.ok(!/\b(?:copyFileSync|cpSync|renameSync|createWriteStream)\b/.test(module),
        'something in the reset path now copies data before deleting it')
    },
  },
  {
    claim: 'Nothing in them is opened, moved or deleted here',
    stillTrueBecause: 'a folder the person chose for their own work is put in the plan\'s `untouched` list, which the erase path never reads -- and if it happens to sit INSIDE a directory being swept, it goes in `conflicts` instead and the screen says so in a serious notice. The sentence therefore cannot be silently false for the one person it would be false for.',
    pin() {
      const module = stripComments(read('shell/local-data-reset.cjs'))
      assert.ok(/untouched\.push\(\{ kind: 'workspace'/.test(module),
        'workspace roots are no longer recorded as untouched')
      assert.ok(/conflicts\.push\(\{ kind: 'workspace'/.test(module),
        'a chosen folder inside the swept directory is no longer detected, so this promise can now be quietly false')
      /* planReset'S OWN BODY, bounded by the next function of ANY name rather
         than by one particular later function. This ended at
         `function eraseDirectory`, which held only while nothing sat between the
         two -- a helper landed there (removeTree, the leaf-by-leaf sweep that
         stops one locked file sheltering its siblings) and the pin began reading
         ITS deletes as the measuring path's, reporting as false a sentence that is
         still exactly true. A boundary that depends on what happens to be next in
         the file is not a boundary. */
      const planStart = module.indexOf('function planReset')
      const nextFunction = module.indexOf('\nfunction ', planStart + 1)
      const plan = module.slice(planStart, nextFunction === -1 ? module.length : nextFunction)
      assert.ok(!/roots\.push\([^)]*workspace/i.test(plan), 'a workspace root can now reach the list of things to delete')
      /* The screen must SAY it, not merely compute it. */
      const markup = stripComments(read('src/account-markup.js'))
      assert.ok(/data-reset-conflict/.test(markup) && /plan\.conflicts/.test(markup),
        'the confirm screen no longer renders the conflicting-folder warning')
      const main = stripComments(MAIN)
      const erase = main.slice(main.indexOf("ipcMain.handle('mc-reset:erase'"))
      assert.ok(/const sweepRoots = plan\.roots\.filter\(/.test(erase) && /roots: sweepRoots/.test(erase),
        'the erase channel no longer takes its directories from the measured plan')
      assert.ok(!/plan\.untouched|plan\.conflicts/.test(erase),
        'the erase channel now reads the list of folders it is supposed to leave alone')
    },
  },
  {
    claim: 'deleting here cannot reach any of it and does not undo it',
    stillTrueBecause: 'the reset path has no network access of any kind -- no fetch, no socket, no node networking module -- so it cannot reach a service, a mailbox or a Google account to undo anything that already left this computer.',
    pin() {
      const network = /\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|require\(\s*['"](?:node:)?(?:http|https|net|dns|tls|dgram)['"]\s*\)|from\s+['"](?:node:)?(?:http|https|net|dns|tls|dgram)['"]/
      assert.ok(!network.test(stripComments(read('shell/local-data-reset.cjs'))),
        'the reset module can now reach the network, so what it claims it cannot reach needs re-checking')
    },
  },
  {
    claim: 'There is no server involved',
    stillTrueBecause: 'the same fact the sign-in copy already rests on: no account module can reach the network, so an account and its sessions exist on this computer and nowhere else. Signing out everywhere is therefore complete by construction rather than by a service being asked.',
    pin() {
      const network = /\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|require\(\s*['"](?:node:)?(?:http|https|net|dns|tls|dgram)['"]\s*\)|from\s+['"](?:node:)?(?:http|https|net|dns|tls|dgram)['"]/
      for (const [name, source] of Object.entries(ACCOUNT_SOURCES)) {
        assert.ok(!network.test(source), `${name} can reach the network, so "There is no server involved" is no longer true`)
      }
      /* And the revocation is still the epoch bump rather than a file delete,
         which is what makes it reach a copy taken off this computer. */
      const store = stripComments(read('shell/product-account.cjs'))
      const revoke = store.slice(store.indexOf('function signOutEverywhere'), store.indexOf('function signOutEverywhere') + 900)
      assert.ok(/epoch: entry\.epoch \+ 1/.test(revoke), 'sign-out-everywhere no longer advances the epoch')
    },
  },
  {
    /* THE PROVIDER PANEL'S OWN PROMISE, and it is the strongest sentence on that
       surface. The panel prints the exact command a person runs to sign one of
       their own provider homes in. Printing a command beside a folder full of
       credentials is only safe while the product genuinely does neither of the
       two things it would be natural to do next -- run it, or read what it
       leaves behind -- so the sentence says both, and this pins both. */
    claim: 'Nothing here runs that line, and nothing here reads what it writes',
    stillTrueBecause: 'shell/account-registry.cjs starts no child process at all, and its single byte-returning call reads only a stable descriptor after an exact product-owned allowlist check plus matching pre-open, descriptor and post-open file identities. No sign-in path can reach it. Asserted against the source and behaviourally against an injected file layer in tools/test/account-registry.test.mjs.',
    pin() {
      const store = ACCOUNT_SOURCES['shell/account-registry.cjs']
      assert.ok(store, 'the provider account store is no longer being scanned by these guards')
      for (const spawner of ['child_process', 'spawn', 'execFile', 'execSync']) {
        assert.ok(!store.includes(spawner),
          `the provider account store can start a program (${spawner}), so "nothing here runs that line" is no longer true`)
      }
      for (const reader of ['createReadStream', 'readSync', 'readdirSync', 'realpathSync', 'readlinkSync']) {
        assert.ok(!store.includes(reader),
          `the provider account store can read bytes another way (${reader}), so "nothing here reads what it writes" is no longer true`)
      }
      /* One path open and one descriptor reader, inside the function that
         refuses every path outside its caller's exact product-owned allowlist.
         Windows Node has no O_NOFOLLOW, so the stable descriptor plus the three
         matching identities is the fence against a post-inspection path swap. */
      assert.equal(store.split('openSync').length - 1, 1,
        'the provider account store has more than one path open')
      assert.equal(store.split('fstatSync').length - 1, 1,
        'the provider account store has more than one descriptor identity check')
      assert.equal(store.split('closeSync').length - 1, 1,
        'the provider account store has more than one descriptor close')
      assert.equal(store.split('readFileSync').length - 1, 1,
        'the provider account store has more than one call that returns bytes')
      const body = store.slice(store.indexOf('function readOwnedBytes'), store.indexOf('function powerShellLiteral'))
      const allowedAt = body.indexOf('allowed.includes(target)')
      const openedAt = body.indexOf('openSync')
      const fstatAt = body.indexOf('fstatSync')
      const readAt = body.indexOf('readFileSync')
      const afterLstatAt = body.lastIndexOf('lstatSync', readAt)
      assert.ok(allowedAt >= 0 && allowedAt < openedAt,
        'the stable open is no longer fenced to an exact product-owned allowlist')
      assert.ok(openedAt < fstatAt && fstatAt < afterLstatAt && afterLstatAt < readAt,
        'the provider store can read bytes before descriptor and post-open path identities agree')
      assert.match(body, /readFileSync\(descriptor\)/,
        'the one byte reader is no longer bound to the proved stable descriptor')
    },
  },
])

for (const entry of REGISTERED_CLAIMS) {
  test(`the promise "${entry.claim}" is still on screen and still true`, () => {
    assert.ok(SHIPPED_COPY.includes(entry.claim),
      `the copy no longer contains "${entry.claim}". If it was reworded, re-register it here with what keeps it true; if it was dropped, delete the entry.`)
    assert.ok(entry.stillTrueBecause.length > 40, 'a registered claim must record WHY it is still true, not just that it is')
    return entry.pin()
  })
}

/* ---- the guard against self-selected coverage ----
 *
 * The first version of this file asserted that five NAMED sentences were
 * registered. That is a hand-written list standing in for the copy, and this
 * repo has already been bitten by exactly that: tools/check-suites-discovered.mjs
 * exists because a hand-written list of 11 test files stood in for a glob over
 * 26, and its comment states the rule -- self-selected coverage cannot fail.
 * My list could not fail either. Measured against the real sources it covered
 * 3 of 13 absolute-shaped sentences.
 *
 * So the sentences are DERIVED from the shipped sources now, and every one must
 * be classified. Two kinds, because collapsing them would be its own lie:
 *
 *   PINNED    - a promise about what this product does or does not do. Needs a
 *               mechanical fact that keeps it true.
 *   REPORTED  - a description of what just happened or what this build cannot
 *               do. "This computer cannot remember a sign-in" is a report about
 *               a keystore, not a promise we could break by writing code.
 *
 * A sentence in neither list fails the suite. Adding copy therefore costs a
 * classification, which is the two-minute speed bump, and the alternative --
 * loosening the pattern until nothing matches -- is the failure mode both lanes
 * hit tonight from opposite directions.
 */

function proseLiterals(source) {
  const code = stripComments(source)
  const found = new Set()
  /* Built with RegExp() rather than written as literals: these patterns need a
     backslash class and a newline class, and every attempt to author them
     inline went through a shell heredoc that ate the escapes and produced a
     regex spanning two lines. Constructing them from strings is escaping I can
     read. The third is a plain literal because it needs neither. */
  const SINGLE_QUOTED = new RegExp("'([^'\\\\\\n]{25,})'", 'g')
  const DOUBLE_QUOTED = new RegExp('"([^"\\\\\\n]{25,})"', 'g')
  const BETWEEN_TAGS = />([^<>{}`$]{25,})</g
  for (const pattern of [SINGLE_QUOTED, DOUBLE_QUOTED, BETWEEN_TAGS]) {
    for (const match of code.matchAll(pattern)) {
      // Markup can carry class names such as acct-bar-none without making a
      // visible claim. Keep text content and labels people can read or hear.
      const text = (match[1] || '').replace(/<\/?[a-z][^>]*>/gi, tag => {
        const labels = [...tag.matchAll(/\b(?:aria-label|title|alt|placeholder|value)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)]
          .map(attribute => attribute[1] ?? attribute[2])
        return ` ${labels.join(' ')} `
      }).replace(/\s+/g, ' ').trim()
      if (text && /\s/.test(text) && /[a-z]/i.test(text)) found.add(text)
    }
  }
  return [...found]
}

test('account prose scanning reads visible text and accessible labels rather than CSS class names', () => {
  const source = [
    `const empty = '<span class="acct-bar-none"></span>';`,
    `const body = '<span class="acct-bar-none">Nothing is sent to another account.</span>';`,
    `const labelled = '<button aria-label="Never shares the current account">Check</button>';`,
    `const input = '<input placeholder="No account is selected for this run">';`,
  ].join('\n')
  const prose = proseLiterals(source)
  assert.ok(prose.every(sentence => !sentence.includes('acct-bar-none')),
    'CSS class names must not become claims about account behavior')
  for (const claim of ['Nothing is sent to another account.', 'Never shares the current account',
    'No account is selected for this run']) {
    assert.ok(prose.some(sentence => sentence.includes(claim)), `${claim} must remain discoverable`)
  }
})

test('nested templates cannot turn following comments into account promises or hide real copy', () => {
  const source = [
    'const nested = `Outer ${allowed ? `Inner ${"Nothing real is lost in this fixture."}` : ""}`;',
    "/* An 'unknown' answer says nothing here: the row's own status is separate. */",
    'const promised = "Never sends a real message from this fixture.";',
  ].join('\n')
  const stripped = stripComments(source)
  assert.doesNotMatch(stripped, /answer says nothing/)
  assert.match(stripped, /Nothing real is lost/)
  const prose = proseLiterals(source)
  assert.ok(prose.includes('Nothing real is lost in this fixture.'))
  assert.ok(prose.includes('Never sends a real message from this fixture.'))
  assert.ok(prose.every(sentence => !sentence.includes('answer says nothing')))
})

/* A word list and `includes`, deliberately, instead of a regex.
 *
 * The regex version of this line silently became a LITERAL BACKSPACE
 * CHARACTER where a word-boundary escape was meant -- authored through a
 * shell heredoc that ate the backslash. It compiled, it ran, and it matched
 * nothing, so the guard reported ZERO absolute sentences in copy that has
 * thirteen. The "checking air" assertion below is the only reason that was
 * caught instead of shipping as a green test over nothing, which is the exact
 * defect this file exists to prevent.
 *
 * A list needs no escapes, so it cannot be corrupted that way. It over-matches
 * slightly ("none" inside "nonetheless"), and that is the safe direction: an
 * over-match costs somebody a classification, an under-match costs a promise
 * nobody is watching. */
const ABSOLUTE_WORDS = Object.freeze([
  'never', 'nothing', 'nowhere', 'no server', 'no email', 'no account', 'anywhere',
  'cannot', 'no password reset', 'no licence check', 'no subscription', 'not a login',
  'none', 'no one',
])

const isAbsoluteShaped = (sentence) => {
  const lower = sentence.toLowerCase()
  return ABSOLUTE_WORDS.some(word => lower.includes(word))
}

test('the absolute-shape detector detects, and is not silently inert', () => {
  /* Pinned because the detector it replaces was inert and looked correct. */
  assert.equal(isAbsoluteShaped('Nothing is sent anywhere'), true)
  assert.equal(isAbsoluteShaped('this one never asks for them'), true)
  assert.equal(isAbsoluteShaped('It is not a login to Claude'), true)
  assert.equal(isAbsoluteShaped('This computer cannot remember a sign-in.'), true)
  assert.equal(isAbsoluteShaped('Sign in, sign out, or change your password.'), false)
  assert.equal(isAbsoluteShaped('Choose a folder for your assistant.'), false)
})

/* Reports, not promises. Each says why it is one. */
const REPORTED_STATE = Object.freeze([
  ['No accounts match these filters.', 'reports that the current search or program filter matched no listed account. It is a view result, not a claim about the registry or account state.'],
  ['No accounts are listed here yet. Add your first account to manage it here. Any existing default sign-in stays available', 'reports an empty provider registry. The missing-registry tests keep the default provider path available; opening the panel creates no registry or sign-in.'],
  ['This page is running in a browser rather than the installed application', 'reports where the page is running; there is genuinely no shell to hold an account.'],
  ['This copy cannot read its accounts', 'reports a damaged account file. It is the fail-closed message, not a promise.'],
  ['The computer you are driving cannot remember a sign-in', 'reports that the OS keystore is unavailable. A fact about Windows, not about our code.'],
  ['This computer cannot remember the sign-in, so you will be asked again next time', 'same keystore report, said where the person just signed in.'],
  ['There is no account on this page to sign in to', 'reports the absent shell bridge.'],
  ['The account file on this computer contains an entry this version cannot read', 'reports a corrupt record; the refusal itself is pinned by the fail-closed tests.'],
  ['This copy cannot hold an account', 'reports that this build has no capability payload or no readable store; the first-run step still lets the person continue, signed out.'],
  ['The password cannot be the same as the username', 'states a rule that IS enforced, and is pinned by the password-rules test.'],
  ['this installation’s own vault does not hold that record', 'reports a vault this copy just read and found the record absent from. It is a measurement, not a promise -- and it is the branch that exists so that state cannot render as "no card on file".'],
  ['This copy could not check whether a card is attached', 'reports that the check itself failed. The sentence exists to refuse the false report; making it a promise would be promising that a read never fails.'],
  ['That email address already identifies a different Google account on this computer', 'reports a collision the store just found between a Google subject identifier and an address already on this computer. It is a refusal that happened, not a promise -- and it is the branch that stops one person being handed another\'s account, pinned behaviourally in google-account.test.mjs.'],
  ['An account on this computer already uses that name', 'reports a name collision the store just found. Same refusal shape as the line above.'],
  ['This copy cannot sign in with Google', 'reports that this build has no Google sign-in channel on its bridge. A fact about the build, said instead of showing a button that would fail.'],
  ['This copy cannot change the name it shows', 'reports that this build has no rename channel on its bridge -- the same shape as the Google line above. It is said instead of a Save that appears to work and changes nothing, which is the failure the sentence exists to refuse.'],
  ['there is no account whose data this would be', 'reports that nobody is signed in. It is the partition refusing to answer rather than answering with somebody else\'s data, which is the behaviour the isolation tests pin.'],
  ['Nothing was measured, so nothing is offered', 'reports that the measurement itself failed, and it is the branch that exists so an unreadable answer cannot render as "there is nothing here to delete" -- which would be a claim about somebody\'s vault made from ignorance.'],
  ['This page cannot delete anything', 'reports that this build has no removal channel on its bridge -- the same shape as the Google and rename lines above. Said instead of a button that would appear to work.'],
  ['There is no installed application here to remove data from', 'reports where the page is running: in a browser there is no shell, no userData directory and nothing to sweep.'],
  /* THE PROVIDER SIGN-IN PANEL. A different meaning of "account" -- the person's
     own Codex and Claude sign-ins -- on a module the discovery above scans
     because of its name. Each of these describes a state that was just read or a
     rule that is really enforced; the one PROMISE that surface makes is
     registered above, with a pin, rather than parked here. */
  ['so two accounts never write over each other', 'states a rule that IS enforced: two accounts of one provider may not share a folder, refused in shell/account-registry.cjs and pinned behaviourally in tools/test/account-registry.test.mjs.'],
  ['Nothing is listed here, so this copy uses the one sign-in already on this computer', 'reports that this computer has no account list. Absence is the ordinary state and means no rotation, which is why it is said as a fact rather than as a fault.'],
  ['This copy could not read its list of accounts, so none are shown', 'reports a damaged account list. It is the fail-closed message, and adding an account refuses in that state rather than replacing what could not be read.'],
  ['That folder cannot be resolved on this computer', 'reports that a relative folder could not be joined to a home directory -- a fact about this machine, said when the addition is refused.'],
  ['That folder cannot be used for an account', 'reports a refused folder: empty, over-long, or carrying a character a path may not hold.'],
  ['That kind of account cannot be added here', 'reports that the named provider is not one the current provider registry understands; an unsupported provider is refused before writing.'],
  ['The application refused this request before deleting any data, so nothing was removed', 'reports an explicit deletionNotStarted:true receipt, after excluding attempted browser deletion; an uncertain outcome uses the separate unconfirmed-deletion message.'],
  ['That kind of account cannot be removed here', 'the same report on the way out; the removal names a provider too, so it can refuse one that does not exist.'],
  ['This copy cannot guard private provider accounts', 'reports that this build lacks the matching provider-isolation policy after isolation was requested. It is the fail-closed refusal AGENT_PROVIDER_ISOLATION_UNAVAILABLE, the same shape as "This copy cannot hold an account"; src/local-activity.js carries its own wording for that code.'],
  /* THE CLOUD ACCOUNT ADDER. These are refusals returned after the one writer
     rejects the proposed entry, plus the fail-closed answer when that writer is
     absent. They were added to the scanned account sources without being added
     to this classification, so the guard correctly found them and its registry
     -- not the product copy -- was incomplete. */
  ['That name cannot be used', 'reports ACCOUNTS_ENTRY_INVALID from the account writer, whose registry parser rejects an entry before it can become a usable account.'],
  ['This copy cannot open that profile right now', 'reports an unavailable existing-profile action from the main process; the separate previous-profile control remains disabled.'],
  ['This copy cannot open a previous Google profile', 'reports that the installed bridge lacks the argument-free existing-profile action; no sign-in is attempted.'],
  ['two accounts cannot share one', 'states the enforced same-provider directory rule: capability/src/lib/multi-account/registry.js raises ACCOUNTS_PROFILE_DIR_SHARED before accepting a registry with two identities that would overwrite one sign-in.'],
  ['already has that role. Nothing was changed', 'reports ACCOUNTS_ROLE_DUPLICATE from the registry parser; the rejected candidate is not returned as an added account and the sign-in step is not opened.'],
  ['The account could not be added, and nothing was changed', 'reports the fail-closed result of an unmapped writer exception; createCloudAccountSetup returns ok:false and does not proceed to the sign-in step.'],
  ['This copy cannot add an account for you', 'reports that this payload does not expose the account writer required by createCloudAccountSetup; the surface returns CLOUD_ACCOUNT_ADD_UNAVAILABLE instead of offering a control that cannot work.'],
  /* Account work landed in the shared checkout while this suite was running.
     These are the same report shape: each is selected only when the installed
     bridge has no corresponding channel, so the screen withholds the action. */
  ['This installed copy cannot cancel the Google sign-in', 'reports that googleCancel is absent from the installed account bridge; the cancel control is disabled and the person is given the browser-window fallback.'],
  ['This copy cannot cancel sign-in', 'reports that the native cancellation method is absent; both account and setup disable cancellation and explain the browser fallback for password/passkey and Google attempts.'],
  ['The copy installed on the computer you are driving cannot change assistant accounts', 'reports that the installed bridge exposes neither the account add nor remove operation required by that panel, which withholds the unavailable actions. Reworded for the reader driving that computer through a browser; the same capability report as before, still not a promise.'],
  ['This installed copy cannot perform this action', 'reports that the installed provider bridge lacks the requested install or sign-in operation; the panel returns its unavailable state instead of presenting success.'],
  /* THE SIGN-OUT-EVERYWHERE OUTCOME, which is a REPORT and not a promise, and
     which exists because the promise beside it was being made falsely. */
  ['No account was signed in here, so no saved sign-in was refused', 'reports the { ok: true, revoked: false } answer from shell/product-account.cjs signOutEverywhere -- it signed out locally and bumped no epoch, so nothing was revoked. This sentence is what replaced "Any saved sign-in taken from this computer earlier is now refused" in that case, which was a promise the product had not kept.'],
  ['No account was signed in on', 'the same report, worded for somebody reading over the relay: it names the computer being driven rather than saying "here", because "here" is the browser and the sign-out happened on the other machine.'],
  ['No sign-in was active, so none had to be ended', 'reports { ok: true, revokedSessions: false } from the delete-everything sweep: the revocation step ran and ended no session, because none was active. It replaced "Every sign-in was ended first, including any copy taken off that computer" in that case, which was a promise about somebody else’s copied credentials that the product had not kept.'],
  ['The application refused this request before deleting any data, so nothing was removed', 'reports an explicit failed erase reply with no sweep and browserStorage attempted:false, cleared:false. readSweep derives deletionNotStarted from all those facts; outcomeLines selects this fallback only for that result. account-reset-copy.test.mjs exercises refusal, attempted browser deletion and unknown outcomes separately.'],
  /* THE ACCOUNTS MENU ON PAGE 2. A third surface using the provider meaning of
     "account" -- see the panel block above -- and the same rule applies to it:
     each of these describes a state that was just read or a refusal that just
     happened. The one PROMISE the menu makes ("Never changes account on its
     own") is registered above with a pin rather than parked here. */
  ['The list of accounts on this computer could not be read, so none are shown. Nothing has been lost', 'reports a damaged account list -- the same fail-closed state the guide panel reports, said in the menu\'s own words. "Nothing has been lost" is a statement about SCOPE that is true of every read on this surface: the menu never writes the registry while listing it, and setPolicy() and switchTo() both refuse outright with ACCOUNT_REGISTRY_DAMAGED rather than replacing a file they could not read.'],
  ['This copy cannot check how much of each account is left. Everything else on this menu still works', 'reports that this build\'s capability payload exposes no readAccountUsage -- the same shape as the Google and rename lines above, said instead of a button that would appear to work. The second half is not a promise either: listing, switching and adding go through separate channels that are present in the same build.'],
  ['Checked. The bars show what each account reported', 'reports that the allowance read answered ok, said on the confirmed branch of Check allowances in place of clearing the status line -- which hid it, so a screen reader heard "Checking…" and no end. It promises nothing about the figures: the bars draw only the windows the reply carried, and an account the reply left out keeps its "not known" line.'],
  ['That account was not switched to. Nothing changed', 'reports an ok!==true answer from the switch channel. switchTo() validates the provider, the name and the registry BEFORE its single writeStateRecord call, so every refusal returns with the rotation record byte-identical -- the same call-order argument the account-creation claim above is pinned on.'],
  ['That setting was not saved. Nothing changed', 'reports an ok!==true answer from the policy channel. setPolicy() refuses an unknown mode or an out-of-range reserve before its single writeRecord call, and the menu puts the control back to what the file says rather than leaving it showing a mode that was refused.'],
  ['That limit was not saved. Nothing changed', 'reports an ok!==true answer from the policy channel on the two allowance sliders. It rests on the same call-order fact as the mode line above: setPolicy() validates both per-window limits -- refusing a non-number, one outside 1..100, and one sent under a provider scope, since the engine reads them off the top of the registry for every program -- before its single writeRecord call, so a refusal leaves the file byte-identical. The menu then puts the slider back to what the file says rather than leaving it showing a limit that was refused.'],
  ['That account was not added. Nothing changed', 'reports an ok!==true answer from the managed-add channel that carried no sentence of its own. The shell answers { ok: false, code, reason } before it writes anything, and the menu shows that reason when there is one; this is the fallback for an answer without one, and it is true for the same call-order reason as the switch line above: nothing is written on a refusal.'],
  ['There are no accounts on this computer yet, so there is nothing to choose between', 'reports an absent registry, which is the ordinary state and means no rotation. setPolicy() refuses rather than creating the file, because a switching rule written for a list that does not exist would be a registry holding no accounts -- which the engine treats as a loud refusal (ACCOUNTS_REGISTRY_EMPTY) rather than as this quiet absence.'],
  ['That kind of account cannot be switched to here', 'reports that the named provider is not one the engine\'s rotation understands -- the same report as the add and remove lines above, on the third verb that names a provider.'],
  ['There are no accounts on this computer to switch between', 'the same absent-registry report on the switch path; there is nothing to prefer when nothing is listed.'],
  /* RENAME AND REMOVE ON THE MENU (owner, 2026-09-02). Each of these reports a
     refusal that just happened or an absence that was just read; rename() and
     remove() both validate before their single write, so "nothing changed" is
     the same call-order fact the switch and policy lines above rest on. */
  ['That account was not renamed. Nothing changed', 'reports an ok!==true answer from the rename channel. rename() refuses an unknown name, a missing new name, a taken name and an unreadable list before its single writeRecord call, so every refusal leaves the list byte-identical.'],
  ['That account was not removed. Nothing changed', 'reports an ok!==true answer from the remove channel. remove() edits the list alone and refuses a damaged one before writing; the folder and its sign-in are never touched by it, which is the second sentence of the success line rather than a promise made here.'],
  ['That kind of account cannot be renamed here', 'reports that the named provider is not one the store knows -- the same report as the add, remove and switch lines above, on the fourth verb that names a provider.'],
  ['There are no accounts on this computer to rename', 'the same absent-registry report on the rename path; there is nothing to rename when nothing is listed.'],
  ['That account was not on the list, so nothing was removed', 'reports the { ok: true, removed: false } answer from shell/account-registry.cjs remove() -- the named account was not in the registry, so no entry was rewritten. The second half is a statement about SCOPE that is true of every removal, not only this one: remove() edits the registry file alone and never touches the account folder or the provider sign-in inside it, deliberately, because a person’s provider home is theirs.'],
  /* WATCHING ONE ACCOUNT'S SIGN-IN FILE (owner, 2026-09-03), added to the
     scanned account sources without being added to this classification -- the
     same gap the cloud-account-adder block above notes for itself, and the
     guard rightly found it. Both are refusals watchSignIn() raises before it
     ever arms a watch; account-registry.cjs's own comment on that function
     states the rule these two answer to: "A REFUSAL NAMES ITSELF ... none of
     them is a silent skip." */
  ['Nothing was given to tell when that account signs in.', 'reports ACCOUNT_WATCH_NO_LISTENER from shell/account-registry.cjs watchSignIn() -- refused because the caller passed no onChange listener to notify, before any folder watch is armed.'],
  ['This computer cannot watch a folder for a sign-in.', 'reports ACCOUNT_WATCH_UNAVAILABLE from shell/account-registry.cjs watchSignIn() -- refused because this build’s fs layer exposes no watch() function, the same shape as the Google and rename lines above: said instead of arming a watch that would silently never fire.'],
  /* KEEP TRYING ACCOUNTS. Both lines were added with the account retry work
     without being added here, so the guard found them. */
  ['The saved role identity cannot be confirmed', 'reports AGENT_RETRY_ROLE_UNCONFIRMED from src/account-recovery-coordinator.js prepareRetryRole(): the retry refuses before any start because the chosen model, the saved role binding or the org bridge needed to confirm the seat is missing.'],
  ['you stopped this agent. Nothing starts until you resume it or send it work', 'reports a Keep trying choice recorded on an agent the person stopped. The rule it states is enforced: keepTryingAccounts() returns before runAccountRetry() for a stopped node, and the host refuses a recovery start whose predecessor was stopped (AGENT_ACCOUNT_RECOVERY_STOPPED). R10 in account-retry-regressions.test.mjs pins that no start follows.'],
])

test('every absolute-shaped sentence in the account copy is classified', () => {
  const sources = ACCOUNT_SOURCES
  const unclassified = []
  let seen = 0
  for (const [name, source] of Object.entries(sources)) {
    for (const sentence of proseLiterals(source)) {
      if (!isAbsoluteShaped(sentence)) continue
      seen += 1
      const pinned = REGISTERED_CLAIMS.some(entry => sentence.includes(entry.claim))
      const reported = REPORTED_STATE.some(([text]) => sentence.includes(text))
      if (!pinned && !reported) unclassified.push(`${name}: ${sentence.slice(0, 120)}`)
    }
  }
  /* A guard that finds nothing is checking air -- the rule
     tools/check-no-owner-data.mjs applies to itself. */
  assert.ok(seen >= 10, `only ${seen} absolute-shaped sentences were found; the scanner has stopped seeing the copy`)
  assert.deepEqual(unclassified, [],
    'these sentences make absolute-shaped statements and are neither pinned as promises nor classified as reports')
})

test('the shared settings row is classified too', () => {
  /* THE ROW IS HEADED "Who is using this copy" NOW, and the rename is the
     point rather than an accident. Headed "Your account", it answered a
     question nobody asked it: somebody who had just paid at toolsenabled.ai
     opened Settings, read "Your account lives on this computer and nowhere
     else", and stopped looking. The sentence was true of THIS row and was read
     as an answer about the hosted account. It still makes absolute-shaped
     promises, so it is still pinned here; the row's own heading is what
     changed. */
  const row = SETTINGS.match(/<div class="settings-desc">[^<]*account lives on this computer[^<]*<\/div>/)
  assert.ok(row, 'the account settings row is gone or reworded; re-register its promises')
  assert.ok(REGISTERED_CLAIMS.some(entry => row[0].includes(entry.claim)),
    'the account settings row makes an absolute promise that nothing pins')
})

/* ------------------------------- the wiring ------------------------------- */

test('the shell exposes the account bridge, and exposes no way to set the principal', () => {
  assert.ok(PRELOAD.includes("exposeInMainWorld('mcAccount'"), 'the bridge must be exposed')
  for (const channel of ['mc-account:availability', 'mc-account:current', 'mc-account:create',
    'mc-account:sign-in', 'mc-account:sign-out', 'mc-account:change-password',
    'mc-account:change-display-name']) {
    assert.ok(PRELOAD.includes(channel), `${channel} must be reachable from the page`)
    assert.ok(MAIN.includes(`ipcMain.handle('${channel}'`), `${channel} must be handled in main`)
  }
  /* THE ONE THAT MATTERS. A channel that lets the page name the principal makes
     every record it appears in worthless. It has never existed; this asserts it
     never starts to. */
  assert.ok(!/set-?principal/i.test(stripComments(PRELOAD)), 'the page must not be able to name the principal')
  assert.ok(!/set-?principal/i.test(stripComments(MAIN)), 'nothing may accept a principal over IPC')
  /* And no handler may read a principal out of what the page sent.
     A RULE'S SUBJECT IS A DIFFERENT THING AND IS SPELLED `subject`. This scan
     reads source text, so it cannot tell "the caller claims to be X" from "the
     owner is writing a rule about X" -- and the second is legitimate: the vault
     page's per-role switches must send WHICH role the owner just ticked, and
     mc-vault:set-access stores exactly that. It caught that handler in 2026-09
     when the field was spelled `principal`; the field was renamed to `subject`
     and this assertion was deliberately left untouched, because it still holds
     full force against the thing it means -- a handler treating a
     renderer-supplied value as the identity of whoever is asking.
     IF YOU ARE HERE BECAUSE THIS FIRED: do not widen the pattern and do not
     delete the case. Establish which of the two your field is. The read-side
     identity in this product is the `principal` option of
     shell/vault-presence.cjs `vaultRecordValues`, which is the only caller of
     `mayRead`; if your value can reach that, it is a principal and the gate has
     found a real hole. If it can only be stored or audited, it is a subject and
     the word is what needs to change. */
  assert.ok(!/value\??\.principal|request\??\.principal/.test(stripComments(MAIN)),
    'no IPC handler may take the principal from the renderer payload')
})

test('the renderer never receives the session identifier', () => {
  assert.ok(MAIN.includes('currentForRenderer()'),
    'the renderer channel must send the projected reply, not the main-process one')
  assert.ok(!MAIN.includes("withFleetProfileSender(event, () => getAccountStore().current())"),
    'the unprojected reply must not be what crosses to the page')
})

test('the spawn record carries a real principal read in the main process', () => {
  assert.ok(!/principal: null/.test(MAIN),
    'the null principal is the hole this lane was opened to close')
  assert.ok(MAIN.includes('principal: accountPrincipal()'),
    'the record must take its identity from the account store')
  assert.ok(/function accountPrincipal\(\)/.test(MAIN), 'and that function must exist in main')
  /* The store is a singleton for the process. Two instances would each hold
     their own session whenever the OS keystore is unavailable, and the record
     would name whichever one it happened to ask. */
  assert.ok(MAIN.includes('sharedAccountStore({'), 'main must use the shared store')
  assert.ok(!MAIN.includes('createAccountStore({'), 'main must not build a second store')
})

/* ---- what the screen RENDERS, proved by rendering it ----
 *
 * THREE ATTEMPTS, AND THE FIRST TWO WERE BOTH WRONG. Two planted defects --
 * an empty sign-in form, and an empty scope notice -- ship a screen with no
 * fields, or one that never says there is no password reset and that this is
 * not a provider login (the SHIPMENT-PLAN B14 disclosure).
 *
 *   Attempt 1 searched the whole file for strings. Survived: the strings live
 *   in the change-password form too.
 *   Attempt 2 searched the function's own source slice. Survived as well,
 *   because the plant was an early `return ''` with the real markup still
 *   below it -- DEAD CODE MATCHES A TEXT SEARCH.
 *
 * No assertion over source text can see reachability. So the builders moved to
 * src/account-markup.js, which imports no stylesheet and holds no DOM, and
 * these tests CALL them and read the output. That is the only instrument that
 * can see the defect -- the rule homescreen-fix stated tonight: ask what your
 * instrument shows if the thing you are checking for is present. */

const SIGNED_OUT_VIEW = Object.freeze({ available: true, signedIn: false, accountCount: 0, canPersistSession: true })
const SIGNED_IN_VIEW = Object.freeze({
  available: true, signedIn: true, accountCount: 1, canPersistSession: true,
  username: 'josh', displayName: 'Josh P', expiresAtMs: Date.now() + 5 * 86400000,
})

test('the sign-in form renders its fields', () => {
  for (const mode of ['sign-in', 'create']) {
    const html = formMarkup({ mode, state: SIGNED_OUT_VIEW })
    assert.match(html, /<input[^>]*name="username"/, `${mode}: no name field is rendered`)
    assert.match(html, /<input[^>]*name="password"[^>]*type="password"|<input[^>]*type="password"[^>]*name="password"/,
      `${mode}: no password field is rendered`)
    assert.match(html, /type="submit"/, `${mode}: nothing to submit the form with`)
    assert.ok(html.length > 800, `${mode}: the form collapsed to ${html.length} characters`)
  }
  assert.match(formMarkup({ mode: 'create', state: SIGNED_OUT_VIEW }), /name="displayName"/,
    'creating an account no longer offers a display name')
})

test('the scope notice is rendered, and reaches the person creating an account', () => {
  const notice = scopeMarkup()
  for (const paragraph of ACCOUNT_SCOPE_NOTICE) {
    assert.ok(notice.includes(paragraph.slice(0, 60)),
      'scopeMarkup does not render one of the sentences it exists to show')
  }

  /* And it must reach BOTH readers: the one creating an account and the one
     signing in. A notice rendered only on one path is a notice half the
     product never shows. */
  for (const mode of ['create', 'sign-in']) {
    const html = formMarkup({ mode, state: SIGNED_OUT_VIEW })
    assert.ok(html.includes(ACCOUNT_SCOPE_NOTICE[0].slice(0, 60)),
      `${mode}: the scope notice never reaches the screen`)
    assert.ok(html.includes(esc(ACCOUNT_SCOPE_LEAD)), `${mode}: the notice lost its heading`)
  }
})

test('the scope notice names this computer at the desk and the driven computer over the relay', () => {
  assert.match(
    scopeMarkup(),
    /Creating an account here makes a local account on this computer\./,
    'mutation ACCOUNT-SCOPE-LOCAL-TO-REMOTE: replacing the desk table with its remote twin must fail here',
  )
  assert.match(
    scopeMarkup({ subject: ACCOUNT_SCOPE_SUBJECT_REMOTE }),
    /Creating an account here makes a local account on the computer you are driving\./,
    'mutation ACCOUNT-SCOPE-REMOTE-TO-LOCAL: selecting the desk table for a relay reader must fail here',
  )
})

test('every state the screen can be in renders something a person can act on', () => {
  const states = [
    ['reading', { state: null }, /Reading accounts on the computer you are driving/],
    ['unavailable', { state: { available: false, signedIn: false, reason: 'no shell here' } }, /no account on this page/],
    ['signed out', { state: SIGNED_OUT_VIEW }, /name="password"/],
    ['signed in', { state: SIGNED_IN_VIEW }, /data-account-sign-out/],
    ['changing password', { state: SIGNED_IN_VIEW, mode: 'change-password' }, /name="currentPassword"/],
    ['changing the shown name', { state: SIGNED_IN_VIEW, mode: 'display-name' }, /name="displayName"/],
  ]
  for (const [name, input, expected] of states) {
    const html = screenMarkup(input)
    assert.ok(html.length > 100, `${name} renders ${html.length} characters, which is not a screen`)
    assert.match(html, expected, `${name} does not render its own control`)
  }
})

/* THE NAME A PERSON IS SHOWN AS, AND THAT IT IS NOT A ONE-WAY DOOR.
 *
 * The defect: the first-run walkthrough creates the account with an empty
 * display name, the store falls back to the username, and there was no screen
 * anywhere in the product that could change it afterwards -- so a username
 * typed in the first ninety seconds was the permanent label on every record of
 * that person's work. These render the repair rather than searching for it,
 * for the reason the whole file exists. */
test('the signed-in screen offers a way to change the name it shows', () => {
  const html = signedInMarkup({ state: SIGNED_IN_VIEW })
  assert.match(html, /data-account-shown-as/, 'the signed-in screen no longer says what it calls you')
  assert.match(html, /data-account-mode="display-name"/, 'there is no control that opens the rename form')
  /* A GOOGLE ACCOUNT TOO. Its display name is the verified email address, in
     full, on every record -- the person who most needs this. The password row
     is hidden for them and it would be easy to hide this one by the same
     reflex; there is no password here to change, but there IS a name. */
  const google = signedInMarkup({
    state: { ...SIGNED_IN_VIEW, signInMethod: 'google', username: 'a@example.com', verifiedEmail: 'a@example.com', displayName: 'a@example.com' },
  })
  assert.match(google, /data-account-mode="display-name"/, 'a Google account is not offered the rename it needs most')
})

test('the rename form states what an empty box means, with the username in it', () => {
  const html = changeDisplayNameMarkup({ state: SIGNED_IN_VIEW })
  assert.match(html, /<input[^>]*name="displayName"/, 'the rename form has no field')
  assert.match(html, /value="Josh P"/, 'the field is not prefilled with the current name, so saving would need it retyped')
  assert.match(html, /type="submit"/, 'nothing to submit the rename with')
  /* THE ABSENCE CASE, WHICH IS THIS CODEBASE'S SIGNATURE DEFECT. An empty
     field MEANS something here -- go back to the username -- and a meaning
     that is not printed is a meaning nobody consented to. */
  assert.match(html, /Leave it empty/, 'the form no longer says what an empty box does')
  assert.match(html, /<code>josh<\/code>/, 'the form does not name the username an empty box falls back to')
  /* No password is asked for on this form, and none may be rendered by it. */
  assert.ok(!/type="password"/.test(html), 'the rename form now asks for a password it does not need')
})

test('the rename action sends what was typed, and lets the shell decide what it becomes', () => {
  const view = stripComments(ACCOUNT_SOURCES['src/views/account.js'])
  const action = view.slice(view.indexOf("kind === 'display-name'"), view.indexOf('const currentPassword'))
  assert.ok(action.length > 200, 'the rename action is gone')
  /* Not trimmed, not defaulted, not emptied in the page. Two opinions about
     what a name normalizes to eventually disagree, and the one on screen would
     be the wrong one. Asserted on the READ and on the SEND rather than by
     scanning the whole action for a `||`, because the action legitimately uses
     one to render the result afterwards -- a guard that cannot tell those apart
     is a guard that fires on correct code. */
  assert.match(action, /const displayName = fieldValue\('displayName'\)/,
    'the rename no longer reads the field as typed')
  assert.match(action, /changeDisplayName\(\{ displayName \}\)/,
    'the rename now transforms the name before sending it, so the page and the shell can disagree about what somebody is called')
  /* The sentence shown afterwards must come from the re-read, not from the
     typed string: they differ exactly when the name was emptied or stripped.
     Scoped to what happens AFTER the shell is called -- the refusal branch in
     front of it legitimately writes a notice without reading anything, and an
     unscoped index comparison flags that as the defect it is not. */
  const onSuccess = action.slice(action.indexOf('changeDisplayName({ displayName })'))
  assert.ok(onSuccess.length > 100, 'the success handler is gone')
  assert.ok(onSuccess.indexOf('await refresh()') < onSuccess.indexOf('notice ='),
    'the rename now writes its confirmation before re-reading, so it can claim a name the shell did not store')
  /* And it must not print an empty name when the re-read comes back signed
     out -- the session can expire while the write is in flight. */
  assert.ok(/state\?\.signedIn/.test(onSuccess),
    'the rename no longer checks that the re-read is still signed in before naming somebody')
  /* A build without the channel must say so rather than showing a Save that
     silently does nothing. */
  assert.ok(/typeof bridge\.changeDisplayName !== 'function'/.test(action),
    'the rename no longer checks that this build has the channel')
})

test('the keystore warning appears exactly when the keystore is missing', () => {
  const withKeystore = screenMarkup({ state: SIGNED_OUT_VIEW })
  const without = screenMarkup({ state: { ...SIGNED_OUT_VIEW, canPersistSession: false } })
  assert.ok(!withKeystore.includes('cannot remember a sign-in'), 'the warning shows when it should not')
  assert.ok(without.includes('cannot remember a sign-in'), 'the warning is missing when the keystore is unavailable')
})

test('no rendered screen can carry a password value', () => {
  /* The builders take no parameter a password could arrive in, so this is
     structural rather than hopeful: a value cannot be rendered that cannot be
     passed. Asserted against every state anyway. */
  const secret = "hunter2-correct-horse"
  for (const input of [
    { state: SIGNED_OUT_VIEW }, { state: SIGNED_IN_VIEW },
    { state: SIGNED_IN_VIEW, mode: 'change-password' },
    { state: SIGNED_OUT_VIEW, mode: 'create', notice: { tone: 'bad', title: 'x', detail: 'y' } },
  ]) {
    assert.ok(!screenMarkup(input).includes(secret))
    assert.ok(!/value="[^"]*password/i.test(screenMarkup(input)), 'a password field renders a value attribute')
  }
})

test('the view owns no markup of its own', () => {
  /* If HTML creeps back into the view it becomes untestable again, which is
     how this defect existed in the first place. */
  const code = stripComments(VIEW)
  assert.ok(code.includes('screenMarkup(view())'), 'the view no longer paints through the tested builder')
  const inlineTags = code.match(/<(form|input|button|article|h1)\b/g) || []
  assert.deepEqual(inlineTags, [],
    `the view has grown ${inlineTags.length} copy- or control-bearing element(s) that no test can render`)
  /* The root shell (<main>/<div>/<section>) is deliberately allowed: it is
     the container the view mounts into and carries no words. */
  assert.ok(code.includes('data-account-section'), 'the view no longer mounts a section to paint into')
})
test('the first-run sign-in step renders, in every state it can be in', () => {
  const states = [
    ['reading', { accountState: null }, /Reading accounts on the computer you are driving/],
    ['unavailable', { accountState: { available: false, reason: 'no payload' } }, /cannot hold an account/],
    ['signed in', { accountState: { available: true, signedIn: true, displayName: 'Josh P' } }, /says who asked for it/],
    ['signed out', { accountState: { available: true, signedIn: false } }, /data-setup-account-field="password"/],
  ]
  for (const [name, input, expected] of states) {
    const html = setupAccountStepMarkup({ ...input, actions: '<div class="setup-actions"></div>' })
    assert.ok(html.length > 80, `${name}: the first-run step renders ${html.length} characters`)
    assert.match(html, expected, `${name}: the first-run step does not render its own content`)
  }
})

test('the first-run step shows the scope notice where the account is created', () => {
  /* This is the SHIPMENT-PLAN B14 disclosure on the screen a first-time user
     actually meets. A plant proved it could vanish silently while the whole
     suite stayed green, which is why it is rendered and read here. */
  const html = setupAccountStepMarkup({ accountState: { available: true, signedIn: false }, mode: 'create' })
  for (const paragraph of ACCOUNT_SCOPE_NOTICE) {
    assert.ok(html.includes(paragraph.slice(0, 60)), 'the first-run step drops one of the scope sentences')
  }
  assert.ok(html.includes(esc(ACCOUNT_SCOPE_LEAD)), 'the first-run notice lost its heading')
  assert.match(html, /no password reset/, 'the first-run step no longer warns that there is no reset')
})

test('the first-run step and the settings screen say the same thing about the account', () => {
  /* Two screens, one set of constants. If they ever drift, one of them is
     telling somebody something the other contradicts. */
  const step = setupAccountStepMarkup({ accountState: { available: true, signedIn: false }, mode: 'create' })
  const screen = formMarkup({ mode: 'create', state: { available: true, signedIn: false } })
  for (const paragraph of ACCOUNT_SCOPE_NOTICE) {
    const fragment = paragraph.slice(0, 60)
    assert.equal(step.includes(fragment), screen.includes(fragment),
      'the walkthrough and the sign-in screen disagree about what this account is')
  }
})

test('the walkthrough delegates its step to the tested builder, and the limit is stated', () => {
  /* WHAT THIS CAN AND CANNOT PROVE, said plainly rather than implied.
     src/views/setup.js imports three stylesheets and touches the DOM, so no
     test can render it. This asserts only that the step DELEGATES; a defect
     planted INSIDE that wrapper -- an early return with the delegation still
     below it -- would survive, because dead code matches a text search.
     Everything the builder renders is covered above; the wiring in setup.js is
     covered only by the packaged run driving the real window. That is a weaker
     guarantee and it is written down as one. */
  const code = stripComments(read('src/views/setup.js'))
  assert.ok(code.includes('setupAccountStepMarkup('), 'the walkthrough no longer paints through the tested builder')
  /* Matches an INPUT ELEMENT, not the attribute name: the walkthrough still
     reads its fields with querySelector('[data-setup-account-field=...]'), and
     banning the selector would ban the event handler that makes the step work.
     The first version of this line did exactly that. */
  const inline = code.match(/<input[^>]*data-setup-account-field/g) || []
  assert.deepEqual(inline, [],
    `the walkthrough has grown ${inline.length} account field(s) of its own that no test can render`)
})

test('the sign-in screen is reachable as its own route', () => {
  assert.ok(ROUTER.includes("import { accountView }"), 'the view must be imported')
  assert.ok(ROUTER.includes("import { parseRoute } from './route-parse.js'"), 'the router must use its extracted parser')
  assert.match(stripComments(ROUTER), /parseRoute\(location\.hash/, 'the router must pass the current address to that parser')
  assert.deepEqual(parseRoute('#/account'), { name: 'account' }, 'the actual parser must resolve the account route')
  assert.deepEqual(parseRoute('#/account?from=signin'), { name: 'account' }, 'query parameters must preserve the account route')
  assert.ok(ROUTER.includes("case 'account': return accountView"), 'the route must build the view')
})

/* ------------------------- the screen holds no secret ------------------------- */

test('the sign-in screen never stores a password anywhere that outlives the call', () => {
  /* Password values are read from the DOM at submit and passed straight on. If
     one were ever written to storage, put on the profile answers, or logged,
     it would appear next to one of these. */
  const code = stripComments(VIEW)
  assert.ok(!/localStorage|sessionStorage/.test(code), 'the sign-in screen must not touch web storage')
  assert.ok(!/console\.(log|warn|error|info)/.test(code), 'nothing on an auth screen may be logged')
  assert.ok(VIEW.includes('clearPasswords()'), 'the password fields must be cleared')
  /* Cleared on refusal too. A wrong password left sitting in the field is a
     password left in the DOM of a window somebody may walk away from. */
  assert.ok(/Cleared on every outcome/.test(VIEW), 'and cleared on failure, not only on success')
  /* Asserted on the RENDERED output now, not on the file: these moved to
     src/account-markup.js with the rest of the markup, and a file search
     could not tell a rendered hint from a dead one anyway. */
  assert.match(formMarkup({ mode: 'create', state: { available: true, signedIn: false } }),
    /autocomplete="new-password"/, 'creation must invite a generated password')
  assert.match(formMarkup({ mode: 'sign-in', state: { available: true, signedIn: false } }),
    /autocomplete="current-password"/, 'sign-in must let a password manager fill it')
})

/* DE-REGISTERED, BECAUSE THE PROMISE'S ROW IS GONE.
 *
 * This used to be a REGISTERED_CLAIMS entry pinning the sentence "Nothing on
 * this screen or elsewhere in the product is switched off because you have not
 * subscribed". That sentence lived in the account page's subscription row, and
 * the row was removed on the owner's 2026-08-26 ruling that the product stop
 * advertising subscriptions. The register's own instruction covers exactly this
 * case: "if it was reworded, re-register it here with what keeps it true; if it
 * was dropped, delete the entry."
 *
 * The promise itself is not lost, it is delivered where it is actually needed.
 * src/refusal-copy.js SUBSCRIPTION_COMING_SOON_REMEDY still tells anyone who
 * reaches a purchase refusal "Keep using everything that runs on this computer;
 * it is unaffected." That is an answer to a person who arrived, rather than a
 * reassurance about a question the advert itself raised.
 *
 * WHAT THE ENTRY WAS REALLY GUARDING SURVIVES HERE UNCHANGED, and it is the
 * half worth keeping: that no account module reads an entitlement, a licence or
 * a paid tier. If licensing ever crept into this screen it would start
 * switching things off with nothing on screen saying so -- and there is no
 * longer a subscription row to make anyone suspicious. The guard matters MORE
 * after the removal, not less, which is why it becomes a test of its own rather
 * than being deleted along with the claim it happened to be filed under. */
test('the account screens sell nothing, and no account module reads licensing', () => {
  /* CODE-SHAPED PATTERNS, MATCHED AGAINST THE RAW SOURCE, and both halves
     of that are deliberate. A bare /licen[cs]e/ over stripped source flags
     this very comment block, so the guard would be satisfied by deleting
     the explanation rather than by the code being right -- and a rule you
     satisfy by saying less is not a rule. These match an IMPORT, a REQUIRE,
     a channel name or a call: shapes prose does not have, so the scan needs
     no comment stripper to be correct and the writing is free. */
  const licensing = [
    /from\s+['"][^'"]*(?:entitlement|licen[cs]e)[^'"]*['"]/i,
    /require\(\s*['"][^'"]*(?:entitlement|licen[cs]e)[^'"]*['"]/i,
    /mc-(?:entitlement|licen[cs]e)/i,
    /\b(?:requiresLicense|paidTier|subscriptionState|isSubscribed|readEntitlement|entitlementFor)\b/,
  ]
  for (const [name, source] of Object.entries(ACCOUNT_SOURCES)) {
    for (const pattern of licensing) {
      assert.ok(!pattern.test(source),
        `${name} consults licensing (${pattern}), so "nothing on it is switched off because you have not [paid]" is no longer a claim this screen can make`)
    }
  }
  /* THE ACCOUNT PAGE MUST NOT SELL ANYTHING.
     Owner, 2026-08-26: "i dont want to advertise subscriptions in the app."
     This block used to assert the opposite in detail -- that the row was
     present, disabled, and carried its reason. That was a good guard on a
     row that should not have been there: views/home.js had already dropped
     its copy on the same ruling, so what the assertions were protecting was
     the LAST advertising surface, on the screen a person reaches from their
     own account.

     Inverted rather than deleted, and asserted against the RENDERED MARKUP
     of both account screens rather than against a module export, because
     the export is gone and a future row would not come back through it.
     Mutation watched: restore any subscribe control to either screen. */
  /* RENDERED, not read as source. Both screens are built here from the fixtures
     the rest of this file already uses, because an advert that came back would
     come back in the MARKUP -- a source grep would also match this comment and
     could be satisfied by saying less. */
  const screens = [
    ['signed out', screenMarkup({ state: SIGNED_OUT_VIEW })],
    ['signed in', signedInMarkup({ state: SIGNED_IN_VIEW })],
    /* belongingsMarkup IS LISTED SEPARATELY, and the honest reason is narrower
       than the one first written here. The row was removed from THREE call
       sites: the two "Without an account" sections, and the "Money" section,
       which lives in belongingsMarkup. Measured: signedInMarkup DOES render the
       Money section, so that arm already catches a restored row there -- the
       first draft of this comment claimed it did not, and was wrong.
       screenMarkup(signed out) does NOT render Money. Calling belongingsMarkup
       directly keeps the guard on the money row from depending on signedInMarkup
       continuing to compose it, which is a composition decision that can change
       without anyone thinking about adverts. */
    ['belongings', belongingsMarkup({})],
  ]
  for (const [screen, markup] of screens) {
    assert.ok(!/data-account-subscribe-link/.test(markup),
      `the ${screen} account screen renders a subscribe control again`)
    assert.ok(!/coming soon/i.test(markup),
      `the ${screen} account screen advertises something as coming soon again`)
    assert.ok(!/#\/subscribe/.test(markup),
      `the ${screen} account screen links to the subscribe route again`)
  }
})
