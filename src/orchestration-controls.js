/* PAGE 2 ORCHESTRATION CONTROLS — the honest inventory.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: never claim a control, such as
 * temperature, that the product cannot actually set.
 *
 * A control earns a place on this page only if changing it provably changes
 * what the spawned child process does. "The engine accepted the argument" is
 * NOT that proof. `codex exec -c <key>=<value>` accepts arbitrary dotted TOML
 * keys and silently ignores the ones it does not know, so a temperature slider
 * built on `-c temperature=0.7` would look wired, would report success, and
 * would change nothing. That is the exact failure being named.
 *
 * MEASURED, not assumed (codex-cli 0.146.0, this machine, 2026-08-11):
 *   `codex exec --help` lists -m/--model, -s/--sandbox, -c, -p/--profile,
 *   --enable/--disable, -i/--image, -C/--cd, --output-schema, --json.
 *   There is NO --temperature and NO --top-p. Neither word appears on any
 *   spawn path in the capability layer.
 *
 *   `codex debug prompt-input` renders the model-visible input list without
 *   calling a model, so it is a free oracle for "did this key change what the
 *   model sees". Normalised over volatile ids/timestamps:
 *       base                              sha256 2792bb11e47f1635…
 *       base -c temperature=0.5           sha256 2792bb11e47f1635…   IDENTICAL
 *       base -c top_p=0.1                 sha256 2792bb11e47f1635…   IDENTICAL
 *       base -c mcp_servers={}            sha256 2792bb11e47f1635…   IDENTICAL
 *       base -c model=gpt-5               sha256 89e068ab95d658d4…   DIFFERENT
 *   Accepted with no error and no effect is the worst of the three outcomes,
 *   because it is the one that ships looking correct.
 *
 * WHERE THE REAL KNOBS LIVE. The child's argv is built in exactly two places,
 * capability/src/lib/mission-bridge/actions.js:435 (codex) and :452 (claude).
 * Read them before adding anything here. Every literal in those arrays is a
 * constant, not a control; only `root`, `tier.model`, `tier.effort`,
 * `tier.cliModel` and the sandbox word vary, and `cap.capMs` is applied by the
 * lane runner rather than the argv.
 */

/* ONE ROW PER MODEL, AND THE WIRE CARRIES ONE ROW ID.
 *
 * The dispatchable rows (DISPATCH_TIERS below) mirror the frozen TIERS table at
 * capability/src/lib/mission-bridge/actions.js, and
 * tools/test/orchestration-controls.test.mjs parses that engine file and fails
 * if they drift from it, so a tier renamed in the engine cannot keep quietly
 * working here. shell/agent-host.cjs START_TIERS carries every row, treeOnly
 * ones included, and tools/test/codex-astra-tier.test.mjs holds that parity.
 *
 * PROVIDER IS A FILTER, NOT A SECOND FIELD (1.0.48, owner decision:
 * provider first, then model). What stood here said separate provider and
 * model menus would invent a freedom the dispatch API does not have. That is
 * still true of the WIRE: a start, a dispatch and a saved node carry exactly
 * one row id, and the engine resolves provider, model, seats and effort from
 * it. What changed is the menu: a person first narrows the rows by
 * `row.provider`, then picks one row. The Provider choice is derived from the
 * row and never stored or sent on its own, so it cannot disagree with it.
 *
 * NEVER RENAME OR REMOVE A ROW ID. Signed usage rows, ledgers, continuations,
 * retry policies and older installs hold them. Labels may change; ids may not.
 *
 * EFFORT IS SCOPED BY ROW. `effort` is the row's default: a string for a row
 * that always runs at a stated depth (every Codex row, the Antigravity rows),
 * null for a row that leaves the depth to the model. `efforts`, where present,
 * is the set that MODEL offers when it is narrower than its provider's set
 * (PROVIDER_EFFORTS below); tierEffortIds() answers the set for any row. */
/* Seats are capacity, not a provider convention. Codex tiers happen to have
   separate single-seat pools, while the three Claude capabilities draw from
   one worker pool. Nothing may infer either topology from `provider`: a future
   provider can have one shared pool, several pools, or both. Keeping the pool
   objects here lets every renderer consumer derive from the same tier contract
   instead of maintaining another tier-to-seat table. */
