// Real Setup view/Finish and real router listeners, with the repository DOM
// stand-in and explicit disposable disk/IPC inputs. No browser, provider or
// native input is launched; geometry and OS account readiness are not proved.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import vm from 'node:vm'
import { createRequire, registerHooks } from 'node:module'
import { installDomStandIn } from './lib/dom-stand-in.mjs'

const cssHook = registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith('file:') && url.endsWith('.css')) return { format: 'module', source: 'export {}', shortCircuit: true }
    return nextLoad(url, context)
  },
})
const { document, restore } = installDomStandIn(globalThis)
const keys = ['localStorage', 'CustomEvent', 'mcSetup', 'mcSettings', 'mcProviders', 'mcAgent', 'mcShell', 'fetch']
const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
const set = (key, value) => Object.defineProperty(globalThis, key, { value, writable: true, configurable: true })
set('CustomEvent', class { constructor(type, options = {}) { this.type = type; this.detail = options.detail } })
set('localStorage', { getItem: () => null, setItem() {}, removeItem() {} })
set('mcShell', { getBridgeProof: () => { throw new Error('No live bridge is available in this source fixture.') } })
window.mcShell = globalThis.mcShell
set('mcSetup', { bootstrap: { ok: true, available: true, configured: true, tier: 'standard' }, chooseTier() { throw new Error('Finish must not rewrite the tier.') } })
set('fetch', async () => { throw new Error('Network is unavailable in this source fixture.') })
const { setupView } = await import('../../src/views/setup.js')
const { writeStoredProfile, readStoredProfile, answersForAutonomy } = await import('../../src/setup-profile.js')
const { SETUP_RESOLUTION } = await import('../../src/setup-state.js')
const { WRITE_FLAGS_EVENT, setWriteEnabled } = await import('../../src/write-flags.js')
const { DATA_SOURCE_EVENT, setExampleMode, announceDataSourceChange, currentDataSource, isExampleMode } = await import('../../src/data-source.js')
const { createSettingsDraft } = await import('../../src/settings-draft.js')
const require = createRequire(import.meta.url)
const { createAccountRegistryStore } = require('../../shell/account-registry.cjs')
const source = fs.readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8')
const start = source.indexOf('window.addEventListener(DATA_SOURCE_EVENT,')
const end = source.indexOf('\nconst hashFor', start)
assert.ok(start >= 0 && end > start, 'The real data-source/write-flag listener block must be retained.')
const listenersSource = source.slice(start, end)
/* The producer's own sentence (src/setup-intent-commit.js), not the review's
   heading: it is the part a person must actually be able to read, and pinning it
   here keeps these tests measuring the deferral rather than the copy around it. */
const notice = 'There are no provider accounts to switch between yet.'
const tick = () => new Promise(resolve => setImmediate(resolve))
async function settle() { for (let i = 0; i < 6; i += 1) await tick() }
after(() => {
  cssHook.deregister()
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else delete globalThis[key]
  }
  restore()
})

