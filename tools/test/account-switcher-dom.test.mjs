/* THE ACCOUNTS MENU'S DOM HALF, MOUNTED AND PRESSED.
 *
 * src/account-switcher.js is the half of the page-2 accounts menu that has a
 * document: it builds the control, opens and closes it, and puts the answers
 * on the glass. tools/test/account-switcher-state.test.mjs holds every rule
 * and every sentence to account as values; nothing held the DOM half to
 * anything, and the reason given -- "the repo has no jsdom" -- was true and
 * beside the point. tools/test/lib/dom-stand-in.mjs is already the document
 * under 21 suites (measured 2026-09-02: grep -l lib/dom-stand-in.mjs over
 * tools/test/*.test.mjs), and tools/test/css-loader.mjs makes a module that
 * imports its own stylesheet loadable under node. This suite
 * mounts the real module on that stand-in with a fake mcProviders bridge and
 * presses it: open, Escape, a press outside, the mode select, Check
 * allowances, Use this one, Sign in and Add.
 *
 * WHAT THE STAND-IN CANNOT DO, said so the assertions are read correctly.
 * It has no layout and no focus fixup: a removed or disabled element that
 * held focus does not drop activeElement to the body on its own, the way a
 * browser does. So a focus assertion here proves what the MODULE moves --
 * which is the half the finding was about -- and not what a browser would
 * have done without it. Its document also holds no listeners at all
 * (addEventListener is a no-op), and the two document-level listeners are
 * the whole point of the Escape and press-outside tests, so this file gives
 * that document a real listener table before anything is mounted.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

import { installDomStandIn } from './lib/dom-stand-in.mjs'
/* THE DOOR IS ASSERTED BY THE CONSTANT. This menu has no Install button and
   both of its doors have to land where Install actually is; the spelling of
   that address is the product's decision and has already moved once. */
import { GUIDE_HREF } from '../../src/first-run-needs.js'

register('./css-loader.mjs', import.meta.url)

const dom = installDomStandIn()
const { document } = dom

/* A LISTENER TABLE FOR THE STAND-IN DOCUMENT. Capture listeners run before
   bubble listeners, which is the order a real document runs them in for an
   event aimed at the document or at anything inside it; the menu registers
   both of its listeners with capture, and the rail's Escape handler this menu
   has to beat is a capture listener on the same document. An event carries
   the three methods the menu calls, each recording that it was called. */
const documentListeners = new Map()
document.addEventListener = (type, listener, options) => {
  if (!documentListeners.has(type)) documentListeners.set(type, [])
  const capture = options === true || Boolean(options && options.capture)
  documentListeners.get(type).push({ listener, capture })
}
document.removeEventListener = (type, listener) => {
  documentListeners.set(type, (documentListeners.get(type) || []).filter(entry => entry.listener !== listener))
}
function documentEvent(type, fields = {}) {
  const event = {
    type,
    target: document.body,
    defaultPrevented: false,
    propagationStopped: false,
    immediatePropagationStopped: false,
    preventDefault() { this.defaultPrevented = true },
    stopPropagation() { this.propagationStopped = true },
    stopImmediatePropagation() { this.immediatePropagationStopped = true; this.propagationStopped = true },
    ...fields,
  }
  const entries = [...(documentListeners.get(type) || [])]
  for (const entry of [...entries.filter(entry => entry.capture), ...entries.filter(entry => !entry.capture)]) {
    entry.listener(event)
    if (event.immediatePropagationStopped) break
  }
  return event
}
const listenerCount = type => (documentListeners.get(type) || []).length

/* Dynamic imports, after the loader is registered and the document stands. */
const { COPY, NOT_INSTALLED_CODE, providerLabel } = await import('../../src/account-switcher-state.js')
const { accountSwitcher } = await import('../../src/account-switcher.js')

test.after(() => dom.restore())

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

test('an empty profile offers account setup and keeps unavailable policy and allowance actions disabled', async () => {
  const state = freshState()
  state.accounts = []
  const menu = await mount(fakeBridge(state))
  try {
    await menu.open()
    assert.equal(menu.mode.disabled, true)
    assert.equal(menu.refresh.disabled, true)
    assert.equal(menu.addButton('codex').disabled, false)
    assert.equal(document.activeElement, menu.name)
    assert.match(menu.list.textContent, /first account/i)
    assert.equal(menu.root.querySelector('[data-acct="setup"]').getAttribute('href'), GUIDE_HREF)
    menu.addButton('codex').click()
    await settle()
    assert.equal(menu.mode.disabled, false)
    assert.equal(menu.refresh.disabled, false)
  } finally { menu.destroy() }
})

test('missing provider programs offer setup and a later refresh enables adding them', async () => {
  let installed = 'no'
  const fixture = fakeBridge(freshState(), {
    presence: async () => ({ ok: true, providers: [{ id: 'codex', installed }, { id: 'claude', installed: 'unknown' }] }),
  })
  const menu = await mount(fixture)
  try {
    await menu.open()
    assert.equal(menu.addButton('codex').disabled, true)
    const setup = [...menu.root.querySelectorAll('[data-acct="setup-provider"]')].find(link => link.dataset.provider === 'codex')
    assert.equal(setup.hidden, false)
    assert.equal(setup.getAttribute('href'), GUIDE_HREF)
    assert.equal(menu.addButton('claude').disabled, false, 'unknown is not absent')
    installed = 'yes'
    menu.root.querySelector('[data-acct="refresh-list"]').click()
    await settle()
    assert.equal(menu.addButton('codex').disabled, false)
    assert.equal(setup.hidden, true)
    fixture.bridge.presence = async () => { throw new Error('unavailable') }
    menu.root.querySelector('[data-acct="refresh-list"]').click()
    await settle()
    assert.equal(menu.addButton('codex').disabled, false)
  } finally { menu.destroy() }
})

test('an allowance check visibly disables account actions, including rows redrawn by a policy save', async () => {
  const held = deferred()
  const fixture = fakeBridge()
  fixture.bridge.accountUsage = async () => { await held.promise; return fixture.state.usage }
  const menu = await mount(fixture)
  try {
    await menu.open()
    menu.refresh.click()
    assert.equal(menu.addButton('codex').disabled, true)
    assert.equal(rowButton(menu.row('codex', 'work'), COPY.switchTo).disabled, true)
    assert.equal(rowButton(menu.row('codex', 'work'), COPY.rename).disabled, true)
    assert.equal(menu.mode.disabled, false)
    menu.mode.value = 'even'
    menu.mode.dispatchEvent({ type: 'change' })
    await settle()
    assert.equal(rowButton(menu.row('codex', 'work'), COPY.switchTo).disabled, true)
    held.resolve()
    await settle()
    assert.equal(menu.addButton('codex').disabled, false)
    assert.equal(rowButton(menu.row('codex', 'work'), COPY.switchTo).disabled, false)
  } finally { held.resolve(); menu.destroy() }
})

test('a direct-only allowance survives its explicit check but not closing, reopening or a late completion', async () => {
  for (const kind of ['unsupported', 'absent']) {
    const state = freshState()
    state.accounts[0].authGeneration = { kind, token: null }
    Object.assign(state.usage.accounts[0], { authGeneration: { kind, token: null }, email: 'direct-only@example.test' })
    const fixture = fakeBridge(state)
    const menu = await mount(fixture)
    try {
      await menu.open()
      menu.refresh.click()
      await settle()
      assert.match(menu.row('codex', 'school').textContent, /direct-only@example\.test/, kind)
      fixture.state.usageCache = fixture.state.usage // Even a forged disk carrier must not grant this context.
      menu.root.querySelector('[data-acct="close"]').click()
      await menu.open()
      assert.doesNotMatch(menu.row('codex', 'school').textContent, /direct-only@example\.test/, 'the closed direct result returned from memory or disk')
      const held = deferred(), directRead = fixture.bridge.accountUsage
      fixture.bridge.accountUsage = async () => { await held.promise; return directRead() }
      menu.refresh.click()
      menu.root.querySelector('[data-acct="close"]').click()
      await menu.open()
      held.resolve()
      await settle()
      assert.doesNotMatch(menu.row('codex', 'school').textContent, /direct-only@example\.test/, 'a late result gained authority in a different open lifecycle')
      assert.equal(menu.refresh.disabled, false)
      assert.equal(callsNamed(fixture.calls, 'accountUsage').length, 2, 'closing or opening triggered a provider retry')
    } finally { menu.destroy() }
  }
})

test('a direct-only allowance is withdrawn when its post-check account list cannot be validated', async () => {
  const state = freshState()
  state.accounts[0].authGeneration = { kind: 'unsupported', token: null }
  Object.assign(state.usage.accounts[0], { authGeneration: { kind: 'unsupported', token: null }, email: 'unvalidated@example.test' })
  const fixture = fakeBridge(state)
  const menu = await mount(fixture)
  try {
    await menu.open()
    const directRead = fixture.bridge.accountUsage
    fixture.bridge.accountUsage = async () => {
      const answer = await directRead()
      fixture.bridge.accounts = async () => { throw new Error('fictional list unavailable') }
      return answer
    }
    menu.refresh.click()
    await settle()
    assert.doesNotMatch(menu.row('codex', 'school').textContent, /unvalidated@example\.test/)
    assert.match(menu.root.querySelector('[data-acct="out"]').textContent, /could not|not.*read|try/i)
    assert.equal(callsNamed(fixture.calls, 'accountUsage').length, 1)
  } finally { menu.destroy() }
})

test('refresh and policy saves preserve an inline rename and Escape cancels just that edit', async () => {
  const menu = await mount()
  try {
    await menu.open()
    rowButton(menu.row('codex', 'work'), COPY.rename).click()
    const input = menu.row('codex', 'work').querySelector('.acct-rename-input')
    input.value = 'office draft'
    menu.root.querySelector('[data-acct="refresh-list"]').click()
    await settle()
    assert.ok(menu.row('codex', 'work').querySelector('.acct-rename-input') === input)
    assert.equal(input.value, 'office draft')
    menu.mode.value = 'even'
    menu.mode.dispatchEvent({ type: 'change' })
    await settle()
    assert.ok(menu.row('codex', 'work').querySelector('.acct-rename-input') === input)
    input.focus()
    const event = documentEvent('keydown', { key: 'Escape', target: input })
    assert.equal(event.defaultPrevented, true)
    assert.equal(menu.panel.hidden, false)
    assert.equal(menu.row('codex', 'work').querySelector('.acct-rename-input'), null)
    assert.equal(document.activeElement, rowButton(menu.row('codex', 'work'), COPY.rename))
    assert.equal(callsNamed(menu.calls, 'accountRename').length, 0)
  } finally { menu.destroy() }
})

test('rename and removal put keyboard focus on their result after replacing the row', async () => {
  const menu = await mount()
  try {
    await menu.open()
    rowButton(menu.row('codex', 'work'), COPY.rename).click()
    menu.row('codex', 'work').querySelector('.acct-rename-input').value = 'office'
    rowButton(menu.row('codex', 'work'), COPY.renameSave).click()
    await settle()
    assert.ok(menu.row('codex', 'office'))
    assert.equal(document.activeElement, menu.out)
    const remove = rowButton(menu.row('codex', 'office'), COPY.remove)
    remove.click(); remove.click()
    await settle()
    assert.equal(menu.row('codex', 'office'), null)
    assert.equal(document.activeElement, menu.out)
  } finally { menu.destroy() }
})

test('edits made during another policy save are all persisted, including the latest value', async () => {
  const fixture = fakeBridge(), held = deferred()
  const write = fixture.bridge.accountPolicy
  let first = true
  fixture.bridge.accountPolicy = async request => {
    if (first) { first = false; await held.promise }
    return write(request)
  }
  const menu = await mount(fixture)
  try {
    await menu.open()
    menu.mode.value = 'even'
    menu.mode.dispatchEvent({ type: 'change' })
    menu.limitWeekly.value = '80'
    menu.limitWeekly.dispatchEvent({ type: 'change' })
    menu.limitHourly.value = '70'
    menu.limitHourly.dispatchEvent({ type: 'change' })
    menu.limitWeekly.value = '85'
    menu.limitWeekly.dispatchEvent({ type: 'change' })
    held.resolve()
    await settle()
    assert.equal(fixture.state.mode, 'even')
    assert.equal(fixture.state.exhaustedAtPercentWeekly, 85)
    assert.equal(fixture.state.exhaustedAtPercentHourly, 70)
    assert.equal(menu.limitWeekly.value, '85')
    assert.equal(menu.limitHourly.value, '70')
    assert.equal(menu.root.querySelector('[data-acct="save-status"]').dataset.state, 'saved')
  } finally { held.resolve(); menu.destroy() }
})

test('a slow allowance check does not drop edits or restore its earlier policy snapshot', async () => {
  const fixture = fakeBridge(), held = deferred()
  fixture.bridge.accountUsage = async () => { await held.promise; return fixture.state.usage }
  const menu = await mount(fixture)
  try {
    await menu.open()
    menu.refresh.click()
    await settle()
    menu.mode.value = 'even'
    menu.mode.dispatchEvent({ type: 'change' })
    const recovery = menu.root.querySelector('[data-acct="auto-recover"]')
    recovery.checked = true
    recovery.dispatchEvent({ type: 'change' })
    await settle()
    assert.equal(fixture.state.mode, 'even')
    assert.equal(fixture.state.autoRecoverOnLimit, true)
    held.resolve()
    await settle()
    assert.equal(menu.mode.value, 'even')
    assert.equal(recovery.checked, true)
  } finally { held.resolve(); menu.destroy() }
})

test('accepted policy edits finish saving when navigation destroys the panel', async () => {
  const fixture = fakeBridge(), held = deferred()
  const write = fixture.bridge.accountPolicy
  fixture.bridge.accountPolicy = async request => { await held.promise; return write(request) }
  const menu = await mount(fixture)
  menu.mode.value = 'even'
  menu.mode.dispatchEvent({ type: 'change' })
  menu.rank.value = 'weekly'
  menu.rank.dispatchEvent({ type: 'change' })
  menu.destroy()
  held.resolve()
  await settle()
  assert.equal(fixture.state.mode, 'even')
  assert.equal(fixture.state.rankWindow, 'weekly')
})

test('reopening adopts a newer cached allowance without starting a provider probe', async () => {
  const fixture = fakeBridge()
  fixture.state.usageCache = { ...fixture.state.usage, readAt: '2026-09-08T01:00:00Z' }
  const menu = await mount(fixture)
  try {
    await menu.open()
    menu.close()
    fixture.state.usageCache = {
      ...fixture.state.usage, readAt: '2026-09-08T01:05:00Z',
      accounts: [{ name: 'school', provider: 'codex', canServe: true, windows: { weekly: { usedPercent: 77 } } }],
    }
    await menu.open()
    assert.ok(menu.row('codex', 'school').textContent.includes('23%'))
    assert.equal(callsNamed(menu.calls, 'accountUsage').length, 0)
  } finally { menu.destroy() }
})

