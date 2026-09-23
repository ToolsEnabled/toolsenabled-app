'use strict'

/* THE HALF OF A USER SETTING THAT DID NOT EXIST: A WAY TO CHANGE IT.
 *
 * The owner's rule, stated and re-stated: a user setting is a registry row, a
 * real enforcement, AND a control in the software -- or it is a lie. The
 * research rows had two of the three. `research.pipeline`, `research.runner_agent`,
 * `research.runner_process` and `research.runner_http` are declared in the
 * payload's config/settings-registry.json and genuinely enforced by
 * src/lib/research/settings-gate.js (the provider's submit path, the runs
 * worker, and runner selection all ask it and none of them re-reads settings on
 * its own). What nothing in this product had was a WRITER. The whole tree
 * carried exactly one settings entry point -- `settings.read` in the payload's
 * tool registry -- and no bridge action, no IPC channel and no control anywhere
 * that could set a value.
 *
 * The consequence a person met: the research page says "The research pipeline
 * is switched off in settings", and there was no such switch in Settings. The
 * only way to run anything was to hand-write
 * %LOCALAPPDATA%\ToolsEnabled\settings.json, which is what the final gate did.
 * For a research product that is fatal: the feature is unreachable by its user.
 *
 * WHY THE SHELL OWNS THIS AND NOT THE PAGE. The settings file lives beside the
 * machine record in the installation's own directory, outside the renderer's
 * reach by design -- the same reason the account boundary and the data reset are
 * main-process acts. A renderer-side "setting" would be a localStorage key that
 * the capability layer never reads, which is the defect, not the fix.
 *
 * WHY THE SHELL AND NOT THE BRIDGE. The capability payload is DERIVED from a
 * pinned engine source (private/capability-source.owner.json), so a new bridge
 * action would have to land in a different repository and be re-cut before it
 * could ship here. The shell already requires payload modules for exactly this
 * class of job (shell/canonical-audit.cjs, shell/setup-record.cjs), and doing it
 * here keeps the enforcement, the file format and the validator as the payload's
 * -- which is the property that matters. Nothing in this file re-implements a
 * rule the payload owns.
 *
 * THE VALIDATOR IS THE PAYLOAD'S, ASKED RATHER THAN COPIED. src/lib/settings.js
 * keeps its per-control validation private (`validationFailure`). Restating it
 * here would create a second opinion about what a legal value is, and the two
 * would drift in the direction that hurts: this file accepting something the
 * gate then reads as "not exactly true" and withholds, with a switch on the
 * screen that says ON. So a write is performed and then RE-READ through
 * loadSettings(), and a value that comes back rejected is rolled back to the
 * exact bytes that were there before and reported with the payload's own
 * sentence. The authority is never duplicated; it is consulted.
 *
 * PROVENANCE IS THE POINT OF THE WRITE. The gate refuses a value whose
 * provenance is not `user` or `installer` -- "a control enforcing an
 * agent-invented value is a software failure". This writer stamps `user` and
 * only `user`, because the only caller is a person moving a control in the
 * window. Nothing here can stamp `installer`, and no caller can ask it to.
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const { resolveCapabilityRoot } = require('./capability-layer.cjs')

/* Declared in tools/capability-manifest.json under `hostModules`, for the same
   reason shell/canonical-audit.cjs declares src/lib/audit.js: these are modules
   the SHELL requires out of the payload rather than programs the payload runs,
   and a require() walk from the payload's entrypoints is not what puts them
   there. A miss below names the manifest instead of reporting a bare
   MODULE_NOT_FOUND. */
const SETTINGS_MODULE = 'src/lib/settings.js'
const REGISTRY_MODULE = 'src/lib/settings-registry.js'
const MODE_MODULE = 'src/lib/agent-api-mode.js'

/* THE ROWS THIS SHELL WILL WRITE, BY NAME, AND WHY THERE IS A LIST AT ALL.
 *
 * The registry declares 50-odd settings, and most of them are enforced by parts
 * of the payload this window has never driven and this lane has not measured. A
 * writer that accepted any id would put a control on the glass for every one of
 * them -- which is the same lie in the other direction: a switch that moves a
 * value nothing in this build reads.
 *
 * So the surface is opened one row at a time, each admitted only once its
 * enforcement has been driven end to end. These four are the research family,
 * and this lane drives them: the settings gate, the provider's submit path and
 * the runs worker all consult them, and tools/research-walkthrough-qa.mjs
 * presses the switch and watches a real process run.
 *
 * ADDING A ROW HERE IS A DELIBERATE ACT WITH A DRIVE ATTACHED. It is not a
 * convenience list to grow; it is the boundary of what this product can
 * honestly say it lets you change. */