const SINGLE_SEAT_POOLS = Object.freeze({
  astra: Object.freeze(['astra']),
  luna: Object.freeze(['luna']),
  terra: Object.freeze(['terra']),
  sol: Object.freeze(['sol']),
})
const CLAUDE_WORKER_SEATS = Object.freeze(['claude-1', 'claude-2', 'claude-3', 'claude-4'])
const LOCAL_NODE_SEATS = Object.freeze(['local-node-1', 'local-node-2', 'local-node-3', 'local-node-4'])

/* EACH PROVIDER'S DEPTH WORDS, when a row states none of its own. Codex's six
   are the codex-cli catalog's (fleet-tree-copy.js EFFORT_CHOICES); Claude's
   five are what the launcher passes as --effort (the engine maps ultra to max,
   so it is not offered twice). Gemini's CLI session advertises no depth, Grok
   rows state theirs, a local model has none, and an Antigravity row carries
   its depth in the model id -- see tierEffortIds(). */
const NO_EFFORTS = Object.freeze([])
const CODEX_EFFORTS_WITHOUT_ULTRA = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max'])
const CLAUDE_EFFORTS_WITHOUT_XHIGH = Object.freeze(['low', 'medium', 'high', 'max'])
export const PROVIDER_EFFORTS = Object.freeze({
  codex: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
  claude: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']),
  gemini: NO_EFFORTS,
  grok: NO_EFFORTS,
  local: NO_EFFORTS,
})

