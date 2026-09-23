/* THE WORDS ON THE ACCOUNTS PANEL, AND THE WARNING THAT HAS TO SHIP WITH IT.
 *
 * WHY THE WARNING GETS A SUITE OF ITS OWN. The legal position on running Claude
 * from a shipped product dropped every cap and every restriction: the person
 * decides. The four-point warning is the ONLY instrument standing in place of
 * those restrictions, which makes it a shipped obligation rather than a nicety.
 * It fails in three ways worth a test, and all three are quiet:
 *
 *   1. IT GOES MISSING. Somebody moves it behind the asynchronous read, and it
 *      disappears on exactly the machines where the read does not answer.
 *   2. IT TURNS INTO BOILERPLATE. The four specifics are replaced by one
 *      sentence about "usage limits", which warns nobody of anything.
 *   3. IT OFFERS A DOOR THAT IS NOT THERE. The position says to name key-based
 *      sign-in as the alternative. This build does not carry that transport, and
 *      a screen that offered it would be untrue -- which is a worse failure than
 *      the one the warning exists to prevent.
 *
 * Run: node --test tools/test/account-panel-copy.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire, register } from 'node:module'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import os from 'node:os'

import {
  ACCOUNT_PANEL,
  CLAUDE_ACCOUNT_RISK,
  PROVIDER_SIGN_IN,
  accountPanelCopy,
  providerSignInCopy,
} from '../../src/account-panel-copy.js'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const require = createRequire(import.meta.url)
const PRELOAD = path.join(REPO, 'shell', 'fleet-profile-preload.cjs')
const MAIN = path.join(REPO, 'shell', 'main.cjs')

/* Node does not give stylesheet imports meaning. The view itself otherwise
   imports under bare Node, so make CSS a no-op and exercise the renderer. */
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

// The provider panels moved into the Settings section module (2026-09-10); the factory paints the same markup.
const { createThisComputerSettings: guideView } = await import('../../src/this-computer-settings.js')

function renderGuide(bridge = {}) {
  let markup = ''
  const panels = ['Codex', 'Claude', 'Gemini'].map(program => ({
    dataset: { accountsProvider: program.toLowerCase(), accountsProgram: program },
    hidden: true,
    innerHTML: '',
  }))
  const root = {
    isConnected: true,
    dataset: {}, // a real element carries one; the section stamps its released flag on it
    querySelector: () => null,
    querySelectorAll: selector => selector === '.guide-accounts-panel' ? panels : [],
  }
  const priorDocument = globalThis.document
  const priorWindow = globalThis.window
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, 'template')
      return {
        // The section paints two templates (programs, then the feedback door); keep both, as a page would.
        set innerHTML(value) { markup += value },
        content: { firstElementChild: root },
      }
    },
  }
  globalThis.window = { mcProviders: bridge }
  try {
    const view = guideView()
    return { ...view, markup, panels }
  } finally {
    if (priorDocument === undefined) delete globalThis.document
    else globalThis.document = priorDocument
    if (priorWindow === undefined) delete globalThis.window
    else globalThis.window = priorWindow
  }
}

function everyPanelSentence() {
  return Object.values(ACCOUNT_PANEL)
    .map(value => (typeof value === 'function' ? value(value === PROVIDER_SIGN_IN.copyLine ? { version: '1.2.3', who: 'installed by its maker', copies: 2 } : 'Codex') : value))
    .filter(value => typeof value === 'string')
}

/* ------------------------------------------------------------------
   1. The four specifics, in the order they matter.
   ------------------------------------------------------------------ */

test('the warning carries four points and not a paragraph', () => {
  assert.equal(CLAUDE_ACCOUNT_RISK.points.length, 4)
  for (const point of CLAUDE_ACCOUNT_RISK.points) {
    assert.equal(typeof point, 'string')
    assert.ok(point.trim().length > 30, `"${point}" is too short to be one of the four specifics`)
  }
})

test('whose account carries the consequence is said FIRST', () => {
  /* The order is the argument. A person is being asked to accept a risk on
     their own account, so the first thing they read must be that it is their
     account -- not ours, and not the product's. */
  const first = CLAUDE_ACCOUNT_RISK.points[0].toLowerCase()
  assert.match(first, /your own account/, 'the first point does not name the reader\'s own account')
  assert.match(first, /not on ours/, 'the first point does not say the risk is not ours')

  const later = CLAUDE_ACCOUNT_RISK.points.slice(1).join(' ').toLowerCase()
  assert.ok(!later.includes('your own account'), 'the point that must come first is repeated later instead')
})

test('the provider being able to change this without notice is point two', () => {
  const second = CLAUDE_ACCOUNT_RISK.points[1].toLowerCase()
  assert.match(second, /anthropic/, 'the second point does not name who can change it')
  assert.match(second, /change|shut it off|block/, 'the second point does not say it can be changed or stopped')
  assert.match(second, /tell you first|without notice|any time/, 'the second point does not say it can happen unannounced')
})

test('point three says volume is the signal, not the program', () => {
  /* The finding this is drawn from: the classifier keys on request velocity and
     not on third-party software -- it false-positived on the provider's own
     tool. So a person who reads "do not use this product" has been misinformed;
     what they can act on is how much they run. */
  const third = CLAUDE_ACCOUNT_RISK.points[2].toLowerCase()
  assert.match(third, /how much you run|volume/, 'the third point does not name volume as the signal')
  assert.match(third, /signal/, 'the third point does not say what the signal is')
  assert.match(third, /heavy|unattended/, 'the third point does not say what heavy use looks like')
})

