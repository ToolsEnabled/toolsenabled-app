/* SETTINGS -> SETUP: everything the walkthrough decided, where it can be found.
 *
 * The owner's requirement has a second half that is easy to miss: the
 * walkthrough may infer, but "inference the user cannot see or correct is a
 * trust problem". So every setting the three questions produce has to be
 * reachable afterwards, including the ones nobody was asked about.
 *
 * Most of them already are. The six write-action flags are rows in Settings ->
 * Write and the six live-view flags are rows in Settings -> Data & Sim; both
 * shipped before this walkthrough existed and neither is duplicated here. What
 * had no home at all is this section:
 *
 *   - THE PERMISSION LEVEL. src/setup-state.js tells every reader "You can
 *     change it later in Settings." That sentence was not true: the level was
 *     writable only from the first-run screen, which a configured machine never
 *     shows again. It is a row here now, and that is the sentence becoming true
 *     rather than a new feature.
 *   - THE WORKING FOLDERS, which decide what an assistant may touch and which
 *     were previously chosen silently by shell/setup-record.cjs.
 *   - THE FOUR INTENT CHOICES. Permission questions and editor imports now
 *     read their canonical policies, account selection reads Accounts, and
 *     attachment choices feed the real Watch/copy controls. Unsupported
 *     takeover is stated beside its choice.
 *
 * Settings presets stage their affected outputs under the same draft keys as
 * the individual controls. The setup record is saved after those writes; it
 * cannot replay an old preset over a later explicit preference.
 *
 * CHANGING THE LEVEL DOWNWARD RE-CLAMPS. Moving from `unrestricted` to `guided`
 * here re-derives the profile against the new ceiling and turns off every write
 * action the smaller level does not permit. Leaving them on would produce a
 * machine whose recorded level and whose actual controls disagree, which is the
 * failure the tier is supposed to prevent.
 */

import { TIER_CHOICES, TIER_IDS, noteTierRecorded, SETUP_RESOLUTION, WORKSPACE_ACCESS_NOTICE } from './setup-state.js'
import { controlState } from './components.js'
import { matchesSettingQuery } from './product-settings-layout.js'
/* The same three answers this lane owes every withheld switch -- what is off,
   what would turn it on, what that gains and risks -- reached from the place a
   person arrives at LATER, rather than only on the walkthrough they may have
   taken weeks ago (owner, R1529). */
import { withheldMarkup } from './guided-step.js'
/* The screens answer lands on ONE switch now: the example toggle owned by
   src/data-source.js, which replaced the seven per-view live flags. */
import { currentDataSource, isExampleMode, setExampleMode } from './data-source.js'
import { WRITE_ACTION_FLAGS, isWriteEnabled, setWriteEnabled } from './write-flags.js'
/* THE MOMENT OF CHOOSING FULL ACCESS (owner, X4, 2026-08-15). The widest level
   is not written on the press: the risk is stated in the Terms' own words, on
   this row, and the person is asked. The words, the gate and the sentence about
   what the record holds all come from one module, so this row and the
   walkthrough cannot describe the same choice two ways. */
import {
  createRiskGate,
  describeConsentRecord,
  requiresRiskConsent,
  unrestrictedRiskMarkup,
} from './unrestricted-consent.js'
import {
  AUTONOMY_CHOICES,
  PROFILE_INTENT,
  RECOMMENDED_ANSWERS,
  SAFE_ANSWERS,
  SCREENS_CHOICES,
  answersForAutonomy,
  applyProfile,
  ceilingForTier,
  deriveProfile,
  intentField,
  matchingAutonomy,
  profileCanStartAnAgent,
  readStoredProfile,
  writeStoredProfile,
  INTENT_BANNER_BODY,
  INTENT_BANNER_TITLE,
  INTENT_IN_USE,
  INTENT_RECORDED_ONLY,
} from './setup-profile.js'
/* THE SAME READ-ONLY CARD setup.js's review step already draws, reused here
   rather than re-derived -- one decision, read from one place, so "what does
   this computer have" cannot answer differently on the walkthrough and on
   this settings row. DOM-free, so this file supplies its own markup wrapper. */
import { localModelReadiness } from './setup-review-readiness.js'
/* The one door to the actual install/download controls, which live in
   Settings, under "This computer" (owner ruling via fleet-B: they are drawn
   from PROVIDER_SETUP, never a second install path here -- this row is a
   summary and a door, not a third way to install Ollama). */
import { GUIDE_HREF } from './first-run-needs.js'
import { applySetupIntentChanges } from './setup-intent-commit.js'
import { createSetupPolicyDraft, SETUP_PROFILE_DEPENDENCIES } from './setup-policy-draft.js'
import { auditReceiptDisposition } from './mission-bridge.js'
import { editorAttachmentDrafts } from './editor-attachment-drafts.js'
import { focusKeeper } from './focus-keep.js'

/* Counted for the settings footer, which states how many settings exist. The
   permission level, the folders, the two derived answers and the four intent
   fields: eight rows a person can move. */
export const SETUP_PROFILE_SETTING_COUNT = 8

// A navigation door, not another setting or an installation path. Keep its
// visible words in the search index so this optional setup stays discoverable.
const SANDBOX_SETUP_NAME = 'Docker and sandbox setup (optional)'
const SANDBOX_SETUP_DESCRIPTION = 'Docker is needed for sandbox execution, not normal Claude or Codex agents or tree delegation. Open setup and continue to the review page for a readiness check and preparation of the ToolsEnabled sandbox image. Expand “Set up Docker (optional)” there for installation guidance. Opening setup does not install Docker or grant permissions.'
const ACCOUNT_SELECTION_NAME = 'Default account selection'
const ACCOUNT_SELECTION_DESCRIPTION = 'The default rule for choosing provider accounts when new sessions start.'
/* The Accounts menu lives only on Computers; this address opens it there (T1588). */
export const ACCOUNTS_MENU_HREF = '#/computers?accounts=open'

/* WHY THE FOLDER WAS REFUSED, WHICHEVER WAY THE SHELL SAID IT.
 *
 * `mcSetup.chooseWorkspace()` answers a refusal in two different shapes, and
 * both screens that ask the folder question used to read only the first:
 *
 *   a folder the check refused   { ok: false, code, reason, resolved }
 *   anything that THREW inside   { ok: false, error: { code, message } }
 *
 * The second is what `withFleetProfileSender` in shell/main.cjs returns for
 * every exception in that handler, so it is not an exotic path. MEASURED while
 * driving the shipped 1.0.20 build on a fresh profile: pressing "Choose a
 * different folder..." answered
 *     { ok: false, error: { code: 'MC_FLEET_PROFILE_ACTION_FAILED',
 *                           message: "Failed to get 'documents' path" } }
 * and the screen read "That folder cannot be used -- The application did not say
 * why." It had been told why, in a sentence, and dropped it.
 *
 * capability/src/lib/setup/workspace.js states the rule this broke, in its own
 * words: every refusal here has to be explainable to the person who chose the
 * folder, because "that folder cannot be used" with no reason is the shape that
 * makes someone pick a worse one.
 *
 * A BARE IDENTIFIER IS NOT A SENTENCE. src/refusal-copy.js refuses those for a
 * reason a person meets rather than a rule: MC_FLEET_PROFILE_ACTION_FAILED on
 * the glass is a code with no reader, and printing it would technically satisfy
 * "say why" while telling nobody anything. Same test here, same outcome: fall
 * through to the sentence that at least admits the silence.
 *
 * It lives in this module, and the walkthrough imports it, so the two screens
 * cannot drift into explaining the same refusal two different ways -- which is
 * exactly how one of them came to miss a shape the other would have shown. */
const BARE_IDENTIFIER = /^[A-Z][A-Z0-9_]*$/

/* WHAT THE LEDGER SAYS ABOUT ONE LEVEL CHANGE, read off the shell's WHOLE
   answer (shell/tier-consent.cjs auditedTierChoice: { ok, tier, recorded,
   intentAudit? }) and never assumed. The shell records the change as
   'setup.tier.choose' on 'tier:<level>', intent first, and answers one of:
     - auditing off (T782): recorded is the engine's exact not-required
       object for the outcome, and intentAudit -- a TOP-LEVEL field beside
       it, never inside it (Controller review of v3, F5) -- is the exact
       object for the intent; both are read through auditReceiptDisposition
       (M10's contract: every field, no extra, this action and target) --
       'not-required';
     - recorded is the pair { ok: true, sequence, intentSequence }, the
       outcome row after the intent row, with no field contradicting it and
       no intentAudit beside it -- 'recorded';
     - recorded is { ok: false, code: 'AUDIT_PAYLOAD_ABSENT' }: no ledger
       writer in this copy -- 'no-writer';
     - recorded is any other { ok: false, code } -- 'refused';
     - no recorded at all: a confined-to-confined move that has no ledger
       step -- 'absent'.
   Anything else -- ok: true with no sequence, signed: false beside ok: true,
   a not-required claim for another level or with a field missing or added,
   an intentAudit without its not-required outcome or beside a pair -- is
   'unconfirmed': the level moved, and its record cannot be confirmed. A
   record is called signed only from the pair the signed ledger answered,
   never from the absence of a negative. */
