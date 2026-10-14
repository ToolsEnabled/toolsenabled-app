'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const { readFirstUseState, assertSavedState, retainedState } = require('./page2-native-first-use.cjs')

function requireFirstUse(context) {
  if (!context.options.sterileFirstUse || !context.firstUse) context.unavailable('This case requires the explicitly selected sterile first-use launch; authenticated cases cannot supply its proof')
}
function settings(context) { return context.page.locator('#stage > .view:not([inert]) > .settings-page') }
async function openSetupSettings(context) {
  await context.page.locator('nav[aria-label="Primary navigation"] a[data-route="settings"]').click()
  const root = settings(context)
  await context.type(root.getByRole('searchbox', { name: 'Search all settings', exact: true }), 'Acting on its own')
  await root.locator('[data-setup-profile-system]').waitFor()
  return root
}
async function choose(context, field, value) {
  await settings(context).locator(`[data-setup-profile-set="${field}"][data-setup-profile-value="${value}"]`).click()
}
async function mountedChoice(context, field, value) {
  assert.equal(await settings(context).locator(`[data-setup-profile-set="${field}"][data-setup-profile-value="${value}"]`).getAttribute('aria-pressed'), 'true')
}
async function pendingSettings(context) {
  // Policy reads are asynchronous: click completion does not mean staging has
  // settled. Wait for the actual mounted draft, without adding a fixed delay.
  await context.page.waitForFunction(() => {
    const root = document.querySelector('#stage > .view:not([inert]) > .settings-page')
    const save = root?.querySelector('[data-settings-save]'), discard = root?.querySelector('[data-settings-discard]')
    return root?.dataset.settingsSaveState === 'pending' && save?.disabled === false && discard?.disabled === false
  }, undefined, { timeout: 12000 })
}
async function waitForWorkspacePath(context) {
  // Native chooser closure precedes the setup handler's awaited result and
  // repaint. Wait for that exact mounted postcondition before reading it.
  await context.page.waitForFunction(expected => document.querySelector('.setup-root-path')?.innerText === expected,
    context.paths.workspace, { timeout: 12000 })
}
async function reopen(context, label) {
  const before = context.state.qaProcessId
  await context.close()
  assert.equal(context.firstUse.receipt.openings.length, context.firstUse.receipt.closures.length)
  await context.open()
  // PID reuse alone cannot be a false positive: the custody helper also binds
  // creation ticks and proves the old retained ChildProcess has terminated.
  const opening = context.firstUse.receipt.openings.at(-1), closed = context.firstUse.receipt.closures.at(-1)
  assert.ok(opening.pid !== before || opening.startTicks !== closed.startTicks)
  await context.page.waitForURL(url => url.hash !== '#/setup')
  return { label, closed, opening }
}
function expected(context, autonomy, screens = 'live') {
  return { autonomy, screens, workspace: context.paths.workspace }
}

const FIRST_USE_HOME = 'nav[aria-label="Primary navigation"] a[data-route="home"]'
const ACTIVE_SETUP = '#stage > .view:not([inert]) > .setup-page'
const ACTIVE_HOME = '#stage > .view:not([inert]) > .home'
/* FINISH IS THE EXIT NOW, so this is what the two scenarios below prove after
 * pressing it.
 *
 * MEASURED 2026-09-11 on the packaged 1.0.44 Linux candidate (b-linuxqa's
 * home-screen-qa, 9/11): a first run that answered every question and pressed
 * Finish stayed at hash=#/setup, because applySetupIntentChanges' account-policy
 * deferral -- unavoidable on a machine with no account list, i.e. every fresh
 * installation -- was filed as a `refusal` and returned. src/views/setup.js now
 * records that deferral in the durable profile and navigates, so the step below
 * asks for what a person actually gets: the application, in the SAME app
 * lifetime, with the one thing that could not be recorded recorded.
 *
 * `firstUseVisibleExit` is kept below, unchanged: it is the proof for a Finish
 * that legitimately stops on the review, which is still what an unwritable
 * .mcp.json or an unavailable undo produces. NEITHER FUNCTION WAS EXECUTED IN
 * THIS LANE -- these scenarios need a Playwright host (TESTKIT_PLAYWRIGHT_ROOT)
 * and this one has none. Note also that `firstUseVisibleExit` has asserted
 * `continueCount === 0` since c057d319 while b1ccc425 had already made the
 * review render [data-setup-open-app] for this very deferral, so it has not been
 * run against the product since 2026-09-09 either. */
