import { answersForAutonomy, deriveProfile, PROFILE_INTENT } from './setup-profile.js'
import { SETUP_APPROVAL_CHOICES } from './setup-intent-commit.js'

// A working profile is a set of policy values, independent of the Settings
// detail view and the machine's authority. Every writable product row has an
// explicit disposition here; the coverage test catches new unclassified rows.
// Six working presets, from least acting to persistent ledger continuation.
export const WORKING_PROFILES = Object.freeze([
  { id: 'locked', label: 'Locked', autonomy: 'assisted', description: 'Keep tool approval prompts, start one agent at a time, and leave more room for other work.' },
  { id: 'careful', label: 'Careful', autonomy: 'assisted', description: 'Keep permission prompts, start at most two agents at a time, and leave more room for other work.' },
  { id: 'balanced', label: 'Balanced', autonomy: 'assisted', description: 'Work when you start an assistant and keep approvals. If you have switched resource admission on, launches are paced using CPU and RAM.' },
  { id: 'independent', label: 'Independent', autonomy: 'autonomous', description: 'Enable permitted app actions and agent judgement. Tool approval prompts are off; purchases still need you.' },
  { id: 'autonomous', label: 'Autonomous', autonomy: 'autonomous', description: 'Use Independent’s action rules with more concurrent starts and shorter waits. Purchases and new access still need you.' },
  { id: 'autonomous-plus', label: 'Autonomous+', autonomy: 'autonomous', description: 'Keep working through authorized ledger tasks with saved continuation and bounded retries after temporary failures. Pace starts for long sessions and switch to other work when approval is needed. Stop, access rules, purchases and account limits still apply.' },
])

// Columns follow WORKING_PROFILES. Acting profiles continue authorized work;
// Autonomous+ adds headroom. No preset grants access or purchase consent.
export const PROFILE_PRODUCT_VALUES = Object.freeze({
  'agent.persistent_continuation': [false, false, false, true, true, true],
  'agent.tool_summary': [true, true, true, true, true, true],
  'agent.capability_recall': [true, true, true, true, true, true],
  'agent.tool_approvals': [true, true, true, false, false, false],
  'agent.close_asks': [false, false, false, true, true, false],
  'agent.blocked_question': ['Stop and wait for me', 'Stop and wait for me', 'Switch to other work', 'Decide for itself', 'Decide for itself', 'Switch to other work'],
  'rules.filing_from': ['Ledger page and /Request', 'Ledger page and /Request', 'Ledger page and /Request', 'Agents too', 'Agents too', 'Agents too'],
  'rules.ask_when_unsure': [true, true, true, true, true, true],
  'rules.agent_filed_needs_approval': [true, true, true, true, true, true],
  'tools.throughput': ['strict', 'fast', 'fast', 'fast', 'fast', 'fast'],
  'tools.audit_batch_window_ms': [0, 1, 1, 2, 4, 4],
  'tools.audit_batch_size': [128, 256, 512, 1024, 2048, 2048],
  'tools.credential_check_interval_seconds': [0, 0, 0, 0, 0, 0],
  'purchases.require_owner_approval': [true, true, true, true, true, true],
  'fleet.concurrent_shared_writes': [false, false, false, false, false, false],
  'capability.elevation_duration': [5, 15, 60, 60, 60, 60],
  'capability.elevation_survives_restart': [false, false, false, false, false, false],
  'agent.message_screening': ['Refuse look-alikes', 'Allow code names', 'Allow code names', 'Allow code names', 'Allow code names', 'Allow code names'],
  'fleet.max_declared_agents': [8, 16, 64, 256, 512, 512],
})

/* AUDITING IS NOT A PRESET VALUE ANY MORE (owner direction, 2026-09-20, T782:
   "for most users we dont want to save everything forever or audit or verify
   everything ... These advanced things should need to be enabled and setup in
   advanced/expert/enterprise rather than be auto enabled"). Every one of the
   six presets used to write `audit.activity` = Full, so choosing Basic or
   Autonomous silently switched detailed activity auditing back on. A working
   profile now leaves that row exactly as the person set it, or unset; the
   detailed-audit setup is its own explicit choice under Advanced. The same
   holds for the resource admission MODE below: presets carry pacing values for
   the person who has switched enforced admission on, and never switch it on
   themselves. */
