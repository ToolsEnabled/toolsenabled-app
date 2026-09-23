/* "This computer" — the Settings section that answers what is on this machine.
 *
 * WHERE THIS CODE COMES FROM. It is the working half of the page that used to
 * live at src/views/guide.js, called "What this copy needs". The owner asked to
 * "get rid of the what this copy needs page and put it nicely into settings and
 * make it more simple and useful", so the page's prose went and the part a
 * person acts on -- what is installed here, which accounts exist, what a local
 * model needs -- moved here as a section of Settings.
 *
 * IT IS A MOVE, NOT A REWRITE. Every bridge call is the one the page made, in
 * the same order, with the same gating: the same window.mcProviders verbs, the
 * same "offer the control disabled with its reason beside it" rule, and the
 * same "the feedback door is ABSENT when the backend says so, never a dead
 * button" rule. Sign-in handling in particular does not change; nothing here
 * asks for a credential and nothing here reads one.
 *
 * WHAT DID CHANGE, AND IT IS ONE THING. The page was rebuilt on every visit, so
 * it could guard its asynchronous paints on `root.isConnected` and let a read
 * that landed after the person left do nothing. This section's element OUTLIVES
 * the render: Settings draws one category at a time and rebuilds the column
 * when a capability probe answers, so the element is detached and re-attached
 * repeatedly and is reused across all of it. Guarding on `isConnected` here
 * would throw away the presence answer of anybody who clicked to another
 * category before the machine replied, and the section would stay blank when
 * they came back. So the guard is a destroyed flag, stamped on the element --
 * the one state that really means "nobody will ever see this again".
 *
 * EVERY WORD STILL COMES FROM A COPY MODULE. src/first-run-needs.js,
 * src/account-panel-copy.js and src/local-model-setup-copy.js own the
 * sentences; this file is a renderer, for the same reason the page was: copy
 * inside a render function can only be checked by reading the render function.
 */

import { FEEDBACK_COPY, MAX_MESSAGE_CHARACTERS, probeFeedbackAvailable, submitFeedback } from './feedback-compose.js'
import { controlState, el } from './components.js'
import {
  ACCOUNT_PANEL,
  CLAUDE_ACCOUNT_RISK,
  PROVIDER_SIGN_IN,
  accountPanelCopy,
  providerSignInCopy,
} from './account-panel-copy.js'
import { applyDeferredAccountPolicy } from './setup-intent-commit.js'
import { currentDataSource, onDesktop } from './data-source.js'
import { readerRemedy } from './refusal-copy.js'
import { withDeadline } from './read-deadline.js'
import { PROVIDER_SETUP, SETTINGS_HREF, presenceSentence } from './first-run-needs.js'
import { LOCAL_MODEL_SETUP } from './local-model-setup-copy.js'
import { GUIDE_LOCAL_MODEL_STOP_IDLE } from './chat-copy.js'
import './this-computer-settings.css'

/* THE SECTION'S NAME AND ITS ANCHOR, IN ONE PLACE. src/views/settings.js draws
   the rows and src/first-run-needs.js points every empty screen at them, so the
   id lives here rather than being typed into either of those and drifting. */
export const THIS_COMPUTER_SECTION = 'This computer'
export const THIS_COMPUTER_PROGRAMS_ROW = 'this_computer_programs'
export const THIS_COMPUTER_HREF = `${SETTINGS_HREF}?setting=${THIS_COMPUTER_PROGRAMS_ROW}`

const esc = value => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

/* THE SENTENCE IS WRITTEN FOR THE MACHINE, THEN READ FROM WHERE THE PERSON IS.
 * This is the same single source verdict used by views/computers.js. Keeping
 * the desk sentence intact matters: local rendering must remain byte-for-byte,
 * while the relay may select a declared remote twin without rewriting stored
 * state or teaching this surface a second translation table. */
const readerSentence = sentence => readerRemedy(sentence, { viaRelay: currentDataSource() === 'relay' })

/* THIS IS WHAT A STRANGER OPENS SETTINGS FOR, AND IT COULD WAIT FOREVER.
 *
 * Both reads here -- what is installed, and which accounts exist -- were
 * awaited with no bound. Both panels stay hidden until their await returns, so
 * a reply that never arrived left a brand-new person looking at a section with
 * no provider status, no account panel, and nothing to press. Not an error:
 * nothing at all, indefinitely. The worst version of a dead end, because there
 * is no way to tell it apart from a slow machine.
 *
 * Both already had CORRECT failure paths -- paintAccountsUnreadable, and the
 * all-"unknown" provider fallback that says so on the screen. So the fix is not
 * new copy or new branches: it is giving the existing failure path a way to be
 * reached. A deadline converts "silent forever" into "we could not tell", which
 * this section already knows how to say.
 *
 * TEN SECONDS, and the number has a reason. These are local reads, not network
 * calls; a healthy one answers in milliseconds. The budget is not sized for a
 * slow reply, it is sized so that a person who is simply on a loaded machine is
 * never told something failed when it was about to succeed.
 *
 * withDeadline BOUNDS THE WAIT, IT DOES NOT CANCEL THE READ -- read-deadline.js
 * is explicit about that. Fine here: both are reads, and a late answer simply
 * repaints what is already painted. */
const THIS_COMPUTER_READ_DEADLINE_MS = 10_000

/* A read that lands after Settings closed must not paint. The flag is stamped
   on the element rather than held in a closure because the three fills and the
   two exported event appliers are module functions that take only the root. */
const released = root => root.dataset.thisComputerDestroyed === 'yes'

/* Facts about the machine behind the relay, not about the browser displaying
 * the section. They live at this call site because the same source values are
 * also rendered on the desktop, where their existing wording is correct, and
 * browser-owned settings must not be swept up by a general "this" replacement.
 *
 * TRIMMED TO WHAT THIS SECTION RENDERS. The page's map also carried twins for
 * its need bodies, its standing-request list and its provider ledes; none of
 * those sentences is drawn here any more, so a twin for them would be a
 * translation nothing asks for. */
const REMOTE_SENTENCES = new Map([
  ['Not on this computer yet.', 'Not on the computer you are driving yet.'],
  ['Installed here, and signed in.', 'Installed on the computer you are driving, and signed in.'],
  ['Installed here, but nobody is signed in to it.', 'Installed on the computer you are driving, but nobody is signed in to it.'],
  ['Installed here. Press Sign in below to see where you stand.', 'Installed on the computer you are driving. Press Sign in below to see where you stand.'],
  ['We could not tell whether it is here. It may well be installed. Reopening ToolsEnabled lets it see anything added since.', 'We could not tell whether it is on the computer you are driving. It may well be installed. Reopening ToolsEnabled on that computer lets it see anything added since.'],
  [ACCOUNT_PANEL.activeNote, 'The mark shows the account the computer you are driving switched to last.'],
  ...PROVIDER_SETUP.map(provider => [
    PROVIDER_SIGN_IN.unsure(provider.name),
    `This copy could not tell whether ${provider.name} is on the computer you are driving. Both buttons still work; press the one you need.`,
  ]),
])

const machineSentence = sentence => currentDataSource() === 'relay'
  ? (REMOTE_SENTENCES.get(sentence) || readerSentence(sentence))
  : readerSentence(sentence)

