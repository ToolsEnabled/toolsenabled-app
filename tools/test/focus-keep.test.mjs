/* KEYBOARD FOCUS ACROSS A REDRAW (T1386).
 *
 * Settings > Home screen, Settings > Setup and the System profile section
 * redraw themselves with outerHTML after every press. A browser drops focus to
 * the page when the focused node is removed, and nothing put it back: after
 * Enter on 'Only the ones I pick', or Space on an agent switch, the next Tab
 * started again at the first control of the section.
 *
 * The DOM stand-in does not model that browser rule, so this file adds it to
 * the one node that is redrawn: its outerHTML setter replaces the node, and if
 * focus was inside, focus falls to the page body, as it does in Chromium.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'

const keeperModule = () => import('../../src/focus-keep.js').catch(() => null)

/* outerHTML as a browser does it, including the focus it drops. */
function redrawable(node) {
  Object.defineProperty(node, 'outerHTML', {
    configurable: true,
    set(markup) {
      const doc = this.ownerDocument
      const holder = doc.createElement('div')
      holder.innerHTML = markup
      const next = holder.firstElementChild
      const hadFocus = this.contains(doc.activeElement)
      this.replaceWith(next)
      if (hadFocus) doc.activeElement = doc.body
      redrawable(next)
    },
  })
  return node
}

test('a keeper gives focus back to the control with the same name after a redraw, and only then', async () => {
  const mod = await keeperModule()
  assert.ok(mod?.focusKeeper, 'nothing keeps focus across a redraw')
  const installed = installDomStandIn(globalThis)
  try {
    const host = document.createElement('div')
    document.body.appendChild(host)
    host.innerHTML = '<section data-part="x"><button data-set="agents" data-value="all">All</button><button data-set="agents" data-value="chosen">Pick</button></section>'
    const section = redrawable(host.firstElementChild)
    const keeper = mod.focusKeeper()
    section.querySelectorAll('button')[1].focus()
    keeper.hold(section)
    section.outerHTML = '<section data-part="x"><button data-set="agents" data-value="all">All</button><button data-set="agents" data-value="chosen" aria-pressed="true">Pick</button></section>'
    assert.equal(document.activeElement, document.body, 'the stand-in no longer drops focus like a browser; this test proves nothing')
    const fresh = host.firstElementChild
    assert.equal(keeper.restore(fresh), true)
    assert.equal(document.activeElement, fresh.querySelectorAll('button')[1])

    /* A control that is disabled while it works gets focus back once usable. */
    const refresh = document.createElement('button')
    refresh.setAttribute('data-refresh', '')
    host.appendChild(refresh)
    refresh.focus()
    keeper.hold(refresh)
    refresh.disabled = true
    document.activeElement = document.body
    assert.equal(keeper.restore(refresh), false, 'focus went to a disabled control')
    refresh.disabled = false
    assert.equal(keeper.restore(refresh), true)
    assert.equal(document.activeElement, refresh)

    /* The person moved focus themselves: nothing is taken back. */
    const other = document.createElement('input')
    host.appendChild(other)
    fresh.querySelectorAll('button')[0].focus()
    keeper.hold(fresh)
    fresh.outerHTML = '<section data-part="x"><button data-set="agents" data-value="all">All</button></section>'
    other.focus()
    assert.equal(keeper.restore(host.firstElementChild), false)
    assert.equal(document.activeElement, other)
  } finally { installed.restore() }
})

test('Settings > Home screen keeps focus on the pressed choice and the ticked switch', async () => {
  const mod = await keeperModule()
  assert.ok(mod?.focusKeeper, 'the Home screen section drops focus on every press')
  const installed = installDomStandIn(globalThis)
  const values = new Map()
  globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) }
  try {
    const { createChatboxSettings } = await import('../../src/chatbox-settings.js')
    const settings = createChatboxSettings()
    const host = document.createElement('div')
    document.body.appendChild(host)
    host.innerHTML = settings.markup({ searchResult: false })
    redrawable(host.firstElementChild)
    settings.bind(host)
    const choice = () => host.querySelectorAll('button').find(button => button.getAttribute('data-chatbox-set') === 'agents' && button.getAttribute('data-chatbox-value') === 'chosen')
    choice().focus()
    choice().click()
    assert.equal(values.has('mc.chat.agents'), true, 'the press did not reach the section')
    assert.equal(document.activeElement, choice(), 'Enter on a choice dropped focus to the page')
    const runs = () => host.querySelectorAll('button').find(button => button.getAttribute('data-chatbox-set') === 'runs' && button.getAttribute('data-chatbox-value') === 'hidden')
    runs().focus()
    runs().click()
    assert.equal(document.activeElement, runs())
    settings.destroy?.()
  } finally { installed.restore(); delete globalThis.localStorage }
})

