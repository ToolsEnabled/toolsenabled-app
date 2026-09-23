import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/* THE AGENT PAGE'S CHAT COLUMN FLOOR, PINNED AT SOURCE.
 *
 * The owner's picked chat card ("Dense — light-mode palette",
 * design/chat/picked-card.png) and its SIZING LAW (design/chat/Sizes.dc.html)
 * set the Panel width at 520px. .agentv-panels-wrap > .agentv-panels lays out
 * Chat and Controls as a 1.15fr/auto/1fr grid; undragged, Chat's share used
 * to be able to shrink to nothing (`minmax(0, 1.15fr)`).
 *
 * THE NUMBER NOW LIVES IN ONE PLACE: the --agentv-chat-floor custom property
 * declared on this same rule. src/views/agent.js's resize-handle wiring used
 * to carry its own, unrelated `min: 280`, so a manual drag could claim a
 * width this grid was never going to honour -- the handle tracked the
 * pointer down to 280px while the rendered column silently clamped 240px
 * higher. agent.js now reads --agentv-chat-floor via getComputedStyle()
 * (agentvChatFloorPx(), exported from src/views/agent.js and covered by its
 * own test) instead of repeating "520" as a second literal, so this file's
 * job narrows to pinning that the property is still declared here with the
 * right value and still what the grid's floor is built from.
 *
 * src/views/agent.js is a view factory over a live DOM and cannot be mounted
 * in a node test, so this reads agent.css as source text.
 */

const read = relative => readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8')
const css = read('src/agent.css')

function ruleBody(selector) {
  const start = css.indexOf(selector)
  assert.ok(start >= 0, `selector not found in agent.css: ${selector}`)
  const open = css.indexOf('{', start)
  const close = css.indexOf('}', open)
  return css.slice(open + 1, close)
}

test('the chat column\'s floor custom property is still declared at 520px, the Dense picked card\'s Panel width', () => {
  const body = ruleBody('.agentv-panels-wrap > .agentv-panels {')
  assert.match(body, /--agentv-chat-floor:\s*520px\s*;/,
    'the --agentv-chat-floor custom property is missing, renamed, or no longer 520px -- src/views/agent.js reads this exact property to keep the drag handle in step with the grid')
})

test('the chat column\'s grid floor is built from that same custom property, not a second literal', () => {
  const body = ruleBody('.agentv-panels-wrap > .agentv-panels {')
  assert.match(body, /grid-template-columns:\s*minmax\(var\(--agentv-chat-floor\),\s*1\.15fr\)\s+auto\s+minmax\(0,\s*1fr\)/,
    'the chat column no longer reads --agentv-chat-floor (or the grid template changed shape) -- a bare "520px" here would let this rule and the drag handle drift apart again')
})

test('the Controls column keeps no floor of its own, so it still absorbs the remaining space', () => {
  /* Only Chat gained a floor. If Controls also gained one, the two floors
     could together exceed the product's stated 1024px desktop width once the
     8px handle and the two 12px grid gaps are added, forcing the page to
     scroll sideways at its own stated floor. */
  const body = ruleBody('.agentv-panels-wrap > .agentv-panels {')
  assert.match(body, /minmax\(0,\s*1fr\)\s*;/, 'Controls must stay minmax(0, 1fr)')
})

test('the single-column breakpoint that protects narrower windows survives', () => {
  /* Below this, .agentv-panels collapses to one column and the resize handle
     hides -- the safety net the 520px floor leans on at this product's stated
     1024x768 desktop floor. */
  assert.match(css, /@media \(max-width: 1000px\) \{\s*\.agentv-panels-wrap > \.agentv-panels \{\s*grid-template-columns: minmax\(0, 1fr\);/,
    'the narrow-window single-column fallback for .agentv-panels is gone or changed shape')
})