/* WHAT THIS COPY CAN ACTUALLY DO WITH EACH PROGRAM, IN ONE PHRASE.
 *
 * `reach` is drawn as a visible phrase and not only as a class name, because
 * the one thing a person must not misread here is what will happen when they
 * finish following the instructions. "Nothing here starts it yet" printed
 * beside Gemini is what stops somebody installing a program, signing in, and
 * then hunting this window for the switch that would use it.
 *
 * The word for each reach is here rather than in the data because it is a
 * rendering of the value. The sentence that explains it lives in the data
 * (PROVIDER_SETUP.doesHere) and is asserted there. */
/* Exported for tools/test/reach-words-are-live.test.mjs, which fails on a reach
   word no provider uses. That gate is the reason the retired `dispatch` word
   cannot come back; see the note inside this table. */
export const REACH_WORDS = Object.freeze({
  tree: 'Works here now',
  /* It used to read 'Works on the agent page'. That named a destination the
     reader has no route to -- driven, zero doors from the state this is shown
     in -- so the word now describes the LIMIT, which is the part that is known. */
  'not-from-tree': 'Not from a tree in this copy',
  none: 'Nothing here starts it yet',
  /* THERE WAS A FOURTH WORD HERE, `dispatch`, reading "Starts from Launch
     controls, not from a tree". It is gone because its premise is gone:
     resolveStartTier() in shell/agent-host.cjs no longer refuses `local` from
     a tree, it opens on `localEngine` exactly as the claude, gemini and grok
     gates open on theirs. The owner started Local from New tree while this
     sentence was on the screen denying it. `local` now carries reach 'tree'
     with the other engine-gated providers; see the note beside PROVIDER_SETUP's
     local entry in src/first-run-needs.js.

     'not-from-tree' and 'none' are now unused too: every provider carries
     'tree'. They are left as vocabulary for states this panel may need again,
     NOT because anything checks them. If you add a provider that cannot start
     from a tree, its paragraph must say so as well --
     tools/test/reach-words-are-live.test.mjs fails a row whose tag denies a
     tree start while its own paragraph promises one, which is exactly how
     `dispatch` outlived the refusal it was written for. */
})

/* THE TAG IS A CLAIM ABOUT THIS COMPUTER (T1439). 'Works here now' printed
   above 'Not on this computer yet.' contradicted itself on every row of a fresh
   install. Once the machine answers, a program it did not report as installed
   reads what is true either way: it can run here once installed. */
export const REACH_ONCE_INSTALLED = 'Can run here once installed'
const DESKTOP_PROGRAMS = 'Programs are installed and signed in from the ToolsEnabled desktop app on your computer.'
export function reachWord(reach, presence = null) {
  if (reach === 'tree' && presence && presence.installed !== 'yes') return REACH_ONCE_INSTALLED
  return REACH_WORDS[reach] || ''
}

/* ONE ROW PER PROGRAM: THE NAME, WHAT IT REACHES, WHAT THE MACHINE SAYS, AND
   THE BUTTONS. The page put a paragraph and a numbered list under each name;
   the owner asked for simpler, and the reach phrase carries the one claim of
   that paragraph a person must not miss.

   The status line is EMPTY until the machine answers, never "checking..." and
   never a guess. A row that paints "Not installed" for a moment and corrects
   itself has told a person something false, and on a slow disk they will read
   it and act on it before it changes. So the slot is here, holds nothing, and
   is filled once by fillPresence() below -- or stays empty forever, which is
   the honest state when the read is unavailable. */
function providerMarkup(provider) {
  return `<section class="guide-provider" data-provider="${esc(provider.id)}" data-reach="${esc(provider.reach)}">
    <header class="guide-need-head">
      <h3>${esc(provider.name)}</h3>
      <p class="guide-need-tag" data-reach-tag="${esc(provider.id)}">${esc(reachWord(provider.reach))}</p>
    </header>
    <p class="guide-presence" data-presence="pending" hidden></p>
    ${signInSlotMarkup(provider)}
    ${claudeRiskMarkup(provider)}
    ${accountsSlotMarkup(provider)}
    ${localModelSlotMarkup(provider)}
  </section>`
}

/* THE PROGRAMS WHOSE SIGN-IN THIS COPY CAN START, AND IT IS ALL THREE.
   It used to be two. Codex and Claude have a real login subcommand, read off
   their own help (codex-cli 0.146.0 `login`; claude 2.1.186 `auth login`), and
   Gemini 0.53.0 has none at all -- so while the sign-in was a hidden child,
   Gemini could not have a button, because there was nothing to spawn. It is a
   terminal window now, and Gemini's sign-in is simply running the program: it
   asks how you want to sign in the first time it starts. A window can do that,
   and so all three get the same pair of buttons. */
const SIGN_IN_PROVIDERS = Object.freeze(new Set(['codex', 'claude', 'gemini', 'grok']))

/* THE PROGRAMS THAT CAN HOLD MORE THAN ONE ACCOUNT HERE, and it is not all
   three. The engine's account list understands Codex and Claude only, so a
   Gemini panel would be a control writing a file nothing reads. Gemini already
   says "nothing here starts it"; offering it accounts would contradict that on
   the same screen. */
const ACCOUNT_PROVIDERS = Object.freeze(new Set(['codex', 'claude', 'gemini', 'grok']))

/* THE WARNING SHIPS WITH THE SURFACE, NOT WITH THE READ.
 *
 * It is drawn here, in the static markup, and NOT by the asynchronous fill
 * below. That is the whole difference between a warning and a decoration: the
 * fill can fail silently -- no bridge, a browser with no preload, a read that
 * never answers -- and every one of those cases still shows a person the four
 * things they are owed before they run Claude on their own account. A warning
 * that only appears when a read succeeds is a warning that is absent exactly
 * when something is already wrong.
 *
 * It sits ABOVE the account list on purpose. A person reads it before they add
 * a second Claude account, not after. */
function claudeRiskMarkup(provider) {
  if (provider.id !== 'claude') return ''
  return `<section class="guide-risk" data-risk="claude">
    <h4 class="guide-risk-head">${esc(CLAUDE_ACCOUNT_RISK.heading)}</h4>
    <ol class="guide-risk-points">${CLAUDE_ACCOUNT_RISK.points.map(point => `<li>${esc(readerSentence(point))}</li>`).join('')}</ol>
    <p class="guide-risk-today">${esc(readerSentence(CLAUDE_ACCOUNT_RISK.today))}</p>
  </section>`
}

/* An EMPTY, HIDDEN slot, filled once by fillAccounts() or left as it is.
 *
 * Same rule as the presence line above it, and for the same reason. `npm run
 * dev` serves Settings in a plain browser with no preload, so there is no
 * bridge to answer; a build with the channel removed looks identical. Drawing
 * the add row statically would put a name field and a button in front of a
 * person in both cases, and pressing it would do nothing at all. So the
 * controls arrive only with the answer that proves they can work. */
function accountsSlotMarkup(provider) {
  if (!ACCOUNT_PROVIDERS.has(provider.id)) return ''
  return `<div class="guide-accounts-panel"
    data-accounts-provider="${esc(provider.id)}"
    data-accounts-program="${esc(provider.name)}" hidden></div>`
}

/* THE FOUR RUNTIMES A LOCAL MODEL MIGHT BE SERVING FROM, read live off the
   engine's own table at call time (detectLocal()'s answer), never copied here
   -- this set exists only to route an install/pull EVENT PACKET back to the
   one local-model slot, not to describe what is curated or installable. */
const LOCAL_RUNTIME_IDS = Object.freeze(new Set(['ollama', 'lm-studio', 'llama-cpp', 'vllm']))