test('a failed read after saving keeps the last shown policy and reports that refresh failed', async () => {
  const fixture = fakeBridge(), read = fixture.bridge.accounts
  let broken = false
  fixture.bridge.accounts = async () => broken ? { ok: false } : read()
  const menu = await mount(fixture)
  try {
    await menu.open()
    broken = true
    menu.mode.value = 'even'
    menu.mode.dispatchEvent({ type: 'change' })
    await settle()
    assert.equal(fixture.state.mode, 'even')
    assert.equal(menu.mode.value, 'even', 'unavailable must not paint default policy values')
    assert.equal(menu.root.querySelector('[data-acct="save-status"]').dataset.state, 'refresh-failed')
    assert.match(menu.out.textContent, /saved.*refresh/i)
  } finally { menu.destroy() }
})

test('finishing a save does not reset another slider that is still being dragged', async () => {
  const fixture = fakeBridge(), held = deferred(), write = fixture.bridge.accountPolicy
  fixture.bridge.accountPolicy = async request => { await held.promise; return write(request) }
  const menu = await mount(fixture)
  try {
    menu.mode.value = 'even'
    menu.mode.dispatchEvent({ type: 'change' })
    menu.limitWeekly.value = '83'
    menu.limitWeekly.dispatchEvent({ type: 'input' })
    held.resolve()
    await settle()
    assert.equal(menu.limitWeekly.value, '83')
    assert.equal(menu.limitWeeklyFigure.textContent, '83%')
    assert.equal(fixture.state.exhaustedAtPercentWeekly, null)
    assert.equal(menu.root.querySelector('[data-acct="save-status"]').dataset.state, 'editing')
    menu.limitWeekly.dispatchEvent({ type: 'change' })
    await settle()
    assert.equal(fixture.state.exhaustedAtPercentWeekly, 83)
  } finally { held.resolve(); menu.destroy() }
})

test('Refresh accounts reloads saved policy and account changes without checking allowances', async () => {
  const menu = await mount()
  try {
    await menu.open()
    menu.state.mode = 'dynamic'
    menu.state.reserve = 35
    menu.state.accounts.push({ provider: 'codex', name: 'new account', signedIn: 'yes' })
    menu.root.querySelector('[data-acct="refresh-list"]').click()
    await settle()
    assert.equal(menu.mode.value, 'dynamic')
    assert.equal(menu.reserve.value, '35')
    assert.ok(menu.row('codex', 'new account'))
    assert.equal(callsNamed(menu.calls, 'accountUsage').length, 0)
    assert.equal(menu.out.textContent, COPY.accountsRefreshed)
  } finally { menu.destroy() }
})

test('a replacement panel follows pending saves and shares write order with the old panel', async () => {
  const fixture = fakeBridge(), held = deferred(), write = fixture.bridge.accountPolicy
  let first = true
  fixture.bridge.accountPolicy = async request => {
    if (first) { first = false; await held.promise }
    return write(request)
  }
  const old = await mount(fixture)
  old.mode.value = 'even'
  old.mode.dispatchEvent({ type: 'change' })
  old.rank.value = 'weekly'
  old.rank.dispatchEvent({ type: 'change' })
  old.destroy()
  const current = await mount(fixture)
  try {
    assert.equal(current.root.querySelector('[data-acct="save-status"]').dataset.state, 'saving')
    held.resolve()
    await settle()
    assert.equal(current.mode.value, 'even')
    assert.equal(current.rank.value, 'weekly')
    assert.equal(current.root.querySelector('[data-acct="save-status"]').dataset.state, 'saved')
    current.mode.value = 'priority'
    current.mode.dispatchEvent({ type: 'change' })
    await settle()
    assert.equal(fixture.state.mode, 'priority')
  } finally { held.resolve(); current.destroy() }
})

test('two open panels serialize edits to the same computer and both refresh after saving', async () => {
  const fixture = fakeBridge(), held = deferred(), write = fixture.bridge.accountPolicy
  let first = true
  fixture.bridge.accountPolicy = async request => {
    if (first) { first = false; await held.promise }
    return write(request)
  }
  const one = await mount(fixture), two = await mount(fixture)
  try {
    one.mode.value = 'even'
    one.mode.dispatchEvent({ type: 'change' })
    one.rank.value = 'weekly'
    one.rank.dispatchEvent({ type: 'change' })
    two.mode.value = 'priority'
    two.mode.dispatchEvent({ type: 'change' })
    held.resolve()
    await settle()
    assert.equal(fixture.state.mode, 'priority')
    assert.equal(fixture.state.rankWindow, 'weekly')
    for (const menu of [one, two]) {
      assert.equal(menu.mode.value, 'priority')
      assert.equal(menu.rank.value, 'weekly')
    }
  } finally { held.resolve(); one.destroy(); two.destroy() }
})

test('typing the existing reserve value does not leave a false unsaved indicator', async () => {
  const menu = await mount()
  try {
    menu.reserve.value = '35'
    menu.reserve.dispatchEvent({ type: 'input' })
    menu.reserve.value = '25'
    menu.reserve.dispatchEvent({ type: 'input' })
    assert.equal(menu.root.querySelector('[data-acct="save-status"]').dataset.state, 'idle')
    assert.equal(callsNamed(menu.calls, 'accountPolicy').length, 0)
  } finally { menu.destroy() }
})

/* Every press on the menu is a chain of awaited bridge calls, all of them
   microtasks; a macrotask turn or three drains them. */
async function settle() {
  for (let turn = 0; turn < 3; turn += 1) await new Promise(resolve => setImmediate(resolve))
}

/* ------------------------------ the fake shell ------------------------------ */

const UNREAD = 'No account reported how much of its allowance is left, so the listed order was used.'
const EXHAUSTED_REASON = 'Its weekly allowance is used up. It resets on Monday.'
const SIGNED_OUT_REASON = 'This Claude home is not signed in. Sign in to it with CLAUDE_CONFIG_DIR set to its directory.'

/* One computer: two Codex accounts (one measured), two Claude accounts (one
   signed out, one exhausted), one Gemini account. Mutable, so a test can
   change what the shell will answer next. */
function freshState() {
  return {
    mode: 'manual',
    reserve: 25,
    rankWindow: 'either',
    /* One number for both windows and neither window overriding it: what a
       registry written before the two sliders existed says. */
    exhaustedAtPercent: 90,
    exhaustedAtPercentHourly: null,
    exhaustedAtPercentWeekly: null,
    /* A program's own rule, when the fixture holds one: { selectionMode?, reservePercent?, rankWindow? }. */
    byProvider: {},
    accounts: [
      { name: 'school', provider: 'codex', signedIn: 'yes' },
      { name: 'work', provider: 'codex', signedIn: 'yes' },
      { name: 'home', provider: 'claude', signedIn: 'no' },
      { name: 'lab', provider: 'claude', signedIn: 'yes' },
      { name: 'spare', provider: 'gemini', signedIn: 'yes' },
    ],
    activeByProvider: { codex: 'school', claude: 'lab', gemini: 'spare' },
    usage: {
      ok: true,
      accounts: [
        { name: 'school', provider: 'codex', status: 'HEALTHY', canServe: true, windows: { hourly: { usedPercent: 18 }, weekly: { usedPercent: 40 } } },
        { name: 'home', provider: 'claude', status: 'signed_out', canServe: false, reason: SIGNED_OUT_REASON },
        { name: 'lab', provider: 'claude', status: 'EXHAUSTED', canServe: false, reason: EXHAUSTED_REASON },
      ],
      orders: [
        { provider: 'codex', names: ['school', 'work'], why: '“school” has the most left.' },
        { provider: 'claude', names: ['lab', 'home'], why: UNREAD },
        { provider: 'gemini', names: ['spare'], why: UNREAD },
      ],
    },
  }
}

/* The bridge the preload would expose, answering from `state` and recording
   every call in order. `overrides` replaces whole arrows for a refusal case. */
/* The shell's per-program answer: a program's own rule when the fixture holds
   one, the rule above otherwise, with `own` saying which. */
function policyByProvider(state) {
  const out = {}
  for (const id of ['codex', 'claude', 'gemini']) {
    const own = state.byProvider[id] || null
    out[id] = {
      selectionMode: own && own.selectionMode ? own.selectionMode : state.mode,
      reservePercent: own && own.reservePercent != null ? own.reservePercent : state.reserve,
      rankWindow: own && own.rankWindow ? own.rankWindow : state.rankWindow,
      own: { selectionMode: Boolean(own && own.selectionMode), reservePercent: Boolean(own && own.reservePercent != null), rankWindow: Boolean(own && own.rankWindow) },
    }
  }
  return out
}

function fakeBridge(state = freshState(), overrides = {}) {
  const calls = []
  // Current native lists and usage replies bind readings to the same account.
  // These deterministic fixture tokens contain no real path or identity.
  const bound = account => {
    const allowanceBinding = account.allowanceBinding || Buffer.from(`${account.provider}:${account.name}`).toString('hex').padEnd(64, '0').slice(0, 64)
    return { ...account, allowanceBinding, authGeneration: Object.hasOwn(account, 'authGeneration')
      ? account.authGeneration : { kind: 'file', token: allowanceBinding } }
  }
  const boundUsage = usage => usage ? { ...usage, ...(Array.isArray(usage.accounts) ? { accounts: usage.accounts.map(bound) } : {}) } : usage
  /* The shell's push for the ONE account a Sign in press armed a watch on.
     Held so a test can deliver a packet the way the main process would. */
  const signInListeners = []
  const bridge = {
    accounts: async () => {
      calls.push(['accounts'])
      return {
        ok: true,
        accounts: state.accounts.map(bound),
        /* The choice and what moved off it ride with `active`, so a fixture
           that sets neither is a shell that does not say. */
        active: state.active === undefined ? null : state.active,
        activeByProvider: { ...state.activeByProvider },
        policy: {
          autoRecoverOnLimit: state.autoRecoverOnLimit === true,
          selectionMode: state.mode, recorded: true, reservePercent: state.reserve, rankWindow: state.rankWindow,
          exhaustedAtPercent: state.exhaustedAtPercent,
          exhaustedAtPercentHourly: state.exhaustedAtPercentHourly,
          exhaustedAtPercentWeekly: state.exhaustedAtPercentWeekly,
          byProvider: policyByProvider(state),
        },
        /* The shell's kept last read, when the fixture has one. */
        ...(state.usageCache ? { usageCache: boundUsage(state.usageCache) } : {}),
        /* What the last change of account was, when this computer has made one. */
        ...(state.lastSwitch ? { lastSwitch: state.lastSwitch } : {}),
      }
    },
    accountUsage: async () => {
      calls.push(['accountUsage'])
      return boundUsage(state.usage)
    },
    accountPolicy: async request => {
      calls.push(['accountPolicy', { ...request }])
      if (request.provider) {
        /* A program's own rule: null clears one field, a value records it. */
        const own = { ...(state.byProvider[request.provider] || {}) }
        for (const key of ['selectionMode', 'reservePercent', 'rankWindow']) {
          if (!(key in request)) continue
          if (request[key] === null) delete own[key]
          else own[key] = request[key]
        }
        state.byProvider[request.provider] = own
        return { ok: true }
      }
      if ('selectionMode' in request) state.mode = request.selectionMode
      if ('autoRecoverOnLimit' in request) state.autoRecoverOnLimit = request.autoRecoverOnLimit
      if ('reservePercent' in request) state.reserve = request.reservePercent
      if ('rankWindow' in request) state.rankWindow = request.rankWindow
      /* null clears a window's own limit and hands it back to the single
         number, which is why these are not folded in with the three above. */
      for (const key of ['exhaustedAtPercentHourly', 'exhaustedAtPercentWeekly']) {
        if (!(key in request)) continue
        state[key] = request[key] === null ? null : request[key]
      }
      return { ok: true }
    },
    accountSwitch: async request => {
      calls.push(['accountSwitch', { ...request }])
      const already = state.activeByProvider[request.provider] === request.name
      state.activeByProvider[request.provider] = request.name
      return { ok: true, switched: !already, active: { name: request.name, provider: request.provider } }
    },
    accountAddManaged: async request => {
      calls.push(['accountAddManaged', { ...request }])
      /* The shell settles the name -- here visibly not the one typed, so a
         sign-in opened for the typed name would show. */
      const name = request.name ? `${request.name}-2` : `${request.provider}-2`
      state.accounts.push({ name, provider: request.provider, signedIn: 'no' })
      return { ok: true, name, provider: request.provider, directory: `.${request.provider}-managed-2` }
    },
    accountSignIn: async request => {
      calls.push(['accountSignIn', { ...request }])
      return { ok: true }
    },
    onAccountSignInChanged: listener => {
      calls.push(['onAccountSignInChanged'])
      signInListeners.push(listener)
      return () => {
        const at = signInListeners.indexOf(listener)
        if (at >= 0) signInListeners.splice(at, 1)
      }
    },
    accountRename: async request => {
      calls.push(['accountRename', { ...request }])
      const entry = state.accounts.find(account => account.provider === request.provider && account.name === request.name)
      if (!entry) return { ok: false, code: 'ACCOUNT_UNKNOWN', reason: 'That account is not on this computer’s list.' }
      entry.name = request.newName
      if (state.activeByProvider[request.provider] === request.name) state.activeByProvider[request.provider] = request.newName
      return { ok: true, renamed: true, name: request.newName }
    },
    accountRemove: async request => {
      calls.push(['accountRemove', { ...request }])
      const before = state.accounts.length
      state.accounts = state.accounts.filter(account => !(account.provider === request.provider && account.name === request.name))
      return { ok: true, removed: state.accounts.length !== before }
    },
    ...overrides,
  }
  return {
    bridge,
    calls,
    state,
    scope: { mcProviders: bridge },
    listening: () => signInListeners.length,
    pushSignIn: packet => { for (const listener of [...signInListeners]) listener(packet) },
  }
}

/* ------------------------------ mounting ------------------------------ */

const textOf = node => node.textContent
const linesOf = row => row.querySelectorAll('.acct-line').map(textOf)
const flagsOf = row => row.querySelectorAll('.acct-flag').map(flag => [flag.textContent, flag.title ?? null])
const rowButton = (row, label) => row.querySelectorAll('button').find(button => button.textContent === label) || null
const callsNamed = (calls, name) => calls.filter(([called]) => called === name)

