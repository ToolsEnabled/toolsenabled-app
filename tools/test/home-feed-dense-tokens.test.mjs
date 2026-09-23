import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/* THE HOME FEED, STYLE-UNIFIED ONTO THE DENSE TOKENS, PINNED AT SOURCE.
 *
 * The owner's picked chat card ("Dense — light-mode palette",
 * design/chat/picked-card.png) and its SIZING LAW (design/chat/Sizes.dc.html)
 * set a type scale of 13.5/12/11/10.5px and a 3px corner radius. This is a
 * STYLE unification only -- src/views/home.js still builds its own hand-rolled
 * feed (the run list, the coordinator thread, the panel chrome); nothing here
 * converts it to buildChat. The scope is the feed panel itself (session-head,
 * the turns, the run rows, the thread heading) -- the hero ring/facts above it
 * are a different design region and are untouched.
 *
 * A plain node run cannot mount src/views/home.js (it builds live DOM), so
 * this reads the stylesheet as source text, same as every other pin in this
 * suite for a view that imports a stylesheet.
 */

const read = relative => readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8')
const css = read('src/home.css')
const HOME_JS = read('src/views/home.js')

/** Pull a rule's body out by its selector, the same slice-between-strings
 * idiom tools/test/home-screen.test.mjs already uses on this same file. */
function ruleBody(selector) {
  const start = css.indexOf(selector)
  assert.ok(start >= 0, `selector not found in home.css: ${selector}`)
  const open = css.indexOf('{', start)
  const close = css.indexOf('}', open)
  return css.slice(open + 1, close)
}

test('the panel header and badge snap to the Dense type scale and 3px radius', () => {
  assert.match(ruleBody('.home .session-head {'), /font-size:\s*12px/,
    'session-head was 12.5px; the Dense scale has no 12.5 step')
  const badge = ruleBody('.home .panel-badge {')
  assert.match(badge, /font-size:\s*11px/, 'panel-badge already sat on the 11px step')
  assert.match(badge, /border-radius:\s*var\(--r-md, 3px\)/,
    'panel-badge used --r-sm (2px); the Dense radius token is 3px (--r-md)')
})

test('the coordinator thread\'s turn labels and body text snap to the Dense scale', () => {
  assert.match(ruleBody('.home .turn-who {'), /font-size:\s*11px/,
    'turn-who was 11.5px; the Dense scale has no 11.5 step')
  assert.match(ruleBody('.home .turn-text {'), /font-size:\s*13\.5px/,
    'turn-text was 13px; Dense body text is 13.5px')
})

test('the run rows snap to the Dense scale', () => {
  assert.match(ruleBody('.home-run {'), /font-size:\s*13\.5px/,
    'the run row\'s base size was 13px; Dense body text is 13.5px')
  const meta = ruleBody('.home-run .run-agent,\n.home-run .run-asked,\n.home-run .run-did,\n.home-run .run-said,\n.home-run .run-why,\n.home-run .run-gap {')
  assert.match(meta, /font-size:\s*12px/, 'the run row\'s meta lines were 12.5px; the Dense scale has no 12.5 step')
  assert.match(ruleBody('.home-run .run-brief {'), /font-size:\s*12px/, 'run-brief was 12.5px')
  assert.match(ruleBody('.home-run .run-when {'), /font-size:\s*12px/, 'run-when was 12.5px')
  /* .log-thread-head is gone from the product: the thread is the shared chat
     surface now and it brings its own head, so views/home.js no longer builds
     this element and home.css no longer dresses it. This pinned the element's
     TYPE SIZE, so it failed the removal rather than the defect it was written
     for. It is kept, not deleted, and pointed at the pair instead: if the head
     ever comes back it must come back on the Dense scale, and it must not come
     back in the markup without a rule to dress it. Same shape as the
     tolerate-removal check in home-turn-surfaces.test.mjs. */
  const headStyled = css.indexOf('.home .log-thread-head {') >= 0
  const headBuilt = /class="log-thread-head/.test(HOME_JS)
  assert.equal(headStyled, headBuilt,
    headBuilt ? 'views/home.js builds .log-thread-head but home.css no longer dresses it'
              : 'home.css still dresses .log-thread-head, which views/home.js no longer builds')
  if (headStyled) assert.match(ruleBody('.home .log-thread-head {'), /font-size:\s*12px/, 'log-thread-head was 12.5px')
})

test('the "next step" door\'s corner unifies onto the 3px radius token', () => {
  assert.match(ruleBody('.home-next {'), /border-radius:\s*var\(--r-md, 3px\)/,
    'home-next carried its own 8px radius, off the Dense 3px token')
})

test('no rule inside the feed panel is left on the retired 12.5px/11.5px steps', () => {
  /* The feed panel is TWO sections in this file, split by the hero ring
     region in between (a different design region this lane does not touch,
     and whose own .home-fact is deliberately still 12.5px) and followed by
     the full-page takeover chrome (also untouched): the session/thread chrome
     (session-head, panel-badge, turns, the dead-but-harmless .home-door rules
     snapped alongside it) and, further down past the whole hero section, the
     run rows (log-thread-head, session-foot). Each slice stops at the next
     section header. */
  const threadStart = css.indexOf('The coordinator session thread')
  const heroStart = css.indexOf('Home hero')
  const runsStart = css.indexOf('What has actually run on this computer.')
  const fullPageStart = css.indexOf('THE FULL PAGE.')
  assert.ok(
    threadStart >= 0 && heroStart > threadStart && runsStart > heroStart && fullPageStart > runsStart,
    'the feed-panel section markers moved; re-anchor this scan',
  )
  const panel = css.slice(threadStart, heroStart) + css.slice(runsStart, fullPageStart)
  assert.doesNotMatch(panel, /font-size:\s*12\.5px/, 'a 12.5px rule survived the Dense unification')
  assert.doesNotMatch(panel, /font-size:\s*11\.5px/, 'an 11.5px rule survived the Dense unification')
})
