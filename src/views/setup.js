/* First-run setup: choose permissions, a working folder, an optional account
 * and an automation preference, then review the resulting settings.
 * Permission consent is saved on Continue; the other settings are saved on
 * Finish. The view preserves drafts, focus and optional-operation progress
 * across asynchronous reads. Machine reads never imply a successful install.
 */

import { controlState, el, attachSeg } from '../components.js'
import {
  DEFAULT_TIER,
  SETUP_RESOLUTION,
  TIER_CHOICES,
  TIER_IDS,
  TIER_LIMIT_LEAD,
  TIER_LIMIT_NOTICE,
  WORKSPACE_ACCESS_NOTICE,
  TIER_QUESTION,
  TIER_QUESTION_SUB,
  noteTierRecorded,
} from '../setup-state.js'
import { setupAccountStepMarkup } from '../account-markup.js'
import { watchBrowserSignInAddress } from '../account-browser-wait.js'
import { dockerSetupMarkup } from '../setup-docker.js'
import { runDockerSetupAction } from '../setup-docker.js'
/* One reader for "why was that folder refused", shared with the settings screen
   that asks the same question, so the two cannot explain one refusal two ways. */
import { setupRefusalDetail } from '../setup-profile-settings.js'
import { applySetupIntentChanges } from '../setup-intent-commit.js'
import {
  ACCOUNT_QUESTION,
  ACCOUNT_QUESTION_SUB,
  ACCOUNT_SCOPE_LEAD,
  ACCOUNT_SCOPE_NOTICE,
  ACCOUNT_SCOPE_SUBJECT_HERE,
  ACCOUNT_SCOPE_SUBJECT_REMOTE,
  MIN_PASSWORD_LENGTH,
  accountStep,
  loadGoogleAvailability,
} from '../account-state.js'
/* The screens answer lands on ONE switch now: the example toggle owned by
   src/data-source.js, which replaced the seven per-view live flags. */
import { currentDataSource, setExampleMode } from '../data-source.js'
import { WRITE_ACTION_FLAGS, setWriteEnabled } from '../write-flags.js'
import {
  AUTONOMY_CHOICES,
  PROFILE_INTENT,
  RECOMMENDED_ANSWERS,
  SAFE_ANSWERS,
  SCREENS_CHOICES,
  answersForAutonomy,
  applyProfile,
  autonomyStartsAgents,
  deriveProfile,
  intentField,
  profileCanStartAnAgent,
  readStoredProfile,
  resumeStep,
  stepAfter,
  stepBefore,
  writeStoredProfile,
  INTENT_BANNER_BODY,
  INTENT_BANNER_TITLE,
} from '../setup-profile.js'
/* The remedy commands and the per-code sentences, taken from the module that
   owns them rather than restated here. Setup, the home screen and the agent
   page all tell a person how to get Codex working; three hand-written copies of
   a command line is three chances to ship one that does not run. */
/* The decision itself, DOM-free, so the suite drives it rather than reading it. */
import { codexReadiness, localModelReadiness } from '../setup-review-readiness.js'
import { withDeadline } from '../read-deadline.js'
/* WHAT EACH SWITCH GRANTS, WHAT IT RISKS, AND WHAT WAS WITHHELD (owner, R1529).
   The statements are data in src/permission-guidance.js so this screen, the
   settings page and the drawer cannot describe one switch three ways. */
import { guidanceMarkup, withheldMarkup } from '../guided-step.js'
import { probe, refreshCapabilityProbes } from '../capability-probes.js'
/* THE MOMENT OF CHOOSING FULL ACCESS (owner, X4, 2026-08-15). Pressing the
   widest level on this screen does not select it: the risk goes on the glass in
   the Terms' own words and the person is asked; only the confirm button makes
   it the selection Continue will record, and Continue hands the shell the
   consent with the words attached. Same module, same words, same gate as the
   Settings row, so a person meets one sentence in both places. */
import { createRiskGate, requiresRiskConsent, unrestrictedRiskMarkup } from '../unrestricted-consent.js'
/* The one address of the place that explains what this copy needs and installs
   the assistant programs. Read rather than spelled, so this link moves with it. */
import { GUIDE_HREF } from '../first-run-needs.js'

import '../settings.css'
import '../fleet-profile-settings.css'
import '../setup.css'

const esc = value => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

/* One order for navigation and the visible progress indicator. Account sign-in
   is an optional step; the other three choices derive the settings profile. */
const STEPS = Object.freeze(['tier', 'workspace', 'account', 'autonomy', 'review'])
const STEP_LABELS = Object.freeze(['Access', 'Folder', 'Account', 'Actions', 'Review'])
const SETUP_READ_DEADLINE_MS = 10_000

/* THE WALK THE PERSON IS IN RIGHT NOW, held for the life of the PAGE rather
 * than of one view instance. Null whenever no walk is open.
 *
 * `resumeStep` reads the stored profile and the recorded tier, and both of
 * those are ANSWERS THAT ARRIVE LATE: the tier is recorded by an await inside
 * commit(), and the router can re-mount this view while that await is in
 * flight (measured 2026-08-19 -- the checkout probe's settle event re-entered
 * render() over '#/setup' and the surviving copy opened on question 1 while
 * the person's copy stood at the review, until the retirement timer removed
 * it). A re-mount inside one page is not a returning visitor; it is the same
 * person, mid-walk, and their current step is the truth. So every move the
 * walk makes records itself here, the next mount in the same page adopts it,
 * and finishing or skipping clears it. Disk state still decides everything on
 * the NEXT launch, where this record no longer exists -- so the measured
 * resume-at-exact-step behaviour from Settings -> "Open setup" is unchanged. */
let liveWalk = null

const WRITE_FLAG_IDS = WRITE_ACTION_FLAGS.map(flag => flag.id)

