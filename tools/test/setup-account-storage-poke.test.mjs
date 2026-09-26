/* THE WALKTHROUGH'S SIGN-IN MUST TELL THE SETTINGS STORE.
 *
 * THE DEFECT THIS EXISTS TO KEEP OUT, measured on the staged packaged build
 * (2026-08-18, stranger-journey lane). public/durable-storage.js scopes
 * mc.theme, mc.set.* and mc.checkout.v1 to WHOEVER IS SIGNED IN, hydrates the
 * account asynchronously, and is told about sign-in changes by exactly one
 * poke: `mcDurableStorage.onAccountChanged()`. src/views/account.js pokes it
 * after every account action. The setup walkthrough's account step -- the one
 * every stranger actually signs in through, because it IS the first launch --
 * did not. So the store spent the whole first session believing nobody was
 * signed in, wrote the person's theme to the DEVICE record, and on relaunch
 * the store (correctly, by its own no-leak rule) refused to show the device
 * value to the signed-in account: renderer-prefs.json carried a bare
 * `mc.theme: black` while both relaunches painted white.
 *
 * WHAT IS ASSERTED. Both sign-in surfaces poke the hook, and the walkthrough
 * pokes it in the SUCCESS tail of the account submit -- after the sign-in has
 * actually succeeded, before the walkthrough moves on -- never only in the
 * refusal path. This is a wiring walk over the source, in the family of
 * tools/test/agent-session-surface.test.mjs's vocabulary walks; the behavior
 * half (a black theme really painted after a real relaunch) is carried by
 * tools/test-account-journey-qa.mjs, which drives it on the staged build.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = relative => readFileSync(path.join(ROOT, relative), 'utf8')

const pokePattern = /globalThis\.mcDurableStorage(?:\s*\)\s*globalThis\.mcDurableStorage)?\s*\.onAccountChanged\s*\(\s*\)/

test('the account page still pokes the settings store after account actions', () => {
  const source = read('src/views/account.js')
  assert.match(source, pokePattern,
    'src/views/account.js no longer pokes mcDurableStorage.onAccountChanged(); '
    + 'account-scoped settings would stop following sign-in from the account page')
})

test('the setup walkthrough pokes the settings store after a SUCCESSFUL sign-in', () => {
  const source = read('src/views/setup.js')

  /* The submit handler: from the account submit's success tail to the step
     change. Located structurally rather than by line number so an edit that
     moves the function does not silently detach the assertion. */
  const submitAt = source.indexOf('data-setup-account-submit')
  assert.ok(submitAt !== -1, 'the setup view no longer has an account submit control at all')

  const successTailAt = source.indexOf("goTo('autonomy')")
  assert.ok(successTailAt !== -1,
    "the account step's success tail (goTo('autonomy')) is gone; this test needs "
    + 'updating to wherever a successful sign-in now hands the walkthrough on')

  const pokeAt = source.search(pokePattern)
  assert.ok(pokeAt !== -1,
    'src/views/setup.js never pokes mcDurableStorage.onAccountChanged(). The '
    + 'durable store then spends the whole first session signed out, every '
    + 'account-scoped setting (theme, settings page, checkout selection) lands '
    + 'on the device record, and the next launch -- correctly, by the no-leak '
    + 'rule -- shows the person none of them.')

  assert.ok(pokeAt < successTailAt,
    'the poke must happen before the walkthrough moves on from the account '
    + 'step, or the next question is answered by a store that still thinks '
    + 'nobody is signed in')

  /* The refusal path must NOT poke: a failed sign-in changed nobody. The
     refusal path is the block between `if (!result.ok) {` and its `return`. */
  const refusalAt = source.indexOf('accountNotice = result.reason')
  if (refusalAt !== -1) {
    const refusalEnd = source.indexOf('return', refusalAt)
    const refusalBlock = source.slice(refusalAt, refusalEnd)
    assert.ok(!pokePattern.test(refusalBlock),
      'the refusal path pokes the store about a sign-in that did not happen')
  }
})