const WRITABLE_IDS = Object.freeze([
  'research.pipeline',
  'research.runner_agent',
  'research.runner_process',
  'research.runner_http',
  /* The standard tool note handed to every new agent session. Its enforcement
     is driven end to end: the payload's src/lib/agent-tool-summary.js is the
     row's named enforcer (engine suite tests/agent-tool-summary.test.js proves
     the row off means no note), and tools/test/tool-summary-injection.test.mjs
     proves the host injects on-and-only-on. Until this build's payload is
     repacked with that module, readProductSettings honestly reports the row as
     not present in this copy's registry -- which is the designed mismatch
     surface, not a dead switch. */
  'agent.tool_summary',
  /* THE PER-MESSAGE SHORTLIST. Its enforcement is driven end to end the same
     way: the payload's src/lib/capability-recall/index.js is the row's named
     enforcer and reads it before it opens the index (engine suite
     tests/capability-recall.test.js drives both sides of the switch against
     a real settings file), and tools/test/capability-recall-injection.test.mjs
     proves this host appends the block on a turn and appends nothing when the
     module answers with an empty one. Like the row above it, this reports as
     not present in this copy's registry until the payload is repacked with
     the module and the catalogue that carries the row. */
  'agent.capability_recall',
  /* WHETHER AN AGENT WORKS THROUGH THIS PRODUCT'S TOOLS OR THE CLI'S OWN
     BUILT-IN ONES -- the owner's feature and his name for it, shipped ON.
     Admitted under this list's own rule, with the drive attached and passing:
     the payload's src/lib/agent-api-policy.js is the row's named enforcer, and
     tools/test/agent-api-setting-drive.test.mjs presses THIS writer, reads the
     file back through that enforcer, and asserts the argv a session is really
     spawned with -- both ways round, so the OFF case cannot pass merely by the
     flag never appearing at all.

     HELD OUT UNTIL 2026-08-25, and the reason is worth keeping. The staged
     payload carried the registry row AND the enforcer but NOT the adapter that
     emits the flag, so a control here would have moved a value one of the
     row's two declared spawn paths ignored. The engine had that wiring the
     whole time; the payload did not, and the payload is what a person runs. */
  'agent.agent_api',
  /* WHETHER AGENTS MAY EDIT THIS PRODUCT'S OWN SOURCE IN A CHECKOUT (owner,
     2026-09-19: with tool sets on Only the host write fence refused every
     lane's checkout edit -- "there needs to be a switch in settings for
     this"). Shipped OFF. Drawn directly under Available tool sets because it
     is the same subject: Only makes ToolsEnabled's file tools the only way an
     agent can write, and this row decides whether those tools may touch
     src/, shell/ and the other product code folders inside a checkout. Its
     enforcer is the payload's src/lib/product-source-writes.js, read by
     src/lib/providers/host-control.js before it refuses a product code
     folder, under the same provenance rule as outside control: this writer's
     `user` stamp is what makes a true count. The running installation stays
     refused whatever the row says. */
  'agent.product_source_writes',
  'agent.tool_approvals',
  'agent.close_asks',
  'agent.persistent_continuation',
  'agent.blocked_question',
  /* WHERE AN ASSISTANT'S OWN ASSISTANTS APPEAR (owner, 2026-09-02: an
     assistant may start another "via toolsenabled api as non tree agents or
     ... as full user toggled agents", settled in settings). Drawn next to the
     Agent API row because it is the same subject, and NOT nested under it,
     because that row decides whether an assistant also keeps its own built-in
     tool for this and turning it off does not stop agent.spawn -- a nested row
     would be greyed out while it still decided something. Its enforcer is the
     payload's src/lib/agent-subagent-route.js, read by agent.spawn before
     either surface is chosen. */
  'agent.subagent_route',
  'agent.task_difficulty_enabled',
  'agent.task_only_delegation',
  'agent.comms_enabled',
  'agent.message_delivery',
  'agent.message_queue_seconds',
  'rules.require_read_each_turn',
  /* WHO ADDS STANDING RULES (owner, 2026-09-15: "either manually on the
     ledger page only, or ledger page and /request, or agent and such like
     now"). One three-way choice over every door into the rules ledger. It
     supersedes the on/off switch rules.capture_spoken (O7; the owner's ruling,
     2026-08-22: "i think just on or off is fine"), which stays in the payload's
     catalogue and is kept in step by the payload's src/lib/settings.js: a
     chosen answer here sets the switch (on only for "Agents too"), so every
     reader built on the switch -- the payload's src/lib/r-ledger-agent-gate.js,
     which the r_ledger.* tools ask before filing and which shell/agent-host.cjs
     reads at every session start to choose the duty paragraph an agent is
     handed and whether the person's typed turns are spooled -- keeps working,
     and the switch itself is no longer drawn. The gate also reads this row for
     whether the typed /Request commands exist at all ("Ledger page only" turns
     them off; shell/agent-host.cjs fileStandingRequest refuses a chat filing
     then). A value nobody chose cannot turn agents on (the gate's provenance
     rule) -- so this writer's `user` stamp is what makes the choice real.
     tools/test/owner-turn-spool.test.mjs and request-contract.test.mjs drive
     both sides of it. */
  'rules.filing_from',
  /* ITS ONE SUB-SETTING (O7 improvements; owner, 2026-08-22: "this is more
     of a user setting. default no. nest it below in settings"). With it on,
     an agent that is not sure files nothing and ends its reply with one short
     question. Same enforcer -- the gate reads it beside the switch
     (loadAgentFilingMode().askWhenUnsure) and shell/agent-host.cjs hands it
     to the duty paragraph at every session start. The page draws it nested
     under the switch and disabled while the switch is off; written here with
     the same `user` stamp, because the gate's provenance rule applies to it
     too. Directly after its parent: the page draws rows in THIS order. */
  'rules.ask_when_unsure',
  /* THE SWITCH'S SECOND SUB-SETTING (owner directive, 2026-09-02: one
     canonical ledger; an agent's filing may wait for the person). With it on,
     a rule an agent files lands as a proposal the person approves or declines
     on the Ledger page before any agent treats it as in force; off (the
     default), it counts the moment it is filed. Its enforcer is the payload's
     src/lib/owner-request-store.js -- fileRequest sets the record's status
     from the gate's reading of this row (r-ledger-agent-gate
     agentFiledNeedsApprovalOf, the same three-rule pattern as the row above:
     only a user/installer `true` turns it on) -- and shell/agent-host.cjs
     hands the same reading to the duty paragraph at every session start.
     Directly after its sibling: the page draws rows in THIS order. */
  'rules.agent_filed_needs_approval',
  /* WHETHER A PROGRAM OUTSIDE THIS APP MAY DRIVE IT (owner, 2026-09-02: "the
     version on my computer SHOULD allow you an agent to touch buttons from the
     outside and this should be a setting not a standard"). Shipped OFF. Its
     enforcer is the payload's src/lib/outside-control.js, read by
     shell/outside-control.cjs before Electron is ready, under the same
     provenance rule as agent.tool_approvals: this writer's `user` stamp is
     what makes a true count. tools/test/outside-control.test.mjs drives the
     shell half and checks the payload, this list and the manifest agree. */
  'app.outside_control',
  /* HOW FAST ASSISTANTS' TOOL CALLS ARE HANDLED (owner, 2026-09-03: "keep
     things secure and tracked but do not slow down a user with even 1000
     agents making tool calls"). fast (the default) runs calls side by side
     and saves their activity records in batches on a helper thread; strict
     is the older one-at-a-time behaviour. Its enforcers are the payload's
     src/lib/throughput-mode.js (the reader), src/lib/tool-registry.js and
     src/lib/audit-admission.js (the records), src/mcp-server.js and
     src/owner-host.js (the scheduling); read on every call, so it applies
     without a restart. */
  'tools.throughput',
  'tools.audit_batch_window_ms',
  'tools.audit_batch_size',
  'tools.credential_check_interval_seconds',
  'tools.policy_enforcement',
  'purchases.require_owner_approval',
  'fleet.concurrent_shared_writes',
  'capability.elevation_duration',
  'capability.elevation_survives_restart',
  'agent.message_screening',
  'audit.enabled',
  'ledger.verify_history',
  'diagnostics.retention',
  'audit.activity',
  'audit.retention',
  'fleet.tree_width',
  'fleet.tree_depth',
  'fleet.max_declared_agents',
  /* WHICH MODEL ANSWERS, AND WHERE IT IS. Admitted under this list's own rule,
     and the rule is met by these three where it was not met by
     `agent.agent_api` for months: all three are DECLARED IN THE STAGED PAYLOAD
     registry with plain titles ("Which AI service answers your requests",
     "Where your AI service is running", "Which model your AI service uses"),
     and their named enforcer, src/lib/providers/customer-model.js, is in the
     payload and reads exactly these keys. src/lib/agent-engine/
     local-node-process.js resolveLocalTarget reads the same three, so one
     choice governs both the local spawn tier and the customer-model tool
     rather than two settings that can disagree.

     WHY THEY WERE NOT HERE, which was never a decision anybody wrote down.
     `model.name` is declared `readback` -- the class this registry uses for
     values the system maintains and shows (capability.tier, the captured-rule
     list, the workspace roots). Classified that way, the model a person's own
     computer answers with became a value they could read and not choose, and
     the owner reported it as local models not working. Nothing in the writer
     consults the control class: setProductSetting checks this list and the
     registry entry, so listing them is what makes them choosable.

     THE VALIDATION THAT MUST NOT CHANGE UNDER THEM. The payload validates a
     `readback` as "any string" and a `seg`/`select` against a static
     `options` array. A local model name is whatever the runtime is serving --
     `hf.co/<publisher>/<repository>-gguf:<quantisation>` for two of the three
     models on the machine this was measured on -- so a row validated against
     a fixed list would refuse the person's own models outright.
     tools/test/local-models-settings.test.mjs asserts that round trip by
     value, and is the reason this comment does not have to be believed. */
  'model.provider',
  'model.endpoint',
  'model.name',
  'model.local_agent_name',
  'model.tool_name',
  'model.local_gpu_policy',
  'model.local_context_tokens',
  'model.local_thinking',
  'model.local_keep_alive_minutes',
])