test('the three Settings sections that redraw with outerHTML keep focus through a keeper', () => {
  for (const [file, selector] of [
    ['chatbox-settings.js', '[data-chatbox-settings]'],
    ['setup-profile-settings.js', '[data-setup-profile-system]'],
    ['fleet-profile-settings.js', '[data-profile-system]'],
  ]) {
    const source = readFileSync(new URL(`../../src/${file}`, import.meta.url), 'utf8')
    assert.match(source, /import \{ focusKeeper \} from '\.\/focus-keep\.js'/, `${file} redraws without keeping focus`)
    const refresh = source.slice(source.indexOf('  function refresh() {'), source.indexOf('\n  }\n', source.indexOf('  function refresh() {')))
    assert.match(refresh, /focus\.hold\(current\)\n\s*current\.outerHTML = markup\(\{ searchResult \}\)[\s\S]*?focus\.restore\(hostRoot\.querySelector\('([^']+)'\)\)/, `${file} refresh() does not hold and restore focus`)
    assert.ok(refresh.includes(`'${selector}'`), `${file} restores focus into a different node`)
  }
})

/* T1559: refresh-type buttons disable themselves while they work, which drops
   focus, and nothing put it back: Metrics 'Refresh data', Settings 'Read saved
   values', Data & privacy 'Refresh' (its panel is redrawn whole) and Ledger
   'Review unconfirmed history'. The stand-in models the browser rule that a
   control loses focus when it is disabled. */
test('Review unconfirmed history keeps focus through its check', async () => {
  const mod = await keeperModule()
  assert.ok(mod?.focusKeeper)
  const installed = installDomStandIn(globalThis)
  try {
    const { mountLedgerCustodyControls } = await import('../../src/ledger-custody-controls.js')
    const root = document.createElement('div')
    document.body.appendChild(root)
    root.innerHTML = '<div data-ledger-custody><button type="button" data-ledger-custody-review>Review unconfirmed history…</button><p data-ledger-custody-status></p></div>'
    const button = root.querySelector('[data-ledger-custody-review]')
    let value = false
    Object.defineProperty(button, 'disabled', { configurable: true, get: () => value, set: next => { value = Boolean(next); if (value && document.activeElement === button) document.activeElement = document.body } })
    let answer
    const bridge = { ledgerCustodyPreview: () => new Promise(resolve => { answer = resolve }), ledgerCustodyConfirm: async () => ({ ok: true }) }
    const controls = mountLedgerCustodyControls(root, { bridge })
    controls.update({ enabled: true })
    button.focus()
    button.click()
    assert.equal(button.disabled, true, 'the button is not busy while it checks')
    answer({ ok: true, count: 0, revision: 1, token: 'a'.repeat(64) })
    for (let turn = 0; turn < 6; turn += 1) await Promise.resolve()
    assert.equal(button.disabled, false)
    assert.equal(document.activeElement, button, 'focus fell to the page after the check')
    controls.destroy()
  } finally { installed.restore() }
})

test('the refresh-type buttons hold focus while they work and give it back after', () => {
  const read = file => readFileSync(new URL(`../../src/${file}`, import.meta.url), 'utf8')
  const metrics = read('views/metrics.js')
  assert.match(metrics, /refreshFocus\.hold\(refresh\)\n\s*refresh\.disabled = true/, 'Refresh data drops focus while it reads')
  assert.match(metrics, /refresh\.disabled = false\n\s*refresh\.textContent = 'Refresh data'\n\s*refreshFocus\.restore\(refresh\)/)
  const profile = read('settings-profile-settings.js')
  assert.match(profile, /refreshFocus\.hold\(root\?\.querySelector\('\[data-working-profile-refresh\]'\)\)\n\s*loading = true/, 'Read saved values drops focus while it reads')
  assert.match(profile, /paint\(\)\n\s*refreshFocus\.restore\(root\?\.querySelector\('\[data-working-profile-refresh\]'\)\)\n  \}/)
  const diagnostics = read('diagnostic-settings.js')
  assert.match(diagnostics, /panelFocus\.hold\(panel\)\n\s*panel\.outerHTML = markup\(\)\n\s*panelFocus\.restore\(root\.querySelector\('\[data-diagnostic-files\]'\)\)/, 'the diagnostic panel redraw drops focus')
  const custody = read('ledger-custody-controls.js')
  assert.match(custody, /reviewFocus\.hold\(button\)\n\s*busy = true; update\(\)/)
})
