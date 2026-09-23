/* THE SETUP PROFILE: few questions, many settings, nothing set where it cannot
 * be found again.
 *
 * The owner asked for a walkthrough that works like twenty questions -- "even a
 * basic user in relatively few steps we should have a very good sense of exactly
 * what they want ... and we end up on exactly the right user settings profile or
 * near it at least". Twenty questions works because each question eliminates a
 * large part of the space. The failure mode it rules out is a wall of forms that
 * enumerates every setting, so this module does the opposite: it defines a small
 * number of answers, and the DERIVATION from those answers to every individual
 * setting they imply.
 *
 * WHAT IS ACTUALLY A SETTING HERE, MEASURED RATHER THAN ASSUMED.
 * src/views/settings.js renders about ninety rows. Every one of them writes
 * `mc.set.<id>` to localStorage and NOTHING IN THIS APPLICATION READS THAT KEY --
 * grep the tree: outside settings.js itself there is not one reader. Those rows
 * are a presentation surface, not behaviour. A walkthrough that inferred ten of
 * them from a question about the user's purpose would look impressive, would test
 * green, and would change nothing whatsoever about the product. That is theatre,
 * so it is not built.
 *
 * The settings that DO something, and therefore the ones this profile decides:
 *
 *   1. The permission level (machine.json `tier`). Recorded by the screen that
 *      already ships; this module treats it as a CEILING and never as an output.
 *   2. The workspace roots (machine.json `workspaceRoots`) -- the folders an
 *      assistant may work in. A fresh record silently defaults these today.
 *   3. The six write-action flags (`mc.write.*`, src/write-flags.js). Each one
 *      gates a real control: the dispatch form, the ledger's decision buttons,
 *      the queue claim/close pair, the coordinator composer, the report reader,
 *      and starting a live agent session.
 *   4. The example toggle (`mc.example`, src/data-source.js). One switch that
 *      decides whether every screen reads this computer's own records or the
 *      labelled built-in example. It replaced seven per-view flags; the
 *      screens question maps to it directly.
 *
 * And four settings that other lanes are building the ENFORCEMENT for right now,
 * which this profile sets coherently so that their work lands on a value the user
 * actually chose rather than on a hardcoded constant: the approvals policy, what
 * attaching to an existing editor session means, whether editor sessions are
 * imported, and whether a second account is used automatically when the first is
 * exhausted. Those four are marked `enforced: false` in PROFILE_INTENT and the
 * surfaces that show them say so, in the same idiom src/setup-state.js uses for
 * the tier's own enforcement gap. Their DEFAULTS are the safe end of each axis,
 * so an intent nothing reads yet cannot do harm while it waits.
 *
 * THE TIER IS A CEILING AND IS NEVER RAISED BY AN ANSWER. `deriveProfile` clamps
 * every output to what the recorded level permits and RECORDS THE CLAMP, so the
 * review screen can say "your permission level does not allow this" instead of
 * silently dropping the answer. An unknown or missing answer collapses to the
 * safest option rather than to the most useful one.
 *
 * NO DOM, NO STYLESHEET, NO STORAGE ACCESS THAT IS NOT GUARDED. The whole
 * derivation is a pure function of (answers, tier) so it can be exercised in
 * `node --test` without a browser -- which is the point, because this decides
 * what a stranger's computer is configured to allow.
 */

export const PROFILE_SCHEMA_VERSION = 1
export const PROFILE_STORAGE_KEY = 'mc.setup.profile'
export const PROFILE_READ_UNAVAILABLE = 'PROFILE_READ_UNAVAILABLE'

/* ---------- the questions ---------- */

/* Question 2 of 3. One question, ten settings.
 *
 * The three options are an axis of how much of the product's action surface is
 * switched on, NOT three amounts of visible menu. They are listed least-acting
 * first, so the order itself reads as an axis.
 *
 * THE RECOMMENDATION HAS MOVED TWICE, AND THIS IS THE ACCOUNT OF WHY.
 *
 * `observe` was Recommended and preselected first, on the same reasoning the
 * tier question uses for `guided`: the least confident reader must be able to
 * proceed by not deciding, and what they proceed into must be the safe end.
 * MEASURED on the packaged window from a sterile profile, taking the two
 * Recommended answers landed on an installation with NO CONTROL ANYWHERE THAT
 * STARTS AN AGENT: `observe` requests no write flags, `agent-session` is one,
 * and src/agent-session.js is what mounts Start. The product's own guidance
 * led the readers least equipped to diagnose it into a dead end. The
 * recommendation moved to `assisted`, which acts only when a person presses a
 * control, while skip still applied `observe`.
 *
 * THEN THE OWNER DIRECTED (2026-09-20, T782) that Basic is the real default:
 * a fresh copy is permissive and autonomous within its permission level and
 * account limits, and the things that hold it back -- detailed auditing,
 * history verification, resource limits, and a profile that acts only when
 * pressed -- are explicit choices. So SAFE_ANSWERS and RECOMMENDED_ANSWERS
 * (defined below, with the derivation, by the runtime owner) both resolve to
 * `autonomous`: the walkthrough preselects it, SKIPPING the walkthrough
 * applies it, and a copy that never ran setup behaves the same way
 * (src/write-flags.js reads an absent action preference as Basic). The
 * permission level, the workspace, the accounts and every operation's own
 * authorization still apply: these answers request app actions, they do not
 * grant machine access.
 *
 * WHAT DID NOT MOVE. An explicit choice is kept exactly: a saved `observe` or
 * `assisted` profile, and any single switch a person turned off by hand, stay
 * as they were saved. `observe` remains a legitimate answer -- someone who
 * wants to read before running anything is entitled to it -- so it keeps its
 * place and its `consequence`: the sentence that says, at the point of
 * choice, that nothing will be startable until it is switched on, and where
 * to switch it. See src/agent-session.js for the other half of that repair,
 * which gives the answer a destination instead of an absence. */
