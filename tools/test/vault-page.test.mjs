/* THE VAULT IS A PAGE, AND THE PAGE DOES WHAT IT SAYS.
 *
 * WHY THIS SUITE EXISTS, IN THE OWNER'S OWN WORDS. The vault surface had been
 * delivered three times as a ROW inside Settings' "Data & Privacy" category --
 * real, reachable, and not a page. The third time he wrote:
 * "i still dont see vault page anywhere wtf? its supposed to have its own page
 * like settings and ledger does". A row inside a category inside another page
 * is not that, and the gap was never caught because nothing asserted the
 * difference: the row's own tests all passed.
 *
 * So the first two cases here assert the part that kept going missing -- that
 * `#/vault` RESOLVES and that the left navigation OFFERS it -- and they assert
 * it the way a person meets it, through parseRoute and through the rendered
 * navigation, not by reading a constant back out of the module that defines it.
 *
 * THE REST ASSERT THE PROMISE THE PAGE MAKES. A nickname exists to hide a real
 * record name, so "shows the nickname" is not enough: the real name must be
 * absent from what the page displays by default. And the checkboxes must reach
 * the durable policy rather than merely redrawing, because a switch that only
 * hid a row would be a label on a door that does not lock -- which is exactly
 * what this feature shipped as the first time.
 *
 * NO CSS IS ASSERTED HERE. tools/test/lib/dom-stand-in.mjs has no cascade, so
 * this suite can say what the page CONTAINS and never how it looks. The
 * rendered appearance is evidenced by a screenshot of the real app instead, and
 * that distinction is deliberate rather than an omission.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { readFileSync } from 'node:fs'
import { installDomStandIn } from './lib/dom-stand-in.mjs'

/* The view imports its stylesheets, which Vite resolves and node does not.
   Stubbing them to empty modules is the same hook tools/test/comms.test.mjs
   uses; it is why this suite can say nothing about appearance. */
register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.css')) return { url: new URL(specifier, context.parentURL).href, shortCircuit: true }
    return nextResolve(specifier, context)
  }
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)

installDomStandIn(globalThis)

const { parseRoute } = await import('../../src/route-parse.js')
const { mountAppNavigation } = await import('../../src/app-navigation.js')
const { vaultView, matrixRoles, VAULT_PAGE_COPY } = await import('../../src/views/vault.js')

/* A bridge that answers like the preload's `window.mcVault`, and records writes.
 *
 * THE ANSWER SHAPE HERE IS COPIED FROM THE REAL ONE, NOT FROM THE VIEW. An
 * earlier version of this helper returned `{readable, detail}` because that is
 * what the view was reading -- so the suite agreed with the view and both were
 * wrong, and the page could not draw a row on a real machine while every case
 * here passed. The shape below is what a private candidate's bridge actually
 * returned, quoted in the report:
 *   {"ok":true,"code":"VAULT_NAMES_READ","names":["github_pat","stripe_secret_key"],"store":"..."}
 * `ok`/`reason` is also the contract shell/vault-credential-page.cjs
 * `listCredentialNames` documents and src/vault-credentials-settings.js
 * `paintNames` has always read. */
function bridgeOf({ names = ['stripe_secret_key'], ok = true, policyReadable = true, records = {} } = {}) {
  const calls = []
  return {
    calls,
    names: async () => (ok
      ? { ok: true, code: 'VAULT_NAMES_READ', names, store: 'C:\\candidate\\vault\\secrets.json' }
      : { ok: false, code: 'VAULT_UNREADABLE', reason: 'the store could not be read' }),
    policy: async () => ({ readable: policyReadable, records }),
    setNickname: async request => { calls.push(['setNickname', request]); return { ok: true } },
    setAccess: async request => { calls.push(['setAccess', request]); return { ok: true } }
  }
}

/* The view's refresh is async, so a mount must settle before it is read. Two
   turns of the microtask queue is what its own Promise.all costs. */
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }

test('#/vault resolves to its own route, the way #/ledger and #/settings do', () => {
  assert.deepEqual(parseRoute('#/vault'), { name: 'vault' })
  /* The comparison that carries the owner's complaint: these are peers. */
  assert.equal(parseRoute('#/ledger').name, 'ledger')
  assert.equal(parseRoute('#/settings').name, 'settings')
})

test('the shipped markup offers Vault in the same nav as Ledger and Settings', () => {
  /* THE ASSERTION THE OWNER'S COMPLAINT MAPS ONTO. Read from the real
     index.html the app ships rather than from a fixture, because a fixture
     would keep passing after somebody deleted the link. */
  const markup = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
  const nav = markup.slice(markup.indexOf('<nav'), markup.indexOf('</nav>'))
  assert.match(nav, /<a href="#\/vault" data-route="vault">Vault<\/a>/)
  /* Peers in the same navigation, which is what "its own page like settings and
     ledger does" means. */
  assert.match(nav, /data-route="ledger"/)
  assert.match(nav, /data-route="settings"/)
})