/* AN EMPTY, HIDDEN slot for the local-model panel, under the same rule as
   accountsSlotMarkup and signInSlotMarkup: the controls arrive only with the
   answer that proves they can work, filled by fillLocalModel() below or left
   hidden forever on a build with no local-model channel.

   ONE SLOT, NOT FOUR. Unlike the sign-in panels (one per CLI program), there
   is a single local-model panel regardless of how many of the four runtimes
   exist -- detectLocal() answers about all of them at once, and a person
   setting this up for the first time is choosing "a local model", not picking
   a runtime up front. */
function localModelSlotMarkup(provider) {
  if (provider.id !== 'local') return ''
  return `<div class="guide-local-model" data-local-model hidden></div>`
}

/* AN EMPTY, HIDDEN slot for the two buttons, under the accounts panel's rule
 * exactly: the controls arrive only with the answer that proves they can work.
 * It is filled by fillPresence() below -- the same read that gates it -- or
 * stays hidden forever, which is what `npm run dev` in a plain browser and a
 * build without the channel both honestly are.
 *
 * WHY BUTTONS AND NOT COMMANDS. This section used to print the install line and
 * the sign-in line for every program, for the person to copy. The first
 * external user of 1.0.20 typed them and got stuck: the window their install
 * ran in could not see the new program, and told them "codex login" was not a
 * command. So the commands are gone from the section and there are two buttons
 * instead -- Install, which fetches the program from its maker and runs the
 * install here, and Sign in, which opens a FRESH terminal window with that
 * program's own sign-in already running in it. A fresh window can always see
 * what the install just put on the computer, which is the whole of the defect,
 * and the person finishes the sign-in in their own window rather than through
 * anything of ours. */
function signInSlotMarkup(provider) {
  if (!SIGN_IN_PROVIDERS.has(provider.id)) return ''
  return `<div class="guide-signin"
    data-signin-provider="${esc(provider.id)}"
    data-signin-program="${esc(provider.name)}" hidden></div>`
}

/* ONE PROGRAM'S SIGN-IN CONTROLS, PAINTED AND WIRED, given the presence answer
 * that just arrived. Repainted whole on every presence read, the same shape
 * paintAccounts uses and for the same reason: after anything changes, the one
 * honest state is whatever the machine says next. */
function paintSignIn(root, presence) {
  const panel = root.querySelector(`.guide-signin[data-signin-provider="${presence.id}"]`)
  if (!panel) return
  const bridge = window.mcProviders
  const loginStart = typeof bridge?.loginStart === 'function' ? bridge.loginStart.bind(bridge) : null
  const installStart = typeof bridge?.installStart === 'function' ? bridge.installStart.bind(bridge) : null
  const loginStop = typeof bridge?.loginStop === 'function' ? bridge.loginStop.bind(bridge) : null
  const signInControl = controlState({ enabled: Boolean(loginStart), why: PROVIDER_SIGN_IN.signInUnavailable })
  const installControl = controlState({ enabled: Boolean(installStart), why: PROVIDER_SIGN_IN.installUnavailable })
  const stopControl = controlState({ enabled: Boolean(loginStop), why: PROVIDER_SIGN_IN.stopUnavailable })
  const unavailable = [signInControl, installControl, stopControl]
    .filter(control => control.disabled)
    .map(control => control.why)
    .join(' ')
  const program = panel.dataset.signinProgram || presence.id
  const installed = presence.installed === 'yes'
  const absent = presence.installed === 'no'
  const signInCopy = providerSignInCopy({ viaRelay: currentDataSource() === 'relay' })
  /* BOTH BUTTONS, ALWAYS, FOR EVERY PROGRAM. The earlier panel showed one of
     the two and picked which by the presence answer, so a machine that could
     not be read got neither. That is a screen with nothing on it in the one
     state where a person most needs something to press. Two buttons that are
     always there is the simpler promise and the honest one: the shell refuses
     a sign-in for a program that is not here, in a sentence that names Install
     as the fix, and it refuses an install it cannot run the same way. The
     sentence under the buttons still says what the machine reported.

     NO SECOND COPY (rc-0922). When the machine reports the program installed,
     the install button no longer offers to install it again: pressing it used
     to put a second copy on the computer and let PATH order pick which one
     ran. The same button becomes the explicit choice of a private copy in
     ToolsEnabled's own folder, and the sentence says the copy you have is
     used. 'unknown' keeps Install, because "could not tell" is not "you have
     it". */
  /* A BROWSER COPY HAS NO PROGRAM BRIDGE (T1526). It said both buttons still
     work under three disabled buttons, then told the visitor to update an
     installed copy that does not exist. Say where installing happens, and do
     not claim a disabled button works. */
  const browserCopy = !bridge && !onDesktop()
  const note = browserCopy ? DESKTOP_PROGRAMS
    : installed
      ? `${PROVIDER_SIGN_IN.usesYours(program)} ${presence.signedIn === 'yes' ? PROVIDER_SIGN_IN.alreadyIn : PROVIDER_SIGN_IN.lead(program)}`
      : absent ? `${signInCopy.absent(program)} ${PROVIDER_SIGN_IN.installLead(program)}`
        : signInControl.disabled && installControl.disabled ? PROVIDER_SIGN_IN.unsure(program).replace(/ Both buttons still work; press the one you need\.$/, '')
          : PROVIDER_SIGN_IN.unsure(program)

  panel.dataset.signinState = installed ? 'sign-in' : (absent ? 'install' : 'unsure')
  panel.innerHTML = `
    <div class="guide-signin-row">
      <button class="guide-account-btn guide-signin-btn" type="button"
        data-signin-install${installed ? '="private"' : ''}${installControl.disabled ? ` disabled title="${esc(installControl.why)}"` : (installed ? ` title="${esc(PROVIDER_SIGN_IN.privateLead(program))}"` : '')}>${esc(installed ? PROVIDER_SIGN_IN.privateButton : PROVIDER_SIGN_IN.installButton(program))}</button>
      <button class="guide-account-btn guide-signin-btn" type="button"
        data-signin-start${signInControl.disabled ? ` disabled title="${esc(signInControl.why)}"` : ''}>${esc(PROVIDER_SIGN_IN.button(program))}</button>
      <button class="guide-account-btn guide-signin-btn" type="button"
        data-signin-stop hidden${stopControl.disabled ? ` disabled title="${esc(stopControl.why)}"` : ''}>${esc(PROVIDER_SIGN_IN.stopButton)}</button>
    </div>
    <p class="guide-step-note" data-signin-note>${esc(readerSentence(note))}</p>
    <p class="guide-step-note" data-signin-copy hidden></p>
    <output class="guide-accounts-note" role="status" data-signin-status>${esc(browserCopy ? '' : readerSentence(unavailable))}</output>
    <pre class="guide-command guide-signin-log" data-signin-log hidden></pre>`
  panel.hidden = false

  const status = panel.querySelector('[data-signin-status]')
  const log = panel.querySelector('[data-signin-log]')
  const stop = panel.querySelector('[data-signin-stop]')

  /* A refusal that carries its own sentence is shown as itself -- prefixing
     "that could not be started" onto "the installer needs npm" was measured on
     the first drive of this panel, and it blames the wrong program. The generic
     line is only for a refusal that arrives empty. */
  const refuse = (answer) => {
    const why = answer && typeof answer.reason === 'string' && answer.reason.trim() ? answer.reason.trim() : ''
    if (status) status.textContent = readerSentence(why || PROVIDER_SIGN_IN.refused)
  }

  /* THE SIGN-IN LEAVES ONE SENTENCE AND NOTHING ELSE. There is no stream to
     show and no Stop to offer: the window belongs to the person from the
     moment it opens, and this product neither reads it nor closes it. */
  if (signInControl.enabled) panel.querySelector('[data-signin-start]')?.addEventListener('click', async () => {
    const answer = await loginStart({ provider: presence.id }).catch(() => null)
    if (!answer || answer.ok !== true) { refuse(answer); return }
    if (status) status.textContent = readerSentence(PROVIDER_SIGN_IN.opened(program))
  })

  /* The install is the half that runs here, so it is the half with a log and a
     Stop. */
  if (installControl.enabled) panel.querySelector('[data-signin-install]')?.addEventListener('click', async () => {
    const answer = await installStart(installed ? { provider: presence.id, privateCopy: true } : { provider: presence.id }).catch(() => null)
    if (!answer || answer.ok !== true) { refuse(answer); return }
    if (log) { log.textContent = ''; log.hidden = false }
    if (status) status.textContent = readerSentence(PROVIDER_SIGN_IN.installRunning)
    if (stop) stop.hidden = false
    if (stopControl.disabled && status) status.textContent = readerSentence(`${PROVIDER_SIGN_IN.installRunning} ${stopControl.why}`)
    await recoverInstallPanel(panel, presence.id)
  })

  if (stopControl.enabled) stop?.addEventListener('click', async () => {
    const answer = await loginStop({ provider: presence.id }).catch(() => null)
    if (!answer || answer.ok !== true) { refuse(answer); return }
    const pending = answer.stopping === true || answer.running === true
    if (status) status.textContent = readerSentence(pending ? PROVIDER_SIGN_IN.installStopping : PROVIDER_SIGN_IN.installStopped)
    if (stop) stop.hidden = !pending
    await recoverInstallPanel(panel, presence.id)
  })
  void recoverInstallPanel(panel, presence.id)
  if (installed) void fillCopyLine(panel, presence.id)
}