async function mount(fixture = fakeBridge()) {
  const root = accountSwitcher({ scope: fixture.scope })
  document.body.appendChild(root)
  await settle()
  const field = key => root.querySelector(`[data-acct="${key}"]`)
  const panel = root.querySelector('.acct-menu')
  // Model only the native dialog's open/close contract here. Browser focus
  // containment and layout need the disposable renderer check, not this DOM.
  panel.open = false
  panel.showModal = () => { panel.open = true; panel.setAttribute('open', '') }
  panel.close = () => { panel.open = false; panel.removeAttribute('open'); panel.dispatchEvent({ type: 'close' }) }
  const menu = {
    root,
    fixture,
    calls: fixture.calls,
    state: fixture.state,
    trigger: root.querySelector('.acct-trigger'),
    label: root.querySelector('.acct-trigger-label'),
    panel,
    query: field('query'),
    providerFilter: field('provider-filter'),
    clearQuery: field('clear-query'),
    matches: field('matches'),
    mode: field('mode'),
    overrideNotice: field('override-notice'),
    overrideNoticeText: field('override-notice-text'),
    overrideApply: field('override-apply'),
    reserveField: field('reserve-field'),
    reserve: field('reserve'),
    rankField: field('rank-field'),
    rank: field('rank'),
    rankHelp: field('rank-help'),
    limitWeekly: field('limit-weekly'),
    limitHourly: field('limit-hourly'),
    limitWeeklyFigure: field('limit-weekly-figure'),
    limitHourlyFigure: field('limit-hourly-figure'),
    providerMode: provider => root.querySelectorAll('[data-acct="provider-mode"]').find(select => select.dataset.provider === provider) || null,
    providerRank: provider => root.querySelectorAll('[data-acct="provider-rank"]').find(select => select.dataset.provider === provider) || null,
    refresh: field('refresh'),
    signInEach: field('sign-in-each'),
    list: field('list'),
    order: field('order'),
    moved: field('moved'),
    out: field('out'),
    name: field('add-name'),
    addButtons: root.querySelectorAll('[data-acct="add-provider"]'),
    addButton: provider => menu.addButtons.find(button => button.dataset.provider === provider),
    rows: () => root.querySelectorAll('.acct-row'),
    row(provider, name) {
      for (const group of root.querySelectorAll('.acct-group')) {
        if (group.querySelector('.acct-group-name').textContent !== providerLabel(provider)) continue
        for (const row of group.querySelectorAll('.acct-row')) {
          if (row.querySelector('.acct-name').textContent === name) return row
        }
      }
      return null
    },
    async open() {
      menu.trigger.click()
      await settle()
    },
    close() {
      documentEvent('keydown', { key: 'Escape' })
    },
    async check() {
      menu.refresh.click()
      await settle()
    },
    destroy() {
      root.__accountSwitcher.destroy()
      root.remove()
    },
  }
  return menu
}

/* ------------------------------ mounting and opening ------------------------------ */

test('automatic limit recovery is opt-in, persists both choices, and restores refused changes', async () => {
  const menu = await mount()
  await menu.open()
  const input = menu.root.querySelector('[data-acct="auto-recover"]')
  assert.equal(input.checked, false)
  input.checked = true
  input.dispatchEvent({ type: 'change' })
  await settle()
  assert.deepEqual(callsNamed(menu.calls, 'accountPolicy').at(-1)[1], { autoRecoverOnLimit: true })
  assert.equal(input.checked, true)
  input.checked = false
  input.dispatchEvent({ type: 'change' })
  await settle()
  assert.equal(menu.state.autoRecoverOnLimit, false)
  menu.fixture.bridge.accountPolicy = async () => ({ ok: false, reason: 'Write refused.' })
  input.checked = true
  input.dispatchEvent({ type: 'change' })
  await settle()
  assert.equal(input.checked, false)
  menu.destroy()
})

test('mounts closed, reads the list once and nothing else, and ships the status line hidden and script-focusable', async () => {
  const menu = await mount()
  assert.deepEqual(menu.calls, [['accounts']], 'the first read is the list; the allowances cost a program each and wait for a press')
  assert.equal(menu.panel.hidden, true)
  assert.equal(menu.trigger.getAttribute('aria-expanded'), 'false')
  assert.equal(menu.trigger.getAttribute('aria-controls'), menu.panel.getAttribute('id'), 'the button has to name its own panel')
  assert.equal(menu.out.hidden, true, 'the status line ships hidden so an empty line adds no gap')
  assert.equal(menu.out.textContent, '')
  assert.equal(menu.out.getAttribute('role'), 'status')
  assert.equal(menu.out.getAttribute('tabindex'), '-1', 'the status line has to take focus from a script and never be a tab stop')
  assert.equal(menu.label.textContent, COPY.buttonMultiple(3), 'the closed button identifies that several providers are in use')
  assert.equal(menu.rows().length, 5)
  assert.equal(listenerCount('keydown'), 1)
  assert.equal(listenerCount('pointerdown'), 1)
  menu.destroy()
  assert.equal(listenerCount('keydown'), 0, 'destroy() left its Escape listener on the document')
  assert.equal(listenerCount('pointerdown'), 0, 'destroy() left its press-outside listener on the document')
})

test('opening uses a named native dialog and focuses account search; Escape returns focus to the button', async () => {
  const menu = await mount()
  const heard = []
  const later = event => heard.push(event.key)
  /* Registered after the menu's own listener, as the drawer's and the
     popover's bubble handlers are: it must not hear the Escape that closed
     this menu, and must hear the one that had nothing to close. */
  document.addEventListener('keydown', later, false)

  await menu.open()
  assert.equal(menu.panel.hidden, false)
  assert.equal(menu.panel.tagName, 'DIALOG')
  assert.equal(menu.panel.open, true)
  assert.equal(menu.trigger.getAttribute('aria-haspopup'), 'dialog')
  assert.equal(menu.panel.getAttribute('aria-labelledby'), menu.root.querySelector('h3').getAttribute('id'))
  assert.equal(menu.trigger.getAttribute('aria-expanded'), 'true')
  assert.equal(menu.root.dataset.open, 'yes')
  assert.equal(document.activeElement, menu.query, 'opening lands on account search for a populated list')
  assert.equal(callsNamed(menu.calls, 'accounts').length, 2, 'the list is re-read on every open')
  assert.equal(callsNamed(menu.calls, 'accountUsage').length, 0, 'opening must not start the allowance programs')

  const escape = documentEvent('keydown', { key: 'Escape' })
  assert.equal(escape.defaultPrevented, true, 'the rail honours defaultPrevented; this Escape has to carry it')
  assert.equal(escape.immediatePropagationStopped, true, 'one key closes one layer')
  assert.deepEqual(heard, [], 'a later document listener heard the Escape that closed this menu')
  assert.equal(menu.panel.hidden, true)
  assert.equal(menu.trigger.getAttribute('aria-expanded'), 'false')
  assert.equal(document.activeElement, menu.trigger, 'Escape has to leave the keyboard on the button that opened the menu')

  /* Closed, the same key is nobody's here. */
  const passed = documentEvent('keydown', { key: 'Escape' })
  assert.equal(passed.defaultPrevented, false)
  assert.deepEqual(heard, ['Escape'])

  /* Open, a different key is not this menu's either. */
  await menu.open()
  const enter = documentEvent('keydown', { key: 'Enter' })
  assert.equal(enter.defaultPrevented, false)
  assert.equal(menu.panel.hidden, false)
  assert.deepEqual(heard, ['Escape', 'Enter'])

  document.removeEventListener('keydown', later)
  menu.destroy()
})

test('a press outside closes the menu; a press inside does not', async () => {
  const menu = await mount()
  await menu.open()
  documentEvent('pointerdown', { target: document.body })
  assert.equal(menu.panel.hidden, true)
  await menu.open()
  documentEvent('pointerdown', { target: menu.mode })
  assert.equal(menu.panel.hidden, false)
  documentEvent('pointerdown', { target: menu.trigger })
  assert.equal(menu.panel.hidden, false, 'the button is inside the control; its own click handler decides')
  menu.destroy()
})

/* ------------------------------ the status line ------------------------------ */

test('the status line shows on the first say(), keeps the keyboard on the changed select, and empties when the menu closes', async () => {
  const menu = await mount()
  await menu.open()
  assert.equal(menu.out.hidden, true, 'opening says nothing')

  menu.mode.focus()
  menu.mode.value = 'even'
  menu.mode.dispatchEvent({ type: 'change' })
  assert.equal(menu.out.hidden, false, 'the first say() has to show the line')
  assert.equal(menu.out.textContent, COPY.saving)
  assert.equal(menu.out.dataset.tone, 'note')
  assert.equal(menu.mode.disabled, false, 'controls remain editable while saves are queued')
  await settle()
  assert.deepEqual(callsNamed(menu.calls, 'accountPolicy'), [['accountPolicy', { selectionMode: 'even' }]])
  assert.equal(menu.out.textContent, COPY.modeSaved('Keep them even'))
  assert.equal(menu.out.dataset.tone, 'confirmed')
  assert.equal(menu.mode.disabled, false)
  assert.equal(menu.mode.value, 'even', 'the re-read list agrees with the saved mode')
  assert.equal(document.activeElement, menu.mode, 'the select keeps the keyboard after its own change')

  menu.close()
  assert.equal(menu.out.hidden, true, 'a closed menu carries no stale answer into its next open')
  assert.equal(menu.out.textContent, '')
  menu.destroy()
})

test('a refused mode puts the select back to what the file says and keeps the shell\'s sentence', async () => {
  const reason = 'That mode is not one this copy has.'
  const fixture = fakeBridge(freshState(), { accountPolicy: async () => ({ ok: false, code: 'ACCOUNT_MODE_UNSUPPORTED', reason }) })
  const menu = await mount(fixture)
  await menu.open()
  menu.mode.focus()
  menu.mode.value = 'even'
  menu.mode.dispatchEvent({ type: 'change' })
  await settle()
  assert.equal(menu.out.textContent, reason)
  assert.equal(menu.out.dataset.tone, 'refused')
  assert.equal(menu.mode.value, 'manual', 'a select left showing a refused mode tells a person their computer does something it does not')
  assert.equal(document.activeElement, menu.mode)
  menu.destroy()
})

test('a dynamic mode with an empty reserve box sends no reservePercent and says the reserve sentence', async () => {
  const menu = await mount()
  await menu.open()
  assert.equal(menu.reserveField.hidden, true, 'the reserve is offered by dynamic alone')

  menu.mode.value = 'dynamic'
  menu.reserve.value = ''
  menu.mode.dispatchEvent({ type: 'change' })
  await settle()
  assert.equal(callsNamed(menu.calls, 'accountPolicy').length, 0, 'an empty box used to be sent as 0 under a "Saved" confirmation')
  assert.equal(menu.out.textContent, COPY.reserveInvalid)
  assert.equal(menu.out.dataset.tone, 'note')
  assert.equal(menu.reserveField.hidden, false, 'choosing dynamic offers the box even while the box is empty')

  for (const bad of ['abc', '101', '-1', '  ']) {
    menu.reserve.value = bad
    menu.reserve.dispatchEvent({ type: 'change' })
    await settle()
    assert.equal(callsNamed(menu.calls, 'accountPolicy').length, 0, `${JSON.stringify(bad)} must not be sent`)
    assert.equal(menu.out.textContent, COPY.reserveInvalid)
  }

  menu.reserve.value = '30'
  menu.reserve.dispatchEvent({ type: 'change' })
  await settle()
  assert.deepEqual(callsNamed(menu.calls, 'accountPolicy'), [['accountPolicy', { selectionMode: 'dynamic', reservePercent: 30 }]])
  assert.equal(menu.out.textContent, COPY.modeSaved('Dynamic'))
  assert.equal(menu.reserve.value, '30', 'the re-read list agrees with the saved reserve')

  /* Any other mode never carries the reserve, whatever the box says. */
  menu.mode.value = 'even'
  menu.reserve.value = ''
  menu.mode.dispatchEvent({ type: 'change' })
  await settle()
  const last = callsNamed(menu.calls, 'accountPolicy').at(-1)
  assert.deepEqual(last, ['accountPolicy', { selectionMode: 'even' }])
  assert.equal('reservePercent' in last[1], false, 'a request without a reserve must not grow one')
  assert.equal(menu.reserveField.hidden, true)
  menu.destroy()
})

/* ------------------------------ Check allowances ------------------------------ */

test('Check allowances says it started, says it finished, and draws only the bars the reply carried', async () => {
  const menu = await mount()
  await menu.open()
  menu.refresh.click()
  assert.equal(menu.out.textContent, COPY.refreshing)
  assert.equal(menu.out.hidden, false)
  assert.equal(menu.refresh.disabled, true)
  /* A second press while the first is in flight is one press. */
  menu.refresh.click()
  await settle()
  assert.equal(callsNamed(menu.calls, 'accountUsage').length, 1, 'two presses close together started two reads')
  assert.equal(menu.out.textContent, COPY.checked, 'a check that announced its start has to announce its end -- a cleared line is a hidden line')
  assert.equal(menu.out.dataset.tone, 'confirmed')
  assert.equal(menu.out.hidden, false)
  assert.equal(menu.refresh.disabled, false)

  const school = menu.row('codex', 'school')
  assert.deepEqual(school.querySelectorAll('.acct-bar-figure').map(textOf), [COPY.percentRemaining(82), COPY.percentRemaining(60)],
    'the figure beside a bar is the share free, the same quantity the sentence speaks')
  assert.equal(school.querySelectorAll('.acct-bar-unread').length, 0)
  assert.deepEqual(school.querySelectorAll('.acct-bar-detail').map(textOf), ['18% used', '40% used'])
  assert.deepEqual(linesOf(school), [], 'visible meter labels and details already carry the readings')
  const work = menu.row('codex', 'work')
  assert.equal(work.querySelectorAll('.acct-bar-unread').length, 2, 'an unread window draws no bar')
  assert.equal(work.querySelectorAll('.acct-bar-fill').length, 0)
  assert.equal(menu.label.textContent, COPY.buttonMultiple(3), 'a global header must not claim the first provider is the selected agent')
  assert.ok(menu.trigger.title.includes('Codex · school'))
  assert.ok(menu.trigger.title.includes('Claude · lab'))
  menu.destroy()
})

test('a check the shell refused, or that threw, keeps the status line honest', async () => {
  const reason = 'The list of accounts could not be read.'
  const refused = await mount(fakeBridge(freshState(), { accountUsage: async () => ({ ok: false, reason }) }))
  await refused.open()
  await refused.check()
  assert.equal(refused.out.textContent, reason)
  assert.equal(refused.out.dataset.tone, 'refused')
  assert.equal(refused.row('codex', 'school').querySelectorAll('.acct-bar-unread').length, 2, 'a refused read draws no bar')
  refused.destroy()

  const threw = await mount(fakeBridge(freshState(), { accountUsage: async () => { throw new Error('ACCOUNT_STATE_UNAVAILABLE') } }))
  await threw.open()
  await threw.check()
  assert.equal(threw.out.textContent, COPY.usageUnavailable)
  assert.equal(threw.out.dataset.tone, 'refused')
  threw.destroy()
})

/* ------------------------------ why this order ------------------------------ */

test('the why paragraph is absent under manual and priority, present under a ranked mode, and never about Gemini', async () => {
  const fixture = fakeBridge()
  const menu = await mount(fixture)
  await menu.open()
  assert.equal(menu.order.hidden, true, 'nothing has been read')

  await menu.check()
  assert.equal(menu.order.hidden, true, 'under "stop and let me switch" the order is the list; a sentence there is filler')
  assert.equal(menu.order.textContent, '')

  fixture.state.mode = 'priority'
  await menu.check()
  assert.equal(menu.order.hidden, true, 'under "in the order listed" the order is the list too')

  fixture.state.mode = 'most-available'
  await menu.check()
  assert.equal(menu.order.hidden, false)
  assert.equal(menu.order.textContent, `Codex: “school” has the most left. Claude: ${UNREAD}`)
  assert.ok(!menu.order.textContent.includes('Gemini'), 'a Gemini order sentence read as a fault beside a row that says Gemini is never measured')

  /* Changing the mode on the select repaints the paragraph from the same rule. */
  menu.mode.value = 'manual'
  menu.mode.dispatchEvent({ type: 'change' })
  await settle()
  assert.equal(menu.order.hidden, true)
  assert.equal(menu.order.textContent, '')

  /* A ranked mode chosen after a read under ANOTHER mode does not inherit that
     read's sentence: the order paragraph waits for the next check, while the
     bars (readings, not an order) stay on the rows. Seen on the live drive,
     where "in the order listed" stood beneath "Expiring soonest first". */
  fixture.state.mode = 'most-available'
  await menu.check()
  assert.equal(menu.order.hidden, false)
  const rowsBefore = menu.rows().length
  menu.mode.value = 'resets-soonest'
  fixture.state.mode = 'resets-soonest'
  menu.mode.dispatchEvent({ type: 'change' })
  await settle()
  assert.equal(menu.order.hidden, true, 'the sentence of the previous mode must not stand under the new one')
  assert.equal(menu.order.textContent, '')
  assert.equal(menu.rows().length, rowsBefore, 'the rows and their readings stay')
  /* Plain class queries: the stand-in document does not know :not(). */
  assert.equal(menu.row('codex', 'school').querySelectorAll('.acct-bar-unread').length, 0, 'the bars of the last read stay on the rows')
  assert.ok(menu.row('codex', 'school').querySelector('.acct-bar-figure'), 'a measured bar carries its figure')
  await menu.check()
  assert.equal(menu.order.hidden, false, 'the next check brings the sentence for the mode chosen now')
  menu.destroy()
})

