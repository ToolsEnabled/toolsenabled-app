/* THE VISIBLE CONTROL FOR THE OWNER'S CREDENTIAL VAULT, DRIVEN.
 *
 * THIS IS THE HALF THE OWNER ACTUALLY SEES, so it is checked by building the
 * panel over a fake main-process seam and reading the rendered text -- not by
 * asserting the source says the right words. A test that pins a spelling passes
 * against a reinstated defect and fails against a better implementation, so
 * every assertion here goes through the panel's own exported verbs, the same
 * ones its buttons call.
 *
 * THE ONE THING THAT WOULD COST THE OWNER MOST IF IT WERE WRONG: a value, a
 * masked prefix, or a character count on screen. The fake store below HOLDS
 * values -- obviously synthetic placeholders, credentials for nothing -- and
 * the listing assertions hunt for each value, each value's first eight
 * characters, and each value's length in the panel's rendered text. Without a
 * store that holds something, "no value was shown" would be a tautology.
 *
 * THE SECOND THING: a deletion happening without the owner's approval. Driven
 * as three presses against a seam that answers the way the real one does, with
 * the removal counted, because "it asked first" is only true if the destructive
 * call had not already happened.
 */

import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import { fileURLToPath } from 'node:url'
import { installDomStandIn } from './lib/dom-stand-in.mjs'

/* The panel imports its stylesheet, as every view module here does. */
register('./helpers/css-stub-loader.mjs', import.meta.url)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = relative => readFileSync(path.join(ROOT, ...relative.split('/')), 'utf8')

const dom = installDomStandIn()
const {
  APPROVALS_HREF,
  VAULT_COPY,
  VAULT_CREDENTIALS_ROW,
  VAULT_CREDENTIALS_SECTION,
  createVaultCredentialsSettings,
} = await import('../../src/vault-credentials-settings.js')

const FAKE_STORE = Object.freeze({
  provider_api_key: 'SYNTHETIC-PLACEHOLDER-NOT-A-CREDENTIAL-0001',
  google_oauth_client_id: 'SYNTHETIC-PLACEHOLDER-NOT-A-CREDENTIAL-000000002',
  legacy_token: 'SYNTHETIC-PLACEHOLDER-NOT-A-CREDENTIAL-3',
})
const FAKE_NAMES = Object.freeze(Object.keys(FAKE_STORE).sort())

/* A seam that answers the way shell/vault-credential-page.cjs answers: names
   for `names`, a promptId for `requestRemoval`, and a removal only once the
   test has said the owner approved it. It records every call so an assertion
   can count what the panel actually did.

   ITS `names` ANSWER CARRIES THE VALUES, AND THAT IS THE WHOLE POINT.

   This stub used to return names only, which made the value hunt below a
   test that COULD NOT FAIL: there was no value anywhere in the panel's
   input, so "no value was rendered" was a tautology dressed as a fence, and
   it stayed green under every mutation of the panel. A test that cannot fail
   is the defect this codebase keeps re-finding, so the stub now models the
   worst realistic input instead -- a main process that leaked, handing the
   panel an answer with a `values` field beside the names. The panel must
   render the names and must not render, mask, measure or echo anything in
   `values`. shell/vault-credential-page.cjs refuses that shape before it can
   reach a window (its own suite's test 3 proves that, and stays the product
   fence); this one proves the panel is not the thing keeping the promise by
   luck. */
