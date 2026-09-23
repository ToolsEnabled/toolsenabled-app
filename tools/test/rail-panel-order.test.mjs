// WHERE THE FOLDER IS ON THE RAIL, HELD IN PLACE.
//
// Owner, 2026-08-19: "also what happened to sessions and choosing a folder for
// each tree and such? ther right panel on page 2 is still so complicated i
// think its in there maybe somewhere". It WAS in there. Driven on the packaged
// build (tools/rail-inventory-drive.mjs, 2026-08-20) before this change:
//
//   overview rail, 1440x900   "Session profiles" 1152px down a 1524px scroll
//   overview rail, 1024x768   "Session profiles" 1042px down a 1339px scroll
//   tree node, Details tab    the "Works in" select 614px down a 3825px scroll,
//                             elementFromPoint says NOT in the viewport at
//                             1024 or 1440, fifth of nine stacked panels
//
// Below the fold at every width this product supports, under two headings --
// "Session profiles" and "Setup > Works in" -- neither of which contains the
// word he was hunting for.
//
// WHY A SOURCE TEST BESIDE A DRIVER. The driver measures pixels on real glass
// and is the evidence; it also needs a packaged build, five minutes and a
// staged profile. This holds the ORDER and the NAMING that produce those
// pixels, in the suite, so the arrangement cannot quietly go back. Neither
// replaces the other: this one cannot see a panel that renders 900px tall, and
// the driver cannot run on every commit.
//
// IT ALSO GUARDS AGAINST THE WRONG FIX. The owner's standing rule is that a
// misbehaving feature gets guarded or fixed, never removed to reach a goal. So
// every assertion about placement is paired with an assertion that the thing
// placed is still THERE: all four start-work builders still called, every
// data-tree-profile hook still written, the profile panel still mounted.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'
import { computersViewAuthorityBindings } from './lib/computers-view-authority-bindings.mjs'
import { createFleetTreeStore, draftStartEffort, safeTreeStorage } from '../../src/fleet-trees.js'
import { createSingleFlight } from '../../src/single-flight.js'
import { createTreeLaunchQueue, isResourceHold } from '../../src/tree-launch-queue.js'
import { identityRoleForTreeNode } from '../../src/tree-node-identity.js'
import { slotAccountStartOptions } from '../../src/slot-account-choice.js'
import { LAUNCH_TIERS } from '../../src/orchestration-controls.js'

const here = fileURLToPath(import.meta.url)
const SRC = join(dirname(dirname(dirname(here))), 'src')
const view = readFileSync(join(SRC, 'views', 'computers.js'), 'utf8')
const copy = readFileSync(join(SRC, 'fleet-tree-copy.js'), 'utf8')
const board = readFileSync(join(SRC, 'board.css'), 'utf8')

/* The renderLiveStats template only -- the overview rail's own markup. Slicing
   it out means "before Services" cannot be satisfied by some other Services
   elsewhere in a 6000-line file. */
function overviewTemplate() {
  const start = view.indexOf('function renderLiveStats()')
  assert.notEqual(start, -1, 'renderLiveStats() is the overview rail builder and it is gone')
  const end = view.indexOf('mountResearchScopeControl()', start)
  assert.ok(end > start, 'renderLiveStats() no longer ends where this test expects')
  return view.slice(start, end)
}

/* The Details tab of the tree node's rail: showTreeNodeControls' template. */
function treeNodeTemplate() {
  const start = view.indexOf('function showTreeNodeControls(node)')
  assert.notEqual(start, -1, 'showTreeNodeControls() is the tree node rail builder and it is gone')
  const end = view.indexOf(".querySelector('.rail-back')", start)
  assert.ok(end > start, 'showTreeNodeControls() no longer ends where this test expects')
  return view.slice(start, end)
}

test('the overview rail names a folder, in a heading with the word in it', () => {
  assert.match(copy, /overviewTitle: '[^']*[Ff]olders?[^']*'/, 'PROFILE_PANEL.overviewTitle must say "folder" -- "Session profiles" is what he could not find')
  assert.match(copy, /nodeTitle: '[^']*[Ff]olders?[^']*'/, 'PROFILE_PANEL.nodeTitle must say "folder" -- "Works in" is what he could not find')
  assert.ok(
    overviewTemplate().includes('PROFILE_PANEL.overviewTitle'),
    'the overview rail must head its folder section with PROFILE_PANEL.overviewTitle',
  )
})

