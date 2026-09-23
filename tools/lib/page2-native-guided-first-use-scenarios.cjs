'use strict'

const assert = require('node:assert/strict')
const { waitForWorkspacePath } = require('./page2-native-first-use-scenarios.cjs')
const { readGuidedState, retainedGuided, assertGuidedDraft, assertGuidedSaved } = require('./page2-native-guided-first-use.cjs')
const setup = context => context.page.locator('#stage > .view:not([inert]) > .setup-page')
const settings = context => context.page.locator('#stage > .view:not([inert]) > .settings-page')
function requireGuided(context) {
  if (!context.options.sterileFirstUse || context.options.level !== 'guided' || !context.firstUse)
    context.unavailable('This case requires the explicitly selected sterile Guided family')
}
async function openSetupSettings(context) {
  await context.page.locator('nav[aria-label="Primary navigation"] a[data-route="settings"]').click()
  await context.type(settings(context).getByRole('searchbox', { name: 'Search all settings', exact: true }), 'Acting on its own')
  await settings(context).locator('[data-setup-profile-system]').waitFor()
}
async function coldOpen(context) {
  const previous = context.firstUse.receipt.openings.at(-1)
  await context.close()
  assert.equal(context.firstUse.receipt.openings.length, context.firstUse.receipt.closures.length)
  const closed = context.firstUse.receipt.closures.at(-1)
  assert.equal(closed.pid, previous.pid); assert.equal(closed.startTicks, previous.startTicks)
  assert.equal(closed.exited, true); assert.equal(closed.oldIdentityGone, true)
  await context.open()
  const opening = context.firstUse.receipt.openings.at(-1)
  assert.ok(opening.pid !== previous.pid || opening.startTicks !== previous.startTicks)
  return { closed, opening }
}
async function selected(context, field, value) {
  assert.equal(await setup(context).locator(`[data-setup-set="${field}"][data-setup-value="${value}"]`).getAttribute('aria-pressed'), 'true')
}
async function review(context) {
  await setup(context).locator('[data-setup-next="finish"]').waitFor()
  await selected(context, 'autonomy', 'assisted'); await selected(context, 'screens', 'live')
}

