import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/* THE JS HALF OF THE CHAT-COLUMN-FLOOR FIX, PINNED WHERE agent.js CANNOT BE
 * MOUNTED AND PROVEN WHERE IT CAN.
 *
 * agent.js carries `import '../agent.css'` (a side-effect import plain
 * node:test's ESM loader cannot resolve -- "Unknown file extension .css",
 * confirmed by trying it), so no test in this suite `import`s agent.js
 * directly; every one that needs a piece of it (agent-session-surface,
 * orchestration-controls, palette-rows...) reads it as source text instead.
 * agentvChatFloorPx() is a small, standalone, dependency-free function (only
 * parseFloat/Number.isFinite, both global), so it is sliced out by name and
 * evaluated with `new Function`, the same technique palette-rows.test.mjs
 * already uses against this same file's chatActionRowsFor/runPaletteAction.
 *
 * agent-chat-column-floor.test.mjs pins agent.css's side: the grid's own
 * minmax(--agentv-chat-floor, 1.15fr) refuses to shrink the chat column
 * below the declared 520px. That alone does not prove the DRAG HANDLE
 * agrees -- before this fix it did not: attachResizeHandle() was wired with
 * a hardcoded `min: 280`, so a manual drag tracked the pointer down to
 * 280px while the grid silently clamped the rendered column 240px higher.
 * The handle looked live; the number it reported was a lie about where the
 * column actually stopped.
 *
 * agentvChatFloorPx() is the fix: a small, pure, exported function --
 * src/views/agent.js:93-118 -- that reads the SAME --agentv-chat-floor
 * custom property the CSS rule declares, so there is one number instead of
 * two. It takes anything CSSStyleDeclaration-shaped (a getPropertyValue(name)
 * method), not an element, specifically so it is callable here with a plain
 * stub even though agentView() itself (the surrounding view factory) still
 * cannot be mounted in a node test -- the same constraint
 * agent-chat-column-floor.test.mjs already documents.
 *
 * Two things are proven, not assumed:
 *   1. This function genuinely reads through to whatever the property says
 *      (not a hardcoded 520 wearing a function's clothes) -- proven with a
 *      DIFFERENT value than 520 below.
 *   2. It fails TOWARD the floor holding, not toward the old bug reopening,
 *      when the property cannot be read at all.
 */

const agentSource = readFileSync(fileURLToPath(new URL('../../src/views/agent.js', import.meta.url)), 'utf8')

function extractFunction(name, source) {
  const start = source.indexOf(`export function ${name}`)
  assert.ok(start >= 0, `function ${name} was not found in agent.js -- renamed, removed, or no longer exported`)
  const bodyOpen = source.indexOf('{', start)
  let depth = 0
  let end = bodyOpen
  for (; end < source.length; end++) {
    if (source[end] === '{') depth++
    else if (source[end] === '}') { depth--; if (depth === 0) { end++; break } }
  }
  // Strip the leading "export " so `new Function` sees a plain declaration.
  return source.slice(start, end).replace(/^export\s+/, '')
}

const agentvChatFloorPx = new Function(`${extractFunction('agentvChatFloorPx', agentSource)}\nreturn agentvChatFloorPx;`)()

test('agentvChatFloorPx reads the real value of --agentv-chat-floor, not a hardcoded number', () => {
  const styleAt = px => ({ getPropertyValue: name => (name === '--agentv-chat-floor' ? `${px}px` : '') })
  assert.equal(agentvChatFloorPx(styleAt(520)), 520, 'must read the CSS rule\'s actual 520px value')
  assert.equal(agentvChatFloorPx(styleAt(640)), 640,
    'must track a DIFFERENT declared value too -- proves this reads through the property rather than always answering a hardcoded 520')
})

test('agentvChatFloorPx fails toward the floor holding, never toward the old 280px bug', () => {
  const missing = { getPropertyValue: () => '' }
  const unreadable = { getPropertyValue: () => 'not-a-length' }
  const noMethod = {}
  for (const [label, style] of [['empty property', missing], ['unparsable value', unreadable], ['no getPropertyValue at all', noMethod]]) {
    assert.equal(agentvChatFloorPx(style), 520, `${label}: must fall back to the CSS rule's own 520, never something lower`)
  }
})

test('agentvChatFloorPx rejects a zero or negative reading the same way', () => {
  const style = { getPropertyValue: () => '0px' }
  assert.equal(agentvChatFloorPx(style), 520, 'a nonsensical zero-width floor must not be trusted over the safe default')
})

/* THE WIRING ITSELF, PINNED AT SOURCE per agent-chat-column-floor.test.mjs's
 * own established reason: the view factory that calls attachResizeHandle()
 * cannot be mounted here. This closes the loop the two behavioural tests
 * above cannot: that the resize handle's `min` option is actually built
 * from agentvChatFloorPx(getComputedStyle(...)) rather than a literal, and
 * that no bare numeric `min:` survives at that call site by accident.
 * Reuses the same agentSource text read above. */
function callSite() {
  const marker = "attachResizeHandle(agentvResizeHandle, {"
  const start = agentSource.indexOf(marker)
  assert.ok(start >= 0, 'the agentv-panels-resize attachResizeHandle call was not found at all -- wiring likely moved or was removed')
  const end = agentSource.indexOf('})', start)
  return agentSource.slice(start, end)
}

test('the resize handle\'s min option is wired to agentvChatFloorPx(getComputedStyle(...)), not a literal', () => {
  const body = callSite()
  assert.match(body, /min:\s*agentvChatFloorPx\(getComputedStyle\(agentvPanels\)\)/,
    'the drag handle\'s min is no longer reading the live CSS floor -- it may have regressed to a hardcoded number')
  assert.doesNotMatch(body, /min:\s*\d/,
    'a bare numeric min crept back into the attachResizeHandle call -- this is exactly the shape of the original 280px bug')
})