async function fixture(t, { route = 'setup', registry = 'absent', firstRun = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-finish-events-'))
  const storageFile = path.join(directory, 'renderer-storage.json')
  const accountFile = path.join(directory, 'accounts.json')
  const writes = [], navigations = [], events = [], renders = [], sideEffects = []
  const disk = (file, value) => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 })
  disk(storageFile, {})
  const values = () => JSON.parse(fs.readFileSync(storageFile, 'utf8'))
  set('localStorage', {
    getItem(key) { return values()[key] ?? null },
    setItem(key, value) { disk(storageFile, { ...values(), [key]: String(value) }) },
    removeItem(key) { const next = values(); delete next[key]; disk(storageFile, next) },
  })
  const accountStore = createAccountRegistryStore({ file: accountFile, homedir: () => directory })
  if (registry === 'damaged') fs.writeFileSync(accountFile, '{invalid')
  let releaseFolder
  const folder = new Promise(resolve => { releaseFolder = resolve })
  const workspace = path.join(directory, 'workspace')
  fs.mkdirSync(workspace)
  set('mcSetup', {
    bootstrap: firstRun
      ? { ok: true, available: true, configured: false, tier: null }
      : { ok: true, available: true, configured: true, tier: 'standard' },
    chooseTier: firstRun
      ? async tier => { writes.push(['tier', tier]); return { ok: true, tier } }
      : () => { throw new Error('Finish must not rewrite the tier.') },
    workspaceState: async () => ({ ok: true, available: true, roots: [workspace] }),
    async recordWorkspaces(roots) {
      writes.push(['folder-request', ...roots])
      await folder
      disk(path.join(directory, 'workspaces.json'), roots)
      writes.push(['folder-saved', ...roots])
      return { ok: true, roots }
    },
    async setEditorImportPolicy(policy) {
      disk(path.join(directory, 'editor-policy.json'), policy)
      writes.push(['editor', policy]); return { ok: true }
    },
  })
  set('mcSettings', { async set(key, value) {
    disk(path.join(directory, 'settings.json'), { [key]: value })
    writes.push(['setting', key, value]); return { ok: true }
  } })
  set('mcProviders', {
    presence: async () => ({ ok: true, providers: [] }),
    async accountPolicy(value) {
      writes.push(['account-policy', value.selectionMode])
      // The refusal is the real store's decision over the disposable path.
      if (registry === 'accepted') return { ok: true } // Explicit controlled success for normal navigation only.
      try { return accountStore.setPolicy(value) }
      catch (error) { return { ok: false, code: error.code, reason: error.message } }
    },
  })
  set('mcAgent', {
    availability: async () => ({ ok: false, code: 'AGENT_ENGINE_UNAVAILABLE' }),
    start() { throw new Error('The fixture must not start a provider session.') },
  })
  /* A FIRST RUN HAS NO STORED PROFILE AND NO RECORDED LEVEL. SETUP_RESOLUTION is
     resolved once while the module graph evaluates, so the only honest way to put
     this file's already-imported copy of the view into that state is to put the
     resolution into it -- the same object noteTierRecorded writes to when the
     level is chosen for real. Restored afterwards so the rest of the file keeps
     measuring a returning customer. */
  if (firstRun) {
    const before = { configured: SETUP_RESOLUTION.configured, tier: SETUP_RESOLUTION.tier }
    SETUP_RESOLUTION.configured = false
    SETUP_RESOLUTION.tier = null
    t.after(() => Object.assign(SETUP_RESOLUTION, before))
  } else {
    writeStoredProfile({ status: 'in-progress', step: 'review',
      answers: { ...answersForAutonomy('assisted'), screens: 'live', workspaceRoots: [workspace] } })
  }
  const subscriptions = []
  const routerWindow = {
    addEventListener(type, listener) { window.addEventListener(type, listener); subscriptions.push([type, listener]) },
    mcAccessibility: { disable: async () => { sideEffects.push('disable-accessibility') } },
  }
  const context = {
    window: routerWindow, DATA_SOURCE_EVENT, WRITE_FLAGS_EVENT, queueMicrotask,
    isExampleMode, currentDataSource,
    syncPhoneExampleNotice: () => sideEffects.push('phone-notice'),
    resetPersistentVoice: () => sideEffects.push('reset-voice'),
    accessibilityControls: { refresh: () => sideEffects.push('refresh-accessibility') },
    resetCartChanges: () => sideEffects.push('reset-cart'),
    current: null,
    render() { renders.push(route); mount() },
  }
  const views = []
  function mount() {
    const old = context.current?.view
    old?.destroy?.()
    old?.el.remove()
    const view = route === 'setup' ? setupView({ navigate(hash) { navigations.push(hash); route = 'home'; mount() } })
      : { el: document.createElement('div'), destroy() {} }
    document.body.appendChild(view.el)
    views.push(view)
    context.current = { route: { name: route }, view }
  }
  const observe = event => events.push({ type: event.type, detail: event.detail })
  for (const type of [WRITE_FLAGS_EVENT, DATA_SOURCE_EVENT]) window.addEventListener(type, observe)
  vm.runInNewContext(listenersSource, context, { filename: 'src/main.js:router-event-listeners' })
  mount()
  const first = context.current.view
  t.after(async () => {
    releaseFolder()
    await settle()
    for (const view of views) { view.destroy?.(); view.el.remove() }
    for (const [type, listener] of subscriptions) window.removeEventListener(type, listener)
    for (const type of [WRITE_FLAGS_EVENT, DATA_SOURCE_EVENT]) window.removeEventListener(type, observe)
    fs.rmSync(directory, { recursive: true })
    assert.equal(fs.existsSync(directory), false)
  })
  await settle()
  return {
    context, first, values, directory, storageFile, accountFile, workspace, writes, renders, events, sideEffects, navigations,
    finish() {
      const button = context.current.view.el.querySelector('[data-setup-next="finish"]')
      assert.ok(button, 'The actual Setup markup must offer Finish.')
      button.click()
    },
    async release() { releaseFolder(); await settle() },
    /* The real return path: Settings offers "Walk through setup again", which
       remounts this view over the SAME durable profile. Finish now enters the
       application, so this is where a recorded deferral has to still be legible
       -- and a notice that only the finishing render could show would be exactly
       the defect src/setup-profile.js records. */
    reopenSetup() { route = 'setup'; mount() },
    displayedNotice: () => [...context.current.view.el.querySelectorAll('[data-setup-status]')].map(node => node.textContent).join(' '),
  }
}