test('an empty list clears the order paragraph and the closed button', async () => {
  const fixture = fakeBridge()
  fixture.state.mode = 'even'
  const menu = await mount(fixture)
  await menu.open()
  await menu.check()
  assert.equal(menu.order.hidden, false)

  fixture.state.accounts = []
  fixture.state.activeByProvider = { codex: null, claude: null, gemini: null }
  menu.close()
  await menu.open()
  assert.equal(menu.order.textContent, '', 'an explanation of an order that no longer exists stood under an empty list')
  assert.equal(menu.order.hidden, true)
  assert.equal(menu.rows().length, 0)
  assert.equal(menu.list.querySelector('.acct-empty').textContent, COPY.none)
  assert.equal(menu.label.textContent, COPY.buttonUnread)
  menu.destroy()
})

test('the menu says when the computer is not on the chosen account, marks the chosen row, and clears both when it goes back', async () => {
  /* MEASURED 2026-09-03 on the owner's machine: the hand-chosen account was
     92% through a week that had three hours left to run, the start used the
     other account, and this menu drew that other account "In use now" with
     nothing anywhere saying a choice had been made -- which reads as a pick
     that reverted itself two minutes after it was made. */
  const fixture = fakeBridge()
  const movedOff = {
    name: 'lab', provider: 'claude', at: '2026-09-03T13:18:24.143Z',
    chosenByProvider: { codex: null, claude: 'home', gemini: null },
    movedOffByProvider: {
      codex: null, gemini: null,
      claude: { chosen: 'home', using: 'lab', at: '2026-09-03T13:18:24.143Z', reason: EXHAUSTED_REASON },
    },
  }
  fixture.state.active = movedOff
  const menu = await mount(fixture)
  await menu.open()

  assert.equal(menu.moved.hidden, false, 'the menu said nothing about a choice it was not honouring')
  assert.match(menu.moved.textContent, /“home” is the account you chose/)
  assert.match(menu.moved.textContent, /on “lab” for now/)
  assert.ok(menu.moved.textContent.includes(EXHAUSTED_REASON),
    'the reason the chosen account could not serve was dropped')

  /* The row says which one is theirs; the paragraph alone cannot. */
  assert.equal(menu.row('claude', 'home').querySelector('.acct-chosen').textContent, COPY.chosenLabel)
  assert.equal(menu.row('claude', 'home').querySelector('.acct-inuse'), null)
  assert.equal(menu.row('claude', 'lab').querySelector('.acct-inuse').textContent, COPY.inUse)
  assert.equal(menu.row('claude', 'lab').querySelector('.acct-chosen'), null,
    'the row in use carried a second badge saying the same thing')
  assert.equal(menu.row('codex', 'school').querySelector('.acct-chosen'), null,
    'a Claude choice marked a Codex row')

  // Back on it: nothing to explain, and the badge is the "In use now" one.
  fixture.state.active = { ...movedOff, name: 'home', movedOffByProvider: { codex: null, claude: null, gemini: null } }
  fixture.state.activeByProvider = { ...fixture.state.activeByProvider, claude: 'home' }
  menu.close()
  await menu.open()
  assert.equal(menu.moved.textContent, '', 'a sentence about a move that is over stood under the list')
  assert.equal(menu.moved.hidden, true)
  assert.equal(menu.row('claude', 'home').querySelector('.acct-inuse').textContent, COPY.inUse)
  assert.equal(menu.row('claude', 'home').querySelector('.acct-chosen'), null)
  menu.destroy()
})

test('a shell that says nothing about a choice draws nothing, rather than "nothing happened"', async () => {
  const menu = await mount()
  await menu.open()
  assert.equal(menu.moved.hidden, true)
  assert.equal(menu.moved.textContent, '')
  assert.equal(menu.root.querySelector('.acct-chosen'), null)
  menu.destroy()
})

/* ------------------------------ the rows ------------------------------ */

test('search and program filters use friendly identities without changing the chosen account', async () => {
  const fixture = fakeBridge()
  fixture.state.accounts[0].directory = '.private-folder-marker'
  fixture.state.usage.accounts[0].email = 'student@example.test'
  fixture.state.usage.accounts[0].planType = 'Study Plus'
  fixture.state.usageCache = fixture.state.usage
  const menu = await mount(fixture)
  try {
    await menu.open()
    assert.equal(menu.row('codex', 'school').querySelector('.acct-signin-identity').textContent, COPY.signedInAs('student@example.test'))
    assert.equal(menu.row('codex', 'work').querySelector('.acct-signin-identity').textContent, COPY.identityNotReported)
    for (const query of ['school', 'STUDENT@', 'study plus']) {
      menu.query.value = query
      menu.query.dispatchEvent({ type: 'input' })
      assert.equal(menu.rows().length, 1)
      assert.ok(menu.row('codex', 'school'))
      assert.equal(menu.matches.textContent, COPY.matchingAccounts(1, 5))
    }
    menu.providerFilter.value = 'claude'
    menu.providerFilter.dispatchEvent({ type: 'change' })
    assert.equal(menu.rows().length, 0)
    assert.equal(menu.list.textContent, COPY.noMatches)
    menu.clearQuery.click()
    assert.equal(menu.rows().length, 5)
    assert.equal(document.activeElement, menu.query)
    menu.query.value = '.private-folder-marker'
    menu.query.dispatchEvent({ type: 'input' })
    assert.equal(menu.rows().length, 0, 'internal directory paths cannot be an account identity')
    menu.query.value = 'claude'
    menu.query.dispatchEvent({ type: 'input' })
    assert.equal(menu.rows().length, 2)
    menu.root.querySelector('[data-acct="refresh-list"]').click()
    await settle()
    assert.equal(menu.query.value, 'claude')
    assert.equal(menu.rows().length, 2)
    assert.deepEqual(fixture.state.activeByProvider, { codex: 'school', claude: 'lab', gemini: 'spare' })
    assert.equal(callsNamed(menu.calls, 'accountSwitch').length, 0)
    assert.equal(callsNamed(menu.calls, 'accountUsage').length, 0)
    assert.doesNotMatch(menu.root.textContent, /private-folder-marker/)
  } finally { menu.destroy() }
})

test('remaining meter fill, numeric value and reset details agree, while unread is never zero', async () => {
  const fixture = fakeBridge()
  fixture.state.usage.readAt = new Date().toISOString()
  fixture.state.usage.accounts[0].windows = {
    hourly: { usedPercent: 100, resetsAt: new Date(Date.now() + 30 * 60000).toISOString() },
    weekly: { usedPercent: 40, resetsAt: 'not a date' },
  }
  const menu = await mount(fixture)
  try {
    await menu.open()
    assert.equal(menu.row('codex', 'school').querySelector('.acct-reading-state').textContent, COPY.allowanceNotChecked)
    await menu.check()
    const school = menu.row('codex', 'school')
    const allowance = school.querySelector('.acct-allowance')
    assert.equal(allowance.getAttribute('aria-label'), COPY.allowanceHeading)
    assert.ok(allowance.contains(school.querySelector('.acct-reading-state')), 'measurement age stays with its allowance windows')
    const meters = school.querySelectorAll('.acct-bar-track')
    assert.deepEqual(meters.map(node => node.getAttribute('role')), ['meter', 'meter'])
    assert.deepEqual(meters.map(node => node.getAttribute('aria-valuenow')), ['0', '60'])
    assert.deepEqual(school.querySelectorAll('.acct-bar-fill').map(node => node.getAttribute('style')), ['width:0%', 'width:60%'])
    assert.deepEqual(school.querySelectorAll('.acct-bar-figure').map(textOf), ['0% remaining', '60% remaining'])
    assert.deepEqual(school.querySelectorAll('.acct-bar-reset').map(textOf), ['resets in 30 min'])
    assert.match(meters[0].getAttribute('aria-valuetext'), /100% used/)
    assert.match(school.querySelector('.acct-reading-state').textContent, /Last checked/)
    assert.equal(menu.row('codex', 'work').querySelectorAll('[role="meter"]').length, 0)
    assert.equal(menu.row('codex', 'work').querySelector('.acct-reading-state').textContent, COPY.allowanceNoReading)
  } finally { menu.destroy() }
})

test('older, undated and failed allowance checks have distinct visible text', async () => {
  for (const [readAt, expected] of [[new Date(Date.now() - 10 * 60000).toISOString(), /Last checked 10 min ago.*Older reading/], [null, /Check time not reported/]]) {
    const fixture = fakeBridge()
    fixture.state.usageCache = { ...fixture.state.usage, readAt }
    const menu = await mount(fixture)
    try {
      assert.match(menu.row('codex', 'school').querySelector('.acct-reading-state').textContent, expected)
    } finally { menu.destroy() }
  }
  const failed = await mount(fakeBridge(freshState(), { accountUsage: async () => ({ ok: false, reason: 'The check could not finish.' }) }))
  try {
    await failed.open()
    await failed.check()
    const row = failed.row('codex', 'school')
    assert.equal(row.dataset.allowanceState, 'failed')
    assert.equal(row.querySelector('.acct-reading-state').textContent, COPY.allowanceCheckFailed)
    assert.equal(row.querySelector('.acct-usage-error').textContent, 'The check could not finish.', 'the missing allowance has its own visible failure reason')
    assert.equal(row.querySelectorAll('[role="meter"]').length, 0)
    assert.equal(rowButton(row, COPY.signIn), null, 'a failed allowance check is not a sign-out')
  } finally { failed.destroy() }
})

test('an undated account reading never borrows a fresh allowance sweep time', async () => {
  const fixture = fakeBridge()
  fixture.state.usage.readAt = new Date().toISOString()
  fixture.state.usage.accounts[0].readAt = null
  fixture.state.usageCache = fixture.state.usage
  const menu = await mount(fixture)
  try {
    const row = menu.row('codex', 'school')
    assert.equal(row.querySelector('.acct-reading-state').textContent,
      `${COPY.allowanceCheckTimeUnknown} · ${COPY.allowanceOlderReading}`)
    assert.equal(row.dataset.allowanceState, 'stale')
    assert.equal(row.querySelectorAll('[role="meter"]').length, 2, 'the undated values remain available with their actual age state')
  } finally { menu.destroy() }
})

test('native cancel closes the popup and row action names remain correct after arming removal', async () => {
  const menu = await mount()
  try {
    await menu.open()
    const row = menu.row('codex', 'work')
    assert.equal(row.querySelector('.acct-row-actions').getAttribute('aria-label'), COPY.accountActions('work', 'Codex'))
    const remove = rowButton(row, COPY.remove)
    remove.click()
    assert.equal(remove.textContent, COPY.removeArmed)
    assert.equal(remove.getAttribute('aria-label'), null, 'the visible confirmation remains its accessible name')
    let cancelled = false
    menu.panel.dispatchEvent({ type: 'cancel', preventDefault() { cancelled = true } })
    assert.equal(cancelled, true)
    assert.equal(menu.panel.open, false)
    assert.equal(menu.panel.hidden, true)
    assert.equal(document.activeElement, menu.trigger)
  } finally { menu.destroy() }
})

test('a partial allowance failure names the failed check without claiming every account was checked', async () => {
  const fixture = fakeBridge()
  fixture.state.usage.readAt = new Date().toISOString()
  fixture.state.usage.accounts.push({ name: 'work', provider: 'codex', status: 'transient', canServe: false, reason: 'The check did not respond.' })
  const menu = await mount(fixture)
  try {
    await menu.open()
    await menu.check()
    const failed = menu.row('codex', 'work')
    assert.equal(failed.dataset.allowanceState, 'failed')
    assert.equal(failed.querySelector('.acct-reading-state').textContent, COPY.allowanceCheckFailed)
    assert.equal(failed.querySelectorAll('[role="meter"]').length, 0)
    assert.deepEqual(flagsOf(failed), [[COPY.accountCheckFailed, 'The check did not respond.']])
    assert.ok(linesOf(failed).includes('The check did not respond.'), 'failure evidence remains readable')
    assert.equal(linesOf(failed).includes(COPY.usageUnknownWhy), false, 'a failed check does not get the never-checked reassurance')
    assert.equal(rowButton(failed, COPY.signIn), null)
    assert.equal(menu.out.dataset.tone, 'refused')
    assert.equal(menu.out.textContent, COPY.allowanceSomeFailed(1))
    assert.equal(menu.row('codex', 'school').querySelectorAll('[role="meter"]').length, 2)
  } finally { menu.destroy() }
})

test('a failed refresh retains the last real reading and its age, clearly marked as older', async () => {
  const fixture = fakeBridge()
  fixture.state.usageCache = { ...fixture.state.usage, readAt: new Date(Date.now() - 10 * 60000).toISOString() }
  fixture.bridge.accountUsage = async () => ({ ok: false, reason: 'The allowance check could not finish.' })
  const menu = await mount(fixture)
  try {
    await menu.open()
    await menu.check()
    const row = menu.row('codex', 'school')
    assert.equal(row.dataset.allowanceState, 'failed')
    assert.match(row.querySelector('.acct-reading-state').textContent, /Couldn’t check allowances.*Last checked 10 min ago.*Older reading/)
    assert.deepEqual(row.querySelectorAll('.acct-bar-figure').map(textOf), ['82% remaining', '60% remaining'])
    assert.equal(menu.out.textContent, 'The allowance check could not finish.')
    assert.equal(rowButton(row, COPY.signIn), null)
  } finally { menu.destroy() }
})

test('an account relink never displays the previous identity or allowance under its reused friendly name', async () => {
  const fixture = fakeBridge()
  fixture.state.usage.accounts[0].email = 'previous@example.test'
  fixture.state.usageCache = fixture.state.usage
  const menu = await mount(fixture)
  try {
    await menu.open()
    assert.equal(menu.row('codex', 'school').querySelector('.acct-signin-identity').textContent, COPY.signedInAs('previous@example.test'))
    fixture.state.accounts[0].allowanceBinding = 'f'.repeat(64)
    menu.root.querySelector('[data-acct="refresh-list"]').click()
    await settle()
    const row = menu.row('codex', 'school')
    assert.equal(row.querySelector('.acct-signin-identity').textContent, COPY.identityNotReported)
    assert.equal(row.querySelectorAll('[role="meter"]').length, 0)
    assert.equal(fixture.state.activeByProvider.codex, 'school')
    assert.equal(callsNamed(menu.calls, 'accountSwitch').length, 0)
    assert.doesNotMatch(menu.root.textContent, /previous@example.test|f{64}/)
  } finally { menu.destroy() }
})