/* WHICH COPY IS USED, WHOSE IT IS AND ITS VERSION (rc-0922), read from
 * window.mcProviders.toolchainStatus(): words, a version and a count, never a
 * path. A copy of the app without that verb, or an answer that does not come,
 * leaves the line hidden -- the sentence above is still true without it. One
 * read serves every program row on the page. */
const toolchainReads = new WeakMap()
function toolchainStatusFor(panel) {
  const bridge = window.mcProviders
  if (typeof bridge?.toolchainStatus !== 'function') return Promise.resolve(null)
  const key = panel.ownerDocument || globalThis
  const held = toolchainReads.get(key)
  if (held && Date.now() - held.at < 2000) return held.read
  const read = withDeadline(bridge.toolchainStatus(), THIS_COMPUTER_READ_DEADLINE_MS, 'which copy is used').catch(() => null)
  toolchainReads.set(key, { at: Date.now(), read })
  return read
}

export function copyLineFor(row) {
  if (!row || row.installed !== 'yes' || row.client) return ''
  const who = PROVIDER_SIGN_IN.copyWho[row.channel] || PROVIDER_SIGN_IN.copyWho.unknown
  const line = PROVIDER_SIGN_IN.copyLine({ version: typeof row.version === 'string' ? row.version : null, who, copies: Number(row.copies) || 1 })
  return row.owner === 'person' && typeof row.updateCommand === 'string' && row.updateCommand
    ? `${line} ${PROVIDER_SIGN_IN.copyUpdate(row.updateCommand)}` : line
}

async function fillCopyLine(panel, providerId) {
  const answer = await toolchainStatusFor(panel)
  const row = answer && answer.available === true && Array.isArray(answer.providers)
    ? answer.providers.find(entry => entry && entry.id === providerId && !entry.client) : null
  const text = copyLineFor(row)
  const line = panel.querySelector('[data-signin-copy]')
  if (!line || !text) return
  line.textContent = readerSentence(text)
  line.hidden = false
}

/* What the stream of one running install does to the glass, and it is the only
 * stream this section has left. The log holds the installer's own words --
 * colour-stripped and bounded by the shell -- because a person waiting on a
 * download needs exactly what it said, not a summary of it. On exit the
 * presence read runs again: the sentence at the top of the section is the truth
 * about whether the program is here now, so it is re-asked rather than inferred
 * from an exit code.
 *
 * A SIGN-IN SENDS NOTHING HERE, ON PURPOSE. It runs in the person's own
 * terminal window, which this product does not read and cannot report on. */
function installTimedOut(outcome) {
  return outcome?.timedOut === true || outcome?.stopReason === 'timeout'
}

function installFailureText(outcome) {
  return installTimedOut(outcome) ? PROVIDER_SIGN_IN.installTimedOut
    : outcome?.stopped === true ? PROVIDER_SIGN_IN.installStopped : PROVIDER_SIGN_IN.installDoneFail
}

function applyLoginEvent(root, packet) {
  if (!packet || typeof packet !== 'object') return
  const panel = root.querySelector(`.guide-signin[data-signin-provider="${packet.provider}"]`)
  if (!panel) return
  const status = panel.querySelector('[data-signin-status]')
  const log = panel.querySelector('[data-signin-log]')
  const stop = panel.querySelector('[data-signin-stop]')
  // A line or exit may overtake an IPC snapshot already in flight. Request a
  // fresh read before painting that event, so the older answer is discarded.
  if (packet.kind === 'line' || packet.kind === 'exit' || packet.kind === 'state') {
    void recoverInstallPanel(panel, packet.provider)
  }
  if (packet.kind === 'line' && log) {
    log.hidden = false
    log.textContent += `${packet.text}\n`
  } else if (packet.kind === 'exit') {
    if (stop) stop.hidden = true
    const install = panel.querySelector('[data-signin-install]')
    if (install) install.disabled = typeof window.mcProviders?.installStart !== 'function'
    if (packet.code === 0) {
      /* A finished install changes what the sentence beside the name should
         say, so the whole panel is re-asked from a fresh presence read -- the
         same one-honest-state rule paintAccounts follows. The installer's log
         goes with it, which is the right moment to lose it. */
      void fillPresence(root)
      return
    }
    if (status) status.textContent = readerSentence(installFailureText(packet))
    void fillPresence(root, { repaintSignIn: false })
  }
}


export function applyInstallSnapshot(panel, snap) {
  if (!panel) return
  const stop = panel.querySelector('[data-signin-stop]')
  const log = panel.querySelector('[data-signin-log]')
  const status = panel.querySelector('[data-signin-status]')
  const install = panel.querySelector('[data-signin-install]')
  if (!snap || snap.ok !== true || snap.known !== true) return
  if (!['running', 'stopping', 'failed', 'completed', 'idle'].includes(snap.state)) return
  const live = snap.state === 'running' || snap.state === 'stopping'
  if (stop) stop.hidden = !live
  if (install) {
    const available = typeof globalThis.window?.mcProviders?.installStart === 'function'
    install.disabled = live || !available
    install.title = live ? PROVIDER_SIGN_IN.installBusy : available ? '' : PROVIDER_SIGN_IN.installUnavailable
  }
  if (log && Array.isArray(snap.lines)) {
    log.hidden = snap.lines.length === 0
    log.textContent = snap.lines.length ? snap.lines.join('\n') + '\n' : ''
  }
  if (live) {
    const activity = snap.cleanupUnconfirmed === true
      ? PROVIDER_SIGN_IN.installCleanupUnconfirmed : snap.state === 'stopping'
        ? PROVIDER_SIGN_IN.installStopping : PROVIDER_SIGN_IN.installRunning
    if (status) status.textContent = readerSentence(installTimedOut(snap)
      ? `${PROVIDER_SIGN_IN.installTimeoutLead} ${activity}` : activity)
    return
  }
  if (status && snap.state === 'failed') status.textContent = readerSentence(installFailureText(snap))
  if (status && snap.state === 'completed') status.textContent = readerSentence(PROVIDER_SIGN_IN.installDone)
}