function seamStub({ names = FAKE_NAMES, approved = new Set(), calls = [], leak = true } = {}) {
  const store = new Set(names)
  /* Outlives any one panel, like the file it stands in for. */
  const bindings = new Map()
  return {
    calls,
    approve(promptId) { approved.add(promptId) },
    names: async () => {
      calls.push(['names'])
      const visible = [...store].sort()
      return {
        ok: true, names: visible, store: null,
        ...(leak ? { values: Object.fromEntries(visible.map(name => [name, FAKE_STORE[name]])) } : {}),
      }
    },
    add: async request => { calls.push(['add', request]); return { ok: true, requestId: 'owner-prompt-1', vaultKey: `custom.${request.customName}` } },
    /* THE BINDING IS DURABLE IN THE STUB TOO, because that is the whole point.
       A stub that kept the binding only for the life of the panel could not
       reproduce the defect: the panel's memory and the stub's memory would
       vanish together and a reload would look identical to no reload. The real
       seam keeps this in <stateRoot>/state/vault-removal-approvals.json, so the
       stub keeps it outside the panel's lifetime and answers `pendingRemovals`
       from it. */
    pendingRemovals: async () => {
      calls.push(['pendingRemovals'])
      return {
        ok: true,
        pending: [...bindings.entries()].map(([name, id]) => ({
          name,
          promptId: id,
          decision: approved.has(id) ? 'approved' : 'waiting',
        })),
      }
    },
    requestRemoval: async request => {
      calls.push(['requestRemoval', request])
      /* REUSE, like the seam: a live binding for this record is not re-asked. */
      const existing = bindings.get(request.name)
      if (existing) return { ok: true, promptId: existing, approvalHref: APPROVALS_HREF, reused: true }
      const promptId = `prompt-${request.name}-${bindings.size}`
      bindings.set(request.name, promptId)
      return { ok: true, promptId, approvalHref: APPROVALS_HREF }
    },
    completeRemoval: async request => {
      calls.push(['completeRemoval', request])
      if (!approved.has(request.promptId)) {
        return { ok: false, removed: false, code: 'OWNER_APPROVAL_PENDING', reason: 'not answered yet', approvalHref: APPROVALS_HREF }
      }
      store.delete(request.name)
      /* Spent once, like the real binding. */
      bindings.delete(request.name)
      approved.delete(request.promptId)
      return { ok: true, removed: true, code: 'CREDENTIAL_REMOVED', name: request.name }
    },
  }
}

function assertNothingNarrowsAValue(text, where) {
  for (const [name, value] of Object.entries(FAKE_STORE)) {
    assert.ok(!text.includes(value), `${where} showed the value stored under ${name}`)
    assert.ok(!text.includes(value.slice(0, 8)), `${where} showed a prefix of the value stored under ${name}`)
    assert.ok(!text.includes(String(value.length)), `${where} showed the length of the value stored under ${name}`)
  }
}

test('the row this panel belongs to is still the row the catalogue declares', () => {
  /* THE DRIFT THIS CLOSES. src/views/settings.js writes the id and the section
     out as literals, because the suite over that catalogue resolves an ALL-CAPS
     identifier only through a table of constants it knows. So the two copies
     are held together here instead: renaming either one without the other
     fails, which is the whole reason a constant would have been preferable. */
  const source = read('src/views/settings.js')
  assert.match(source, new RegExp(`\\{ id: '${VAULT_CREDENTIALS_ROW}', section: '${VAULT_CREDENTIALS_SECTION.replace('&', '&')}',`),
    'the settings catalogue no longer declares this panel\'s row under the id and section this module exports')
  assert.match(source, /mount: 'vault-credentials'/, 'the row no longer names a socket for this panel to mount in')
  assert.match(source, /\[data-settings-mount="vault-credentials"\]/, 'nothing in the settings view looks for this panel\'s socket')
})

test('the panel lists record names and shows nothing that narrows a value', async () => {
  const seam = seamStub()
  const panel = createVaultCredentialsSettings({ vault: seam })
  await panel.refresh()

  /* POSITIVE FIRST, so a DOM stand-in that rendered nothing cannot make the
     privacy assertions below pass vacuously. */
  const rendered = panel.element.textContent
  for (const name of FAKE_NAMES) assert.ok(rendered.includes(name), `the panel did not list the record named ${name}`)
  assert.equal(panel.element.querySelectorAll('[data-vault-name]').length, FAKE_NAMES.length,
    'the panel drew a different number of records than the vault reported')
  assertNothingNarrowsAValue(rendered, 'the panel')

  /* AND IT NEVER ASKED FOR A VALUE. Stated as a property rather than as an
     exact call list: the earlier form pinned ['names'] and went red the moment
     the panel legitimately began reading the durable removal bindings on mount,
     which is a test failing against a better implementation. What matters is
     that no verb the panel calls could return a value at all. */
  const asked = new Set(seam.calls.map(call => call[0]))
  assert.deepEqual([...asked].sort(), ['names', 'pendingRemovals'],
    'the panel called a verb beyond listing names and reading its own pending bindings')
  panel.destroy()
})