export const AUTONOMY_CHOICES = Object.freeze([
  Object.freeze({
    value: 'observe',
    label: 'Nothing yet — let me look around first',
    note: '',
    detail: 'Every screen still reads and reports, and nothing at all is switched on that acts: no assistant starts, nothing is approved, nothing is replied to. Choose this to look around before anything runs; a fresh copy does not start here.',
    /* Present on exactly the answers that leave no way to start an agent, and
       pinned to that fact by the test suite rather than to this list. */
    consequence: 'Nothing on this computer will be able to start an assistant while this is the answer. The agent page shows no Start control, because there is nothing switched on for it to start. That page says so, and turns it on in one click when you want it. Settings has the same switch.',
  }),
  Object.freeze({
    value: 'assisted',
    label: 'Act when I start it',
    note: '',
    detail: 'You start an assistant and it works; it stops and asks you whenever it needs permission for something. Nothing runs until you press start, and approving, closing queue items and replying stay off.',
    consequence: '',
  }),
  Object.freeze({
    value: 'autonomous',
    label: 'Act on its own',
    note: 'Recommended',
    detail: 'The permitted app action switches are enabled, including approving items and replying, and ToolsEnabled permission questions use the assistant’s judgement. This is what a fresh copy does. Your permission level, your accounts, separate tool-approval controls and provider-native prompts still apply.',
    consequence: '',
  }),
])

/* Asked on the review screen rather than as its own step, because it is the one
 * choice a person can only make well while looking at the screens it changes. It
 * costs no question and it is still shown and walked through. */
export const SCREENS_CHOICES = Object.freeze([
  Object.freeze({
    value: 'live',
    label: 'My own activity',
    note: 'Recommended',
    detail: 'Every screen reads records from the computer you are driving. On a new installation most of them are empty until you run something, and they say so rather than filling the gap.',
  }),
  Object.freeze({
    value: 'demonstration',
    label: 'A labelled demonstration',
    note: '',
    /* One-world phrasing: the example is not a separate demonstration render
       any more, it is the product's built-in example shown through the same
       screens -- so the detail names what the screens SHOW, not a mode. */
    detail: 'Every screen shows the product’s built-in example so you can see what each one does. None of it is your data and each screen says so. Switch back at any time.',
  }),
])

/* THE ID OF THE FLAG THAT DECIDES WHETHER THIS PRODUCT CAN BE MADE TO DO
   ANYTHING. src/write-flags.js owns the flag; this names it once so the
   question "does this answer leave a way to start an agent?" has a single
   definition that the setup screens, the agent page and the test suite all
   ask the same way. */
export const START_CONTROL_FLAG = 'agent-session'

export const AUTONOMY_VALUES = Object.freeze(AUTONOMY_CHOICES.map(choice => choice.value))
export const SCREENS_VALUES = Object.freeze(SCREENS_CHOICES.map(choice => choice.value))

/* Basic enables normal app actions by default. These are requested actions,
 * not machine authority: deriveProfile still applies the saved tier ceiling.
 * Explicit Observe and individual disabled flags remain valid saved choices. */
export const SAFE_ANSWERS = Object.freeze({ autonomy: 'autonomous', screens: 'live' })
export const RECOMMENDED_ANSWERS = Object.freeze({ autonomy: 'autonomous', screens: 'live' })

/* ---------- what an answer implies ---------- */

/* src/write-flags.js owns the flag list; these are its ids. Repeating them as a
 * literal would go stale the first time a flag is added, so the derivation reads
 * the imported list and this map only says which ids an answer REQUESTS. An id
 * here that write-flags.js does not know is a programming error and is asserted
 * against in the test suite rather than silently ignored. */
/* An explicit Observe choice disables actions. It is independent of Basic's
 * fresh/default autonomous behavior. */
/* `cloud-launch` arrived from the Codex Cloud lane, which added it to
   src/write-flags.js. It is listed here for both acting answers because it is a
   launch a PERSON presses -- the flag's own description says each launch still
   asks for approval -- which is exactly what "Act when I start it" means. A flag
   that exists and no answer names is caught by the test suite, which walks the
   real flag list rather than this map. */
const AUTONOMY_WRITE_FLAGS = Object.freeze({
  observe: Object.freeze([]),
  assisted: Object.freeze(['report-read', 'agent-session', 'dispatch', 'cloud-launch']),
  autonomous: Object.freeze(['report-read', 'agent-session', 'dispatch', 'cloud-launch', 'decision', 'queue', 'thread-reply']),
})

/* The four settings other lanes are building enforcement for. Each axis is
 * ordered SAFEST FIRST, and the tier ceiling below is expressed as a maximum
 * index into that order -- so "clamp to what this level allows" is one comparison
 * and cannot accidentally be written the permissive way round. */