test('a Gemini row says one sentence, an unread Codex row says two, and an engine fault is text a keyboard can read', async () => {
  const menu = await mount()
  await menu.open()
  await menu.check()

  const spare = menu.row('gemini', 'spare')
  assert.deepEqual(linesOf(spare), [COPY.usageNotMeasured], 'a Gemini row said "not known" twice')
  assert.equal(spare.querySelectorAll('.acct-bars').length, 0, 'a Gemini row draws no bar a press could never fill')
  assert.deepEqual(flagsOf(spare), [['Gemini CLI', null]])

  const work = menu.row('codex', 'work')
  assert.deepEqual(linesOf(work), [COPY.usageUnknown, COPY.usageUnknownWhy])

  const lab = menu.row('claude', 'lab')
  assert.deepEqual(flagsOf(lab), [['exhausted', EXHAUSTED_REASON]], 'the engine status is spoken, not shouted, and its reason rides in the tooltip')
  assert.ok(linesOf(lab).includes(EXHAUSTED_REASON), 'a title on a span is unreachable by keyboard; the reason has to be on the row as text')
  assert.equal(lab.querySelectorAll('.acct-line-quiet').at(-1).textContent, EXHAUSTED_REASON)
  assert.equal(rowButton(lab, COPY.signIn), null, 'an exhausted account is not a signed-out one')

  const home = menu.row('claude', 'home')
  assert.deepEqual(flagsOf(home), [[COPY.notSignedIn, null]], 'one fact, one flag, and no environment-variable sentence in its tooltip')
  assert.ok(!linesOf(home).some(line => line.includes('CLAUDE_CONFIG_DIR')), 'the engine sign-out sentence reached the row')
  assert.ok(rowButton(home, COPY.signIn), 'a signed-out row offers the one press that fixes it')
  menu.destroy()
})

/* ------------------------------ Use this one ------------------------------ */

test('Rotate saves and reads back globally and per program, without asking for an allowance ranking', async () => {
  const fixture = fakeBridge()
  let menu = await mount(fixture)
  await menu.open()
  assert.ok(menu.mode.querySelectorAll('option').some(option => option.value === 'rotate' && option.textContent === 'Rotate'))
  menu.mode.value = 'rotate'
  menu.mode.dispatchEvent({ type: 'change' })
  await settle()
  assert.deepEqual(callsNamed(menu.calls, 'accountPolicy').at(-1), ['accountPolicy', { selectionMode: 'rotate' }])
  assert.equal(menu.out.textContent, COPY.modeSaved('Rotate'))
  assert.equal(menu.mode.value, 'rotate')
  assert.equal(menu.rankField.hidden, true)
  assert.equal(menu.providerRank('codex').hidden, true)
  menu.destroy()

  menu = await mount(fixture)
  await menu.open()
  assert.equal(menu.mode.value, 'rotate', 'a new view uses the rule read from the shell')
  menu.mode.value = 'manual'
  menu.mode.dispatchEvent({ type: 'change' })
  await settle()
  menu.providerMode('codex').value = 'rotate'
  menu.providerMode('codex').dispatchEvent({ type: 'change' })
  await settle()
  assert.deepEqual(callsNamed(menu.calls, 'accountPolicy').at(-1), ['accountPolicy', { provider: 'codex', selectionMode: 'rotate' }])
  assert.equal(menu.providerMode('codex').value, 'rotate')
  assert.equal(menu.providerMode('claude').value, 'inherit')
  assert.equal(menu.mode.value, 'manual')
  assert.equal(menu.providerRank('codex').hidden, true)
  menu.destroy()
})

test('Use this one under Rotate shows the chosen account and says the next start will advance', async () => {
  const fixture = fakeBridge()
  fixture.state.mode = 'rotate'
  const menu = await mount(fixture)
  await menu.open()
  rowButton(menu.row('codex', 'work'), COPY.switchTo).click()
  await settle()
  assert.deepEqual(callsNamed(menu.calls, 'accountSwitch'), [['accountSwitch', { name: 'work', provider: 'codex' }]])
  assert.equal(menu.out.textContent, COPY.switchedRotate('work'))
  assert.equal(menu.row('codex', 'work').getAttribute('data-active'), 'yes')
  assert.ok(menu.trigger.title.includes('Codex · work'))
  assert.equal(menu.mode.value, 'rotate', 'an explicit switch leaves the rotation rule saved')
  menu.destroy()
})

test('Use this one asks the shell for that row, says which account, redraws the list and leaves the keyboard on the status line', async () => {
  const fixture = fakeBridge()
  const menu = await mount(fixture)
  await menu.open()
  const pressed = rowButton(menu.row('codex', 'work'), COPY.switchTo)
  pressed.focus()
  pressed.click()
  assert.equal(menu.out.textContent, COPY.switching)
  assert.equal(pressed.disabled, true)
  /* A press on another row while this one is in flight is not a second switch. */
  rowButton(menu.row('claude', 'home'), COPY.switchTo).click()
  await settle()
  assert.deepEqual(callsNamed(menu.calls, 'accountSwitch'), [['accountSwitch', { name: 'work', provider: 'codex' }]])
  assert.equal(menu.out.textContent, COPY.switched('work'))
  assert.equal(menu.out.dataset.tone, 'confirmed')
  assert.equal(menu.root.contains(pressed), false, 'the list is redrawn from scratch; the pressed button is gone')
  assert.equal(document.activeElement, menu.out, 'the keyboard has to land on the answer, not on the page body')
  assert.equal(menu.row('codex', 'work').getAttribute('data-active'), 'yes')
  assert.equal(rowButton(menu.row('codex', 'work'), COPY.switchTo), null, 'the account in use offers no switch')
  assert.ok(rowButton(menu.row('codex', 'school'), COPY.switchTo))
  assert.equal(menu.label.textContent, COPY.buttonMultiple(3))
  assert.ok(menu.trigger.title.includes('Codex · work'))

  /* Under a ranked mode the sentence says the ranking takes over after one run. */
  fixture.state.mode = 'dynamic'
  menu.close()
  await menu.open()
  rowButton(menu.row('codex', 'school'), COPY.switchTo).click()
  await settle()
  assert.equal(menu.out.textContent, COPY.switchedRanked('school', 'Dynamic'))
  assert.equal(document.activeElement, menu.out)
  menu.destroy()
})

test('a refused switch redraws nothing and puts the keyboard back on the button', async () => {
  const reason = 'No account named “work” is on the list, so nothing changed.'
  const menu = await mount(fakeBridge(freshState(), { accountSwitch: async () => ({ ok: false, code: 'ACCOUNT_UNKNOWN', reason }) }))
  await menu.open()
  const pressed = rowButton(menu.row('codex', 'work'), COPY.switchTo)
  pressed.click()
  await settle()
  assert.equal(menu.out.textContent, reason)
  assert.equal(menu.out.dataset.tone, 'refused')
  assert.equal(menu.root.contains(pressed), true, 'a refusal redraws nothing')
  assert.equal(pressed.disabled, false)
  assert.equal(document.activeElement, pressed, 'after a refusal, trying again has to be one press away')
  assert.equal(menu.row('codex', 'school').getAttribute('data-active'), 'yes', 'the account in use did not change')
  menu.destroy()
})

/* ------------------------------ Sign in ------------------------------ */

test('Sign in opens the window for that row and leaves the keyboard on the status line; not installed is said in this menu\'s words', async () => {
  const fixture = fakeBridge()
  const menu = await mount(fixture)
  await menu.open()
  const pressed = rowButton(menu.row('claude', 'home'), COPY.signIn)
  pressed.click()
  /* The progress line names the account, because the run below says this line
     once per account and three anonymous "Opening the sign-in window…" in a row
     tell a person nothing about which window is arriving. */
  assert.equal(menu.out.textContent, COPY.openingSignIn('home'))
  assert.equal(pressed.disabled, true)
  await settle()
  assert.deepEqual(callsNamed(menu.calls, 'accountSignIn'), [['accountSignIn', { name: 'home', provider: 'claude' }]])
  assert.equal(menu.out.textContent, COPY.signInOpened('home', null))
  assert.equal(menu.out.dataset.tone, 'confirmed')
  assert.equal(pressed.disabled, false)
  assert.equal(document.activeElement, menu.out)

  /* AND WHEN THE SHELL SAYS WHAT IT CALLED THE WINDOW, the sentence quotes it.
     Every sign-in window for one program runs the same command, so the name is
     the only thing that tells one of several apart -- and it is the shell's
     word, carried here, never a second copy of the format built in this menu. */
  const TITLE = 'ToolsEnabled sign-in: home - claude'
  fixture.bridge.accountSignIn = async () => ({ ok: true, terminal: 'command-prompt', title: TITLE })
  pressed.click()
  await settle()
  assert.equal(menu.out.textContent, COPY.signInOpened('home', TITLE))
  assert.ok(menu.out.textContent.includes(`“${TITLE}”`), 'the confirmation does not name the window that opened')

  fixture.bridge.accountSignIn = async () => ({ ok: false, code: NOT_INSTALLED_CODE, reason: 'That program is not on this computer yet. Press Install first, and this button will work.' })
  pressed.click()
  await settle()
  assert.equal(menu.out.textContent, COPY.notInstalled('Claude'), 'the shell\'s sentence presses an Install button this menu does not have')
  assert.equal(menu.out.dataset.tone, 'refused')
  assert.equal(document.activeElement, pressed, 'after a refusal the keyboard goes back to the button')
  menu.destroy()
})

test('after a Sign in press the row changes when that folder does, and nothing is listened to before the press', async () => {
  /* THE DEFECT THIS PINS. A person pressed Sign in, finished in the terminal
     window, came back -- and the row said what it said before, because the
     only fresh signal on this menu was a press of Check allowances. */
  const fixture = fakeBridge()
  const menu = await mount(fixture)
  await menu.open()
  assert.equal(fixture.listening(), 0, 'the menu subscribed to a folder nobody pressed Sign in for')

  const before = menu.row('claude', 'home')
  assert.ok(rowButton(before, COPY.signIn), 'the signed-out row did not offer the press this test is about')
  rowButton(before, COPY.signIn).click()
  await settle()
  assert.equal(fixture.listening(), 1, 'the press opened a window and then listened for nothing')

  /* A push for somebody else's row is not this row's answer. */
  fixture.pushSignIn({ name: 'lab', provider: 'claude', signedIn: 'no' })
  await settle()
  assert.equal(menu.out.textContent, COPY.signInOpened('home'), 'another account\u2019s change was reported as this one\u2019s')

  /* The program writes its sign-in into that folder; the shell, which was
     watching that one folder, says so. */
  fixture.state.accounts.find(account => account.name === 'home').signedIn = 'yes'
  fixture.pushSignIn({ name: 'home', provider: 'claude', signedIn: 'yes' })
  await settle()
  const after = menu.row('claude', 'home')
  assert.equal(menu.out.textContent, COPY.signInSeen('home'))
  assert.equal(menu.out.dataset.tone, 'confirmed')
  assert.equal(rowButton(after, COPY.signIn), null, 'a signed-in row still offered Sign in')
  assert.deepEqual(flagsOf(after), [], 'a signed-in row still carried a flag')

  /* The window was closed without finishing: still signed out, and said so. */
  fixture.state.accounts.find(account => account.name === 'home').signedIn = 'no'
  fixture.pushSignIn({ name: 'home', provider: 'claude', signedIn: 'no' })
  await settle()
  assert.equal(menu.out.textContent, COPY.signInStillOut('home'))
  assert.ok(rowButton(menu.row('claude', 'home'), COPY.signIn), 'the row lost the press that fixes it')

  /* COULD NOT LOOK IS NOT SIGNED OUT, and it is not a sentence either: the
     row's own flag is the honest report, and a status line announcing it
     would be the menu shouting about a folder nobody asked about. */
  fixture.state.accounts.find(account => account.name === 'home').signedIn = 'unknown'
  fixture.pushSignIn({ name: 'home', provider: 'claude', signedIn: 'unknown' })
  await settle()
  assert.equal(menu.out.textContent, COPY.signInStillOut('home'), 'a state nobody could read was announced as one')
  const blind = menu.row('claude', 'home')
  assert.deepEqual(flagsOf(blind), [[COPY.signInUnchecked, null]])
  assert.equal(rowButton(blind, COPY.signIn), null, 'a row nobody could look at was sent to sign in again')

  menu.destroy()
  assert.equal(fixture.listening(), 0, 'a destroyed menu left its listener attached')
})

/* ------------------------ signing several in, one at a time ------------------------ */

/* Three accounts that need signing in, which is the shape the owner was in:
   several to do, every window identical, and no order between the presses. */
function threeToSignIn() {
  const state = freshState()
  state.accounts = [
    { name: 'school', provider: 'codex', signedIn: 'no' },
    { name: 'work', provider: 'codex', signedIn: 'yes' },
    { name: 'home', provider: 'claude', signedIn: 'no' },
    { name: 'spare', provider: 'gemini', signedIn: 'no' },
  ]
  state.usage = { ok: true, accounts: [], orders: [] }
  return state
}

test('one control signs in every account that needs it, opening ONE window per press', async () => {
  /* THE DEFECT. MEASURED 2026-09-03: there was no sequencing between sign-in
     presses at all, and every window that opened was identical and untitled --
     so the only way to sign several accounts in was to press each row in turn
     and then work out which of several identical windows was which. A control
     that opened them all at once would make that worse, and it cannot know when
     one has finished: the window is the person's and this product reads nothing
     of it. So a press opens the NEXT one and says how many are left. */
  const fixture = fakeBridge(threeToSignIn())
  fixture.bridge.accountSignIn = async request => {
    fixture.calls.push(['accountSignIn', { ...request }])
    return { ok: true, terminal: 'command-prompt', title: `ToolsEnabled sign-in: ${request.name} - ${request.provider}` }
  }
  const menu = await mount(fixture)
  await menu.open()

  assert.equal(menu.signInEach.hidden, false, 'three accounts need signing in and the one control is not on screen')
  assert.equal(menu.signInEach.textContent, COPY.signInEach(3))

  menu.signInEach.click()
  await settle()
  assert.deepEqual(callsNamed(menu.calls, 'accountSignIn'), [['accountSignIn', { name: 'school', provider: 'codex' }]],
    'one press opened more than one window, or opened the wrong one')
  assert.equal(menu.out.textContent, COPY.signInOpened('school', 'ToolsEnabled sign-in: school - codex'))
  assert.equal(menu.signInEach.textContent, COPY.signInEach(2), 'the control does not say how many are left')

  /* The list still reports every one of them as not signed in -- the person is
     only just starting in the first window -- and the run moves on anyway. */
  assert.equal(menu.state.accounts.filter(account => account.signedIn === 'no').length, 3)
  menu.signInEach.click()
  await settle()
  assert.deepEqual(callsNamed(menu.calls, 'accountSignIn').at(-1), ['accountSignIn', { name: 'home', provider: 'claude' }])
  assert.equal(menu.signInEach.textContent, COPY.signInEach(1))

  menu.signInEach.click()
  await settle()
  assert.deepEqual(callsNamed(menu.calls, 'accountSignIn').at(-1), ['accountSignIn', { name: 'spare', provider: 'gemini' }])
  assert.equal(menu.signInEach.hidden, true, 'the control stands after the last account, offering a press that does nothing')
  assert.ok(menu.out.textContent.endsWith(COPY.signInEachDone), `the run does not say it is finished: ${menu.out.textContent}`)
  assert.equal(document.activeElement, menu.out)

  /* Three presses, three windows, three different accounts and no repeats. */
  const names = callsNamed(menu.calls, 'accountSignIn').map(([, request]) => request.name)
  assert.deepEqual(names, ['school', 'home', 'spare'])
  assert.equal(new Set(names).size, 3, 'the run opened the same account twice')
  menu.destroy()
})

