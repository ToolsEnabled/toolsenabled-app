import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

/* WHAT THE TWO PRESS-THROUGHS PROVED AND THESE PINS KEEP FIXED (2026-08-27).
 *
 * The desktop and phone press-throughs pressed every control on /app/#/computers
 * under one rule — a press must visibly change something OR state a refusal in
 * words — and found the places this view fell silent: the "Open agent detail"
 * door vanished at the moment of selection, Escape closed every layer except
 * the agent rail, and two chips (Edit, Start tree) kept their whole explanation
 * in a tooltip no finger can reach. The repairs are wiring inside a DOM module
 * the size of a small program, so these are source pins in the idiom of
 * computers-account-door.test.mjs: they hold WHICH gate answers, not how it is
 * painted. The values (the refusal sentences, the pure placement rules) are
 * asserted by value in their own suites. */

const VIEW = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
const GRAPH_CSS = readFileSync(new URL('../../src/tree-graph.css', import.meta.url), 'utf8')
const PHONE_CSS = readFileSync(new URL('../../src/phone-canvas.css', import.meta.url), 'utf8')
const require_ = createRequire(import.meta.url)
const { parse: parseCss } = createRequire(require_.resolve('vite/package.json'))('postcss')
const refusalSelectors = [
  '.computers .graph-tree-start[disabled]',
  '.computers .graph-tree-start[aria-disabled="true"]',
  '.computers .graph-open-btn[aria-disabled="true"]',
]
function refusalRules(css) {
  return parseCss(css).nodes.filter(node => node.type === 'rule'
    && refusalSelectors.every(selector => node.selectors.includes(selector)))
}
function hasRefusalDress(css) {
  const rules = refusalRules(css)
  if (rules.length !== 1) return false
  return Object.entries({ color: 'var(--ink-3)', 'border-style': 'dashed', cursor: 'default' }).every(([prop, value]) => {
    const declaration = rules[0].nodes.findLast(node => node.type === 'decl' && node.prop === prop)
    return declaration?.value === value && !declaration.important
  })
}

/* ---------- the Open agent detail door ---------- */