const LEGACY_WRITABLE_IDS = Object.freeze(['agent.tool_mode'])
const PURCHASE_RESERVATION = 'Approving any purchase or spending any money'
const confirmations = new Map()

function failure(code, reason) {
  return { ok: false, code, reason }
}

let cached = null

/**
 * Load the payload's settings reader and its registry.
 *
 * Cached like shell/canonical-audit.cjs caches its writer, and for the same
 * reason: a copy with no payload should not pay a module resolution every time
 * a page asks what its settings are.
 */
function loadSettingsModules({ root = resolveCapabilityRoot(), load = require } = {}) {
  if (!root) {
    return failure(
      'SETTINGS_PAYLOAD_ABSENT',
      'No capability payload is present, so this copy carries no settings registry and nothing that would enforce one.',
    )
  }
  let settings
  let registry
  let modes
  try {
    settings = load(path.join(root, SETTINGS_MODULE))
    registry = load(path.join(root, REGISTRY_MODULE))
    modes = load(path.join(root, MODE_MODULE))
  } catch (error) {
    /* COULD NOT READ IT IS NOT DOES NOT HAVE IT. This is the sibling of the same
     * fix in shell/canonical-audit.cjs, and here it costs more: every throw
     * answered SETTINGS_MODULES_ABSENT, and settingsModules() cached ANY failure
     * with no exclusion at all -- so one EMFILE on a loaded box left
     * readProductSettings returning { ok: true, available: false, rows: [] } for
     * the life of the process. The Settings page is empty, reports ok to the
     * window, and nothing can be changed until the app restarts, while the modules
     * sit staged and healthy in the payload.
     * MODULE_NOT_FOUND is the one code that genuinely means absent. Anything else
     * says so and is NOT cached, so the next read looks again. A copy with no
     * payload is still refused above this and still caches. */
    if (error?.code === 'MODULE_NOT_FOUND') {
      return failure(
        'SETTINGS_MODULES_ABSENT',
        `The capability payload does not carry its settings modules (${error.message}). They are staged by tools/capability-manifest.json under hostModules.`,
      )
    }
    return failure(
      'SETTINGS_MODULES_UNREADABLE',
      `The capability payload's settings modules could not be read on this attempt (${error.message}). This does not say they are missing, and the next attempt is not answered from a cache.`,
    )
  }
  if (typeof settings?.loadSettings !== 'function' || typeof settings?.resolveValuesPath !== 'function'
    || typeof registry?.loadRegistry !== 'function'
    || typeof modes?.normalizeSettingChange !== 'function' || typeof modes?.settingChangesWithCompatibility !== 'function') {
    return failure('SETTINGS_MODULES_UNRECOGNIZED', 'The capability payload carries a settings module this shell does not recognize.')
  }
  return { ok: true, settings, registry, modes, registryFile: path.join(root, REGISTRY_FILE),
    optimizedApiSupport() {
      try {
        const policy = load(path.join(root, 'src', 'lib', 'agent-api-policy.js'))
        const support = policy?.optimizedApiSupport?.()
        if (support?.scope === 'installation' && support.appliesTo === 'new-sessions'
            && Array.isArray(support.providers)) return support
      } catch { /* Support metadata is optional; saved settings remain readable. */ }
      return { scope: 'installation', appliesTo: 'new-sessions', providers: [],
        reason: 'Optimized provider support could not be read from this copy.' }
    },
  }
}