/* THE TWO SENTENCES THESE ROWS CAN TRUTHFULLY SAY ABOUT THEMSELVES.
 *
 * They live here, beside the rows, and not in the two screens that print
 * them. Both screens carried their own copy of one sentence about "the last
 * four rows", and the moment one row started being acted on BOTH sentences
 * became wrong -- in two files, either of which could have been missed. A
 * claim about a set of rows belongs with the rows. */
export const INTENT_IN_USE = 'This one is in use now.'
export const INTENT_RECORDED_ONLY = 'Recorded, not yet acted on.'
export const INTENT_BANNER_TITLE = 'What these rows do today.'
export const INTENT_BANNER_BODY = [
  'This program records all of them and keeps them.',
  'Permission questions, editor imports, and account switching are applied when you save.',
  'The saved attachment choice is used when you open an included editor session below. Watch reads saved messages; supported copies are prepared on the tree. Takeover requires a verified editor handoff, which is unavailable today.',
  'Each is set to its cautious end unless you moved it.',
].join(' ')

export const PROFILE_INTENT = Object.freeze([
  Object.freeze({
    id: 'approvals',
    name: 'When it needs permission',
    lane: 'two-path-connect',
    enforced: true,
    enforcedBy: 'agent.blocked_question in the ToolsEnabled system.ask approval handler',
    order: Object.freeze(['stop', 'other-work', 'judgement']),
    labels: Object.freeze({
      stop: 'Stop and ask me',
      'other-work': 'Work on something else while it waits',
      judgement: 'Use its own judgement',
    }),
    desc: 'What an assistant does when it asks through ToolsEnabled. Questions raised by the provider’s own tools follow the provider’s permission controls.',
  }),
  Object.freeze({
    id: 'attach',
    name: 'Attaching to a session already open in your editor',
    lane: 'two-path-connect',
    enforced: true,
    enforcedBy: 'setup-profile-settings editor actions, source receipts, and the ordinary tree launch path',
    order: Object.freeze(['mirror', 'fork', 'adopt']),
    labels: Object.freeze({
      mirror: 'Watch it only',
      fork: 'Continue it in a copy',
      adopt: 'Take it over',
    }),
    desc: 'The starting choice for each included editor session below; you can change it for that session. Watch is read-only. A supported copy gets its own conversation and starts only from its tree. Takeover requires the editor to relinquish exclusive control and is unavailable without that handoff.',
  }),
  Object.freeze({
    id: 'ideImport',
    name: 'Sessions found in your editor',
    lane: 'ide-import-surface',
    enforced: true,
    enforcedBy: 'ide-session-settings and the engine editor-session consent partition',
    order: Object.freeze(['none', 'ask', 'all-detected']),
    labels: Object.freeze({
      none: 'Do not bring any in',
      ask: 'Ask me each time',
      'all-detected': 'Bring in everything it finds',
    }),
    desc: 'Whether newly discovered editor sessions are offered here or included automatically. Existing explicit import and removal choices are kept. This does not start, stop, or take over an editor session.',
  }),
  Object.freeze({
    id: 'failover',
    name: 'If an account runs out',
    lane: 'multi-account-build',
    /* ENFORCED SINCE 2026-08-18, AND WHAT THAT WORD HAS TO MEAN HERE.
 *
 * This row shipped as `enforced: false` and was honest about it: the screen
 * said "recorded, not yet acted on" and nothing anywhere read the answer.
 * The owner's standing rule is that a setting is a row, a real enforcement
 * site, and a control a person can reach -- anything less is a lie told in
 * a settings list. Two of the three were already here. This is the third.
 *
 * WHERE IT IS ACTED ON, precisely, so this claim can be checked rather than
 * believed: the main process reads this answer and passes it to the payload
 * rotation module as its `mode`, and that module is what decides whether a
 * spent account may hand the session to the next one. `manual` refuses the
 * switch and reports which account is spent and which is ready; `auto`
 * performs it. Both directions are asserted in the payload's own
 * tests/multi-account-rotation.test.js.
 *
 * ONE ANSWER, ONE READER. The value is not copied into a second store on
 * its way there. A settings screen that shows one thing while a different
 * copy of the answer drives the behaviour is worse than an unenforced row,
 * because it looks true. */
    enforced: true,
    enforcedBy: 'the account switching in the assistant program',
    order: Object.freeze(['manual', 'auto']),
    labels: Object.freeze({
      manual: 'Stop and let me switch',
      auto: 'Switch to another account automatically',
    }),
    /* CORRECTED WHEN THE SIGN-IN STEP LANDED. This said "signing in never
       happens on this screen and no account details are ever collected here",
       which became ambiguous the moment setup grew an account step: if "here"
       means this row it is arguably true, and if a reader takes it to mean the
       walkthrough it is false. On a disclosure the ambiguity IS the defect,
       because the reader resolves it and we do not get to say which way. The
       half that is still true is the half that matters, and it is the one
       SHIPMENT-PLAN B14 turns on. */
    /* NARROWED A THIRD TIME, and the narrowing is the point. This said
       "anywhere in this product", which is a promise about code no test of mine
       can see: another lane adding a provider key field on some other screen
       would falsify it silently, and I would never know. A claim is only worth
       making if something can keep it true, so it is scoped to setup, which is
       what the copy rules actually walk. The sentence lost nothing a reader
       needed and gained a keeper. */
    /* WHAT THE TWO ANSWERS DO (T1583). The sentence above was a disclosure
       about the Account step, so the one row that decides whether agents move
       between provider accounts explained nothing about that. The credential
       sentence stays, reworded about the accounts this row is about: provider
       sign-ins, which setup never collects. */
    desc: 'What happens when a provider account reaches its limit. Stop and let me switch: the agent stops, and you pick the next account in the Accounts menu on Computers. Switch to another account automatically: the agent carries on with another signed-in account. Provider accounts are signed in inside their own programs; no Claude, ChatGPT or Google subscription, key, or password is asked for anywhere in setup.',
  }),
])