export const LAUNCH_TIERS = Object.freeze([
  /* Codex's gpt-6 line, added 2026-09-07 for the 1.0.42 cut, and first in this
     list because it is what a new circle now defaults to (see DEFAULT_TIER in
     src/fleet-tree-copy.js). The label is the catalog's own display name rather
     than the one-word style of the rows below: the person asked for "astra6"
     and the vendor calls it GPT-6-Astra, so the full name is what identifies
     it. The K3 reversal makes the default effort `medium`, which is what Codex
     does for its own model. */
  Object.freeze({ id: 'astra', provider: 'codex', label: 'GPT-6-Astra', model: 'gpt-6-astra', effort: 'medium', seats: SINGLE_SEAT_POOLS.astra }),
  /* The rest of Codex's gpt-6 line, added 2026-09-25 for 1.0.48. Ids, display
     names and efforts are read from ~/.codex/models_cache.json (codex-cli
     0.156.0, fetched 2026-09-25): both default to medium, GPT-6-Luna has no
     ultra. TREE-ONLY on purpose: a dispatch row needs a seat of its own, and a
     saved org overlay never gains a seat a later default adds, so every
     existing installation would refuse it (engine actions.js, beside TIERS).
     Their seats are nominal, like the Gemini and Grok rows' -- a tree start
     does not draw on the dispatch pools. */
  /* `failoverTarget: false` (review P6): the automatic account-limit walk
     (account-recovery-coordinator.js switchToAnotherModel) keeps exactly the
     candidates it had before 1.0.48. A model added since is a choice a person
     makes, not a stand-in the walk moves an agent onto -- the same reason it
     skips `pinned` rows. */
  Object.freeze({ id: 'gpt-6-sol', provider: 'codex', label: 'GPT-6-Sol', model: 'gpt-6-sol', effort: 'medium', treeOnly: true, failoverTarget: false, seats: Object.freeze(['gpt-6-sol']) }),
  Object.freeze({ id: 'gpt-6-luna', provider: 'codex', label: 'GPT-6-Luna', model: 'gpt-6-luna', effort: 'medium', efforts: CODEX_EFFORTS_WITHOUT_ULTRA, treeOnly: true, failoverTarget: false, seats: Object.freeze(['gpt-6-luna']) }),
  /* The gpt-5.6 rows carry the version in their label since 1.0.48: the
     vendor's GPT-6-Luna and GPT-6-Sol would otherwise share their words. */
  Object.freeze({ id: 'luna', provider: 'codex', label: 'GPT-5.6-Luna', model: 'gpt-5.6-luna', effort: 'medium', efforts: CODEX_EFFORTS_WITHOUT_ULTRA, seats: SINGLE_SEAT_POOLS.luna }),
  Object.freeze({ id: 'terra', provider: 'codex', label: 'GPT-5.6-Terra', model: 'gpt-5.6-terra', effort: 'high', seats: SINGLE_SEAT_POOLS.terra }),
  Object.freeze({ id: 'sol', provider: 'codex', label: 'GPT-5.6-Sol', model: 'gpt-5.6-sol', effort: 'xhigh', seats: SINGLE_SEAT_POOLS.sol }),
  /* CLAUDE'S THREE ALIASES STAY FIRST AMONG CLAUDE ROWS, WITH THEIR IDS. Each
     runs whatever the installed Claude Code serves for that word (`opus` is
     Opus 5.5 from CLI 2.1.280 and Opus 5 before it), so the label says
     "(latest)" and never a version: old usage under `claude-opus` was one
     model or the other depending on the CLI. The first Claude row keeps
     `effort: null` (bounded-child-thinking-depth and create-and-start-node
     pin it). */
  Object.freeze({ id: 'claude-fable', provider: 'claude', label: 'Fable (latest)', model: 'claude/fable', cliModel: 'fable', effort: null, seats: CLAUDE_WORKER_SEATS }),
  Object.freeze({ id: 'claude-sonnet', provider: 'claude', label: 'Sonnet (latest)', model: 'claude/sonnet', cliModel: 'sonnet', effort: null, seats: CLAUDE_WORKER_SEATS }),
  Object.freeze({ id: 'claude-opus', provider: 'claude', label: 'Opus (latest)', model: 'claude/opus', cliModel: 'opus', effort: null, seats: CLAUDE_WORKER_SEATS }),
  /* ONE ROW PER CLAUDE MODEL, added 2026-09-25 for 1.0.48. Product decision:
     every model a provider offers is selectable, Opus 5 and Sonnet 5
     included. Mirrors engine TIERS row for row (ids and effort sets checked
     there against the model catalog served on 2026-09-25 and CLI 2.1.283).
     `pinned: true` means the row names one exact model: recovery and failover
     never move such an agent to another model on their own (D6) -- the same
     model on another account is fine, a different model needs the person.
     `effort: null` on every one: an untouched start sends no --effort and the
     model's own default applies. */
  Object.freeze({ id: 'claude-opus-5-5', provider: 'claude', label: 'Opus 5.5', model: 'claude/claude-opus-5-5', cliModel: 'claude-opus-5-5', effort: null, pinned: true, seats: CLAUDE_WORKER_SEATS }),
  Object.freeze({ id: 'claude-opus-5', provider: 'claude', label: 'Opus 5', model: 'claude/claude-opus-5', cliModel: 'claude-opus-5', effort: null, pinned: true, seats: CLAUDE_WORKER_SEATS }),
  Object.freeze({ id: 'claude-sonnet-5', provider: 'claude', label: 'Sonnet 5', model: 'claude/claude-sonnet-5', cliModel: 'claude-sonnet-5', effort: null, pinned: true, seats: CLAUDE_WORKER_SEATS }),
  Object.freeze({ id: 'claude-fable-5-1', provider: 'claude', label: 'Fable 5.1', model: 'claude/claude-fable-5-1', cliModel: 'claude-fable-5-1', effort: null, pinned: true, seats: CLAUDE_WORKER_SEATS }),
  Object.freeze({ id: 'claude-fable-5', provider: 'claude', label: 'Fable 5', model: 'claude/claude-fable-5', cliModel: 'claude-fable-5', effort: null, pinned: true, seats: CLAUDE_WORKER_SEATS }),
  // Haiku 4.5 has no effort setting at all; the CLI refuses --effort for it.
  Object.freeze({ id: 'claude-haiku-4-5', provider: 'claude', label: 'Haiku 4.5', model: 'claude/claude-haiku-4-5', cliModel: 'claude-haiku-4-5', effort: null, efforts: NO_EFFORTS, pinned: true, seats: CLAUDE_WORKER_SEATS }),
  Object.freeze({ id: 'claude-opus-4-8', provider: 'claude', label: 'Opus 4.8', model: 'claude/claude-opus-4-8', cliModel: 'claude-opus-4-8', effort: null, pinned: true, seats: CLAUDE_WORKER_SEATS }),
  Object.freeze({ id: 'claude-opus-4-7', provider: 'claude', label: 'Opus 4.7', model: 'claude/claude-opus-4-7', cliModel: 'claude-opus-4-7', effort: null, pinned: true, seats: CLAUDE_WORKER_SEATS }),
  // Opus 4.6 and Sonnet 4.6 offer no xhigh.
  Object.freeze({ id: 'claude-opus-4-6', provider: 'claude', label: 'Opus 4.6', model: 'claude/claude-opus-4-6', cliModel: 'claude-opus-4-6', effort: null, efforts: CLAUDE_EFFORTS_WITHOUT_XHIGH, pinned: true, seats: CLAUDE_WORKER_SEATS }),
  Object.freeze({ id: 'claude-sonnet-4-6', provider: 'claude', label: 'Sonnet 4.6', model: 'claude/claude-sonnet-4-6', cliModel: 'claude-sonnet-4-6', effort: null, efforts: CLAUDE_EFFORTS_WITHOUT_XHIGH, pinned: true, seats: CLAUDE_WORKER_SEATS }),
  // Native Antigravity catalog verified with the selected account on 2026-09-10.
  Object.freeze({ id: 'agy-gemini-3-8-flash-high', provider: 'gemini', client: 'antigravity', label: 'Gemini 3.8 Flash (High)', model: 'gemini/antigravity/gemini-3.8-flash-high', cliModel: 'gemini-3.8-flash-high', effort: 'high', treeOnly: true, seats: Object.freeze(['gemini-1']) }),
  Object.freeze({ id: 'agy-gemini-3-8-flash-medium', provider: 'gemini', client: 'antigravity', label: 'Gemini 3.8 Flash (Medium)', model: 'gemini/antigravity/gemini-3.8-flash-medium', cliModel: 'gemini-3.8-flash-medium', effort: 'medium', treeOnly: true, seats: Object.freeze(['gemini-1']) }),
  Object.freeze({ id: 'agy-gemini-3-8-flash-low', provider: 'gemini', client: 'antigravity', label: 'Gemini 3.8 Flash (Low)', model: 'gemini/antigravity/gemini-3.8-flash-low', cliModel: 'gemini-3.8-flash-low', effort: 'low', treeOnly: true, seats: Object.freeze(['gemini-1']) }),
  Object.freeze({ id: 'agy-gemini-3-7-flash-high', provider: 'gemini', client: 'antigravity', label: 'Gemini 3.7 Flash (High)', model: 'gemini/antigravity/gemini-3.7-flash-high', cliModel: 'gemini-3.7-flash-high', effort: 'high', treeOnly: true, seats: Object.freeze(['gemini-1']) }),
  Object.freeze({ id: 'agy-gemini-3-7-flash-medium', provider: 'gemini', client: 'antigravity', label: 'Gemini 3.7 Flash (Medium)', model: 'gemini/antigravity/gemini-3.7-flash-medium', cliModel: 'gemini-3.7-flash-medium', effort: 'medium', treeOnly: true, seats: Object.freeze(['gemini-1']) }),
  Object.freeze({ id: 'agy-gemini-3-7-flash-low', provider: 'gemini', client: 'antigravity', label: 'Gemini 3.7 Flash (Low)', model: 'gemini/antigravity/gemini-3.7-flash-low', cliModel: 'gemini-3.7-flash-low', effort: 'low', treeOnly: true, seats: Object.freeze(['gemini-1']) }),
  Object.freeze({ id: 'agy-gemini-3-6-flash-high', provider: 'gemini', client: 'antigravity', label: 'Gemini 3.6 Flash (High)', model: 'gemini/antigravity/gemini-3.6-flash-high', cliModel: 'gemini-3.6-flash-high', effort: 'high', treeOnly: true, seats: Object.freeze(['gemini-1']) }),
  Object.freeze({ id: 'agy-gemini-3-6-flash-medium', provider: 'gemini', client: 'antigravity', label: 'Gemini 3.6 Flash (Medium)', model: 'gemini/antigravity/gemini-3.6-flash-medium', cliModel: 'gemini-3.6-flash-medium', effort: 'medium', treeOnly: true, seats: Object.freeze(['gemini-1']) }),
  Object.freeze({ id: 'agy-gemini-3-6-flash-low', provider: 'gemini', client: 'antigravity', label: 'Gemini 3.6 Flash (Low)', model: 'gemini/antigravity/gemini-3.6-flash-low', cliModel: 'gemini-3.6-flash-low', effort: 'low', treeOnly: true, seats: Object.freeze(['gemini-1']) }),
  Object.freeze({ id: 'agy-gemini-3-1-pro-high', provider: 'gemini', client: 'antigravity', label: 'Gemini 3.1 Pro (High)', model: 'gemini/antigravity/gemini-3.1-pro-high', cliModel: 'gemini-3.1-pro-high', effort: 'high', treeOnly: true, seats: Object.freeze(['gemini-1']) }),
  Object.freeze({ id: 'agy-gemini-3-1-pro-low', provider: 'gemini', client: 'antigravity', label: 'Gemini 3.1 Pro (Low)', model: 'gemini/antigravity/gemini-3.1-pro-low', cliModel: 'gemini-3.1-pro-low', effort: 'low', treeOnly: true, seats: Object.freeze(['gemini-1']) }),
  Object.freeze({ id: 'gemini', provider: 'gemini', label: 'Automatic', model: 'gemini/auto', cliModel: null, effort: null, treeOnly: true, seats: Object.freeze(['gemini-1']) }),
  // Official CLI model menus, checked 2026-09-10. Availability is confirmed
  // by the selected provider at launch; these rows never silently use Auto.
  // https://geminicli.com/docs/get-started/gemini-3/
  // https://geminicli.com/docs/cli/model/
  Object.freeze({ id: 'gemini-3-1-pro', provider: 'gemini', label: 'Gemini 3.1 Pro Preview', model: 'gemini/gemini-3.1-pro-preview', cliModel: 'gemini-3.1-pro-preview', effort: null, treeOnly: true, seats: Object.freeze(['gemini-1']) }),
  Object.freeze({ id: 'gemini-3-flash', provider: 'gemini', label: 'Gemini 3 Flash Preview', model: 'gemini/gemini-3-flash-preview', cliModel: 'gemini-3-flash-preview', effort: null, treeOnly: true, seats: Object.freeze(['gemini-1']) }),
  /* Added 2026-09-25 for 1.0.48. The installed Gemini CLI 0.58.0 lists
     `gemini-3.1-flash-lite` in VALID_GEMINI_MODELS as its
     DEFAULT_GEMINI_FLASH_LITE_MODEL (not a preview id). */
  Object.freeze({ id: 'gemini-3-1-flash-lite', provider: 'gemini', label: 'Gemini 3.1 Flash Lite', model: 'gemini/gemini-3.1-flash-lite', cliModel: 'gemini-3.1-flash-lite', effort: null, treeOnly: true, failoverTarget: false, seats: Object.freeze(['gemini-1']) }),
  Object.freeze({ id: 'gemini-2-5-pro', provider: 'gemini', label: 'Gemini 2.5 Pro', model: 'gemini/gemini-2.5-pro', cliModel: 'gemini-2.5-pro', effort: null, treeOnly: true, seats: Object.freeze(['gemini-1']) }),
  Object.freeze({ id: 'gemini-2-5-flash', provider: 'gemini', label: 'Gemini 2.5 Flash', model: 'gemini/gemini-2.5-flash', cliModel: 'gemini-2.5-flash', effort: null, treeOnly: true, seats: Object.freeze(['gemini-1']) }),
  Object.freeze({ id: 'grok', provider: 'grok', label: 'Automatic', model: 'grok/auto', cliModel: null, effort: null, treeOnly: true, seats: Object.freeze(['grok-1']) }),
  // Grok Build's native ACP catalog advertises these exact models.
  // https://docs.x.ai/build/overview
  // Efforts as Grok CLI 1.0.40 advertises them: 4.6 low..xhigh, 4.5 low..high.
  Object.freeze({ id: 'grok-4-6', provider: 'grok', label: 'Grok 4.6', model: 'grok/grok-4.6', cliModel: 'grok-4.6', effort: 'xhigh', efforts: Object.freeze(['low', 'medium', 'high', 'xhigh']), treeOnly: true, seats: Object.freeze(['grok-1']) }),
  Object.freeze({ id: 'grok-4-5', provider: 'grok', label: 'Grok 4.5', model: 'grok/grok-4.5', cliModel: 'grok-4.5', effort: null, efforts: Object.freeze(['low', 'medium', 'high']), treeOnly: true, seats: Object.freeze(['grok-1']) }),
  /* A model on the user's own GPU, in the same table as the paid ones — the
     engine's TIERS.local row (the free local path is a full part of the
     product, not a fallback). `cliModel: null` is load-bearing: a local
     node has no vendor CLI; the engine resolves the concrete model at
     dispatch from what the user has pulled, and refuses honestly if nothing
     is installed. */
  Object.freeze({ id: 'local', provider: 'local', label: 'Local', model: 'local/auto', cliModel: null, effort: null, seats: LOCAL_NODE_SEATS }),
])