export function setupView({ navigate = hash => { location.hash = hash } } = {}) {
  const state = SETUP_RESOLUTION
  const initiallyConfigured = liveWalk?.initiallyConfigured ?? state.configured
  let chosen = TIER_IDS.includes(state.tier) ? state.tier : DEFAULT_TIER
  let busy = false
  /* The gate for the widest level, and the consent it produced. `consent` is
     non-null ONLY after the person pressed confirm on this screen for the
     level `chosen` now names; every other move clears it. Continue sends it to
     the shell, which refuses the widest level without it -- so a walkthrough
     that somehow skipped the words could not widen anything. */
  const riskGate = createRiskGate({ via: 'setup' })
  let consent = null
  /* Non-null only when the app cannot record an answer, or a save failed. The
     screen still renders the question in that case -- a reader is entitled to
     see what the levels ARE even where this copy cannot set one -- but the
     button is disabled and says why, rather than failing on click. */
  let refusal = state.available ? null : { code: state.code, reason: state.reason }
  /* Read back from the stored profile so somebody who finishes setup, leaves
     and returns still meets it. A notice only the finishing render could show
     would be gone the instant they navigated -- which is exactly where the
     original defect hid. */
  let assistantConfigFailure = readStoredProfile()?.assistantConfig || null
  let undoUnavailable = readStoredProfile()?.undoUnavailable || null
  /* Restored beside its two siblings for the same reason they are: the fact
     belongs to the machine, not to this mount. See src/setup-profile.js. */
  let accountPolicyDeferred = readStoredProfile()?.accountPolicyDeferred || null

  const stored = readStoredProfile()
  /* RECOMMENDED_ANSWERS is what the walkthrough OFFERS a person who is
     answering; skip() below applies SAFE_ANSWERS to a person who is not. Since
     the owner's Basic direction (2026-09-20, T782) both are the Basic answers
     -- autonomous within the permission level -- and they are kept as two
     constants so the runtime owner can still let them differ. Preselecting
     the answer that switches nothing on is how the recommended path once
     ended at a product with no control that starts anything. */
  let answers = stored ? stored.answers : { ...RECOMMENDED_ANSWERS, workspaceRoots: [] }
  let step = resumeStep(stored, { tierRecorded: state.configured, steps: STEPS })
  if (liveWalk && STEPS.includes(liveWalk.step)) {
    step = liveWalk.step
    answers = liveWalk.answers
  }
  /* The workspace facts come from the shell, so until they arrive the step says
     it is loading rather than showing an empty folder list that looks like an
     answer. `null` means "not asked for yet", which is distinct from a reply
     that came back unavailable. */
  let workspace = null
  let workspaceBusy = false
  let workspaceRefusal = null

  /* WHETHER AN AGENT CAN ACTUALLY RUN WHEN THIS FINISHES, which setup used not
   * to ask at any point.
   *
   * Setup configured a permission level, a folder and an account, said "Finish
   * setup", and handed the person a home screen reading "Not ready yet -- sign
   * in to Codex on this computer". Nothing in the walkthrough had mentioned
   * Codex, and nothing anywhere in the product said how to get it. A setup that
   * completes successfully and lands on a blocker it never named is a setup that
   * is not finished, whatever it says on the button.
   *
   * `null` means "not asked yet", the same convention the two states above use.
   * It is READ ONLY -- setup does not install anything and does not gate Finish
   * on the answer, because the recorded level, the folder and the account are all
   * still worth saving on a machine where Codex is not installed yet. It tells
   * the person what remains and lets them finish. */
  let agentReadiness = null
  /* What THIS COMPUTER has, per assistant program, from mcProviders.presence().
     null while unasked; `known:false` when it could not be asked, which the
     review says out loud rather than rounding to a tick. */
  let codexPresence = null
  /* THE SAME QUESTION, FOR A MODEL ON THIS COMPUTER'S OWN HARDWARE -- a
     separate read from mcProviders.detectLocal() rather than a field bolted
     onto codexPresence, because it answers a different question (a live
     network probe, never a PATH/npm check) through a different bridge verb.
     Same convention: null while unasked, `known:false` when it could not be
     asked. READ-ONLY, exactly like codexPresence -- this screen never installs
     anything for either. */
  let localModelPresence = null
  let readinessBusy = false

  /* The sign-in step's own state. `null` means "not asked yet", which is
     distinct from a reply that came back unavailable -- painting an empty form
     during the read would show "create an account" to somebody who has one.
     No password is ever held here; see submitAccount(). */
  const account = accountStep()
  let accountState = null
  let accountBusy = false
  let accountNotice = null
  let accountMode = 'sign-in'
  let accountPicked = false
  /* Whether this copy can sign in with Google. `null` is "not asked yet",
     which the step renders differently from "not available" -- see
     googleOptionMarkup(). */
  let accountGoogle = null
  let accountBrowserSignIn = null
  let stopAccountBrowserWait = null
  function beginAccountBrowserSignIn(provider) {
    endAccountBrowserSignIn()
    const attempt = { provider, canCancel: account.canCancelSignIn, address: null }
    accountBrowserSignIn = attempt
    stopAccountBrowserWait = watchBrowserSignInAddress({ bridge: account, onAddress(address) {
      if (destroyed || accountBrowserSignIn !== attempt) return
      attempt.address = address
      if (step === 'account') paint()
    } })
  }
  function endAccountBrowserSignIn() {
    stopAccountBrowserWait?.()
    stopAccountBrowserWait = null
    accountBrowserSignIn = null
  }

  const root = el(`<div class="view-pad setup-page">
    <div class="settings-shell setup-shell">
      <section class="settings-section setup-section" data-setup-section></section>
    </div>
  </div>`)
  const section = root.querySelector('[data-setup-section]')
  let segCleanups = []
  let destroyed = false
  let sandboxPanel = null

  /* Setup can be read at the desk or through the relay. These are facts about
     the machine whose bridge answers the questions, not facts about the
     browser holding this view. Keep that subject decision on the render pass,
     beside the controls and copy it governs. */
  const machineSubject = () => currentDataSource() === 'relay'
    ? 'the computer you are driving'
    : 'this computer'

  // Native buttons make the whole choice usable with a pointer or keyboard.
  // The widest level still passes through the shared explicit consent gate.
  function choiceMarkup(choice, lit = chosen) {
    return `<button type="button" class="setup-choice-card" data-setup-choice="${esc(choice.tier)}" data-setup-tier="${esc(choice.tier)}" aria-disabled="${busy ? 'true' : 'false'}" aria-pressed="${choice.tier === lit ? 'true' : 'false'}" ${busy ? 'disabled' : ''}>
      <span class="setup-choice-mark" aria-hidden="true"></span>
      <span class="settings-copy">
        <span class="settings-name">${esc(choice.label)}${choice.note ? ` <span class="setup-badge">${esc(choice.note)}</span>` : ''}</span>
        <span class="settings-desc">${esc(choice.detail)}</span>
      </span>
    </button>`
  }

  /* is-warn, not is-serious: the enforcement gap is a real limit on what the
     level does and the reader must weigh it, but it is a stated property of a
     working product, not a fault in this installation. A save that FAILED is
     is-serious, because that one is broken. */
  function disclosureMarkup() {
    if (refusal) {
      return `<div class="fleet-profile-status is-serious" data-setup-status role="alert">
        <strong>${esc(refusal.title || 'This copy cannot record a permission level')}</strong>
        <span>${esc(setupRefusalDetail(refusal))}</span>
      </div>`
    }
    return `<details class="setup-disclosure" data-setup-details="permissions">
      <summary>How these permissions work</summary>
      <div class="fleet-profile-status" data-setup-status>
      <strong>${esc(TIER_LIMIT_LEAD)}</strong>
      ${TIER_LIMIT_NOTICE.map(paragraph => `<span>${esc(paragraph)}</span>`).join('')}
      </div>
    </details>`
  }

  function markup() {
    /* WHILE THE QUESTION IS OPEN the seg lights the button that was pressed,
       because on this screen the seg is a selection in progress and that is
       what was pressed; `chosen` -- the level Continue would record -- has not
       moved, and declining puts the light back where it was. (The Settings row
       does the opposite, and rightly: its seg shows the level the machine
       HOLDS, and nothing has moved there either.) */
    const lit = riskGate.pending || chosen
    return `<h1 class="setup-title">${esc(TIER_QUESTION)}</h1>
      <p class="setup-lede">${esc(TIER_QUESTION_SUB)}</p>
      <div class="setup-choices" role="group" aria-label="Permission level">
        ${TIER_CHOICES.map(choice => choiceMarkup(choice, lit)).join('')}
        ${riskGate.pending ? unrestrictedRiskMarkup({ id: 'setup-unrestricted-risk', busy, declineLabel: `No, keep “${TIER_CHOICES.find(choice => choice.tier === chosen)?.label || 'the safer level'}”` }) : ''}
      </div>
      ${disclosureMarkup()}
      <div class="setup-actions">
        ${riskGate.pending || refusal ? '' : `<button type="button" class="setup-skip" data-setup-skip-first ${busy ? 'disabled' : ''}>${esc(skipLabel())}</button>`}
        <span class="setup-actions-spacer"></span>
        <button type="button" class="ctl-btn" data-setup-continue ${!state.available || busy || riskGate.pending ? 'disabled' : ''}>${busy ? 'Saving…' : refusal && state.available ? 'Try again' : 'Continue'}</button>
    </div>`
  }

  function paint() {
    if (destroyed) return
    // Replacing the view must not close an expanded review or drop keyboard
    // focus when an independent readiness check finishes.
    const openDetails = [...section.querySelectorAll('[data-setup-details][open]')]
      .map(item => item.getAttribute('data-setup-details'))
    sandboxPanel = section.querySelector('[data-setup-sandbox]') || sandboxPanel
    const active = globalThis.document?.activeElement
    const focusedDetail = active?.tagName === 'SUMMARY' ? active.parentElement?.getAttribute('data-setup-details') : null
    const headingFocused = active?.classList?.contains('setup-title') === true
    // A busy/refused account action must not erase the name fields being typed.
    // Before submit, retain the password for late Google paints; while busy,
    // exclude it so the action repaint clears the secret immediately.
    const formValues = step === 'account'
      ? [...section.querySelectorAll('[data-setup-account-field]')]
        .filter(input => !accountBusy || input.getAttribute('data-setup-account-field') !== 'password')
        .map(input => [input.getAttribute('data-setup-account-field'), input.value])
      : []
    const selection = active && Number.isInteger(active.selectionStart)
      ? [active.selectionStart, active.selectionEnd] : null
    const focusKeys = active && section.contains?.(active)
      ? (active.getAttributeNames?.() || []).filter(name => name.startsWith('data-'))
        .map(name => [name, active.getAttribute(name)])
      : []
    releaseSegs()
    section.innerHTML = `${progressMarkup()}${step === 'tier' ? markup() : stepMarkup()}`
    const nextSandbox = section.querySelector('[data-setup-sandbox]')
    if (nextSandbox && sandboxPanel) nextSandbox.replaceWith(sandboxPanel)
    for (const detail of section.querySelectorAll('[data-setup-details]')) {
      if (openDetails.includes(detail.getAttribute('data-setup-details'))) detail.open = true
      if (focusedDetail === detail.getAttribute('data-setup-details')) detail.querySelector('summary')?.focus({ preventScroll: true })
    }
    for (const input of section.querySelectorAll('[data-setup-account-field]')) {
      const previous = formValues.find(([name]) => name === input.getAttribute('data-setup-account-field'))
      if (previous) input.value = previous[1]
    }
    wireSegs()
    if (focusKeys.length) {
      const replacement = [...section.querySelectorAll('button, input, summary, a')]
        .find(item => focusKeys.every(([name, value]) => item.getAttribute(name) === value))
      replacement?.focus({ preventScroll: true })
      if (replacement && selection) { try { replacement.setSelectionRange(...selection) } catch { /* Some input types have no text selection. */ } }
      /* THE PRESSED CONTROL IS GONE (T1587). 'Use this folder' removes itself
         once the folder is accepted, so there is no replacement and focus fell
         to the page: the one press in the wizard that lost the person's place.
         Focus goes on to the step's way forward, or its heading. */
      if (!replacement) {
        const onward = [...section.querySelectorAll('button')]
          .find(item => (item.hasAttribute('data-setup-next') || item.hasAttribute('data-setup-continue')) && !item.disabled && !item.hasAttribute('disabled'))
        const heading = section.querySelector('.setup-title')
        if (onward) onward.focus({ preventScroll: true })
        else if (heading) { heading.setAttribute('tabindex', '-1'); heading.focus({ preventScroll: true }) }
      }
    } else if (headingFocused) {
      const heading = section.querySelector('.setup-title')
      heading?.setAttribute('tabindex', '-1')
      heading?.focus({ preventScroll: true })
    }
  }

  /* The selection is local until Continue. Someone comparing the three options
     by clicking between them has not decided anything yet, and writing a
     configuration on every click would record levels nobody chose. */
  function select(tier) {
    if (busy || !TIER_IDS.includes(tier)) return
    if (requiresRiskConsent(tier)) {
      /* Not selected yet. The words go on the glass and the two buttons under
         them decide; a second press on the same button while the question is
         open changes nothing. Asked EVERY time, whatever this screen or the
         ledger remembers -- that is clause four of the ruling. */
      if (riskGate.pending === tier) return
      riskGate.request(tier)
      paint()
      focusAfterRiskPress('[data-unrestricted-risk]')
      return
    }
    /* A narrower press answers an open question with "no" and clears any
       consent that was given for the widest level: what Continue records is
       always the level that is lit, with the consent that belongs to it. */
    const wasAsking = riskGate.pending !== null
    riskGate.clear()
    consent = null
    if (tier === chosen && !wasAsking) return
    chosen = tier
    paint()
  }

  function confirmUnrestricted() {
    if (busy) return
    const given = riskGate.confirm()
    if (!given) return
    consent = given
    chosen = 'unrestricted'
    paint()
    focusAfterRiskPress(`[data-setup-tier="${chosen}"]`)
  }

  function declineUnrestricted() {
    if (busy) return
    riskGate.decline()
    consent = null
    paint()
    focusAfterRiskPress(`[data-setup-tier="${chosen}"]`)
  }

  /* A PRESS NEVER LEAVES THE KEYBOARD ON THE PAGE BODY (T1414; the rule
     src/account-switcher.js states). Each of these presses repaints away the
     button that was pressed, so paint()'s own restore finds nothing: the
     question takes the focus when it opens, and the lit level card when it is
     answered either way. */
  function focusAfterRiskPress(selector) {
    section.querySelector(selector)?.focus?.({ preventScroll: true })
  }

  async function commit() {
    if (busy || !state.available || riskGate.pending) return
    /* The widest level leaves this screen only with the words attached. If it
       is somehow the selection with no consent behind it -- this branch should
       be unreachable, and the shell refuses it anyway -- ask, rather than send
       a choice nobody confirmed. A machine that ALREADY holds the widest level
       is the one exception: re-recording the level it has is not enabling it,
       and the shell treats it the same way. */
    if (requiresRiskConsent(chosen) && !consent?.confirmed && state.tier !== chosen) {
      riskGate.request(chosen)
      paint()
      return
    }
    busy = true
    refusal = null
    paint()
    let result
    try {
      result = await globalThis.mcSetup.chooseTier(chosen, consent)
    } catch (error) {
      result = { ok: false, reason: error?.message || String(error) }
    }
    busy = false
    if (result?.ok) {
      noteTierRecorded(result.tier || chosen)
      /* The level is the ONLY thing this walkthrough writes before the end, and
         only because the first-run gate is built on it. Advancing to the folder
         question rather than into the app is the change the owner asked for:
         before this, step 1 was the whole of setup. */
      goTo('workspace')
      return
    }
    refusal = {
      title: 'That level was not saved',
      code: result?.code || 'MC_SETUP_SAVE_FAILED',
      reason: setupRefusalDetail(result, `The application did not say why. Nothing on ${machineSubject()} was changed.`),
    }
    paint()
  }

  /* SKIP, FROM THE VERY FIRST SCREEN, IN ONE PRESS. Skip used to appear only
   * after the level question was answered, so leaving early was two decisions
   * and a wait. It cannot simply leave: with no level recorded the first-run
   * gate bounces straight back to this screen (src/main.js, shouldOpenSetup),
   * which is a trap wearing a skip button. So the press records the level that
   * is LIT -- for a person who decided nothing, the preselected narrowest one
   * -- and then applies the Basic answers (SAFE_ANSWERS), which are what a
   * copy that never ran setup does anyway.
   *
   * NO CONSENT SURFACE IS PASSED. Only the widest level carries one, and the
   * lit level can only BE the widest after its words were answered on this
   * screen (`consent` is non-null exactly then); while the question is OPEN
   * the button is not rendered at all. The shell refuses the widest level
   * without consent besides. */
  async function skipFromFirstQuestion() {
    if (busy || refusal || riskGate.pending) return
    if (state.configured) { skip(); return }
    busy = true
    paint()
    let result
    try {
      result = await globalThis.mcSetup.chooseTier(chosen, consent)
    } catch (error) {
      result = { ok: false, reason: error?.message || String(error) }
    }
    busy = false
    if (!result?.ok) {
      refusal = {
        title: 'That level was not saved',
        code: result?.code || 'MC_SETUP_SAVE_FAILED',
        reason: setupRefusalDetail(result, `The application did not say why. Nothing on ${machineSubject()} was changed.`),
      }
      paint()
      return
    }
    noteTierRecorded(result.tier || chosen)
    skip()
  }

  /* ---------- the derived profile, recomputed rather than cached ---------- */

  function derived() {
    return deriveProfile(answers, {
      tier: recordedTier(),
      writeFlagIds: WRITE_FLAG_IDS,
    })
  }

  function recordedTier() {
    return TIER_IDS.includes(SETUP_RESOLUTION.tier) ? SETUP_RESOLUTION.tier : chosen
  }

  /* ---------- step chrome ---------- */

  function progressMarkup() {
    const index = STEPS.indexOf(step)
    return `<header class="setup-header">
      <span class="setup-brand">ToolsEnabled <span>Setup</span></span>
      <span class="setup-progress" data-setup-progress>Step ${index + 1} of ${STEPS.length}</span>
    </header>
    <ol class="setup-steps" aria-label="Setup progress">
      ${STEPS.map((id, position) => `<li class="${position < index ? 'is-complete' : ''}" ${id === step ? 'aria-current="step"' : ''}>
        <span class="setup-step-number" aria-hidden="true">${position < index ? '✓' : position + 1}</span>
        <span>${STEP_LABELS[position]}${id === 'account' ? '<small>Optional</small>' : ''}</span>
      </li>`).join('')}
    </ol>`
  }

  /* ONE LABEL, THREE SITES. The word this control shows depends on what a press
     would actually do, and the three places it is drawn must never disagree
     about that. On a configured profile the first press only arms; the second
     is the one that resets, and the armed words say so plainly rather than
     asking a question. */
  /* Armed by the first press of the skip control on a configured profile; the
     second press is the one that resets. Reset on any other interaction below,
     so an arming press left behind by a change of mind never fires later. */
  let skipArmed = false

  /* On a configured profile the control RESETS the answers to the Basic ones
     and drops a hand-picked folder, so its label says that, and the armed
     label names the reset rather than asking "are you sure". */
  function skipLabel() {
    if (!initiallyConfigured) return 'Skip the rest for now'
    return skipArmed
      ? 'Press again to reset to the Basic answers'
      : 'Reset to the Basic answers'
  }

  function actionsMarkup({ back = null, next = null, nextLabel = 'Continue', nextDisabled = false, nextReason = null, skip = true } = {}) {
    const nextControl = next ? controlState({
      enabled: !busy && !nextDisabled,
      why: busy ? 'Setup is saving.' : nextReason,
    }) : null
    return `<div class="setup-actions">
      ${skip ? `<button type="button" class="setup-skip" data-setup-skip>${esc(skipLabel())}</button>` : ''}
      <span class="setup-actions-spacer"></span>
      ${back ? `<button type="button" class="ctl-btn" data-setup-back="${esc(back)}" ${busy ? 'disabled' : ''}>Back</button>` : ''}
      ${next ? `<button type="button" class="ctl-btn" data-setup-next="${esc(next)}"${nextControl.disabled ? ` disabled title="${esc(nextControl.why)}"` : ''}>${esc(nextLabel)}</button>` : ''}
    </div>`
  }

  function stepMarkup() {
    if (step === 'workspace') return workspaceMarkup()
    if (step === 'account') return accountMarkup()
    if (step === 'autonomy') return autonomyMarkup()
    return reviewMarkup()
  }

  /* ---------- step 3: signing in ----------
   *
   * docs/design/INSTALLER-EXPERIENCE.md section 3 step 6. It is HERE rather
   * than behind a link from the end, because a walkthrough that finishes with
   * "now go and find the account screen" is the one-way door this design
   * forbids. The same screen also lives at #/account for every later visit;
   * one screen, two entry points.
   *
   * IT FAILS OPEN, exactly like the folder question. No bridge, an unreadable
   * account file, or a refused sign-in all leave Continue working. Signing in
   * is not a wall: a person who skips it is signed out, which is an honest
   * working state, and their assistant's records say `unauthenticated` rather
   * than naming somebody who never signed in.
   *
   * NOTHING HERE TOUCHES `answers`. That object is serialised to localStorage
   * and rendered on the review page, so a password reaching it would be written
   * to disk in the clear. The account is its own durable state, written by the
   * shell at the moment of sign-in, and the only thing this step ever reads
   * back is a display name. */

  /* The step's markup lives in src/account-markup.js, called rather than
     inlined. This file imports three stylesheets and touches the DOM, so no
     test can render it -- and a plant proved what that costs: accountMarkup()
     could return an empty string, and the scope notice could be deleted
     outright, with the entire suite still green. That notice is the
     SHIPMENT-PLAN B14 disclosure, on the screen where a first-time user
     creates an account. The builder is now callable, so both defects die.

     The action bar is rendered HERE and passed in: the walkthrough owns which
     step comes next, and the builder has no business knowing. */
  function accountMarkup() {
    const back = stepBefore(STEPS, 'account')
    const next = stepAfter(STEPS, 'account')
    const subject = machineSubject() === 'the computer you are driving'
      ? ACCOUNT_SCOPE_SUBJECT_REMOTE
      : ACCOUNT_SCOPE_SUBJECT_HERE
    if (accountState === null) return setupAccountStepMarkup({ accountState, actions: actionsMarkup({ back, next, nextLabel: 'Not now' }), subject })
    if (!accountState.available || accountState.signedIn) {
      return setupAccountStepMarkup({ accountState, actions: actionsMarkup({ back, next }), subject })
    }
    return setupAccountStepMarkup({
      accountState,
      google: accountGoogle,
      browserSignIn: accountBrowserSignIn,
      mode: accountMode,
      busy: accountBusy,
      notice: accountNotice,
      subject,
      actions: `<div class="setup-actions">
        <button type="button" class="setup-skip" data-setup-skip>${esc(skipLabel())}</button>
        <span class="setup-actions-spacer"></span>
        <button type="button" class="ctl-btn" data-setup-account-mode="${accountMode === 'create' ? 'sign-in' : 'create'}" ${accountBusy ? 'disabled' : ''}>${accountMode === 'create' ? 'I already have one' : 'Create an account'}</button>
        <button type="button" class="ctl-btn" data-setup-back="${esc(back)}" ${accountBusy ? 'disabled' : ''}>Back</button>
        <button type="button" class="ctl-btn" data-setup-next="${esc(next)}" ${accountBusy ? 'disabled' : ''}>Not now</button>
        <button type="button" class="ctl-btn" data-setup-account-submit="${accountMode === 'create' ? 'create' : 'sign-in'}" ${accountBusy ? 'disabled' : ''}>${accountBusy ? 'Working…' : accountMode === 'create' ? 'Create and continue' : 'Sign in and continue'}</button>
      </div>`,
    })
  }
  async function loadAccount() {
    accountState = await account.load()
    if (destroyed) return
    /* A computer with no account opens on "create"; one that already has
       accounts opens on "sign in". Only on the first read -- after that the
       person's own choice of form stands. */
    if (!accountPicked && accountState.available && accountState.accountCount === 0) accountMode = 'create'
    accountPicked = true
    if (step === 'account') paint()
    /* Asked AFTER the step can paint, so the walkthrough never waits on it.
       Only while signed out: a person who is already signed in is not being
       offered a way to sign in. */
    if (accountState.signedIn) return
    accountGoogle = await loadGoogleAvailability()
    if (destroyed) return
    if (step === 'account') paint()
  }

  /* SIGN IN WITH GOOGLE, inside the walkthrough.
   *
   * The same call the account screen makes, and the same rule: nothing is sent
   * from this page, and every failure lands SIGNED OUT with the shell's own
   * sentence. It does not advance the walkthrough on a failure and it does not
   * fall back to the password form on the person's behalf -- the form is
   * already on screen underneath, for them to choose. */
  async function startGoogleSignIn(localProfile = false) {
    if (accountBusy) return
    accountBusy = true
    accountNotice = null
    beginAccountBrowserSignIn('google')
    paint()
    let result
    try { result = await (localProfile ? account.googleLocalProfile() : account.googleSignIn()) } catch { result = { ok: false, reason: 'The application did not answer.' } }
    endAccountBrowserSignIn()
    if (destroyed) return
    accountBusy = false
    if (!result || result.ok !== true) {
      accountNotice = (result && result.reason) || 'The Google sign-in did not complete, so nobody was signed in.'
      await loadAccount()
      if (destroyed) return
      paint()
      return
    }
    accountNotice = null
    await loadAccount()
    if (destroyed) return
    paint()
  }

  /**
   * Create or sign in, then move on.
   *
   * The password is read from the field at the moment this runs, handed to the
   * shell, and the field is cleared on EVERY outcome -- a refused password left
   * sitting in the input is a password left in the DOM of a window somebody may
   * walk away from. Neither value is ever assigned to anything that outlives
   * this function.
   */
  async function submitAccount(kind) {
    if (accountBusy) return
    const usernameField = section.querySelector('[data-setup-account-field="username"]')
    const passwordField = section.querySelector('[data-setup-account-field="password"]')
    /* Only rendered on the create form, so it is absent on sign-in -- and absent
       there is not an empty answer, it is no question asked. Either way what is
       handed to the shell is a string, and the shell is the one place that
       decides what an empty one means. */
    const displayNameField = section.querySelector('[data-setup-account-field="displayName"]')
    const username = usernameField ? usernameField.value : ''
    const password = passwordField ? passwordField.value : ''
    const displayName = displayNameField ? displayNameField.value : ''

    /* An @ suggests an email address, but does not prove a ToolsEnabled
       account. Keep this local: do not invoke account.create and do not
       authenticate on the person's behalf. */
    if (kind === 'create' && username.includes('@')) {
      accountMode = 'sign-in'
      accountNotice = {
        tone: 'warn',
        title: 'Sign in with your email',
        detail: 'To sign in with an email address, use the sign-in form below.',
      }
      if (passwordField) passwordField.value = ''
      paint()
      return
    }

    accountBusy = true
    accountNotice = null
    if (kind !== 'create' && username.includes('@')) beginAccountBrowserSignIn('password')
    paint()

    let result
    if (kind === 'create') {
      /* The name the person typed, not a hardcoded empty string. Passing '' made
         the username the permanent label on their records: the walkthrough never
         asked, and nothing anywhere could change it afterwards. The field above
         asks; changeDisplayName in shell/product-account.cjs is what makes it
         changeable later, and the field's own copy promises exactly that. */
      result = await account.create({ username, displayName, password })
      /* Created and then signed in, as one action from the person's point of
         view. Making them retype the password they just chose, inside their own
         first run, is friction that buys nothing. */
      if (result.ok) result = await account.signIn({ username, password })
    } else {
      result = await account.signIn({ username, password })
    }
    endAccountBrowserSignIn()
    if (destroyed) return

    accountBusy = false
    const stillThere = section.querySelector('[data-setup-account-field="password"]')
    if (stillThere) stillThere.value = ''
    if (!result.ok) {
      accountNotice = result.reason
      await loadAccount()
      paint()
      return
    }
    await loadAccount()
    /* Tell the settings store who is signed in now, exactly as
       src/views/account.js does after its own sign-in. Without this poke the
       durable store spends the WHOLE FIRST SESSION believing nobody is signed
       in (it hydrates the account asynchronously at launch, and this walkthrough
       is the launch), so every account-scoped setting the person chooses in
       their first hour -- the theme, the settings page, the purchase selection
       -- is written to the DEVICE record. On the next launch the store hydrates
       the account correctly, consults ONLY the account overlay for those keys
       (the no-leak rule in public/durable-storage.js), finds nothing, and the
       person opens an app wearing none of the choices they just made. Measured
       on the staged packaged build, 2026-08-18: theme chosen black after an
       in-walkthrough account creation, renderer-prefs.json carrying a bare
       `mc.theme` device key, and both relaunches painting white. Optional and
       guarded because a plain browser has no storage layer to tell. */
    try { if (globalThis.mcDurableStorage) globalThis.mcDurableStorage.onAccountChanged() } catch (error) { /* storage layer is optional */ }
    goTo('autonomy')
  }

  /* ---------- question 2: the folder ---------- */

  function workspaceRoots() {
    if (answers.workspaceRoots.length) return answers.workspaceRoots
    if (workspace?.roots?.length) return workspace.roots
    return workspace?.suggested ? [workspace.suggested] : []
  }

  function workspaceMarkup() {
    if (workspace === null) {
      return `<h1 class="setup-title">Which folder should your assistant work in?</h1>
        <div class="fleet-profile-status is-quiet" role="status">
          <strong>${currentDataSource() === 'relay' ? 'Reading the configuration of the computer you are driving…' : 'Reading this computer’s configuration…'}</strong>
          <span>The folder question needs to know which permission level was recorded, because the level decides which folders can be used.</span>
        </div>
        ${actionsMarkup({ back: stepBefore(STEPS, 'workspace') })}`
    }
    if (workspace.available === false) {
      /* Fails OPEN, exactly like the permission gate. A copy that cannot record
         a folder must not trap anyone on a screen whose only button fails; the
         walkthrough continues and the review states plainly that the folder was
         left as recorded. */
      return `<h1 class="setup-title">Which folder should your assistant work in?</h1>
        <div class="fleet-profile-status is-serious" role="alert">
          <strong>This copy cannot record a folder</strong>
          <span>${esc(setupRefusalDetail(workspace))} Nothing on ${esc(machineSubject())} has been changed, and the rest of setup still works.</span>
        </div>
        ${typeof globalThis.mcSetup?.workspaceState === 'function' ? '<button type="button" class="ctl-btn" data-setup-retry-workspace>Try again</button>' : ''}
        ${actionsMarkup({ back: stepBefore(STEPS, 'workspace'), next: stepAfter(STEPS, 'workspace') })}`
    }

    const roots = workspaceRoots()
    const multiple = recordedTier() !== 'guided'
    const chooserMissing = typeof globalThis.mcSetup?.chooseWorkspace !== 'function'
    const chooserReason = chooserMissing
      ? 'This installed copy cannot open the folder chooser. Update the app, then try again.'
      : (workspaceBusy ? 'The folder chooser is already open.' : (busy ? 'Setup is saving.' : null))
    const chooserControl = controlState({ enabled: !chooserMissing && !workspaceBusy && !busy, why: chooserReason })
    return `<h1 class="setup-title">Which folder should your assistant work in?</h1>
      <div class="settings-section-rows">
        <article class="settings-row fleet-profile-block setup-question">
          <div class="settings-copy">
            <div class="settings-name">Working folder</div>
            <div class="settings-desc">${esc(WORKSPACE_ACCESS_NOTICE)}</div>
          </div>
          <div class="fleet-profile-fields">
            ${roots.length
              ? roots.map((path, index) => `<div class="setup-root" data-setup-root-index="${index}">
                  <code class="setup-root-path">${esc(path)}</code>
                  ${roots.length > 1 ? `<button type="button" class="ctl-btn danger" data-setup-remove-root="${index}" aria-label="Remove ${esc(path)}" ${busy ? 'disabled' : ''}>Remove</button>` : ''}
                </div>`).join('')
              : '<p class="fleet-profile-empty">No folder chosen yet.</p>'}
            <div class="fleet-profile-actions">
              ${!workspace.chosen && !answers.workspaceRoots.length && roots.length ? `<button type="button" class="ctl-btn armed" data-setup-confirm-root${chooserControl.disabled ? ` disabled title="${esc(chooserControl.why)}"` : ''}>Use this folder</button>` : ''}
              <button type="button" class="ctl-btn" data-setup-choose-root${chooserControl.disabled ? ` disabled title="${esc(chooserControl.why)}"` : ''}>${roots.length ? 'Choose a different folder…' : 'Choose a folder…'}</button>
              ${multiple ? `<button type="button" class="ctl-btn" data-setup-add-root${chooserControl.disabled ? ` disabled title="${esc(chooserControl.why)}"` : ''}>Add another folder</button>` : ''}
            </div>
            <small class="setup-hint">${esc(workspace.chosen || answers.workspaceRoots.length
              ? 'This folder is recorded. Nothing is created or changed until you finish setup.'
              : 'This is a suggestion. Press “Use this folder” to accept it, or choose a different one. It is created for you when you accept, and put under version control, so every change an assistant makes there is recorded.')}</small>
          </div>
        </article>
      </div>
      ${chooserMissing ? `<div class="fleet-profile-status is-serious" data-setup-status role="alert">
        <strong>This copy cannot open the folder chooser</strong>
        <span>${esc(chooserControl.why)}</span>
      </div>` : workspaceRefusal ? `<div class="fleet-profile-status is-serious" data-setup-status role="alert">
        <strong>That folder cannot be used</strong>
        <span>${esc(workspaceRefusal)}</span>
      </div>` : ''}
      ${actionsMarkup({ back: stepBefore(STEPS, 'workspace'), next: stepAfter(STEPS, 'workspace'), nextDisabled: roots.length === 0, nextReason: 'Choose a folder before continuing.' })}`
  }

  /* ---------- question 3: how much it does on its own ---------- */

  /* THE CONSEQUENCE OF THE CURRENT ANSWER, STATED WHERE THE ANSWER IS MADE.
   *
   * The defect this repairs was not that `observe` exists -- someone who wants
   * to read before running anything is entitled to that answer. It was that
   * choosing it produced a product with no control anywhere that starts an
   * agent, and said so NOWHERE: the person met an absence and had to work out
   * that it was an answer they had given two screens earlier.
   *
   * It is driven by the DERIVED profile, not by the chosen label. The question
   * is "after these answers, on this permission level, does a control that
   * starts an agent exist?", and that has the ceiling already applied -- so if
   * a level ever stopped permitting the start flag, this block would report it
   * without anyone having to remember to write a second sentence. */
  function consequenceMarkup(profile) {
    if (profileCanStartAnAgent(profile)) return ''
    const tierLabel = TIER_CHOICES.find(choice => choice.tier === recordedTier())?.label || recordedTier()
    const sentence = autonomyStartsAgents(answers.autonomy)
      ? `The “${tierLabel}” permission level does not allow a session to be started on ${machineSubject()}, so the agent page will show no Start control. Change the level to change that.`
      : AUTONOMY_CHOICES.find(choice => choice.value === answers.autonomy)?.consequence
        || 'No control that starts an agent will be shown until this is changed.'
    return `<div class="fleet-profile-status is-warn" role="status" data-setup-consequence>
      <strong>With this answer, nothing here will start an agent</strong>
      <span>${esc(sentence)}</span>
    </div>`
  }

  function autonomyMarkup() {
    const profile = derived()
    const refused = profile.refusedWriteFlags
      .map(id => WRITE_ACTION_FLAGS.find(flag => flag.id === id)?.label || id)
    return `<h1 class="setup-title">How much should it do without asking you?</h1>
      <p class="setup-lede">Choose how hands-on you want to be. You can review the individual settings next.</p>
      <div class="setup-choices" role="group" aria-label="How much it does without asking">
        ${AUTONOMY_CHOICES.map(choice => `<button type="button" class="setup-choice-card" data-setup-set="autonomy" data-setup-value="${esc(choice.value)}" aria-disabled="${busy ? 'true' : 'false'}" aria-pressed="${choice.value === answers.autonomy ? 'true' : 'false'}" ${busy ? 'disabled' : ''}>
          <span class="setup-choice-mark" aria-hidden="true"></span>
          <span class="settings-copy">
            <span class="settings-name">${esc(choice.label)}${choice.note ? ` <span class="setup-badge">${esc(choice.note)}</span>` : ''}</span>
            <span class="settings-desc">${esc(choice.detail)}</span>
            ${choice.consequence ? `<span class="settings-desc setup-consequence">${esc(choice.consequence)}</span>` : ''}
          </span>
        </button>`).join('')}
      </div>
      ${consequenceMarkup(profile)}
      ${refused.length ? `<div class="fleet-profile-status is-warn" role="status">
        <strong>Your permission level does not allow all of that</strong>
        <span>${esc(refused.join(', '))} ${refused.length > 1 ? 'stay' : 'stays'} off however this question is answered, because the “${esc(TIER_CHOICES.find(choice => choice.tier === recordedTier())?.label || recordedTier())}” level does not include ${refused.length > 1 ? 'them' : 'it'}. Change the level to change that.</span>
      </div>` : ''}
      ${actionsMarkup({ back: stepBefore(STEPS, 'autonomy'), next: stepAfter(STEPS, 'autonomy') })}`
  }

  /* ---------- the review ---------- */

  function reviewRow(name, desc, control) {
    return `<article class="settings-row">
      <div class="settings-copy">
        <div class="settings-name">${esc(name)}</div>
        <div class="settings-desc">${esc(desc)}</div>
      </div>
      <div class="settings-control">${control}</div>
    </article>`
  }

  /* One attribute pair for every choice control on the review -- `data-setup-set`
     names the answer, `data-setup-value` names the option. Encoding the field in
     the attribute NAME instead looked tidier and was a trap: HTML lowercases
     attribute names, so `data-setup-intent-ideImport` arrives as
     `setupIntentIdeimport` and the camel-cased field ids silently stop matching. */
  function segControl(target, options, current, label) {
    return `<div class="seg settings-seg" role="group" aria-label="${esc(label)}">
      ${options.map(option => `<button type="button" data-setup-set="${esc(target)}" data-setup-value="${esc(option.value)}" aria-pressed="${option.value === current ? 'true' : 'false'}" class="${option.value === current ? 'on' : ''}" ${busy ? 'disabled' : ''}>${esc(option.label)}</button>`).join('')}
    </div>`
  }

  /* THE STEP THE WALKTHROUGH USED TO LEAVE OUT ENTIRELY.
   *
   * Codex is the program that actually runs an agent, and setup never mentioned
   * it: a person answered three questions, pressed Finish, and met a home screen
   * saying "Not ready yet" about software they had never been told to install.
   * The remedy existed nowhere in the product.
   *
   * IT NAMES THE COMMAND RATHER THAN THE CONCEPT. "Install the Codex CLI" is
   * something a person then has to go and research; a line they can paste is
   * something they can do. The winget form is given first because it needs no
   * Node -- on a machine with nothing installed it is the only one of the two
   * that works -- and both were run on a real machine before being written here.
   *
   * IT DOES NOT BLOCK FINISH, and that is deliberate rather than lax. The level,
   * the folder and the account are all worth recording on a computer that does
   * not have Codex yet, and a walkthrough that refuses to end until an unrelated
   * program is installed is a worse first hour than one that says what is left.
   * The state it reports is read, never written. */
  /* WHICH QUESTION IS BEING ANSWERED, AND BY WHOM.
   *
   * This block makes two claims about CODEX -- that it is installed here, and
   * that somebody is signed in to it -- and it used to read both of them off
   * mcAgent.availability(), which answers a different question: can this
   * installation start ANY agent. That short-circuit is correct and deliberate
   * (d1eb2a5): a person with Claude installed and no Codex is not a broken
   * machine, and telling them so would be the product calling itself broken on
   * a correctly set-up computer.
   *
   * But a provider-agnostic yes rendered as a fact about Codex is how the last
   * screen of setup came to say "Codex is installed on this computer and signed
   * in" on a machine with no Codex on PATH and nobody signed in to it --
   * measured on the packaged build 2026-08-16, where the sentence flipped on
   * whether CLAUDE was installed. Worse than the false sentence: it made the
   * not-installed branch below -- the one carrying the paste-able install
   * command -- unreachable for exactly the person who needed it.
   *
   * So the copy asks the bridge that answers per program. mcProviders.presence()
   * reports `installed` and `signedIn` for codex on their own, from the
   * filesystem, with 'unknown' as a real answer it uses rather than rounding
   * off. The short-circuit is untouched; what changed is that this screen stops
   * quoting it as evidence about a program it never mentioned.
   *
   * A KNOWN-BAD ENGINE STILL SPEAKS, because "Codex is here and signed in" is
   * not the whole of "an agent can start": a build with no engine payload
   * refuses whatever is installed. That answer is availability()'s to give and
   * it keeps its branch, above the provider ones. */
  /* NO SECOND TRANSLATION PASS OVER THESE LINES. codexReadiness() takes the
     desk-or-relay decision itself -- its `viaRelay` parameter defaults from
     currentDataSource(), and every branch in src/setup-review-readiness.js is
     written twice, once for the desk and once for the relay reader ("On that
     computer, open Windows Terminal and run: ..."). A replace() sweep here
     was tried and was worse than redundant: the relay line "On that computer,
     open Windows Terminal and run:" still CONTAINS the lowercase desk phrase,
     so rewriting it a second time doubled the prefix ("On that computer, on
     the computer you are driving, open Windows Terminal..."). The subject
     decision this view still owns is machineSubject(), for the sentences
     written in THIS file. */
  function codexReadinessMarkup() {
    const block = codexReadiness({ engine: agentReadiness, codex: codexPresence })
    return statusBlock(block.tone, block.heading, block.lines)
  }

  /* THE SAME CARD, FOR A MODEL ON THIS COMPUTER'S OWN HARDWARE. Read-only,
     like the one above it: this screen states what it found and, unlike
     Codex, never treats the absence as something the person still has to go
     do -- see localModelReadiness()'s own header for why the tone differs. */
  function localModelReadinessMarkup() {
    const block = localModelReadiness({ local: localModelPresence })
    return statusBlock(block.tone, block.heading, block.lines)
  }

  function statusBlock(modifier, heading, lines) {
    return `<div class="fleet-profile-status ${esc(modifier)}" role="status">
        <strong>${esc(heading)}</strong>
        ${lines.map(line => `<span>${esc(line)}</span>`).join('')}
      </div>`
  }

  /* WHAT THE RECOMMENDED PATH WITHHELD, SAID OUT LOUD (owner, R1529).
   *
   * This block used to be one line -- "Off is the shipped default for every one
   * of these" -- under a list of names. That is a true sentence and it is not an
   * answer: a person who took both Recommended answers arrived here, read that
   * their permission level "does not include" four switches, and had no way to
   * learn what any of them would have done, what it would have cost, whether
   * they were supposed to go and get it, or where the switch is. It is the same
   * shape as the defect this walkthrough already fixed once, one level in: an
   * absence a person has to diagnose.
   *
   * So every withheld switch now answers the three questions the directive
   * names -- what is off, what would turn it on, what that gains and risks --
   * and says in as many words that turning it on is optional.
   *
   * IT DOES NOT SWITCH ANYTHING ON, and that is the half worth stating. The
   * recommended answers grant exactly what they granted before this block
   * existed. The repair is guidance; a repair that closed the gap by granting
   * more by default would be the thing the directive forbids.
   *
   * THE REASON IS PER SWITCH, not per section. "Your level does not include it"
   * and "the answer you chose does not ask for it" are different facts with
   * different remedies -- one is changed at the permission question, the other
   * at this one -- and a person given the wrong one goes to the wrong screen. */
  function withheldSectionMarkup(profile, off) {
    if (off.length === 0) return ''
    const tierLabel = TIER_CHOICES.find(choice => choice.tier === profile.tier)?.label || profile.tier
    const refused = new Set(profile.refusedWriteFlags)
    return `<h2 class="setup-subtitle">Left off, and what each one would have given you</h2>
      <p class="setup-lede">None of these is required. This program works as it is; each one is an offer, with what it costs stated beside what it gives.</p>
      ${off.map(flag => withheldMarkup(`write_${flag.id}`, {
        label: flag.label,
        reason: refused.has(flag.id)
          ? `It is off because the “${tierLabel}” permission level does not include it. Choosing a wider level at the permission question is what would change that.`
          : 'It is off because the answer you chose does not ask for it. Changing that answer, or the switch itself in Settings, is what would turn it on.',
      })).join('')}`
  }

  /* THE QUICK BRIEF ON STANDING REQUESTS (owner, 2026-08-19: "they should be
   * shown a quick brief about /Request functions and such in setup").
   *
   * A CARD ON THE REVIEW, NOT A STEP: the walkthrough stays three questions,
   * and this asks nothing. Presentation only -- it writes nothing, gates
   * nothing, and sits clear of the consent machinery.
   *
   * EVERY SCOPE SENTENCE WAS CHECKED AGAINST THE SKILL DEFINITIONS
   * (the request skills' SKILL.md files in the canonical checkout), never
   * remembered: global is read by every agent at boot until the owner edits
   * or deletes it; session covers the working session and everything it
   * spawns and no other session; tree covers the anchor agent and every
   * agent below it, never parents or siblings; thread covers one
   * conversation and is re-read after the conversation is condensed. */
  function requestBriefMarkup() {
    return `<h2 class="setup-subtitle">Standing requests, in one minute</h2>
      <p class="setup-lede">Start a message to an agent with /Request and the words after it become a standing rule. Every agent reads it when it starts, until you edit or delete it.</p>
      <div class="settings-section-rows" data-setup-request-brief>
        <article class="settings-row setup-choice">
          <div class="settings-copy">
            <div class="settings-name">/Request — for everyone</div>
            <div class="settings-desc">The rule stands for every agent, everywhere, until you edit or delete it.</div>
          </div>
        </article>
        <article class="settings-row setup-choice">
          <div class="settings-copy">
            <div class="settings-name">/RequestSession — for one working session</div>
            <div class="settings-desc">The rule stands for that working session and every agent it starts. Other sessions never see it.</div>
          </div>
        </article>
        <article class="settings-row setup-choice">
          <div class="settings-copy">
            <div class="settings-name">/RequestTree — for one agent and its helpers</div>
            <div class="settings-desc">The rule stands for that agent and every agent working under it. It never reaches its neighbours or its manager.</div>
          </div>
        </article>
        <article class="settings-row setup-choice">
          <div class="settings-copy">
            <div class="settings-name">/RequestThread — for one conversation</div>
            <div class="settings-desc">The rule stands in that one conversation only. The agent re-reads it, so even a very long conversation cannot forget it.</div>
          </div>
        </article>
        <article class="settings-row setup-choice">
          <div class="settings-copy">
            <div class="settings-name">One example</div>
            <div class="settings-desc">Type: /Request Always ask before spending money. From then on, every agent starts its work knowing that rule.</div>
          </div>
        </article>
        <article class="settings-row setup-choice">
          <div class="settings-copy">
            <div class="settings-name">Two things worth saying out loud</div>
            <div class="settings-desc">These commands work right in the chat box, where you already talk to an agent. And to point any agent at ${esc(machineSubject())}'s tools, just say: “Ok, use ToolsEnabled and …” — agents here are told what that means. <a href="${esc(GUIDE_HREF)}">Settings, under &ldquo;This computer&rdquo;, has the longer story.</a></div>
          </div>
        </article>
      </div>`
  }

  /* A NOTICE FROM A SETUP THAT SAVED, which is not the same thing as a refusal.
     This used to read `refusal?.code === 'MC_SETUP_INTENT_DEFERRED'`, so the
     account deferral was both the reason the review showed a saved notice AND an
     entry in the variable every genuine failure uses -- which is why it rendered
     is-serious/role=alert and why Finish returned instead of navigating. The
     deferral is now its own carried fact and `refusal` means only "that was not
     saved". */
  function hasSavedSetupNotice() {
    return Boolean(assistantConfigFailure || undoUnavailable || accountPolicyDeferred)
  }

  function reviewMarkup() {
    const profile = derived()
    const tierChoice = TIER_CHOICES.find(choice => choice.tier === profile.tier)
    const roots = workspaceRoots()
    const workspaceWriteMissing = roots.length > 0 && workspace?.available !== false
      && typeof globalThis.mcSetup?.recordWorkspaces !== 'function'
    const finishReason = workspaceWriteMissing
      ? 'This installed copy cannot record the chosen folder. Update ToolsEnabled, then finish setup again.'
      : null
    const on = WRITE_ACTION_FLAGS.filter(flag => profile.writeFlags[flag.id])
    const off = WRITE_ACTION_FLAGS.filter(flag => !profile.writeFlags[flag.id])

    return `<h1 class="setup-title">Here is what those answers set.</h1>
      <p class="setup-lede">${hasSavedSetupNotice() ? 'Your settings are saved. Review the items below before you continue.' : 'Your permission level is saved. Finish setup to save the rest. You can change these choices later in Settings.'}</p>
      <div class="settings-section-rows">
        ${reviewRow(
          'Permission level',
          `${tierChoice ? tierChoice.detail : `A permission level is recorded for ${machineSubject()}.`}`,
          `<button type="button" class="ctl-btn" data-setup-back="tier" ${busy ? 'disabled' : ''}>${esc(tierChoice ? tierChoice.label : 'Change')}</button>`,
        )}
        ${reviewRow(
          roots.length > 1 ? 'Working folders' : 'Working folder',
          roots.length
            ? `${roots.join(' · ')}`
            : `No folder was chosen, so the one already recorded for ${machineSubject()} is kept.`,
          `<button type="button" class="ctl-btn" data-setup-back="workspace" ${busy ? 'disabled' : ''}>Change</button>`,
        )}
        ${reviewRow(
          'How much it does without asking',
          AUTONOMY_CHOICES.find(choice => choice.value === answers.autonomy)?.detail || '',
          segControl('autonomy', AUTONOMY_CHOICES.map(choice => ({ value: choice.value, label: choice.label })), answers.autonomy, 'How much it does without asking'),
        )}
        ${reviewRow(
          'What the screens show',
          SCREENS_CHOICES.find(choice => choice.value === answers.screens)?.detail || '',
          segControl('screens', SCREENS_CHOICES.map(choice => ({ value: choice.value, label: choice.label })), answers.screens, 'What the screens show'),
        )}
      </div>

      ${consequenceMarkup(profile)}

      ${codexReadinessMarkup()}

      <div class="setup-readiness-actions">
        <button type="button" class="ctl-btn setup-recheck" data-setup-recheck ${readinessBusy ? 'disabled' : ''}>${readinessBusy ? 'Checking…' : 'Check again'}</button>
        <span class="setup-hint">You can also install and sign in from the Guide after setup.</span>
      </div>

      <details class="setup-disclosure" data-setup-details="settings">
      <summary>Review all settings <span>${on.length} controls enabled</span></summary>
      <h2 class="setup-subtitle">Switches this turned on</h2>
      <div class="settings-section-rows">
        ${on.length ? on.map(flag => `<article class="settings-row setup-choice">
          <div class="settings-copy">
            <div class="settings-name">${esc(flag.label)}</div>
            <div class="settings-desc">This is a control this program will now offer you. The same switch is in Settings → Things it may do for you.</div>
            ${guidanceMarkup(`write_${flag.id}`, { probe, summary: 'What this lets happen, and what it risks' })}
          </div>
        </article>`).join('') : `<article class="settings-row setup-choice">
          <div class="settings-copy">
            <div class="settings-name">None</div>
            <div class="settings-desc">Nothing that acts is switched on. Every screen still reads and reports; turn on what you want when you want it, here or in Settings → Things it may do for you.</div>
          </div>
        </article>`}
      </div>

      ${withheldSectionMarkup(profile, off)}

      <h2 class="setup-subtitle">Decided for you, and changeable</h2>
      <div class="settings-section-rows">
        ${PROFILE_INTENT.map(field => reviewRow(
          field.name,
          field.desc,
          segControl(`intent:${field.id}`, field.order.map(value => ({ value, label: field.labels[value] })), profile.intent[field.id], field.name),
        )).join('')}
      </div>
      </details>

      <details class="setup-disclosure" data-setup-details="optional-tools">
        <summary>Optional tools <span>Local models and Docker</span></summary>
        ${localModelReadinessMarkup()}
        ${dockerSetupMarkup()}
      </details>

      <details class="setup-disclosure" data-setup-details="first-task">
      <summary>Tips for your first task</summary>
      ${requestBriefMarkup()}

      <div class="fleet-profile-status is-warn" role="status">
        <strong>${INTENT_BANNER_TITLE}</strong>
        <span>${INTENT_BANNER_BODY}</span>
        <span>The only account this setup asks for is the one on ${esc(machineSubject())}, described where it was offered. Nothing in this setup asks for a subscription, key or password for Claude, ChatGPT or Google, and this program stores none. Those stay in their own programs.</span>
      </div>
      </details>

      ${refusal ? `<div class="fleet-profile-status is-serious" data-setup-status role="alert">
        <strong>${esc(refusal.title || 'That was not saved')}</strong>
        <span>${esc(setupRefusalDetail(refusal))}</span>
      </div>` : ''}

      ${workspaceWriteMissing ? `<div class="fleet-profile-status is-serious" data-setup-status role="alert">
        <strong>This copy cannot record the chosen folder</strong>
        <span>${esc(finishReason)}</span>
      </div>` : ''}
      
      ${assistantConfigFailure ? `<div class="fleet-profile-status" data-setup-status data-setup-assistant-config role="status">
        <strong>Your folders were saved. The agent settings file was not written.</strong>
        <span>Agent programs on ${esc(machineSubject())} read a settings file in the folder you chose, and this copy could not write it. ${esc(setupRefusalDetail(assistantConfigFailure, 'The computer did not say why.'))} Everything else in this setup took. Until it is written, an agent opened in that folder will not see ToolsEnabled&rsquo;s tools &mdash; close anything holding the file, then press Finish setup again.</span>
      </div>` : ''}
      
      ${undoUnavailable ? `<div class="fleet-profile-status" data-setup-status data-setup-undo-unavailable role="status">
        <strong>Your folders were saved. Undo will not be available in them.</strong>
        <span>${esc(setupRefusalDetail(undoUnavailable, 'The application did not say why.'))} Everything else in this setup took. An assistant can still work in those folders; what it cannot do is put them back the way they were.</span>
      </div>` : ''}

      ${accountPolicyDeferred ? `<div class="fleet-profile-status" data-setup-status data-setup-account-policy role="status">
        <strong>Your setup was saved. The account switching choice waits for an account.</strong>
        <span>${esc(setupRefusalDetail(accountPolicyDeferred, 'The application did not say why.'))} Everything else in this setup took. Add accounts in the Accounts menu on Computers.</span>
      </div>` : ''}

        ${hasSavedSetupNotice() ? '<button type="button" class="ctl-btn" data-setup-open-app>Continue to the app</button>' : ''}
      ${actionsMarkup({ back: stepBefore(STEPS, 'review'), next: 'finish', nextLabel: busy ? 'Saving…' : 'Finish setup', nextDisabled: workspaceWriteMissing, nextReason: finishReason })}`
  }

  /* ---------- moving between steps ---------- */

  /* Progress as the person has it, beside the durable write: the stored
     profile is what the NEXT launch resumes from, `liveWalk` is what a
     re-mount inside THIS page adopts, and writing them in the same breath is
     what keeps the two from disagreeing. */
  function holdWalk() {
    liveWalk = { step, answers, initiallyConfigured }
  }

  function goTo(next) {
    if (!STEPS.includes(next)) return
    step = next
    workspaceRefusal = null
    /* Held, not applied. A person who closes the window here has changed
       nothing on this computer beyond the permission level they explicitly
       saved, and reopening setup resumes on this step. */
    writeStoredProfile({ status: 'in-progress', step, answers })
    holdWalk()
    paint()
    const heading = section.querySelector('.setup-title')
    if (heading) {
      heading.setAttribute('tabindex', '-1')
      heading.focus({ preventScroll: true })
      root.scrollTo?.({ top: 0 })
    }
    if ((step === 'workspace' || step === 'review') && workspace === null) loadWorkspace()
    /* Re-asked every time the review step is REACHED, not cached for the life
       of the view: the whole point of naming the commands is that somebody goes
       and runs them, and stepping back and forward is the one gesture available
       to a person who just did. */
    if (step === 'review') loadAgentReadiness()
  }

  async function loadWorkspace() {
    if (!globalThis.mcSetup?.workspaceState) {
      workspace = { available: false, reason: 'This page is running in a browser rather than the installed application, so there is no computer here to configure.' }
      paint()
      return
    }
    let result
    try {
      result = await withDeadline(globalThis.mcSetup.workspaceState(), SETUP_READ_DEADLINE_MS, 'The working folder check')
    } catch (error) {
      result = { ok: false, available: false, reason: error?.message || String(error) }
    }
    if (destroyed) return
    workspace = result?.ok === false
      ? { available: false, reason: setupRefusalDetail(result) }
      : result
    paint()
  }

  /* IS THE CODEX PROGRAM ITSELF HERE, asked of the bridge that answers per
     program rather than inferred from "can anything start". Same rule as
     everything else on this screen: an answer that cannot be got stays
     unanswered, and 'unknown' from the shell survives as 'unknown' here. */
  async function loadCodexPresence() {
    if (!globalThis.mcProviders?.presence) {
      codexPresence = { known: false }
      return
    }
    let answer
    try {
      answer = await withDeadline(globalThis.mcProviders.presence(), SETUP_READ_DEADLINE_MS, 'The assistant installation check')
    } catch {
      answer = null
    }
    if (destroyed) return
    const codex = answer && answer.ok === true && Array.isArray(answer.providers)
      ? answer.providers.find(provider => provider.id === 'codex')
      : null
    codexPresence = codex
      ? { known: true, installed: codex.installed, signedIn: codex.signedIn }
      : { known: false }
  }

  /* IS A LOCAL MODEL RUNTIME ANSWERING ON THIS COMPUTER, asked of the bridge
     verb built for exactly this question -- a live network probe, never the
     PATH/npm check loadCodexPresence() runs. Same fail-to-unknown convention:
     an absent bridge or a read that could not complete leaves `known:false`,
     which localModelReadiness() reports as "could not check" rather than a
     tick or a false "not running". */
  async function loadLocalModelPresence() {
    if (!globalThis.mcProviders?.detectLocal) {
      localModelPresence = { known: false }
      return
    }
    let answer
    try {
      answer = await withDeadline(globalThis.mcProviders.detectLocal(), SETUP_READ_DEADLINE_MS, 'The local model check')
    } catch {
      answer = null
    }
    if (destroyed) return
    localModelPresence = answer && answer.ok === true
      ? { known: true, ready: answer.ready === true, selected: answer.selected || null }
      : { known: false }
  }

  /* Fails to an honest silence, never to a green tick. Every branch that cannot
     get an answer leaves `agentReadiness` reporting `unknown`, and the review
     step then says it could not check rather than implying it passed. */
  async function loadAgentReadiness() {
    if (readinessBusy) return
    readinessBusy = true
    agentReadiness = null
    codexPresence = null
    localModelPresence = null
    paint()
    /* Asked on the same beat, because the review reads both: the engine's own
       verdict, and what this machine has installed. */
    const codexCheck = loadCodexPresence().then(() => { if (!destroyed) paint() })
    /* A third, independent read -- see its own comment above for why it is
       not folded into loadCodexPresence(): different bridge verb, different
       question, and a local runtime's absence must never be able to blank
       or delay the Codex line beside it, any more than the reverse. */
    const localCheck = loadLocalModelPresence().then(() => { if (!destroyed) paint() })
    if (!globalThis.mcAgent?.availability) {
      agentReadiness = { known: false }
      await Promise.allSettled([codexCheck, localCheck])
      readinessBusy = false
      paint()
      return
    }
    let reply
    try {
      reply = await withDeadline(globalThis.mcAgent.availability(), SETUP_READ_DEADLINE_MS, 'The agent readiness check')
    } catch {
      reply = null
    }
    if (destroyed) return
    agentReadiness = reply && typeof reply === 'object' && typeof reply.ok === 'boolean'
      ? { known: true, ok: reply.ok === true, code: typeof reply.code === 'string' ? reply.code : '',
        codexCode: typeof reply.codexCode === 'string' ? reply.codexCode : '' }
      : { known: false }
    paint()
    /* The guided steps on this screen ask the same question of a few more
       outside things. Same rule as above: an answer that cannot be got stays
       unanswered and the step says it could not check. */
    await Promise.allSettled([codexCheck, localCheck, withDeadline(refreshCapabilityProbes(), SETUP_READ_DEADLINE_MS, 'The optional tools check')])
    readinessBusy = false
    if (destroyed) return
    paint()
  }

  /* CONFIRMS THE SUGGESTED FOLDER WITHOUT RECORDING IT. Only Finish and Skip
     may call the real recordWorkspaces -- it provisions the folder on disk and
     writes the durable machine record, and both of those are terminal acts the
     person has not taken yet by pressing this button. This used to call
     recordWorkspaces directly, so accepting the suggested default folder
     wrote it to disk and stamped workspaceChosen on the machine record before
     the person had seen the rest of the walkthrough, let alone pressed
     Finish -- closing the wizard right afterward left that write standing.
     checkWorkspace runs the identical validation (src/lib/setup/workspace.js's
     checkWorkspaceCandidate) without provisioning or writing anything, so a
     rejected folder is still caught here; only the accepted case moved. */
  async function confirmWizardFolder() {
    if (workspaceBusy) return
    if (typeof globalThis.mcSetup?.checkWorkspace !== 'function') {
      workspaceRefusal = 'This installed copy cannot check a working folder. Update the app, then try again.'
      paint(); return
    }
    const roots = workspaceRoots()
    if (!roots.length) { workspaceRefusal = 'There is no suggested folder to confirm. Choose one instead.'; paint(); return }
    workspaceBusy = true; workspaceRefusal = null; paint()
    let result
    try { result = await globalThis.mcSetup.checkWorkspace(roots[0]) } catch (error) { result = { ok: false, reason: error?.message || String(error) } }
    if (destroyed) return
    workspaceBusy = false
    if (!result?.ok) { workspaceRefusal = setupRefusalDetail(result); paint(); return }
    const confirmed = [result.resolved]
    answers = { ...answers, workspaceRoots: confirmed }
    if (workspace) workspace = { ...workspace, roots: confirmed, chosen: true }
    writeStoredProfile({ status: 'in-progress', step, answers })
    holdWalk()
    paint()
  }

  async function pickWorkspace(mode) {
    if (workspaceBusy) return
    if (typeof globalThis.mcSetup?.chooseWorkspace !== 'function') {
      workspaceRefusal = 'This installed copy cannot open the folder chooser. Update the app, then try again.'
      paint()
      return
    }
    workspaceBusy = true
    workspaceRefusal = null
    paint()
    let result
    try {
      result = await globalThis.mcSetup.chooseWorkspace()
    } catch (error) {
      result = { ok: false, reason: error?.message || String(error) }
    }
    if (destroyed) return
    workspaceBusy = false
    if (result?.canceled) { paint(); return }
    if (!result?.ok) {
      /* Both shapes, one reader -- see setupRefusalDetail. This line used to
         read `result?.reason` alone and printed "The application did not say
         why." over a shell reply that carried the sentence in `error.message`. */
      workspaceRefusal = setupRefusalDetail(result)
      paint()
      return
    }
    const current = mode === 'add' ? workspaceRoots() : []
    answers = { ...answers, workspaceRoots: current.includes(result.path) ? current : [...current, result.path] }
    writeStoredProfile({ status: 'in-progress', step, answers })
    holdWalk()
    paint()
  }

  function removeRoot(index) {
    const roots = workspaceRoots().slice()
    if (index < 0 || index >= roots.length || roots.length <= 1) return
    roots.splice(index, 1)
    answers = { ...answers, workspaceRoots: roots }
    writeStoredProfile({ status: 'in-progress', step, answers })
    holdWalk()
    paint()
  }

  /* ---------- writing it down ---------- */

  function applyDerived() {
    return applyProfile(derived(), { setWriteFlag: setWriteEnabled, setExampleMode })
  }

  /**
   * Finish: the folders first, then the switches.
   *
   * The folder write is the only step that can fail, so it goes first and a
   * failure stops everything. Applying the switches and then failing to record
   * the folder would leave a machine that half-agrees with the screen the person
   * is looking at, which is worse than a refusal they can act on.
   *
   * BEING DESTROYED IS NOT A REASON TO DROP THE PRESS, and reading it as one was
   * a dead end at the last click of setup.
   *
   * MEASURED, on the packaged window from a sterile profile: this view can be
   * mounted TWICE -- two [data-setup-section] elements and two Continue buttons
   * exist in the DOM at once -- and the copy a person's eye reaches first is the
   * one the router has already torn down. Every question still answered
   * correctly on it, because each instance wires its own section. Then Finish
   * awaited the folder write, came back to `destroyed === true`, and RETURNED.
   * Nothing was applied, no profile was recorded, nothing navigated. The stored
   * record was still `in-progress` and the walkthrough restarted at question 1,
   * forever. The most important button in the product did precisely nothing and
   * said nothing, which is the worst shape a failure can take.
   *
   * The guard was right about ONE thing: a destroyed instance must not paint,
   * because its section is detached and painting it shows nobody anything. But
   * applying the profile, recording it and navigating are writes to
   * localStorage and to the route -- global, and every bit as correct from an
   * instance that has been torn down as from one that has not. The person
   * pressed Finish. The folder was already written by the time this returns.
   * So the guard now covers only the paint, and the outcome happens either way.
   *
   * The double mount itself is the deeper defect and is not this file's to fix:
   * it is the router that mounts a second copy without removing the first.
   */
  async function finish() {
    if (busy) return
    busy = true
    refusal = null
    paint()

    /* THE ANSWER IS READ BEFORE IT IS ACTED ON (T299).
     *
     * loadWorkspace() is FIRED, not awaited, by goTo() when the person reaches
     * the Folder step, and it is the only thing that ever sets `workspace`. So
     * Finish can land while that read is still in flight, or before it has been
     * started at all -- and a null `workspace` makes workspaceRoots() answer []
     * (answers.workspaceRoots is empty for somebody who accepted the suggested
     * default without pressing anything, which is the ordinary fresh install).
     *
     * The old needsWrite read that [] as "there is no folder to record",
     * recorded nothing, reported success and navigated into the product. The
     * person then met "No working folder has been confirmed" on a different
     * screen when they tried to start an agent, because
     * shell/agent-command-surface.cjs mints AGENT_START_WORKSPACE_UNCONFIRMED
     * from `chosen === false`, and shell/setup-record.cjs's recordWorkspaces is
     * the only thing that ever stamps it. Nothing on the wizard said a word:
     * the progress tick is positional (see the header markup -- `position <
     * index`), so the Folder step draws a tick for having been walked past, not
     * for having recorded anything.
     *
     * "Could not look" and "there is nothing there" are different answers, so
     * the read is finished here rather than guessed at. */
    if (workspace === null) await loadWorkspace()
    const roots = workspaceRoots()
    /* AND A SUBSYSTEM THAT SAID NO IS A REFUSAL, NOT AN ABSENCE. When the
       working-folder check is unavailable the folder cannot be recorded, and
       completing setup quietly hands the person a product that will refuse the
       first agent they start with a sentence pointing at a screen they have
       just been through. Said here, where they can still act on it, in the same
       shape as every other folder failure below. */
    if (roots.length > 0 && workspace?.available === false) {
      busy = false
      refusal = {
        title: 'That folder was not saved',
        code: 'MC_SETUP_WORKSPACE_UNAVAILABLE',
        reason: `${workspace.reason || 'The working folder check is unavailable on this computer.'} Nothing else was changed either.`,
      }
      if (!destroyed) paint()
      return
    }
    const needsWrite = roots.length > 0
    if (needsWrite) {
      if (typeof globalThis.mcSetup?.recordWorkspaces !== 'function') {
        busy = false
        refusal = {
          title: 'This copy cannot record the chosen folder',
          code: 'MC_SETUP_WORKSPACE_UNAVAILABLE',
          reason: 'This installed copy cannot record the chosen folder. Nothing else was changed either.',
        }
        if (!destroyed) paint()
        return
      }
      let result
      try {
        result = await globalThis.mcSetup.recordWorkspaces(roots)
      } catch (error) {
        result = { ok: false, reason: error?.message || String(error) }
      }
      if (!result?.ok) {
        busy = false
        refusal = {
          title: 'That folder was not saved',
          code: result?.code || 'MC_SETUP_WORKSPACE_FAILED',
          reason: `${setupRefusalDetail(result)} Nothing else was changed either.`,
        }
        /* A refusal a torn-down section cannot show is still a refusal, so the
           run stops here rather than completing a setup whose folder failed. */
        if (!destroyed) paint()
        return
      }
      answers = { ...answers, workspaceRoots: result.roots }
      /* THE OTHER HALF OF THE PRODUCER'S ANSWER. recordWorkspaces reports the
         folders and the agent-client config SEPARATELY, and says so in its own
         comment: "so the screen can say what did and did not happen". Only `ok`
         was ever read, so a locked or unwritable .mcp.json completed setup
         silently and left the person's agent clients with no ToolsEnabled
         configuration, permanently and with nothing anywhere mentioning it.
         Deliberately NOT a refusal: the folders really were saved, and refusing
         would tell somebody their choice did not take when it did. Carried,
         stated, and non-blocking. */
      assistantConfigFailure = result.assistantConfig && result.assistantConfig.ok === false
        ? result.assistantConfig
        : null
      /* AND THE SIBLING FACT IN THE SAME REPLY, which the commit that added the line
         above missed. `provisioned` carries per-root undoAvailable and a reason;
         engine/src/lib/setup/workspace.js returns them so a surface can say when
         "Undo the last thing it did" will not work. Reading one field of a reply and
         leaving its neighbour is the miss this project has now recorded six times. */
      const noUndo = (Array.isArray(result.provisioned) ? result.provisioned : [])
        .find(root => root && root.undoAvailable === false && root.undoUnavailableReason)
      undoUnavailable = noUndo ? { reason: noUndo.undoUnavailableReason } : null
    }

    let intentResult
    try {
      intentResult = await applySetupIntentChanges(null, derived().intent)
      applyDerived()
      /* Recorded BEFORE the write, not after it, because the write is what makes
         the fact outlive this screen. See src/setup-profile.js for why it must. */
      accountPolicyDeferred = intentResult.deferred.length ? { reason: intentResult.deferred.join(' ') } : null
      if (writeStoredProfile({ status: 'complete', step: 'review', answers, assistantConfig: assistantConfigFailure, undoUnavailable, accountPolicyDeferred }) === null) throw new Error('The setup answers could not be saved.')
    } catch (error) {
      busy = false
      refusal = { title: 'Setup settings could not be saved', code: 'MC_SETUP_INTENTS_FAILED',
        reason: `${error.message} Earlier setup changes may already have saved. Your answers remain here so you can try again.` }
      if (!destroyed) paint()
      return
    }
    liveWalk = null
    busy = false
    /* FINISH FINISHES. This is the repair for the worst defect the packaged Linux
     * run found, and it is a defect about a deferral being filed as a refusal.
     *
     * MEASURED 2026-09-11 on the packaged 1.0.44 Linux candidate, from a sterile
     * profile: the walk answers all five questions, presses Finish, and the build
     * stays at hash=#/setup. Every write succeeded. The stored profile read
     * `status: "complete"`. The single thing outstanding was
     * applySetupIntentChanges' one deferral -- mcProviders.accountPolicy cannot
     * record an account-switching choice before the account list exists, which is
     * EVERY fresh installation -- and the old code turned that into a `refusal`
     * and RETURNED. So the last press of first-run setup answered with an
     * is-serious role=alert box about a preference the wizard never asks, left
     * "Finish setup" still on the screen for the person to press again, and made
     * entering the product depend on noticing a different button.
     *
     * `skip()` called the same function, received the same deferral, never read
     * it, and navigated -- which is exactly why "Skip the rest for now" reached
     * the app and "Finish setup" did not. One of the two was wrong and it was not
     * skip.
     *
     * The remaining stop is deliberate and is NOT a deferral: assistantConfig and
     * undoUnavailable are outcomes of the folder the person chose, and the first
     * of the two names something to do ON THIS SCREEN ("close anything holding
     * the file, then press Finish setup again"). A notice whose only action is
     * later and elsewhere must not hold the last press of setup; one whose action
     * is here may. */
    if (assistantConfigFailure || undoUnavailable) {
      paint()
      section.querySelector('[data-setup-assistant-config], [data-setup-undo-unavailable]')?.scrollIntoView?.({ block: 'center' })
      return
    }
    navigate('#/')
  }

  /**
   * Skip: apply the Basic answers (SAFE_ANSWERS), explicitly.
   *
   * Writing them rather than leaving storage empty is deliberate. The effective
   * state is the same either way -- src/write-flags.js reads an absent action
   * preference as Basic, and live views default live -- but a declared state
   * can be shown on the review and in Settings, and an implied one cannot.
   * The workspace is left alone: skipping is not an answer to that question.
   */
  /* THIS CONTROL WIPES A WORKING CONFIGURATION, AND IT USED TO DO IT ON ONE
   * UNWARNED PRESS. skip() replaces every answer with the Basic defaults and
   * APPLIES them -- a saved Observe or Assisted choice and every hand-set
   * switch replaced by the Basic answers, any hand-picked folder dropped.
   *
   * On first run that is exactly right and costs nothing: there is nothing to
   * lose, and a step with no exit is a trap (tools/test/setup-profile.test.mjs
   * pins that this control must exist, so it must never be suppressed).
   *
   * THE RETURNING CUSTOMER IS THE CASE THAT MATTERS. Settings offers "Walk
   * through setup again", and its own description promises "Nothing is written
   * until you finish it, and leaving partway changes nothing"
   * (setup-profile-settings.js). resumeStep sends a completed profile straight
   * to the review screen, so the person lands on the LAST page holding their
   * real answers -- and the leftmost control in that action bar reset every one
   * of them. The screen they were promised could not change anything was the
   * screen whose first control changed everything.
   *
   * SO IT CONFIRMS, AND ONLY WHEN THERE IS SOMETHING TO DESTROY. A second press
   * is the same idiom Disconnect uses, rather than a dialog this view does not
   * otherwise have -- and the armed label says what will happen instead of
   * asking "are you sure", which is a question nobody reads. */
  async function skip() {
    if (busy) return
    if (initiallyConfigured && !skipArmed) {
      skipArmed = true
      paint()
      return
    }
    skipArmed = false
    busy = true
    answers = { ...SAFE_ANSWERS, workspaceRoots: [] }
    try {
      /* THE RETURN VALUE WAS DISCARDED HERE, and that discard is half of the
         defect finish() above records. Skipping reached the app because it never
         looked at the deferral; finishing did not because it filed it as a
         refusal. Both now record it and both enter the application, so the two
         controls differ in what they answer and not in whether they work. */
      const skipIntent = await applySetupIntentChanges(null, derived().intent)
      applyDerived()
      accountPolicyDeferred = skipIntent.deferred.length ? { reason: skipIntent.deferred.join(' ') } : null
      if (writeStoredProfile({ status: 'skipped', step: 'review', answers, accountPolicyDeferred }) === null) throw new Error('The setup answers could not be saved.')
    } catch (error) {
      busy = false
      refusal = { title: 'The Basic setup answers could not be saved', code: 'MC_SETUP_INTENTS_FAILED', reason: error.message }
      if (!destroyed) paint()
      return
    }
    busy = false
    liveWalk = null
    navigate('#/')
  }

  /* ---------- wiring ---------- */

  function releaseSegs() {
    for (const cleanup of segCleanups) cleanup()
    segCleanups = []
  }

  function wireSegs() {
    const groups = [...section.querySelectorAll('.seg')]
    for (const group of groups) segCleanups.push(attachSeg(group))
  }

  function onClick(event) {
    if (event.target.closest('[aria-disabled="true"]')) return
    if (event.target.closest('[data-setup-open-app]')) {
      if (!busy && hasSavedSetupNotice()) navigate('#/')
      return
    }
    if (event.target.closest('[data-setup-retry-workspace]')) {
      if (workspace !== null) { workspace = null; paint(); void loadWorkspace() }
      return
    }
    if (event.target.closest('[data-setup-recheck]')) { void loadAgentReadiness(); return }
    const option = event.target.closest('[data-setup-tier]')
    if (option) { select(option.dataset.setupTier); return }
    if (event.target.closest('[data-unrestricted-confirm]')) { confirmUnrestricted(); return }
    const sandboxAction = event.target.closest('[data-sandbox-action]')
    if (sandboxAction) { void runDockerSetupAction(section, sandboxAction.dataset.sandboxAction, window.mcSetup); return }
    if (event.target.closest('[data-unrestricted-decline]')) { declineUnrestricted(); return }
    if (event.target.closest('[data-setup-continue]')) { commit(); return }

    const back = event.target.closest('[data-setup-back]')
    if (back) { goTo(back.dataset.setupBack); return }

    const next = event.target.closest('[data-setup-next]')
    if (next) {
      if (next.dataset.setupNext === 'finish') finish()
      else goTo(next.dataset.setupNext)
      return
    }

    if (event.target.closest('[data-setup-skip-first]')) { skipFromFirstQuestion(); return }
    if (event.target.closest('[data-setup-skip]')) { skip(); return }
    /* ANY OTHER PRESS DISARMS. An arming press followed by a change of mind
       must not leave the control loaded, so that an unrelated press minutes
       later is the second half of a confirmation nobody remembers giving. */
    if (skipArmed) { skipArmed = false; paint() }
    if (event.target.closest('[data-setup-confirm-root]')) { void confirmWizardFolder(); return }
    if (event.target.closest('[data-setup-choose-root]')) { pickWorkspace('replace'); return }
    if (event.target.closest('[data-setup-add-root]')) { pickWorkspace('add'); return }

    const remove = event.target.closest('[data-setup-remove-root]')
    if (remove) { removeRoot(Number(remove.dataset.setupRemoveRoot)); return }

    if (event.target.closest('[data-google-signin-legacy]')) { startGoogleSignIn(true); return }
    if (event.target.closest('[data-google-signin-start]')) { startGoogleSignIn(); return }
    if (event.target.closest('[data-google-signin-cancel], [data-account-signin-cancel]')) {
      const attempt = accountBrowserSignIn
      if (!attempt || !account.canCancelSignIn) return
      void account.googleCancel().then(result => {
        if (destroyed || accountBrowserSignIn !== attempt || result?.ok === true) return
        accountNotice = result?.reason || 'Cancellation was not confirmed. Close the browser window and wait for the sign-in attempt to end.'
        paint()
      })
      return
    }

    const accountSubmit = event.target.closest('[data-setup-account-submit]')
    if (accountSubmit) { submitAccount(accountSubmit.dataset.setupAccountSubmit); return }

    const accountModeButton = event.target.closest('[data-setup-account-mode]')
    if (accountModeButton) {
      if (accountBusy) return
      accountMode = accountModeButton.dataset.setupAccountMode
      accountNotice = null
      accountPicked = true
      paint()
      return
    }

    const setter = event.target.closest('[data-setup-set]')
    if (setter) setAnswer(setter.dataset.setupSet, setter.dataset.setupValue)
  }

  /**
   * Record one answer, refusing anything this build does not recognise.
   *
   * The value arrives from an attribute, so it is treated as untrusted input and
   * checked against the model's own vocabulary rather than assigned. An
   * unrecognised value silently becoming an answer is how a profile ends up
   * holding a setting no part of the product can act on.
   */
  function setAnswer(target, value) {
    if (busy) return
    let next = null
    if (target === 'autonomy') {
      /* A different overall posture resets the four detail settings to that
         posture's own coherent set. Keeping a hand-moved value across a change
         of answer produces a profile nobody chose. */
      if (!AUTONOMY_CHOICES.some(choice => choice.value === value) || value === answers.autonomy) return
      next = answersForAutonomy(value, answers)
    } else if (target === 'screens') {
      if (!SCREENS_CHOICES.some(choice => choice.value === value) || value === answers.screens) return
      next = { ...answers, screens: value }
    } else if (target.startsWith('intent:')) {
      const field = intentField(target.slice('intent:'.length))
      if (!field || !field.order.includes(value) || value === answers[field.id]) return
      next = { ...answers, [field.id]: value }
    }
    if (!next) return
    answers = next
    writeStoredProfile({ status: 'in-progress', step, answers })
    holdWalk()
    paint()
  }

  /* ENTER SUBMITS THE ACCOUNT STEP (T1557), as it does on the Account page,
     where the same fields sit in a form. Here they do not, so Enter in a
     name or password field did nothing and a keyboard user had to Tab past
     four other buttons to reach "Create and continue". It does exactly what
     the visible submit button does, including nothing while that is busy. */
  function onKeydown(event) {
    if (event.key !== 'Enter' || event.isComposing || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return
    if (step !== 'account' || accountBusy || !event.target?.closest?.('[data-setup-account-field]')) return
    event.preventDefault()
    submitAccount(accountMode === 'create' ? 'create' : 'sign-in')
  }

  section.addEventListener('click', onClick)
  section.addEventListener('keydown', onKeydown)
  paint()
  if (step === 'workspace' || step === 'review') loadWorkspace()
  if (step === 'review') loadAgentReadiness()
  /* Read on mount rather than on arrival at the step, so the step paints its
     real state on the first frame instead of flashing "reading accounts". */
  loadAccount()

  return {
    el: root,
    destroy() {
      destroyed = true
      endAccountBrowserSignIn()
      section.removeEventListener('click', onClick)
      section.removeEventListener('keydown', onKeydown)
      releaseSegs()
    },
  }
}