test('point four names the one correlation a person can actually avoid', () => {
  const fourth = CLAUDE_ACCOUNT_RISK.points[3].toLowerCase()
  assert.match(fourth, /plan/, 'the fourth point does not mention changing a plan')
  assert.match(fourth, /automation|running/, 'the fourth point does not mention running automation at the time')
  assert.match(fourth, /payment|plan change/, 'the fourth point does not say what the reported blocks followed')
})

test('the alternative offered is one this build really has', () => {
  /* THE DELIBERATE DEPARTURE FROM THE ADVICE, and it is recorded here rather
     than only in a report. The position says to name key-based sign-in in the
     same breath. That transport is not in this build. Naming it would put a door
     on screen with nothing behind it, so the alternative named is the one that
     exists today: do the work by hand, outside this window. */
  const today = CLAUDE_ACCOUNT_RISK.today.toLowerCase()
  for (const absent of ['api key', 'api-key', 'your key', 'a key instead', 'console']) {
    assert.ok(!today.includes(absent), `the warning offers "${absent}", which this build does not carry`)
  }
  assert.match(today, /by hand|outside this window/, 'the warning names no alternative at all')
})

/* ------------------------------------------------------------------
   2. What the panel may never say.
   ------------------------------------------------------------------ */

test('no copy on this surface uses the provider\'s product name for its tool', () => {
  /* A written branding rule, independent of how anything authenticates: the
     product is not named on our screens and its look is not imitated. */
  const prose = [...everyPanelSentence(), ...CLAUDE_ACCOUNT_RISK.points, CLAUDE_ACCOUNT_RISK.today, CLAUDE_ACCOUNT_RISK.heading]
  for (const sentence of prose) {
    assert.ok(!/claude\s*code/i.test(sentence), `"${sentence}" names the provider's own tool`)
  }
})

test('the panel never asks a person for a credential', () => {
  /* The same list tools/test/first-run-needs.test.mjs holds the shared copy to.
     This is the screen where somebody is most primed to hand a key over, so it
     is the screen that must never have a field for one. */
  const prose = [...everyPanelSentence(), CLAUDE_ACCOUNT_RISK.today].join(' ').toLowerCase()
  for (const ask of ['paste your', 'enter your key', 'api key here', 'copy your token', 'your password']) {
    assert.ok(!prose.includes(ask), `the panel asks for a credential: "${ask}"`)
  }
})

test('an empty list reads as a working computer, not as a fault', () => {
  /* Almost everybody has exactly one sign-in. That is a complete setup, and a
     screen that greets it with a failure has invented a problem. */
  const none = ACCOUNT_PANEL.none.toLowerCase()
  for (const alarming of ['error', 'failed', 'missing', 'not found', 'problem', 'invalid']) {
    assert.ok(!none.includes(alarming), `the empty state reads as a fault: "${alarming}"`)
  }
  assert.match(none, /one sign-in already on this computer/, 'the empty state does not say what IS being used')
  assert.match(none, /add a name and a folder/, 'the empty state does not say how to add another')
})

test('the empty account panel names the reader\'s actual computer', () => {
  assert.equal(accountPanelCopy().none, ACCOUNT_PANEL.none)
  assert.equal(accountPanelCopy({ viaRelay: true }).none,
    'Nothing is listed on the computer you are driving, so that copy uses the one sign-in already there. Add a name and a folder below to keep a second account.')
})

/* ------------------------------------------------------------------
   3. Where the words are drawn, which decides whether they ship.
   ------------------------------------------------------------------ */

test('the panel draws every warning point', () => {
  const { markup } = renderGuide()
  for (const point of CLAUDE_ACCOUNT_RISK.points) {
    assert.ok(markup.includes(point), `the guide does not render the warning point: "${point}"`)
  }
})

test('the warning is drawn with the page and not by the read that can fail', () => {
  /* THE FAILURE THIS CATCHES IS THE WHOLE REASON THE FILE IS ARRANGED AS IT IS.
     fillAccounts() degrades silently -- no bridge, a plain browser, a read that
     never answers -- and a warning inside it would be absent on exactly those
     machines. So it must be built by the static markup, beside the commands. */
  const { markup } = renderGuide({
    accounts: () => new Promise(() => {}),
    presence: () => new Promise(() => {}),
  })
  for (const point of CLAUDE_ACCOUNT_RISK.points) {
    assert.ok(markup.includes(point), `the warning disappeared while the machine read was pending: "${point}"`)
  }
})

/* THIS TEST USED TO PIN THE DEFECT IT WAS GUARDING AGAINST.
 *
 * It required the source to contain literally `window.mcProviders?.accounts()`
 * and a bare `catch { return }`. That first pattern is the object-only optional
 * chain -- the optional mark sits on the OBJECT and not on the VERB -- so when
 * the bridge exists without the verb, `bridge.accounts` is undefined and
 * `undefined()` throws a TypeError inside the async handler BEFORE any `.catch`
 * is reached. It was one of the six sites in the renderer-wide sweep of that
 * shape, and the sweep is what turned this assertion red.
 *
 * So the test was pinning the SPELLING of an implementation, and a correct fix
 * broke it. That is the second time in one pass; the other was the a11y refusal
 * table. The property this test actually exists to protect is in its own title:
 * an unreachable bridge must not leave dead controls on the page. That property
 * is now MORE true, not less -- so the assertions below check the behaviour and
 * deliberately do NOT check how it is spelled.
 *
 * The renderer is imported below with a document/window stand-in. That makes
 * the absent-bridge path observable at its panel output: every provider states
 * the unreadable outcome and paints nothing pressable.
 */