const TIER_BY_ID = new Map(LAUNCH_TIERS.map(tier => [tier.id, tier]))
export const DISPATCH_TIERS = Object.freeze(LAUNCH_TIERS.filter(tier => !tier.treeOnly))

export function launchTier(id) {
  return TIER_BY_ID.get(id) || null
}

/* A row, from its id or as given. Callers with an injected table (tests, the
   recovery coordinator) hand the row itself; everyone else hands the id. */
function rowOf(tierOrId) {
  if (tierOrId && typeof tierOrId === 'object') return tierOrId
  return typeof tierOrId === 'string' ? launchTier(tierOrId) : null
}

/**
 * The depths a row can run at, as effort ids, in the provider's order. Empty
 * for a row whose model takes no depth at all. Never includes '' -- the
 * "Model default" choice is the copy module's (effortChoicesFor), and it exists
 * exactly when tierDefaultEffort() is ''.
 */
export function tierEffortIds(tierOrId) {
  const row = rowOf(tierOrId)
  if (!row) return NO_EFFORTS
  if (row.client === 'antigravity') return row.effort ? Object.freeze([row.effort]) : NO_EFFORTS
  if (Array.isArray(row.efforts)) return row.efforts
  return PROVIDER_EFFORTS[row.provider] || NO_EFFORTS
}

