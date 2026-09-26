/* THE OPEN-AGENT DOOR MUST NEVER LEAVE THE SCREEN, AND MUST COME BACK OPENABLE.
 *
 * MEASURED on the shipped build, 2026-08-19: on a fresh fleet page the graph
 * bar offers "Open agent detail" (aimed at the first declared seat -- the
 * earlier fix that made the door exist before anything is clicked). Click any
 * node in YOUR OWN tree, press Back, and the door NEVER RETURNED: display
 * none, 0x0, for the rest of the visit. The restore in showStats closed that.
 *
 * MEASURED AGAIN on the desktop press-through, 2026-08-27, one step earlier in
 * the same sequence: the door was gone *while the agent was selected* -- a
 * 0-width button with no rail equivalent, so the only route to an agent's
 * detail page was to deselect first. The cause was the same line the earlier
 * fix worked around: the tree branch aimed the door at NOTHING, and a null
 * target renders as `hidden`.
 *
 * SO THE RULE CHANGED, and this file is rewritten around it rather than
 * deleted (its own earlier text asked for exactly that). Hiding is for genuine
 * absence -- no agent anywhere for a door to name. A SELECTED agent is not
 * absence: the door stays on screen, marked unavailable, carrying the reason
 * in words, and a press is answered rather than swallowed. Leaving the
 * selection re-aims it at the openable default, which is what the 2026-08-19
 * fix was for and still is.
 *
 * Source-contract test, same idiom and reason as
 * tree-approval-pending.test.mjs: this view cannot be imported into a unit
 * test, so the wiring's shape is pinned where its behaviour cannot be. The
 * sentences themselves are asserted by value in
 * tools/test/computers-press-honesty.test.mjs.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const view = readFileSync(path.resolve(HERE, '..', '..', 'src', 'views', 'computers.js'), 'utf8')

/* The slice is BOUNDED BY A MARKER THAT EXISTS. It used to end at
   `showControls(agent)` -- a string this file has never contained -- so
   indexOf returned -1, slice(0, -1) ran to the end of the module, and the
   assertion was satisfied by an unrelated setOpenTarget(null) hundreds of
   lines away. It passed on both sides of the defect it was written to catch. */
function selectionBranch() {
  const at = view.indexOf('onOpenControls: (agent) =>')
  assert.ok(at > -1, 'the graph selection callback is gone; find where a press lands and pin that instead')
  const end = view.indexOf('onRootChange:', at)
  assert.ok(end > at, 'onRootChange no longer follows onOpenControls; re-aim this slice')
  return view.slice(at, end)
}

test('selecting a tree agent aims the door at that agent, never at nothing', () => {
  const body = selectionBranch()
  assert.match(body, /if \(agent\?\.treeNode\) \{[\s\S]*?setOpenTarget\(agent\)/,
    'the tree branch no longer aims the door at the agent that was just pressed')
  assert.doesNotMatch(body, /setOpenTarget\(null\)/,
    'the tree branch aims the door at nothing again -- a null target renders as hidden, so the door vanishes exactly when an agent is selected')
})

test('Fleet overview stays available even before a conversation is selected', () => {
  const at = view.indexOf('function syncOpenButton()')
  assert.ok(at > -1, 'syncOpenButton is gone; find what sizes the door and pin that instead')
  const body = view.slice(at, view.indexOf('function setOpenTarget', at))
  assert.match(body, /openButton\.hidden = false/)
  assert.match(body, /openButton\.textContent = 'Fleet overview'/)
  const click = view.slice(view.indexOf("openButton.addEventListener('click'"), view.indexOf("editButton.addEventListener('click'"))
  assert.match(click, /graph\?\.workspace\?\.showTrees\(\{ focus: false \}\)/,
    'the overview keeps the current shared workspace rather than replacing its conversation')
  assert.match(click, /showStats\(\)/)
  assert.doesNotMatch(click, /navigate\(/)
})

test('returning to the overview re-aims the door instead of leaving it unopenable', () => {
  const at = view.indexOf('function showStats()')
  assert.ok(at > -1, 'showStats is gone; find where Back lands and pin that instead')
  const body = view.slice(at, view.indexOf('\n  }', at))
  assert.match(body, /setOpenTarget\([^)]*firstDeclaredTarget\(\)\)/,
    'Back from a tree node leaves the Open-agent door hidden for the rest of the visit -- measured display:none 0x0 after one click on an own agent, on the shipped build')
  assert.match(body, /openTarget\.treeNode/,
    'the restore no longer re-aims a door still pointed at a tree agent, so Back leaves it stated-unavailable for the rest of the visit')
})