const TIER_CHOICE_ACTION = 'setup.tier.choose'
export function tierRecordDisposition(answer, tier) {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return 'unconfirmed'
  const { recorded, intentAudit } = answer
  if (recorded === undefined) return intentAudit === undefined ? 'absent' : 'unconfirmed'
  if (!recorded || typeof recorded !== 'object' || Array.isArray(recorded)) return 'unconfirmed'
  const target = `tier:${tier}`
  if (recorded.disposition === 'not-required') {
    return auditReceiptDisposition(recorded, TIER_CHOICE_ACTION, target) === 'not-required'
      && auditReceiptDisposition(intentAudit, `${TIER_CHOICE_ACTION}.intent`, target) === 'not-required'
      ? 'not-required' : 'unconfirmed'
  }
  if (intentAudit !== undefined) return 'unconfirmed'
  if (recorded.ok === false) return recorded.code === 'AUDIT_PAYLOAD_ABSENT' ? 'no-writer' : 'refused'
  const contradicted = ['ok', 'required', 'recorded', 'durable', 'anchored', 'signed'].some(key => Object.hasOwn(recorded, key) && recorded[key] !== true)
    || (Object.hasOwn(recorded, 'disposition') && recorded.disposition !== 'recorded')
    || (Object.hasOwn(recorded, 'action') && recorded.action !== TIER_CHOICE_ACTION)
    || (Object.hasOwn(recorded, 'target') && recorded.target !== target)
  const pair = Number.isSafeInteger(recorded.sequence) && recorded.sequence > 0
    && Number.isSafeInteger(recorded.intentSequence) && recorded.intentSequence > 0 && recorded.sequence > recorded.intentSequence
  return recorded.ok === true && !contradicted && pair ? 'recorded' : 'unconfirmed'
}

const TIER_RECORD_NOTE = Object.freeze({
  'not-required': ' Activity auditing is off, so no ledger record was requested for this change.',
  recorded: ' The change was recorded in the signed ledger.',
  'no-writer': ' This copy carries no ledger writer, so the change was not recorded.',
  refused: ' The change could not be recorded in the signed ledger.',
  unconfirmed: ' The level changed, but its activity record could not be confirmed.',
  absent: '',
})

export function setupRefusalDetail(result, fallback = 'The application did not say why.') {
  const candidates = [result?.reason, result?.error?.message, result?.message]
  for (const candidate of candidates) {
    const text = typeof candidate === 'string' ? candidate.trim() : ''
    if (text.length === 0) continue
    if (BARE_IDENTIFIER.test(text)) continue
    if (!/[a-z]/.test(text)) continue
    return text
  }
  return fallback
}

const WRITE_FLAG_IDS = WRITE_ACTION_FLAGS.map(flag => flag.id)
const PROFILE_SAVE_DEPENDENCIES = Object.freeze([
  ...SETUP_PROFILE_DEPENDENCIES, 'setup:tier', 'setup:workspace',
  ...WRITE_FLAG_IDS.map(id => `row:write_${id}`), 'row:example_mode',
])

const esc = value => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

/* Copy in this section describes the machine whose setup record and folders
   are being changed. On the desktop that is this computer; over the relay it
   is the computer the browser is driving. Keep that distinction at the read,
   where the resolved source is known, rather than baking the desk reader into
   the underlying setup choices. */
const machineCopy = sentence => currentDataSource() === 'relay'
  ? String(sentence).replace(/This computer/g, 'The computer you are driving').replace(/this computer/g, 'the computer you are driving')
  : sentence