/** The depth an untouched start sends: the row's own, or '' for "Model default". */
export function tierDefaultEffort(tierOrId) {
  const row = rowOf(tierOrId)
  return row && typeof row.effort === 'string' && row.effort ? row.effort : ''
}

/**
 * A depth carried over to a row: kept when that row offers it, otherwise the
 * row's own default. '' means send no effort. Used wherever a saved or chosen
 * depth meets a (possibly different) model -- a start, a next-model change, an
 * editor copy -- so a Codex `ultra` never reaches a model that has no ultra.
 */
export function scopedEffort(tierOrId, effort) {
  return offeredEffort(tierOrId, effort) || tierDefaultEffort(tierOrId)
}

/** The depth as that row would run it, or '' when the row does not offer it. */
export function offeredEffort(tierOrId, effort) {
  const wanted = typeof effort === 'string' ? effort.trim() : ''
  if (!wanted) return ''
  const offered = tierEffortIds(tierOrId)
  if (offered.includes(wanted)) return wanted
  /* The one depth word that maps rather than drops: Claude's launcher runs
     `ultra` as `max` (engine tool-registry.js AGENT_SPAWN_EFFORT_BY_PROVIDER),
     so a Codex ultra carried to a Claude model keeps "hardest". */
  if (wanted === 'ultra' && rowOf(tierOrId)?.provider === 'claude' && offered.includes('max')) return 'max'
  return ''
}