async function firstUseFinishEntersApplication(context, { readState = readFirstUseState, autonomy = 'assisted' } = {}) {
  requireFirstUse(context)
  const lifetime = () => {
    const receipt = context.firstUse.receipt
    assert.equal(receipt.attempts.length, 1); assert.equal(receipt.openings.length, 1)
    assert.deepEqual(receipt.closures, []); assert.deepEqual(receipt.rejections, [])
    return structuredClone({ attempt: receipt.attempts[0], opening: receipt.openings[0] })
  }
  const initial = lifetime()
  const setup = context.page.locator(ACTIVE_SETUP)
  assert.equal(new URL(context.page.url()).hash, '#/setup')
  await setup.locator('[data-setup-next="finish"]').click()
  // Finish's own navigation. No forced route, notice-specific Continue, primary
  // navigation click or cold reopen may supply it.
  await context.page.waitForURL(url => url.hash === '#/', { timeout: 20000 })
  await context.page.locator(ACTIVE_HOME).waitFor({ state: 'visible', timeout: 12000 })
  assert.equal(await context.page.locator(ACTIVE_HOME).count(), 1)
  assert.equal(await setup.count(), 0)
  assert.deepEqual(lifetime(), initial, 'Finish must reach home inside the initial app lifetime.')
  const saved = assertSavedState(await readState(context), expected(context, autonomy))
  assert.equal(saved.profile.assistantConfig, null); assert.equal(saved.profile.undoUnavailable, null)
  assert.match(saved.profile.accountPolicyDeferred?.reason || '',
    /no provider accounts to switch between yet/,
    'The one intent that could not be recorded must be recorded, because the machine defaults to the opposite of it.')
  assert.equal(saved.custody.registry.absent, true)
  return { obligation: 'fresh-finish-enters-application-with-recorded-deferral', ...initial,
    hash: new URL(context.page.url()).hash, expectedPolicyRefusal: 'ACCOUNT_REGISTRY_ABSENT',
    observation: 'actual Finish navigation plus exact absent registry', saved }
}

async function firstUseVisibleExit(context, { readState = readFirstUseState } = {}) {
  requireFirstUse(context)
  const lifetime = () => {
    const receipt = context.firstUse.receipt
    assert.equal(receipt.attempts.length, 1); assert.equal(receipt.openings.length, 1)
    assert.deepEqual(receipt.closures, []); assert.deepEqual(receipt.rejections, [])
    const attempt = receipt.attempts[0], opening = receipt.openings[0]
    assert.equal(attempt.attempt, 1); assert.equal(opening.attempt, 1)
    assert.equal(attempt.pid, opening.pid); assert.equal(attempt.startTicks, opening.startTicks)
    assert.equal(context.state.qaProcessId, opening.pid)
    return structuredClone({ attempt, opening })
  }
  const initial = lifetime(), savedBefore = assertSavedState(context.state.firstUseSaved, expected(context, 'assisted'))
  assert.equal(savedBefore.profile.assistantConfig, null); assert.equal(savedBefore.profile.undoUnavailable, null)
  const setup = context.page.locator(ACTIVE_SETUP), home = context.page.locator(FIRST_USE_HOME)
  const before = { hash: new URL(context.page.url()).hash, activeSetupCount: await setup.count(), setupVisible: await setup.isVisible(),
    assistantConfig: savedBefore.profile.assistantConfig, undoUnavailable: savedBefore.profile.undoUnavailable,
    noticeCount: await setup.locator('[data-setup-assistant-config], [data-setup-undo-unavailable]').count(),
    continueCount: await setup.locator('[data-setup-open-app]').count(), openingCount: 1, closureCount: 0 }
  assert.equal(before.hash, '#/setup'); assert.equal(before.activeSetupCount, 1); assert.equal(before.setupVisible, true)
  assert.equal(before.noticeCount, 0); assert.equal(before.continueCount, 0, 'A notice-specific Continue cannot supply ordinary Finish exit evidence')
  await context.capture('first-use-finish-exit-before')
  assert.equal(await home.count(), 1)
  await home.waitFor({ state: 'visible', timeout: 12000 })
  Object.assign(before, { homeVisible: await home.isVisible(), homeEnabled: await home.isEnabled(), homeHref: await home.getAttribute('href'),
    homeName: (await home.getAttribute('aria-label') || await home.textContent()).trim() })
  assert.equal(before.homeVisible, true); assert.equal(before.homeEnabled, true)
  assert.equal(before.homeHref, '#/'); assert.equal(before.homeName, 'Home')
  assert.deepEqual(lifetime(), initial)
  // The actual default locator click must be actionable. No force, injected
  // routing, Finish retry, notice fallback or cold reopen can fill this step.
  await home.click({ timeout: 12000 })
  const gesture = { kind: 'primary-navigation-home', selector: FIRST_USE_HOME, completed: true, ordinaryClick: true }
  context.report.event({ kind: 'first-use-exit-gesture', ...initial, gesture })
  await context.page.waitForURL(url => url.hash === '#/', { timeout: 12000 })
  await context.page.locator(ACTIVE_HOME).waitFor({ state: 'visible', timeout: 12000 })
  const after = { hash: new URL(context.page.url()).hash, homeVisible: await context.page.locator(ACTIVE_HOME).isVisible(),
    activeHomeCount: await context.page.locator(ACTIVE_HOME).count(), activeSetupCount: await setup.count(), openingCount: 1, closureCount: 0 }
  assert.equal(after.hash, '#/'); assert.equal(after.homeVisible, true); assert.equal(after.activeHomeCount, 1); assert.equal(after.activeSetupCount, 0)
  assert.deepEqual(lifetime(), initial)
  const saved = assertSavedState(await readState(context), expected(context, 'assisted'))
  assert.deepEqual(retainedState(saved), retainedState(savedBefore)); assert.deepEqual(saved.workspace, savedBefore.workspace)
  assert.deepEqual(lifetime(), initial)
  await context.capture('first-use-finish-exit-after')
  return { obligation: 'fresh-standard-account-deferral-visible-exit', ...initial, before, gesture, after, saved,
    captures: Object.fromEntries(['before', 'after'].map(phase => [phase, { image: path.join(context.paths.qaRoot, `first-use-finish-exit-${phase}.png`),
      text: path.join(context.paths.qaRoot, `first-use-finish-exit-${phase}.txt`) }])) }
}