test('the navigation draws Vault with its own icon, not the fallback', () => {
  /* mountAppNavigation reads `header.topbar #tb-nav` off a document. The
     stand-in's document object has no querySelector of its own, so the shim
     below delegates to a real element tree -- the elements under test are
     genuine, only the lookup is bridged. */
  const root = document.createElement('div')
  root.innerHTML = `<header class="topbar">
    <div class="tb-left"></div>
    <nav id="tb-nav">
      <a href="#/home" data-route="home">Home</a>
      <a href="#/ledger" data-route="ledger">Ledger</a>
      <a href="#/vault" data-route="vault">Vault</a>
    </nav>
    <div class="tb-right"></div>
  </header>`
  const documentRef = {
    querySelector: selector => root.querySelector(selector),
    createElement: tag => document.createElement(tag),
    body: document.body,
    documentElement: document.documentElement
  }
  mountAppNavigation({ documentRef })

  const entry = root.querySelector('[data-route=vault]')
  assert.ok(entry, 'the navigation has no Vault entry')
  assert.equal(entry.getAttribute('href'), '#/vault')
  // Compare the rendered glyphs by value. A padlock can use paths or rectangles;
  // the behavior is a distinct, nonempty Vault icon instead of the Home fallback.
  const iconOf = link => link.querySelector('.app-nav-icon')
  const glyph = link => ['path', 'rect', 'circle', 'line', 'polyline', 'polygon']
    .flatMap(tag => [...iconOf(link).querySelectorAll(tag)])
    .map(shape => [shape.tagName, ...['d','x','y','width','height','cx','cy','r','points','x1','y1','x2','y2']
      .map(key => shape.getAttribute(key))])
  assert.ok(iconOf(entry), 'the Vault entry was not given an icon')
  const vaultGlyph = glyph(entry)
  assert.ok(vaultGlyph.length > 0, 'the Vault glyph contains no visible shapes')
  assert.notDeepEqual(vaultGlyph, glyph(root.querySelector('[data-route=ledger]')))
  assert.notDeepEqual(vaultGlyph, glyph(root.querySelector('[data-route=home]')),
    'Vault must not fall back to the Home glyph')

})

test('a nicknamed record shows the nickname INSTEAD of its real name', async () => {
  const bridge = bridgeOf({
    names: ['stripe_secret_key'],
    records: { stripe_secret_key: { nickname: 'the card one', access: {} } }
  })
  const view = vaultView({ vault: bridge })
  await settle()

  const heading = view.el.querySelector('[data-vault-shown]')
  assert.equal(heading.textContent, 'the card one')
  /* THE WHOLE POINT. The owner asked for nicknames "so that they arent
     visible"; a nickname shown BESIDE the real name would leave it visible. */
  const disclosure = view.el.querySelector('[data-vault-real]')
  assert.ok(disclosure, 'the real name should still be reachable on purpose')
  assert.equal(disclosure.textContent, 'stripe_secret_key')
  assert.equal(view.el.querySelector('details').hasAttribute('open'), false,
    'the real name must be closed until the owner opens it')

  /* NOTHING ELSE ON THE ROW MAY PRINT THE REAL NAME EITHER. The rendered page
     showed "Secret nickname for stripe_secret_key" immediately under a heading
     that had just replaced that name -- the row hid it in one line and
     published it in the next. Checking every visible string on the row, rather
     than the heading alone, is what makes this case about the owner's actual
     request instead of about one element. */
  const visible = [...view.el.querySelectorAll('h2, label, legend, summary, span')]
    .map(node => node.textContent)
    .join(' | ')
  assert.equal(visible.includes('stripe_secret_key'), false,
    `the real record name is still printed on the row: ${visible}`)
})

test('a record with no nickname shows its real name and offers no disclosure', async () => {
  const bridge = bridgeOf({ names: ['stripe_secret_key'], records: {} })
  const view = vaultView({ vault: bridge })
  await settle()
  assert.equal(view.el.querySelector('[data-vault-shown]').textContent, 'stripe_secret_key')
  assert.equal(view.el.querySelector('[data-vault-real]'), null)
})

test('an unruled role draws as allowed, and a denied one draws as refused', async () => {
  const bridge = bridgeOf({
    names: ['stripe_secret_key'],
    records: { stripe_secret_key: { nickname: null, access: { builder: false } } }
  })
  const view = vaultView({ vault: bridge })
  await settle()

  const builder = view.el.querySelector('[data-vault-role=builder]')
  const reviewer = view.el.querySelector('[data-vault-role=reviewer]')
  assert.ok(builder && reviewer, 'the matrix must draw a cell per role')
  assert.equal(builder.checked, false, 'a role the owner turned off must draw as off')
  /* An unruled role reads as allowed because that is what the policy actually
     does. Drawing it off would tell the owner he had closed something he had
     not. */
  assert.equal(reviewer.checked, true)
})