const INTENT_BY_ID = new Map(PROFILE_INTENT.map(field => [field.id, field]))

const AUTONOMY_INTENT = Object.freeze({
  observe: Object.freeze({ approvals: 'stop', attach: 'mirror', ideImport: 'none', failover: 'manual' }),
  assisted: Object.freeze({ approvals: 'other-work', attach: 'fork', ideImport: 'ask', failover: 'manual' }),
  autonomous: Object.freeze({ approvals: 'judgement', attach: 'fork', ideImport: 'all-detected', failover: 'auto' }),
})

/* ---------- the ceiling ---------- */

/* docs/design/INSTALLER-EXPERIENCE.md 2.5: "A tier is a different amount of
 * machine access, not a different amount of visible interface ... A tier that
 * refuses nothing is a skin." These are the refusals in profile terms.
 *
 * `guided` grants one assistant in one folder and section 2.2 refuses multiple
 * agents outright, so the dispatch form -- which starts lanes -- is above its
 * ceiling however the autonomy question is answered. It keeps the report reader
 * (which only reads) and starting the one session (which is the product). The
 * three fleet-operation controls are above it as well: approving owner requests,
 * claiming and closing queue items, and replying into a coordinator thread are
 * not what an assistant confined to one folder does. Launching a Codex Cloud
 * task is above it for the same reason the dispatch form is -- it starts work
 * that is not the one confined assistant this level grants.
 *
 * WHAT EVERY LEVEL KEEPS IS `agent-session`, and that is load-bearing rather
 * than incidental: it is the flag that decides whether a control exists anywhere
 * that starts an agent, so a level that refused it would be a level at which the
 * product cannot be made to do anything. `profileCanStartAnAgent` is asserted
 * true for the recommended answers at all three levels.
 *
 * `standard` and `unrestricted` permit every flag; they still differ, in the
 * machine access the level itself grants and in the intent maxima below. */
export const TIER_CEILINGS = Object.freeze({
  guided: Object.freeze({
    writeFlags: Object.freeze(['report-read', 'agent-session']),
    intent: Object.freeze({ approvals: 'stop', attach: 'mirror', ideImport: 'none', failover: 'manual' }),
  }),
  standard: Object.freeze({
    writeFlags: Object.freeze(['report-read', 'agent-session', 'dispatch', 'cloud-launch', 'decision', 'queue', 'thread-reply']),
    intent: Object.freeze({ approvals: 'judgement', attach: 'adopt', ideImport: 'ask', failover: 'auto' }),
  }),
  unrestricted: Object.freeze({
    writeFlags: Object.freeze(['report-read', 'agent-session', 'dispatch', 'cloud-launch', 'decision', 'queue', 'thread-reply']),
    intent: Object.freeze({ approvals: 'judgement', attach: 'adopt', ideImport: 'all-detected', failover: 'auto' }),
  }),
})

/* An unrecognised level is the SMALLEST ceiling, never the largest. A record
 * written by a newer build, a typo, or a truncated read must not be the reason a
 * profile switches everything on. */
export function ceilingForTier(tier) {
  return TIER_CEILINGS[tier] || TIER_CEILINGS.guided
}

function clampIntentValue(fieldId, requested, tier) {
  const field = INTENT_BY_ID.get(fieldId)
  if (!field) return { value: null, clamped: false }
  const ceiling = ceilingForTier(tier).intent[fieldId]
  const ceilingIndex = field.order.indexOf(ceiling)
  const requestedIndex = field.order.indexOf(requested)
  /* An unknown requested value is index -1 and resolves to the safest option,
     which is index 0. An unknown ceiling would resolve to -1 as well, so it is
     floored at 0 rather than allowed to make every value "above the ceiling". */
  const maxIndex = ceilingIndex < 0 ? 0 : ceilingIndex
  const wantIndex = requestedIndex < 0 ? 0 : requestedIndex
  const finalIndex = Math.min(wantIndex, maxIndex)
  return {
    value: field.order[finalIndex],
    clamped: wantIndex > maxIndex,
    requested: field.order[wantIndex],
  }
}

/* ---------- derivation ---------- */

/* The four intent fields live IN the answers, not beside them.
 *
 * They start as whatever the autonomy answer implies -- that is the whole point
 * of asking one question instead of five -- but the review screen lets each be
 * changed on its own, and a change that survives only until the next repaint is
 * not a change. Holding them in the answers means "the set this answer implies"
 * and "the one you moved afterwards" are the same field, so nothing has to
 * reconcile two sources later.
 *
 * Picking a different autonomy answer RESETS all four, which is the behaviour a
 * person expects from choosing a different overall posture, and is why
 * `answersForAutonomy` exists rather than the view mutating one field. */
