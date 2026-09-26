/* ⇧⇥ (SHIFT+TAB) CYCLES THE AGENT CHIP'S MODE — COMPOSER-FOCUSED ONLY.
 *
 * Bound on the composer's own <input> keydown handler (onInputKeydown),
 * never on document or window: a global handler would fire the moment a
 * person hits Shift+Tab ANYWHERE on the page, including while reading a
 * different agent's transcript or with focus on an entirely different
 * control. this is the same discipline every other composer shortcut here
 * already follows (the slash command, ⇧⏎).
 *
 * A control that does nothing must not also eat the key that would
 * otherwise do something else: with no chips.onCycleTier, the handler must
 * not call preventDefault, so the browser's native Shift+Tab
 * focus-reverse keeps working exactly as it would with no handler bound at
 * all.
 *
 * Source pins, deliberately: buildChat needs a DOM to run, and the harness
 * here has none.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')
const components = readFileSync(join(SRC, 'components.js'), 'utf8')
const chat = components.slice(components.indexOf('export function buildChat'))
const onInputKeydown = chat.slice(chat.indexOf('const onInputKeydown = (e)'), chat.indexOf('const onCloseClick'))

test('the cycle only fires on Tab+shiftKey, guarded by chips.onCycleTier, inside onInputKeydown', () => {
  assert.match(onInputKeydown,
    /if \(e\.key === 'Tab' && e\.shiftKey && chips && typeof chips\.onCycleTier === 'function'\) \{/,
    'the Shift+Tab branch is gone, moved, or lost one of its guards -- it must be Tab AND shiftKey AND a real chips.onCycleTier function')
})

test('preventDefault is called only inside the guarded branch, never before it', () => {
  const branch = onInputKeydown.slice(
    onInputKeydown.indexOf(`e.key === 'Tab' && e.shiftKey`),
    onInputKeydown.indexOf(`e.key === 'Tab' && e.shiftKey`) + 220,
  )
  assert.match(branch, /e\.preventDefault\(\)/, 'the guarded branch no longer calls preventDefault, so chips.onCycleTier firing would still let the key act as an ordinary Tab')
  assert.match(branch, /chips\.onCycleTier\(\)/, 'the guarded branch no longer calls chips.onCycleTier')
  /* No preventDefault call exists in onInputKeydown BEFORE this branch --
     if one did, Shift+Tab would be swallowed even with chips.onCycleTier
     absent, breaking native focus-reverse for every caller that has not
     wired the cycle. */
  const before = onInputKeydown.slice(0, onInputKeydown.indexOf(`e.key === 'Tab' && e.shiftKey`))
  assert.doesNotMatch(before, /e\.preventDefault\(\)[\s\S]*e\.key === 'Tab'/,
    'a preventDefault before the Tab guard would swallow Shift+Tab unconditionally')
})

test('the binding is on the input element itself, never document or window', () => {
  /* onInputKeydown is attached exactly once, to input's own keydown --
     pinned by chat-composer.test.mjs's existing suite implicitly (the slash
     command and ⇧⏎ live in the same handler); this asserts the ONE
     attachment point directly, so a future change that ALSO binds
     onInputKeydown (or a copy of it) to document/window cannot pass
     silently. */
  const attachments = chat.match(/addEventListener\('keydown', onInputKeydown\)/g) || []
  assert.equal(attachments.length, 1, `onInputKeydown is attached ${attachments.length} time(s); expected exactly 1 (the composer input)`)
  assert.match(chat, /input\.addEventListener\('keydown', onInputKeydown\)/,
    'onInputKeydown is no longer bound to the composer input specifically')
  assert.doesNotMatch(chat, /document\.addEventListener\('keydown', onInputKeydown\)/, 'onInputKeydown must never be bound to document')
  assert.doesNotMatch(chat, /window\.addEventListener\('keydown', onInputKeydown\)/, 'onInputKeydown must never be bound to window')
})