test('an absent bridge leaves the page as it was, with no dead controls', () => {
  const { panels } = renderGuide()
  for (const panel of panels) {
    assert.equal(panel.hidden, false, `${panel.dataset.accountsProgram} does not state that its accounts cannot be read`)
    assert.ok(panel.innerHTML.includes(ACCOUNT_PANEL.unreadable),
      `${panel.dataset.accountsProgram} does not state the unreadable outcome`)
    assert.doesNotMatch(panel.innerHTML, /<button|ctl-btn|role="button"/,
      `${panel.dataset.accountsProgram} paints a control that cannot work`)
  }
})

/* ------------------------------------------------------------------
   4. The channel, and the check every agent channel opens with.
   ------------------------------------------------------------------ */

test('the account calls are on the bridge, and the login arrows are the recorded exception', () => {
  const source = readFileSync(PRELOAD, 'utf8')
  const bridge = source.slice(source.indexOf("exposeInMainWorld('mcProviders'"))
  const end = bridge.indexOf('}))')
  const body = bridge.slice(0, end)
  assert.match(body, /accounts: \(\) => ipcRenderer\.invoke\('mc-accounts:list'\)/)
  assert.match(body, /accountAdd: request => ipcRenderer\.invoke\('mc-accounts:add', request\)/)
  assert.match(body, /accountRemove: request => ipcRenderer\.invoke\('mc-accounts:remove', request\)/)
  /* The login arrows joined the bridge on 2026-08-19, and they are NOT the
     signIn() whose absence used to be asserted here: installStart() runs the
     provider's OWN official install, whose stdin is closed and whose files are
     never read, and loginStart() asks for a terminal WINDOW that this product
     hands nothing and reads nothing from. So no credential can cross this
     bridge in either direction. What stays banned is any call shaped like the
     product handling one itself. */
  assert.match(body, /loginStart: request => ipcRenderer\.invoke\('mc-provider-login:start', request\)/)
  assert.match(body, /loginStop: request => ipcRenderer\.invoke\('mc-provider-login:stop', request\)/)
  assert.match(body, /installStart: request => ipcRenderer\.invoke\('mc-provider-login:install', request\)/)
  /* THE ACCOUNTS MENU'S ARROWS, on the same bridge and under the same rule:
     a name and a program go out, and names, folders, percentages and a yes/no
     come back. accountSignIn() is the menu's own route to the SAME terminal
     window loginStart() opens, with the listed account's folder set as the
     program's home -- not a second sign-in path. */
  assert.match(body, /accountSwitch: request => ipcRenderer\.invoke\('mc-accounts:switch', request\)/)
  assert.match(body, /accountPolicy: request => ipcRenderer\.invoke\('mc-accounts:policy', request\)/)
  assert.match(body, /accountUsage: \(\) => ipcRenderer\.invoke\('mc-accounts:usage'\)/)
  assert.match(body, /accountAddManaged: request => ipcRenderer\.invoke\('mc-accounts:add-managed', request\)/)
  assert.match(body, /accountSignIn: request => ipcRenderer\.invoke\('mc-accounts:sign-in', request\)/)
  /* And the arrow that used to fetch a captured sign-in link is gone with the
     channel behind it; the window opens the page itself. */
  assert.ok(!/loginOpenUrl/.test(body), 'the open-the-page arrow came back')
  assert.ok(!/credential|token|password|apiKey|secret/i.test(body), 'a credential-shaped call appeared on the bridge')
})