test('an unreadable vault is not rendered as an empty one', async () => {
  const panel = createVaultCredentialsSettings({
    vault: { names: async () => ({ ok: false, code: 'VAULT_UNREADABLE', reason: 'This installation’s vault could not be read, so what it holds is unknown.' }) },
  })
  await panel.refresh()
  const rendered = panel.element.textContent
  assert.match(rendered, /could not be read/, 'the panel dropped the reason the vault could not be read')
  assert.ok(!rendered.includes(VAULT_COPY.empty), 'the panel told the owner his vault is empty when it could not be read')
  assert.equal(panel.element.querySelectorAll('[data-vault-name]').length, 0)
  panel.destroy()
})

test('an empty vault says it was read, which is a different sentence', async () => {
  const panel = createVaultCredentialsSettings({ vault: seamStub({ names: [] }) })
  await panel.refresh()
  assert.ok(panel.element.textContent.includes(VAULT_COPY.empty), 'a vault that was read and holds nothing did not say so')
  panel.destroy()
})

test('adding a credential sends a choice and a name, never a value', async () => {
  const seam = seamStub()
  const panel = createVaultCredentialsSettings({ vault: seam })
  await panel.refresh()
  panel.element.querySelector('[data-vault-new-name]').value = 'my_provider_api_key'
  await panel.add()

  const call = seam.calls.find(entry => entry[0] === 'add')
  assert.ok(call, 'pressing add asked the main process for nothing')
  assert.deepEqual(call[1], { credential: 'custom', customName: 'my_provider_api_key' })
  assert.ok(!('value' in call[1]), 'the add control sent a value to the main process')
  /* The panel says where the value gets typed, because a queued form the owner
     does not know to open is a credential that never arrives. */
  assert.ok(panel.element.textContent.includes(VAULT_COPY.addQueued), 'the panel did not tell the owner the entry form is waiting')
  assert.equal(panel.element.querySelector('[data-vault-new-name]').value, '', 'the panel kept the typed name after queueing it')
  panel.destroy()
})

test('a name the vault could never have issued is refused before anything is asked', async () => {
  const seam = seamStub()
  const panel = createVaultCredentialsSettings({ vault: seam })
  await panel.refresh()
  for (const typed of ['', '   ', 'has spaces', 'semi;colon', 'quote"mark']) {
    panel.element.querySelector('[data-vault-new-name]').value = typed
    await panel.add()
  }
  assert.equal(seam.calls.filter(entry => entry[0] === 'add').length, 0,
    'the panel sent a name the vault cannot hold to the main process')
  assert.match(panel.element.textContent, /letters, numbers/, 'the panel refused without saying what a name may contain')
  panel.destroy()
})

test('removing a credential needs the approvals surface, and nothing happens before it answers', async () => {
  const seam = seamStub()
  const panel = createVaultCredentialsSettings({ vault: seam })
  await panel.refresh()

  /* 1  PRESS REMOVE. It must ASK, not remove, and it must say where to answer. */
  await panel.askToRemove('legacy_token')
  assert.equal(seam.calls.filter(entry => entry[0] === 'completeRemoval').length, 0,
    'pressing remove removed the credential before the owner was asked')
  const rendered = panel.element.textContent
  assert.ok(rendered.includes(VAULT_COPY.removeAsked), 'pressing remove did not tell the owner his approval is needed')
  const link = panel.element.querySelector('[data-vault-approvals]')
  assert.ok(link, 'pressing remove offered no way to reach the approvals surface')
  assert.equal(link.getAttribute('href'), APPROVALS_HREF,
    'the panel pointed somewhere other than the product\'s approvals surface')
  /* The id is the seam's to choose, so this asserts the binding is for the
     right RECORD and matches what the seam handed back -- not a spelling. */
  const asked_ = seam.calls.find(entry => entry[0] === 'requestRemoval')
  assert.ok(asked_, 'pressing remove asked the main process for nothing')
  assert.equal(panel.awaitingRemoval()?.name, 'legacy_token')
  assert.ok(panel.awaitingRemoval()?.promptId, 'the panel holds no binding for the removal it asked about')

  /* 2  PRESS "REMOVE IT NOW" BEFORE ANSWERING. The record must survive. */
  await panel.finishRemoval('legacy_token')
  assert.ok(panel.element.textContent.includes(VAULT_COPY.removePending),
    'the panel did not say the approval is still unanswered')
  assert.ok((await seam.names()).names.includes('legacy_token'),
    'the credential was removed while the approval was still pending')

  /* 3  THE OWNER APPROVES ON THE APPROVALS SURFACE, then presses again. */
  seam.approve(panel.awaitingRemoval().promptId)
  await panel.refresh()
  assert.ok(panel.element.querySelector('[data-vault-finish="legacy_token"]'), 'confirmed approval exposes the finish control')
  await panel.finishRemoval('legacy_token')
  assert.ok(panel.element.textContent.includes(VAULT_COPY.removed), 'the panel did not confirm the removal')
  assert.equal(panel.awaitingRemoval(), null, 'the panel is still waiting on an approval it has already spent')
  /* AND THE LIST ON SCREEN CAUGHT UP. A panel still showing a removed record
     is a panel telling the owner his vault holds something it does not. */
  const after = panel.element.textContent
  assert.ok(!panel.element.querySelector('[data-vault-item="legacy_token"]'), 'the removed record is still drawn')
  for (const name of FAKE_NAMES.filter(candidate => candidate !== 'legacy_token')) {
    assert.ok(after.includes(name), `removing one record dropped ${name} from the list`)
  }
  panel.destroy()
})