test('pressing a matrix cell writes the decision through, it does not just redraw', async () => {
  const bridge = bridgeOf({ names: ['stripe_secret_key'], records: {} })
  const view = vaultView({ vault: bridge })
  await settle()

  const builder = view.el.querySelector('[data-vault-role=builder]')
  builder.checked = false
  builder.dispatchEvent({ type: 'change' })
  await settle()

  /* `subject` names WHICH role the owner's rule is about. It is deliberately
     not spelled `principal`: that word is the identity of whoever is ASKING to
     read a record, which is decided in the main process and never sent from
     here. See the note on mc-vault:set-access in shell/main.cjs. */
  assert.deepEqual(bridge.calls, [['setAccess', { name: 'stripe_secret_key', subject: 'builder', allowed: false }]])
})

test('a refused write puts the control back rather than leaving a lie on screen', async () => {
  const bridge = bridgeOf({ names: ['stripe_secret_key'], records: {} })
  bridge.setAccess = async () => ({ ok: false })
  const view = vaultView({ vault: bridge })
  await settle()

  const builder = view.el.querySelector('[data-vault-role=builder]')
  builder.checked = false
  builder.dispatchEvent({ type: 'change' })
  await settle()

  assert.equal(view.el.querySelector('[data-vault-role=builder]').checked, true,
    'the current control must show the retained decision after a refused write')
  assert.equal(view.el.querySelector('[data-vault-status]').textContent, VAULT_PAGE_COPY.accessRefused)
})

test('an unreadable vault and an empty one get different sentences', async () => {
  const unreadable = vaultView({ vault: bridgeOf({ ok: false }) })
  await settle()
  const empty = vaultView({ vault: bridgeOf({ names: [] }) })
  await settle()

  const said = view => view.el.querySelector('[data-vault-status]').textContent
  /* "You have no credentials", rendered out of a store that could not be
     opened, is a false sentence about the owner's own machine. */
  assert.notEqual(said(unreadable), said(empty))
  assert.equal(said(empty), VAULT_PAGE_COPY.empty)
  assert.equal(said(unreadable), 'the store could not be read')
})

test('an unreadable POLICY is reported as such, not as an open vault', async () => {
  const view = vaultView({ vault: bridgeOf({ policyReadable: false }) })
  await settle()
  assert.equal(view.el.querySelector('[data-vault-status]').textContent, VAULT_PAGE_COPY.policyUnreadable)
  assert.equal(view.el.querySelector('[data-vault-shown]'), null,
    'no record may be drawn as readable while the decisions about it are unavailable')
})

test('a bridge that throws does not leave the page saying it is still reading', async () => {
  /* "Reading what this computer's vault holds." is a true sentence only while
     it is true. Left on screen after the read has already failed it is a false
     statement about the owner's own machine, and it is indistinguishable from a
     slow read that is about to finish -- so the person waits for something that
     is never coming. */
  const bridge = bridgeOf()
  bridge.names = async () => { throw new Error('the main process went away') }
  const view = vaultView({ vault: bridge })
  await settle()

  const said = view.el.querySelector('[data-vault-status]').textContent
  assert.notEqual(said, VAULT_PAGE_COPY.reading)
  assert.equal(said, VAULT_PAGE_COPY.unreadable)
})

test('the matrix draws the roles an agent can run as, and not the drawing buckets', () => {
  const ids = matrixRoles().map(role => role.id)
  assert.ok(ids.includes('builder') && ids.includes('manager') && ids.includes('reviewer'))
  /* `default` and `spawned` are presentation buckets for the tree drawing and
     `shadow` is the legacy spelling of `shadow-manager`; a column for any of
     them would be a rule that names nobody, or two columns meaning one thing. */
  for (const bucket of ['default', 'spawned', 'shadow']) {
    assert.equal(ids.includes(bucket), false, `${bucket} is not a role an agent runs as`)
  }
})

test('the embedded panel never says the vault was read when this page has not read it', async () => {
  /* Observed in a real window 2026-09-21 (no Linux secret service): the page said
     "What the vault holds is unknown" and, inside "Add or remove credentials",
     the panel said "This computer's vault was read and holds no credentials."
     The panel's invalidate() wrote that sentence before any read, and none of
     this page's three failure exits ever replaced it. */
  const { VAULT_COPY } = await import('../../src/vault-credentials-settings.js')
  const note = view => view.el.querySelector('[data-vault-listing-note]')
  const claimsRead = view => !note(view).hidden && note(view).textContent.includes(VAULT_COPY.empty)
  const throwing = bridgeOf()
  throwing.names = async () => { throw new Error('the main process went away') }
  for (const [label, vault] of [
    ['an unreadable vault', bridgeOf({ ok: false })],
    ['a bridge that throws', throwing],
    ['an unreadable policy over a vault that holds a record', bridgeOf({ policyReadable: false })],
  ]) {
    const view = vaultView({ vault })
    assert.equal(claimsRead(view), false, label + ': the panel claimed a read before any read had answered')
    await settle(); await settle()
    assert.equal(claimsRead(view), false, label + ': the panel says the vault was read and is empty')
    view.destroy()
  }
  /* The true sentence survives: a vault that WAS read and holds nothing says so. */
  const empty = vaultView({ vault: bridgeOf({ names: [] }) })
  await settle(); await settle()
  assert.equal(claimsRead(empty), true, 'a vault that was read and is empty no longer says so')
  empty.destroy()
})