function saved(f) {
  const disk = f.values(), profile = JSON.parse(disk['mc.setup.profile'])
  assert.equal(profile.status, 'complete')
  assert.equal(profile.answers.autonomy, 'assisted')
  assert.equal(profile.answers.screens, 'live')
  assert.deepEqual(profile.answers.workspaceRoots, [f.workspace])
  assert.deepEqual(Object.fromEntries(Object.entries(disk).filter(([key]) => key.startsWith('mc.write.'))), {
    'mc.write.dispatch': 'enabled', 'mc.write.decision': 'disabled', 'mc.write.queue': 'disabled',
    'mc.write.thread-reply': 'disabled', 'mc.write.report-read': 'enabled',
    'mc.write.agent-session': 'enabled', 'mc.write.cloud-launch': 'enabled',
  })
  assert.equal(fs.existsSync(f.accountFile), false)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.directory, 'settings.json'), 'utf8')),
    { 'agent.blocked_question': 'Switch to other work' })
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory, 'editor-policy.json'), 'utf8')), 'ask')
}

/* THE DEFERRAL NO LONGER HOLDS THE LAST PRESS OF SETUP, and these two tests are
 * where that is measured. Both used to assert `navigations === []` and a notice
 * on the retained instance, which is the behaviour the packaged Linux run
 * reported as "the first-run walk ends in the application -- hash=#/setup".
 * Neither is weakened: the first still pins every saved event, the retained
 * owner (now as "nothing re-rendered the screen under the press") and the exact
 * producer sentence, and additionally pins that the sentence is DURABLE and that
 * Finish navigated exactly once. The second still pins the saved-notice exit,
 * now reached the way a person reaches it. */
test('held real Finish keeps its mounted owner through every saved event, records the account deferral and enters the application', async t => {
  const f = await fixture(t)
  f.finish()
  assert.equal(f.writes.length, 1)
  assert.equal(readStoredProfile().status, 'in-progress')
  assert.equal(f.first.el.querySelector('[data-setup-next="finish"]').disabled, true)
  await f.release()
  saved(f)
  assert.equal(f.events.filter(row => row.type === WRITE_FLAGS_EVENT).length, 7)
  assert.equal(f.events.filter(row => row.detail?.why === 'example-toggle').length, 1)
  assert.deepEqual(f.renders, [], 'mutation `re-render Setup on its own write notifications` survived: expected the pressed instance to keep the screen it was pressed on')
  assert.deepEqual(f.navigations, ['#/'],
    'mutation `return instead of navigate when applySetupIntentChanges defers` survived: expected Finish to end in the application')
  assert.equal(f.context.current.route.name, 'home')
  assert.match(readStoredProfile().accountPolicyDeferred?.reason || '', /no provider accounts to switch between yet/,
    'mutation `drop accountPolicyDeferred from the completed profile` survived: expected the deferral to outlive the screen that produced it')
})