export const PROFILE_PRODUCT_PRESERVED = Object.freeze({
  'audit.activity': 'Keep your activity audit choice. Detailed activity auditing is an optional setup under Advanced; a working profile never turns it on or off for you.',
  /* Owner direction 2026-09-20 (T781/T782/T783): the signed audit, ledger
     history verification and diagnostic retention are explicit setups under
     Advanced, off or finite on a fresh copy. No preset writes them. */
  'audit.enabled': 'Keep your signed activity audit choice. It is an optional setup under Advanced, off until you turn it on; a working profile never switches it.',
  'ledger.verify_history': 'Keep your ledger history verification choice. It is an optional setup under Advanced; a working profile never switches it.',
  'diagnostics.retention': 'Keep your diagnostic retention choice. Keep and Archive are explicit choices under Advanced; a working profile never changes them.',
  /* The reusable-slot shape (direct child slots per agent, delegation depth)
     is the person's own tree layout: lowering it keeps existing descendants,
     raising it opens no slot by itself, and no preset knows their tree. */
  'fleet.tree_width': 'Keep your direct child slots per agent. The slot shape of your trees is your own layout choice, not a working-profile value.',
  'fleet.tree_depth': 'Keep your delegation depth. Existing descendants stay where they are; a working profile never reshapes your trees.',
  'rules.require_read_each_turn': 'Keep your choice to include all applicable standing rules before every turn.',
  'agent.message_delivery': 'Keep your selected message delivery mode when changing a working profile.',
  'agent.message_queue_seconds': 'Keep your chosen message batching interval when changing a working profile.',
  'agent.agent_api': 'Available tool sets are an independent session boundary. Existing Only restrictions and Disabled API withholding stay in effect.',
  'agent.product_source_writes': 'Letting agents edit ToolsEnabled source in checkouts is your separate opt-in; a working profile never lifts the product-code fence for you.',
  'agent.subagent_route': 'Delegation is your independent choice.',
  'app.outside_control': 'External control is a separate opt-in and needs an app restart.',
  'tools.policy_enforcement': 'The additional tool authorization gate depends on the configured host and launch policy. Change it explicitly in Tool use.',
  'audit.retention': 'Keep your fast searchable activity window. Older signed activity moves to sealed storage according to this choice; this setting deletes no audit history.',
  ...Object.fromEntries(['pipeline', 'runner_agent', 'runner_process', 'runner_http'].map(key => [`research.${key}`, 'Keep the explicit research opt-in. Enabling it can resume queued unattended work, including commands or web requests; choose that separately in Research.'])),
  ...Object.fromEntries(['provider', 'endpoint', 'name', 'local_agent_name', 'tool_name'].map(key => [`model.${key}`, 'Keep the exact service and model identity you configured. A profile does not choose where prompts go or replace a model.'])),
  'model.local_gpu_policy': 'Keep the explicit GPU requirement or CPU fallback consent. System RAM alone cannot prove that the selected model fits GPU memory.',
  'model.local_context_tokens': 'Keep the context window you set for the selected model and available memory. Tune it separately in Local models.',
  'model.local_thinking': 'Keep the thinking choice for the selected model, including its own default. Tune it separately in Local models.',
  'model.local_keep_alive_minutes': 'Keep the idle model lifetime you chose for local memory use. Tune it separately in Local models.',
})

export const PROFILE_LOCAL_PRESERVED = Object.freeze({
  uninstall_data: 'Keep your separate decision about removing data during uninstall.',
  theme: 'Keep your chosen appearance.',
  ui_font: 'Keep your chosen letter shapes and readability.',
  home_circle_style: 'Keep your chosen Home circle appearance.',
  home_circle_motion: 'Keep your Home circle motion and accessibility preference.',
  /* THE THREE STATUS COLORS ARE EXPLAINED ONE BY ONE, NOT AS A GROUP, and
     they are written out rather than mapped from HOME_STATUS_COLOR_SETTINGS.
     This list is what the coverage test measures every writable row against,
     so deriving it from the same array the rows come from would make a new
     color setting classify itself with a borrowed sentence -- self-selected
     coverage, which is the thing that test exists to prevent. Each reason
     says what that one color is for, because the dialog prints it beside
     that one row's name. */
  home_circle_clear_color: 'Keep your color for a ledger with nothing waiting. Status colors are a per-theme display choice saved on this computer, not policy that travels with a profile.',
  home_circle_attention_color: 'Keep your color for owner asks and proposals. A profile changes what agents may do; it never changes which color tells you something is waiting for you.',
  home_circle_blocked_color: 'Keep your color for blocked work. The one mark that says the owner is needed is yours to set, on Home and on the Ledger register. No working profile repaints it.',
  tree_style: 'Keep your chosen tree layout and node appearance.',
  tree_cards: 'Keep your chosen visibility of tree context cards.',
  text_size: 'Keep your reading size and accessibility preference.',
  reduce_motion: 'Keep your motion and accessibility preference.',
  glow: 'Keep your chosen visual intensity.',
  example_mode: 'Keep the example preference; complete profiles need examples off and local resource access.',
  notify_agent_finished: 'Keep your explicit notification opt-in.',
  notify_agent_error: 'Keep your explicit notification opt-in.',
})