test('the overview rail puts the folder above Services, Organisation and the Role library', () => {
  const template = overviewTemplate()
  const folder = template.indexOf('data-profile-slot')
  const services = template.indexOf('>Services<')
  const roles = template.indexOf('board-org-slot')
  assert.ok(folder > -1, 'the profile panel mount point is gone from the overview rail')
  assert.ok(services > -1 && roles > -1, 'the overview rail no longer has the sections this order is measured against')
  /* The Role library measured 484px tall with 51 controls, and it sat directly
     above the folder. That single panel is what put the folder off-screen. */
  assert.ok(folder < services, 'the folder section must come before Services on the overview rail')
  assert.ok(folder < roles, 'the folder section must come before the Role library on the overview rail')
})

test('the overview rail still MOUNTS the profile panel it moved', () => {
  assert.ok(
    /mountProfilePanel\(statsPage\.querySelector\('\[data-profile-slot\]'\)\)/.test(view),
    'moving the section must not have unmounted it -- nothing is removed to reach a goal',
  )
})

test('the tree node rail puts the folder first, under the name', () => {
  const template = treeNodeTemplate()
  const head = template.indexOf('agent-head board-head')
  const folder = template.indexOf('data-tree-folder')
  const doing = template.indexOf('>What it is doing<')
  const setup = template.indexOf('data-tree-move')
  const startWork = template.indexOf('board-start-work-slot')
  assert.ok(folder > -1, 'the tree node rail must carry a box of its own for the folder')
  assert.ok(head > -1 && doing > -1 && setup > -1 && startWork > -1, 'the tree node rail no longer has the panels this order is measured against')
  assert.ok(head < folder, 'the folder box belongs under the agent head, not above it')
  assert.ok(folder < doing, 'the folder must come before "What it is doing"')
  assert.ok(folder < setup, 'the folder must come before Setup -- it used to be buried inside it')
  assert.ok(folder < startWork, 'the folder must come before the start-work group')
})

test('every folder hook the handlers query is still written, by its exact name', () => {
  const template = treeNodeTemplate()
  /* The handlers query controlsPage, not the box, which is what made moving
     this markup safe. If a hook is renamed the handler silently stops finding
     it and the control goes dead with no error anywhere. */
  for (const hook of [
    'data-tree-profile',
    'data-tree-profile-out',
    'data-tree-profile-restart-row',
    'data-tree-profile-restart',
  ]) {
    assert.ok(template.includes(hook), `the rail must still write ${hook} -- its handler queries that exact name`)
    assert.ok(view.includes(`[${hook}]`), `something must still query [${hook}]`)
  }
})

test('the four ways to start work are one named disclosure, and all four are still built', () => {
  const start = view.indexOf('function mountStartWorkControls(agent, slot)')
  assert.notEqual(start, -1, 'mountStartWorkControls() is gone')
  const body = view.slice(start, start + 3600)

  /* NOTHING REMOVED. 74% of the Details tab's 3825px scroll was these four
     panels (Launch 963, Loop 699, Codex Cloud 609, Team 550, driven at
     1440x900). Collapsing them is the whole saving -- deleting any of them
     would be the wrong way to the same number. */
  for (const builder of ['launchControlsBox(', 'teamControlsBox(', 'loopControlsBox(', 'cloudControlsBox(']) {
    assert.ok(body.includes(builder), `${builder}) must still be called -- collapsed is not removed`)
  }

  /* A REAL BUTTON, NOT A BARE ROW. A sibling lane measured this week that a
     group collapsing without a clear affordance reads as a missing feature. */
  assert.match(body, /<button[^>]*data-start-work-toggle/, 'the disclosure must be a real <button>')
  assert.match(body, /aria-expanded="\$\{open \? 'true' : 'false'\}"/, 'the toggle must carry aria-expanded reflecting the real state')
  assert.match(body, /aria-controls="\$\{bodyId\}"/, 'the toggle must name the region it controls')
  assert.ok(body.includes('rail-group-chev'), 'the disclosure must carry a chevron')

  /* AND IT MUST SAY WHAT IS INSIDE IT. */
  assert.ok(body.includes('START_WORK_GROUP.contents'), 'the toggle must name its four panels on its own line')
  assert.match(copy, /contents: '[^']*Launch[^']*Team[^']*Loop[^']*Codex Cloud[^']*'/, 'START_WORK_GROUP.contents must name all four panels')
  assert.match(copy, /expandLabel: '[^']+'/, 'the toggle needs an accessible label for the closed state')
  assert.match(copy, /collapseLabel: '[^']+'/, 'the toggle needs an accessible label for the open state')
})