export function createSetupProfileSettings({ stageWrite = null, draft = null, productSettings = null, navigate = hash => { location.hash = hash } } = {}) {
  const stored = readStoredProfile()
  let answers = stored ? stored.answers : { ...SAFE_ANSWERS, workspaceRoots: [] }
  let draftTier = null
  let status = stored ? stored.status : null
  let hostRoot = null
  let busy = null
  let feedback = null
  let workspace = null
  let loadStarted = false
  /* A model on this computer's own hardware -- the same null-while-unasked
     convention as `workspace` above, fed by mcProviders.detectLocal() rather
     than mcSetup.workspaceState(). Its own load-guard because it answers a
     different question through a different bridge and must not be able to
     block or be blocked by the workspace read beside it. */
  let localModel = null
  let localModelLoadStarted = false
  /* The gate for the widest level. `pending` while the words are on the row and
     nobody has answered; the seg keeps showing the level this computer HOLDS the
     whole time, because nothing has moved. */
  const riskGate = createRiskGate({ via: 'settings' })
  /* What the signed record says about the widest level, when that is the level
     recorded here. null until read; {ok:false} when it could not be read; the
     row states each of those differently and never rounds absence up to
     "confirmed". */
  let consentRecord = null
  let savedIntents = { ...derived().intent }
  const policyDraft = draft && typeof productSettings?.read === 'function' && typeof productSettings?.set === 'function'
    ? createSetupPolicyDraft({ draft, productSettings }) : null
  let profileEdit = 0, policyReadStarted = false, policyKnown = false
  let profileBaseline = derived().answers
  let editorState = null, editorLoadStarted = false, editorLoading = false, editorShowOffers = false
  let editorSelectionText = '', editorSelectedSessionIds
  let editorRoles = []
  const editorDraft = new Map()
  const attachmentChoices = new Map()
  const editorCopyDrafts = new Map()
  let editorPreview = null, editorAttachmentBusy = false, previewTimer = null, previewReading = false
  let attachmentGeneration = 0

  function tier() {
    if (draftTier) return draftTier
    return TIER_IDS.includes(SETUP_RESOLUTION.tier) ? SETUP_RESOLUTION.tier : null
  }

  function derived() {
    return deriveProfile(answers, {
      tier: tier(),
      writeFlagIds: WRITE_FLAG_IDS,
    })
  }

  function effectiveIntents(profile = derived()) {
    return { ...profile.intent, ...(policyDraft ? policyDraft.values(profile.intent) : {}) }
  }

  function intentChoiceAllowed(field, value) {
    const maximum = Math.max(0, field.order.indexOf(ceilingForTier(tier()).intent[field.id]))
    const requested = field.order.indexOf(value)
    return requested >= 0 && requested <= maximum
  }

  function effectiveScreens() {
    return (draft ? draft.value('row:example_mode', isExampleMode()) : isExampleMode()) ? 'demonstration' : 'live'
  }

  function effectiveWriteFlags() {
    return Object.fromEntries(WRITE_FLAG_IDS.map(id => [id,
      draft ? draft.value(`row:write_${id}`, isWriteEnabled(id)) : isWriteEnabled(id)]))
  }

  function stagePreferences(profile, { writeFlags = false, screens = false } = {}) {
    if (writeFlags) {
      const allowed = new Set(ceilingForTier(profile.tier).writeFlags)
      const current = effectiveWriteFlags()
      for (const id of WRITE_FLAG_IDS) {
        const value = writeFlags === 'clamp' ? current[id] && allowed.has(id) : profile.writeFlags[id]
        const key = `row:write_${id}`
        if (value === isWriteEnabled(id)) draft.unstage(key)
        else draft.stage(key, value, next => setWriteEnabled(id, next), { after: ['setup:tier'] })
      }
    }
    if (screens) {
      if (profile.exampleMode === isExampleMode()) draft.unstage('row:example_mode')
      else draft.stage('row:example_mode', profile.exampleMode, next => setExampleMode(next))
    }
  }

  // Settings supplies the shared draft writer; the walkthrough's standalone
  // controller keeps its existing immediate writer.
  function persist(next, { resetIntents = false, intentFields = null, writeFlags = false, screens = false, throwFailure = false } = {}) {
    const previousAnswers = answers
    answers = next
    status = status === 'complete' ? 'complete' : status || 'skipped'
    const record = { status, step: 'review', answers: { ...answers } }
    const profile = derived()
    const generation = ++profileEdit
    const write = async () => {
      const intent = policyDraft ? await policyDraft.committedValues(profile.intent, {
        requireAccount: resetIntents || intentFields?.includes('failover'),
      }) : profile.intent
      const previous = policyDraft ? { ...savedIntents, approvals: intent.approvals, ideImport: intent.ideImport, failover: intent.failover } : savedIntents
      const applied = await applySetupIntentChanges(previous, intent)
      // In Settings each affected preference has its own shared draft key.
      // This last receipt cannot replay a preset over a later explicit edit.
      if (!draft) {
        if (writeFlags) applyProfile({ ...profile, intent }, { setWriteFlag: setWriteEnabled })
        if (screens) setExampleMode(profile.exampleMode)
      }
      const savedAnswers = { ...record.answers, ...intent, screens: effectiveScreens() }
      const saved = writeStoredProfile({ ...record, answers: savedAnswers })
      if (saved === null) throw new Error('The setup profile could not be saved.')
      answers = savedAnswers
      profileBaseline = deriveProfile(savedAnswers).answers
      savedIntents = { ...intent }
      feedback = { tone: applied.deferred.length ? 'warn' : 'good', title: 'Setup settings saved',
        detail: applied.deferred.join(' ') || 'The saved answers and their working policies now agree.' }
      refresh()
      void loadEditorSessions()
    }
    if (policyDraft && stageWrite) {
      // Stage synchronously, before a native policy read yields. A subsequent
      // click in App permissions or What the screens show must stay later.
      stagePreferences(profile, { writeFlags, screens })
      const changes = Object.fromEntries(['approvals', 'ideImport', 'failover']
        .filter(field => resetIntents || (intentFields ? intentFields.includes(field) : next[field] !== previousAnswers[field]))
        .map(field => [field, profile.intent[field]]))
      return policyDraft.stage(changes).then(() => {
        if (generation !== profileEdit || !hostRoot) return
        const comparable = value => JSON.stringify({ ...value, approvals: null, ideImport: null, failover: null })
        if (comparable(profile.answers) === comparable(profileBaseline)
            && !PROFILE_SAVE_DEPENDENCIES.some(key => draft.has(key))) {
          draft.unstage('setup:profile')
          feedback = { tone: 'good', title: 'Setup settings match the saved choices', detail: '' }
          refresh()
          return
        }
        stageWrite('setup:profile', record, write, { after: PROFILE_SAVE_DEPENDENCIES })
        refresh()
      }).catch(error => {
        if (generation !== profileEdit) return
        feedback = { tone: 'serious', title: 'Setup settings could not be staged', detail: error.message }
        refresh()
        if (throwFailure) throw error
      })
    }
    if (stageWrite) stageWrite('setup:profile', record, write)
    else return write().catch(error => {
      feedback = { tone: 'serious', title: 'Setup settings could not be saved', detail: error.message }
      refresh()
      if (throwFailure) throw error
    })
  }

  function segMarkup(target, options, current, label) {
    const tierUnavailable = target === 'tier' && typeof globalThis.mcSetup?.chooseTier !== 'function'
    const controls = controlState({
      enabled: !busy && !tierUnavailable,
      why: busy
        ? 'This section is saving another change.'
        : 'This installed copy cannot change the permission level. Update the app, then try again.',
    })
    /* THE PERMISSION LEVEL IS A SLIDER, NOT A ROW OF BUTTONS, and the axis is
       protection. Owner, 2026-08-26: "a slider; up and down and the higher up
       the more protected the more restricted the agents, at the bottom the
       agents are not at all restricted -- users choice -- we warn them."
       TIER_CHOICES is already ordered most-protected first, so the visual
       column keeps that order: guided sits at the top, unrestricted at
       the bottom, and moving down is visibly moving toward less protection.
       Everything else is unchanged -- same buttons, same data attributes, same
       handler, same writer, same unrestricted risk gate below. A person can
       still tab through it and a screen reader still reads a group of pressed
       buttons, because the slider is how it LOOKS, not a second control.
       Other targets keep the horizontal segment: this shape means "one axis
       from safe to unsafe", and using it for choices that are merely different
       would drain it of that meaning. */
    if (target === 'tier') {
      const rungs = options
      return `<div class="seg settings-seg settings-level-slider" role="group" aria-label="${esc(label)}" data-level-slider>
        <span class="level-slider-cap" aria-hidden="true">More protected</span>
        ${rungs.map(option => `<button type="button" data-setup-profile-set="${esc(target)}" data-setup-profile-value="${esc(option.value)}" aria-pressed="${option.value === current ? 'true' : 'false'}" class="${option.value === current ? 'on' : ''}"${controls.disabled ? ` disabled title="${esc(controls.why)}"` : ''}><span class="level-slider-dot" aria-hidden="true"></span>${esc(option.label)}</button>`).join('')}
        <span class="level-slider-cap" aria-hidden="true">Nothing off limits</span>
      </div>${tierUnavailable ? `<span class="settings-desc">${esc(controls.why)}</span>` : ''}`
    }
    const intent = target.startsWith('intent:') ? intentField(target.slice('intent:'.length)) : null
    const limited = intent && options.some(option => !intentChoiceAllowed(intent, option.value))
    const limitReason = 'This choice is unavailable at the current permission level. Change Permission level above to use it.'
    const disabledAttributes = option => {
      if (controls.disabled) return ` disabled title="${esc(controls.why)}"`
      return intent && !intentChoiceAllowed(intent, option.value) ? ` disabled title="${esc(limitReason)}"` : ''
    }
    return `<div class="seg settings-seg" role="group" aria-label="${esc(label)}">
      ${options.map(option => `<button type="button" data-setup-profile-set="${esc(target)}" data-setup-profile-value="${esc(option.value)}" aria-pressed="${option.value === current ? 'true' : 'false'}" class="${option.value === current ? 'on' : ''}"${disabledAttributes(option)}>${esc(option.label)}</button>`).join('')}
    </div>${limited ? `<span class="settings-desc" data-setup-tier-limit="${esc(intent.id)}">Some choices are unavailable at the current permission level. Change Permission level above to use them.</span>` : ''}`
  }

  function rowMarkup(name, desc, control, id) {
    return `<article class="settings-row" ${id ? `data-setup-profile-row="${esc(id)}"` : ''}>
      <div class="settings-copy">
        <div class="settings-name">${esc(name)}</div>
        <div class="settings-desc">${esc(desc)}</div>
      </div>
      <div class="settings-control">${control}</div>
    </article>`
  }

  function statusMarkup() {
    if (feedback) {
      return `<div class="fleet-profile-status is-${esc(feedback.tone)}" data-setup-profile-status role="${feedback.tone === 'serious' ? 'alert' : 'status'}">
        <strong>${esc(feedback.title)}</strong>
        <span>${esc(feedback.detail)}</span>
      </div>`
    }
    if (status === null) {
      /* BOTH HALVES, IN ONE BREATH, BECAUSE THEY ARE BOTH TRUE AND ONE OF THEM
       * IS THE ONE A PERSON NEEDS.
       *
       * "These are the shipped defaults: nothing that acts is switched on" was
       * printed directly above a permission level reading Unrestricted, whose
       * own row says the assistant "can read, change, and delete any file on
       * this computer and run any program, without asking" -- on a profile that
       * has never walked setup. Neither sentence is wrong. The write switches
       * really are all off, and the level really is the widest one. Read one
       * after the other they contradict each other flatly, and the reassuring
       * one is on top.
       *
       * Whether the shipped default should BE the widest level is a product
       * decision and is not made here. Saying the two things together is a copy
       * fix, and it is this one. */
      return `<div class="fleet-profile-status is-quiet" data-setup-profile-status role="status">
        <strong>${machineCopy('Setup has not been walked through on this computer')}</strong>
        <span>Your current action controls are shown below. The permission level and working folder are separate recorded choices. Setup can be completed here or in the walkthrough.</span>
      </div>`
    }
    if (status === 'skipped') {
      return `<div class="fleet-profile-status is-quiet" data-setup-profile-status role="status">
        <strong>Setup was skipped</strong>
        <span>Your current choices are shown below; they may have changed since setup was skipped. The permission level and working folder are separate recorded choices.</span>
      </div>`
    }
    return `<div class="fleet-profile-status is-good" data-setup-profile-status role="status">
      <strong>${machineCopy('Setup was completed on this computer')}</strong>
      <span>Every row below is what you chose, and every row below is still yours to move.</span>
    </div>`
  }

  /* THE READINESS SUMMARY AND THE DOOR, AND NOTHING ELSE -- the "settings ->
   * setup" pattern this whole file is named for, applied to the one thing
   * setup's review step and this settings row can BOTH honestly say: whether
   * a local runtime is currently answering. The actual install/download
   * controls are NOT here; owner ruling via fleet-B put those on guide.js's
   * PROVIDER_SETUP, the product's one existing "install/sign in to a
   * provider" home, so this row does not become a second, thinner copy of
   * that UI. This is the "door", not a duplicate room. */
  function localModelRowMarkup() {
    const block = localModelReadiness({ local: localModel })
    return `<article class="settings-row fleet-profile-block" data-setup-profile-row="local-model">
      <div class="settings-copy">
        <div class="settings-name">Local models</div>
        <div class="settings-desc">A model already running on your own hardware &mdash; no account, no per-token charge. Installing one and downloading its weights happens in Settings, under &ldquo;This computer&rdquo;.</div>
        <div class="fleet-profile-status ${esc(block.tone)}" data-setup-profile-local-status role="status">
          <strong>${esc(block.heading)}</strong>
          ${block.lines.map(line => `<span>${esc(line)}</span>`).join('')}
        </div>
      </div>
      <div class="settings-control"><a class="ctl-btn" href="${esc(GUIDE_HREF)}">Open This computer</a></div>
    </article>`
  }

  function workspaceRowMarkup() {
    if (workspace === null) {
      return rowMarkup('Working folders', machineCopy('Reading this computer’s configuration…'), '<span class="settings-desc">…</span>', 'workspace')
    }
    if (workspace.available === false) {
      return rowMarkup(
        'Working folders',
        `${setupRefusalDetail(workspace)}`,
        '<span class="settings-desc">unavailable</span>',
        'workspace',
      )
    }
    const roots = workspace.roots || []
    const workspaceControl = controlState({
      enabled: !busy
        && typeof globalThis.mcSetup?.chooseWorkspace === 'function'
        && typeof globalThis.mcSetup?.recordWorkspaces === 'function',
      why: busy
        ? 'This section is saving another change.'
        : 'This installed copy cannot choose and record a working folder. Update the app, then try again.',
    })
    return `<article class="settings-row fleet-profile-block" data-setup-profile-row="workspace">
      <div class="settings-copy">
        <div class="settings-name">Working folders</div>
        <div class="settings-desc">${esc(WORKSPACE_ACCESS_NOTICE)}${workspace.chosen ? '' : ' Nobody has been asked about this yet, so it is the folder setup would have suggested.'}</div>
      </div>
      <div class="fleet-profile-fields">
        ${roots.length
          ? roots.map(path => `<div class="setup-root"><code class="setup-root-path">${esc(path)}</code></div>`).join('')
          : '<p class="fleet-profile-empty">No folder is recorded.</p>'}
        <div class="fleet-profile-actions">
          ${!workspace.chosen && roots.length ? `<button type="button" class="ctl-btn armed" data-setup-profile-action="confirm-folder"${workspaceControl.disabled ? ` disabled title="${esc(workspaceControl.why)}"` : ''}>Use this folder</button>` : ''}
          <button type="button" class="ctl-btn" data-setup-profile-action="choose-folder"${workspaceControl.disabled ? ` disabled title="${esc(workspaceControl.why)}"` : ''}>${roots.length > 1 ? `Replace all ${roots.length} with one folder…` : 'Choose a different folder…'}</button>
        </div>
        ${workspaceControl.disabled && !busy ? `<small>${esc(workspaceControl.why)}</small>` : ''}
      </div>
    </article>`
  }

  function editorSessionsMarkup() {
    const available = typeof globalThis.mcSetup?.editorSessionState === 'function'
    let detail = !available ? 'Open the desktop app to read this computer’s editor sessions.'
      : editorLoading ? 'Checking editor session metadata…'
      : !editorState ? 'Editor sessions have not been checked yet.'
      : !editorState.ok ? setupRefusalDetail(editorState)
      : editorState.discovery === 'not-requested' ? 'New editor sessions are not scanned automatically with this choice.'
      : `${editorState.imported?.length || 0} observed sessions are included. ${editorState.discovery === 'complete' ? 'The bounded discovery completed.' : 'Discovery is incomplete; the list may not include every session.'}`
    const policy = effectiveIntents().ideImport
    const surfaces = editorState?.ok ? editorState.surfaces || [] : []
    const visible = surfaces.filter(surface => surface.imported || policy !== 'none' || editorShowOffers)
    return `<article class="settings-row fleet-profile-block" data-setup-profile-row="editor-sessions">
      <div class="settings-copy"><div class="settings-name">Editor sessions on this computer</div><div class="settings-desc">${esc(detail)} Discovery reads metadata. Watch reads saved user and assistant messages only after you open a session. Your editor keeps control.</div></div>
      <div class="fleet-profile-fields">
        ${visible.map(surface => {
          const imported = editorDraft.has(surface.surface) ? editorDraft.get(surface.surface) : surface.imported
          return `<label class="settings-row settings-check-row"><span>${esc(surface.surface)} · ${surface.sessionCount} session${surface.sessionCount === 1 ? '' : 's'}</span><input type="checkbox" data-editor-surface="${esc(surface.surface)}" ${imported ? 'checked' : ''}></label>`
        }).join('')}
        ${editorState?.ok ? (editorState.importedSurfaces || []).filter(surface => !surfaces.some(row => row.surface === surface)).map(surface => `<label class="settings-row settings-check-row"><span>${esc(surface)} · no recent session observed</span><input type="checkbox" data-editor-surface="${esc(surface)}" ${editorDraft.get(surface) === false ? '' : 'checked'}></label>`).join('') : ''}
        <label>Saved session IDs (optional)<input class="ctl-input" type="text" data-editor-selected-ids aria-label="Saved session IDs" value="${esc(editorSelectionText)}" maxlength="320" placeholder="Paste up to eight IDs, separated by spaces"></label>
        <button class="ctl-btn" type="button" data-setup-profile-action="check-editors" ${!available || editorLoading ? 'disabled' : ''}>Check for editor sessions</button>
        ${editorState?.missingSessionIds?.length ? `<small>${editorState.missingSessionIds.length} requested saved session${editorState.missingSessionIds.length === 1 ? ' was' : 's were'} not found in this account. Check each ID, then choose Check for editor sessions again.</small>` : ''}
        <small>Explicit includes and removals are saved with Save settings and survive later changes to the default import choice.</small>
        ${(editorState?.ok ? editorState.imported || [] : []).map(session => {
          const key = session.sourceRef || `${session.provider}:${session.surface}:${session.sessionId}`
          if (!attachmentChoices.has(key)) attachmentChoices.set(key, savedIntents.attach || 'mirror')
          const mode = attachmentChoices.get(key)
          const copyDraft = editorCopyDraftFor(key)
          const supported = session.receipt && session.capabilities?.[mode] === true
          const unavailable = !session.receipt ? 'The original record could not be verified. Check for sessions again.'
            : mode === 'adopt' ? 'This editor has no verified handoff or exclusive-control agreement with ToolsEnabled. Choose Watch or a supported copy.'
            : mode === 'fork' && !session.capabilities?.fork ? session.forkUnavailableReason : ''
          return `<div class="editor-attachment-session" data-editor-session="${esc(key)}">
            <strong>${esc(session.provider)} · ${esc(session.workspace || session.model || 'Editor conversation')}</strong>
            <small>Session ${esc(session.sessionId || 'unverified')}${session.model ? ` · ${esc(session.model)}` : ''}</small>
            <div class="fleet-profile-actions"><label>Open as <select data-editor-attachment-mode="${esc(key)}" aria-label="How to open ${esc(session.provider)} session ${esc(session.sessionId)}">
              <option value="mirror" ${mode === 'mirror' ? 'selected' : ''}>Watch it only</option>
              <option value="fork" ${mode === 'fork' ? 'selected' : ''}>Continue it in a copy</option>
              <option value="adopt" ${mode === 'adopt' ? 'selected' : ''}>Take it over</option>
            </select></label>
            <button class="ctl-btn" type="button" data-setup-profile-action="open-editor" data-editor-key="${esc(key)}" data-editor-receipt="${esc(session.receipt || '')}" ${!supported || editorAttachmentBusy ? 'disabled' : ''}>${mode === 'mirror' ? 'Watch saved messages' : mode === 'fork' ? 'Prepare copy on tree' : 'Cannot take it over'}</button></div>
            ${mode === 'fork' ? `<label>Role for the copy<select class="ctl-select" data-editor-copy-role="${esc(key)}" aria-label="Role for copied session ${esc(session.sessionId)}"><option value=""${copyDraft.role ? '' : ' selected'}>Worker (default)</option>${editorRoles.map(role => `<option value="${esc(role.id)}"${copyDraft.role === role.id ? ' selected' : ''}>${esc(role.name || role.id)}</option>`).join('')}</select></label>
              <label>First request for the copy<textarea class="ctl-input" data-editor-copy-message="${esc(key)}" aria-label="First request for copied session ${esc(session.sessionId)}" rows="4" maxlength="12000">${esc(copyDraft.message)}</textarea></label>` : ''}
            ${unavailable ? `<small>${esc(unavailable)}</small>` : ''}</div>`
        }).join('')}
        ${(editorState?.imported?.length || 0) ? '<small>Each session starts with the saved attachment choice. Changing its menu applies only to that session. A copy stays as a draft until you press Start on its tree. Codex copies retain the current context; messages from before its latest compaction remain in the original editor.</small>' : ''}
        ${editorPreviewMarkup()}
      </div></article>`
  }

  function editorPreviewMarkup() {
    if (!editorPreview) return '<div data-editor-preview></div>'
    return `<section class="editor-session-preview" data-editor-preview aria-label="Read-only editor conversation">
      <div class="fleet-profile-actions"><strong>Watching saved messages</strong><button class="ctl-btn" type="button" data-setup-profile-action="close-editor-watch">Close watch</button></div>
      <small>${editorPreview.ok ? `${editorPreview.partial ? 'Partial history. ' : ''}Recent user and assistant messages; tool details are omitted. Refreshed every three seconds while this panel is open.` : esc(setupRefusalDetail(editorPreview))}</small>
      <div class="editor-session-messages">${(editorPreview.messages || []).map(message => `<article><strong>${message.role === 'user' ? 'You' : 'Assistant'}</strong><pre>${esc(message.text)}</pre></article>`).join('') || '<p>No supported saved messages were found in the bounded window.</p>'}</div>
    </section>`
  }

  async function refreshEditorPreview(receipt) {
    if (previewReading || !hostRoot?.querySelector?.('[data-editor-preview]')) return
    const generation = attachmentGeneration
    previewReading = true
    try {
      const result = await globalThis.mcSetup.previewEditorSession(receipt)
      if (generation !== attachmentGeneration || !hostRoot) return
      editorPreview = result
    } catch (error) {
      if (generation === attachmentGeneration) editorPreview = { ok: false, reason: error.message }
    } finally { previewReading = false }
    if (generation !== attachmentGeneration) return
    const slot = hostRoot?.querySelector?.('[data-editor-preview]')
    if (slot) slot.outerHTML = editorPreviewMarkup()
    if (editorPreview?.ok !== true) { clearInterval(previewTimer); previewTimer = null }
  }

  async function openEditor(receipt, key) {
    if (editorAttachmentBusy) return
    const mode = attachmentChoices.get(key) || savedIntents.attach || 'mirror'
    const generation = ++attachmentGeneration
    editorAttachmentBusy = true
    feedback = null
    clearInterval(previewTimer); previewTimer = null
    refresh()
    try {
      if (mode === 'mirror') {
        const result = await globalThis.mcSetup.previewEditorSession(receipt)
        if (generation !== attachmentGeneration || !hostRoot) return
        editorPreview = result
        if (generation === attachmentGeneration && hostRoot && editorPreview?.ok) {
          previewTimer = setInterval(() => { void refreshEditorPreview(receipt) }, 3000)
        }
      } else if (mode === 'fork') {
        if (currentDataSource() !== 'local') throw new Error('Switch the fleet from example or remote data to this computer before preparing an editor copy.')
        const prepared = await globalThis.mcSetup.prepareEditorFork(receipt)
        if (!prepared?.ok) throw new Error(setupRefusalDetail(prepared))
        if (generation !== attachmentGeneration || !hostRoot) return
        const queued = editorAttachmentDrafts.queue({ ...prepared, ...editorCopyDraftFor(key) })
        if (!queued.ok) throw new Error(queued.reason)
        navigate('#/computers')
      } else {
        const result = await globalThis.mcSetup.adoptEditorSession()
        throw new Error(setupRefusalDetail(result))
      }
    } catch (error) {
      if (generation === attachmentGeneration) feedback = { tone: 'serious', title: 'The editor session could not be opened', detail: error.message }
    } finally {
      editorAttachmentBusy = false
      if (generation === attachmentGeneration) refresh()
    }
  }

  async function loadEditorSessions(discover = false) {
    if (editorLoading || typeof globalThis.mcSetup?.editorSessionState !== 'function') return
    editorLoading = true
    if (discover) editorShowOffers = true
    try {
      const [sessions, roles] = await Promise.all([
        globalThis.mcSetup.editorSessionState({ discover,
          ...(editorSelectedSessionIds ? { selectedSessionIds: editorSelectedSessionIds } : {}) }),
        Promise.resolve().then(() => globalThis.mcOrg?.read?.()).catch(() => null),
      ])
      editorState = sessions
      editorRoles = roles?.ok && Array.isArray(roles.roles) ? roles.roles : []
    }
    catch (error) { editorState = { ok: false, reason: error.message } }
    policyDraft?.observeEditorState(editorState)
    editorLoading = false
    refresh()
  }

  function editorCopyDraftFor(key) {
    if (!editorCopyDrafts.has(key)) editorCopyDrafts.set(key, {
      role: '', message: 'This is a separate copy of my editor conversation. Wait for my next request.',
    })
    return editorCopyDrafts.get(key)
  }

  function inputEditorSelection(event) {
    const input = event.target.closest?.('[data-editor-selected-ids]')
    if (input && hostRoot?.contains(input)) editorSelectionText = input.value
    const message = event.target.closest?.('[data-editor-copy-message]')
    if (message && hostRoot?.contains(message)) editorCopyDraftFor(message.dataset.editorCopyMessage).message = message.value
  }

  function changeEditorSurface(event) {
    const role = event.target.closest?.('[data-editor-copy-role]')
    if (role && hostRoot?.contains(role)) {
      if (!role.value || editorRoles.some(choice => choice.id === role.value)) editorCopyDraftFor(role.dataset.editorCopyRole).role = role.value
      return
    }
    const choice = event.target.closest?.('[data-editor-attachment-mode]')
    if (choice && hostRoot?.contains(choice)) {
      if (['mirror', 'fork', 'adopt'].includes(choice.value)) attachmentChoices.set(choice.dataset.editorAttachmentMode, choice.value)
      refresh()
      return
    }
    const input = event.target.closest?.('[data-editor-surface]')
    if (!input || !hostRoot?.contains(input)) return
    const surface = input.dataset.editorSurface, imported = input.checked
    editorDraft.set(surface, imported)
    const write = async value => {
      const result = await globalThis.mcSetup?.setEditorSurface?.(surface, value)
      if (result?.ok !== true) return { ok: false, reason: setupRefusalDetail(result, 'The editor import choice could not be saved.') }
      editorDraft.delete(surface)
      await loadEditorSessions(true)
      return result
    }
    if (stageWrite) stageWrite(`setup:editor:${surface}`, imported, write)
    else void write(imported)
  }

  /* THE SWITCHES THIS PROFILE IS LEAVING OFF, EXPLAINED HERE TOO.
   *
   * The walkthrough says this at the moment of choosing; this section is where
   * a person arrives afterwards, which is usually much later and usually
   * because something they expected was not there. Saying it in only one of the
   * two places is how the walkthrough came to be the only screen that knew
   * anything, and this section the one people actually reach.
   *
   * Nothing here turns anything on. It states what is off, what it would give,
   * what it would cost, that it is optional, and where the switch is. */
  function withheldSectionMarkup(profile, currentTier) {
    const off = WRITE_ACTION_FLAGS.filter(flag => !profile.writeFlags[flag.id])
    if (off.length === 0) return ''
    const tierLabel = TIER_CHOICES.find(choice => choice.tier === currentTier)?.label || currentTier
    const refused = new Set(profile.refusedWriteFlags)
    /* SEVEN OF THESE, ALL OPEN, ALL THE TIME.
     *
     * MEASURED on the packaged build: 1,850px of explanation between the last
     * Setup row and the System heading, which pushed three of the page's four
     * groups roughly six screens below the fold. Every other row on this page
     * hides the identical content behind a disclosure -- src/guided-step.js
     * draws it that way everywhere else -- so this run was the one place the
     * page shouted instead of offering.
     *
     * NOT ONE WORD OF IT CHANGED. It is correct and it is worth reading; it is
     * simply not worth reading before you have decided you want to. The summary
     * says how many there are and what they are about, so somebody who does
     * want them knows they are here. */
    return `<details class="settings-section-rows guided-withheld-run" data-setup-profile-withheld>
      <summary class="guided-summary">${off.length} switch${off.length === 1 ? '' : 'es'} currently off, and what each one would give you</summary>
      ${off.map(flag => withheldMarkup(`write_${flag.id}`, {
        label: flag.label,
        reason: refused.has(flag.id)
          /* Not escaped here: withheldMarkup escapes what it is given, and
             escaping twice renders the quotation marks as their own source. */
          ? `It is off because the “${tierLabel}” permission level does not include it. Widening the level in the first row above is what would change that.`
          : 'It is off in your current choices. Its switch is in Settings → App permissions, and the row above sets several of them together.',
      })).join('')}
    </details>`
  }

  /* The record's sentence rides on the tier row's own description, so a person
     reading which level this computer holds reads in the same breath whether
     the risk was ever confirmed for it. Empty for every narrower level. */
  function consentSentence(currentTier) {
    if (!requiresRiskConsent(currentTier)) return ''
    if (consentRecord === null) return ' Reading whether the risk was confirmed for this level…'
    const sentence = describeConsentRecord(consentRecord, { tier: currentTier })
    return sentence ? ` ${machineCopy(sentence)}` : ''
  }

  async function loadConsentRecord() {
    if (!requiresRiskConsent(tier())) return
    if (!globalThis.mcSetup?.tierConsent) {
      consentRecord = { ok: false }
      refresh()
      return
    }
    let result
    try {
      result = await globalThis.mcSetup.tierConsent()
    } catch {
      result = { ok: false }
    }
    consentRecord = result && typeof result === 'object' ? result : { ok: false }
    refresh()
  }

  function accountPolicyRowMarkup() {
    const state = policyDraft.accountState()
    const error = policyDraft.error('failover')
    const description = [
      ACCOUNT_SELECTION_DESCRIPTION,
      state.known ? `Saved default: ${state.label}.` : error,
      /* T1588: the place is named where a person can find it, and the row
         carries the door to it. There is no Accounts page; the menu is on
         Computers, top right. */
      'Provider overrides, detailed ranking, percentage choices, and continuing after a limit are managed in the Accounts menu on Computers.',
      state.known && !state.applicable ? 'Add a provider account in the Accounts menu on Computers before changing this rule.' : '',
      state.known && state.applicable && !state.writable ? 'This installed copy cannot change the rule. Update ToolsEnabled and try again.' : '',
    ].filter(Boolean).join(' ')
    const controls = state.known && state.applicable && state.writable
      ? segMarkup('intent:failover', [
        { value: 'manual', label: 'Use the selected account' },
        { value: 'auto', label: 'Choose accounts automatically' },
      ], effectiveIntents().failover, ACCOUNT_SELECTION_NAME)
      : '<span class="settings-desc">Account selection cannot be changed. The note in this row says why.</span>'
    return rowMarkup(ACCOUNT_SELECTION_NAME, description,
      `${controls}<a class="ctl-btn" href="${ACCOUNTS_MENU_HREF}" data-setup-profile-open-accounts>Open the Accounts menu</a><button type="button" class="ctl-btn" data-setup-profile-action="refresh-account-policy"${busy ? ' disabled' : ''}>Refresh account policy</button>`, 'failover')
  }

  function markup({ searchResult = false } = {}) {
    const profile = derived()
    const effectiveProfile = { ...profile, writeFlags: effectiveWriteFlags() }
    const currentTier = tier()
    const tierChoice = TIER_CHOICES.find(choice => choice.tier === currentTier)
    const autonomy = policyDraft && (!policyKnown || ['approvals', 'ideImport', 'failover'].some(id => policyDraft.error(id))) ? 'unknown' : matchingAutonomy({ tier: currentTier,
      writeFlags: effectiveProfile.writeFlags, intent: effectiveIntents(profile),
      accountApplicable: policyDraft ? policyDraft.accountState().applicable : true, preferred: answers.autonomy })
    const autonomyDescription = (currentTier === 'guided' && ['assisted', 'autonomous'].includes(autonomy)
      ? 'This preset is limited by the current permission level. ToolsEnabled permission questions stop and wait for you; app approval and reply controls stay off.'
      : AUTONOMY_CHOICES.find(choice => choice.value === autonomy)?.detail)
      || (autonomy === 'unknown' ? 'Reading the saved action and consent policies…' : 'Custom action and consent settings. The individual values differ from these Setup presets.')
    return `<section class="settings-section setup-profile-section" data-settings-section="Setup" data-setup-profile-system>
      ${searchResult ? '<div class="settings-prefix">Setup · permission level, folders, and what it may do</div>' : ''}
      <h2 class="settings-section-title">Setup</h2>
      ${statusMarkup()}
      <div class="settings-section-rows">
        ${rowMarkup(
          'Permission level',
          `${machineCopy(tierChoice ? tierChoice.detail : 'How much of this computer an assistant may reach. This is the ceiling for everything below it.')}${consentSentence(currentTier)}`,
          currentTier
            ? segMarkup('tier', TIER_CHOICES.map(choice => ({ value: choice.tier, label: choice.label })), currentTier, 'Permission level')
            : `<span class="settings-desc">${machineCopy('not recorded on this computer')}</span>`,
          'tier',
        )}
        ${riskGate.pending ? unrestrictedRiskMarkup({ id: 'settings-unrestricted-risk', busy: Boolean(busy), declineLabel: `No, keep “${TIER_CHOICES.find(choice => choice.tier === currentTier)?.label || 'the current level'}”` }) : ''}
        ${workspaceRowMarkup()}
        ${rowMarkup(
          'How much it does without asking',
          /* The consequence sentence rides here for the same reason it is on the
             walkthrough: this row is where a person who met the absence arrives
             to fix it, and "nothing that acts" does not tell them that the Start
             control they went looking for is the thing this row removed. It is
             gated on the DERIVED profile, so a level that refused the flag would
             show it too. */
          `${autonomyDescription} These presets cover the action switches and four consent rows in Setup. Notifications remain your separate choice. Switched on${draft?.dirty ? ' in the pending choices' : ' now'}: ${WRITE_ACTION_FLAGS.filter(flag => effectiveProfile.writeFlags[flag.id]).map(flag => flag.label).join(', ') || 'nothing that acts'}.${
            profileCanStartAnAgent(effectiveProfile)
              ? ''
              : ` ${AUTONOMY_CHOICES.find(choice => choice.value === answers.autonomy)?.consequence || 'No control that starts an agent is shown until this is changed.'}`
          }`,
          segMarkup('autonomy', AUTONOMY_CHOICES.map(choice => ({ value: choice.value, label: choice.label })), autonomy, 'How much it does without asking'),
          'autonomy',
        )}
        ${rowMarkup(
          'What the screens show',
          SCREENS_CHOICES.find(choice => choice.value === effectiveScreens())?.detail || '',
          segMarkup('screens', SCREENS_CHOICES.map(choice => ({ value: choice.value, label: choice.label })), effectiveScreens(), 'What the screens show'),
          'screens',
        )}
        ${rowMarkup(
          'The recommended answers, in one press',
          'Sets the two rows above and the four below to what the walkthrough recommends. The permission level is not touched, and full access is never part of this.',
          `<button type="button" class="ctl-btn" data-setup-profile-action="recommended" ${busy ? 'disabled' : ''}>Use recommended answers</button>`,
          'recommended',
        )}
        ${PROFILE_INTENT.map(field => field.id === 'failover' && policyDraft ? accountPolicyRowMarkup() : rowMarkup(
          field.name,
          /* Each row names its actual consumer or current read failure. */
          `${field.desc} ${policyDraft?.error(field.id) || (field.enforced ? INTENT_IN_USE : INTENT_RECORDED_ONLY)}`,
          segMarkup(`intent:${field.id}`, field.order.map(value => ({ value, label: field.labels[value] })), effectiveIntents(profile)[field.id], field.name),
          field.id,
        )).join('')}
        ${editorSessionsMarkup()}
        <article class="settings-row">
          <div class="settings-copy">
            <div class="settings-name">Walk through setup again</div>
            <div class="settings-desc">The same three questions, ending on a page that shows everything they set. The permission level takes effect as soon as you pick it &mdash; that one is needed before the rest of setup can run. Everything else is written when you finish, so leaving partway changes nothing else.</div>
          </div>
          <div class="settings-control"><button type="button" class="ctl-btn" data-setup-profile-action="walkthrough">Open setup</button></div>
        </article>
        ${rowMarkup(
          SANDBOX_SETUP_NAME,
          SANDBOX_SETUP_DESCRIPTION,
          '<button type="button" class="ctl-btn" data-setup-profile-action="walkthrough">Open setup</button>',
          'sandbox-setup',
        )}
        ${localModelRowMarkup()}
      </div>
      <!-- THE BANNER MOVED UP, ABOVE THE COLLAPSED RUN RATHER THAN BELOW IT.
           Three of the Setup rows above are recorded and not yet acted on, and
           they are drawn as segmented controls identical to the working ones
           beside them. The sentence that explains that was roughly 1,900px
           further down, under seven always-open blocks -- so the explanation
           for a control was three screens away from the control. Each row now
           says it itself (INTENT_RECORDED_ONLY, above), and the banner that
           says it once for all of them sits directly under the last of them. -->
      <div class="fleet-profile-status is-warn" role="status">
        <strong>${INTENT_BANNER_TITLE}</strong>
        <span>${INTENT_BANNER_BODY}</span>
        <span>This screen asks for no subscription, key or password for Claude, ChatGPT or Google, and this program stores none. Those stay in their own programs.</span>
        <span>${machineCopy('The account for this computer is its own setting, not one of these.')}</span>
      </div>
      ${withheldSectionMarkup(effectiveProfile, currentTier)}
    </section>`
  }

  /* WHERE THE KEYBOARD GOES AFTER A RISK-GATE PRESS (T1414). The repaint
     replaces the whole section, so the pressed button is gone and nothing had
     the focus. A press that opens the question sends it to the question; an
     answer either way sends it to the lit level once the section is live
     again (a busy repaint disables the rungs, so it waits for the next one). */
  let focusAfterRefresh = null
  const LIT_LEVEL = '[data-setup-profile-set="tier"][aria-pressed="true"]'

  const focus = focusKeeper()
  function refresh() {
    if (!hostRoot) return
    const current = hostRoot.querySelector('[data-setup-profile-system]')
    if (!current) return
    const searchResult = current.querySelector('.settings-prefix') !== null
    /* A control that held the keyboard keeps it across a repaint that redraws
       it: the same setting and value is focused again in the new section. */
    const active = globalThis.document?.activeElement
    const held = active && current.contains?.(active) && active.getAttribute?.('data-setup-profile-set')
      ? `[data-setup-profile-set="${active.getAttribute('data-setup-profile-set')}"][data-setup-profile-value="${active.getAttribute('data-setup-profile-value')}"]`
      : null
    // the pressed choice or switch keeps keyboard focus across the redraw (T1386)
    focus.hold(current)
    current.outerHTML = markup({ searchResult })
    const next = hostRoot.querySelector('[data-setup-profile-system]')
    const target = focusAfterRefresh ? next?.querySelector?.(focusAfterRefresh) : (held ? next?.querySelector?.(held) : null)
    if (target && !target.disabled) {
      focusAfterRefresh = null
      target.focus?.({ preventScroll: true })
    }
    focus.restore(hostRoot.querySelector('[data-setup-profile-system]'))
  }

  async function loadWorkspace() {
    if (loadStarted) return
    loadStarted = true
    if (!globalThis.mcSetup?.workspaceState) {
      workspace = { available: false, reason: 'This page is running in a browser rather than the installed application, so there is no computer here to configure.' }
      refresh()
      return
    }
    let result
    try {
      result = await globalThis.mcSetup.workspaceState()
    } catch (error) {
      result = { ok: false, reason: error?.message || String(error) }
    }
    workspace = result?.ok === false
      ? { available: false, reason: setupRefusalDetail(result) }
      : result
    refresh()
  }

  /* IS A LOCAL MODEL RUNTIME ANSWERING ON THIS COMPUTER -- the live network
     probe localModelReadiness() reads, never a green tick invented here. */
  async function loadLocalModel() {
    if (localModelLoadStarted) return
    localModelLoadStarted = true
    if (!globalThis.mcProviders?.detectLocal) {
      localModel = { known: false }
      refresh()
      return
    }
    let answer
    try {
      answer = await globalThis.mcProviders.detectLocal()
    } catch {
      answer = null
    }
    localModel = answer && answer.ok === true
      ? { known: true, ready: answer.ready === true, selected: answer.selected || null }
      : { known: false }
    refresh()
  }

  async function confirmSuggestedFolder() {
    if (busy) return
    if (typeof globalThis.mcSetup?.recordWorkspaces !== 'function') {
      feedback = { tone: 'serious', title: 'The working folder was not confirmed', detail: 'This installed copy cannot record a working folder. Update the app, then try again.' }
      refresh(); return
    }
    const roots = (workspace && Array.isArray(workspace.roots) ? workspace.roots.slice() : [])
    if (!roots.length) {
      feedback = { tone: 'serious', title: 'No folder to confirm', detail: 'There is no suggested working folder to confirm. Choose one instead.' }
      refresh(); return
    }
    busy = 'folder'; feedback = null; refresh()
    if (stageWrite) {
      stageWrite('setup:workspace', roots, value => globalThis.mcSetup.recordWorkspaces(value))
      workspace = { ...(workspace || {}), available: true, roots, chosen: true }
      busy = null; persist({ ...answers, workspaceRoots: roots })
      feedback = { tone: 'warn', title: 'Working folder is pending', detail: 'Save settings to apply this working folder.' }
      refresh(); return
    }
    let saved
    try { saved = await globalThis.mcSetup.recordWorkspaces(roots) } catch (error) { saved = { ok: false, reason: error?.message || String(error) } }
    busy = null
    if (!saved?.ok) {
      feedback = { tone: 'serious', title: 'That folder was not saved', detail: machineCopy(`${setupRefusalDetail(saved)} Nothing on this computer was changed.`) }
      refresh(); return
    }
    workspace = { ...(workspace || {}), available: true, roots: saved.roots, chosen: true }
    answers = { ...answers, workspaceRoots: saved.roots }
    writeStoredProfile({ status: status || 'skipped', step: 'review', answers })
    feedback = { tone: 'good', title: 'Working folder saved', detail: 'New assistants can use this working folder. Their read and write access still depends on the program and its permission policy.' }
    refresh()
  }

  async function chooseFolder() {
    if (busy) return
    if (typeof globalThis.mcSetup?.chooseWorkspace !== 'function'
        || typeof globalThis.mcSetup?.recordWorkspaces !== 'function') {
      feedback = {
        tone: 'serious',
        title: 'The working folder was not changed',
        detail: 'This installed copy cannot choose and record a working folder. Update the app, then try again.',
      }
      refresh()
      return
    }
    busy = 'folder'
    feedback = null
    refresh()
    let picked
    try {
      picked = await globalThis.mcSetup.chooseWorkspace()
    } catch (error) {
      picked = { ok: false, reason: error?.message || String(error) }
    }
    if (picked?.canceled) { busy = null; refresh(); return }
    if (!picked?.ok) {
      busy = null
      feedback = { tone: 'serious', title: 'That folder cannot be used', detail: setupRefusalDetail(picked) }
      refresh()
      return
    }
    /* WHAT THIS REPLACES, CAPTURED BEFORE IT IS GONE. recordWorkspaces is called
       with a SINGLE-ELEMENT array, so choosing one folder drops every other
       recorded root. The row above is titled "Working folders", lists all of them,
       and the button reads "Choose a different folder" -- so somebody with three
       listed presses it, picks one, and the other two vanish with a success message
       that never mentions them. Their permission has to be reconstructed from
       memory. The replacement is the intended behaviour; saying nothing about it
       was not. */
    const replaced = (workspace && Array.isArray(workspace.roots) ? workspace.roots : [])
      .filter(root => root !== picked.path)
    if (stageWrite) {
      const roots = [picked.path]
      stageWrite('setup:workspace', roots, value => globalThis.mcSetup.recordWorkspaces(value))
      workspace = { ...(workspace || {}), available: true, roots, chosen: true }
      busy = null
      persist({ ...answers, workspaceRoots: roots })
      feedback = { tone: 'warn', title: 'Working folder change is pending', detail: 'Save settings to apply this working folder.' }
      refresh()
      return
    }
    let saved
    try {
      saved = await globalThis.mcSetup.recordWorkspaces([picked.path])
    } catch (error) {
      saved = { ok: false, reason: error?.message || String(error) }
    }
    busy = null
    if (!saved?.ok) {
      feedback = { tone: 'serious', title: 'That folder was not saved', detail: machineCopy(`${setupRefusalDetail(saved)} Nothing on this computer was changed.`) }
      refresh()
      return
    }
    workspace = { ...(workspace || {}), available: true, roots: saved.roots, chosen: true }
    answers = { ...answers, workspaceRoots: saved.roots }
    writeStoredProfile({ status: status || 'skipped', step: 'review', answers })
    feedback = {
      tone: 'good',
      title: replaced.length ? 'Working folder replaced' : 'Working folder saved',
      detail: replaced.length
        ? machineCopy(`New assistants can use this working folder. Their read and write access still depends on the program and its permission policy. `
          + `${replaced.length === 1 ? 'This folder is no longer recorded' : `These ${replaced.length} folders are no longer recorded`}: `
          + `${replaced.join(', ')}. Choose ${replaced.length === 1 ? 'it' : 'them'} again if you still need ${replaced.length === 1 ? 'it' : 'them'}.`)
        : 'New assistants can use this working folder. Their read and write access still depends on the program and its permission policy.',
    }
    refresh()
  }

  /* THE PRESS ON THE WIDEST LEVEL STOPS HERE, EVERY TIME. Nothing is written:
     the words go on the row and the two buttons under them decide what happens
     next. `confirmUnrestricted` is the only way from this function to the disk
     for that level, and it is reached only by the confirm button. A press on
     any narrower level goes straight through, as it always did -- and it also
     closes an open block, because a person who moved to a narrower level has
     answered the question. */
  function requestTier(value) {
    if (busy || !TIER_IDS.includes(value) || value === tier()) return
    const decision = riskGate.request(value)
    if (decision.ask) {
      feedback = null
      focusAfterRefresh = '[data-unrestricted-risk]'
      refresh()
      return
    }
    chooseTier(value, null)
  }

  function confirmUnrestricted() {
    if (busy) return
    const consent = riskGate.confirm()
    if (!consent) return
    focusAfterRefresh = LIT_LEVEL
    chooseTier('unrestricted', consent)
  }

  function declineUnrestricted() {
    if (busy) return
    riskGate.decline()
    const kept = TIER_CHOICES.find(choice => choice.tier === tier())
    feedback = {
      tone: 'good',
      title: 'Full access was not turned on',
      detail: machineCopy(`The permission level stays at “${kept ? kept.label : tier()}”. Nothing on this computer was changed.`),
    }
    focusAfterRefresh = LIT_LEVEL
    refresh()
  }

  async function chooseTier(value, consent) {
    if (busy || !TIER_IDS.includes(value) || value === tier()) return
    if (!globalThis.mcSetup?.chooseTier) {
      feedback = { tone: 'serious', title: 'The permission level was not changed', detail: 'This page is running in a browser rather than the installed application, so there is no computer here to configure.' }
      refresh()
      return
    }
    if (stageWrite) {
      draftTier = value
      stageWrite('setup:tier', value, async next => {
        const result = await globalThis.mcSetup.chooseTier(next, consent)
        if (result?.ok) noteTierRecorded(result.tier || next)
        return result
      })
      persist({ ...answers, ...effectiveIntents() }, { resetIntents: true, writeFlags: 'clamp' })
      feedback = { tone: 'warn', title: 'Permission level change is pending', detail: 'Save settings to apply this level and its derived switches.' }
      refresh()
      return
    }
    busy = 'tier'
    feedback = null
    refresh()
    /* ONE EXIT, AND IT ALWAYS REPAINTS.
     *
     * This body used to clear `busy` in the middle and then return through five
     * separate `refresh()` calls. Measured on the packaged build 2026-08-16: a
     * throw between the disk write and the repaint -- one unbound identifier
     * was enough -- left the machine on its NEW permission level, this row
     * showing the OLD one, and every button in the section painted `disabled`
     * with nothing left to run that could re-enable them. Clearing `busy` early
     * did not help: the flag was already null, so the section was dead only
     * because the DOM still said so, and the next repaint (typing in the
     * settings search) handed back a live control that wrote a further level to
     * disk on every press while still showing the original.
     *
     * So the state is restored and the section repainted in `finally`, for
     * every path including one nobody predicted, and a failure the code did not
     * expect arrives as a sentence rather than as a section that stops
     * answering. */
    try {
      let result
      try {
        /* The consent rides with the level. For the widest level the shell
           refuses without it (SETUP_UNRESTRICTED_UNCONFIRMED), so a screen that
           forgot to ask could not widen anything; for the others it is null. */
        result = await globalThis.mcSetup.chooseTier(value, consent)
      } catch (error) {
        result = { ok: false, reason: error?.message || String(error) }
      }
      if (!result?.ok) {
        feedback = { tone: 'serious', title: 'The permission level was not changed', detail: machineCopy(`${setupRefusalDetail(result)} Nothing on this computer was changed.`) }
        return
      }
      /* WHAT THE LEDGER SAYS ABOUT THIS CHANGE: tierRecordDisposition, read
         off this operation's own answer for the level it recorded, never
         relabelled from the current toggle. For the widest level a
         present-but-refusing ledger never gets this far, because the shell
         refuses the change. The level has moved whatever the record says, and
         the sentence below always begins with that. */
      const recordedNote = TIER_RECORD_NOTE[tierRecordDisposition(result, result.tier ?? value)]
      consentRecord = null
      /* THE MACHINE HAS ALREADY MOVED, so the level this screen believes in
         moves FIRST. Everything below is bookkeeping on top of a record that is
         already the new one; a step that failed with the level unrecorded would
         leave the row naming a level this computer no longer has, which is the
         one thing a permission control may never do. */
      noteTierRecorded(result.tier || value)
      /* Read the flags as they ACTUALLY ARE before the derivation moves them.
         Deriving "before" would be wrong twice over: the ceiling has already
         changed by the time this runs, so a derived before is a derived after;
         and a flag the person turned on by hand in Settings -> Write is not in
         the derivation at all. What was on is a question only storage can
         answer, and storage is not affected by the line above. */
      const wasOn = new Map(WRITE_ACTION_FLAGS.map(flag => [flag.id, isWriteEnabled(flag.id)]))
      /* Re-derive against the NEW ceiling and write the result. A smaller level
         that left the bigger level's switches on would be a level in name only. */
      await persist(answers, { resetIntents: true, writeFlags: 'clamp', throwFailure: true })
      const after = derived()
      const dropped = WRITE_ACTION_FLAGS
        .filter(flag => wasOn.get(flag.id) && !after.writeFlags[flag.id])
        .map(flag => flag.label)
      feedback = dropped.length
        ? { tone: 'warn', title: 'Permission level changed, and some switches went off with it', detail: `${dropped.join(', ')} ${dropped.length === 1 ? 'is' : 'are'} not part of this level, so ${dropped.length === 1 ? 'it was' : 'they were'} turned off.${recordedNote}` }
        : { tone: 'good', title: 'Permission level changed', detail: `Everything below is unchanged; this level permits all of it.${recordedNote}` }
    } catch {
      /* The words carry no identifier and no path, the same rule every other
         refusal in this product keeps: what a person can act on is which level
         this computer now holds and which screen shows the switches. */
      feedback = {
        tone: 'serious',
        title: 'The level changed, and this screen could not finish the change',
        detail: machineCopy('This computer now records the level shown above. The switches below it may not have been brought into line with it. Open Settings → Things it may do for you to check them.'),
      }
    } finally {
      busy = null
      refresh()
      /* After a move to the widest level, read what the ledger now holds so the
         row's sentence is the record's and not this screen's memory of what it
         just did. */
      loadConsentRecord()
    }
  }

  /* ONE PRESS, NO CONSENT SURFACE, and that is the safety argument in full.
     The recommended set covers only the derived answers: autonomy, the
     screens, and the four recorded choices. The permission level -- the one
     row here behind a consent gate -- is not part of RECOMMENDED_ANSWERS and
     is not touched, so this press can never widen what this computer may do:
     deriveProfile re-clamps every switch against the ceiling it already
     holds, exactly as a hand-moved row would be. */
  function applyRecommended() {
    if (busy) return
    const next = answersForAutonomy(RECOMMENDED_ANSWERS.autonomy, { ...answers, screens: RECOMMENDED_ANSWERS.screens })
    feedback = {
      tone: 'good',
      title: draft ? 'Recommended setup answers are pending' : 'Recommended answers applied',
      detail: draft ? 'Save settings to apply the six Setup answers. The permission level stays as chosen.' : 'The six answer rows now hold what the walkthrough recommends. The permission level was not touched.',
    }
    persist(next, { resetIntents: true, writeFlags: true, screens: true })
    refresh()
  }

  function setAnswer(target, value) {
    if (busy) return
    if (target === 'tier') { requestTier(value); return }
    let next = null
    if (target === 'autonomy') {
      if (!AUTONOMY_CHOICES.some(choice => choice.value === value)) return
      next = answersForAutonomy(value, answers)
    } else if (target === 'screens') {
      if (!SCREENS_CHOICES.some(choice => choice.value === value) || value === effectiveScreens()) return
      next = { ...answers, screens: value }
    } else if (target.startsWith('intent:')) {
      const field = intentField(target.slice('intent:'.length))
      if (field?.id === 'failover' && policyDraft && (!policyDraft.accountState().applicable || !policyDraft.accountState().writable)) return
      if (!field || !intentChoiceAllowed(field, value) || value === effectiveIntents()[field.id]) return
      next = { ...answers, [field.id]: value }
    }
    if (!next) return
    feedback = null
    persist(next, { resetIntents: target === 'autonomy', intentFields: target.startsWith('intent:') ? [target.slice('intent:'.length)] : [],
      writeFlags: target === 'autonomy', screens: target === 'screens' })
    refresh()
  }

  function handleClick(event) {
    const setter = event.target.closest('[data-setup-profile-set]')
    if (setter && hostRoot?.contains(setter)) {
      setAnswer(setter.dataset.setupProfileSet, setter.dataset.setupProfileValue)
      return
    }
    if (event.target.closest('[data-unrestricted-confirm]')) { confirmUnrestricted(); return }
    if (event.target.closest('[data-unrestricted-decline]')) { declineUnrestricted(); return }
    const action = event.target.closest('[data-setup-profile-action]')
    if (!action || !hostRoot?.contains(action)) return
    if (action.dataset.setupProfileAction === 'walkthrough') { navigate('#/setup'); return }
    if (action.dataset.setupProfileAction === 'refresh-account-policy') { void policyDraft?.refreshAccounts().then(() => refresh()); return }
    if (action.dataset.setupProfileAction === 'recommended') { applyRecommended(); return }
    if (action.dataset.setupProfileAction === 'check-editors') {
      editorSelectionText = hostRoot?.querySelector('[data-editor-selected-ids]')?.value || ''
      editorSelectedSessionIds = editorSelectionText.trim() ? editorSelectionText.trim().split(/[\s,]+/) : undefined
      void loadEditorSessions(true); return
    }
    if (action.dataset.setupProfileAction === 'open-editor') { void openEditor(action.dataset.editorReceipt, action.dataset.editorKey); return }
    if (action.dataset.setupProfileAction === 'close-editor-watch') {
      attachmentGeneration += 1
      clearInterval(previewTimer); previewTimer = null; editorPreview = null
      refresh(); return
    }
    if (action.dataset.setupProfileAction === 'confirm-folder') { void confirmSuggestedFolder(); return }
    if (action.dataset.setupProfileAction === 'choose-folder') chooseFolder()
  }

  function matches(query) {
    const normalized = String(query || '').trim().toLowerCase()
    if (!normalized) return true
    const haystack = [
      SANDBOX_SETUP_NAME, SANDBOX_SETUP_DESCRIPTION,
      ACCOUNT_SELECTION_NAME, ACCOUNT_SELECTION_DESCRIPTION, policyDraft?.accountState().label || '',
      'setup permission level tier guided standard unrestricted workspace working folder folders autonomy acting on its own how much it does without asking approvals attach adopt fork mirror editor import account failover sign in walkthrough first run screens demonstration live recommended answers one press',
      ...TIER_CHOICES.map(choice => `${choice.label} ${choice.detail}`),
      ...AUTONOMY_CHOICES.map(choice => `${choice.label} ${choice.detail}`),
      ...SCREENS_CHOICES.map(choice => `${choice.label} ${choice.detail}`),
      ...PROFILE_INTENT.flatMap(field => [field.name, field.desc, ...Object.values(field.labels)]),
      ...(workspace?.roots || []),
    ].join(' ').toLowerCase()
    return matchesSettingQuery(normalized, haystack)
  }

  function bind(root) {
    hostRoot = root
    root.addEventListener('click', handleClick)
    root.addEventListener('change', changeEditorSurface)
    root.addEventListener('input', inputEditorSelection)
  }

  function afterRender(root = hostRoot) {
    hostRoot = root
    loadWorkspace()
    loadConsentRecord()
    loadLocalModel()
    if (!editorLoadStarted) { editorLoadStarted = true; void loadEditorSessions() }
    if (policyDraft && !policyReadStarted && root?.querySelector?.('[data-setup-profile-system]')) {
      policyReadStarted = true
      void policyDraft.load().then(() => { policyKnown = true; refresh() }).finally(() => { policyReadStarted = false })
    }
  }

  function destroy() {
    attachmentGeneration += 1
    clearInterval(previewTimer); previewTimer = null
    if (hostRoot) hostRoot.removeEventListener('click', handleClick)
    if (hostRoot) hostRoot.removeEventListener('change', changeEditorSurface)
    if (hostRoot) hostRoot.removeEventListener('input', inputEditorSelection)
    hostRoot = null
  }

  function profileState({ saved = false } = {}) {
    const errors = policyDraft ? ['approvals', 'ideImport', 'failover'].map(id => policyDraft.error(id)).filter(Boolean) : ['The policy controls could not be read from this computer. Press Read saved values to try again.']
    const savedProfile = saved ? deriveProfile(readStoredProfile()?.answers || SAFE_ANSWERS, { tier: SETUP_RESOLUTION.tier, writeFlagIds: WRITE_FLAG_IDS }) : null
    return { tier: saved ? SETUP_RESOLUTION.tier : tier(),
      writeFlags: saved ? Object.fromEntries(WRITE_FLAG_IDS.map(id => [id, isWriteEnabled(id)])) : effectiveWriteFlags(),
      intent: saved ? { ...savedProfile.intent, ...policyDraft?.savedValues() } : effectiveIntents(),
      accounts: policyDraft?.accountState(), ready: policyKnown && errors.length === 0, errors }
  }

  return Object.freeze({ markup, matches, bind, afterRender, destroy,
    profileState,
    async readForProfile() { if (policyDraft) { await policyDraft.load(); policyKnown = true; refresh() } return profileState() },
    async stageWorkingProfile(plan) {
      if (!draft || !policyDraft || !profileState().ready) throw new Error('Read the current Setup policies before applying a working profile.')
      if (plan.tier !== tier()) throw new Error('The permission level changed. Read the profile again before applying it.')
      return persist({ ...answers, ...plan.answers, workspaceRoots: answers.workspaceRoots, screens: answers.screens },
        { resetIntents: true, writeFlags: true, throwFailure: true })
    },
  })
}