function normalizeAnswers(answers) {
  const source = answers && typeof answers === 'object' && !Array.isArray(answers) ? answers : {}
  const autonomy = AUTONOMY_VALUES.includes(source.autonomy) ? source.autonomy
    : Object.hasOwn(source, 'autonomy') ? 'observe' : SAFE_ANSWERS.autonomy
  const implied = AUTONOMY_INTENT[autonomy]
  const normalized = {
    autonomy,
    screens: SCREENS_VALUES.includes(source.screens) ? source.screens : SAFE_ANSWERS.screens,
    workspaceRoots: Array.isArray(source.workspaceRoots)
      ? source.workspaceRoots.filter(entry => typeof entry === 'string' && entry.trim() !== '')
      : [],
  }
  for (const field of PROFILE_INTENT) {
    const given = source[field.id]
    normalized[field.id] = field.order.includes(given) ? given : implied[field.id]
  }
  return normalized
}

/** The coherent answer set one autonomy choice implies, intent fields included. */
export function answersForAutonomy(autonomy, answers = {}) {
  const value = AUTONOMY_VALUES.includes(autonomy) ? autonomy : SAFE_ANSWERS.autonomy
  const reset = { ...normalizeAnswers(answers), autonomy }
  for (const field of PROFILE_INTENT) reset[field.id] = AUTONOMY_INTENT[value][field.id]
  return reset
}

/**
 * Every setting the answers imply, with the tier applied as a ceiling.
 *
 * @param answers  what the person chose. Anything unrecognised becomes the safe
 *                 option; this never throws, because a profile that crashes on a
 *                 stored value from an older build is a product that cannot be
 *                 recovered from its own settings screen.
 * @param options.tier          the recorded permission level (the ceiling).
 * @param options.writeFlagIds  the ids src/write-flags.js knows, injected so the
 *                              derivation cannot drift from the real flag list.
 */
export function deriveProfile(answers, { tier, writeFlagIds = [] } = {}) {
  const chosen = normalizeAnswers(answers)
  const ceiling = ceilingForTier(tier)
  const requestedWrite = new Set(AUTONOMY_WRITE_FLAGS[chosen.autonomy] || AUTONOMY_WRITE_FLAGS.observe)
  const permitted = new Set(ceiling.writeFlags)

  const writeFlags = {}
  const refused = []
  for (const id of writeFlagIds) {
    const wanted = requestedWrite.has(id)
    const allowed = permitted.has(id)
    writeFlags[id] = wanted && allowed
    if (wanted && !allowed) refused.push(id)
  }

  /* ONE BOOLEAN WHERE A MAP OF SEVEN WAS. The demonstration answer used to
     switch every per-view flag off together; those flags are gone and the one
     example toggle (src/data-source.js) is what the answer reaches now. The
     polarity is the toggle's own: true means "show the example". */
  const exampleMode = chosen.screens === 'demonstration'

  const intent = {}
  const intentClamped = []
  for (const field of PROFILE_INTENT) {
    const result = clampIntentValue(field.id, chosen[field.id], tier)
    intent[field.id] = result.value
    if (result.clamped) intentClamped.push({ id: field.id, requested: result.requested, allowed: result.value })
  }

  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    tier: typeof tier === 'string' ? tier : null,
    answers: chosen,
    writeFlags,
    exampleMode,
    intent,
    /* What the level refused. Carried out of the derivation rather than dropped,
       so the review screen states the refusal instead of showing an answer the
       person gave next to settings that quietly disagree with it. */
    refusedWriteFlags: refused,
    clampedIntent: intentClamped,
  }
}

export function matchingAutonomy({ tier, writeFlags = {}, intent = {}, accountApplicable = true, preferred } = {}) {
  // A recorded answer only breaks ties when the permission ceiling makes two
  // presets equivalent. It cannot make a changed policy retain a preset name.
  const matches = AUTONOMY_CHOICES.filter(choice => {
    const plan = deriveProfile(answersForAutonomy(choice.value), { tier, writeFlagIds: Object.keys(writeFlags) })
    return Object.entries(plan.writeFlags).every(([id, value]) => writeFlags[id] === value)
      && PROFILE_INTENT.every(field => field.id === 'failover' && !accountApplicable || intent[field.id] === plan.intent[field.id])
  }).map(choice => choice.value)
  return matches.includes(preferred) ? preferred : matches[0] || 'custom'
}

/**
 * Does this ANSWER ask for a way to start an agent?
 *
 * A question about the answer alone, before any ceiling: it is what the
 * `consequence` sentences on AUTONOMY_CHOICES are pinned to, so a fourth
 * autonomy option added later cannot ship without either requesting the start
 * flag or saying out loud that it does not.
 */
export function autonomyStartsAgents(value) {
  const requested = AUTONOMY_WRITE_FLAGS[value] || AUTONOMY_WRITE_FLAGS.observe
  return requested.includes(START_CONTROL_FLAG)
}

/**
 * Does this DERIVED profile leave a control that starts an agent?
 *
 * The same question asked of the outcome, ceiling included, which is the form
 * that can actually be wrong: an answer may request the flag and a permission
 * level may refuse it. Every tier permits it today -- `guided` grants one
 * assistant in one folder and that assistant has to be startable -- and the
 * test suite asserts that for the recommended answers at every level rather
 * than trusting the table to stay that way.
 */