test('the run stops where a window would not open, and the row it stopped on stays in it', async () => {
  /* A run that stepped past what it could not do would be the silent skip this
     codebase keeps finding: the person would be told two windows opened and
     find one. The shell's own sentence is shown and the account is still next. */
  const reason = 'That program is not on this computer yet. Press Install first, and this button will work.'
  const fixture = fakeBridge(threeToSignIn(), {
    accountSignIn: async () => ({ ok: false, code: NOT_INSTALLED_CODE, reason }),
  })
  const menu = await mount(fixture)
  await menu.open()
  menu.signInEach.click()
  await settle()
  assert.equal(menu.out.dataset.tone, 'refused')
  assert.equal(menu.out.textContent, COPY.notInstalled('Codex'), 'the shell\'s own words for a missing program are shown')
  assert.equal(menu.signInEach.textContent, COPY.signInEach(3), 'a window that never opened took its account out of the run')
  menu.destroy()
})

test('the run listens to the window it opened, and the listener follows the run from one account to the next', async () => {
  /* THE DEFECT THIS PINS. MEASURED 2026-09-03 by reading the merged
     src/account-switcher.js: onSignIn() and onAdd() called watchSignInChange()
     and onSignInEach() called it nowhere -- while all three open a window
     through the same `mc-account:sign-in`, whose handler arms a watch on every
     call (shell/main.cjs armSignInWatch) over a store whose own note reads
     "Arming replaces whatever was armed before" (shell/account-registry.cjs
     watchSignIn). So a run press moved the shell's watch onto the account it
     had just opened while this side went on filtering for the account an
     earlier row press had named: the run's packet was dropped by name, and the
     account the filter still wanted was watched by nothing. Every account
     signed in through the run reported nothing at all, and the only way to
     learn the outcome was Check allowances -- one short-lived program per
     account. Both halves are asserted here: that the run listens, and that its
     listener moves with it rather than staying on the first account. */
  const fixture = fakeBridge(threeToSignIn())
  const menu = await mount(fixture)
  /* THE MENU IS TAKEN DOWN EVEN WHEN AN ASSERTION THROWS. Every mount here
     puts a live listener on one shared stand-in document, so a test that
     failed before its own destroy() used to leave one attached and fail a
     later, unrelated test as well -- which is exactly the noise that makes a
     mutation run unreadable (measured 2026-09-03: reverting the fix this test
     is for turned 2 failures into 3). */
  try {
    await menu.open()
    assert.equal(fixture.listening(), 0, 'the menu listened to a folder nobody pressed anything for')

    /* First press of the run: 'school'. */
    menu.signInEach.click()
    await settle()
    assert.deepEqual(callsNamed(menu.calls, 'accountSignIn').at(-1), ['accountSignIn', { name: 'school', provider: 'codex' }])
    assert.equal(fixture.listening(), 1, 'the run opened a window and listened to nothing')

    /* The program writes its sign-in; the shell re-probes that one folder and
       pushes the same three words the list answers with. */
    fixture.state.accounts.find(account => account.name === 'school').signedIn = 'yes'
    fixture.pushSignIn({ name: 'school', provider: 'codex', signedIn: 'yes' })
    await settle()
    assert.equal(menu.out.textContent, COPY.signInSeen('school'), 'an account the run signed in reported nothing')
    assert.equal(rowButton(menu.row('codex', 'school'), COPY.signIn), null, 'a signed-in row still offered Sign in')
    assert.equal(menu.signInEach.textContent, COPY.signInEach(2), 'the count did not fall when an account actually signed in')
    assert.equal(callsNamed(menu.calls, 'accountUsage').length, 0, 'learning the outcome started a program per account')

    /* Second press: 'home'. The shell's watch has moved to it, so this side's
       must have moved too -- one watch, one account, both sides agreeing. */
    menu.signInEach.click()
    await settle()
    assert.deepEqual(callsNamed(menu.calls, 'accountSignIn').at(-1), ['accountSignIn', { name: 'home', provider: 'claude' }])
    assert.equal(fixture.listening(), 1, 'the run stacked a second listener instead of replacing the first')
    fixture.pushSignIn({ name: 'home', provider: 'claude', signedIn: 'no' })
    await settle()
    assert.equal(menu.out.textContent, COPY.signInStillOut('home'), 'the listener stayed on the account of the first press')
    assert.ok(rowButton(menu.row('claude', 'home'), COPY.signIn), 'the row lost the press that fixes it')
  } finally {
    menu.destroy()
  }
  assert.equal(fixture.listening(), 0, 'a destroyed menu left the run’s listener attached')
})

test('a run press that opened nothing leaves the watch the last window armed', async () => {
  /* A refusal arms nothing in the shell, so tearing this side's watch down
     would silence the window that IS open and waiting -- a press that failed
     taking the report of a press that worked with it. */
  const fixture = fakeBridge(threeToSignIn())
  const menu = await mount(fixture)
  try {
    await menu.open()
    menu.signInEach.click()
    await settle()
    assert.equal(fixture.listening(), 1)

    const reason = 'The window could not be opened. Press the button again in a moment.'
    fixture.bridge.accountSignIn = async request => {
      fixture.calls.push(['accountSignIn', { ...request }])
      return { ok: false, code: 'PROVIDER_LOGIN_SPAWN_FAILED', reason }
    }
    menu.signInEach.click()
    await settle()
    assert.equal(menu.out.textContent, reason)
    assert.equal(fixture.listening(), 1, 'a refused press detached the watch on the window that did open')
    fixture.state.accounts.find(account => account.name === 'school').signedIn = 'yes'
    fixture.pushSignIn({ name: 'school', provider: 'codex', signedIn: 'yes' })
    await settle()
    assert.equal(menu.out.textContent, COPY.signInSeen('school'), 'the open window went unreported after a later press failed')
  } finally {
    menu.destroy()
  }
})

test('one account that needs signing in has its row button and no second control beside it', async () => {
  /* The row's own Sign in press already does that one job. A second control for
     it would be two ways to do one thing, which is what the sequencing control
     exists to avoid rather than to add. */
  const menu = await mount(fakeBridge())
  await menu.open()
  assert.equal(menu.rows().filter(row => rowButton(row, COPY.signIn)).length, 1)
  assert.equal(menu.signInEach.hidden, true, 'a run is offered for a single account the row already handles')
  menu.destroy()
})

/* ------------------------------ Add ------------------------------ */

test('Add presses accountAddManaged then accountSignIn, for the name the shell settled on, and clears the name box', async () => {
  const menu = await mount()
  await menu.open()
  menu.name.value = '  work  '
  const pressed = menu.addButton('claude')
  pressed.click()
  assert.equal(menu.out.textContent, COPY.adding)
  assert.ok(menu.addButtons.every(button => button.disabled), 'every add button is held for the round trip')
  await settle()
  const presses = menu.calls.filter(([name]) => name === 'accountAddManaged' || name === 'accountSignIn')
  assert.deepEqual(presses, [
    ['accountAddManaged', { provider: 'claude', name: 'work' }],
    ['accountSignIn', { name: 'work-2', provider: 'claude' }],
  ], 'the sign-in has to be opened for the name the shell answered, not the one typed')
  assert.equal(menu.out.textContent, COPY.added('work-2', null))
  assert.equal(menu.out.dataset.tone, 'confirmed')
  assert.equal(menu.name.value, '', 'the name box is cleared for the next account')
  assert.ok(menu.addButtons.every(button => !button.disabled))
  const added = menu.row('claude', 'work-2')
  assert.ok(added, 'the list is re-read and shows the new account')
  assert.ok(rowButton(added, COPY.signIn), 'the new row offers Sign in, which is the way to try again')
  assert.equal(document.activeElement, menu.out, 'the answer says what comes next; the keyboard goes to it')

  /* No name typed: the request carries no name key at all. */
  menu.addButton('gemini').click()
  await settle()
  assert.deepEqual(callsNamed(menu.calls, 'accountAddManaged').at(-1), ['accountAddManaged', { provider: 'gemini' }])
  assert.deepEqual(callsNamed(menu.calls, 'accountSignIn').at(-1), ['accountSignIn', { name: 'gemini-2', provider: 'gemini' }])
  assert.equal(menu.out.textContent, COPY.added('gemini-2', null))
  menu.destroy()
})

test('an add the shell refused opens no sign-in; an add whose window did not open says both facts', async () => {
  const reason = 'An account with that name is already listed.'
  const refused = await mount(fakeBridge(freshState(), { accountAddManaged: async () => ({ ok: false, code: 'ACCOUNT_NAME_TAKEN', reason }) }))
  await refused.open()
  const pressed = refused.addButton('codex')
  pressed.click()
  await settle()
  assert.equal(callsNamed(refused.calls, 'accountSignIn').length, 0, 'a sign-in was opened for an account that was not added')
  assert.equal(refused.out.textContent, reason)
  assert.equal(refused.out.dataset.tone, 'refused')
  assert.equal(pressed.disabled, false)
  assert.equal(document.activeElement, pressed)
  refused.destroy()

  const shellWords = 'That program is not on this computer yet. Press Install first, and this button will work.'
  const notOpened = await mount(fakeBridge(freshState(), { accountSignIn: async () => ({ ok: false, code: NOT_INSTALLED_CODE, reason: shellWords }) }))
  await notOpened.open()
  notOpened.addButton('codex').click()
  await settle()
  assert.equal(notOpened.out.textContent, `${COPY.addedOnly('codex-2')} ${COPY.notInstalled('Codex')}`, 'added, then why the window did not open, in that order')
  assert.equal(notOpened.out.dataset.tone, 'refused')
  assert.ok(rowButton(notOpened.row('codex', 'codex-2'), COPY.signIn), 'the row\'s own Sign in is the way to try again')
  assert.equal(document.activeElement, notOpened.out)
  notOpened.destroy()
})

/* ------------------------------ the newest read paints ------------------------------ */

test('the newest list read is the one that paints, however the reads land', async () => {
  const pending = []
  const reply = names => ({
    ok: true,
    accounts: names.map(name => ({ name, provider: 'codex', signedIn: 'yes' })),
    activeByProvider: { codex: names[0] || null, claude: null, gemini: null },
    policy: { selectionMode: 'manual', recorded: true, reservePercent: 25 },
  })
  const fixture = fakeBridge(freshState(), { accounts: () => new Promise(resolve => { pending.push(resolve) }) })
  const menu = await mount(fixture)
  assert.equal(pending.length, 1, 'the mount read is in flight')
  await menu.open()
  menu.close()
  await menu.open()
  assert.equal(pending.length, 3, 'each open is a read')

  pending[2](reply(['newest']))
  await settle()
  assert.deepEqual(menu.rows().map(row => row.querySelector('.acct-name').textContent), ['newest'])
  pending[1](reply(['older']))
  pending[0](reply(['oldest']))
  await settle()
  assert.deepEqual(menu.rows().map(row => row.querySelector('.acct-name').textContent), ['newest'],
    'a read that started earlier and landed later painted over the newest answer')
  menu.destroy()
})

/* ------------------------------ the kept read ------------------------------ */

test('a failover that already happened is on the menu, in one sentence, with the reason under it', async () => {
  /* THE CHANGE NOBODY WAS PRESENT FOR. The menu could say WHEN this computer
     last changed account and never what the change was, so an automatic
     failover -- the one thing a person finds out about after the fact -- was
     the one thing it could not describe. */
  const fixture = fakeBridge()
  fixture.state.lastSwitch = {
    at: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
    from: 'lab', to: 'home', provider: 'claude', automatic: true,
    reason: 'Its weekly allowance was used up.',
  }
  const menu = await mount(fixture)
  await menu.open()
  const said = menu.root.querySelector('[data-acct="switched"]')
  assert.equal(said.hidden, false)
  assert.equal(said.querySelector('.acct-switched-what').textContent,
    'Claude: This computer moved from “lab” to “home” on its own, 12 min ago.')
  assert.equal(said.querySelector('.acct-switched-why').textContent,
    'It gave this reason: Its weekly allowance was used up.')
  /* Marked so the styling can agree with the words rather than re-decide. */
  assert.equal(said.dataset.automatic, 'yes')
  menu.destroy()
})

test('a computer that has never changed account says nothing, and a damaged list does not hide a change that happened', async () => {
  const never = await mount(fakeBridge())
  await never.open()
  const quiet = never.root.querySelector('[data-acct="switched"]')
  assert.equal(quiet.hidden, true, 'a computer that never switched was told it had')
  assert.equal(quiet.textContent, '')
  never.destroy()

  /* A failover is a fact about this computer, not about whether its account
     file parses today, so it survives a list that came back damaged. */
  const fixture = fakeBridge()
  fixture.state.lastSwitch = { at: new Date().toISOString(), from: 'lab', to: 'home', automatic: true }
  fixture.state.accounts = []
  const damaged = await mount(fixture)
  await damaged.open()
  const said = damaged.root.querySelector('[data-acct="switched"]')
  assert.equal(said.hidden, false, 'an empty list hid a change that had already happened')
  assert.match(said.textContent, /moved from “lab” to “home”/)
  damaged.destroy()
})

test('the last read the shell kept paints at mount, dated, and the chip shows room before any program starts', async () => {
  const fixture = fakeBridge()
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString()
  fixture.state.usageCache = { ...fixture.state.usage, readAt: tenMinutesAgo }
  const menu = await mount(fixture)
  assert.equal(callsNamed(menu.calls, 'accountUsage').length, 0, 'mounting must not start the allowance programs')
  assert.equal(menu.label.textContent, COPY.buttonMultiple(3))
  assert.ok(menu.trigger.title.includes('60% free'), 'the named account keeps its cached allowance')
  await menu.open()
  assert.equal(callsNamed(menu.calls, 'accountUsage').length, 0, 'opening must not start the allowance programs either')
  const checked = menu.root.querySelector('[data-acct="checked"]')
  assert.equal(checked.hidden, false)
  assert.equal(checked.textContent, COPY.checkedAgo('10 min ago'))
  assert.ok(menu.row('codex', 'school').querySelector('.acct-bar-figure'), 'the kept bars are on the rows')
  /* A press replaces the kept read with a fresh one and re-dates the line. */
  fixture.state.usage = { ...fixture.state.usage, readAt: new Date().toISOString() }
  await menu.check()
  assert.equal(callsNamed(menu.calls, 'accountUsage').length, 1)
  assert.equal(checked.textContent, COPY.checkedJustNow)
  menu.destroy()
})