test('selecting a tree agent keeps the open door on screen, stated, never removed', () => {
  /* F5: the header button was 0-width the moment a bubble was pressed,
     because the tree branch aimed the target at null. */
  const graphBranch = VIEW.slice(VIEW.indexOf('onOpenControls: (agent) =>'), VIEW.indexOf('onRootChange:'))
  assert.match(graphBranch, /if \(agent\?\.treeNode\) \{[\s\S]*?setOpenTarget\(agent\)[\s\S]*?showTreeNodeControls\(agent\.treeNode\)/,
    'the graph’s tree branch stopped aiming the door at the selected agent')
  assert.doesNotMatch(graphBranch, /setOpenTarget\(null\)/,
    'the graph’s selection path nulls the open target again — the door will vanish exactly when an agent is selected')

  const ledgerBranch = VIEW.slice(VIEW.indexOf('onPressAgent: (agent) =>'), VIEW.indexOf('onPressAdd:'))
  assert.match(ledgerBranch, /if \(agent\?\.treeNode\) \{[\s\S]*?setOpenTarget\(agent\)/,
    'the ledger’s press path and the graph’s no longer share the one selection rule')

  /* The workspace keeps chats in tabs; this door opens the fleet side panel. */
  const sync = VIEW.slice(VIEW.indexOf('function syncOpenButton'), VIEW.indexOf('function setOpenTarget'))
  assert.match(sync, /openButton\.hidden = false/)
  assert.match(sync, /Fleet overview/)
  const click = VIEW.slice(VIEW.indexOf("openButton.addEventListener('click'"), VIEW.indexOf("editButton.addEventListener('click'"))
  assert.match(click, /graph\?\.workspace\?\.showTrees\(\{ focus: false \}\)/)
  assert.match(click, /showStats\(\)/)
  assert.doesNotMatch(click, /navigate\(/)
})

test('the full chat door uses agents from the current graph, including its example world', () => {
  const graph = readFileSync(new URL('../../src/tree-graph.js', import.meta.url), 'utf8')
  const open = graph.slice(graph.indexOf('  openFullChat('), graph.indexOf('  _syncConversationShelf()'))
  assert.match(open, /this\.computer\?\.agents\?\.find/)
  assert.match(open, /this\.openChat\(/)
  assert.doesNotMatch(open, /declaredAgentsData|sampleFleetData|navigate\(/)
})

test('leaving a tree-agent selection re-aims the door at the openable default', () => {
  const stats = VIEW.slice(VIEW.indexOf('function showStats'), VIEW.indexOf('const DEAD_ACTIONS'))
  assert.match(stats, /if \(!openTarget \|\| openTarget\.treeNode\) setOpenTarget\(computer\?\.agents\?\.\[0\] \|\| firstDeclaredTarget\(\)\)/,
    'the overview no longer re-aims a tree-agent door; after Back the door stays unavailable for the rest of the visit')
})

/* ---------- Escape leaves the agent rail ---------- */

test('Escape closes the agent rail, in capture, one layer per press', () => {
  const escape = VIEW.slice(VIEW.indexOf('const onRailEscape'), VIEW.indexOf("document.addEventListener('keydown', onRailEscape, true)"))
  assert.ok(escape.length > 0, 'the rail Escape handler is gone; “‹ Back” is the rail’s only exit again')
  /* The layers whose own handlers own the press. */
  /* The guard reads `if (phoneCanvas || chatOnly) return`: the phone sheet
     still owns the press, and a second layer was added beside it. Allow further
     alternatives, but keep phoneCanvas required, so removing it still fails. */
  assert.match(escape, /if \(phoneCanvas(?:\s*\|\|[^)]*)?\) return/, 'the phone sheet lost its ownership of Escape')
  assert.match(escape, /\.drawer\.open/, 'the modal drawer’s press is taken from it')
  assert.match(escape, /\.chat-actions-pop/, 'the actions popover’s press is taken from it')
  assert.match(escape, /record\.chatOpen/, 'an open chat card’s press is taken from tree-graph')
  assert.match(escape, /'INPUT' \|\| tag === 'TEXTAREA' \|\| tag === 'SELECT'/,
    'Escape inside a text control no longer stays with that control')
  /* The act: clear the ring, return to the overview. */
  assert.match(escape, /graph\?\.select\(null\)/, 'Escape leaves the bubble wearing a selected ring beside a fleet-overview rail')
  assert.match(escape, /showStats\(\)/, 'Escape no longer returns the rail to the overview')
  /* Capture is load-bearing: bubble listeners registered after main.js’s
     drawer handler would read a world that handler already changed and close
     two layers on one press. */
  assert.match(VIEW, /document\.addEventListener\('keydown', onRailEscape, true\)/,
    'the rail Escape left the capture phase; it now races the drawer’s own handler')
  assert.match(VIEW, /document\.removeEventListener\('keydown', onRailEscape, true\)/,
    'the document-level listener is never removed; it outlives the view')
})

/* ---------- refusals a finger can read ---------- */

test('Edit and Start tree answer a press in words instead of dying in a tooltip', () => {
  /* Phone F3: both were `disabled` with the whole explanation in title/aria —
     a silent dead control on touch. aria-disabled keeps the press deliverable
     and each handler’s first gate states the sentence in the status line. */
  const sync = VIEW.slice(VIEW.indexOf('function syncEditAvailability'), VIEW.indexOf('function handleReparent'))
  assert.match(sync, /setAttribute\('aria-disabled', 'true'\)/, 'the blocked Edit is no longer marked aria-disabled')
  assert.doesNotMatch(sync, /editButton\.disabled\s*=/,
    'Edit is hard-disabled again: the press is swallowed and the refusal is unreachable on touch')
  const editClick = VIEW.slice(VIEW.indexOf("editButton.addEventListener('click'"), VIEW.indexOf("resetButton.addEventListener('click'"))
  assert.match(editClick, /aria-disabled.*=== 'true'[\s\S]*?setOrgStatus\(editButton\.title, 'refuse'\)/,
    'a press on blocked Edit no longer states its reason')

  const starts = VIEW.slice(VIEW.indexOf('function refreshTreeStartControls'), VIEW.indexOf('function refreshTreeSwitch'))
  assert.match(starts, /setAttribute\('aria-disabled', 'true'\)/, 'an unavailable Start tree is hard-disabled again')
  assert.match(starts, /button\.disabled = startingTreeIds\.has\(tree\.id\)/,
    'the momentary in-flight disable was lost, or widened back over the stated case')
  /* And the face says so: the chips had NO disabled dress at all. */
  assert.equal(hasRefusalDress(GRAPH_CSS), true,
    'the unavailable chips lost their visible dress; they read as live controls again')
  assert.match(GRAPH_CSS, /\.graph-open-btn\[aria-disabled="true"\]/,
    'the unavailable open door lost its visible dress')
})

test('the refusal-style pin rejects a missing target, changed values and conditional-only styling', () => {
  const rules = refusalRules(GRAPH_CSS)
  assert.equal(rules.length, 1)
  const original = rules[0].toString()
  for (const selector of refusalSelectors) {
    assert.equal(hasRefusalDress(GRAPH_CSS.replace(original,
      original.replace(selector, '.unrelated-control'))), false, selector)
  }
  for (const [prop, value] of Object.entries({ color: 'var(--ink)', 'border-style': 'solid', cursor: 'pointer' })) {
    const changed = rules[0].clone()
    changed.nodes.findLast(node => node.type === 'decl' && node.prop === prop).value = value
    assert.equal(hasRefusalDress(GRAPH_CSS.replace(original, changed.toString())), false, prop)
  }
  assert.equal(hasRefusalDress(GRAPH_CSS.replace(original, `@media (max-width: 1px) { ${original} }`)), false)
})

/* ---------- the strip shows its active chip ---------- */

test('tree navigation lives in the existing list with a current-tree marker', () => {
  assert.doesNotMatch(VIEW, /class="graph-bar-trees"/)
  const list = VIEW.slice(VIEW.indexOf('  function paintFleetOverview()'), VIEW.indexOf('  function renderLiveStats()'))
  assert.match(list, /data-fleet-open-tree=/)
  assert.match(list, /aria-current="\$\{tree\.id === currentTreeId\}"/)
  assert.match(VIEW, /graph\?\.setRoot\(treeRoot\.id\)/)
})

/* ---------- the phone dress carries the repairs ---------- */

test('the phone sheet’s segment, quick-pick and ledger rows carry their repairs', () => {
  /* B: 44px floor buttons inside a fixed 32px segment overflowed onto the
     agent heading on every sheet open. */
  assert.match(PHONE_CSS, /\[data-phone-canvas="on"\] \.phone-sheet-body \.seg:where\(:has\(> button\)\) \{[^}]*height: auto/,
    'the sheet’s segmented control is a fixed 32px box again; the floor-raised tabs will overflow it')
  /* A: the actions quick-pick anchored in a ~240px chat gave its list 46px. */
  assert.match(PHONE_CSS, /\[data-phone-canvas="on"\] \.phone-sheet-body \.chat \{[^}]*position: static/,
    'the sheet chat is a positioning context again; the actions quick-pick caps at the chat’s leftover instead of the rail’s measure')
  /* D: the ledger name column vanished at the 1.18x step. */
  assert.match(PHONE_CSS, /\.phone-ledger-press \{[^}]*minmax\(calc\(var\(--s5\) \* 3\), 1fr\)/,
    'the ledger name column lost its readable minimum; at max zoom names collapse to a glyph or to nothing')
  assert.match(PHONE_CSS, /min-height: calc\(\(var\(--s5\) \+ var\(--s5\) \+ var\(--s2\)\) \* var\(--phone-ledger-scale, 1\)\)/,
    '“Larger rows” scales only the type again, not the row')
})
