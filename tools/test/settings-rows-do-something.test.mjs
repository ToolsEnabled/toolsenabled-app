/* EVERY ROW ON THE SETTINGS PAGE HAS TO DO SOMETHING.
 *
 * Written failing-first for the settings-truth lane, 2026-08-20. Before the
 * change this suite reported 74 dead rows out of 96; after it, none.
 *
 * WHAT WAS MEASURED. The page built 96 rows and its own footer said "116
 * settings". Seventy-four of them wrote a `mc.set.<id>` key that nothing in the
 * product ever read. Six whole sections were inert top to bottom -- Fleet
 * Graph, Metrics, Chat & Threads, Comms Board, Performance and Developer -- and
 * every one of those rows moved, filled, reported a percentage and survived a
 * restart, so nothing on screen distinguished them from the twenty-two that
 * worked. `contrast_curve` promised "Make the lighter, secondary text darker
 * and easier to read" to the person least able to detect that nothing happened.
 * `drawer_width` offered 280-440px against a drawer hardcoded `width: 320px`
 * (src/styles.css:2684). `brace_stroke_width` declared a default of 1.25px
 * while the shipped braces draw at a hardcoded 1.5 (src/views/home.js:186), so
 * it misreported the current value as well as failing to change it.
 *
 * WHY THE RULE IS EXPRESSED THIS WAY. A row's value can reach behaviour by
 * exactly two doors, and this test walks both rather than searching for ninety
 * strings:
 *
 *   1  A branch in `applyValue()` in src/views/settings.js. Everything that
 *      does not match a branch falls to `else { writeStored(setting, value) }`
 *      and stops there.
 *   2  Some other file reading the row's storage key. The whole product
 *      contains exactly one such literal (`mc.set.uninstall_data`, read by
 *      shell/uninstall-retention.cjs) and two templated readers
 *      (src/appearance-persistence.js, for glow and reduce_motion).
 *
 * (`scenario_tick_rate` used to be licensed through a third path,
 * applyStoredSimPace() re-applying it to the simulation clock at launch. The
 * row and the clock are gone -- the example the product shows now is data fed
 * through the ordinary screens -- so the path is gone with them. The
 * `example_mode` row that replaced the per-view family acts through door 1,
 * and its ENFORCEMENT is asserted by name below: src/data-source.js owns the
 * stored choice and answers 'mock' for every screen while it is on.)
 *
 * THIS IS A RATCHET, NOT A SNAPSHOT. It is derived from the source at run time,
 * so a row added tomorrow with no consumer fails it on the day it is added,
 * named. That is the whole point: the defect was not that somebody wrote 74 bad
 * rows, it was that nothing could tell a real control from a drawn one.
 *
 * ADDING A ROW THEREFORE MEANS ADDING ITS READER. If a row genuinely acts
 * through a door this test does not know about, teach the test the door -- with
 * the file and line that reads it. Do not add the id to an exemption list;
 * there deliberately is not one.
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { SETTINGS_GROUPS } from '../../src/settings-presentation.js'
import { PRODUCT_SECTIONS } from '../../src/product-settings-layout.js'
import { CHATBOX_SECTION } from '../../src/chatbox-settings.js'
import { CONNECT_SECTION } from '../../src/connect-computer-settings.js'
import { ENTERPRISE_SECTION, ENTERPRISE_SETTING_IDS } from '../../src/enterprise-settings.js'
import { PRODUCT_SETTING_IDS } from '../../src/research-settings.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = relative => readFileSync(path.join(ROOT, ...relative.split('/')), 'utf8')
const require = createRequire(import.meta.url)

const settingsSource = read('src/views/settings.js')

/* The declared rows, taken from the source so the test cannot hold a stale
   copy of the catalogue it is judging. */