const installRecovery = new WeakMap()
async function recoverInstallPanel(panel, providerId) {
  const bridge = window.mcProviders
  if (typeof bridge?.installSnapshot !== 'function') return
  let recovery = installRecovery.get(panel)
  if (!recovery) {
    recovery = { requested: 0, pending: null }
    installRecovery.set(panel, recovery)
  }
  recovery.requested += 1
  if (recovery.pending) return recovery.pending
  recovery.pending = (async () => {
    for (;;) {
      const requested = recovery.requested
      let snap = null
      try {
        snap = await withDeadline(bridge.installSnapshot({ provider: providerId }), THIS_COMPUTER_READ_DEADLINE_MS, 'install state')
      } catch { /* Existing stream state remains visible when the read fails. */ }
      if (requested !== recovery.requested) continue
      applyInstallSnapshot(panel, snap)
      return
    }
  })().finally(() => { recovery.pending = null })
  return recovery.pending
}

/* THE VRAM SENTENCE, PER CURATED MODEL. The number is read straight off
   whatever detectLocal() just answered -- itself a live read of the engine's
   own CURATED_MODELS -- so nothing here is a copy of a number that could go
   stale. A model with no known figure (LOCAL-MODELS.md: "label their fit as
   unknown rather than inventing one") gets the honest fallback. */
function vramSentence(model) {
  if (!model || !Number.isFinite(model.minFreeVramBytes)) return LOCAL_MODEL_SETUP.vramUnknown
  const giB = (model.minFreeVramBytes / (1024 ** 3)).toFixed(1)
  return LOCAL_MODEL_SETUP.vramNeeded(giB)
}

/* THE LOCAL-MODEL PANEL, PAINTED AND WIRED, given whatever detectLocal() just
 * answered. Repainted whole on every read, the same shape paintSignIn and
 * paintAccounts already use and for the same reason: after anything changes,
 * the one honest state is whatever the machine says next.
 *
 * BOTH ACTIONS, ALWAYS OFFERED. Same rule as paintSignIn's own "BOTH BUTTONS,
 * ALWAYS" -- Install and every curated model's Download button are drawn
 * whether or not this read found a runtime already listening, and the shell's
 * OWN refusal (installRuntime()/pullLocalModel() in shell/provider-login.cjs)
 * explains when a press cannot work, in its own words, rather than this section
 * guessing in advance and getting it wrong.
 */
export function paintLocalModel(root, answer) {
  const slot = root.querySelector('[data-local-model]')
  if (!slot) return
  const bridge = window.mcProviders
  const installRuntime = typeof bridge?.installRuntime === 'function' ? bridge.installRuntime.bind(bridge) : null
  const pullLocalModel = typeof bridge?.pullLocalModel === 'function' ? bridge.pullLocalModel.bind(bridge) : null
  const stopRuntime = typeof bridge?.stopRuntime === 'function' ? bridge.stopRuntime.bind(bridge) : null
  const installControl = controlState({ enabled: Boolean(installRuntime), why: LOCAL_MODEL_SETUP.installUnavailable })
  const pullControl = controlState({ enabled: Boolean(pullLocalModel), why: LOCAL_MODEL_SETUP.pullUnavailable })
  const stopControl = controlState({ enabled: Boolean(stopRuntime), why: LOCAL_MODEL_SETUP.stopUnavailable })

  /* THE READINESS LINE IS ALWAYS THIS FILE'S OWN SENTENCE, NEVER
     detectLocal()'s RAW `reason` STRING. That field is engine-generated at
     runtime ("No local model runtime is listening on 127.0.0.1 (checked
     ollama, lm-studio, llama-cpp, vllm).") -- true, but it reads as a log
     line, names runtime ids as if the reader already knows them, and prints
     a bare loopback address. LOCAL_MODEL_SETUP owns the plain-language
     version of the same fact, the same division of labour presenceSentence()
     already keeps for the three CLI programs above. */
  const ok = Boolean(answer && answer.ok === true)
  const readiness = ok
    ? (answer.ready ? LOCAL_MODEL_SETUP.ready(answer.selected) : LOCAL_MODEL_SETUP.notReady)
    : LOCAL_MODEL_SETUP.unknown
  const curated = ok && Array.isArray(answer.curatedModels) ? answer.curatedModels : []

  slot.innerHTML = `
    <h3 class="guide-local-model-head">${esc(LOCAL_MODEL_SETUP.heading)}</h3>
    <p class="guide-need-body" data-local-readiness>${esc(readerSentence(readiness))}</p>
    <div class="guide-signin-row">
      <button class="guide-account-btn guide-signin-btn" type="button"
        data-local-install${installControl.disabled ? ` disabled title="${esc(installControl.why)}"` : ''}>${esc(LOCAL_MODEL_SETUP.installButton)}</button>
      <button class="guide-account-btn guide-signin-btn" type="button"
        data-local-stop hidden${stopControl.disabled ? ` disabled title="${esc(stopControl.why)}"` : ''}>${esc(LOCAL_MODEL_SETUP.stopButton)}</button>
    </div>
    <p class="guide-step-note">${esc(readerSentence(LOCAL_MODEL_SETUP.installLead))}</p>
    ${curated.length ? `<ul class="guide-works-list" data-local-models>${curated.map(model => `
      <li>
        <span>${esc(model.label)}</span>
        <span class="guide-step-note">&nbsp;${esc(vramSentence(model))}</span>
        <button class="guide-account-btn" type="button" data-local-pull="${esc(model.id)}"${pullControl.disabled ? ` disabled title="${esc(pullControl.why)}"` : ''}>${esc(LOCAL_MODEL_SETUP.downloadButton)}</button>
      </li>`).join('')}</ul>` : ''}
    <output class="guide-accounts-note" role="status" data-local-status></output>
    <pre class="guide-command guide-signin-log" data-local-log hidden></pre>`
  slot.hidden = false

  const status = slot.querySelector('[data-local-status]')
  const log = slot.querySelector('[data-local-log]')
  const stop = slot.querySelector('[data-local-stop]')
  let runningModel

  const refuse = (action) => {
    const why = action && typeof action.reason === 'string' && action.reason.trim() ? action.reason.trim() : ''
    if (status) status.textContent = readerSentence(why || LOCAL_MODEL_SETUP.refused)
  }

  if (installControl.enabled) slot.querySelector('[data-local-install]')?.addEventListener('click', async () => {
    const action = await installRuntime({ runtime: 'ollama' }).catch(() => null)
    if (!action || action.ok !== true) { refuse(action); return }
    if (log) { log.textContent = ''; log.hidden = false }
    if (status) status.textContent = readerSentence(LOCAL_MODEL_SETUP.installRunning)
    runningModel = undefined
    if (stop) stop.hidden = false
  })

  if (pullControl.enabled) for (const button of slot.querySelectorAll('[data-local-pull]')) {
    button.addEventListener('click', async () => {
      const model = button.dataset.localPull
      const action = await pullLocalModel({ runtime: 'ollama', model }).catch(() => null)
      if (!action || action.ok !== true) { refuse(action); return }
      if (log) { log.textContent = ''; log.hidden = false }
      if (status) status.textContent = readerSentence(LOCAL_MODEL_SETUP.downloadRunning)
      runningModel = model
      if (stop) stop.hidden = false
    })
  }

  if (stopControl.enabled) stop?.addEventListener('click', async () => {
    /* main.cjs selects the flight from model's PRESENCE, not its value. An
       install therefore omits it and a pull carries the exact model selected
       by the button. */
    const action = await stopRuntime(localModelStopPayload('ollama', runningModel)).catch(() => null)
    if (!action || action.ok !== true) { refuse(action); return }
    applyLocalModelStopAnswer({ action, status, stop })
  })
}