const scenarios = [
  { id: 'guided-draft-cancel-and-cold-resume', title: 'Keep the recommended Guided draft through native picker Cancel, Back and a cold visible Setup reopening',
    controls: ['first-use.guided.draft'], requires: ['startup'], async run(context) {
      requireGuided(context)
      assert.equal(context.firstUse.receipt.openings.length, 1)
      await context.page.waitForURL(url => url.hash === '#/setup')
      await context.step('guided-draft-empty-custody', async () => {
        const initial = context.firstUse.receipt.initialPreferences, saved = await readGuidedState(context)
        assert.equal(initial.absent, true); assert.equal(saved.profile, null); assert.equal(saved.disk.machine.absent, true)
        context.state.guidedInitial = saved
        return { initialPreferences: initial, saved }
      })
      await context.step('guided-draft-recommended-tier', async () => {
        const button = setup(context).locator('button[data-setup-tier="guided"]')
        assert.equal(await button.getAttribute('aria-pressed'), 'true')
        const text = await button.innerText(); assert.match(text, /I’m new to this/); assert.match(text, /Recommended/)
        await setup(context).locator('[data-setup-continue]').click()
        await setup(context).locator('[data-setup-choose-root]').waitFor()
        const saved = assertGuidedDraft(await readGuidedState(context), { roots: [], step: 'workspace' })
        context.state.guidedTierBaseline = saved
        return { recommendation: text, saved }
      })
      await context.step('guided-draft-picker-cancel', async () => {
        const before = await readGuidedState(context), beforeText = await setup(context).locator('.setup-root-path').allTextContents()
        await setup(context).locator('[data-setup-choose-root]').click()
        const picker = await context.picker({ operation: 'cancel', title: 'Choose a folder for your assistant to work in' })
        // Read the mounted result and persisted draft independently. Picker
        // completion never stands in for the later exact-path paint wait.
        const saved = await readGuidedState(context)
        assert.deepEqual(retainedGuided(saved), retainedGuided(before))
        assert.deepEqual(await setup(context).locator('.setup-root-path').allTextContents(), beforeText)
        return { picker, beforeText, saved }
      })
      await context.step('guided-draft-picker-select', async () => {
        await setup(context).locator('[data-setup-choose-root]').click()
        const picker = await context.picker({ operation: 'select-path', title: 'Choose a folder for your assistant to work in', selectedPath: context.paths.workspace })
        await waitForWorkspacePath(context)
        const displayedPath = await setup(context).locator('.setup-root-path').innerText()
        assert.equal(displayedPath, context.paths.workspace)
        const saved = assertGuidedDraft(await readGuidedState(context), { roots: [context.paths.workspace], step: 'workspace', baseline: context.state.guidedTierBaseline })
        return { picker, displayedPath, saved }
      })
      await context.step('guided-draft-back-forward', async () => {
        await setup(context).locator('[data-setup-next="account"]').click()
        await setup(context).getByRole('button', { name: 'Not now', exact: true }).click()
        await selected(context, 'autonomy', 'assisted')
        await setup(context).locator('[data-setup-back="account"]').click()
        await setup(context).getByRole('button', { name: 'Not now', exact: true }).click()
        await setup(context).locator('[data-setup-next="review"]').click()
        await review(context)
        const saved = assertGuidedDraft(await readGuidedState(context), { roots: [context.paths.workspace], step: 'review', baseline: context.state.guidedTierBaseline })
        context.state.guidedDraft = saved
        return { saved }
      })
      await context.step('guided-draft-cold-resume', async () => {
        const lifetime = await coldOpen(context)
        // A recorded tier clears firstRunPending; unfinished profile status is
        // not a promise of automatic routing. Use the real visible affordance.
        await context.page.waitForURL(url => url.hash !== '#/setup')
        await openSetupSettings(context)
        await settings(context).locator('[data-setup-profile-action="walkthrough"]').click()
        await context.page.waitForURL(url => url.hash === '#/setup'); await review(context)
        const saved = assertGuidedDraft(await readGuidedState(context), { roots: [context.paths.workspace], step: 'review', baseline: context.state.guidedTierBaseline })
        assert.deepEqual(retainedGuided(saved), retainedGuided(context.state.guidedDraft))
        return { ...lifetime, routeGesture: 'Settings → Open setup', saved }
      })
      await context.capture('guided-draft-cold-resumed')
    } },
  { id: 'guided-recommended-finish-and-exit', title: 'Finish recommended Guided Assisted Live setup, retain account deferral and leave through visible navigation',
    controls: ['first-use.guided.finish'], requires: ['guided-draft-cancel-and-cold-resume'], async run(context) {
      requireGuided(context)
      await context.step('guided-finish-review-readiness', async () => {
        await review(context)
        const statuses = await setup(context).locator('[role="status"]').allTextContents()
        assert.ok(statuses.length > 0)
        return { statuses, saved: assertGuidedDraft(await readGuidedState(context), { roots: [context.paths.workspace], step: 'review', baseline: context.state.guidedTierBaseline }),
          readinessObservation: 'Actual rendered copy only; no provider availability or signed-in claim inferred' }
      })
      /* FINISH IS THE EXIT. Measured 2026-09-11 on the packaged 1.0.44 Linux
         candidate: this press left the build at hash=#/setup, because the
         account-policy deferral -- unavoidable with no account list, i.e. on
         every fresh installation -- was filed as a refusal and returned.
         src/views/setup.js records it durably and navigates, so the recommended
         Guided walk now ends where a person expects it to. NOT EXECUTED IN THIS
         LANE: these scenarios need a Playwright host and this one has none. */
      await context.step('guided-finish-enters-the-application', async () => {
        await setup(context).locator('[data-setup-next="finish"]').click()
        await context.page.waitForURL(url => url.hash === '#/', { timeout: 20000 })
        await context.page.locator('#stage > .view:not([inert]) > .home').waitFor({ state: 'visible', timeout: 12000 })
        assert.equal(await setup(context).count(), 0, 'Finish must leave no mounted Setup behind.')
        const saved = assertGuidedSaved(await readGuidedState(context), context.paths.workspace)
        assert.equal(saved.disk.protectedSha256, context.state.guidedDraft.disk.protectedSha256)
        assert.match(saved.profile.accountPolicyDeferred?.reason || '', /no provider accounts to switch between yet/,
          'The one intent that could not be recorded must be recorded: the machine defaults to the opposite of it.')
        context.state.guidedSaved = saved
        return { expectedPolicyRefusal: 'ACCOUNT_REGISTRY_ABSENT', observation: 'actual Finish navigation plus exact absent registry', saved }
      })
      await context.step('guided-finish-requested-effective-readback', async () => {
        const saved = assertGuidedSaved(await readGuidedState(context), context.paths.workspace)
        assert.deepEqual(retainedGuided(saved), retainedGuided(context.state.guidedSaved))
        return { saved, effective: { approvals: 'stop', attach: 'mirror', ideImport: 'none', failover: 'manual' },
          limit: 'Attach and effective account ceiling are source-bound intentions; no editor attachment or account switch was executed' }
      })
      await context.step('guided-finish-visible-exit', async () => {
        /* The gesture is now Finish itself, so what is left to prove is that it
           was Finish and not a restart: still one opening, no closures, and the
           primary navigation reachable from where it landed. */
        assert.deepEqual(context.firstUse.receipt.closures, [], 'Finish must not have needed a cold restart to reach home')
        assert.equal(context.firstUse.receipt.openings.length, 1)
        const home = context.page.locator('nav[aria-label="Primary navigation"] a[data-route="home"]')
        assert.equal(await home.isVisible(), true, 'The application Finish entered must offer its primary navigation')
        assert.equal(await home.getAttribute('href'), '#/')
        return { gesture: 'Finish setup', hash: new URL(context.page.url()).hash,
          opening: context.firstUse.receipt.openings.at(-1) }
      })
      await context.step('guided-finish-cold-durable', async () => {
        const lifetime = await coldOpen(context)
        await context.page.waitForURL(url => url.hash !== '#/setup'); await openSetupSettings(context)
        for (const [field, value] of [['autonomy', 'assisted'], ['screens', 'live'], ['tier', 'guided']]) {
          assert.equal(await settings(context).locator(`[data-setup-profile-set="${field}"][data-setup-profile-value="${value}"]`).getAttribute('aria-pressed'), 'true')
        }
        const saved = assertGuidedSaved(await readGuidedState(context), context.paths.workspace)
        assert.deepEqual(retainedGuided(saved), retainedGuided(context.state.guidedSaved))
        return { ...lifetime, saved }
      })
      await context.capture('guided-finish-cold-durable')
    } },
]

module.exports = { scenarios, coldOpen, requireGuided }