test('a removal survives leaving the page to approve it', async () => {
  /* THE ASSERTION THAT WAS MISSING, and the defect it is for was found on
   * screen rather than by any suite.
   *
   * Approving a removal means LEAVING this page for #/approvals. Every
   * end-to-end we built drove request and complete IN ONE PROCESS, so the
   * navigation never happened and the panel's in-memory `awaiting` never
   * cleared. On a real screen it does clear: the completion control vanished,
   * the only control left was Remove, and pressing it raised a NEW prompt and
   * ORPHANED the approved one. The owner's decision was spent, the credential
   * stayed, and following the screen exactly could never finish a removal.
   *
   * So this test does the thing the others could not: it DESTROYS the panel
   * between Remove and approve and builds a new one over the same durable
   * state, exactly as navigating away and back does. Without the reload the fix
   * is unproven by the same blind spot that hid the defect. */
  const seam = seamStub()
  const first = createVaultCredentialsSettings({ vault: seam })
  await first.refresh()
  await first.askToRemove('legacy_token')
  const promptId = first.awaitingRemoval()?.promptId
  assert.ok(promptId, 'pressing Remove did not record a binding at all')

  /* The owner leaves for #/approvals. The panel goes with the page. */
  first.destroy()

  /* ...approves there... */
  seam.approve(promptId)

  /* ...and comes back to a NEW panel with no memory of anything. */
  const second = createVaultCredentialsSettings({ vault: seam })
  await second.refresh()

  assert.deepEqual(second.awaitingRemoval(), { name: 'legacy_token', promptId },
    'the rebuilt panel did not pick the approved binding back up off disk')
  assert.ok(second.element.querySelector('[data-vault-finish="legacy_token"]'),
    'the rebuilt panel offers no way to finish the removal the owner already approved')

  /* And finishing works on the approval he actually gave -- not a new one. */
  await second.finishRemoval('legacy_token')
  assert.ok(second.element.textContent.includes(VAULT_COPY.removed), 'the removal did not complete after the reload')
  assert.ok(!(await seam.names()).names.includes('legacy_token'), 'the record is still on file')
  /* ONE decision, not two: the reload must not have raised a second prompt. */
  assert.equal(seam.calls.filter(entry => entry[0] === 'requestRemoval').length, 1,
    'the flow raised more than one owner prompt for one removal')
  second.destroy()
})

test('pressing Remove again reuses the live binding instead of orphaning it', async () => {
  /* The other half of the same defect: the control the owner was left with.
     Pressing Remove while a binding is live must REUSE it -- minting a second
     promptId is what spends an approval on nothing. */
  const seam = seamStub()
  const panel = createVaultCredentialsSettings({ vault: seam })
  await panel.refresh()
  await panel.askToRemove('legacy_token')
  const firstId = panel.awaitingRemoval()?.promptId
  await panel.askToRemove('legacy_token')
  assert.equal(panel.awaitingRemoval()?.promptId, firstId,
    'pressing Remove twice changed the binding, orphaning the first')
  panel.destroy()
})