test('the account header distinguishes shared allowance from an exhausted model ceiling', async () => {
  const fixture = fakeBridge()
  fixture.state.accounts = [{ name: 'Owner', provider: 'claude', signedIn: 'yes' }]
  fixture.state.activeByProvider = { claude: 'Owner' }
  fixture.state.usageCache = {
    ok: true, readAt: new Date().toISOString(), accounts: [{
      name: 'Owner', provider: 'claude', status: 'EXHAUSTED', canServe: false,
      windows: {
        hourly: { usedPercent: 10, label: 'session' },
        weekly: { usedPercent: 100, label: 'weekly_scoped', model: 'Fable' },
        weeklyWindows: [
          { usedPercent: 97, label: 'weekly_all' },
          { usedPercent: 100, label: 'weekly_scoped', model: 'Fable' },
        ],
      },
    }],
  }
  const menu = await mount(fixture)
  try {
    assert.equal(menu.label.textContent, 'Owner · 3% shared allowance left')
    await menu.open()
    const row = menu.row('claude', 'Owner')
    assert.deepEqual(row.querySelectorAll('.acct-bar-figure').map(textOf), ['90% remaining', '3% remaining', '0% remaining'])
    assert.match(menu.trigger.title, /Fable/)
    assert.equal(callsNamed(menu.calls, 'accountUsage').length, 0, 'painting uses the existing reading without starting a provider')
  } finally { menu.destroy() }
})

test('an account header with only a model ceiling names that model instead of claiming a shared total', async () => {
  const fixture = fakeBridge()
  fixture.state.accounts = [{ name: 'Owner', provider: 'claude', signedIn: 'yes' }]
  fixture.state.activeByProvider = { claude: 'Owner' }
  fixture.state.usageCache = { ok: true, readAt: new Date().toISOString(), accounts: [{
    name: 'Owner', provider: 'claude', status: 'EXHAUSTED', canServe: false,
    windows: { weekly: { usedPercent: 100, model: 'Fable', label: 'weekly_scoped' } },
  }] }
  const menu = await mount(fixture)
  try { assert.equal(menu.label.textContent, 'Owner · 0% left for Fable') }
  finally { menu.destroy() }
})

test('an account that answered one window says "none reported" for the other, not "not known"', async () => {
  const fixture = fakeBridge()
  /* Codex Pro: one window, the week, reported as primary with no length. */
  fixture.state.usage.accounts[0] = { name: 'school', provider: 'codex', status: 'HEALTHY', canServe: true, windows: { hourly: null, weekly: { usedPercent: 87 } } }
  const menu = await mount(fixture)
  await menu.open()
  await menu.check()
  const bars = menu.row('codex', 'school').querySelectorAll('.acct-bar')
  assert.equal(bars[0].querySelector('.acct-bar-none').textContent, COPY.noneReported, 'the missing 5-hour window of a plan without one')
  assert.ok(bars[1].querySelector('.acct-bar-figure'), 'the week is drawn')
  const unread = menu.row('codex', 'work').querySelectorAll('.acct-bar')
  assert.equal(unread[0].querySelector('.acct-bar-none').textContent, COPY.notKnown, 'an account that answered nothing stays "not known"')
  menu.destroy()
})

test('a Claude row draws BOTH weeks, each named, and the accessible names are not two of the same sentence', async () => {
  /* MEASURED 2026-09-02 (Claude Code 2.1.258, the owner's own account): the
     `get_usage` reply carried a week across all models at 25% used AND a
     Fable-scoped week at 46%, active. The menu had one weekly slot, so it drew
     the worse of the two under the word "this week" -- owner: "i think fable
     weekly limit instead of all models weekly limit is shown for claude we
     should include both". */
  const fixture = fakeBridge()
  fixture.state.usage.accounts[2] = {
    name: 'lab',
    provider: 'claude',
    status: 'HEALTHY',
    canServe: true,
    windows: {
      hourly: { usedPercent: 21, label: 'session' },
      weekly: { usedPercent: 46, label: 'weekly_scoped · Fable', model: 'Fable' },
      weeklyWindows: [
        { usedPercent: 25, label: 'weekly_all' },
        { usedPercent: 46, label: 'weekly_scoped · Fable', model: 'Fable' },
      ],
    },
  }
  const menu = await mount(fixture)
  await menu.open()
  await menu.check()

  const row = menu.row('claude', 'lab')
  assert.deepEqual(row.querySelectorAll('.acct-bar-label').map(textOf),
    [COPY.hourlyBar, COPY.weeklyAll, COPY.weeklyModel('Fable')],
    'three bars: the short window and both weeks, each saying which week it is')
  assert.deepEqual(row.querySelectorAll('.acct-bar-figure').map(textOf),
    [COPY.percentRemaining(79), COPY.percentRemaining(75), COPY.percentRemaining(54)],
    'the all-models week is 75% free and the Fable week 54%; one bar could only ever show one of them')
  const spoken = row.querySelectorAll('.acct-bar-track').map(track => track.getAttribute('aria-label'))
  assert.equal(new Set(spoken).size, 3, 'two bars whose accessible names differ only by a percentage tell a screen reader nothing')
  assert.ok(spoken[1].includes(COPY.weeklyAll) && spoken[2].includes(COPY.weeklyModel('Fable')))
  assert.deepEqual(row.querySelectorAll('.acct-bar-detail').map(textOf), ['21% used', '25% used', '46% used'],
    'each named ceiling carries its own visible used amount')
  assert.deepEqual(linesOf(row), [], 'the same three readings are not repeated beneath the meters')

  /* A row from an engine that sends one week only keeps the two bars and the
     plain word it has always had. */
  const codex = menu.row('codex', 'school')
  assert.deepEqual(codex.querySelectorAll('.acct-bar-label').map(textOf), [COPY.hourlyBar, COPY.weeklyBar])
  menu.destroy()
})

/* ------------------------------ rename and remove ------------------------------ */

test('Rename turns the name into a box on the row; Save renames through the shell and Escape only closes the box', async () => {
  const fixture = fakeBridge()
  const menu = await mount(fixture)
  await menu.open()
  const row = menu.row('codex', 'work')
  rowButton(row, COPY.rename).click()
  const input = row.querySelector('.acct-rename-input')
  assert.ok(input, 'the rename box is on the row')
  assert.equal(input.value, 'work')
  assert.equal(row.querySelector('.acct-name').hidden, true)
  /* Escape closes the box, not the menu. */
  input.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() {}, stopPropagation() {} })
  assert.equal(row.querySelector('.acct-rename-input'), null)
  assert.equal(menu.panel.hidden, false, 'Escape in the box must not close the menu')
  assert.equal(row.querySelector('.acct-name').hidden, false)
  rowButton(row, COPY.rename).click()
  const box = row.querySelector('.acct-rename-input')
  box.value = 'office'
  rowButton(row, COPY.renameSave).click()
  await settle()
  assert.deepEqual(callsNamed(menu.calls, 'accountRename'), [['accountRename', { name: 'work', provider: 'codex', newName: 'office' }]])
  assert.equal(menu.out.textContent, COPY.renamed('work', 'office'))
  assert.equal(menu.out.dataset.tone, 'confirmed')
  assert.ok(menu.row('codex', 'office'), 'the list is redrawn under the new name')
  assert.equal(menu.row('codex', 'work'), null)
  menu.destroy()
})

test('Remove is armed by one press and done by the next; a refusal disarms it', async () => {
  const fixture = fakeBridge()
  const menu = await mount(fixture)
  await menu.open()
  const row = menu.row('claude', 'home')
  const button = rowButton(row, COPY.remove)
  button.click()
  await settle()
  assert.equal(callsNamed(menu.calls, 'accountRemove').length, 0, 'one press must not remove')
  assert.equal(button.textContent, COPY.removeArmed)
  assert.equal(button.dataset.armed, 'yes')
  button.click()
  await settle()
  assert.deepEqual(callsNamed(menu.calls, 'accountRemove'), [['accountRemove', { name: 'home', provider: 'claude' }]])
  assert.equal(menu.out.textContent, COPY.removed('home'))
  assert.equal(menu.out.dataset.tone, 'confirmed')
  assert.equal(menu.row('claude', 'home'), null, 'the row is gone')

  const refusing = fakeBridge(undefined, { accountRemove: async () => ({ ok: false, code: 'ACCOUNT_REGISTRY_DAMAGED', reason: 'The list of accounts on this computer cannot be read, so nothing was changed.' }) })
  const second = await mount(refusing)
  await second.open()
  const target = rowButton(second.row('codex', 'work'), COPY.remove)
  target.click()
  await settle()
  target.click()
  await settle()
  assert.equal(second.out.dataset.tone, 'refused')
  assert.equal(second.out.textContent, 'The list of accounts on this computer cannot be read, so nothing was changed.')
  assert.equal(target.dataset.armed, 'no', 'a refused removal disarms the button')
  assert.equal(target.textContent, COPY.remove)
  assert.ok(second.row('codex', 'work'), 'the row stays')
  second.destroy()
  menu.destroy()
})

/* ------------------------------ the window a ranking reads ------------------------------ */

test('the window field is offered by ranked modes only, paints the recorded window, and saves on its own', async () => {
  const menu = await mount()
  await menu.open()
  assert.equal(menu.rankField.hidden, true, '"stop and let me switch" asks no window')
  assert.equal(menu.rankHelp.hidden, true)

  menu.mode.value = 'resets-soonest'
  menu.mode.dispatchEvent({ type: 'change' })
  await settle()
  assert.equal(menu.rankField.hidden, false, 'a ranking asks which window it reads')
  assert.equal(menu.rankHelp.hidden, false)
  assert.equal(menu.rank.value, 'either', 'the recorded window is painted')

  menu.rank.value = 'weekly'
  menu.rank.dispatchEvent({ type: 'change' })
  assert.equal(menu.rank.disabled, false, 'controls remain editable while saves are queued')
  await settle()
  assert.deepEqual(callsNamed(menu.calls, 'accountPolicy').at(-1), ['accountPolicy', { rankWindow: 'weekly' }],
    'the window rides alone; no mode is re-sent with it')
  assert.equal(menu.out.textContent, COPY.rankSaved('Weekly window'))
  assert.equal(menu.out.dataset.tone, 'confirmed')
  assert.equal(menu.rank.disabled, false)
  assert.equal(menu.rank.value, 'weekly', 'the re-read list agrees with the saved window')

  menu.mode.value = 'manual'
  menu.mode.dispatchEvent({ type: 'change' })
  await settle()
  assert.equal(menu.rankField.hidden, true, 'back to a mode that reads no allowance, the window goes away')
  menu.destroy()
})

test('each program carries its own rule in its group head; "Same as above" is the recorded absence of one', async () => {
  const menu = await mount()
  await menu.open()
  const codexLabel = menu.root.querySelectorAll('.acct-group-name')[0].textContent
  const codex = menu.providerMode('codex')
  assert.ok(codex, 'a rule select per program')
  assert.equal(codex.parentElement.querySelector('.acct-field-label').textContent, COPY.providerRule(codexLabel), 'the program rule has a visible label as well as an accessible name')
  assert.equal(codex.value, 'inherit')
  assert.ok(menu.providerMode('claude') && menu.providerMode('gemini'))
  assert.equal(menu.providerRank('codex').hidden, true, 'the rule above reads no allowance, so no window is asked')
  assert.equal(menu.providerRank('codex').parentElement.hidden, true, 'an unavailable comparison field must not leave an orphan label')

  codex.value = 'resets-soonest'
  codex.dispatchEvent({ type: 'change' })
  await settle()
  assert.deepEqual(callsNamed(menu.calls, 'accountPolicy').at(-1), ['accountPolicy', { provider: 'codex', selectionMode: 'resets-soonest' }])
  assert.equal(menu.out.textContent, COPY.providerRuleSaved(codexLabel, 'Resetting soonest first'))
  assert.equal(menu.out.dataset.tone, 'confirmed')
  assert.equal(menu.providerMode('codex').value, 'resets-soonest', 'the repaint draws the recorded rule')
  assert.equal(menu.providerRank('codex').hidden, false, 'a program that ranks is asked its window')
  assert.equal(menu.providerRank('codex').parentElement.hidden, false)
  assert.equal(menu.providerMode('claude').value, 'inherit', 'the other programs still follow the rule above')
  assert.equal(menu.mode.value, 'manual', 'the rule above is untouched')

  menu.providerRank('codex').value = 'weekly'
  menu.providerRank('codex').dispatchEvent({ type: 'change' })
  await settle()
  assert.deepEqual(callsNamed(menu.calls, 'accountPolicy').at(-1), ['accountPolicy', { provider: 'codex', rankWindow: 'weekly' }])
  assert.equal(menu.providerRank('codex').value, 'weekly')
  assert.equal(menu.out.textContent, COPY.providerRuleSaved(codexLabel, 'Weekly window'))

  menu.providerMode('codex').value = 'inherit'
  menu.providerMode('codex').dispatchEvent({ type: 'change' })
  await settle()
  assert.deepEqual(callsNamed(menu.calls, 'accountPolicy').at(-1), ['accountPolicy', { provider: 'codex', selectionMode: null }],
    'clearing sends null for that one field, so the shell drops it and leaves the rest')
  assert.equal(menu.out.textContent, COPY.providerRuleSaved(codexLabel, COPY.sameAsAbove))
  assert.equal(menu.providerMode('codex').value, 'inherit')
  menu.destroy()
})

test('a refused per-program rule is put back where the file says it is', async () => {
  const fixture = fakeBridge()
  fixture.bridge.accountPolicy = async request => {
    fixture.calls.push(['accountPolicy', { ...request }])
    return { ok: false, code: 'ACCOUNT_MODE_UNSUPPORTED', reason: 'This copy does not know that mode.' }
  }
  const menu = await mount(fixture)
  await menu.open()
  const claude = menu.providerMode('claude')
  claude.value = 'even'
  claude.dispatchEvent({ type: 'change' })
  await settle()
  assert.equal(menu.out.dataset.tone, 'refused')
  assert.equal(menu.out.textContent, 'This copy does not know that mode.')
  assert.equal(menu.providerMode('claude').value, 'inherit', 'the repaint shows the recorded rule, not the refused one')
  menu.destroy()
})

test('both windows start on the single number and say they are inheriting it', async () => {
  /* The registry names one limit and neither window overrides it. Showing the
     sliders empty, or at some default of the menu's own, would be a screen
     disagreeing with what a start actually does. */
  const menu = await mount()
  await menu.open()

  assert.equal(menu.limitWeekly.value, '90')
  assert.equal(menu.limitHourly.value, '90')
  assert.equal(menu.limitWeekly.style.getPropertyValue('--fill'), `${89 / 99 * 100}%`)
  assert.equal(menu.limitHourly.style.getPropertyValue('--fill'), `${89 / 99 * 100}%`)
  assert.equal(menu.limitWeeklyFigure.textContent, `90%${' \u00b7 '}using 90% for both`)
  assert.equal(menu.limitHourlyFigure.textContent, `90%${' \u00b7 '}using 90% for both`)
  menu.destroy()
})