test('every account channel opens with the sender check', () => {
  /* `add` writes the file that decides which sign-in the next agent runs on. A
     frame that could reach it could point somebody's agent at an account they
     never chose, so the same test every other agent channel applies is not a
     formality here. `switch` and `policy` write the same decision; `add-managed`
     makes a folder and records it; `sign-in` opens a window with that folder
     as the program's home. None of them may be reachable from a frame that is
     not the application's own. */
  const source = readFileSync(MAIN, 'utf8')
  for (const channel of [
    'mc-accounts:list', 'mc-accounts:add', 'mc-accounts:remove',
    'mc-accounts:policy', 'mc-accounts:switch', 'mc-accounts:usage',
    'mc-accounts:add-managed', 'mc-accounts:sign-in', 'mc-accounts:add-cloud',
  ]) {
    const at = source.indexOf(`ipcMain.handle('${channel}'`)
    assert.ok(at > 0, `${channel} is not registered`)
    const opening = source.slice(at, at + 220)
    assert.match(opening, /assertTrustedAgentSender\(event\)/, `${channel} does not check its sender first`)
  }
  /* And every one that takes a payload bounds it: the allowed keys are named
     and every string is length-checked before anything reads it. */
  for (const [channel, keys] of [
    ['mc-accounts:policy', "[\n      'selectionMode', 'reservePercent', 'rankWindow',\n      'autoRecoverOnLimit',\n      'exhaustedAtPercentHourly', 'exhaustedAtPercentWeekly',\n      'provider'\n    ]"],
    ['mc-accounts:switch', "['name', 'provider']"],
    ['mc-accounts:add-managed', "['provider', 'name', 'client']"],
    ['mc-accounts:sign-in', "['name', 'provider']"],
  ]) {
    const at = source.indexOf(`ipcMain.handle('${channel}'`)
    const handler = source.slice(at, source.indexOf('\n})\n', at))
    assert.ok(handler.includes(`agentPayload(value, ${keys})`), `${channel} does not bound its payload to ${keys}`)
    assert.match(handler, /boundedAgentString\(/, `${channel} reads a string without bounding it`)
    if (channel === 'mc-accounts:add-managed') {
      // 9b52925a: an Antigravity account names its client; that key is bounded like the others.
      assert.match(handler, /boundedAgentString\(payload\.client, 'client', 32\)/, `${channel} reads its client without bounding it`)
    }
  }
})

/* Exercise the actual policy handler and its payload helpers without starting
   Electron, opening a provider window or writing a real account registry. The
   sender and store seams record admission order; the production allowlist and
   request construction run unchanged. */
function policyChannelFixture() {
  const source = readFileSync(MAIN, 'utf8')
  const from = source.indexOf("ipcMain.handle('mc-accounts:policy'")
  const until = source.indexOf("ipcMain.handle('mc-accounts:switch'", from)
  assert.ok(from >= 0 && until > from)
  const helpers = source.slice(source.indexOf('function agentIpcError('), source.indexOf('function parseAgentStart('))
  const accountAnswer = source.slice(source.indexOf('function accountAnswer('), source.indexOf('/* WHICH ACCOUNT THIS COMPUTER PICKS'))
  assert.ok(helpers && accountAnswer)
  const trusted = {}
  const calls = []
  let handler
  const context = {
    ipcMain: { handle(channel, callback) {
      assert.equal(channel, 'mc-accounts:policy')
      handler = callback
    } },
    assertTrustedAgentSender(event) {
      calls.push({ kind: 'sender' })
      if (event !== trusted) throw Object.assign(new Error('untrusted sender'), { code: 'TEST_UNTRUSTED_SENDER' })
    },
    accountRegistry: { setPolicy(request) {
      calls.push({ kind: 'store', request: { ...request } })
      return { ok: true }
    } },
    agentHost: { offerPendingAccountRecoveries() { calls.push({ kind: 'offer-recovery' }) } },
  }
  vm.runInNewContext(`${helpers}\n${accountAnswer}\n${source.slice(from, until)}`, context, { filename: MAIN })
  assert.equal(typeof handler, 'function')
  return { trusted, calls, handler }
}

test('the policy channel carries the existing explicit recovery option without inventing consent', () => {
  for (const request of [{ autoRecoverOnLimit: true }, { autoRecoverOnLimit: false }, {}]) {
    const { handler, trusted, calls } = policyChannelFixture()
    assert.deepEqual(handler(trusted, request), { ok: true })
    assert.deepEqual(calls.filter(call => call.kind === 'store').map(call => call.request), [request])
    assert.equal(calls.filter(call => call.kind === 'offer-recovery').length, request.autoRecoverOnLimit === true ? 1 : 0)
    assert.equal(calls[0].kind, 'sender')
  }
})

test('the policy channel still refuses unknown fields and oversized strings before the store', () => {
  for (const request of [
    { autoRecoverOnLimit: true, unrecognized: 'field' },
    { provider: 'x'.repeat(33) },
    { selectionMode: 'x'.repeat(33) },
    { rankWindow: 'x'.repeat(17) },
    null, [], 'not-an-object',
  ]) {
    const { handler, trusted, calls } = policyChannelFixture()
    assert.throws(() => handler(trusted, request), error =>
      error.code === 'MC_AGENT_INVALID_PAYLOAD' && error.message === 'MC_AGENT_INVALID_PAYLOAD')
    assert.deepEqual(calls.map(call => call.kind), ['sender'])
  }
})

test('an untrusted policy sender is refused before reading any payload property', () => {
  const { handler, calls } = policyChannelFixture()
  let read = false
  const request = { get autoRecoverOnLimit() { read = true; throw new Error('payload read') } }
  assert.throws(() => handler({}, request), error => error.code === 'TEST_UNTRUSTED_SENDER')
  assert.equal(read, false)
  assert.deepEqual(calls.map(call => call.kind), ['sender'])
})

/* ------------------------------------------------------------------
   5. The sign-in button's words and wiring, added for the first
      external user, who was stuck exactly where the owner predicted:
      the guide's commands, followed by hand, in a window whose PATH
      predated the install. The button starts the provider's own login
      program instead, so these words carry the same obligations the
      account panel's do -- honest when disabled, and never a sentence
      that reads as this product handling a sign-in itself.
   ------------------------------------------------------------------ */

test('every sign-in sentence is real prose and none asks for a credential', () => {
  const sentences = Object.values(PROVIDER_SIGN_IN)
    .map(value => (typeof value === 'function' ? value(value === PROVIDER_SIGN_IN.copyLine ? { version: '1.2.3', who: 'installed by its maker', copies: 2 } : 'Codex') : value))
    .filter(value => typeof value === 'string')
  assert.ok(sentences.length >= 10, 'the sign-in copy lost sentences')
  for (const sentence of sentences) {
    assert.ok(sentence.trim().length > 0, 'an empty sign-in sentence would draw as a blank control')
    assert.ok(!/enter your|paste your|type your/i.test(sentence),
      `a sign-in sentence asks the person to hand something over: "${sentence}"`)
  }
})

test('the disabled states are honest: absence offers the install, uncertainty says so', () => {
  const absent = PROVIDER_SIGN_IN.absent('Codex')
  assert.match(absent, /not on this computer/i)
  const unsure = PROVIDER_SIGN_IN.unsure('Codex')
  assert.match(unsure, /could not tell/i, 'uncertainty is being rounded to an answer')
})

test('provider absence names the reader\'s actual computer', () => {
  assert.equal(providerSignInCopy().absent('Codex'), PROVIDER_SIGN_IN.absent('Codex'))
  assert.equal(providerSignInCopy({ viaRelay: true }).absent('Codex'),
    'Codex is not on the computer you are driving yet. Press Install, and then Sign in.')
})

test('the install words say whose bytes they are, because they are not ours', () => {
  /* The legal record REQ-engine-bundle-provider-clis.md: Claude Code cannot be
     bundled (no redistribution grant) and Codex is not bundled by decision, so
     the button's one-click is a FETCH by the person's own machine from the
     provider's own channel. The sentence must carry that, or the button reads
     as this product shipping a program it has no licence to ship. */
  const lead = PROVIDER_SIGN_IN.installLead('Codex')
  assert.match(lead, /maker's own channel/i, 'the install lead does not say where the program comes from')
  assert.match(lead, /does not ship/i, 'the install lead does not say ToolsEnabled ships nothing')
  assert.match(PROVIDER_SIGN_IN.installButton('Codex'), /Install Codex/)
  assert.match(PROVIDER_SIGN_IN.installDoneFail, /press the button/i, 'a failed install leaves no way on')
})

test('the guide draws the button from this module, gated and hidden until proven', () => {
  let released = false
  const { markup, destroy } = renderGuide({
    accounts: () => new Promise(() => {}),
    presence: () => new Promise(() => {}),
    onLoginEvent: () => () => { released = true },
  })
  /* The slot ships hidden and only a real presence answer fills it, the same
     rule the account panel holds to. */
  for (const program of ['Codex', 'Claude', 'Gemini']) {
    assert.ok(markup.includes(`data-signin-program="${program}" hidden`), `${program}'s sign-in slot no longer starts hidden`)
  }
  /* ALL THREE, and that is the owner's instruction of 2026-08-22 in one line.
     It was codex and claude while the sign-in was a hidden child, because
     gemini has no sign-in subcommand for a hidden child to run. It is a
     terminal window now, and gemini's sign-in is simply running the program --
     which a window does perfectly well. */
  /* Leaving the page must detach the stream listener. */
  destroy()
  assert.equal(released, true, 'destroy() no longer releases the login stream')
})

test('every login channel opens with the sender check', () => {
  const source = readFileSync(MAIN, 'utf8')
  for (const channel of ['mc-provider-login:start', 'mc-provider-login:stop', 'mc-provider-login:install']) {
    const at = source.indexOf(`ipcMain.handle('${channel}'`)
    assert.ok(at > 0, `${channel} is not registered`)
    const opening = source.slice(at, at + 220)
    assert.match(opening, /assertTrustedAgentSender\(event\)/, `${channel} does not check its sender first`)
  }
  /* THE OPEN-THE-PAGE CHANNEL IS GONE, AND ITS ABSENCE IS NOW THE ASSERTION.
     It existed to hand a person the https line a hidden sign-in had printed,
     because a hidden sign-in gave them nowhere else to see it. The sign-in has
     a window of its own now: the program prints its line there and opens the
     browser itself. A second route to the same page from this side would be
     the two-paths-for-one-thing the owner ruled out, and it would put a
     shell-captured URL back into a renderer's reach for no gain at all. */
  assert.equal(source.indexOf("ipcMain.handle('mc-provider-login:open-url'"), -1,
    'the open-the-page channel came back; the sign-in window already opens it')
  assert.ok(!source.includes('providerLoginService.lastUrl'),
    'the shell is capturing sign-in links again')
})

function terminalOpenerFixture(spawnChildProcess, extra = {}) {
  const source = readFileSync(MAIN, 'utf8')
  const start = source.indexOf('function openTerminalWindow(')
  const body = source.slice(start, source.indexOf('/* THE LOCAL-MODEL READER', start))
  const helper = source.slice(source.indexOf('const LIBUV_WILL_QUOTE'), start)
  const context = {
    windowTitleIsSafe: require(path.join(REPO, 'shell', 'provider-login.cjs')).windowTitleIsSafe,
    PROVIDER_ISOLATION_REQUESTED: false, TERMINAL_WINDOW_IS_THE_POINT: false,
    spawnChildProcess, setTimeout, clearTimeout, ...extra,
  }
  vm.runInNewContext(`${helper}; ${body}`, context)
  return context
}

for (const kind of ['windows-terminal', 'command-prompt']) {
  test(`${kind} asynchronous spawn failure is handled and reaches the login caller`, async () => {
    const child = new EventEmitter()
    child.unref = () => {}
    const context = terminalOpenerFixture(() => child)
    const { createProviderLoginService } = require(path.join(REPO, 'shell', 'provider-login.cjs'))
    const files = new Set(['c:/windows/system32/cmd.exe', 'c:/apps/codex.exe',
      ...(kind === 'windows-terminal' ? ['c:/local/microsoft/windowsapps/wt.exe'] : [])])
    const statSync = file => {
      if (files.has(String(file).replace(/\\/g, '/').toLowerCase())) return { isFile: () => true }
      throw Object.assign(new Error('missing fixture executable'), { code: 'ENOENT' })
    }
    const service = createProviderLoginService({ platform: 'win32',
      env: { SystemRoot: 'C:/Windows', LOCALAPPDATA: 'C:/local', PATH: 'C:/apps', PATHEXT: '.EXE' },
      statSync, lstatSync: statSync, spawnHidden: () => assert.fail('No provider execution'),
      providerSpawnRefused: () => false, openTerminal: context.openTerminalWindow,
    })
    const result = service.start('codex')
    const unhandled = await new Promise(resolve => setImmediate(() => {
      try { child.emit('error', new Error('EACCES: private fixture path')); resolve(false) }
      catch { resolve(true) }
    }))
    const answer = await result
    assert.deepEqual({ unhandled, ok: answer.ok, code: answer.code },
      { unhandled: false, ok: false, code: 'PROVIDER_LOGIN_SPAWN_FAILED' })
    assert.equal(JSON.stringify(answer).includes('private fixture path'), false)
    assert.doesNotThrow(() => child.emit('error', new Error('late failure')))
  })
}

test('terminal spawn acknowledgement is bounded and retains error handling after settlement', async () => {
  for (const kind of ['windows-terminal', 'command-prompt', 'linux-xterm']) {
    for (const event of ['spawn', 'error', 'exit', 'timeout']) {
      const child = new EventEmitter()
      child.unref = () => {}
      child.kill = () => assert.fail('An unconfirmed user window must not be killed or retried')
      const timers = new Map()
      const context = terminalOpenerFixture(() => child, {
        PROVIDER_ISOLATION_REQUESTED: true,
        setTimeout: (fn, ms) => { assert.equal(ms, 10000); const timer = {}; timers.set(timer, fn); return timer },
        clearTimeout: timer => timers.delete(timer),
      })
      const pending = context.openTerminalWindow('fixture-terminal', [], { kind, env: { USERPROFILE: '/private/fixture' } })
      assert.equal(typeof pending?.then, 'function', `${kind} must await a launch acknowledgement`)
      let settled = false
      pending.then(() => { settled = true }, () => { settled = true })
      await Promise.resolve()
      assert.equal(settled, false)
      if (event === 'timeout') [...timers.values()][0]()
      else child.emit(event, event === 'error' ? new Error('fixture') : 1)
      if (event === 'spawn') await pending
      else await assert.rejects(pending, /PROVIDER_LOGIN_TERMINAL_UNCONFIRMED/)
      assert.equal(timers.size, 0)
      assert.doesNotThrow(() => child.emit('error', new Error('late fixture')))
      child.emit('spawn')
      child.emit('exit', 1)
    }
  }
})

test('a real missing terminal executable refuses without an uncaught process error', () => {
  const source = readFileSync(MAIN, 'utf8')
  const at = source.indexOf('function openTerminalWindow(')
  const body = source.slice(at, source.indexOf('/* THE LOCAL-MODEL READER', at))
  const missing = path.join(os.tmpdir(), `toolsenabled-missing-terminal-${randomUUID()}`)
  const script = `const {spawn:spawnChildProcess}=require('node:child_process');
const PROVIDER_ISOLATION_REQUESTED=false,TERMINAL_WINDOW_IS_THE_POINT=false;
process.on('uncaughtException',error=>{process.stderr.write('UNHANDLED:'+error.code);process.exitCode=88});
${body}
Promise.resolve(openTerminalWindow(${JSON.stringify(missing)},[],{kind:'windows-terminal',env:{}})).then(
()=>{process.stderr.write('INCORRECT_OPENED_CLAIM');process.exitCode=89},
error=>{if(error.message!=='PROVIDER_LOGIN_TERMINAL_UNCONFIRMED')throw error;process.stdout.write('REFUSED_WITHOUT_FATAL')});`
  const actual = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 20000,
    shell: false, windowsHide: true, maxBuffer: 65536 })
  assert.equal(actual.status, 0, actual.stderr)
  assert.equal(actual.stdout, 'REFUSED_WITHOUT_FATAL')
  assert.equal(actual.stderr, '')
})