export const PROFILE_PRESERVED_SCOPES = Object.freeze([
  ['Permission level and working folders', 'Keep the permission ceiling, its consent record and workspace roots. A working profile does not change those records. Working folders do not guarantee that other files cannot be read.'],
  ['Action permission profiles', 'Keep the active profile, name, parent, per-action rules and allowed function list. These restrictions still constrain the working profile.'],
  ['Accounts and credentials', 'Keep linked accounts, priorities, quota reserves, provider overrides, passwords, PINs and keys. The listed automatic/manual account selection is the only account policy a profile changes.'],
  ['Fleet and remote connections', 'Keep fleet labels, machine IDs/names/addresses, data folders, transports/ports/endpoints, pairing, web-drive opt-in and remote-workspace consent. These identify and authorize real destinations.'],
  ['Reading and appearance', 'Keep the Settings detail view, theme, font, text size, motion, glow, every role color and every ledger status color. Profiles preserve readability and accessibility choices.'],
  ['Home and tree display', 'Keep selected Home agents, run visibility, default context-card size and every per-tree override. These are display choices, not action policy.'],
  ['Notifications', 'Keep both finish and problem notifications as chosen. A profile neither requests notification permission nor opts into interruptions.'],
  ['Example screens', 'Keep the example-fleet choice. Complete profiles require local desktop Settings with examples off; unavailable resources are never silently omitted.'],
  ['Voice, accessibility and hand controls', 'Keep listening/speech choices, accessibility inputs, camera/hand enablement and device consent. Profiles do not start a microphone or camera.'],
  ['Computer control', 'Keep the selected agents, all-running/selected mode and live grants. Screen, mouse and keyboard access still needs its explicit Enable control and remains one agent at a time.'],
  ['Transcript archive', 'Keep the archive folder, closed-archive quota and delete-nodes-on-exit choice. Reducing that quota can delete closed history, so it needs its own decision.'],
  ['Uninstall and updates', 'Keep uninstall data retention and the update-check policy. A working profile does not choose deletion or installation behavior.'],
  ['Maintenance and setup actions', 'Comparison, cloud mirror setup, ledger archiving, audit identity maintenance, reset, connect/disconnect and consent dialogs are explicit operations, not preset values.'],
  ['Program RAM estimates', 'Keep the measured Claude, Codex and Local launch reservations, including larger or fractional calibrations. Profiles set all nine resource policy and pacing values; replacing a measured program cost with a generic estimate could over-admit work.'],
])

const MIB = 1024 ** 2
/* The pacing values a profile writes. `mode` -- whether admission is enforced
   at all -- is deliberately not among them; see PROFILE_RESOURCE_PRESERVED. */
export const PROFILE_RESOURCE_KEYS = Object.freeze(['reserveBytes', 'maxConcurrentStarts', 'cpuCeilingPercent', 'cpuBusyPercent', 'startIntervalMs', 'busyStartIntervalMs', 'settleMs', 'sampleMaxAgeMs'])
export const PROFILE_RESOURCE_PRESERVED = Object.freeze({
  mode: 'Keep your resource admission policy. Enforced CPU and RAM admission is an optional setup under Advanced. A working profile sets its pacing values and never switches it on or off for you.',
})