const scenarios = [
  { id: 'startup', title: 'Launch the actual sandboxed Electron app in the sterile first-use companion',
    controls: ['first-use.startup'], run: context => context.open() },
  { id: 'first-use-wizard-standard', title: 'Complete ordinary Standard setup in a generated provider-free profile and retain account deferral',
    controls: ['first-use.wizard.standard'], requires: ['startup'], async run(context) {
      requireFirstUse(context)
      assert.equal(context.firstUse.receipt.openings.length, 1)
      await context.page.waitForURL(url => url.hash === '#/setup')
      await context.step('first-use-initial-empty-custody', () => context.firstUse.inspect(context.paths.userData))
      await context.step('first-use-choose-standard', async () => {
        await context.page.locator('button[data-setup-tier="standard"]').click()
        await context.page.locator('[data-setup-continue]').click()
      })
      await context.step('first-use-choose-owned-folder', async () => {
        await context.page.locator('[data-setup-choose-root]').click()
        await context.picker({ operation: 'select-path', title: 'Choose a folder for your assistant to work in', selectedPath: context.paths.workspace })
        await waitForWorkspacePath(context)
        assert.equal(path.normalize(await context.page.locator('.setup-root-path').innerText()), path.normalize(context.paths.workspace))
        await context.page.locator('[data-setup-next="account"]').click()
        await context.page.locator('[data-setup-next="autonomy"]').click()
        await context.page.locator('button[data-setup-value="assisted"]').click()
        await context.page.locator('[data-setup-next="review"]').click()
      })
      await context.step('first-use-finish-enters-the-application', async () => {
        // This is a source-bound observation of the exact deferral branch,
        // not an intercepted/replaced IPC response or a second hidden write.
        const result = await firstUseFinishEntersApplication(context)
        context.state.firstUseSaved = result.saved
        return result
      })
      await context.step('first-use-finish-review-is-gone', async () => {
        const setup = context.page.locator(ACTIVE_SETUP)
        assert.equal(await setup.count(), 0, 'Finish must leave no mounted Setup behind.')
        assert.equal(await context.page.locator(`${ACTIVE_SETUP} [data-setup-open-app]`).count(), 0,
          'A notice-specific Continue cannot be what carries a clean first run into the app')
        const home = context.page.locator(FIRST_USE_HOME)
        assert.equal(await home.isVisible(), true); assert.equal(await home.getAttribute('href'), '#/')
        return { hash: new URL(context.page.url()).hash, gesture: 'Finish setup' }
      })
      await context.capture('first-use-wizard-saved')
    } },
  { id: 'first-use-wizard-cold-reopen', title: 'Read the completed first-use profile from disk in a new Electron process',
    controls: ['first-use.wizard.cold-reopen'], requires: ['first-use-wizard-standard'], async run(context) {
      requireFirstUse(context)
      await context.step('first-use-wizard-new-process', () => reopen(context, 'after-wizard'))
      await context.step('first-use-wizard-durable-readback', async () => {
        const saved = assertSavedState(await readFirstUseState(context), expected(context, 'assisted'))
        assert.deepEqual(retainedState(saved), retainedState(context.state.firstUseSaved))
        assert.equal(saved.tier, 'standard')
        context.state.firstUseSaved = saved
        return saved
      })
    } },
  { id: 'first-use-settings-discard', title: 'Discard mounted Setup changes without changing the durable profile or runtime policies',
    controls: ['first-use.settings.discard'], requires: ['first-use-wizard-cold-reopen'], async run(context) {
      requireFirstUse(context)
      await openSetupSettings(context)
      const before = await readFirstUseState(context)
      await context.step('first-use-settings-stage-for-discard', async () => {
        await choose(context, 'autonomy', 'observe'); await choose(context, 'screens', 'demonstration')
        await pendingSettings(context)
        assert.equal(await settings(context).locator('[data-settings-save]').isEnabled(), true)
        assert.equal(await settings(context).locator('[data-settings-discard]').isEnabled(), true)
        const staged = await readFirstUseState(context)
        assert.deepEqual(retainedState(staged), retainedState(before))
        return staged
      })
      await context.step('first-use-settings-discard-gesture', async () => {
        await settings(context).locator('[data-settings-discard]').click()
        await openSetupSettings(context)
        await mountedChoice(context, 'autonomy', 'assisted'); await mountedChoice(context, 'screens', 'live')
        assert.equal(await settings(context).locator('[data-settings-save]').isEnabled(), false)
      })
      await context.step('first-use-discard-new-process', () => reopen(context, 'after-discard'))
      await context.step('first-use-discard-durable-readback', async () => {
        const after = await readFirstUseState(context)
        assert.deepEqual(retainedState(after), retainedState(before))
        return after
      })
    } },
  { id: 'first-use-settings-save', title: 'Save mounted Setup choices through the ordinary Settings draft and durable policy writers',
    controls: ['first-use.settings.save'], requires: ['first-use-settings-discard'], async run(context) {
      requireFirstUse(context)
      await openSetupSettings(context)
      const before = await readFirstUseState(context)
      await context.step('first-use-settings-stage-for-save', async () => {
        await choose(context, 'autonomy', 'observe'); await choose(context, 'screens', 'demonstration')
        await pendingSettings(context)
        const staged = await readFirstUseState(context)
        assert.deepEqual(retainedState(staged), retainedState(before))
        return staged
      })
      await context.step('first-use-settings-save-gesture', async () => {
        await settings(context).locator('[data-settings-save]').click()
        // Save is also disabled while the draft is busy. Observe the actual
        // settled state before reading durable data or allowing a cold close.
        await context.page.locator('#stage > .view:not([inert]) > .settings-page[data-settings-save-state="saved"]').waitFor()
        await mountedChoice(context, 'autonomy', 'observe'); await mountedChoice(context, 'screens', 'demonstration')
        const saved = assertSavedState(await readFirstUseState(context), expected(context, 'observe', 'demonstration'))
        assert.equal(saved.disk.protectedSha256, before.disk.protectedSha256)
        assert.notEqual(saved.raw['mc.setup.profile'], before.raw['mc.setup.profile'])
        assert.equal(saved.custody.registry.absent, true)
        context.state.firstUseSaved = saved
        return saved
      })
      await context.capture('first-use-settings-saved')
    } },
  { id: 'first-use-settings-cold-reopen', title: 'Retain saved Setup policies and mounted Settings choices after a cold application reopen',
    controls: ['first-use.settings.cold-reopen'], requires: ['first-use-settings-save'], async run(context) {
      requireFirstUse(context)
      await context.step('first-use-settings-new-process', () => reopen(context, 'after-settings-save'))
      await openSetupSettings(context)
      await context.step('first-use-settings-final-durable-readback', async () => {
        await mountedChoice(context, 'autonomy', 'observe'); await mountedChoice(context, 'screens', 'demonstration')
        const saved = assertSavedState(await readFirstUseState(context), expected(context, 'observe', 'demonstration'))
        assert.deepEqual(retainedState(saved), retainedState(context.state.firstUseSaved))
        assert.equal(saved.tier, 'standard')
        assert.equal(await settings(context).locator('[data-settings-save]').isEnabled(), false)
        assert.equal(await settings(context).locator('[data-settings-discard]').isEnabled(), false)
        return saved
      })
      await context.capture('first-use-settings-cold-reopened')
    } },
]

module.exports = { scenarios, waitForWorkspacePath, firstUseVisibleExit, firstUseFinishEntersApplication }