test('the sign-in terminal keeps provider output private and only GNOME client diagnostics are piped', async () => {
  /* The whole point of the change: the person gets a real terminal window and
     finishes the sign-in in it. What must stay true is that this product hands
     that window no input and reads no provider output. GNOME's separate
     launcher client needs a bounded diagnostic check because it can return
     zero when window creation fails. The window remains user-owned. */
  const source = readFileSync(MAIN, 'utf8')
  const at = source.indexOf('function openTerminalWindow(')
  assert.ok(at > 0, 'the shell no longer opens a terminal for the sign-in')
  const body = source.slice(at, source.indexOf('/* THE LOCAL-MODEL READER', at))
  assert.match(body, /const gnome = kind === 'linux-gnome-terminal'/)
  assert.match(body, /stdio:\s*gnome \? \['ignore', 'ignore', 'pipe'\] : 'ignore'/,
    'only the GNOME launcher client may expose stderr; all other terminal handles stay ignored')
  assert.match(body, /if \(gnome\) return acknowledgeGnomeTerminal\(child\)/)
  assert.match(body, /shell:\s*false/, 'the terminal is started through a shell')
  assert.match(body, /unref\(\)/, 'the shell keeps hold of the person’s window')
  /* MEASURED 2026-09-02, twice, from an Explorer-started Electron main. The
     first live drive found that on a machine without Windows Terminal a
     detached cmd.exe /k has no console at all, so the window that echoes the
     command and stays open never appeared; only the sign-in program's own
     console flashed. The Command Prompt is therefore opened through `start`,
     which makes a new console whatever the parent has, and the second
     measurement (recorded above the function in shell/main.cjs) saw that
     window stand and outlive its payload. Windows Terminal makes its own
     window and keeps the direct, detached spawn. These lines stop reasoning
     from replacing the measurement. */
  assert.match(body, /kind === 'command-prompt'/, 'the Command Prompt is no longer told apart from Windows Terminal')
  const helper = source.slice(source.indexOf('const LIBUV_WILL_QUOTE'), at)
  assert.match(helper, /\['\/c', 'start', named, command, /, 'the Command Prompt is no longer opened through start')

  /* THE ESCAPING RULE, RUN. The tail provider-login builds goes to the OUTER
     cmd.exe /c, which parses it once before start sees it; a bare && there
     would run the sign-in in the windowless outer cmd. Bare operators get a
     caret; a word libuv will quote is left alone, because inside quotes the
     outer cmd already reads an operator as text and a caret would reach the
     inner window as a literal character in the directory name. */
  /* THE SHIPPED PREDICATE, NOT A STAND-IN. consoleWindowArgs asks
     provider-login.cjs whether a title may be written into a command line, and
     a context that answered that question with its own copy would be the
     measuring-itself defect this file's own comment above warns about. */
  const launches = []
  const context = {
    windowTitleIsSafe: require(path.join(REPO, 'shell', 'provider-login.cjs')).windowTitleIsSafe,
    PROVIDER_ISOLATION_REQUESTED: false, TERMINAL_WINDOW_IS_THE_POINT: false,
    setTimeout, clearTimeout,
    spawnChildProcess: (command, args, options) => {
      launches.push({ command, args, options })
      const child = new EventEmitter()
      child.unref = () => {}
      queueMicrotask(() => child.emit('spawn'))
      return child
    },
  }
  vm.runInNewContext(`${helper}; ${body}; this.consoleWindowArgs = consoleWindowArgs; this.openTerminalWindow = openTerminalWindow`, context)
  for (const isolated of [false, true]) {
    context.PROVIDER_ISOLATION_REQUESTED = isolated
    for (const kind of ['windows-terminal', 'command-prompt']) {
      await context.openTerminalWindow('fixture-terminal', ['/k', 'echo', 'fixture'], { kind, env: {} })
      const launched = launches.at(-1)
      assert.equal(launched.options.detached, true, 'Windows terminal windows retain their measured detached launch')
      if (isolated && kind === 'command-prompt') assert.equal(launched.args[0], '/d', 'Private outer cmd must suppress owner AutoRun')
    }
  }
  /* Spread, because an array built in the other context has that context's
     Array prototype and strict deep-equal compares prototypes. */
  const built = (...args) => [...context.consoleWindowArgs(...args)]
  const CMD = 'C:\\Windows\\System32\\cmd.exe'
  assert.deepEqual(
    built(CMD, ['/k', 'echo', 'codex', 'login', '&&', 'set', 'CODEX_HOME=C:\\h\\a&&', 'codex', 'login']),
    ['/c', 'start', '', CMD, '/k', 'echo', 'codex', 'login', '^&^&', 'set', 'CODEX_HOME=C:\\h\\a^&^&', 'codex', 'login'],
    'a bare && was not escaped for the outer cmd',
  )
  assert.deepEqual(
    built(CMD, ['/k', 'echo', 'codex', 'login', '&&', 'set', 'CODEX_HOME=C:\\a b\\x', '&&', 'codex', 'login']),
    ['/c', 'start', '', CMD, '/k', 'echo', 'codex', 'login', '^&^&', 'set', 'CODEX_HOME=C:\\a b\\x', '^&^&', 'codex', 'login'],
    'a word libuv quotes was touched, or the && beside it was not escaped',
  )
  assert.deepEqual(built(CMD, ['/k', 'a|b', 'c^d', 'e<f>g']), ['/c', 'start', '', CMD, '/k', 'a^|b', 'c^^d', 'e^<f^>g'])

  /* THE TITLE, WHICH USED TO BE THE EMPTY STRING ON EVERY SIGN-IN WINDOW.
     MEASURED 2026-09-03 by reading this function and shell/provider-login.cjs:
     nothing on either side put an account name where a person could see it, and
     the note above openTerminalWindow already recorded the consequence -- "one
     thing the form costs: `start ""` gives the window an empty title bar". Two
     accounts to sign in were two untitled windows running the same command. */
  assert.deepEqual(
    built(CMD, ['/k', 'echo', 'codex', 'login'], 'ToolsEnabled sign-in: work - codex'),
    ['/c', 'start', 'ToolsEnabled sign-in: work - codex', CMD, '/k', 'echo', 'codex', 'login'],
    'the sign-in window is untitled again, so several of them cannot be told apart',
  )
  /* AND A TITLE THAT COULD BE READ AS SYNTAX IS REFUSED RATHER THAN WRITTEN.
     `start` takes its title as its first QUOTED word, so a quote inside it ends
     the title and everything after it is read as part of the command. The
     fallback is the empty title -- what shipped before this change -- never a
     command line with a person's punctuation loose in it. */
  for (const unsafe of ['a" & del x', 'b && del x', 'c > out', 'd | more']) {
    assert.deepEqual(built(CMD, ['/k'], unsafe), ['/c', 'start', '', CMD, '/k'],
      `a title containing ${JSON.stringify(unsafe)} was written into the command line`)
  }
})

test('Remove says what it removes, and what it leaves behind', async () => {
  /* shell/account-registry.cjs remove() edits the registry file and NOTHING else.
   * The account folder, and the provider sign-in inside it, are untouched -- on
   * purpose: engine/src/lib/multi-account holds that a person's provider home is
   * theirs, "their file, their terminal, their business", and deleting somebody's
   * paid sign-in is not this product's to do.
   *
   * The button said only "Remove". The row vanished from the list, and a person
   * could reasonably believe the sign-in went with it. Somebody handing a laptop
   * on is exactly who presses this, so the belief is expensive and the moment is
   * the wrong one to be wrong in.
   *
   * Saying the scope is the fix. Deleting their credential is not, and this test
   * exists partly so nobody later mistakes the fix for the other one.
   */
  const { ACCOUNT_PANEL } = await import('../../src/account-panel-copy.js')

  assert.equal(typeof ACCOUNT_PANEL.removeScope, 'string')
  assert.match(ACCOUNT_PANEL.removeScope, /off this list/,
    'the removal sentence does not say the removal is from the list')
  assert.match(ACCOUNT_PANEL.removeScope, /sign-in inside it, stay/,
    'the removal sentence does not say the sign-in stays, which is the belief that costs somebody a '
    + 'credential left on a computer they handed on')
  assert.match(ACCOUNT_PANEL.removeScope, /sign out in that program/i,
    'the sentence states the limit and offers no way past it')

  assert.match(ACCOUNT_PANEL.removeDidNothing, /nothing was removed/,
    'the did-nothing case does not say nothing was removed, so { ok: true, removed: false } reads as a removal')

  /* THE HANDLER MUST READ `removed`, not `ok` alone. Without this the copy above
     exists and is never reached, which is the shape this file keeps finding. */
  const guide = readFileSync(new URL('../../src/this-computer-settings.js', import.meta.url), 'utf8')
  assert.match(guide, /gone\.removed === false/,
    'the remove handler reads ok alone again, so an account that was never on the list reports as removed')
  assert.match(guide, /ACCOUNT_PANEL\.removeScope/,
    'a successful removal no longer tells the person what it left behind')
})

test('no account-panel sentence carries an HTML entity, because these are drawn as text', async () => {
  /* THE PANEL'S SENTENCES REACH THE GLASS THROUGH textContent, NOT innerHTML.
   *
   * src/views/guide.js assigns these values with `out.textContent = ...`, and
   * textContent does not decode entities -- it prints them. So a sentence
   * carrying `&mdash;` does not show a dash to the person; it shows the seven
   * characters "&mdash;" in the middle of a sentence about what Remove just did.
   *
   * The rest of the application already settles this by using the character
   * itself: every other copy module under src/ ships a literal em dash, and this
   * module was the single one reaching for the entity. So the guard is not a new
   * house rule, it is the existing one written down where it can be measured.
   *
   * It walks the exported values rather than the file text, because a value is
   * what actually reaches the screen, and because the two remote twins and the
   * function-shaped entries compose their sentences at call time. */
  const copy = await import('../../src/account-panel-copy.js')

  const ENTITY = /&(?:[a-zA-Z][a-zA-Z0-9]*|#\d+);/

  const sentences = []
  const collect = (label, value) => {
    if (typeof value === 'string') { sentences.push([label, value]); return }
    if (Array.isArray(value)) { value.forEach((item, i) => collect(`${label}[${i}]`, item)); return }
    if (typeof value === 'function') { collect(`${label}('Codex')`, value(value === PROVIDER_SIGN_IN.copyLine ? { version: '1.2.3', who: 'installed by its maker', copies: 2 } : 'Codex')); return }
    if (value && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) collect(`${label}.${key}`, inner)
    }
  }

  collect('ACCOUNT_PANEL', copy.ACCOUNT_PANEL)
  collect('PROVIDER_SIGN_IN', copy.PROVIDER_SIGN_IN)
  collect('CLAUDE_ACCOUNT_RISK', copy.CLAUDE_ACCOUNT_RISK)
  collect('accountPanelCopy(relay)', copy.accountPanelCopy({ viaRelay: true }))
  collect('providerSignInCopy(relay)', copy.providerSignInCopy({ viaRelay: true }))

  // A cardinality floor, so a refactor that stops collecting anything cannot
  // pass this test by having nothing left to check.
  assert.ok(sentences.length >= 40,
    `only ${sentences.length} account-panel sentences were collected; the walk above stopped finding them`)

  for (const [label, sentence] of sentences) {
    assert.ok(!ENTITY.test(sentence),
      `${label} carries an HTML entity and is drawn with textContent, so a person reads the entity itself: ${JSON.stringify(sentence)}`)
  }

  /* And the premise, proved rather than assumed: if these ever became innerHTML
     the guard above would be arguing for the wrong thing. */
  const guide = readFileSync(new URL('../../src/this-computer-settings.js', import.meta.url), 'utf8')
  assert.match(guide, /textContent = readerSentence\(/,
    'the panel no longer writes its outcome with textContent, so this guard is measuring the wrong thing')
})

test('each Remove button says which account it removes', () => {
  /* THE PANEL EXISTS BECAUSE A PERSON HAS MORE THAN ONE ACCOUNT, so it always
   * draws more than one Remove button, and every one of them announced itself
   * as the single word "Remove".
   *
   * A screen reader names a button from the button, not from the paragraph
   * above it. Someone moving through this list by control heard "Remove",
   * "Remove", "Remove", with nothing to tell them apart, and the only way to
   * choose was to count. The cost of miscounting is the whole subject of the
   * removeScope sentence beside it: the wrong account leaves the list.
   *
   * THE VISIBLE WORD DOES NOT CHANGE. The row already names the account in
   * text, and a longer button would crowd a list whose point is that it is a
   * list. What changes is the accessible name, and it LEADS with the same
   * visible word on purpose: somebody driving this by voice says "click
   * Remove", and a name that did not begin with the visible label would stop
   * matching that. */
  assert.equal(typeof ACCOUNT_PANEL.removeAccount, 'function',
    'there is no per-account name for the Remove button, so every row announces the same word')

  const school = ACCOUNT_PANEL.removeAccount('school')
  const personal = ACCOUNT_PANEL.removeAccount('personal')

  assert.match(school, /school/, 'the accessible name does not say which account it removes')
  assert.notEqual(school, personal,
    'two accounts produce the same accessible name, which is the defect this guards')
  assert.ok(school.startsWith(ACCOUNT_PANEL.remove),
    `the accessible name must begin with the visible label "${ACCOUNT_PANEL.remove}" so voice control still matches it, got ${JSON.stringify(school)}`)

  /* WIRED, not merely available. This module has a standing habit of holding
     correct copy that no renderer ever reaches, so the button itself is checked
     against the account it belongs to. */
  const guide = readFileSync(new URL('../../src/this-computer-settings.js', import.meta.url), 'utf8')
  const button = guide.split('\n').find(line => line.includes('data-account-remove='))
  assert.ok(button, 'the remove button is no longer drawn from this line, so this guard cannot see it')
  assert.match(button, /aria-label=/,
    'the remove button carries no accessible name, so every row announces the same word again')
  assert.match(button, /ACCOUNT_PANEL\.removeAccount\(account\.name\)/,
    'the remove button does not build its accessible name from the account it removes')
  assert.match(button, /ACCOUNT_PANEL\.remove\b/,
    'the remove button lost its visible label')
})