test('the disclosure mounts all four controls before opening and keeps them mounted across toggles', async () => {
  const { installDomStandIn } = await import('./lib/dom-stand-in.mjs')
  const world = installDomStandIn()
  try {
    const { el } = await import('../../src/components.js')
    const { START_WORK_GROUP } = await import('../../src/fleet-tree-copy.js')
    for (const initiallyOpen of [false, true]) {
      const calls = [], remembered = []
      const panel = name => () => {
        calls.push(name)
        const box = document.createElement('div')
        box.setAttribute('data-fixture-panel', name)
        return box
      }
      const bindings = {
        el, START_WORK_GROUP, escapeMarkup: value => String(value),
        startWorkWasOpen: () => initiallyOpen, rememberStartWork: value => remembered.push(value),
        mockSource: () => false, launchControlsBox: panel('launch'), teamControlsBox: panel('team'),
        loopControlsBox: panel('loop'), cloudControlsBox: panel('cloud'), goalControlsBox: panel('goal'),
      }
      const mount = new Function(...Object.keys(bindings), 'let boardCloudBox = null;'
        + declaredFunctionSource(view, 'mountStartWorkControls') + '; return mountStartWorkControls')(...Object.values(bindings))
      const host = document.createElement('div'), slot = document.createElement('div')
      host.appendChild(slot)
      mount({ id: 'fixture-agent' }, slot)
      const body = host.querySelector('[data-start-work-body]'), toggle = host.querySelector('[data-start-work-toggle]')
      const controls = ['launch', 'team', 'loop', 'cloud'].map(name => {
        const control = body.querySelector('[data-fixture-panel="' + name + '"]')
        assert.ok(control, name + ' is mounted before any disclosure press')
        return control
      })
      assert.equal(body.hidden, !initiallyOpen)
      assert.equal(toggle.getAttribute('aria-expanded'), String(initiallyOpen))
      assert.deepEqual(calls, ['launch', 'team', 'loop', 'cloud', 'goal'])
      for (const open of [!initiallyOpen, initiallyOpen]) {
        toggle.dispatch('click')
        assert.equal(body.hidden, !open)
        assert.equal(toggle.getAttribute('aria-expanded'), String(open))
        assert.deepEqual(body.querySelectorAll('[data-fixture-panel]'), controls,
          'toggling retains the existing controls and their state')
      }
      assert.deepEqual(remembered, [!initiallyOpen, initiallyOpen])
      assert.equal(calls.length, 5, 'opening does not construct a second set of controls')
    }
  } finally { world.restore() }
})

test('the classes the disclosure writes have rules', () => {
  for (const cls of ['rail-group-toggle', 'rail-group-chev', 'rail-group-name', 'rail-group-body']) {
    assert.ok(board.includes(`.${cls}`), `.${cls} is written by the rail and styled by nothing`)
  }
})