/** True for a row that names one exact model (see `pinned` in LAUNCH_TIERS). */
export function tierIsPinned(tierOrId) {
  return rowOf(tierOrId)?.pinned === true
}

/**
 * The argv fragment a tier actually produces, quoted so the panel can show the
 * person the real flags rather than a promise about them.
 *
 * Codex effort rides on `-c model_reasoning_effort=<effort>`, which is a `-c`
 * key like any other — but unlike `temperature` it is a key Codex recognises,
 * and it is the key the engine has always shipped. It is listed as real
 * BECAUSE the engine uses it, and the accompanying evidence names where.
 */
export function tierArgvFragment(id) {
  const tier = launchTier(id)
  if (!tier) return null
  if (tier.provider === 'claude' || tier.client === 'antigravity') return Object.freeze(['--model', tier.cliModel])
  return Object.freeze(['--model', tier.model, '-c', `model_reasoning_effort=${tier.effort}`])
}

/* Sandbox level. Real, and the best-evidenced knob in the whole system: the
   capability layer records measured OS-level refusals per level, not merely
   that the flag was accepted. It is shown here and NOT offered as a per-node
   dropdown, because dispatch derives it from the machine's recorded install
   permission tier (actions.js:507) — an explicit level is only honoured from
   the two remote bridges. A dropdown would be a control the dispatch call has
   no field for. */
export const SANDBOX_LEVELS = Object.freeze({
  guided: Object.freeze({ codex: 'read-only', claude: 'plan', summary: 'Reads only. Writes are refused by the operating system.' }),
  standard: Object.freeze({ codex: 'workspace-write', claude: 'acceptEdits', summary: 'Writes only inside its work folder. Writes anywhere else are refused by the operating system.' }),
  unrestricted: Object.freeze({ codex: 'danger-full-access', claude: 'bypassPermissions', summary: 'No sandbox. The agent can write anywhere this account can.' }),
})