export function profileCanStartAnAgent(derived) {
  return derived?.writeFlags?.[START_CONTROL_FLAG] === true
}

/**
 * Write the derived settings through the application's own setters.
 *
 * The setters are INJECTED rather than imported, for two reasons that are the
 * same reason: `node --test` has no localStorage, and a test that stubs storage
 * proves the storage stub works. Passing setWriteEnabled and setExampleMode in
 * means the real path and the tested path are one call graph.
 *
 * The example toggle is applied in BOTH directions, exactly as every write
 * flag is: choosing "my own activity" turns the example off, so a profile
 * finished on a machine where somebody had switched the example on lands on
 * the state the review screen showed, not on a leftover.
 *
 * Nothing here writes `mc.set.*`. See the header: nothing reads it.
 */
export function applyProfile(derived, { setWriteFlag, setExampleMode } = {}) {
  const applied = { writeFlags: {} }
  for (const [id, enabled] of Object.entries(derived?.writeFlags || {})) {
    applied.writeFlags[id] = Boolean(setWriteFlag?.(id, enabled))
  }
  if (derived && typeof derived === 'object') {
    applied.exampleMode = Boolean(setExampleMode?.(derived.exampleMode === true))
  }
  return applied
}

/* ---------- the stored record ---------- */

/* `status` is three-valued on purpose. `in-progress` exists because a person who
 * closes the window halfway through has NOT chosen the safe defaults -- they have
 * chosen nothing -- and the difference decides whether reopening setup resumes or
 * starts again. Nothing is applied while a profile is `in-progress`; the answers
 * are held and the machine is untouched. */
export const PROFILE_STATUSES = Object.freeze(['in-progress', 'skipped', 'complete'])

/* WHAT DID NOT HAPPEN, CARRIED WITH WHAT DID.
 *
 * shell/setup-record.cjs recordWorkspaces answers
 * { ok: true, assistantConfig: { ok: false, code } } when the folders were saved
 * but the agent-client config could not be written -- a locked or unwritable
 * .mcp.json. Its own comment states the contract: "NEITHER OUTCOME FAILS THE
 * RECORDING ... Both outcomes are returned alongside, with codes and no paths,
 * SO THE SCREEN CAN SAY WHAT DID AND DID NOT HAPPEN."
 *
 * The screen said nothing. `assistantConfig` appeared ZERO times in all of src/,
 * so first run completed, navigated away, and recorded itself as complete while
 * the person's agent clients had no ToolsEnabled configuration and nothing
 * anywhere would ever mention it.
 *
 * The producer is right not to fail: the folders ARE saved, and refusing would
 * tell the person their choice did not take when it did. What was missing is the
 * other half of its own sentence. Both halves travel now.
 *
 * This reader and its writer both rebuilt the record from a FIXED FIELD LIST, so
 * passing the field through would have been silently dropped -- the same shape as
 * src/account-state.js readActionResult, which dropped `revoked` and let the
 * account screen claim every copied sign-in had been refused. */
/* Same shape, same rule: only a stated UNAVAILABILITY is carried, so nothing
   downstream has to tell "undo works" apart from "nobody said".

   THE NAME IS GENERAL BECAUSE THERE ARE NOW THREE OF THESE, and the third was
   the one that cost the most. `accountPolicyDeferred` below carries the
   account-switching deferral, which has exactly this shape -- a stated reason or
   nothing. Calling the helper `normalizeUndo` and reaching for it from the
   account policy is how a reader ends up believing the two facts are the same
   fact. */
function normalizeStatedReason(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const reason = typeof value.reason === 'string' && value.reason.trim() ? value.reason.trim() : null;
  return reason ? { reason } : null;
}

function normalizeAssistantConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.ok !== false) return null;
  const code = typeof value.code === 'string' && value.code.trim() ? value.code.trim() : null;
  const reason = typeof value.reason === 'string' && value.reason.trim() ? value.reason.trim() : null;
  return { ok: false, code, reason };
}