// Same column order as PROFILE_PRODUCT_VALUES.
const PROFILE_RESOURCE_VALUES = Object.freeze({
  maxConcurrentStarts: [1, 2, 8, 16, 32, 8],
  cpuCeilingPercent: [85, 90, 97, 97, 97, 90], cpuBusyPercent: [55, 65, 80, 85, 90, 75],
  startIntervalMs: [1000, 500, 250, 100, 50, 500], busyStartIntervalMs: [10000, 7500, 5000, 2500, 1500, 5000],
  settleMs: [8000, 6000, 4000, 4000, 3000, 8000],
})
const PROFILE_SPARE_MIB = Object.freeze([4096, 4096, 2048, 2048, 1536, 4096])
const PROFILE_SPARE_FRACTION = Object.freeze([0.25, 0.25, 0.125, 0.125, 0.1, 0.2])
const UNATTENDED_IDS = new Set(['independent', 'autonomous', 'autonomous-plus'])

export function workingProfilePlan(id, { tier, writeFlagIds = [], totalBytes, keepApprovals = null } = {}) {
  const index = WORKING_PROFILES.findIndex(profile => profile.id === id)
  if (index < 0) throw new Error('Choose one of the working profiles.')
  const choice = WORKING_PROFILES[index]
  const answers = answersForAutonomy(choice.autonomy)
  if (id === 'autonomous-plus') answers.approvals = 'other-work'
  if (id === 'locked' || id === 'careful') Object.assign(answers, { approvals: 'stop', attach: 'mirror', ideImport: 'none', failover: 'manual' })
  /* "When an agent needs an answer" reaches its row through Setup's own
     writer rather than the product list, so keeping the person's own choice
     means deriving the whole plan from it -- the intent, the row and the
     Setup record then agree, which staging the row alone would not give. */
  if (keepApprovals && Object.hasOwn(SETUP_APPROVAL_CHOICES, keepApprovals)) answers.approvals = keepApprovals
  const setup = deriveProfile(answers, { tier, writeFlagIds })
  const product = Object.fromEntries(Object.entries(PROFILE_PRODUCT_VALUES).map(([key, values]) => [key, values[index]]))
  product['agent.blocked_question'] = SETUP_APPROVAL_CHOICES[setup.intent.approvals]
  if (!['standard', 'unrestricted'].includes(tier)) {
    product['agent.tool_approvals'] = true
    product['agent.close_asks'] = false
    product['rules.filing_from'] = 'Ledger page and /Request'
  }
  const capacityMiB = Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes / MIB : null
  const spareMiB = PROFILE_SPARE_MIB[index]
  const reserveMiB = capacityMiB === null ? spareMiB
    : Math.max(256, Math.min(spareMiB, Math.floor(capacityMiB * PROFILE_SPARE_FRACTION[index])))
  /* Pacing only. No `mode`: a profile never decides whether admission is
     enforced (PROFILE_RESOURCE_PRESERVED). */
  const resources = {
    reserveBytes: reserveMiB * MIB,
    ...Object.fromEntries(Object.entries(PROFILE_RESOURCE_VALUES).map(([key, values]) => [key, values[index]])),
    sampleMaxAgeMs: 6000,
  }
  const description = UNATTENDED_IDS.has(id) && !['standard', 'unrestricted'].includes(tier)
    ? `Enable the app actions allowed by Guided. Tool approvals and stop-and-wait stay on; the other limits use the ${choice.label} values listed below.`
    : choice.description
  return { ...choice, description, tier, setup, product, resources }
}

export function matchWorkingProfile(plan, { product, setup, resources, resourceApplicable = true } = {}) {
  const differences = []
  for (const [id, value] of Object.entries(plan.product)) {
    const row = product?.find(row => row.id === id)
    if (row?.applicable === false) continue
    if (!row || row.present === false || !Object.is(row.value, value)) differences.push(id)
  }
  for (const [id, value] of Object.entries(plan.setup.writeFlags)) if (setup?.writeFlags?.[id] !== value) differences.push(`write:${id}`)
  for (const field of PROFILE_INTENT) {
    if (field.id === 'failover' && setup?.accounts?.applicable === false) continue
    if (setup?.intent?.[field.id] !== plan.setup.intent[field.id]) differences.push(`setup:${field.id}`)
  }
  if (resourceApplicable) for (const [id, value] of Object.entries(plan.resources)) {
    if (!Object.is(resources?.[id], value)) differences.push(`resources:${id}`)
  }
  return { matches: differences.length === 0, differences }
}