export function localModelStopPayload(runtime, model) {
  return model === undefined ? { runtime } : { runtime, model }
}

export function applyLocalModelStopAnswer({ action, status, stop }) {
  if (status) status.textContent = readerSentence(action.stopped === true
    ? LOCAL_MODEL_SETUP.stopped
    : GUIDE_LOCAL_MODEL_STOP_IDLE)
  if (stop) stop.hidden = true
}

/* THE LOCAL-MODEL TWIN OF applyLoginEvent, routing the SAME
 * mc-provider-login:event stream by a different key: a runtime id
 * (ollama/lm-studio/llama-cpp/vllm) rather than a CLI provider id. There is
 * one local-model slot per section rather than one per runtime, so every
 * matching packet lands on the single slot regardless of which runtime it
 * names -- an install and a pull can never be confused for one another
 * because installRuntime()/pullLocalModel() in shell/provider-login.cjs use
 * disjoint flight keys, and this section only ever has one of each in flight at
 * a time by construction (the buttons that would start a second are still
 * enabled, but the shell's own LOCAL_MODEL_*_RUNNING refusal catches it, the
 * same belt-and-braces installStart() already relies on). */
export function applyLocalModelEvent(root, packet) {
  if (!packet || typeof packet !== 'object' || !LOCAL_RUNTIME_IDS.has(packet.provider)) return
  const slot = root.querySelector('[data-local-model]')
  if (!slot) return
  const status = slot.querySelector('[data-local-status]')
  const log = slot.querySelector('[data-local-log]')
  const stop = slot.querySelector('[data-local-stop]')
  if (packet.kind === 'line' && log) {
    log.hidden = false
    log.textContent += `${packet.text}\n`
  } else if (packet.kind === 'exit') {
    if (stop) stop.hidden = true
    if (packet.code === 0) {
      /* A finished install or pull changes the readiness sentence at the top
         of the panel, so the whole thing is re-asked from a fresh detectLocal()
         read -- the same one-honest-state rule fillPresence's exit branch
         already follows for the three CLI programs. */
      void fillLocalModel(root)
      return
    }
    /* fly() deliberately sends null when kill() caused the exit. That is an
       action the person took, not an install or download failure. `op` is
       consumed too: it is the producer's evidence for which existing copy
       owns a genuine non-zero failure. */
    if (status) status.textContent = readerSentence(packet.code === null
      ? LOCAL_MODEL_SETUP.stopped
      : packet.op === 'pull'
        ? LOCAL_MODEL_SETUP.downloadDoneFail
        : LOCAL_MODEL_SETUP.installDoneFail)
  }
}

/* THE THIRD READ HERE, held to fillPresence's and fillAccounts's rules
 * exactly: bounded by the same deadline, and a read that cannot answer paints
 * the "could not check" state rather than leaving the slot empty forever. */
async function fillLocalModel(root) {
  const bridge = window.mcProviders
  const detectLocal = typeof bridge?.detectLocal === 'function' ? bridge.detectLocal.bind(bridge) : null
  let answer = null
  if (detectLocal) {
    try {
      answer = await withDeadline(detectLocal(), THIS_COMPUTER_READ_DEADLINE_MS, 'local models on this computer')
    } catch {
      answer = null
    }
  }
  if (released(root)) return
  paintLocalModel(root, answer)
}

function accountRowMarkup(account, activeName, removeControl) {
  const inUse = Boolean(activeName) && String(account.name).toLowerCase() === activeName.toLowerCase()
  const signedIn = account.signedIn === 'yes' ? ACCOUNT_PANEL.signedIn : ACCOUNT_PANEL.notSignedIn
  return `<li class="guide-account" data-account="${esc(account.name)}" data-signed-in="${esc(account.signedIn)}">
    <p class="guide-account-line">
      <b class="guide-account-name">${esc(account.name)}</b>
      ${inUse ? `<span class="guide-account-tag" data-account-active="yes">${esc(ACCOUNT_PANEL.inUse)}</span>` : ''}
      <span class="guide-account-state">${esc(signedIn)}</span>
    </p>
    <p class="guide-account-folder">${esc(account.directory)}</p>
    ${account.command ? `<p class="guide-step-note">${esc(readerSentence(ACCOUNT_PANEL.commandLead))}</p>
    <code class="guide-command">${esc(account.command)}</code>
    <p class="guide-step-note">${esc(machineSentence(ACCOUNT_PANEL.commandNote))}</p>`
    : `<p class="guide-step-note">Use this account’s Sign in button in the accounts menu.</p>`}
    <button class="guide-account-btn" type="button" data-account-remove="${esc(account.name)}" aria-label="${esc(ACCOUNT_PANEL.removeAccount(account.name))}"${removeControl.disabled ? ` disabled title="${esc(removeControl.why)}"` : ''}>${esc(ACCOUNT_PANEL.remove)}</button>
  </li>`
}

/* ONE PROGRAM'S ACCOUNTS, PAINTED AND WIRED.
 *
 * The whole panel is redrawn after every change rather than patched, which is
 * the shape mountProfilePanel() in src/views/computers.js already uses: a list
 * whose rows carry buttons has exactly one honest state after a write, and that
 * is whatever the store says next. */