export function sandboxLevel(id) {
  return SANDBOX_LEVELS[id] || null
}

/* The run cap. Real: capMs is handed to the lane runner, which kills the lane's
   whole process tree when it elapses. The dispatch form has always sent a
   hardcoded 20 minutes; exposing it is turning a real constant into a real
   control, not adding a new one.

   THIS SENTENCE WAS FALSE UNTIL 2026-08-11 AND IS RECORDED HERE SO IT CANNOT
   GO FALSE QUIETLY AGAIN. The cap ran `child.kill()` -- SIGTERM to the DIRECT
   child only -- so everything the lane's CLI started underneath it was
   orphaned and kept running while the launch record said the lane had stopped.
   The claim shipped on this page long before the behaviour did. It is now
   `taskkill /PID <pid> /T /F`, the same mechanism the explicit terminate action
   uses, at capability/src/lib/mission-bridge/agent-lane-dispatch.js.

   The evidence address below is that kill site, NOT actions.js:662 where capMs
   is merely handed over. A citation that points at the wrong file is worse than
   none: the next reader checks it, sees a plausible line, and stops. */
export const CAP_BOUNDS = Object.freeze({ minMs: 60_000, maxMs: 4 * 60 * 60_000, defaultMs: 20 * 60_000 })

export function clampCapMs(value) {
  /* ABSENT IS NOT ZERO. `Number(null)` and `Number('')` are both 0, which is
     finite, so clamping straight to the bounds turned "no value stored" into
     "the shortest run this product allows" — a one-minute cap nobody chose.
     A missing value means the person has not decided, and the honest answer to
     that is the default, not the floor. Caught by the named cap test. */
  if (value === null || value === undefined || value === '') return CAP_BOUNDS.defaultMs
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return CAP_BOUNDS.defaultMs
  return Math.min(CAP_BOUNDS.maxMs, Math.max(CAP_BOUNDS.minMs, Math.round(parsed)))
}

/* WHAT THIS PAGE REFUSES TO PRETEND IT CAN DO.
 *
 * Every entry here was a plausible control someone could have built. Each is
 * named on the panel with its reason, because a person who cannot find a
 * temperature slider deserves to be told it does not exist rather than left to
 * assume they are looking in the wrong place — and because an absent control
 * that is never mentioned is indistinguishable from an oversight.
 *
 * `evidence` is a file:line in this repository. Keep it that way: a reason
 * with no address is an opinion. */
export const UNSUPPORTED_CONTROLS = Object.freeze([
  Object.freeze({
    id: 'temperature',
    label: 'Temperature',
    reason: 'Neither engine takes it. `codex exec` has no temperature flag, and `-c temperature=…` is accepted and ignored — measured byte-identical model input with and without it.',
    evidence: 'capability/src/lib/mission-bridge/actions.js:435',
  }),
  Object.freeze({
    id: 'top-p',
    label: 'Top-p',
    reason: 'Same as temperature: no flag, and the config override is inert. The word does not occur on any spawn path.',
    evidence: 'capability/src/lib/mission-bridge/actions.js:435',
  }),
  Object.freeze({
    id: 'max-tokens',
    label: 'Max tokens',
    reason: 'No spawn path passes a token limit. The run is bounded by the time cap above instead, which is real: when it elapses the lane’s whole process tree is killed.',
    evidence: 'capability/src/lib/mission-bridge/agent-lane-dispatch.js:282',
  }),
  Object.freeze({
    id: 'tool-allowlist',
    label: 'Tool allowlist',
    reason: 'Fixed at Read, Edit, Write, Glob, Grep for a Claude lane, and absent entirely for a Codex lane. Both are string literals in the argv builder, not parameters.',
    evidence: 'capability/src/lib/mission-bridge/actions.js:463',
  }),
  /* REMOVED, BECAUSE IT STOPPED BEING TRUE.
     This list carried an entry saying invented role names were impossible --
     "a role must be one of the nine the engine declares... a box that accepted
     a new name would produce a file the engine rejects." That was correct when
     written and false the moment the org store gained knownRoles(), which feeds
     custom roles into normalizeOrg. Custom roles are now created, stored and
     assigned from this very rail.

     The entry is deleted rather than reworded. This list's whole job is naming
     things the product genuinely cannot do, and the value of that honesty is
     that every entry is load-bearing. A capability that starts working leaves
     the list; it does not get a softer sentence. An impossibility claim printed
     directly above a working control that performs it is worse than no claim at
     all, because it teaches a reader that the other entries are decoration too. */
])