test('two removals awaiting approval can both be finished after a reload', async () => {
  /* THE SINGLE-SLOT DEFECT, which is the fix's own version of the defect it
   * fixes. The durable file holds one binding PER RECORD, up to
   * MAX_PENDING_APPROVALS of them. The restore draws a completion control on
   * every row it finds -- so if the panel remembers only ONE binding, the other
   * row carries a button reading "I approved it" that answers "this computer is
   * not waiting on an approval for that credential" and removes nothing.
   *
   * Same failure as the original, one record over: the screen offers a control
   * that cannot complete. Driven with TWO records, both approved, and both
   * finished, because one working and one dead button is exactly what a
   * one-record test cannot see. */
  const seam = seamStub()
  const first = createVaultCredentialsSettings({ vault: seam })
  await first.refresh()
  await first.askToRemove('legacy_token')
  await first.askToRemove('provider_api_key')
  const ids = ['legacy_token', 'provider_api_key'].map(name => first.awaitingRemoval(name)?.promptId)
  assert.ok(ids[0] && ids[1], 'two Removes did not record two bindings')
  assert.notEqual(ids[0], ids[1], 'two different records share one prompt id')

  /* Away to #/approvals, both approved, and back to a fresh panel. */
  first.destroy()
  for (const id of ids) seam.approve(id)
  const second = createVaultCredentialsSettings({ vault: seam })
  await second.refresh()

  for (const [index, name] of ['legacy_token', 'provider_api_key'].entries()) {
    assert.deepEqual(second.awaitingRemoval(name), { name, promptId: ids[index] },
      `the rebuilt panel did not pick ${name}'s approved binding back up`)
    assert.ok(second.element.querySelector(`[data-vault-finish="${name}"]`),
      `the rebuilt panel offers no way to finish ${name}`)
  }

  /* BOTH complete. Not "the last one the restore loop touched". */
  await second.finishRemoval('legacy_token')
  await second.finishRemoval('provider_api_key')
  const left = (await seam.names()).names
  assert.ok(!left.includes('legacy_token'), 'legacy_token is still on file')
  assert.ok(!left.includes('provider_api_key'), 'provider_api_key is still on file -- its button did nothing')
  assert.equal(seam.calls.filter(entry => entry[0] === 'requestRemoval').length, 2,
    'two removals raised something other than two owner prompts')

  second.destroy()

  /* And asking "which one" with two in flight REFUSES rather than guessing.
     A fresh seam, because the two records above are gone from the one used
     here and a panel cannot await a removal for a record it does not list. */
  const other = seamStub()
  const third = createVaultCredentialsSettings({ vault: other })
  await third.refresh()
  await third.askToRemove('legacy_token')
  await third.askToRemove('provider_api_key')
  assert.throws(() => third.awaitingRemoval(), /needs a name/,
    'asked which of two removals it is waiting on, the panel picked one')
  third.destroy()
})