test('dragging a slider updates the figure and saves nothing; letting go saves that window alone', async () => {
  const menu = await mount()
  await menu.open()

  menu.limitWeekly.value = '95'
  menu.limitWeekly.dispatchEvent({ type: 'input' })
  assert.equal(menu.limitWeeklyFigure.textContent, '95%', 'the figure follows the drag')
  assert.equal(menu.limitWeekly.style.getPropertyValue('--fill'), `${94 / 99 * 100}%`, 'the colored fill follows the same declared range as the thumb')
  assert.equal(callsNamed(menu.calls, 'accountPolicy').length, 0,
    'a save per pixel would be a file write per pixel')

  menu.limitWeekly.dispatchEvent({ type: 'change' })
  assert.equal(menu.limitWeekly.disabled, false, 'controls remain editable while saves are queued')
  await settle()

  assert.deepEqual(callsNamed(menu.calls, 'accountPolicy'),
    [['accountPolicy', { exhaustedAtPercentWeekly: 95 }]],
    'only the window that moved is sent; the other keeps whatever the file says')
  assert.equal(menu.out.textContent, COPY.limitSaved('this week', 95))
  assert.equal(menu.out.dataset.tone, 'confirmed')
  assert.equal(menu.limitWeekly.disabled, false)

  /* THE OTHER WINDOW IS UNTOUCHED AND STILL SAYS SO. This is the whole point of
     two numbers: 91% of a week that refills over days is a different fact from
     91% of five hours, and the owner's own accounts sat at exactly that. */
  assert.equal(menu.limitWeekly.value, '95')
  assert.equal(menu.limitWeeklyFigure.textContent, '95%', 'a limit that was chosen no longer says it is inherited')
  assert.equal(menu.limitHourly.value, '90')
  assert.equal(menu.limitHourlyFigure.textContent, `90%${' \u00b7 '}using 90% for both`)
  menu.destroy()
})

test('a refused limit puts the slider back where the file says it is', async () => {
  const reason = 'A window limit must be a number between 1 and 100, or cleared.'
  const fixture = fakeBridge(freshState(), {
    accountPolicy: async () => ({ ok: false, code: 'ACCOUNT_WINDOW_LIMIT_INVALID', reason }),
  })
  const menu = await mount(fixture)
  await menu.open()

  menu.limitHourly.value = '40'
  menu.limitHourly.dispatchEvent({ type: 'change' })
  await settle()

  assert.equal(menu.out.textContent, reason)
  assert.equal(menu.out.dataset.tone, 'refused')
  assert.equal(menu.limitHourly.value, '90',
    'a slider left showing a limit that was refused is a screen telling somebody their computer does something it does not do')
  assert.equal(menu.limitHourly.style.getPropertyValue('--fill'), `${89 / 99 * 100}%`, 'the refused change also restores the last saved fill')
  menu.destroy()
})

test('sign-in completion discards the previous identity and allowance for only that account', async () => {
  const fixture = fakeBridge()
  fixture.state.usage.accounts.find(account => account.name === 'home').email = 'previous@example.test'
  fixture.state.usageCache = fixture.state.usage
  const menu = await mount(fixture)
  try {
    assert.ok(menu.row('claude', 'home').textContent.includes('previous@example.test'))
    rowButton(menu.row('claude', 'home'), COPY.signIn).click()
    await settle()
    fixture.state.accounts.find(account => account.name === 'home').signedIn = 'yes'
    fixture.pushSignIn({ name: 'home', provider: 'claude', signedIn: 'yes' })
    await settle()
    assert.equal(menu.out.textContent, COPY.signInSeen('home'))
    assert.equal(Boolean(rowButton(menu.row('claude', 'home'), COPY.signIn)), false,
      'the previous signed_out allowance result contradicts the completed sign-in')
    assert.deepEqual(flagsOf(menu.row('claude', 'home')), [])
    assert.equal(menu.row('claude', 'home').textContent.includes('previous@example.test'), false)
    assert.ok(menu.row('codex', 'school').textContent.includes('60%'), 'another account lost its measured allowance')
    assert.equal(callsNamed(fixture.calls, 'accountUsage').length, 0, 'sign-in change started allowance probes without a press')
    fixture.state.usage = { ok: true, accounts: [{ name: 'home', provider: 'claude', status: 'signed_out', canServe: false }] }
    menu.refresh.click()
    await settle()
    assert.ok(rowButton(menu.row('claude', 'home'), COPY.signIn), 'a new provider refusal must still offer sign-in')
  } finally { menu.destroy() }
})

test('an unknown sign-in file change also retires the old identity in the open panel', async () => {
  const fixture = fakeBridge()
  fixture.state.usage.accounts.find(account => account.name === 'home').email = 'previous@example.test'
  fixture.state.usageCache = fixture.state.usage
  const menu = await mount(fixture)
  try {
    assert.ok(menu.row('claude', 'home').textContent.includes('previous@example.test'))
    rowButton(menu.row('claude', 'home'), COPY.signIn).click()
    await settle()
    fixture.state.accounts.find(account => account.name === 'home').signedIn = 'unknown'
    fixture.pushSignIn({ name: 'home', provider: 'claude', signedIn: 'unknown' })
    await settle()
    assert.equal(menu.row('claude', 'home').textContent.includes('previous@example.test'), false,
      'the changed sign-in kept the old identity because its new state was unknown')
    assert.equal(Boolean(rowButton(menu.row('claude', 'home'), COPY.signIn)), false,
      'an unknown answer was presented as a definite sign-out')
    assert.ok(menu.row('codex', 'school').textContent.includes('60%'))
    assert.equal(callsNamed(fixture.calls, 'accountUsage').length, 0)
  } finally { menu.destroy() }
})


test('existing Antigravity registration sends its client and configuration folder without reopening sign-in', async () => {
  const state=freshState()
  const requests=[]
  const fixture=fakeBridge(state,{accountAdd:async request=>{requests.push(request);state.accounts.push({...request,signedIn:'unknown'});return{ok:true}}})
  const menu=await mount(fixture)
  try {
    await menu.open()
    menu.name.value='native Gemini'
    menu.root.querySelector('[data-acct="add-directory"]').value='/owned/agy-config'
    menu.addButtons.find(button=>button.dataset.client==='antigravity').click()
    await settle()
    assert.deepEqual(requests,[{provider:'gemini',name:'native Gemini',client:'antigravity',directory:'/owned/agy-config'}])
    assert.equal(callsNamed(menu.calls,'accountSignIn').length,0)
    assert.match(menu.out.textContent,/current OS sign-in/)
    assert(flagsOf(menu.row('gemini','native Gemini')).some(([text])=>text==='Antigravity · current OS sign-in'))
  } finally {menu.destroy()}
})

test('Grok and Antigravity rows render what their programs reported: Antigravity bars per group, Grok plan and period in words', async () => {
  const state = freshState()
  const week = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000 + 30 * 60 * 1000).toISOString()
  state.accounts.push({ name: 'Gemini current OS sign-in', provider: 'gemini', client: 'antigravity', signedIn: 'yes' },
    { name: 'Current Grok CLI', provider: 'grok', signedIn: 'yes' })
  const geminiWeek = { kind: 'weekly', usedPercent: 3.8, remainingPercent: 96.2, resetsAt: week, label: 'gemini-weekly', model: 'Gemini Models' }
  const otherWeek = { kind: 'weekly', usedPercent: 0, remainingPercent: 100, resetsAt: week, label: '3p-weekly', model: 'Claude and GPT models' }
  const grokReason = 'Grok reports this week’s usage period but not how much of it is used, so usage is not measured. The first turn checks whether it can serve.'
  state.usage.accounts.push(
    { name: 'Gemini current OS sign-in', provider: 'gemini', client: 'antigravity', status: 'healthy', canServe: true, usedPercent: 3.8,
      resetsAt: week, windows: { hourly: null, weekly: geminiWeek, weeklyWindows: [geminiWeek, otherWeek] }, reason: 'measured' },
    { name: 'Current Grok CLI', provider: 'grok', status: 'healthy', canServe: true, email: 'owner@example.test', planType: 'X Premium+',
      resetsAt: week, windows: { hourly: null, weekly: null, weeklyWindows: [] }, reason: grokReason })
  const menu = await mount(fakeBridge(state))
  try {
    await menu.open()
    await menu.check()
    const agy = menu.row('gemini', 'Gemini current OS sign-in')
    const figures = agy.querySelectorAll('.acct-bar-figure').map(textOf)
    assert.deepEqual(figures, ['96% remaining', '100% remaining'], 'the Antigravity weeks were not drawn as bars')
    assert.deepEqual(agy.querySelectorAll('.acct-bar-label').map(textOf), ['5-hour window', 'this week (Gemini Models)', 'this week (Claude and GPT models)'])
    assert.equal(agy.querySelectorAll('.acct-bar-unread').length, 1, 'only the unreported 5-hour window reads as not drawn')
    const grok = menu.row('grok', 'Current Grok CLI')
    assert.equal(grok.querySelectorAll('.acct-bars').length, 0, 'a Grok row with no figure drew a bar')
    assert.deepEqual(linesOf(grok), [grokReason, 'This period resets in 7 days.'])
    assert.equal(grok.querySelector('.acct-signin-identity').textContent, 'Signed in as owner@example.test.')
    assert.equal(grok.querySelector('.acct-plan').textContent, 'Plan: X Premium+.')
  } finally { menu.destroy() }
})


test('the account header shows a measured percentage when only one provider is active', async () => {
  const fixture = fakeBridge()
  fixture.state.activeByProvider = { codex: 'school', claude: null, gemini: null }
  const menu = await mount(fixture)
  try {
    await menu.open(); await menu.check()
    assert.equal(menu.label.textContent, `school · ${COPY.roomLeft(60)}`)
  } finally { menu.destroy() }
})

/* ---------------------- the default that is not what runs (T378) ---------------------- */

/* MEASURED 2026-09-18 (ledger T378): 18 of the last 30 starts landed on one
   account while this menu read Rotate. Nothing was broken -- Claude carried a
   "Dynamic" rule of its own, which by design outranks the rule above, and
   Dynamic drains one account while there is room. What the person was never
   told is WHICH programs were not following the default they had just chosen.
   These two checks are the notice that tells them, and the one action that
   acts on it. */

test('the notice names every program not following the default, in the copy table\'s words, and writes nothing by drawing (T378)', async () => {
  const state = freshState()
  state.mode = 'rotate'
  /* TWO programs with a rule of their own, not one: a notice that named only
     the first would read as complete while leaving a program off the list. */
  state.byProvider = { claude: { selectionMode: 'dynamic' }, codex: { selectionMode: 'manual' } }
  const menu = await mount(fakeBridge(state))
  await menu.open()

  assert.equal(menu.overrideNotice.hidden, false, 'two programs carry a rule of their own and neither was named')
  assert.equal(
    menu.overrideNoticeText.textContent,
    COPY.overrideNotice(`${providerLabel('codex')} and ${providerLabel('claude')}`, 2, 'Rotate'),
    'the notice must name both programs and the default they are not following')
  /* EVERY WORD COMES FROM THE COPY TABLES. A raw provider key on the owner's
     screen is breakage a cut ships silently, so the rendered sentence is
     checked against the labels rather than against the ids. */
  for (const id of ['codex', 'claude']) {
    assert.ok(menu.overrideNoticeText.textContent.includes(providerLabel(id)), `${id} is not named by its label`)
  }
  assert.equal(menu.overrideApply.textContent, COPY.overrideNoticeApply, 'the action is labelled from the copy table')

  /* READ-ONLY. Drawing it is not a write, and it did not disturb either rule. */
  assert.deepEqual(callsNamed(menu.calls, 'accountPolicy'), [], 'drawing the notice wrote a policy')
  assert.equal(menu.state.byProvider.claude.selectionMode, 'dynamic')
  assert.equal(menu.state.byProvider.codex.selectionMode, 'manual')
  assert.equal(menu.mode.value, 'rotate', 'the rule above is untouched by the notice')

  menu.destroy()
})

test('a default every program already follows draws no notice at all (T378)', async () => {
  const state = freshState()
  state.mode = 'rotate'
  state.byProvider = {}
  const menu = await mount(fakeBridge(state))
  await menu.open()
  assert.equal(menu.overrideNotice.hidden, true, 'nothing overrides the default, so there is nothing to say')
  assert.equal(callsNamed(menu.calls, 'accountPolicy').length, 0)
  menu.destroy()
})

test('"Apply the default to these programs" drops BOTH named rules on the click, leaves an unnamed program and a non-mode field alone, and writes only when pressed (T378)', async () => {
  const state = freshState()
  state.mode = 'rotate'
  /* Codex also carries a window of its own. A window is not a mode: it shapes
     a ranking and cannot decide which mode runs, so this action must not
     reach it. Gemini carries nothing and is never named. */
  state.byProvider = {
    claude: { selectionMode: 'dynamic' },
    codex: { selectionMode: 'manual', rankWindow: 'weekly' },
  }
  const menu = await mount(fakeBridge(state))
  await menu.open()
  assert.equal(menu.overrideNotice.hidden, false)
  /* NOTHING IS WRITTEN UNTIL THE PERSON CLICKS. */
  assert.deepEqual(callsNamed(menu.calls, 'accountPolicy'), [], 'a policy was written before any click')

  menu.overrideApply.click()
  await settle()

  const writes = callsNamed(menu.calls, 'accountPolicy').map(([, request]) => request)
  assert.equal(writes.length, 2, `one write per named program, got ${writes.length}: ${JSON.stringify(writes)}`)
  /* The same request the per-program "Use default" already sends: scoped, and
     null for the mode. Not a second route for clearing a rule. */
  assert.deepEqual(
    [...writes].sort((a, b) => a.provider.localeCompare(b.provider)),
    [{ provider: 'claude', selectionMode: null }, { provider: 'codex', selectionMode: null }])

  /* BOTH programs, checked in the shell's own state -- the SECOND as well as
     the first, because a clearing bug that skips one entry and eats the rest
     passes a one-program check. */
  assert.equal(menu.state.byProvider.claude.selectionMode, undefined, 'the first named program kept its own mode')
  assert.equal(menu.state.byProvider.codex.selectionMode, undefined, 'the second named program kept its own mode')
  assert.equal(menu.state.byProvider.codex.rankWindow, 'weekly', 'the action reached a field that is not a mode')
  assert.equal(writes.some(request => request.provider === 'gemini'), false, 'a program the notice never named was written')

  /* REDRAWN FROM WHAT CAME BACK, not from what the click assumed. */
  assert.equal(menu.overrideNotice.hidden, true, 'nothing overrides the default now, so the notice is gone')
  assert.equal(menu.providerMode('claude').value, 'inherit')
  assert.equal(menu.providerMode('codex').value, 'inherit')
  assert.equal(menu.mode.value, 'rotate', 'the rule above is untouched by the action')

  menu.destroy()
})

/* T1588: an address that names the Accounts menu opens it on arrival. */
test('the menu opens itself when the page was reached through the Accounts menu address', async () => {
  const priorLocation = globalThis.location
  try {
    globalThis.location = { hash: '#/computers' }
    const closed = await mount()
    try {
      await settle()
      assert.equal(closed.root.querySelector('.acct-menu').hidden, true, 'a plain Computers address opened the menu')
    } finally { closed.destroy() }
    globalThis.location = { hash: '#/computers?accounts=open' }
    const menu = await mount()
    try {
      await settle()
      assert.equal(menu.root.querySelector('.acct-menu').hidden, false, 'the Accounts menu address did not open the menu')
      assert.equal(menu.trigger.getAttribute('aria-expanded'), 'true')
    } finally { menu.destroy() }
  } finally {
    if (priorLocation === undefined) delete globalThis.location
    else globalThis.location = priorLocation
  }
})