export function readStoredProfile(scope = globalThis) {
  let raw = null
  try {
    raw = scope?.localStorage?.getItem(PROFILE_STORAGE_KEY) ?? null
  } catch (cause) {
    /* `null` is reserved for the one result that establishes absence: getItem
       returned null. A busy or unreadable storage service establishes no such
       fact. In particular, do not retain this result: every call performs the
       read again, so a transient EMFILE/EAGAIN/EIO/EBUSY can recover. */
    const error = new Error(
      'The setup profile could not be read; this is not claiming that the profile is absent.',
      { cause },
    )
    error.code = PROFILE_READ_UNAVAILABLE
    throw error
  }
  if (raw === null) return null
  let parsed
  try { parsed = JSON.parse(raw) } catch { return null }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  if (parsed.schemaVersion !== PROFILE_SCHEMA_VERSION) return null
  if (!PROFILE_STATUSES.includes(parsed.status)) return null
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    status: parsed.status,
    step: typeof parsed.step === 'string' ? parsed.step : null,
    answers: normalizeAnswers(parsed.answers),
    updatedAtMs: Number.isFinite(parsed.updatedAtMs) ? parsed.updatedAtMs : null,
    /* Null when it succeeded or was never attempted. Only a stated failure is
       carried, so nothing has to distinguish "fine" from "not recorded". */
    assistantConfig: normalizeAssistantConfig(parsed.assistantConfig),
    /* THE SECOND FACT IN THE SAME REPLY, and it was missed by the commit that
       carried the first. recordWorkspaces answers { ok, roots, provisioned,
       assistantConfig, releasedRoots }; `provisioned` carries per-root
       undoAvailable and undoUnavailableReason, faithfully, from
       engine/src/lib/setup/workspace.js -- which returns them precisely so a
       surface can say when "Undo the last thing it did" will not work, usually
       because the machine has no git. Nothing in src/ read either.
       A person then finds out at the moment they reach for the undo, which is the
       worst moment there is. */
    undoUnavailable: normalizeStatedReason(parsed.undoUnavailable),
    /* THE THIRD FACT, AND THE ONE THAT STOPPED FIRST RUN DEAD.
       mcProviders.accountPolicy cannot record an account-switching choice before
       the account list exists -- shell/account-registry.cjs setPolicy refuses
       ACCOUNT_REGISTRY_ABSENT -- which is EVERY fresh installation.
       src/setup-intent-commit.js correctly calls that a deferral rather than a
       failure, because nothing the person asked for was lost. But the deferral
       lived only in a local variable on the review, so Finish had two choices:
       hold the person on the setup screen to show it, or navigate and throw it
       away. It held them, on every first run (measured 2026-09-11 on the
       packaged Linux candidate: Finish left hash=#/setup with an alert-styled
       notice about a preference the wizard never asks). It matters that it is
       not thrown away, because shell/account-registry.cjs DEFAULT_SELECTION_MODE
       is 'priority' while the walkthrough's answer is 'manual' -- so the machine
       that comes back from adding an account defaults to the OPPOSITE of the
       recorded profile. Carried here, the fact outlives the screen: Finish
       enters the application and the review states it again whenever the person
       reopens the walkthrough. */
    accountPolicyDeferred: normalizeStatedReason(parsed.accountPolicyDeferred),
  }
}

export function writeStoredProfile(record, scope = globalThis) {
  const payload = {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    status: PROFILE_STATUSES.includes(record?.status) ? record.status : 'in-progress',
    step: typeof record?.step === 'string' ? record.step : null,
    answers: normalizeAnswers(record?.answers),
    updatedAtMs: Number.isFinite(record?.updatedAtMs) ? record.updatedAtMs : Date.now(),
    assistantConfig: normalizeAssistantConfig(record?.assistantConfig),
    undoUnavailable: normalizeStatedReason(record?.undoUnavailable),
    accountPolicyDeferred: normalizeStatedReason(record?.accountPolicyDeferred),
  }
  try { scope?.localStorage?.setItem(PROFILE_STORAGE_KEY, JSON.stringify(payload)) } catch { return null }
  return payload
}

/**
 * Which screen should the walkthrough open on?
 *
 * A recorded profile sends a returning visitor to the review rather than back
 * through the questions, because "change one thing" is the reason anyone reopens
 * this. An interrupted one resumes where it stopped. Nothing has been applied in
 * either case that this function needs to undo.
 */
export function resumeStep(stored, { tierRecorded, steps }) {
  const order = Array.isArray(steps) ? steps : []
  if (!tierRecorded) return order[0] ?? 'tier'
  if (!stored) return order[1] ?? 'review'
  if (stored.status === 'in-progress' && order.includes(stored.step)) return stored.step
  return order[order.length - 1] ?? 'review'
}

/* THE FLOW IS DERIVED FROM THE STEP LIST, NOT WRITTEN OUT TWICE.
 *
 * Every Continue and Back used to name its destination as a literal, which is
 * fine until someone inserts a step -- and then the list says the step exists
 * while no button goes there. That happened: an entire sign-in screen was added
 * to STEPS, built, and tested, and nothing routed to it. It was dead on arrival
 * and every test over it was green, because a test that a screen RENDERS cannot
 * see that a person can never reach it.
 *
 * So the destination is computed from the list. Adding a step to STEPS now wires
 * it into the flow by construction, and `stepsAreReachable` below asserts the
 * chain actually covers the list rather than trusting that it does.
 */
export function stepAfter(steps, current) {
  const order = Array.isArray(steps) ? steps : []
  const index = order.indexOf(current)
  if (index === -1) return order[order.length - 1] ?? null
  return order[index + 1] ?? null
}

export function stepBefore(steps, current) {
  const order = Array.isArray(steps) ? steps : []
  const index = order.indexOf(current)
  if (index <= 0) return null
  return order[index - 1]
}

/** Walking forward from the first step, is every step actually arrived at? */
export function stepsAreReachable(steps) {
  const order = Array.isArray(steps) ? steps : []
  if (order.length === 0) return false
  const seen = new Set([order[0]])
  let current = order[0]
  for (let guard = 0; guard < order.length + 1; guard += 1) {
    const next = stepAfter(order, current)
    if (next === null) break
    if (seen.has(next)) return false
    seen.add(next)
    current = next
  }
  return seen.size === order.length
}

export function intentField(id) {
  return INTENT_BY_ID.get(id) || null
}

/* WHY THERE IS NO START CONTROL, IN THE PERSON'S OWN WORDS.
 *
 * Two genuinely different ways to arrive at a machine that cannot start an
 * agent, and telling them apart is the whole value of the sentence: the
 * walkthrough's autonomy answer, or the Settings switch on a machine that never
 * recorded a profile. Telling somebody setup did it when they turned it off
 * themselves an hour ago is the product misdescribing its own state.
 *
 * IT LIVES HERE, not on the two screens that say it, because both of them say
 * it: the agent page's switched-off surface and the fleet page's start panel.
 * Two copies of one explanation is how one of them comes to be wrong. */