test('a refused or unreadable answer is never drawn as an approval', async () => {
  /* THE CLAIM THIS PROVES, which had none until a mutation check went GREEN
   * where it should have gone red. The restore path draws the completion
   * controls for what it finds on disk, and the seam reports four decisions:
   * approved, waiting, refused and unknown. Only the first two are the owner
   * still being in the flow. The other two must draw NOTHING:
   *
   *   REFUSED -- he said no. Offering "I approved it, remove it now" on a row
   *   he just declined is the screen telling him his own answer back wrong, and
   *   pressing it spends a round trip to be told he did not approve it.
   *
   *   UNKNOWN -- the prompt store could not be read. "Could not look" and "he
   *   approved it" are different answers, and on a delete path an unreadable
   *   one must never round up. This is the same rule the seam applies when it
   *   refuses to remove; the screen must not undo it by drawing the button.
   *
   * Driven with a seam that reports all four at once, so the two that should
   * appear and the two that should not are measured in one pass -- a test with
   * only the refused case could pass on a panel that drew nothing at all. */
  const seam = {
    ...seamStub(),
    pendingRemovals: async () => ({
      ok: true,
      pending: [
        { name: 'legacy_token', promptId: 'prompt-refused', decision: 'refused' },
        { name: 'provider_api_key', promptId: 'prompt-unknown', decision: 'unknown' },
        { name: 'google_oauth_client_id', promptId: 'prompt-approved', decision: 'approved' },
      ],
    }),
  }
  const panel = createVaultCredentialsSettings({ vault: seam })
  await panel.refresh()

  for (const name of ['legacy_token', 'provider_api_key']) {
    assert.ok(panel.element.querySelector('[data-vault-item="' + name + '"]'),
      name + ' is not even on the page, so this test is measuring nothing')
    assert.equal(panel.element.querySelector('[data-vault-finish="' + name + '"]'), null,
      'the panel offered to finish a removal the owner refused or that it could not read an answer for: ' + name)
    assert.equal(panel.awaitingRemoval(name), null,
      'the panel is holding a binding for an answer that was not approval or waiting: ' + name)
  }

  /* AND THE APPROVED ONE IN THE SAME ANSWER IS STILL DRAWN, so the two above
     are a refusal to draw rather than a panel that draws nothing. */
  assert.ok(panel.element.querySelector('[data-vault-finish="google_oauth_client_id"]'),
    'the approved removal was not offered either, so nothing above is a measurement')
  assert.deepEqual(panel.awaitingRemoval('google_oauth_client_id'),
    { name: 'google_oauth_client_id', promptId: 'prompt-approved' })

  /* And pressing the button that is not there, the way a stale page or a
     keyboard could, still removes nothing. */
  await panel.finishRemoval('legacy_token')
  assert.ok((await seam.names()).names.includes('legacy_token'),
    'a record the owner refused to have removed was removed')
  assert.equal(seam.calls.filter(entry => entry[0] === 'completeRemoval').length, 0,
    'the panel asked the main process to complete a removal the owner had refused')
  panel.destroy()
})

test('finishing a removal the panel did not ask about does nothing', async () => {
  const seam = seamStub()
  const panel = createVaultCredentialsSettings({ vault: seam })
  await panel.refresh()
  await panel.finishRemoval('provider_api_key')
  assert.equal(seam.calls.filter(entry => entry[0] === 'completeRemoval').length, 0,
    'the panel tried to complete a removal it never asked the owner about')
  panel.destroy()
})

test('the vault panel never reads or writes the browser store', async () => {
  /* THE VAULT IS THE ENCRYPTED STORE, NOT localStorage. Two ways of asking, for
     the reason this repository keeps re-finding: a single grep has produced
     wrong verdicts here before.

     One -- drive the whole panel with a localStorage that THROWS on any access,
     so a touch is a failure rather than a value. */
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const trap = new Proxy({}, { get() { throw new Error('the vault panel touched localStorage') },
    set() { throw new Error('the vault panel wrote to localStorage') } })
  Object.defineProperty(globalThis, 'localStorage', { value: trap, writable: true, configurable: true })
  try {
    const seam = seamStub()
    const panel = createVaultCredentialsSettings({ vault: seam })
    await panel.refresh()
    panel.element.querySelector('[data-vault-new-name]').value = 'provider_api_key'
    await panel.add()
    await panel.askToRemove('legacy_token')
    await panel.finishRemoval('legacy_token')
    seam.approve(panel.awaitingRemoval().promptId)
    await panel.finishRemoval('legacy_token')
    /* And the reload path too, since that is where the panel now does its extra
       reading -- a store touch hiding in restorePendingRemovals would be
       exactly the kind this trap exists to catch. */
    panel.destroy()
    const reloaded = createVaultCredentialsSettings({ vault: seam })
    await reloaded.refresh()
    reloaded.destroy()
  } finally {
    if (saved) Object.defineProperty(globalThis, 'localStorage', saved)
    else delete globalThis.localStorage
  }

  /* Two -- the module's own CODE, which catches a path the drive above did not
     reach. Neither alone is an absence claim; together they are.

     COMMENTS ARE STRIPPED FIRST, and that is not a loophole. This module's
     header explains at length why the vault is NOT localStorage and why this
     row stores no `mc.set.*` key; a check that forbade the words would forbid
     writing down the rule. What must not exist is a reference node executes. */
  const code = read('src/vault-credentials-settings.js')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
  assert.match(code, /createVaultCredentialsSettings/, 'stripping comments removed the module’s code as well')
  assert.doesNotMatch(code, /localStorage|sessionStorage|mc\.set\./,
    'the vault panel names a browser store or a settings storage key')
})

test.after(() => { dom.restore() })