test('saved Setup restates the absent-account deferral when it is reopened, and can continue without resetting choices or claiming the policy saved', async t => {
  const f = await fixture(t)
  assert.equal(f.first.el.querySelector('[data-setup-open-app]'), null)
  f.finish(); await f.release()
  saved(f)
  assert.deepEqual(f.navigations, ['#/'])
  const before = fs.readFileSync(f.storageFile, 'utf8')
  const writes = f.writes.length
  f.reopenSetup(); await settle()
  const review = f.context.current.view.el
  assert.ok(f.displayedNotice().includes(notice),
    'mutation `read the deferral from the live refusal instead of the stored profile` survived: expected a reopened review to restate it')
  const policyNotice = review.querySelector('[data-setup-account-policy]')
  assert.ok(policyNotice, 'mutation `stop rendering the carried deferral` survived: expected the review to state it')
  assert.equal(policyNotice.getAttribute('role'), 'status',
    'mutation `render the deferral as role=alert is-serious` survived: expected a saved-setup status, not a refusal')
  assert.equal(policyNotice.className.includes('is-serious'), false,
    'mutation `keep filing the deferral in `refusal`` survived: expected nothing on this review to look like a save that failed')
  const button = review.querySelector('[data-setup-open-app]')
  assert.ok(button, 'A completed first-run setup with no provider account needs an exit from its saved notice.')
  assert.match(review.querySelector('.setup-lede').textContent, /settings are saved/)
  button.click(); await settle()
  assert.deepEqual(f.navigations, ['#/', '#/'])
  assert.equal(f.context.current.route.name, 'home')
  assert.equal(f.writes.length, writes, 'Continue must not retry policy writes or reset setup answers.')
  assert.equal(fs.readFileSync(f.storageFile, 'utf8'), before)
  assert.equal(fs.existsSync(f.accountFile), false, 'No account or acknowledged account policy is fabricated.')
})

for (const [name, notify] of [
  ['write flag', () => setWriteEnabled('report-read', true)],
  ['example choice', () => setExampleMode(true)],
]) test(`a real ${name} event while Finish awaits the folder cannot retire its owner`, async t => {
  const f = await fixture(t)
  f.finish(); notify(); await settle()
  assert.equal(f.context.current.view === f.first, true, 'A pending Finish must still own the mounted review.')
  assert.equal(f.writes.length, 1)
  await f.release(); saved(f)
  assert.deepEqual(f.navigations, ['#/'])
  assert.match(readStoredProfile().accountPolicyDeferred?.reason || '', /no provider accounts to switch between yet/)
})

test('Finish still navigates normally after an acknowledged account policy', async t => {
  const f = await fixture(t, { registry: 'accepted' })
  f.finish(); await f.release()
  assert.deepEqual(f.navigations, ['#/'])
  assert.equal(f.context.current.route.name, 'home')
  assert.equal(readStoredProfile().status, 'complete')
})

test('a real damaged-registry refusal leaves the review pending without applying the profile', async t => {
  const f = await fixture(t, { registry: 'damaged' })
  f.finish(); await f.release()
  assert.equal(f.context.current.view === f.first, true)
  assert.equal(readStoredProfile().status, 'in-progress')
  assert.equal(f.events.length, 0)
  assert.deepEqual(f.navigations, [])
  assert.ok(f.displayedNotice().includes('Setup settings could not be saved'))
  assert.equal(f.first.el.querySelector('[data-setup-open-app]'), null, 'An unsaved failure must not present the saved-setup exit.')
})