function declaredRows() {
  const start = settingsSource.indexOf('export const SETTINGS = [')
  const end = settingsSource.indexOf('\nconst byId = new Map')
  assert.ok(start >= 0 && end > start, 'the SETTINGS catalogue is where this test expects it')
  const block = settingsSource.slice(start, end)
  /* A row may name its id or section through the two constants the This computer
     section exports (2026-09-10), so the regex accepts an identifier and this
     table resolves it -- a constant the test does not know is a failure below. */
  // Read out of the module's own text (importing it would pull its stylesheet into Node), so a renamed constant fails here.
  const thisComputer = read('src/this-computer-settings.js')
  const constant = name => { const m = new RegExp(`export const ${name} = '([^']+)'`).exec(thisComputer); assert.ok(m, `${name} is exported by src/this-computer-settings.js`); return m[1] }
  const CONSTANTS = { THIS_COMPUTER_SECTION: constant('THIS_COMPUTER_SECTION'), THIS_COMPUTER_PROGRAMS_ROW: constant('THIS_COMPUTER_PROGRAMS_ROW') }
  const resolve = (quoted, identifier) => quoted ?? (assert.ok(identifier in CONSTANTS, `unknown constant ${identifier} in a settings row`), CONSTANTS[identifier])
  const literal = [...block.matchAll(/^\s*\{\s*id:\s*(?:'([^']+)'|([A-Z_][A-Z0-9_]*)),\s*section:\s*(?:'([^']+)'|([A-Z_][A-Z0-9_]*))/gm)]
    .map(match => ({ id: resolve(match[1], match[2]), section: resolve(match[3], match[4]) }))

  /* The one family still built by `.map()` over a flag table rather than
     written out, which a regex over this block cannot see. (The live-view
     family this used to add collapsed into the literal `example_mode` row,
     which the regex above sees directly.) */
  const write = [...read('src/write-flags.js').matchAll(/id:\s*'([^']+)'/g)]
    .map(match => ({ id: `write_${match[1]}`, section: 'App permissions' }))
  assert.ok(write.length > 0, 'the flag table was read')
  return [...literal, ...write]
}

/* DOOR 1: the rows `applyValue` treats specially. Read out of the function's
   own text, so deleting a branch retires its row's licence in the same edit. */
function rowsAppliedInPlace() {
  const start = settingsSource.indexOf('function applyValue(setting, value)')
  const end = settingsSource.indexOf('function syncSectionDepth', start)
  assert.ok(start >= 0 && end > start, 'applyValue is where this test expects it')
  const body = settingsSource.slice(start, end)
  const ids = new Set([...body.matchAll(/setting\.id === '([^']+)'/g)].map(match => match[1]))
  if (/writeSettingActions\.has\(setting\.id\)/.test(body)) {
    for (const match of read('src/write-flags.js').matchAll(/id:\s*'([^']+)'/g)) ids.add(`write_${match[1]}`)
  }
  return ids
}

/* DOOR 2: a row whose stored key is read somewhere else in the product. Named
   with the reader, because "trust me, something reads it" is the claim this
   whole suite exists to refuse. */
const READ_ELSEWHERE = Object.freeze({
  tree_style: 'src/tree-box-layout.js — readTreeStyle, read by the tree renderer',
  tree_cards: 'src/tree-box-layout.js — readTreeCards, read by the tree renderer',
  uninstall_data: 'shell/uninstall-retention.cjs — RETENTION_PREF_KEY',
  glow: 'src/appearance-persistence.js — GLOW_KEY, applied at launch',
  reduce_motion: 'src/appearance-persistence.js — REDUCE_MOTION_KEY, applied at launch',
  /* THE DOOR THE NOTIFICATION ROWS ACT THROUGH, and it is the same door
     `uninstall_data` uses: the MAIN PROCESS reads the row out of the durable
     settings record this page writes into. shell/agent-notifications.cjs asks
     for `mc.set.notify_agent_finished` and `mc.set.notify_agent_error` on every
     agent event, before it raises anything -- so nothing in the renderer acts on
     these two and there is no applyValue branch to find.

     Named with the reader, and DRIVEN below rather than taken on trust: the
     test under 'every claimed reader still uses the storage key licensed above'
     builds a real notifier over a fake store and asserts that flipping exactly
     these keys is what turns a notification on. A licence that only asserted
     the file exists would be the exemption list this suite refuses to have. */
  notify_agent_finished: 'shell/agent-notifications.cjs — TRIGGERS[agent-finished].key, read per event',
  notify_agent_error: 'shell/agent-notifications.cjs — TRIGGERS[agent-error].key, read per event',
})

/* A row that stores no value at all: it runs something when pressed. */
function actionRows() {
  const start = settingsSource.indexOf('export const SETTINGS = [')
  const end = settingsSource.indexOf('\nconst byId = new Map')
  const block = settingsSource.slice(start, end)
  /* `link` rows navigate and `custom` rows host a module that acts for itself
     (the This computer section, 2026-09-10): like `action`, they store nothing. */
  const thisComputer = read('src/this-computer-settings.js')
  const programsRow = /export const THIS_COMPUTER_PROGRAMS_ROW = '([^']+)'/.exec(thisComputer)?.[1]
  return new Set([...block.matchAll(/id:\s*(?:'([^']+)'|([A-Z_][A-Z0-9_]*))[^}]*type:\s*'(?:action|link|custom)'/g)].map(match => match[1] ?? (match[2] === 'THIS_COMPUTER_PROGRAMS_ROW' ? programsRow : match[2])))
}

test('no row on the settings page writes a value nothing reads', () => {
  const rows = declaredRows()
  const applied = rowsAppliedInPlace()
  const actions = actionRows()

  const dead = rows.filter(row => !applied.has(row.id)
    && !Object.prototype.hasOwnProperty.call(READ_ELSEWHERE, row.id)
    && !actions.has(row.id))

  const bySection = new Map()
  for (const row of dead) {
    if (!bySection.has(row.section)) bySection.set(row.section, [])
    bySection.get(row.section).push(row.id)
  }
  const report = [...bySection.entries()]
    .map(([section, ids]) => `  ${section}: ${ids.join(', ')}`)
    .join('\n')

  assert.equal(
    dead.length,
    0,
    `${dead.length} of ${rows.length} settings rows write a key nothing reads.\n`
      + 'Each one draws a working control and changes nothing:\n'
      + `${report}\n`
      + 'Either wire the row to something that reads it, or remove the row. A control '
      + 'that moves and does nothing is worse than an absent one, because a person '
      + 'stops looking for the real switch.',
  )
})

test('every claimed reader still uses the storage key licensed above', async () => {
  const { readTreeStyle, readTreeCards } = await import('../../src/tree-box-layout.js')
  const treeValues = new Map()
  const treeStorage = { getItem: key => treeValues.get(key) ?? null }
  assert.equal(readTreeStyle(treeStorage), 'boxes')
  assert.equal(readTreeCards(treeStorage), true)
  treeValues.set('mc.set.tree_style', 'circles')
  treeValues.set('mc.set.tree_cards', 'false')
  assert.equal(readTreeStyle(treeStorage), 'circles')
  assert.equal(readTreeCards(treeStorage), false)
  assert.match(read('src/views/computers.js'), /nodeStyle: readTreeStyle\(/)
  assert.match(read('src/views/computers.js'), /circleCards: readTreeCards\(/)
  /* The other half of the ratchet. Without this, deleting a reader would
     silently leave its row exempt and dead -- the exemption list becoming the
     very thing this suite refuses. */
  const { RETENTION_PREF_KEY } = require('../../shell/uninstall-retention.cjs')
  assert.equal(RETENTION_PREF_KEY, 'mc.set.uninstall_data', 'uninstall_data is no longer read from its settings-row storage key')

  const {
    GLOW_SETTING_ID,
    REDUCE_MOTION_SETTING_ID,
    rememberAppearance,
    storedAppearance,
  } = await import('../../src/appearance-persistence.js')
  const values = new Map()
  const storage = {
    getItem: key => values.has(key) ? values.get(key) : null,
    removeItem: key => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  }
  rememberAppearance(GLOW_SETTING_ID, 73, storage)
  rememberAppearance(REDUCE_MOTION_SETTING_ID, true, storage)
  assert.deepEqual(
    Object.fromEntries(values),
    { 'mc.set.glow': '73', 'mc.set.reduce_motion': 'true' },
    'appearance choices are no longer written to their settings-row storage keys',
  )
  assert.deepEqual(
    storedAppearance(storage),
    { glow: 73, reduceMotion: true },
    'the appearance reader no longer restores the values written by the settings rows',
  )

  /* THE NOTIFICATION ROWS' READER, DRIVEN. Not "does the file mention the key"
     -- a real notifier over a store holding exactly the bytes the settings page
     writes, asserting that the key is what decides whether anything is raised.
     If shell/agent-notifications.cjs stopped reading these keys, or read them
     under different names, this goes red and the two rows above lose their
     licence in the same run. */
  const { TRIGGERS, createAgentNotifier } = require('../../shell/agent-notifications.cjs')
  for (const rowId of ['notify_agent_finished', 'notify_agent_error']) {
    const trigger = Object.values(TRIGGERS).find(entry => entry.settingId === rowId)
    assert.ok(trigger, `${rowId} names no trigger in the shell seam that reads it`)
    assert.equal(trigger.key, `mc.set.${rowId}`, `${rowId} is read under a key the settings page does not write`)

    const values = {}
    const raised = []
    const notifier = createAgentNotifier({
      notifications: { isSupported: () => true, show: options => { raised.push(options) } },
      prefs: { snapshot: () => ({ values }) },
      attention: () => ({ focused: false, sessionId: null }),
    })
    assert.equal(notifier.deliver({ trigger }).delivered, false, `${rowId} notified while its key was unset`)
    values[trigger.key] = 'true'
    assert.equal(notifier.deliver({ trigger }).delivered, true, `${rowId} did not notify when its own key said true`)
    assert.equal(raised.length, 1, `${rowId} raised the wrong number of notifications`)
  }
})

test('the example row has its registry, its enforcement, and its control, by name', async () => {
  /* The owner's doctrine -- "a user setting needs registry, enforcement, and
     a control, or it's a lie" -- asserted for the one row that replaced the
     per-view family, because a toggle claiming to change EVERY screen is the
     most expensive place a dead control could sit.
       REGISTRY     src/data-source.js owns the stored choice (`mc.example`).
       ENFORCEMENT  resolveDataSource() consults the toggle first and answers
                    'mock' for every screen while it is on.
       CONTROL      the settings row writes through setExampleMode (door 1,
                    already walked above) and reads back through
                    isExampleMode, never through a private copy. */
  const savedStorage = globalThis.localStorage
  const values = new Map()
  globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    removeItem: key => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  }
  try {
    const { isExampleMode, resolveDataSource, setExampleMode } = await import('../../src/data-source.js')
    setExampleMode(true)
    assert.equal(values.get('mc.example'), 'on', 'data-source no longer stores the example choice in its registry key')
    assert.equal(isExampleMode(), true, 'data-source no longer reads back the stored example choice')
    assert.equal(await resolveDataSource(), 'mock', 'the example choice no longer forces the mock source')
  } finally {
    if (savedStorage === undefined) delete globalThis.localStorage
    else globalThis.localStorage = savedStorage
  }
  assert.match(settingsSource, /setExampleMode\(Boolean\(value\)\)/, 'the settings row no longer writes through setExampleMode')
  assert.match(settingsSource, /if \(setting\.id === 'example_mode'\) return isExampleMode\(\)/, 'the settings row no longer reads back the applied state')
  assert.match(settingsSource, /from '\.\.\/data-source\.js'/, 'the settings page no longer imports the one source module')

  /* A FOURTH THING A REGISTRY-ENFORCEMENT-CONTROL ROW CAN STILL GET WRONG:
     the control can be real and still promise an outcome it cannot deliver.
     "Turn it off to see your own records again" is false the moment there is
     no host at all -- every screen keeps showing the example whichever way
     this switch is set, because previewWithoutHost() (not isExampleMode()
     alone) is what actually decides that. data-source.js exported the
     discrimination and nothing in src/ called it (tools/test/data-source.test.mjs
     drives the exported function itself with values); this pins that the
     control settings.js draws for THIS row is the one asking it, so the row
     cannot go back to reading isExampleMode() alone. */
  assert.match(settingsSource, /previewWithoutHost/, 'the example row no longer asks whether the example is a choice or the only thing this page could draw')
})

test('the sections the page lists are exactly the sections its rows are in', () => {
  /* An empty heading is its own defect: a person opens a group, finds a
     titled section with nothing under it, and cannot tell whether it is broken
     or merely collapsed. Removing rows must remove the headings they leave
     behind. */
  assert.match(settingsSource, /const SECTIONS = SETTINGS_GROUPS\.flatMap\(group => group\.sections\)/)
  const listed = SETTINGS_GROUPS.flatMap(group => group.sections)

  /* Four sections draw their rows from a module instead of from SETTINGS --
     the chat box, Research, System and Setup. `sectionNodeMarkup` is the single
     place that routes a section to its module, so the set is read from there
     rather than restated: a section that stops being module-rendered and keeps
     no rows of its own then shows up here, which is the point. */
  const router = settingsSource.slice(
    settingsSource.indexOf('function sectionNodeMarkup(section)'),
    settingsSource.indexOf('function sectionShownCount(section)'),
  )
  assert.ok(router.length > 0, 'the section router is where this test expects it')
  assert.match(router, /section === ENTERPRISE_SECTION\) return settingsModePanel\(researchController\.markup\(\{ section \}\)/,
    'Enterprise must still route to the installed-settings controller')
  assert.ok(ENTERPRISE_SETTING_IDS.length > 0, 'Enterprise must contain real settings')
  for (const id of ENTERPRISE_SETTING_IDS) assert.ok(PRODUCT_SETTING_IDS.includes(id), `${id} is a real installed-settings row`)
  /* Only the quoted names are needed: `listed` above reads quoted entries out
     of SECTIONS, so the two that arrive as imported constants (the chat box and
     Research) are not in it to begin with. */
  const moduleRendered = new Set([
    ...PRODUCT_SECTIONS, CHATBOX_SECTION, CONNECT_SECTION, ENTERPRISE_SECTION,
    ...[...router.matchAll(/section === '([^']+)'/g)].map(match => match[1]),
  ])
  assert.ok(moduleRendered.size >= 2, `the module-rendered sections were found (${[...moduleRendered]})`)

  const populated = new Set(declaredRows().map(row => row.section))
  const empty = listed.filter(section => !populated.has(section) && !moduleRendered.has(section))
  assert.deepEqual(
    empty,
    [],
    `these sections are listed on the page and have no rows: ${empty.join(', ')}`,
  )

  /* AND THE OTHER DIRECTION, WHICH WAS NOT CHECKED UNTIL 2026-08-27. "Exactly"
     is a two-way word and only one way was asserted. A section that has rows
     and is NOT in this list still paints -- the group in
     src/settings-presentation.js is what decides that -- so nothing looks
     wrong. What it loses is everything SECTIONS is for: `levels` has no entry
     for it, so a depth-2 row added to it later is folded shut with no way to
     open it, and `SECTIONS.indexOf` answers -1, which every unlisted section
     shares, so their fold controls collide on one DOM id and one aria-controls
     target. Both are silent, and both were reachable by deleting one line. */
  const unlisted = [...populated].filter(section => !listed.includes(section) && !moduleRendered.has(section))
  assert.deepEqual(
    unlisted,
    [],
    `these sections have rows and are not in SECTIONS, so they have no fold level and share a fold id: ${unlisted.join(', ')}`,
  )
})

/* THE ROWS THE INSTALLED APPLICATION ENFORCES, HELD TO THE SAME RULE.
 *
 * The six rows src/research-settings.js draws are not in the SETTINGS
 * catalogue above -- they are written to the installation's own settings file
 * by shell/product-settings.cjs and read by the part of the program that does
 * the work. The rule is the same: a row with no reader is a drawn control.
 * Each one names its reader here, with the file and the symbol, and the pin is
 * read out of the source so deleting a reader retires the licence in the
 * same edit. The two rows the HOST reads are pinned to shell/agent-host.cjs;
 * the research family is read by the payload's own gate, which the registry
 * names in `enforcedBy` and the engine suite drives. */
test('every product-settings row names a reader, and the host really reads the two that are its own', async () => {
  const { PRODUCT_SETTING_IDS } = await import('../../src/research-settings.js')
  const host = read('shell/agent-host.cjs')
  const READERS = Object.freeze({
    'agent.tool_mode': 'payload src/lib/tool-mode.js resolves legacy values; agent-api-policy.js and agent-session-confinement.js compose the actual provider launch',
    'agent.tool_approvals': 'payload src/lib/policy.js requiresApproval reads explicit owner approval preference before consequential tools',
    'agent.persistent_continuation': 'payload src/lib/agent-ledger-continuation.js schedules host turns for unfinished tasks',
    'agent.close_asks': 'payload src/lib/minor-ledger-agent-gate.js gates answer and decline',
    'agent.blocked_question': 'payload src/lib/ask-preference.js, agent-approval-policy.js, and tool-registry.js systemAsk branch before prompt/defer/agent decision',
    'tools.audit_batch_window_ms': 'payload src/lib/audit-admission.js schedules pending records from tool-performance-settings.js bounds',
    'tools.audit_batch_size': 'payload src/lib/audit-admission.js drains at most the selected batch size',
    'tools.credential_check_interval_seconds': 'payload src/lib/vault-presence.js invalidates rememberedPresence on vault fingerprint or expiry',
    'tools.policy_enforcement': 'payload src/lib/p13-setting.js and tool-registry.js requireP13Decision; shell/product-settings.cjs pins launch environment',
    'purchases.require_owner_approval': 'payload src/lib/purchase-authority.js purchaseApprovalReserved; providers/pay.js recordSpend; shell confirmation gate',
    'fleet.concurrent_shared_writes': 'payload src/lib/shared-write-guard.js withSharedWrite at repo-files and host-control writes',
    'capability.elevation_duration': 'payload src/lib/capability-elevation-policy.js boundedCompileInput and capability-manifests.js authorization expiry',
    'capability.elevation_survives_restart': 'payload src/lib/capability-elevation-policy.js prepareState revokes grants through state-store on a new process',
    'agent.message_screening': 'payload src/lib/agent-comms/history.js screens each incoming message',
    'agent.message_delivery': 'payload src/lib/agent-message-delivery.js reads the delivery mode; shell/agent-host.cjs currentMessageDelivery applies it through messageDeliveryDecision',
    'agent.message_queue_seconds': 'payload src/lib/agent-message-delivery.js reads the interval; shell/agent-host.cjs currentMessageDelivery applies it through messageDeliveryDecision',
    'audit.retention': 'payload src/lib/audit-retention.js retentionPlan and audit.js rollArchiveOnce preserve sealed history while pruning the search window',
    'fleet.max_declared_agents': 'payload src/lib/agent-org.js — savedMaxAgents and resolveMaxAgents, consumed by src/lib/agent-org-store.js write admission (registry enforcedBy)',
    'research.pipeline': 'payload src/lib/research/settings-gate.js (registry enforcedBy)',
    'research.runner_agent': 'payload src/lib/research/settings-gate.js (registry enforcedBy)',
    'research.runner_process': 'payload src/lib/research/settings-gate.js (registry enforcedBy)',
    'research.runner_http': 'payload src/lib/research/settings-gate.js (registry enforcedBy)',
    'agent.tool_summary': 'shell/agent-host.cjs — composeToolSummaryNote via payload src/lib/agent-tool-summary.js',
    /* The per-message shortlist. The host composes it on every turn; the row
       itself is read inside the payload module, which returns an empty block
       when it is off -- so the switch is enforced one layer deeper than the
       note above, in the module the registry names as its enforcer. */
    'agent.capability_recall': 'shell/agent-host.cjs — composeCapabilityNote via payload src/lib/capability-recall/index.js',
    /* NEITHER OF THIS ROW'S READERS IS THE HOST. The payload decides it and
       emits it into the argv, on BOTH spawn paths the registry names -- the
       adapter's baseClaudeArgs for an agent thread and mission-bridge's
       claudeArgs for a dispatched lane -- so one answer governs both rather
       than each path holding its own opinion. Driven end to end by
       tools/test/agent-api-setting-drive.test.mjs, which presses the writer
       and then asserts the ARGV, not the file: until 2026-08-25 the staged
       payload carried this row's enforcer without the adapter that emits its
       flag, and a test that stopped at the file would have called that
       enforced. */
    'agent.agent_api': 'payload src/lib/agent-api-policy.js — agentApiArgs, emitted by src/lib/agent-engine/claude-cli-adapter.js baseClaudeArgs and src/lib/mission-bridge/actions.js claudeArgs (registry enforcedBy)',
    /* The owner's product-source switch (2026-09-19) is read inside the
       payload on every refused code-folder write, so no shell reader exists
       by design; the registry names the reader and the fence it feeds. */
    'agent.product_source_writes': 'payload src/lib/product-source-writes.js — productSourceWritesPolicy, read by src/lib/providers/host-control.js isProductCodeWriteAllowed before a product code folder is refused (registry enforcedBy)',
    /* The subagent route is read BEFORE either surface is chosen, which is why
       its reader is the spawn tool itself and not one of the two spawn paths:
       a row that only one surface read would be a row that decided nothing on
       the other. */
    'agent.subagent_route': 'payload src/lib/agent-subagent-route.js — subagentRoute, read by src/lib/tool-registry.js spawnSubagent before either surface is chosen, and obeyed including its refusals',
    'rules.require_read_each_turn': 'shell/agent-host.cjs — complete current snapshot on every turn via payload src/lib/rules-turn-snapshot.js, revalidated before the provider call',
    /* The three-way choice (owner, 2026-09-15) that superseded the on/off
       switch rules.capture_spoken: the gate answers the mode from it, and
       whether a /Request typed in a chat exists at all (chatFiling), which
       the host's fileStandingRequest enforces by refusing a chat filing. */
    'rules.filing_from': 'shell/agent-host.cjs — agentFilingFor via payload src/lib/r-ledger-agent-gate.js (loadAgentFilingMode: mode and chatFiling); fileStandingRequest refuses a chat-door rule filing while the choice is Ledger page only',
    /* The switch's nested sub-setting: the gate reads it beside the switch
       (loadAgentFilingMode().askWhenUnsure) and the host hands it to the
       duty paragraph at every session start. */
    'rules.ask_when_unsure': 'shell/agent-host.cjs — agentFilingFor passes askWhenUnsure to gate.requestContractParagraph (payload src/lib/r-ledger-agent-gate.js)',
    /* The switch's second sub-setting (owner, 2026-09-02): an agent's filing
       waits for the person. Enforced one layer deeper than the host, in the
       store the registry names; the host hands the same reading to the duty
       paragraph so the agent is told its filing waits. */
    'rules.agent_filed_needs_approval': 'payload src/lib/owner-request-store.js — fileRequest sets status proposed via r-ledger-agent-gate agentFiledNeedsApprovalOf; shell/agent-host.cjs agentFilingFor passes needsApproval to the duty paragraph',
    /* Outside control (owner, 2026-09-02): the payload decides whether the
       port opens and the shell asks it before Electron is ready. Neither
       reader is agent-host; the row's enforcer is the module the registry
       names. */
    'app.outside_control': 'payload src/lib/outside-control.js — outsideControlPolicy, read by shell/outside-control.cjs startOutsideControl before Electron is ready (registry enforcedBy)',
    /* Tool throughput (owner, 2026-09-03): read inside the payload on every
       call, so no shell reader exists by design; the registry names the
       reader and the three enforcers. */
    'tools.throughput': 'payload src/lib/throughput-mode.js — throughputMode, read per call by src/lib/tool-registry.js (audit admission path) and src/mcp-server.js createLineDispatcher (scheduler), which src/owner-host.js dispatches every session through (registry enforcedBy)',
    'audit.activity': 'payload src/lib/runtime-policy.js — runtimePolicy().activity, which is Off unless audit.enabled was explicitly chosen; snapshotted by src/lib/operation-audit.js capturePolicy() and applied by src/lib/tool-registry.js auditInvocation; tools/test/audit-performance-settings.test.mjs drives the shell writer into that reader',
    'audit.retention': 'payload src/lib/audit.js — configuredRetention reads audit.retention on append; src/lib/audit-retention.js selects the live window and sealed archive policy (registry enforcedBy)',
    /* THE MASTER, AND THE TWO ROWS THAT WAIT ON IT. runtime-policy.js is the
       one reader of all three: it refuses to treat a retained Full as a
       choice until the master is explicitly on. */
    'audit.enabled': 'payload src/lib/runtime-policy.js — runtimePolicy().auditEnabled is true only for an explicit user or installer true; src/lib/operation-audit.js capturePolicy() refuses an unreadable or rejected master before it mints a policy, so nothing optional is recorded on a guess (registry enforcedBy)',
    'ledger.verify_history': 'payload src/lib/runtime-policy.js — runtimePolicy().verifyHistory, consulted independently by src/lib/agent-ledger-continuation.js and src/lib/minor-ledger-agent-gate.js before either verifies a chain (registry enforcedBy)',
    'diagnostics.retention': 'payload src/lib/diagnostic-retention.js — readDiagnosticPolicy reads the row and resolveDiagnosticPolicy turns it into the bound createDiagnosticStore enforces inside the managed diagnostic directory (registry enforcedBy)',
    /* THE ONLY TWO APPLICATION-SIDE ROWS. Everything else on this page is read
       inside the payload; these two are read here, which is why the registry
       says "application" and why the loop below resolves their src/ path
       against this application rather than the staged payload. */
    'fleet.tree_width': 'application shell/tree-slot-policy.mjs — TREE_SLOT_SETTING_IDS.width, loaded from the engine registry by shell/product-settings.cjs readTreeSlotSettings; src/fleet-trees.js applies the bound to admission and moves and shell/tree-slot-admission.cjs refuses over it (registry enforcedBy)',
    'fleet.tree_depth': 'application shell/tree-slot-policy.mjs — TREE_SLOT_SETTING_IDS.depth, loaded from the engine registry by shell/product-settings.cjs readTreeSlotSettings; src/fleet-trees.js applies the bound to admission and moves and shell/tree-slot-admission.cjs refuses over it (registry enforcedBy)',
    /* WHICH MODEL ANSWERS, AND WHERE IT IS. These three have TWO readers each,
       and naming both is the point rather than a flourish: the person picks
       once and two different parts of the program obey the same pick. The
       customer-model tool reads all three in configuration() before it builds a
       request, and the local spawn tier reads the same three in
       resolveLocalTarget() before it decides which runtime and which model a
       circle talks to -- matching the chosen name against what the runtime
       actually lists, so a name nothing serves refuses by name instead of
       silently answering from another model. */
    'model.provider': 'payload src/lib/providers/customer-model.js — configuration (registry enforcedBy), and payload src/lib/agent-engine/local-node-process.js — resolveLocalTarget, which reads the same row for the local spawn tier',
    'model.endpoint': 'payload src/lib/providers/customer-model.js — configuration and requestUrl (registry enforcedBy), and payload src/lib/agent-engine/local-node-process.js — resolveLocalTarget, which probes this address before a circle starts',
    'model.name': 'payload src/lib/providers/customer-model.js — configuration (registry enforcedBy), and payload src/lib/agent-engine/local-node-process.js — resolveLocalTarget via installedName, which matches this exact string against the models the runtime lists',
    'model.local_agent_name': 'payload src/lib/local-model-options.js modelFor, used by local-node-process.js for agent model selection',
    'model.tool_name': 'payload src/lib/local-model-options.js modelFor, used by providers/customer-model.js for tool model selection',
    'model.local_gpu_policy': 'payload src/lib/local-model-options.js GPU request options and residency check',
    'model.local_context_tokens': 'payload src/lib/local-model-options.js Ollama context request option',
    'model.local_thinking': 'payload src/lib/local-model-options.js explicit native thinking option',
    'model.local_keep_alive_minutes': 'payload src/lib/local-model-options.js Ollama keep_alive request option',
  })
  const unread = PRODUCT_SETTING_IDS.filter(id => !Object.prototype.hasOwnProperty.call(READERS, id))
  assert.deepEqual(unread, [], `these product-settings rows name no reader: ${unread.join(', ')}`)

  /* The host's readers, by symbol. */
  assert.match(host, /PAYLOAD_TOOL_SUMMARY_MODULE = 'src\/lib\/agent-tool-summary\.js'/, 'the host no longer loads the tool-summary module')
  assert.match(host, /composeToolSummaryNote\(toolSummary, basePlan\)/, 'the host no longer composes the tool note from the row\'s enforcer')
  assert.match(host, /PAYLOAD_CAPABILITY_RECALL_MODULE = 'src\/lib\/capability-recall\/index\.js'/, 'the host no longer loads the per-message recommender')
  assert.match(host, /composeCapabilityNote\(capabilityRecall, session, turnText\)/, 'the host no longer composes the per-message block from the row\'s enforcer')
  assert.match(host, /PAYLOAD_R_LEDGER_AGENT_GATE_MODULE = 'src\/lib\/r-ledger-agent-gate\.js'/, 'the host no longer loads the agent-filing gate')
  assert.match(host, /gate\.loadAgentFilingMode\(\)/, 'the host no longer asks the gate for the mode rules.filing_from decides')
  assert.match(host, /agentFilingFor\(agentFilingGate, basePlan\)/, 'the host no longer reads the switch at session start')
  assert.match(host, /session\.agentFiling\.mode !== 'auto'/, 'the spool no longer consults the mode the switch decides')
  /* The nested sub-setting reaches the paragraph through the SAME gate answer
     and the SAME paragraph call -- one read, so the two cannot disagree. */
  assert.match(host, /const askWhenUnsure = Boolean\(decision && decision\.askWhenUnsure === true\)/, 'the host no longer reads rules.ask_when_unsure off the gate answer')
  assert.match(host, /const needsApproval = Boolean\(decision && decision\.needsApproval === true\)/, 'the host no longer reads rules.agent_filed_needs_approval off the gate answer')
  assert.match(host, /const chatFiling = !\(decision && decision\.chatFiling === false\)/, 'the host no longer reads whether the typed commands exist off the gate answer')
  assert.match(host, /gate\.requestContractParagraph\(mode, \{ canFile, askWhenUnsure, needsApproval, chatFiling \}\)/, 'the host no longer hands askWhenUnsure, needsApproval and chatFiling to the duty paragraph')
  assert.match(host, /via === 'chat' && \(kind === undefined \|\| kind === null\) && !chatFilingAllowed\(agentFilingGate\)/, 'the host no longer refuses a chat-door rule filing when the choice is Ledger page only')

  /* The registry, when a payload is staged, names an enforcer for every row:
     a row with `enforcedBy: ""` is the exact shape rules.capture_spoken had
     before O7 -- a control a person could set that changed nothing. */
  const payloadRoot = process.env.MC_TEST_SETTINGS_PAYLOAD || path.join(ROOT, 'capability')
  const registryFile = path.join(payloadRoot, 'config', 'settings-registry.json')
  let registry = null
  try { registry = JSON.parse(readFileSync(registryFile, 'utf8')) } catch { registry = null }
  assert.ok(registry, 'Pack the capability layer or name the engine source with MC_TEST_SETTINGS_PAYLOAD to verify real registered readers')
  for (const id of PRODUCT_SETTING_IDS) {
    const entry = registry.entries.find(row => row.id === id)
    assert.ok(entry, `${id} is not in the staged registry`)
    assert.ok(typeof entry.enforcedBy === 'string' && entry.enforcedBy.trim().length > 0, `${id} names no enforcer in the registry`)
    const paths = [...entry.enforcedBy.matchAll(/(?:src|shell)\/[\w/.-]+\.(?:cjs|js)\b/g)].map(match => match[0])
    assert.ok(paths.length > 0, `${id} names no concrete reader file`)
    /* WHICH SIDE OWNS THE NAMED FILE. `shell/...` is always this application.
       `src/...` is the payload for every row the map above calls `payload`,
       and this application for the two it calls `application`: the registry
       writes "application shell/tree-slot-admission.cjs; src/fleet-trees.js"
       because src/fleet-trees.js is OURS, and the payload does not ship it and
       is not supposed to. The side comes from the map, not from guessing at
       the sentence, so a payload module that goes missing still fails here --
       which is how audit.activity's dead src/lib/audit-activity.js was found. */
    const applicationSide = String(READERS[id] || '').startsWith('application')
    for (const file of paths) {
      const side = file.startsWith('shell/') || applicationSide ? ROOT : payloadRoot
      assert.ok(readFileSync(path.join(side, file), 'utf8').trim(),
        `${id} names an absent or empty ${side === ROOT ? 'application' : 'payload'} reader: ${file}`)
    }
  }
  assert.equal(registry.entries.find(row => row.id === 'rules.capture_spoken').default, false, 'the rule switch must ship OFF')
  assert.equal(registry.entries.find(row => row.id === 'rules.capture_spoken').control, 'toggle', 'the rule switch is one switch, on or off')
  const filingFrom = registry.entries.find(row => row.id === 'rules.filing_from')
  assert.equal(filingFrom.default, 'Ledger page and /Request', 'the three-way choice ships at the switch\'s old off meaning: agents out, typed commands in')
  assert.deepEqual(filingFrom.options, ['Ledger page only', 'Ledger page and /Request', 'Agents too'])
})