/* THE PLAIN NAME OF EACH ROW, TAKEN FROM THE REGISTRY RATHER THAN WRITTEN AGAIN.
 *
 * config/settings-registry.json carries a `titles` map -- "Running research jobs
 * on this computer" and its three siblings -- and loadRegistry() drops it: it
 * validates and indexes `entries` and returns nothing else. Those titles are the
 * product's own words for these switches, already reviewed, and a settings page
 * that re-typed them would be a second wording to keep in step with the first.
 * So the same file is read once more, for that map alone.
 *
 * IT ASKED FOR THE WRONG KEY, AND THE MISS WAS SILENT BY DESIGN. This read
 * `parsed.labels` until 2026-08-20. The registry's top-level keys are exactly
 * ["schemaVersion","titles","entries"] and have been in every copy of it in this
 * tree, so the map was never found, and the "unreadable or nameless registry"
 * branch below -- meant for a broken copy -- was the ONLY branch on every
 * machine. src/research-settings.js then fell to its last resort and drew the
 * identifier, so a person opening Settings read "research.pipeline" where a
 * reviewed English sentence belongs, four rows running. The failure mode is the
 * instructive part: an absent key is indistinguishable here from a damaged
 * registry, which is correct behaviour for a damaged registry and no help at all
 * against a typo. tools/test/research-setting-titles.test.mjs is what makes the
 * key name checkable, by asserting the registry's shape directly.
 *
 * The path is the one settings-registry.js itself resolves (its
 * DEFAULT_REGISTRY_PATH is <payload>/config/settings-registry.json), so this
 * cannot address a different registry than the one the entries came from. An
 * unreadable or title-less registry yields no name, and the surface says the id
 * instead of inventing one. */
const REGISTRY_FILE = path.join('config', 'settings-registry.json')

/* Named for the key it reads, not for the field it fills. The whole defect above
   was a shell that called this map "labels" while the file called it "titles";
   keeping the shell's own word for it would leave the mismatch one rename away
   from coming back. The row's field stays `label` because that is what the page
   consumes. */
function registryTitles(registryFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(registryFile, 'utf8'))
    return parsed && typeof parsed.titles === 'object' && !Array.isArray(parsed.titles) ? parsed.titles : {}
  } catch { return {} }
}

function settingsModules(options = {}) {
  if (options.load || options.root || options.fresh) return loadSettingsModules(options)
  if (!cached) {
    const loaded = loadSettingsModules(options)
    /* A statement about this ATTEMPT is never cached as a statement about this
       installation. Everything else -- an absent payload, modules that loaded but
       are the wrong shape -- is a durable fact and still caches, which is what
       keeps a copy with no payload from paying module resolution repeatedly. */
    if (loaded.ok === false && loaded.code === 'SETTINGS_MODULES_UNREADABLE') return loaded
    cached = loaded
  }
  return cached
}

function resetForTests() {
  cached = null
}

/**
 * What every writable row is, is set to, and rests on -- read at the moment it
 * is asked for.
 *
 * `enforcement.declared` travels with each row because the payload computes it
 * and a surface must be able to say "nothing reads this" from a false. It is
 * deliberately the weaker statement in the other direction: a true means the
 * catalogue NAMES an enforcer, never that the enforcer ran.
 */
// Read only the two admission settings. A malformed saved document is not a
// request to restore defaults and grant new slots. Missing values use declared defaults.
function readTreeSlotSettings(options = {}) {
  const modules = settingsModules(options)
  if (!modules.ok) return modules
  try {
    const ids = ['fleet.tree_width', 'fleet.tree_depth']
    const registry = modules.registry.loadRegistry()
    if (ids.some(id => !registry.byId.has(id))) return failure('TREE_SLOT_SETTINGS_UNAVAILABLE', 'This engine does not declare saved tree width and depth.')
    const resolved = modules.settings.loadSettings({ registry, ids })
    const rejected = resolved.rejected.filter(row => row?.id === '*' || ids.includes(row?.id))
    if (rejected.length) return failure('TREE_SLOT_SETTINGS_UNAVAILABLE', 'The saved tree width and depth could not be read. Open Settings and correct the saved values before adding or moving an agent.')
    const maxChildren = resolved.values[ids[0]], maxDepth = resolved.values[ids[1]]
    if (!Number.isSafeInteger(maxChildren) || maxChildren < 1 || maxChildren > 64
        || !Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 16) {
      return failure('TREE_SLOT_SETTINGS_UNAVAILABLE', 'The saved tree width or depth is outside the supported range.')
    }
    return { ok: true, bounds: { maxChildren, maxDepth }, revision: resolved.revision,
      provenance: Object.fromEntries(ids.map(id => [id, resolved.provenance[id]])) }
  } catch (error) {
    return failure('TREE_SLOT_SETTINGS_UNAVAILABLE', 'The saved tree width and depth could not be read (' + (error.code || error.message) + ').')
  }
}

