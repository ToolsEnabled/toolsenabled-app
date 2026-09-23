/* THE EXAMPLE'S OWN ACCOUNTS (src/sample-accounts.js), read by the menu's own
 * parser and drawn by the menu's own rows -- on the example only, to read.
 *
 * The example fleet's accounts menu used to hold a sentence and a Sign in
 * link. Owner, 2026-09-11: the example should show how the product works. So
 * it now draws the sign-ins the working tree spends, and these tests hold the
 * lines that matter:
 *   - the example is a raw shell reply read by readAccountList, never a
 *     hand-built parsed shape, so the menu's rules reach it;
 *   - it shows a used-up Codex account and the one Keep trying accounts moved
 *     to, Claude's two weeks, Gemini's weekly buckets per model, and Grok's
 *     honest "did not report";
 *   - nothing in it is anyone's: example:// folders, no signed-in address;
 *   - on the example, the menu draws those rows with no press on them and no
 *     per-program rule beside them, and its button keeps its plain name.
 *
 * Run: node --test tools/test/sample-accounts.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

import { installDomStandIn } from './lib/dom-stand-in.mjs'

register('./css-loader.mjs', import.meta.url)
const { document } = installDomStandIn()
const cells = new Map()
globalThis.localStorage = {
  getItem: key => (cells.has(key) ? cells.get(key) : null),
  setItem: (key, value) => { cells.set(key, String(value)) },
  removeItem: key => { cells.delete(key) },
}

const NOW = Date.parse('2026-09-11T09:00:00Z')
const { sampleAccountsRaw, sampleAccountListing } = await import('../../src/sample-accounts.js')
const { COPY, mergeAccounts, groupByProvider, rowLines, accountBars } = await import('../../src/account-switcher-state.js')
const { setExampleMode, currentDataSource } = await import('../../src/data-source.js')
const { accountSwitcher } = await import('../../src/account-switcher.js')

test('the example accounts are read by the menu’s own parser and say what each program reports', () => {
  const { listing, usage } = sampleAccountListing(NOW)
  assert.equal(listing.available, true)
  assert.equal(usage?.ok, true)
  const accounts = mergeAccounts(listing, usage)
  const byKey = new Map(accounts.map(account => [`${account.provider}:${account.name}`, account]))
  assert.deepEqual(groupByProvider(accounts).map(group => group.label), ['Codex', 'Claude', 'Gemini', 'Grok'])

  const work = byKey.get('codex:Work'), personal = byKey.get('codex:Personal')
  assert.equal(work.active, false)
  assert.equal(work.chosen, true, 'the used-up Work account is still the one that was chosen')
  assert.equal(personal.active, true, 'Keep trying accounts moved Codex to Personal')
  assert.match(rowLines(work, { now: NOW }).map(line => line.text).join(' '), /0% free this 5-hour window/)

  const claudeBars = accountBars(byKey.get('claude:Work'), { now: NOW }).map(bar => bar.label)
  assert.deepEqual(claudeBars, [COPY.hourlyBar, COPY.weeklyAll, COPY.weeklyModel('Opus')])

  const gemini = byKey.get('gemini:Antigravity')
  assert.equal(gemini.client, 'antigravity')
  const buckets = accountBars(gemini, { now: NOW }).slice(1).map(bar => bar.sentence)
  assert.equal(buckets.length, 2)
  assert.match(buckets[0], /62% free this week \(Gemini 3\.1 Pro\)/)
  assert.match(buckets[1], /88% free this week \(Gemini 3\.8 Flash\)/)

  assert.deepEqual(rowLines(byKey.get('grok:Grok'), { now: NOW }).map(line => line.text), [COPY.usageNotReportedFor('Grok')],
    'Grok’s row must say its program did not report, not invent a figure')
})

test('nothing in the example is anyone’s, and the same moment gives the same accounts', () => {
  const raw = sampleAccountsRaw(NOW)
  for (const account of raw.accounts) assert.match(account.directory, /^example:\/\//)
  assert.equal(new Set(raw.accounts.map(account => account.allowanceBinding)).size, raw.accounts.length)
  for (const reading of raw.usageCache.accounts) {
    assert.match(reading.allowanceBinding, /^[a-f0-9]{64}$/)
    const registered = raw.accounts.find(account => account.provider === reading.provider && account.name === reading.name)
    assert.equal(reading.allowanceBinding, registered.allowanceBinding, 'the example uses the same identity contract as native replies')
  }
  for (const row of raw.usageCache.accounts) assert.equal(row.email, undefined, 'an example row carries a signed-in address')
  assert.doesNotMatch(JSON.stringify(raw), /@|\/home\/|\\Users\\|C:\\/)
  assert.deepEqual(sampleAccountsRaw(NOW), sampleAccountsRaw(NOW))
})

test('on the example the menu draws those rows to read, with no press on them', () => {
  setExampleMode(true)
  assert.equal(currentDataSource(), 'mock')
  const root = accountSwitcher({ scope: {} })
  document.body.appendChild(root)
  try {
    assert.equal(root.dataset.preview, 'yes')
    assert.equal(root.querySelector('.acct-preview').hidden, false, 'the line saying whose accounts these are not must stay')
    const rows = root.querySelectorAll('.acct-row')
    assert.equal(rows.length, 5)
    for (const row of rows) {
      assert.equal(row.querySelectorAll('button').length, 0, 'an example row offers a press')
      assert.equal(row.querySelectorAll('.acct-row-actions').length, 0)
    }
    for (const head of root.querySelectorAll('.acct-group-head')) {
      assert.equal(head.querySelectorAll('select').length, 0, 'an example program offers its own rule control')
    }
    assert.equal(root.querySelector('.acct-trigger-label').textContent, COPY.buttonUnread, 'the button named an example account as if it were in use')
    assert.ok(root.querySelectorAll('.acct-line').some(line => line.textContent === COPY.usageNotReportedFor('Grok')))
  } finally {
    root.__accountSwitcher.destroy()
    root.remove()
    setExampleMode(false)
  }
})

test('on a desktop whose example switch is on, the menu shows the example too and never reads the real list', () => {
  setExampleMode(true)
  const calls = []
  const scope = { mcProviders: { accounts: () => { calls.push('accounts'); return Promise.resolve({ ok: true, accounts: [] }) } } }
  const root = accountSwitcher({ scope })
  document.body.appendChild(root)
  try {
    assert.equal(root.dataset.preview, 'yes')
    assert.equal(root.querySelector('.acct-preview .acct-help').textContent, COPY.previewHelpDesktop)
    assert.equal(root.querySelector('.acct-preview a').hidden, true, 'the desktop is offered the website’s Sign in')
    assert.equal(root.querySelectorAll('.acct-row').length, 5)
    assert.deepEqual(calls.filter(name => name === 'accounts'), [], 'the example read this computer’s real account list')
  } finally {
    root.__accountSwitcher.destroy()
    root.remove()
    setExampleMode(false)
  }
})