/* THE WORDS ON THE SWITCH THAT TURNS IT BACK ON.
 *
 * Here for the same reason startControlOffBecause() is, and the reason is now
 * literally true of two surfaces rather than one: the agent page's switched-off
 * surface has carried this button since R1529, and the fleet page's start panel
 * carries it as of 2026-08-18. Both had to name the same control, and a label
 * typed twice is a label that reads differently on the two screens the first
 * time only one is edited.
 *
 * It says what the press DOES, not what the setting is called. "Turn on running
 * agents" is a verb a person can act on; "agent-session" is the row it writes,
 * and a row identifier in front of a person is the defect
 * tools/check-plain-language.mjs exists to catch. */
export const START_CONTROL_ON = Object.freeze({
  label: 'Turn on running agents',
})

/* AN ANSWER NOBODY GAVE WAS BEING QUOTED BACK TO THE PERSON WHO DID NOT GIVE
 * IT. This read stored.answers.autonomy and nothing else, so a SKIPPED
 * walkthrough -- whose answers are the safe defaults the skip wrote, not
 * anything a person chose -- was described on the agent page and the fleet
 * start panel as: Setup recorded "Nothing yet - let me look around first".
 * They recorded nothing. They pressed a button that ended setup.
 *
 * The record has always carried the fact: `status` is one of in-progress,
 * skipped or complete, and setup-profile-settings.js reads it correctly on the
 * SAME record and says "Setup was skipped, so these are the safe defaults". So
 * two live surfaces described one record two different ways and one of them was
 * false. This is the false one, corrected -- in Settings' existing words rather
 * than a third vocabulary.
 *
 * IN-PROGRESS IS THE SAME MISTAKE, and it is why this branches on status rather
 * than special-casing the skip: somebody who closed setup halfway also never
 * recorded an autonomy answer, so only `complete` may claim one. */
/* THE SENTENCE THAT BLAMES NOBODY, named once because two paths reach it: a
   machine with no recorded profile (the Settings switch), and a read that could
   not tell. It states the fact the surface already knows -- starting is off --
   and attributes it to nothing, which is the only honest thing to say when the
   cause is unknown. */
const START_CONTROL_OFF_UNATTRIBUTED = 'Starting an assistant is switched off for the computer you are driving.'

export function startControlOffBecause(scope = globalThis) {
  /* READING THE PROFILE CAN NOW SAY "I COULD NOT TELL", AND THIS SENTENCE STILL
   * HAS TO EXIST. readStoredProfile throws PROFILE_READ_UNAVAILABLE instead of
   * returning null when storage is busy or unreadable, because null is reserved
   * for the definite fact that no profile is stored. That distinction is right
   * and stays. What it must not do is travel out of here.
   *
   * Every caller of this is a surface explaining WHY the Start control is off,
   * and src/views/computers.js evaluates startControlOffReason() INLINE while
   * it builds palette rows (the effort, resume and clear rows each compute
   * their disabledHint eagerly). A throw there does not blank one sentence, it
   * takes down the panel that was supposed to explain the refusal -- on a
   * machine whose storage is merely busy for a moment.
   *
   * So a could-not-read lands on the sentence that ATTRIBUTES NOTHING. It may
   * not fall through to the branches below: "Setup was skipped" and "Setup
   * recorded ..." are claims about a record nobody managed to look at. */
  let stored = null
  try {
    stored = readStoredProfile(scope)
  } catch {
    return START_CONTROL_OFF_UNATTRIBUTED
  }
  if (stored?.status === 'skipped') {
    return 'Setup was skipped, so starting an assistant is off and nothing that acts is switched on.'
  }
  const chosen = stored?.status === 'complete' ? autonomyChoice(stored.answers?.autonomy) : null
  return chosen && chosen.consequence
    ? `Setup recorded “${chosen.label}”, and that answer switches off starting an assistant.`
    : START_CONTROL_OFF_UNATTRIBUTED
}

/* THE WHOLE SENTENCE THE START CONTROL SHOWS WHEN IT IS OFF, in one place.
 *
 * It used to live as a private function inside src/views/computers.js, which
 * meant the OTHER surfaces that need it either did without or would have had to
 * copy the tail. The agent page needed it and had no import, so its chat box
 * refused with nothing at all. Two copies of one sentence is how the two halves
 * of a product come to say different things about one switch, which is the
 * defect this codebase has been repeatedly bitten by -- so it moved here, beside
 * the reason it is built from, and computers.js imports it like everyone else.
 *
 * The tail is deliberately the same for every surface: the switch is the same
 * switch, and turning it on has the same consequence wherever you are standing. */
export function startControlOffReason(scope = globalThis) {
  return `${startControlOffBecause(scope)} Turning it on starts nothing by itself, `
    + 'it just puts the Start control back. You can change this later in Settings.'
}

export function autonomyChoice(value) {
  return AUTONOMY_CHOICES.find(choice => choice.value === value) || AUTONOMY_CHOICES[0]
}

export function screensChoice(value) {
  return SCREENS_CHOICES.find(choice => choice.value === value) || SCREENS_CHOICES[0]
}
