/* TEXT WAS OVERLAPPING TOOL USE: A NEGATIVE MARGIN OUTLIVED THE CONTEXT IT WAS
 * WRITTEN FOR.
 *
 * Owner: "text overlaps tool use."
 *
 * THE RULE, AS WRITTEN 2026-08-20 (src/styles.css):
 *
 *   .chat-action + .chat-action { margin-top: calc(-1 * var(--s1)); }
 *
 * -4px, meant to cancel 4px of the 8px flex `gap` .chat-log spends between
 * its own direct children, leaving a tight 4px between two adjacent
 * top-level action rows ("A RUN OF STEPS READS AS ONE PIECE OF WORK... 8px
 * log gap minus 4", the rule's own comment).
 *
 * FOUR DAYS LATER (2026-08-24) makeActionRun/addToActionRun
 * (src/components.js) changed what "adjacent .chat-action" MEANS. A run's
 * calls are no longer appended straight into `.chat-log`; from the second
 * call on, each is appended into that run's own `.chat-action-run-body` -- a
 * plain block div that carries no CSS rule anywhere in this file, so it is
 * not a flex container and spends no `gap`. The selector above does not know
 * that: it is a bare sibling combinator with no ancestor in it, so it
 * matched there too and kept firing the same -4px with nothing left to
 * cancel it.
 *
 * MEASURED IN SOURCE, before this fix: `.chat-action-run-body` had zero
 * rules anywhere in src/styles.css, and `paintAction`'s only row-creating
 * caller was `addToActionRun`, which never appends to `log` directly -- so
 * every run of two or more calls, live or replayed from a saved
 * conversation, nests its rows, and every one of them past the first drew
 * 4px INTO the row above it: a tool's name, its command, its state word,
 * sliced under the next row's own background and border. Two top-level
 * `.chat-action-run` elements never land adjacent either (a run is reused
 * while it is the log's last child; a new run always follows a `.msg` or a
 * `.chat-context`, never another run) -- so the ONLY place this selector
 * ever actually fired was the nested, broken one.
 *
 * THE FIX scopes the top-level rule to where its own comment says it lives
 * (`.chat-log > .chat-action + .chat-action`, the only place an 8px flex gap
 * exists to spend) and gives the nested case a rule of its own with a real,
 * positive gap instead of a borrowed one -- the same `var(--s1)` list
 * convention `.settings-row + .settings-row` already uses for the same
 * shape, a column of bordered rows.
 *
 * WHAT THIS PINS: the broken selector's exact former (unscoped) shape does
 * not come back; the two replacement rules exist, scoped to where a gap (or
 * a run body) genuinely is; the nested rule's value can never go negative;
 * and the CSS keeps targeting the container the JS actually builds.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const SRC = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'src')
const styles = readFileSync(join(SRC, 'styles.css'), 'utf8')
const components = readFileSync(join(SRC, 'components.js'), 'utf8')

test('the top-level close-up margin is scoped to the log it borrows a gap from', () => {
  assert.match(
    styles,
    /^\.chat-log > \.chat-action \+ \.chat-action \{ margin-top: calc\(-1 \* var\(--s1\)\); \}$/m,
    'the scoped top-level rule is missing, or its shape changed; re-read this pin before trusting it',
  )
})

test('the old UNSCOPED selector -- the actual defect -- has not come back', () => {
  /* Anchored to the start of a line so the two scoped survivors below
     (".chat-log > .chat-action + .chat-action" and
     ".chat-action-run-body > .chat-action + .chat-action") cannot themselves
     satisfy this pattern -- neither begins its line with the bare class. */
  assert.doesNotMatch(
    styles,
    /^\.chat-action \+ \.chat-action \{/m,
    'the unscoped ".chat-action + .chat-action" rule is back: every second-plus ' +
      'call in a run has nothing left to stop it drawing -4px into the row above it',
  )
})

test("a run's own nested calls get a real, positive gap instead of a borrowed one", () => {
  assert.match(
    styles,
    /^\.chat-action-run-body > \.chat-action \+ \.chat-action \{ margin-top: var\(--s1\); \}$/m,
    'the nested-run gap rule is missing, or its shape changed; re-read this pin before trusting it',
  )
})

test('the nested rule truly cannot go negative -- its value is not a negation', () => {
  const rule = /\.chat-action-run-body > \.chat-action \+ \.chat-action \{ margin-top: ([^;]+); \}/.exec(styles)
  assert.ok(rule, 'the nested-run gap rule moved; re-read this pin before trusting it')
  /* Checked for a leading minus or a `calc(-` negation rather than for any
     hyphen at all -- `var(--s1)` carries two hyphens of its own in the
     custom-property name, and a naive "no hyphen anywhere" check would flag
     the correct, positive value along with a genuinely negative one. */
  assert.doesNotMatch(rule[1], /^-|calc\(\s*-/, `the nested rows' margin is "${rule[1]}", which still overlaps them`)
})

test('the CSS still targets the container makeActionRun actually builds', () => {
  /* Ties the selectors above to the real DOM: if the run body's class were
     ever renamed here without the stylesheet following, both nested-case
     rules would stop matching anything and the overlap would come back
     silently -- present in neither a passing test nor a visible rule. */
  assert.match(components, /body\.className = 'chat-action-run-body'/, "makeActionRun no longer names its body this; the nested CSS rule targets nothing")
  assert.match(components, /run\.body\.appendChild\(held\.wrap\)/, 'addToActionRun no longer nests calls inside the run body; the nested rule may now be unused')
})

test('every row-creating path joins a run, so the nested case is the only one that exists', () => {
  /* paintAction's own "first time we have seen this id" branch is the only
     place a NEW action row is created -- live rows and rows replayed from a
     saved conversation both funnel through it (components.js: "AN ACTION IS
     PART OF THE HISTORY TOO... painted by the SAME function the live stream
     uses"). If that branch ever stopped calling addToActionRun, a bare
     top-level ".chat-action" could land as .chat-log's direct child again,
     and the scoped rule two tests up would need a sibling case, not just
     this file's own contentment that nothing reaches it. */
  const newRowBranch = components.slice(
    components.indexOf('const paintAction = (row) => {'),
    components.indexOf('held.wrap.dataset.actionState'),
  )
  assert.ok(newRowBranch.length > 0 && newRowBranch.indexOf('const paintAction') === 0, 'paintAction moved; re-read this pin before trusting it')
  assert.match(newRowBranch, /addToActionRun\(held\)/, 'a new action row no longer joins a run; it may now land as a bare top-level sibling of .chat-log')
})