test('unrelated account changes still refresh Setup and clear account-related view state', async t => {
  const f = await fixture(t)
  announceDataSourceChange('signed-out'); await settle()
  assert.equal(f.context.current.view !== f.first, true)
  assert.deepEqual(f.renders, ['setup'])
  assert.ok(f.sideEffects.includes('reset-cart'))
  assert.ok(f.sideEffects.includes('refresh-accessibility'))
})

test('Setup example notifications keep all synchronous shared side effects', async t => {
  const f = await fixture(t)
  setExampleMode(true); await settle()
  assert.equal(f.context.current.view === f.first, true)
  for (const effect of ['phone-notice', 'reset-voice', 'disable-accessibility', 'refresh-accessibility', 'reset-cart']) {
    assert.ok(f.sideEffects.includes(effect), effect)
  }
})

test('other routes still refresh on both actual saved-preference events', async t => {
  const f = await fixture(t, { route: 'home' })
  setWriteEnabled('report-read', true); setExampleMode(false); await settle()
  assert.deepEqual(f.renders, ['home', 'home'])
  assert.equal(f.context.current.view !== f.first, true)
})

test('Settings keeps its existing unsaved draft through both preference and account events', async t => {
  const f = await fixture(t, { route: 'settings' })
  const draft = createSettingsDraft()
  let saves = 0
  draft.stage('held', 'answer', async () => { saves += 1 })
  setWriteEnabled('report-read', true); setExampleMode(false); announceDataSourceChange('signed-out')
  await settle()
  assert.equal(f.context.current.view === f.first, true)
  assert.deepEqual(f.renders, [])
  assert.equal(draft.dirty, true)
  assert.equal(saves, 0)
})

/* THE WALK THE PACKAGED LINUX RUN MADE, IN SOURCE.
 *
 * tools/home-screen-qa.cjs answers all five questions against the packaged build
 * and then waits for `location.hash === '#/'`. On 2026-09-11 it scored 9/11: every
 * press landed, and the last one left the build at hash=#/setup. Nothing shorter
 * than the whole walk would have caught it -- each step in isolation was correct,
 * and the fixture above starts on the review, so it could not see that the press
 * a first-time customer makes at the end of a FIRST RUN does not enter the
 * product. This is that walk: no stored profile, no recorded level, an absent
 * account registry (which is what every fresh installation has), the recommended
 * answer at every question. */
test('a first run that answers every question and presses Finish ends in the application', async t => {
  const f = await fixture(t, { firstRun: true })
  const press = selector => {
    const control = f.context.current.view.el.querySelector(selector)
    assert.ok(control, `the first-run walk found nothing matching ${selector}`)
    assert.equal(control.disabled ?? false, false, `${selector} is on the screen but disabled`)
    control.click()
    return settle()
  }
  assert.equal(readStoredProfile(), null, 'A first run starts with no stored profile.')
  await press('[data-setup-tier="standard"]')
  await press('[data-setup-continue]')
  assert.deepEqual(f.writes, [['tier', 'standard']], 'The level is the only thing recorded before the end.')
  await press('[data-setup-next="account"]')
  await press('[data-setup-next="autonomy"]')
  await press('[data-setup-value="assisted"]')
  await press('[data-setup-next="review"]')
  await press('[data-setup-next="finish"]')
  await f.release()
  assert.deepEqual(f.navigations, ['#/'],
    'mutation `return instead of navigate when applySetupIntentChanges defers` survived: expected a completed first run to enter the application, not to stay on #/setup')
  assert.equal(f.context.current.route.name, 'home')
  const profile = readStoredProfile()
  assert.equal(profile.status, 'complete')
  assert.deepEqual(profile.answers.workspaceRoots, [f.workspace])
  assert.match(profile.accountPolicyDeferred?.reason || '', /no provider accounts to switch between yet/,
    'mutation `discard the deferral once Finish navigates` survived: expected the one thing that could not be recorded to be recorded')
  assert.equal(fs.existsSync(f.accountFile), false, 'No account or account policy is fabricated to get past the deferral.')
})