function paintAccounts(root, panel, answer) {
  const providerId = panel.dataset.accountsProvider
  const program = panel.dataset.accountsProgram || providerId
  const mine = answer.accounts.filter(account => account && account.provider === providerId)
  const activeName = answer.active && typeof answer.active.name === 'string' ? answer.active.name : ''
  const bridge = window.mcProviders
  const accountAdd = typeof bridge?.accountAdd === 'function' ? bridge.accountAdd.bind(bridge) : null
  const accountRemove = typeof bridge?.accountRemove === 'function' ? bridge.accountRemove.bind(bridge) : null
  const addControl = controlState({ enabled: Boolean(accountAdd), why: ACCOUNT_PANEL.unavailable })
  const removeControl = controlState({ enabled: Boolean(accountRemove), why: ACCOUNT_PANEL.unavailable })

  panel.innerHTML = `
    <h4 class="guide-accounts-head">${esc(ACCOUNT_PANEL.heading(program))}</h4>
    <p class="guide-step-note">${esc(readerSentence(ACCOUNT_PANEL.help))}</p>
    ${answer.damaged === true ? `<p class="guide-accounts-note">${esc(readerSentence(ACCOUNT_PANEL.unreadable))}</p>` : ''}
    ${mine.length
      ? `<ul class="guide-account-list">${mine.map(account => accountRowMarkup(account, activeName, removeControl)).join('')}</ul>
         <p class="guide-step-note">${esc(machineSentence(ACCOUNT_PANEL.activeNote))}</p>`
      : `<p class="guide-accounts-note">${esc(accountPanelCopy({ viaRelay: currentDataSource() === 'relay' }).none)}</p>`}
    <div class="guide-account-add">
      <input class="guide-account-field" type="text" data-account-name
        placeholder="${esc(ACCOUNT_PANEL.namePlaceholder)}" aria-label="${esc(ACCOUNT_PANEL.nameLabel)}"${addControl.disabled ? ' disabled' : ''}>
      <input class="guide-account-field" type="text" data-account-folder
        placeholder="${esc(ACCOUNT_PANEL.folderPlaceholder)}" aria-label="${esc(ACCOUNT_PANEL.folderLabel)}"${addControl.disabled ? ' disabled' : ''}>
      <button class="guide-account-btn" type="button" data-account-add${addControl.disabled ? ` disabled title="${esc(addControl.why)}"` : ''}>${esc(ACCOUNT_PANEL.add(program))}</button>
    </div>
    <output class="guide-accounts-note" role="status" data-account-out>${addControl.disabled || (mine.length && removeControl.disabled) ? esc(readerSentence(ACCOUNT_PANEL.unavailable)) : ''}</output>`
  panel.hidden = false

  const out = panel.querySelector('[data-account-out]')
  if (addControl.enabled) panel.querySelector('[data-account-add]')?.addEventListener('click', async () => {
    const name = panel.querySelector('[data-account-name]')?.value?.trim() || ''
    const directory = panel.querySelector('[data-account-folder]')?.value?.trim() || ''
    if (!name || !directory) {
      if (out) out.textContent = readerSentence(ACCOUNT_PANEL.needBoth)
      return
    }
    const added = await accountAdd({ name, provider: providerId, directory })
      .catch(() => null)
    if (!added || added.ok !== true) {
      if (out) out.textContent = readerSentence(ACCOUNT_PANEL.refused)
      return
    }
    /* A setup answer that waited for the first account is applied now (T1582). */
    await applyDeferredAccountPolicy().catch(() => null)
    void fillAccounts(root)
  })

  if (removeControl.enabled) for (const button of panel.querySelectorAll('[data-account-remove]')) {
    button.addEventListener('click', async () => {
      const gone = await accountRemove({ name: button.dataset.accountRemove, provider: providerId })
        .catch(() => null)
      /* ok MEANS THE CALL SUCCEEDED. `removed` MEANS SOMETHING WENT.
         shell/account-registry.cjs answers { ok: true, removed: false } when the
         named account was not on the list -- a damaged registry, or a name that no
         longer matches. This branch read `ok` alone and redrew as though it had
         removed something.
         And on a real removal it said nothing at all about SCOPE: the folder and the
         provider sign-in inside it stay, deliberately, because a person's provider
         home is theirs. Somebody handing a laptop on is exactly who presses this. */
      if (!gone || gone.ok !== true) {
        if (out) out.textContent = readerSentence(ACCOUNT_PANEL.removeRefused)
        return
      }
      if (out) {
        out.textContent = readerSentence(gone.removed === false
          ? ACCOUNT_PANEL.removeDidNothing
          : ACCOUNT_PANEL.removeScope)
      }
      void fillAccounts(root)
    })
  }
}

/* THE SECOND READ HERE, held to the first one's rules exactly.
 *
 * A list that could not be read is UNKNOWN, not empty and not a reason to hide
 * the whole panel. The panel names that reading failure and its retry; a real
 * `accounts: []` answer still takes the ordinary empty-list path in
 * paintAccounts(). */
function paintAccountsUnreadable(root) {
  if (released(root)) return
  for (const panel of root.querySelectorAll('.guide-accounts-panel')) {
    const providerId = panel.dataset.accountsProvider
    const program = panel.dataset.accountsProgram || providerId
    panel.innerHTML = `
      <h4 class="guide-accounts-head">${esc(ACCOUNT_PANEL.heading(program))}</h4>
      <p class="guide-step-note">${esc(readerSentence(ACCOUNT_PANEL.help))}</p>
      <output class="guide-accounts-note" role="status">${esc(readerSentence(ACCOUNT_PANEL.unreadable))}</output>`
    panel.hidden = false
  }
}

async function fillAccounts(root) {
  const bridge = window.mcProviders
  const accounts = typeof bridge?.accounts === 'function' ? bridge.accounts.bind(bridge) : null
  if (!accounts) {
    paintAccountsUnreadable(root)
    return
  }
  let answer = null
  try {
    answer = await withDeadline(accounts(), THIS_COMPUTER_READ_DEADLINE_MS, 'your accounts')
  } catch {
    paintAccountsUnreadable(root)
    return
  }
  if (!answer || answer.ok !== true || !Array.isArray(answer.accounts)) {
    paintAccountsUnreadable(root)
    return
  }
  if (released(root)) return
  for (const panel of root.querySelectorAll('.guide-accounts-panel')) {
    paintAccounts(root, panel, answer)
  }
}

/* ASK THE MACHINE WHAT IT HAS, AND NAME AN ANSWER THAT CANNOT BE GOT.
 *
 * THE ABSENT-BRIDGE CASE IS THE ONE THAT MATTERS, and it is not hypothetical:
 * `npm run dev` serves this section in a plain browser with no preload, so
 * window.mcProviders is undefined every time a designer opens it. It is also
 * what a future build with this channel removed would look like. Neither is
 * evidence that a program is absent: every provider gets the established
 * "could not tell" sentence, and its controls are independently gated from
 * the verbs this copy actually exposes.
 *
 * The commands and warnings remain useful, and the section no longer converts an
 * unreadable state into no state at all.
 */
async function fillPresence(root, { repaintSignIn = true } = {}) {
  const bridge = window.mcProviders
  const presence = typeof bridge?.presence === 'function' ? bridge.presence.bind(bridge) : null
  let answer = null
  if (presence) {
    try {
      answer = await withDeadline(presence(), THIS_COMPUTER_READ_DEADLINE_MS, 'what is installed')
    } catch {
      answer = null
    }
  }
  const providers = answer && answer.ok === true && Array.isArray(answer.providers)
    ? answer.providers
    : PROVIDER_SETUP.map(provider => ({ id: provider.id, installed: 'unknown', signedIn: 'unknown' }))
  if (released(root)) return

  for (const providerPresence of providers) {
    const sentence = presenceSentence(providerPresence)
    if (!sentence) continue
    const slot = root.querySelector(`.guide-provider[data-provider="${providerPresence.id}"] .guide-presence`)
    if (!slot) continue
    // In a browser there is nothing to reopen; the programs live on the desktop.
    slot.textContent = !presence && !onDesktop() ? DESKTOP_PROGRAMS : machineSentence(sentence)
    /* The state is carried as data as well as prose so a driver and a support
       conversation can read it without parsing a sentence, which is the same
       rule `data-refusal-code` follows elsewhere. */
    slot.dataset.presence = providerPresence.installed === 'yes' && providerPresence.signedIn === 'yes' ? 'ready' : 'incomplete'
    slot.dataset.installed = providerPresence.installed
    slot.dataset.signedIn = providerPresence.signedIn
    slot.hidden = false
    const tag = root.querySelector(`[data-reach-tag="${providerPresence.id}"]`)
    const reach = PROVIDER_SETUP.find(provider => provider.id === providerPresence.id)?.reach
    if (tag && reach) tag.textContent = reachWord(reach, providerPresence)
    /* The sign-in button is gated by THIS answer, so it is painted from this
       answer -- a second read could disagree with the sentence beside it. Not
       repainted after a finished flow: that path re-reads presence for the
       SENTENCE while the panel keeps the program's own last words on screen. */
    if (repaintSignIn && SIGN_IN_PROVIDERS.has(providerPresence.id)) paintSignIn(root, providerPresence)
  }
}


