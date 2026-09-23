import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createFleetTreeStore, draftStartEffort } from '../../src/fleet-trees.js'

const view = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
const css = readFileSync(new URL('../../src/tree-graph.css', import.meta.url), 'utf8')

function between(start, end) {
  const from = view.indexOf(start)
  const to = view.indexOf(end, from + start.length)
  assert.notEqual(from, -1, `${start} is gone`)
  assert.ok(to > from, `${end} no longer follows ${start}`)
  return view.slice(from, to)
}

test('compose sets a persisted draft without entering the launch path', () => {
  const submit = between('async function submitCompose(draft, detail, workspace, submission)', 'async function startDraftNode')
  /* THE LABEL IS THE ACTION, NOT THE TARGET TREE (owner: "ITS SUPPOSED TO
     HAVE SET OR START AS OPTIONS"). This used to derive Set-versus-Start from
     treeHasStarted() -- the tree deciding what the person's press meant,
     which is the exact defect the two-button compose panel exists to close.
     draft.mode is which button src/agent-compose-panel.js actually built and
     the person actually pressed ('set' or 'start'), read alone. */
  assert.match(submit, /const willStart = draft\.mode === 'start'/,
    'compose no longer derives Set versus Start from which button the person pressed')
  /* Comments stripped: the code above explains the change by NAMING the old
     treeHasStarted() call it replaced, which must not itself trip this check. */
  assert.doesNotMatch(submit.replace(/\/\*[\s\S]*?\*\//g, ''), /treeHasStarted\(/,
    'compose still asks the target tree what the person meant, alongside or instead of draft.mode')
  assert.match(submit, /refreshTree\(\)[\s\S]*?if \(!willStart\) \{[\s\S]*?return \{ ok: true \}/,
    'Set no longer stops after persisting and drawing the draft')
  assert.doesNotMatch(submit, /startAgentForNode\(/,
    'compose bypasses the shared existing-draft launch path')
})

test('a non-default effort survives Set and is handed to the later tree Start', () => {
  const submit = between('async function submitCompose(draft, detail, workspace, submission)', 'async function startDraftNode')
  assert.match(submit, /const added = addDraft\(\{[\s\S]*?effort: draft\.effort \|\| ''[\s\S]*?\}\)/,
    'Set no longer writes the effort selected in the compose panel onto its draft node')

  const start = between('async function startDraftNode', 'function statusNote')
  assert.match(start, /effort: draftStartEffort\(node, \{ override: effort, tierDefault: tierEffortOf\(node\.tier\) \}\)/,
    'the shared Start path no longer resolves the persisted effort through the tested precedence rule')

  const cells = new Map()
  const storage = {
    read(key) { return cells.get(key) ?? null },
    write(key, value) { cells.set(key, value); return true },
  }
  let id = 0
  const buildStore = () => createFleetTreeStore({
    computerId: 'effort-test',
    storage,
    now: () => '2026-08-30T00:00:00.000Z',
    makeId: kind => `${kind}-${++id}`,
  })
  const setNode = buildStore().addNode({
    role: 'reviewer',
    message: 'Review the release',
    tier: 'sol',
    effort: 'xhigh',
  }).node
  const reopenedNode = buildStore().getNode(setNode.id)
  assert.equal(reopenedNode.effort, 'xhigh',
    'the selected non-default effort did not survive the persisted Set boundary')
  assert.equal(draftStartEffort(reopenedNode, { tierDefault: 'medium' }), 'xhigh',
    'the later tree Start replaced the persisted effort with the tier default')
})

test('tree status no longer predicts which compose controls are available', () => {
  const open = between('function openComposeFor(detail)', 'async function submitCompose(draft, detail, workspace, submission)')
  assert.doesNotMatch(open, /treeHasStarted|willStart/,
    'opening compose still predicts a mode from the target tree')
  assert.match(open, /unavailableReason: unavailable,[\s\S]*?startUnavailableReason: startUnavailable/,
    'full and Start-only unavailability are not handed to the panel separately')
  assert.match(open, /confinementLine: composeConfinementLine/,
    'the Start confinement line is still hidden according to a predicted mode')
  assert.doesNotMatch(view, /paintComposeMode|composePanelWillStart/,
    'a predicted compose mode still hides or disables Start-related controls')
})

test('every tree with drafts gets a real Start control in its tree-list row', () => {
  const controls = between('function refreshTreeStartControls', 'function refreshTreeSwitch')
  assert.match(controls, /listNodes\(tree\.id\)\.filter\(node => node\.status === 'draft'\)/,
    'the tree list no longer finds the drafts it can start')
  assert.match(controls, /document\.createElement\('button'\)[\s\S]*?button\.type = 'button'/,
    'tree Start stopped being a native button')
  assert.match(controls, /button\.addEventListener\('click',[\s\S]*?startSetTree\(tree\.id\)/,
    'the visible tree control is no longer wired to the batch start')
  assert.match(controls, /slot\.prepend\(group\)/,
    'tree Start is no longer attached to the tree-list row')
  assert.match(controls, /tree\.id === slot\.dataset\.treeStartControls/,
    'a row must only offer Start for its own tree')
  // Additional controls may join the rule without changing either button.
  // Check selector membership and the declarations, not selector adjacency.
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  const shared = rules.find(([, selectors]) => {
    const names = selectors.split(',').map(selector => selector.trim())
    return names.includes('.computers .graph-tree-start') && names.includes('.computers .graph-edit-btn')
  })
  assert.ok(shared, 'tree Start no longer shares the established graph-bar button theme')
  const declarations = new Map(shared[2].split(';').filter(part => part.includes(':')).map(part => {
    const colon = part.indexOf(':')
    return [part.slice(0, colon).trim(), part.slice(colon + 1).trim()]
  }))
  for (const [property, value] of Object.entries({ display: 'inline-flex', 'min-height': '30px',
    padding: '0 13px', border: '1px solid var(--line-2)', 'border-radius': '4px',
    background: 'var(--sheet)', color: 'var(--ink-2)', font: '640 12.5px/1 var(--font-ui)' })) {
    assert.equal(declarations.get(property), value, `shared graph-bar button ${property}`)
  }
})

test('tree batches prepare real declared seats, then use bounded resource admission rather than legacy lane quotas', () => {
  const start = between('async function startSetTree', 'function refreshTreeStartControls')
  assert.match(start, /createTreeLaunchQueue\(\{ nodes: drafts/)
  assert.match(start, /prepare: async node[\s\S]*?ensureSeatForNode\(node, identityRoleForTreeNode\(node.role\)\)/)
  assert.match(start, /start: node => startDraftNode\(node, \{ queueManaged: true \}\)/)
  assert.doesNotMatch(start, /TIER_SEAT_POOL|treeSeatShortage|Promise\.all\(drafts/)
  const launch = between('async function startDraftNodeUnguarded', 'function statusNote')
  assert.ok(launch.indexOf('window.mcResources.status') < launch.indexOf("store.setNodeStatus(node.id, 'starting'"))
  assert.match(launch, /!result.sessionId && isResourceHold\(result.code\)[\s\S]*?store.setNodeStatus\(node.id, 'draft'/)
  assert.match(view, /for \(const queue of treeLaunchQueues.values\(\)\) queue.cancel\(\)/)
})

test('the phone keeps the same Set and tree Start controls', () => {
  /* THE PANEL'S SET FACE IS NO LONGER A MODE THE TREE PICKS, it is a BUTTON
     THAT ALWAYS EXISTS (src/agent-compose-panel.js builds setBtn
     unconditionally, not gated on treeHasStarted() or any narrow-width
     reader) -- so there is nothing left for a phone-only rule to hide even
     in principle. Retargeted from the old single-face dataset attribute,
     which this file's own view no longer sets, to the control this test's
     name is actually about. */
  const panelSrc = readFileSync(new URL('../../src/agent-compose-panel.js', import.meta.url), 'utf8')
  assert.match(panelSrc, /setBtn\.setAttribute\('data-compose-action', 'set'\)/,
    'the compose panel has no explicit Set control any more')
  const phone = css.slice(css.indexOf('@media (max-width: 720px)'), css.indexOf('.computers .graph-hint'))
  assert.ok(phone.length > 0, 'the narrow graph-bar rules moved')
  assert.doesNotMatch(phone, /graph-tree-start[^}]*display:\s*none/,
    'the phone breakpoint hides the tree Start control')
})