function readProductSettings(options = {}) {
  const modules = settingsModules(options)
  if (!modules.ok) return { ok: true, available: false, code: modules.code, reason: modules.reason, rows: [], valuesPath: null }

  let registry
  try {
    registry = modules.registry.loadRegistry()
  } catch (error) {
    return { ok: true, available: false, code: 'SETTINGS_REGISTRY_UNREADABLE', reason: `The settings registry could not be read: ${error.message}`, rows: [], valuesPath: null }
  }

  let resolved
  try {
    resolved = modules.settings.loadSettings({ registry })
  } catch (error) {
    return { ok: true, available: false, code: 'SETTINGS_UNREADABLE', reason: `This installation's settings could not be read: ${error.message}`, rows: [], valuesPath: null }
  }

  const titles = registryTitles(modules.registryFile)
  const rows = []
  for (const id of WRITABLE_IDS.flatMap(id => id === 'fleet.max_declared_agents' ? [id, 'fleet.concurrency_limits'] : [id])) {
    const entry = registry.byId.get(id)
    if (!entry) {
      /* A row this shell offers that the payload does not declare is a
         MISMATCH between the app and the engine it shipped with, and it is
         reported rather than skipped. Skipping it would draw a Settings page
         that silently lost a control between two builds. */
      rows.push({ id, present: false, reason: `"${id}" is not in this payload's settings registry, so this copy has no such control to offer.` })
      continue
    }
    rows.push({
      id,
      present: true,
      label: typeof titles[id] === 'string' && titles[id].trim() ? titles[id].trim() : null,
      control: entry.control,
      options: Array.isArray(entry.options) ? entry.options.slice() : [],
      depth: entry.depth,
      min: entry.minimum ?? null,
      max: entry.maximum ?? null,
      step: entry.step ?? null,
      unit: entry.unit ?? null,
      applies: entry.applies ?? 'next-call',
      platforms: entry.platforms ?? null,
      applicable: !entry.platforms || entry.platforms.includes(process.platform),
      default: entry.default,
      value: resolved.values[id],
      ...(id === 'agent.agent_api' ? { optimizedSupport: modules.optimizedApiSupport() } : {}),
      provenance: resolved.provenance[id],
      consequence: entry.consequence,
      warningText: entry.warningText || null,
      readOnlyReason: entry.readOnlyReason || null,
      capabilities: Array.isArray(entry.capabilities) ? entry.capabilities.slice() : [],
      risks: Array.isArray(entry.risks) ? entry.risks.slice() : [],
      enforcement: resolved.enforcement[id],
    })
  }

  return {
    ok: true,
    available: true,
    rows,
    valuesPath: resolved.valuesPath,
    revision: resolved.revision,
    workingProfile: readWorkingProfileReceipt(resolved.valuesPath),
    rejected: resolved.rejected.filter(entry => entry && (entry.id === '*' || WRITABLE_IDS.includes(entry.id))),
  }
}

/* The last working-profile application, or null when no profile has been
   applied through this build. A receipt this function cannot vouch for reads
   as no receipt at all: the page then behaves exactly as it did before one was
   ever written, which is the safe direction -- it keeps no row back. */
function readWorkingProfileReceipt(valuesPath) {
  if (typeof valuesPath !== 'string' || !valuesPath) return null
  let stored
  try { stored = readDocument(valuesPath) } catch { return null }
  const receipt = plainObject(stored.document) ? stored.document.workingProfile : null
  if (!plainObject(receipt) || typeof receipt.id !== 'string' || !receipt.id || !Number.isFinite(receipt.atMs)) return null
  return { id: receipt.id, atMs: receipt.atMs }
}

/* Read the settings document as BYTES first, because a rollback has to restore
   exactly what was there -- including a file that was not there at all, which
   is restored by being removed again. Reconstructing it from a parse would
   silently reformat somebody else's file. */