/* THE TWO FACTS A REPORT NEEDS, READ FROM WHAT THE PAGE ALREADY HAS.
   Absent is fine and stays absent: composeFeedback drops an empty line rather
   than writing "Version: undefined" into somebody's mail. */
function buildFacts() {
  const info = globalThis.mcBuildInfo || globalThis.__MC_BUILD__ || null
  if (!info || typeof info !== 'object') return null
  return { version: info.appVersion || info.version || '', commit: info.shortCommit || info.commit || '' }
}


/**
 * The section's live half: the four program rows, and the feedback composer.
 *
 * Returns `{ el, feedbackEl, onFeedbackAvailable, destroy }`.
 *
 *   el            the block of program rows, hosted by the
 *                 `this_computer_programs` row in src/views/settings.js.
 *   feedbackEl    the composer, hosted by the `this_computer_feedback` row. It
 *                 ships `hidden` and stays hidden -- with no listener ever
 *                 attached to the button inside it -- unless the backend
 *                 answers available.
 *   onFeedbackAvailable(listener)
 *                 called with true or false once the probe settles, and called
 *                 immediately if it already has. Settings uses it to keep the
 *                 whole ROW absent, not merely the composer inside it, which is
 *                 what the owner's rule for this control actually asks for.
 *                 Returns a function that stops listening.
 *   destroy()     releases the login-event subscription and stops every pending
 *                 read from painting. It is the only thing here that outlives
 *                 the element.
 *
 * `navigate` is deliberately NOT taken, although the brief for this module
 * named it. Nothing in here navigates: the section's other doors are ordinary
 * anchors drawn by src/views/settings.js, and the window's own hash routing
 * takes them. A parameter nothing reads is a promise this file cannot keep.
 */
export function createThisComputerSettings() {
  const root = el(`<div class="guide-programs" data-this-computer-programs>
      ${PROVIDER_SETUP.map(providerMarkup).join('')}
    </div>`)

  /* THE FEEDBACK CONTROL, GATED ON THE PROBE -- the "?" door itself.
   *
   * Every other absent-or-unready control here is offered anyway, DISABLED,
   * with a reason beside it (see paintSignIn and paintAccounts above). This one
   * is different by owner ruling: "door absent when the backend doesn't answer,
   * never a dead button." So it starts `hidden` in the markup below and is
   * revealed ONLY on a confirmed `available: true` from
   * src/feedback-compose.js's probeFeedbackAvailable -- everything else,
   * including a probe that could not even run, leaves it exactly as it was:
   * absent, with no listener ever attached to the button inside it. */
  const feedbackRoot = el(`<section class="guide-need guide-feedback" data-need="feedback" data-feedback-available="unknown" hidden>
      <header class="guide-need-head">
        <h2>${esc(FEEDBACK_COPY.heading)}</h2>
      </header>
      <p class="guide-need-body">${esc(FEEDBACK_COPY.intro)}</p>
      <textarea class="ctl-textarea guide-feedback-text" data-feedback-text rows="5"
        maxlength="${MAX_MESSAGE_CHARACTERS}" aria-label="${esc(FEEDBACK_COPY.heading)}"></textarea>
      <label class="guide-feedback-build"><input type="checkbox" data-feedback-build /> ${esc(FEEDBACK_COPY.includeBuild)}</label>
      <p class="guide-need-body guide-feedback-why">${esc(FEEDBACK_COPY.buildWhy)}</p>
      <button type="button" class="ctl-btn" data-feedback-send>${esc(FEEDBACK_COPY.send)}</button>
      <p class="guide-need-body" data-feedback-status role="status" hidden></p>
    </section>`)

  let destroyed = false

  /* THREE READS, AND THEY ARE THREE ON PURPOSE. They answer different questions
     and fail apart: a machine can report its programs and still have no account
     list, an account list must not be able to blank the presence line, and a
     machine with no CLI programs at all can still have a local runtime serving
     a model. */
  /* Subscribe before the first paint so a running installer cannot finish
     its next line into a listener that does not exist yet. Snapshot then
     recovers lines already printed. */
  const releaseLoginEvents = typeof window.mcProviders?.onLoginEvent === 'function'
    ? window.mcProviders.onLoginEvent(packet => {
      if (destroyed) return
      applyLoginEvent(root, packet)
      applyLocalModelEvent(root, packet)
    })
    : null

  fillPresence(root)
  fillAccounts(root)
  fillLocalModel(root)

  const feedbackSend = feedbackRoot.querySelector('[data-feedback-send]')
  const feedbackStatus = feedbackRoot.querySelector('[data-feedback-status]')
  const sayFeedback = sentence => {
    if (!feedbackStatus) return
    feedbackStatus.textContent = sentence
    feedbackStatus.hidden = !sentence
  }

  let feedbackSettled = null
  const feedbackListeners = new Set()

  /* ONE READ, AT MOUNT, never polled -- fillPresence's rule above, and the same
     reason: a person who installs the backend and comes back later gets the new
     answer by opening Settings again. */
  async function fillFeedback() {
    const available = await probeFeedbackAvailable()
    if (destroyed) return
    feedbackSettled = available === true
    feedbackRoot.dataset.feedbackAvailable = feedbackSettled ? 'yes' : 'no'
    for (const listener of feedbackListeners) listener(feedbackSettled)
    if (!feedbackSettled) return // stays hidden and stays inert: the door is absent, not merely disabled
    feedbackRoot.hidden = false
    if (!feedbackSend) return
    feedbackSend.addEventListener('click', async () => {
      const text = feedbackRoot.querySelector('[data-feedback-text]')?.value ?? ''
      const includeBuild = Boolean(feedbackRoot.querySelector('[data-feedback-build]')?.checked)
      /* DISABLED FOR THE ROUND TRIP, so a second press mid-send cannot open a
         second submission of the same words -- the same reason the install
         button in paintSignIn hides Stop until there is something to stop. */
      feedbackSend.disabled = true
      sayFeedback(FEEDBACK_COPY.sending)
      const result = await submitFeedback({ message: text, includeBuild, build: buildFacts() })
      if (destroyed) return
      feedbackSend.disabled = false
      sayFeedback(result.why)
    })
  }
  fillFeedback()

  return {
    el: root,
    feedbackEl: feedbackRoot,
    onFeedbackAvailable(listener) {
      if (typeof listener !== 'function') return () => {}
      feedbackListeners.add(listener)
      if (feedbackSettled !== null) listener(feedbackSettled)
      return () => { feedbackListeners.delete(listener) }
    },
    destroy() {
      destroyed = true
      root.dataset.thisComputerDestroyed = 'yes'
      feedbackListeners.clear()
      if (releaseLoginEvents) releaseLoginEvents()
    },
  }
}