test('remembering the disclosure is posture, not a setting', () => {
  const start = view.indexOf('function mountStartWorkControls(agent, slot)')
  const region = view.slice(Math.max(0, start - 1200), start + 3600)
  assert.ok(region.includes('mc.rail.start-work-open'), 'the open state is remembered under its own key')
  /* A "user setting" in this product needs a registry row, real enforcement and
     a control in the software, or it is a lie. This is none of those and must
     not pretend to be: it grants nothing and gates nothing, exactly as
     src/settings-presentation.js already ruled for its own open-groups memory. */
  assert.ok(
    !/WRITE_ACTION_FLAGS|setWriteEnabled\(\s*['"]start-work/.test(region),
    'the disclosure must not touch a write flag -- it is posture, not permission',
  )
})

/* ---------------------------------------------------------------------------
 * PART B: THE FOLDER CHOSEN AT TREE START ACTUALLY BECOMES THE TREE'S FOLDER.
 *
 * The compose panel's own suite proves the QUESTION is asked and the answer
 * reaches the caller (tools/test/agent-compose-panel.test.mjs). This pins what
 * the caller then DOES with it, which is the half that can silently rot: the
 * write has to land between the node existing and the start reading the tree's
 * profile, or the first agent of the tree starts in the wrong folder and only
 * the second one is right.
 *
 * Execute the actual nested caller and its delegated start queue against the
 * real tree store. The provider boundary returns an explicit fixture refusal;
 * no session is launched, and these checks make no native UI claim.
 * ------------------------------------------------------------------------- */

function composeProfileFixture() {
  let raw = null, nextId = 0
  const events = [], handoffs = [], remembered = []
  const storage = safeTreeStorage({ getItem: () => raw, setItem: (_key, value) => { raw = value } })
  const stored = createFleetTreeStore({ computerId: 'compose-profile-fixture', storage, makeId: kind => `${kind}-${++nextId}` })
  const reload = () => createFleetTreeStore({ computerId: 'compose-profile-fixture', storage })
  const store = { ...stored,
    addNode(fields) {
      const result = stored.addNode(fields)
      events.push({ kind: 'add', result })
      return result
    },
    setTreeProfile(treeId, profileId) {
      const result = stored.setTreeProfile(treeId, profileId)
      events.push({ kind: 'write', treeId, profileId, saved: reload().treeProfile(treeId), result })
      return result
    },
    treeProfile(treeId) {
      const profileId = stored.treeProfile(treeId)
      events.push({ kind: 'read', treeId, profileId })
      return profileId
    },
  }
  const boundarySentence = 'Fixture stopped at the provider handoff.'
  const context = vm.createContext({
    ...computersViewAuthorityBindings(),
    treeStore: store, treeStoreProblem: '', destroyed: false, composePanel: {}, transcriptStore: null,
    mockSource: () => false, isWriteEnabled: () => true, START_CONTROL_FLAG: 'start', START_REFUSAL: {},
    treeNodeName: node => node.id,
    rememberComposeFolder: profileId => remembered.push(profileId),
    setOrgStatus: () => {}, closeComposePanel: () => {}, refreshTree: () => {},
    refreshTreeStartControls: () => {}, refreshLaunchStatus: () => {},
    startDraftFlight: createSingleFlight(), createTreeLaunchQueue, nodeLaunchQueues: new Map(),
    startingNodeIds: new Set(), draftStartEffort, identityRoleForTreeNode, tierEffortOf: () => 'medium',
    // The real account choice for the start (reusable tree slots, app a8aee112a), not a stand-in.
    slotAccountStartOptions, LAUNCH_TIERS,
    ensureSeatForNode: async () => ({ ok: true }),
    roleBindingForStart: id => ({ ok: true, binding: { agentId: id } }),
    currentDataSource: () => 'local', window: {},
    roleDisplayFor: role => role, startingLine: () => 'Starting.',
    briefContextFor: () => ({}), composeNodeBrief: draft => draft.message,
    startProfileId: profileId => profileId, retainStartingTreeStore: () => () => {},
    startAgentForNode: async options => {
      const nodeId = options.requestKeys.threadId
      const node = stored.getNode(nodeId)
      const saved = reload()
      const handoff = { profileId: options.profileId, text: options.text, tier: options.tier, effort: options.effort,
        node, savedNode: saved.getNode(nodeId), savedProfile: saved.treeProfile(node.treeId),
        requestKeys: JSON.parse(JSON.stringify(options.requestKeys)),
        treeIdentity: JSON.parse(JSON.stringify(options.treeIdentity)), roleAgentId: options.roleBinding.agentId }
      handoffs.push(handoff)
      events.push({ kind: 'handoff', nodeId })
      return { ok: false, code: 'QA_PROVIDER_BOUNDARY', sentence: boundarySentence }
    },
    setTimeout, clearTimeout, startStallMs: () => 60000, startStalledLine: () => 'Waiting.',
    isResourceHold, statusNote: text => text, rebindRailToSession: () => {},
    unstartedTreeNodeRetryState: () => ({ hasSavedConversation: false, cleanupPending: false, busy: false }),
  })
  for (const name of ['composeParentFor', 'submitCompose', 'startDraftNode', 'startDraftNodeQueued',
    'startDraftNodeUnguarded', 'treeAnchorsFor', 'nodeRequestKeys', 'nodeTreeIdentity']) {
    vm.runInContext(declaredFunctionSource(view, name), context)
  }
  const submission = { active: () => true }
  return { stored, reload, events, handoffs, remembered, context, boundarySentence, submission,
    submit: (draft, detail) => context.submitCompose(draft, detail, false, submission),
    start: node => context.startDraftNode(node),
  }
}

const composeDraft = { mode: 'start', profileId: 'chosen-folder', role: 'worker', tier: 'luna', effort: 'high', message: 'Keep this opening job.' }

function assertProfileHandoff(f, result, expectedProfile, { parent = null } = {}) {
  assert.equal(result.ok, false, 'the fixture must stop at its explicit provider boundary')
  assert.equal(result.message, f.boundarySentence, 'a fixture setup exception must not masquerade as the expected refusal')
  assert.equal(f.handoffs.length, 1, 'the real caller and queue must request exactly one start')
  const sent = f.handoffs[0], node = sent.node
  assert.equal(sent.profileId, expectedProfile, 'the first start must use the tree folder')
  assert.equal(sent.savedProfile, expectedProfile, 'the folder must already be saved when the provider is requested')
  assert.deepEqual(sent.savedNode, node, 'the exact starting node must be persisted before the handoff')
  assert.equal(node.status, 'starting')
  assert.equal(node.sessionId, null, 'the fixture must not claim that a provider session exists')
  assert.equal(node.parentId, parent?.id || null)
  if (parent) assert.equal(node.treeId, parent.treeId)
  assert.equal(sent.roleAgentId, node.id)
  assert.deepEqual(sent.requestKeys, { treeAnchors: parent ? [parent.id, node.id] : [node.id], threadId: node.id })
  assert.deepEqual(sent.treeIdentity, { selfName: node.id, managerName: parent?.id || null })
  assert.equal(sent.text, composeDraft.message)
  assert.equal(sent.tier, composeDraft.tier)
  assert.equal(sent.effort, composeDraft.effort)
  assert.equal(f.context.nodeLaunchQueues.size, 0, 'the delegated queue must settle and release the node')
  assert.equal(f.context.startingNodeIds.size, 0)
  const reads = f.events.filter(event => event.kind === 'read')
  assert.ok(reads.length > 0, 'the actual delegated start must read the tree store')
  for (const read of reads) {
    assert.equal(read.treeId, node.treeId)
    assert.equal(read.profileId, expectedProfile)
  }
  return node
}

test('the folder chosen at tree start is saved before the delegated start reads it', async () => {
  const f = composeProfileFixture()
  const node = assertProfileHandoff(f, await f.submit(composeDraft), composeDraft.profileId)
  const added = f.events.findIndex(event => event.kind === 'add')
  const written = f.events.findIndex(event => event.kind === 'write')
  const read = f.events.findIndex(event => event.kind === 'read')
  const handedOff = f.events.findIndex(event => event.kind === 'handoff')
  assert.ok(added >= 0 && added < written && written < read && read < handedOff,
    'the real store must create the tree, save its folder, and only then supply the first start')
  const writes = f.events.filter(event => event.kind === 'write')
  assert.equal(writes.length, 1)
  assert.equal(writes[0].treeId, node.treeId)
  assert.equal(writes[0].result.ok, true)
  assert.equal(writes[0].saved, composeDraft.profileId)
  assert.deepEqual(f.remembered, [composeDraft.profileId])
})

test('Set persists the chosen folder without starting, and a later Start reads that saved choice', async () => {
  const f = composeProfileFixture()
  const draft = { ...composeDraft, mode: 'set' }
  assert.equal((await f.submit(draft)).ok, true)
  assert.equal(f.handoffs.length, 0)
  assert.equal(f.events.some(event => event.kind === 'read'), false)
  const node = f.events.find(event => event.kind === 'add').result.node
  assert.equal(f.reload().getNode(node.id).status, 'draft')
  assert.equal(f.reload().treeProfile(node.treeId), composeDraft.profileId)
  draft.profileId = 'a-later-compose-choice'
  assertProfileHandoff(f, await f.start(node), composeDraft.profileId)
})

test('a new tree without a folder choice requests the default profile', async () => {
  const f = composeProfileFixture()
  assertProfileHandoff(f, await f.submit({ ...composeDraft, profileId: null }), null)
  assert.equal(f.events.some(event => event.kind === 'write'), false)
  assert.deepEqual(f.remembered, [null])
})

for (const mode of ['start', 'set']) test(`a child ${mode} cannot retarget its parent tree's folder`, async () => {
  for (const profileId of ['parent-folder', null]) {
    const f = composeProfileFixture()
    const parent = f.stored.addNode({ role: 'manager', message: 'Keep this running parent.', tier: 'luna' }).node
    assert.equal(f.stored.setTreeProfile(parent.treeId, profileId).ok, true)
    assert.equal(f.stored.attachSession(parent.id, 'parent-session').ok, true)
    assert.equal(f.stored.setNodeStatus(parent.id, 'running').ok, true)
    const sibling = f.stored.addNode({ parentId: parent.id, role: 'worker', message: 'Keep this existing sibling.', tier: 'luna' }).node
    const originals = [parent.id, sibling.id].map(id => f.reload().getNode(id))
    let result = await f.submit({ ...composeDraft, mode, profileId: 'must-not-retarget-this-tree' }, { kind: 'child', parentId: parent.id })
    const added = f.events.find(event => event.kind === 'add').result
    assert.equal(added.ok, true)
    if (mode === 'set') {
      assert.equal(result.ok, true)
      assert.equal(f.handoffs.length, 0)
      assert.equal(f.reload().getNode(added.node.id).status, 'draft')
      result = await f.start(added.node)
    }
    assertProfileHandoff(f, result, profileId, { parent })
    assert.equal(f.events.some(event => event.kind === 'write'), false, 'a child must never write a tree profile')
    assert.equal(f.reload().treeProfile(parent.treeId), profileId)
    assert.deepEqual([parent.id, sibling.id].map(id => f.reload().getNode(id)), originals)
    assert.deepEqual(f.remembered, [], 'a nested compose must not change the remembered new-tree folder')
  }
})

test('the compose panel is handed the folders and the remembered choice', () => {
  const start = view.indexOf('function openComposeFor(detail)')
  assert.notEqual(start, -1, 'openComposeFor() is gone')
  const body = view.slice(start, start + 2600)
  assert.ok(body.includes('folders: composeFolders'), 'the panel must be handed this computer’s folders')
  assert.ok(body.includes('folderSelectedId: lastComposeFolder()'), 'the menu must open on the folder used last')
})

test('the folders come from the ONE store that holds them, read once per mount', () => {
  /* Not a second register of folders kept beside the first: the same
     mcAgent.profiles() the fleet rail's own panel reads. */
  assert.match(view, /async function readComposeFolders\(\)/, 'the folders must be read by their own named function')
  const start = view.indexOf('async function readComposeFolders()')
  const body = view.slice(start, start + 900)
  assert.ok(body.includes('bridge.profiles()'), 'the folders must come from the main process store, not from the renderer')
  assert.ok(/composeFolders = \[\]/.test(view.slice(start - 400, start)) || body.includes(': []'),
    'a bridge that will not answer must leave an empty list, never throw')
  assert.ok(view.includes('void readComposeFolders()'), 'the list must be read as the board comes up')
})

test('the remembered folder is posture, not a setting', () => {
  assert.ok(view.includes('mc.compose.last-folder'), 'the last-used folder is remembered under its own key')
  const start = view.indexOf("const LAST_FOLDER_KEY = 'mc.compose.last-folder'")
  assert.notEqual(start, -1, 'the key must be declared once, by name')
  const region = view.slice(start, start + 700)
  assert.ok(
    !/WRITE_ACTION_FLAGS|setWriteEnabled/.test(region),
    'pre-filling a menu grants nothing and gates nothing -- it must not touch a write flag',
  )
})

test('the folder section clears the fold: it sits above "This computer", not below it', () => {
  /* MEASURED, not preferred. Below "This computer" the heading landed at 415px
     of a 1524px scroll -- readable at 1440 and 1920, but at 1024x768 its
     CONTROLS (the name field and "Pick a folder…") fell under the floating
     fleet-profile notice. A heading a person can read over a box they cannot
     reach is not a fix. Above it, the whole section clears at every width.
     It stays BELOW the hero's "this is the record" caveat, which qualifies the
     number directly above it. */
  const template = overviewTemplate()
  const caveat = template.indexOf('projection-unavailable')
  const folder = template.indexOf('data-profile-slot')
  /* Anchored on the facts list rather than the heading text. The heading is no
     longer a constant: driving from a browser, the computer these facts
     describe is somewhere else, so calling it "This computer" invited the exact
     mistake the account page warns about. What this test measures is the ORDER,
     and the facts list sits immediately under that heading in every wording. */
  const thisComputer = template.indexOf('class="rail-facts"')
  assert.ok(caveat > -1 && folder > -1 && thisComputer > -1, 'the overview rail no longer has the sections this order is measured against')
  assert.ok(
    template.includes('thisComputerHeading()'),
    'the heading must still be chosen by the helper that knows whether this computer is the one you are sitting at',
  )
  assert.ok(caveat < folder, 'the record caveat belongs with the number it qualifies, above the folder')
  assert.ok(folder < thisComputer, 'the folder section must clear the fold, which means above "This computer"')
})