function readDocument(valuesPath) {
  let raw
  try {
    raw = fs.readFileSync(valuesPath, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return { existed: false, raw: null, document: null }
    throw error
  }
  let document = null
  try { document = JSON.parse(raw) } catch { document = null }
  return { existed: true, raw, document }
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/* Written to a sibling temporary file and renamed, with the same 0600 the
   payload's own state writers use. A settings file torn in half by a crash
   mid-write reads as an invalid structure, and loadSettings answers that by
   discarding EVERY stored value and falling back to defaults -- which for this
   family means every research control silently returning to off. */
function writeDocumentAtomic(valuesPath, document) {
  fs.mkdirSync(path.dirname(valuesPath), { recursive: true })
  const temporary = `${valuesPath}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(temporary, valuesPath)
  } finally {
    try { fs.rmSync(temporary, { force: true }) } catch { /* renamed away, or never written */ }
  }
}

function restoreDocument(valuesPath, before) {
  try {
    if (!before.existed) fs.rmSync(valuesPath, { force: true })
    else fs.writeFileSync(valuesPath, before.raw, { encoding: 'utf8', mode: 0o600 })
  } catch (error) {
    return { status: 'restore-failed', error }
  }

  /* A successful write is not enough to say the old bytes survived: the
     filesystem can reject the confirming read, or another writer can replace
     them between the restore and this check. Report that uncertainty instead
     of telling the window that the prior document is back. */
  try {
    const after = readDocument(valuesPath)
    if (after.existed === before.existed && after.raw === before.raw) {
      return { status: 'restored' }
    }
  } catch (error) {
    return { status: 'unknown', error }
  }
  // The file reads back, but not as the bytes just written: another writer
  // may have replaced them.
  return { status: 'unknown' }
}

// The person reads this sentence in Settings; restoreStatus carries the same
// answer as data ('restored', 'restore-failed' or 'unknown').
function restoreFailure(code, reason, valuesPath, before) {
  const restoration = restoreDocument(valuesPath, before)
  const detail = restoration.error ? ` (${restoration.error.code || restoration.error.message})` : ''
  const outcome = restoration.status === 'restored'
    ? 'Settings were restored.'
    : restoration.status === 'restore-failed'
      ? `Settings may have changed: the earlier settings could not be written back${detail}. Check them before relying on them.`
      : `Settings may have changed: the earlier settings were written back, but reading them again did not confirm it${detail}. Check them before relying on them.`
  return { ...failure(code, `${reason} ${outcome}`), restoreStatus: restoration.status }
}

/**
 * Set one settings row, as this person's own choice.
 *
 * Returns the same {ok,...} shape the rest of the shell's IPC uses, and on
 * success the RE-READ row rather than the value it was asked to store, because
 * what a control must show is what the enforcer will see.
 */
function setProductSetting({ id, value, confirmation }, options = {}) {
  if (![...WRITABLE_IDS, ...LEGACY_WRITABLE_IDS].includes(id)) {
    return failure('SETTING_NOT_WRITABLE', `"${id}" is not a setting this window can change.`)
  }
  const modules = settingsModules(options)
  if (!modules.ok) return modules

  try { ({ id, value } = modules.modes.normalizeSettingChange(id, value)) }
  catch (error) { return failure('SETTING_VALUE_REFUSED', error.message) }

  let registry
  try {
    registry = modules.registry.loadRegistry()
  } catch (error) {
    return failure('SETTINGS_REGISTRY_UNREADABLE', `The settings registry could not be read: ${error.message}`)
  }
  const entry = registry.byId.get(id)
  if (!entry) {
    return failure('SETTING_NOT_DECLARED', `"${id}" is not in this payload's settings registry, so there is nothing to set.`)
  }

  const valuesPath = modules.settings.resolveValuesPath({})
  let before
  try {
    before = readDocument(valuesPath)
  } catch (error) {
    return failure('SETTINGS_UNREADABLE', `This installation's settings could not be read: ${error.message}`)
  }

  /* A file that is on the disk and unparseable is NOT an empty file, and
     overwriting it would destroy every other row in it. The refusal names the
     path so a person can look. */
  if (before.existed && !plainObject(before.document)) {
    return failure(
      'SETTINGS_FILE_UNREADABLE',
      `The settings file at ${valuesPath} could not be read as settings, so nothing was changed. Nothing has been deleted; move it aside to start a fresh one.`,
    )
  }

  if (id === 'purchases.require_owner_approval' && value === false) {
    const pending = confirmation && confirmations.get(confirmation.confirmationId)
    if (confirmation?.confirmationId) confirmations.delete(confirmation.confirmationId)
    const fingerprint = crypto.createHash('sha256').update(before.raw || '').digest('hex')
    if (!pending || pending.owner !== (options.owner ?? null) || pending.path !== valuesPath || pending.fingerprint !== fingerprint
        || Date.now() > pending.expiresAt || typeof confirmation.code !== 'string' || confirmation.code !== pending.code) {
      return failure('SETTING_CONFIRMATION_REQUIRED', 'Retype the current four-digit code in this window to turn off purchase approval. No setting was changed.')
    }
  }

  const current = before.document || {}
  const values = plainObject(current.values) ? { ...current.values } : {}
  const provenance = plainObject(current.provenance) ? { ...current.provenance } : {}
  const revision = Number.isFinite(current.revision) ? current.revision : 0

  values[id] = value
  provenance[id] = { source: 'user', atMs: Date.now(), directive: null }
  if (id === 'purchases.require_owner_approval') {
    let resolvedBefore
    try { resolvedBefore = modules.settings.loadSettings({ registry }) } catch { return failure('SETTINGS_UNREADABLE', 'The current purchase reservations could not be read.') }
    const reservations = resolvedBefore.values['outward.reserved_from_agents']
    if (!Array.isArray(reservations)) return failure('SETTINGS_UNREADABLE', 'The current purchase reservations could not be read.')
    values['outward.reserved_from_agents'] = reservations.filter(item => item !== PURCHASE_RESERVATION)
    if (value === true) values['outward.reserved_from_agents'].push(PURCHASE_RESERVATION)
    provenance['outward.reserved_from_agents'] = { ...provenance[id] }
  }
  // Canonical enum and compatibility label are one atomic, provenance-bound edit.
  for (const change of modules.modes.settingChangesWithCompatibility(id, value)) {
    if (!registry.byId.has(change.id)) continue
    values[change.id] = change.value
    provenance[change.id] = { ...provenance[id] }
  }

  const document = { ...current, values, provenance, revision: revision + 1 }

  try {
    writeDocumentAtomic(valuesPath, document)
  } catch (error) {
    return failure('SETTINGS_WRITE_FAILED', `The settings file could not be written (${error.code || error.message}), so nothing was changed.`)
  }

  /* THE PAYLOAD'S OWN VERDICT ON WHAT WAS JUST WRITTEN. */
  let resolved
  try {
    resolved = modules.settings.loadSettings({ registry })
  } catch (error) {
    return restoreFailure(
      'SETTINGS_UNREADABLE',
      `The settings file could not be re-read after the change (${error.message}).`,
      valuesPath,
      before,
    )
  }
  const refused = resolved.rejected.find(item => item && item.id === id)
  if (refused || resolved.values[id] !== value) {
    return restoreFailure(
      'SETTING_VALUE_REFUSED',
      refused ? refused.reason : `"${id}" did not read back as the value it was set to.`,
      valuesPath,
      before,
    )
  }

  return {
    ok: true,
    id,
    value: resolved.values[id],
    provenance: resolved.provenance[id],
    revision: resolved.revision,
    valuesPath: resolved.valuesPath,
    enforcement: resolved.enforcement[id],
  }
}

function beginProductSettingConfirmation({ id, value }, options = {}) {
  if (id !== 'purchases.require_owner_approval' || value !== false) return failure('SETTING_CONFIRMATION_NOT_REQUIRED', 'This setting does not require a code.')
  const modules = settingsModules(options)
  if (!modules.ok) return modules
  const valuesPath = modules.settings.resolveValuesPath({})
  let before
  try { before = readDocument(valuesPath) } catch { return failure('SETTINGS_UNREADABLE', 'The current settings could not be read.') }
  if (before.existed && !plainObject(before.document)) return failure('SETTINGS_FILE_UNREADABLE', 'The current settings are not readable.')
  for (const [key, old] of confirmations) if (old.expiresAt < Date.now() || old.owner === (options.owner ?? null)) confirmations.delete(key)
  const confirmationId = crypto.randomUUID()
  const code = String(crypto.randomInt(0, 10000)).padStart(4, '0')
  const expiresAt = Date.now() + 120000
  confirmations.set(confirmationId, { code, expiresAt, owner: options.owner ?? null, path: valuesPath,
    fingerprint: crypto.createHash('sha256').update(before.raw || '').digest('hex') })
  return { ok: true, confirmationId, code, expiresAt }
}

// A Settings Save is one local edit, often spanning dozens of rows. Validate
// the complete candidate with the real reader before one atomic replacement.
// The purchase-OFF action retains its separate one-use confirmation contract.
function setProductSettingsMany(request, options = {}) {
  const reject = (code, reason) => ({ ...failure(code, reason), results: [] })
  /* One Save can also BE a working-profile application. The caller names the
     profile so this write can leave a receipt of which rows that profile
     chose; without the receipt the page cannot tell a value the profile put
     there from one the person picked themselves afterwards, and re-picking the
     profile silently replays the preset over the person's own later choice
     (owner, 2026-09-15: "my settings keep not saving"). */
  let items = request, workingProfile = null
  if (plainObject(request) && Array.isArray(request.items)) {
    items = request.items
    workingProfile = request.workingProfile ?? null
    if (Object.keys(request).some(key => !['items', 'workingProfile'].includes(key))) {
      return reject('SETTINGS_BATCH_INVALID', 'A settings batch carries its changes and, at most, the working profile that chose them.')
    }
    if (workingProfile !== null && !(typeof workingProfile === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(workingProfile))) {
      return reject('SETTINGS_BATCH_INVALID', 'A working-profile receipt names one profile. No setting was changed.')
    }
  }
  if (!Array.isArray(items) || items.length < 1 || items.length > WRITABLE_IDS.length) {
    return reject('SETTINGS_BATCH_INVALID', `Choose between 1 and ${WRITABLE_IDS.length} distinct settings.`)
  }
  const modules = settingsModules(options)
  if (!modules.ok) return { ...modules, results: [] }
  const seen = new Set()
  const normalized = []
  for (const item of items) {
    if (!plainObject(item) || Object.keys(item).sort().join(',') !== 'id,value'
        || ![...WRITABLE_IDS, ...LEGACY_WRITABLE_IDS].includes(item.id)) {
      return reject('SETTINGS_BATCH_INVALID', 'A settings batch must contain distinct settings this window can change.')
    }
    let change
    try { change = modules.modes.normalizeSettingChange(item.id, item.value) }
    catch (error) { return reject('SETTING_VALUE_REFUSED', error.message) }
    if (seen.has(change.id)) return reject('SETTINGS_BATCH_INVALID', 'A settings batch must contain distinct settings this window can change.')
    if (item.id === 'purchases.require_owner_approval' && item.value === false) {
      return reject('SETTING_CONFIRMATION_REQUIRED', 'Turn off purchase approval separately using the current four-digit confirmation. No setting was changed.')
    }
    seen.add(change.id)
    normalized.push(change)
  }
  items = normalized
  let registry, valuesPath, before, resolvedBefore
  try {
    registry = modules.registry.loadRegistry()
    valuesPath = modules.settings.resolveValuesPath({})
    before = readDocument(valuesPath)
    if (before.existed && !plainObject(before.document)) return reject('SETTINGS_FILE_UNREADABLE', 'The current settings file is unreadable. No setting was changed.')
    resolvedBefore = modules.settings.loadSettings({ registry })
  } catch (error) {
    return reject('SETTINGS_UNREADABLE', `The current settings could not be read (${error.code || error.message}). No setting was changed.`)
  }
  for (const { id } of items) {
    if (!registry.byId.has(id)) return reject('SETTING_NOT_DECLARED', `"${id}" is not declared by this copy. No setting was changed.`)
  }
  const current = before.document || {}
  const values = plainObject(current.values) ? { ...current.values } : {}
  const provenance = plainObject(current.provenance) ? { ...current.provenance } : {}
  const atMs = Date.now()
  for (const { id, value } of items) {
    values[id] = value
    provenance[id] = { source: 'user', atMs, directive: null }
    for (const change of modules.modes.settingChangesWithCompatibility(id, value)) {
      if (!registry.byId.has(change.id)) continue
      values[change.id] = change.value
      provenance[change.id] = { ...provenance[id] }
    }
    if (id === 'purchases.require_owner_approval') {
      const reservations = resolvedBefore.values['outward.reserved_from_agents']
      if (!Array.isArray(reservations)) return reject('SETTINGS_UNREADABLE', 'The current purchase reservations could not be read. No setting was changed.')
      values['outward.reserved_from_agents'] = reservations.filter(item => item !== PURCHASE_RESERVATION)
      if (value === true) values['outward.reserved_from_agents'].push(PURCHASE_RESERVATION)
      provenance['outward.reserved_from_agents'] = { ...provenance[id] }
    }
  }
  const revision = (Number.isFinite(current.revision) ? current.revision : 0) + 1
  /* WHICH WORKING PROFILE THIS SAVE APPLIED. The page compares each row
     against that profile's own values -- it already has them -- so the
     receipt only has to name the profile and when it was applied. A row that
     no longer holds what that profile wants is a row the person changed
     since, and re-applying the profile must not put the preset back over it
     silently. The engine reads `values`, `provenance` and `revision` and
     ignores the rest, so this key travels with the file without changing
     what it enforces. */
  const receipt = workingProfile ? { workingProfile: { id: workingProfile, atMs } } : {}
  const document = { ...current, values, provenance, revision, ...receipt }
  const candidatePath = `${valuesPath}.${crypto.randomUUID()}.candidate`
  let candidate
  try {
    writeDocumentAtomic(candidatePath, document)
    candidate = modules.settings.loadSettings({ registry, valuesPath: candidatePath })
  } catch (error) {
    return reject('SETTINGS_UNREADABLE', `The proposed settings could not be validated (${error.code || error.message}). No setting was changed.`)
  } finally {
    try { fs.rmSync(candidatePath, { force: true }) } catch { /* no active settings were changed */ }
  }
  for (const { id, value } of items) {
    const refused = candidate.rejected.find(item => item && item.id === id)
    if (refused || candidate.values[id] !== value) return reject('SETTING_VALUE_REFUSED', `${refused?.reason || `"${id}" did not validate as requested.`} No setting was changed.`)
  }
  try {
    const unchanged = readDocument(valuesPath)
    if (unchanged.existed !== before.existed || unchanged.raw !== before.raw) return reject('SETTINGS_CHANGED', 'Settings changed while this batch was being validated. Inspect them and save again.')
    writeDocumentAtomic(valuesPath, document)
  } catch (error) {
    return reject('SETTINGS_WRITE_FAILED', `The settings file could not be written (${error.code || error.message}).`)
  }
  let resolved
  try {
    resolved = modules.settings.loadSettings({ registry })
    if (items.some(({ id, value }) => resolved.rejected.some(row => row?.id === id) || resolved.values[id] !== value)) throw new Error('The saved settings did not match their validated values')
  } catch (error) {
    return {
      ...restoreFailure(
        'SETTINGS_UNREADABLE',
        `The saved settings could not be verified (${[error.code, error.message].filter(Boolean).join(': ') || 'unknown error'}).`,
        valuesPath,
        before,
      ),
      results: [],
    }
  }
  return { ok: true, results: items.map(({ id }) => ({ ok: true, id, value: resolved.values[id],
    provenance: resolved.provenance[id], revision: resolved.revision, valuesPath: resolved.valuesPath, enforcement: resolved.enforcement[id] })) }
}

function applyProductLauncherSettings(options = {}) {
  const modules = settingsModules(options)
  if (!modules.ok) return modules
  try {
    const settings = modules.settings.loadSettings({ registry: modules.registry.loadRegistry() })
    const on = settings.values['tools.policy_enforcement'] === true && ['user', 'installer'].includes(settings.provenance['tools.policy_enforcement']?.source)
    const env = options.env || process.env
    env.TOOLSENABLED_P13_POLICY_ENFORCE = on ? '1' : '0'
    return { ok: true, policyEnforcement: on }
  } catch { return failure('SETTINGS_UNREADABLE', 'The launcher policy setting could not be read.') }
}

// The Engine owns the policy, directory identity and all retention mechanics.
// Loading this facade does not scan or delete; bootstrap explicitly starts it.
function createProductDiagnostics({ engineRoot, retentionModule, store,
  chooseExport = async () => ({ canceled: true }), validateExport = () => {} } = {}) {
  let service = store, unavailable = null;
  try {
    const retention = retentionModule || require(path.join(engineRoot || resolveCapabilityRoot(), 'src/lib/diagnostic-retention.js'))
    service ||= retention.createDiagnosticStore({ directory: retention.resolveDiagnosticDirectory() })
  } catch (error) { unavailable = error.code || 'DIAGNOSTICS_UNAVAILABLE' }
  const refusal = () => ({ ok: false, reason: unavailable || 'DIAGNOSTICS_UNAVAILABLE', files: [] })
  const valid = request => request && typeof request.id === 'string'
  const call = async operation => {
    if (!service) return refusal()
    try { return await operation() }
    catch (error) { return { ok: false, reason: error.code || error.message || 'DIAGNOSTICS_UNAVAILABLE' } }
  }
  return Object.freeze({
    writer: kind => service ? service.createWriter(kind) : {
      append: () => ({ written: false, reason: unavailable }), rotate() {}, close() {},
      state: () => ({ bytes: 0, totalBytes: 0, dropped: 0, failure: unavailable }),
    },
    status: () => service ? service.status() : refusal(),
    inspect: request => call(() => service.inspect({ next: request?.next === true })),
    keep: request => valid(request) && typeof request.keep === 'boolean'
      ? call(() => service.keep(request.id, request.keep)) : Promise.resolve({ ok: false, reason: 'DIAGNOSTIC_REQUEST_INVALID' }),
    export: request => valid(request) ? call(async () => {
      const answer = await chooseExport({ title: 'Export diagnostic file', defaultPath: path.basename(request.id),
        buttonLabel: 'Export', filters: [{ name: 'Diagnostic log', extensions: ['jsonl'] }] })
      if (answer?.canceled || !answer?.filePath) return { ok: false, reason: 'cancelled' }
      validateExport(answer.filePath)
      return service.exportFile(request.id, answer.filePath)
    }) : Promise.resolve({ ok: false, reason: 'DIAGNOSTIC_REQUEST_INVALID' }),
    archive: request => valid(request) ? call(() => service.archiveFile(request.id))
      : Promise.resolve({ ok: false, reason: 'DIAGNOSTIC_REQUEST_INVALID' }),
    start: () => service?.start(),
    dispose: () => service?.dispose(),
  })
}

module.exports = {
  createProductDiagnostics,
  REGISTRY_FILE,
  REGISTRY_MODULE,
  SETTINGS_MODULE,
  WRITABLE_IDS,
  LEGACY_WRITABLE_IDS,
  beginProductSettingConfirmation,
  applyProductLauncherSettings,
  loadSettingsModules,
  readProductSettings,
  readTreeSlotSettings,
  resetForTests,
  setProductSetting,
  setProductSettingsMany,
}