/* THE NINE ROLES THE ENGINE ACTUALLY ACCEPTS.
   Mirrors the frozen list at capability/src/lib/agent-org.js:28. A role is not
   decoration: it is exported to the child as TOOLSENABLED_AGENT_ROLE and
   rendered into the onboarding packet on the child's stdin. It does not change
   the model, the argv, or the sandbox — two agents with different roles get
   byte-identical argv — so the panel says what a role does and does not do. */
export const ENGINE_ROLES = Object.freeze([
  'controller', 'shadow-manager', 'planner', 'manager',
  'coordinator-assistant', 'builder', 'reviewer', 'worker', 'observer',
])

/* The four relationship types the declared organization understands.
   Mirrors capability/src/lib/agent-org.js:35. */
export const RELATION_TYPES = Object.freeze(['manages', 'reviews', 'delegates_to', 'escalates_to'])

/**
 * The chatbox's channel, resolved honestly.
 *
 * THIS IS THE PART MOST LIKELY TO BECOME A LIE, so it is a pure function with
 * a test rather than a branch buried in a render call.
 *
 * There are three genuinely different situations and they must not be drawn
 * the same way:
 *
 *   'session'   The app started this agent itself through mcAgent.start(), so
 *               there is a live adapter session and sendTurn() reaches it.
 *               Typing here really does reach the running agent.
 *
 *   'simulated' The simulated fleet. The replies are written by this product
 *               and no process exists. Honest only while it says so.
 *
 *   'none'      A declared or observed agent with no app-owned session. There
 *               is NO live channel to such an agent: a dispatched lane gets its
 *               entire prompt on stdin at spawn and the pipe is then closed
 *               (capability/src/lib/agent-lane.js — child.stdin.end(prompt)),
 *               and the mailbox that supervisors write is drained only when a
 *               lane next starts. A composer here would be a text box that
 *               throws away what the person types.
 *
 * @returns {{kind: 'session'|'simulated'|'none', canSend: boolean, reason: string|null}}
 */
export const CHAT_CHANNEL_KINDS = Object.freeze(['session', 'simulated', 'none'])

/**
 * DOES A CONVERSATION EXIST AT ALL — one definition, used everywhere.
 *
 * This is deliberately NOT `channel.canSend`, even though the two agree for
 * every kind that exists today. They answer different questions: whether there
 * is a conversation to show, and whether a person may add to it. Two callers
 * were asking the first question in two different ways — one testing
 * `kind !== 'none'` and one testing `canSend` — and they coincided only because
 * no kind has yet existed that has a conversation and cannot be written to.
 *
 * The drift that would actually happen: a session that exists but is mid-turn
 * or interrupted (mcAgent.interrupt() already exists), or a decision to make
 * the simulated fleet read-only. Either adds a kind with a conversation and
 * `canSend: false`, at which point the caller that meant "a conversation
 * exists" starts reporting "there is no channel to this agent" — reviving,
 * silently, exactly the defect an earlier commit fixed.
 *
 * Adding a kind therefore forces a decision about which side of this it sits
 * on, and tools/test/node-chatbox.test.mjs pins the enum so the decision
 * cannot be skipped.
 */
export function channelHasConversation(channel) {
  return Boolean(channel) && channel.kind !== 'none'
}

export function resolveChatChannel({ live = false, sessionAvailable = false, sessionAgentId = null, agentId = null } = {}) {
  if (sessionAvailable && sessionAgentId && agentId && sessionAgentId === agentId) {
    return Object.freeze({ kind: 'session', canSend: true, reason: null })
  }
  if (!live) {
    return Object.freeze({ kind: 'simulated', canSend: true, reason: 'simulated fleet' })
  }
  return Object.freeze({
    kind: 'none',
    canSend: false,
    reason: sessionAvailable && sessionAgentId
      ? `the live session on the computer you are driving belongs to ${sessionAgentId}, not this agent`
      : 'no session started from this app owns this agent',
  })
}

/** Minutes, for a cap the person reads rather than a millisecond count. */
export function capMinutes(capMs) {
  return Math.round(clampCapMs(capMs) / 60_000)
}
