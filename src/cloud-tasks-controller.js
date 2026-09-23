/* Codex Cloud: the half that has no DOM.
 *
 * WHY THIS IS ITS OWN FILE. Everything here decides something -- what a
 * provider answer means, whether a launch may proceed, when to stop watching a
 * task -- and every one of those decisions is exactly what a test has to be able
 * to exercise without a browser. Its sibling `cloud-tasks.js` imports a
 * stylesheet, which a plain `node --test` run cannot load, so keeping the rules
 * in the same file as the markup would have made the rules untestable. The two
 * mounts over there share this one controller for the same reason: two copies of
 * the confirm-then-send rule would eventually disagree, and the one that
 * disagreed would be the one that launched something.
 *
 * The fail-closed rules this file owns, each of which is the answer to a real
 * defect class in this codebase (a missing field read as permission):
 *   - an unread environment list never permits a launch;
 *   - an environment absent from an INCOMPLETE reading is unproven, not absent;
 *   - an environment with no single source repository cannot be launched into;
 *   - a branch is never defaulted to "main" from nothing;
 *   - UNKNOWN never ends the status watch, and the watch is bounded in both
 *     interval and count so it can never become a background job nobody started;
 *   - a reply that carries no diff is a refusal, never an empty diff, because
 *     the second one would tell somebody their finished task did nothing.
 */
import { isWriteEnabled } from './write-flags.js'
import { postBridgeAction } from './mission-bridge.js'
/* [B6] Five lines on this panel used to open with a bare identifier. On the one
   surface in the product that can spend money, the first thing the eye landed
   on was the one token that meant nothing to the person spending it. */
import { refusalCodeOf, refusalSentence } from './refusal-copy.js'
import {
  WRITE_OUTCOME_KEYS,
  clearUndeliveredWrite,
  recordUndeliveredWrite,
  restatedMessage,
  undeliveredWrite,
} from './write-outcomes.js'

/* THE STATE VOCABULARY THE PERSON READS.
 *
 * The capability layer speaks a provider-neutral enum (contract.js) that maps
 * Codex Cloud's own words onto six values. Those six are the honest set and
 * this table is the ONLY place they become English, so a status can never be
 * described one way in the task list and another beside the launch button.
 *
 * `UNKNOWN` is a first-class row here rather than a fallback, and that is the
 * load-bearing decision. The provider reports statuses this product has never
 * seen -- the adapter's own comments record two that were added only after
 * being observed live -- and the failure mode a status view must not have is
 * rounding an unrecognised state toward "finished". A person who is told
 * "unknown" goes and looks; a person who is told "finished" does not.
 */
export const CLOUD_STATES = Object.freeze({
  SUBMITTED: Object.freeze({ label: 'queued', tone: 'pending' }),
  RUNNING: Object.freeze({ label: 'running', tone: 'pending' }),
  SUCCEEDED: Object.freeze({ label: 'finished', tone: 'good' }),
  FAILED: Object.freeze({ label: 'failed', tone: 'bad' }),
  CANCELLED: Object.freeze({ label: 'cancelled', tone: 'bad' }),
  UNKNOWN: Object.freeze({ label: 'unknown', tone: 'unknown' }),
})

/* The three states that end the watch. UNKNOWN is deliberately NOT one of them:
   the capability layer answers UNKNOWN for a task its bounded search window did
   not reach, and a task that has simply scrolled out of the first pages is still
   running. Stopping there would report "we stopped looking" as "it is over". */
export const TERMINAL_CLOUD_STATES = Object.freeze(['SUCCEEDED', 'FAILED', 'CANCELLED'])

export function cloudStateView(state) {
  return CLOUD_STATES[state] || CLOUD_STATES.UNKNOWN
}

/* The account line, from readings only. `usedPercent` is null whenever the
   provider did not answer, and null must never render as 0% -- "we could not
   ask" and "nothing used" are opposite facts and the second one invites a
   launch that the first one cannot promise. */
export function accountSummary(account) {
  if (!account || typeof account !== 'object') return 'account unknown'
  const parts = [account.name || 'unnamed']
  if (account.role) parts.push(account.role)
  parts.push(Number.isFinite(account.usedPercent) ? `${Math.round(account.usedPercent)}% used` : 'usage unknown')
  return parts.join(' · ')
}

/* Whether this installation can be asked to launch at all, expressed as the
   sentence the surface shows. Separated from the DOM so the reason is one
   string with one owner, and so the flag-off case is a described state rather
   than an absent panel. */
/* `mcShell` EXISTING is not the desktop app any more. The website's
   host-bridge.js defines window.mcShell too (getBridgeEndpoint plus the relay
   transport), so `Boolean(globalThis.mcShell)` reads true in a signed-in
   browser and this panel presented itself as live there -- the refusal below
   became unreachable on the one surface it was written for. getBridgeProof is
   the discriminator: the desktop preload exposes it, and host-bridge.js
   deliberately withholds it ("a second closed door behind the first"), so its
   presence means the shell that can actually spawn a launch is behind us. */
export function cloudAvailability({ writeEnabled = isWriteEnabled('cloud-launch'), inShell = typeof globalThis.mcShell?.getBridgeProof === 'function' } = {}) {
  if (!inShell) {
    return Object.freeze({
      ok: false,
      code: 'CLOUD_SHELL_REQUIRED',
      note: 'Codex Cloud needs the ToolsEnabled desktop app; this surface is inert in a browser.',
    })
  }
  if (!writeEnabled) {
    return Object.freeze({
      ok: false,
      code: 'CLOUD_LAUNCH_SWITCHED_OFF',
      /* The panel is DRAWN in this state rather than removed. Every other write
         surface disappears when its flag is off, which is exactly why "switched
         off pending review" and "this product has no cloud feature" have looked
         the same from inside the app for as long as the flag has existed. A
         person cannot turn on a switch they have never been shown, so the switch
         is ALSO offered on the panel rather than only in Settings -- same flag,
         same durable setting, reachable from where the feature is. */
      note: 'Codex Cloud launching is switched off. Turn it on here or in Settings › Write. Nothing is contacted while it is off.',
    })
  }
  return Object.freeze({ ok: true, code: null, note: 'Codex Cloud ready.' })
}

export const ENVIRONMENT_ID = /^[0-9a-f]{32}$/
const REMEMBERED_KEY = 'mc.cloud.last'
/* Fifteen seconds between checks, for at most fifteen minutes of watching. Both
   bounds are here rather than open-ended for the same reason the capability
   layer's paging is bounded: an unbounded poll is a background job nobody
   started, and it would keep spawning a provider CLI long after the person who
   pressed Launch has walked away. When the budget runs out the surface SAYS the
   watch stopped and that the task may still be running -- it never implies the
   task ended. */
export const WATCH_INTERVAL_MS = 15_000
export const WATCH_FIRST_DELAY_MS = 2_000
export const WATCH_MAX_CHECKS = 60

export function readRemembered() {
  try {
    const parsed = JSON.parse(localStorage.getItem(REMEMBERED_KEY) || 'null')
    if (!parsed || typeof parsed !== 'object') return { environment: '', branch: '' }
    return {
      environment: typeof parsed.environment === 'string' && ENVIRONMENT_ID.test(parsed.environment) ? parsed.environment : '',
      branch: typeof parsed.branch === 'string' ? parsed.branch.slice(0, 200) : '',
    }
  } catch { return { environment: '', branch: '' } }
}

function writeRemembered(value) {
  /* The environment id and branch only. NOT the prompt: a task body is the one
     field a person is most likely to paste something sensitive into, and this
     store is a plain file on disk. The bridge already refuses credential-shaped
     prompt text before it reaches the provider; keeping it out of local
     persistence as well means a refused launch leaves nothing behind either. */
  try { localStorage.setItem(REMEMBERED_KEY, JSON.stringify({ environment: value.environment || '', branch: value.branch || '' })) }
  catch { /* a session-only memory is still better than none */ }
}

/* One discovered environment, as one line of English.
 *
 * Two of this machine's real environments share a display label, and two more
 * differ only by which account owns them, so the label ALONE cannot identify a
 * choice. The account and a short id prefix are part of the option text for that
 * reason -- not decoration. */
export function environmentSummary(environment) {
  if (!environment || typeof environment !== 'object') return 'environment unknown'
  const parts = [environment.label || environment.repository || environment.environmentId]
  if (Array.isArray(environment.accounts) && environment.accounts.length) parts.push(environment.accounts.join(', '))
  if (typeof environment.environmentId === 'string') parts.push(environment.environmentId.slice(0, 6))
  if (environment.launchable !== true) parts.push('no single repository — cannot launch')
  return parts.join(' · ')
}

/* What the person is told about the environment list itself. The incomplete
   case has its own sentence because an environment MISSING from a partial
   reading has not been shown to be unauthorized, and a surface that renders a
   partial list as the whole set turns "we could not ask" into "you do not have
   it" -- the absence-as-answer defect this codebase keeps finding. */
/* NOBODY HAS SIGNED IN HERE YET, WHICH IS A STATE AND NOT A FAILURE.
 *
 * THE DEFECT THIS CLOSES, and it is the whole of the owner's finding 8. On a
 * computer with no Codex account the capability layer threw -- a first run was
 * modelled exclusively as an error, with no success shape that could say "we
 * looked, and there are none" -- so this panel had nothing to render but a
 * refusal, and it rendered it TWICE, once for the accounts and once for the
 * environments, because one condition was published into two slots. Two
 * near-identical 47-word paragraphs, one under the other, for a person who had
 * simply never signed in. His words: "almost impossible for a human to make any
 * meaning of."
 *
 * The engine answers with an empty reading now (src/lib/cloud-agent/codex-cloud-launch.js),
 * and this is the sentence for it: what is true, and the one thing to do. */
/* THE SECOND HALF OF THAT DEFECT, WHICH SURVIVED THE FIRST FIX. This sentence
 * ended "Sign in to Codex Cloud on this computer, then press Refresh", and that
 * was a dead end wearing an instruction: signing Codex in the ordinary way does
 * NOT put an account on this list. The list is a registry the cloud lane reads,
 * and until now nothing in the product wrote it -- the two accounts running
 * cloud tasks on the builder's own machine were typed into a JSON file in an
 * editor. So a customer who did exactly what this sentence said came back,
 * pressed Refresh, and read the same sentence again.
 *
 * There is a control under it now. What the sentence promises is what that
 * control does: a name is the only thing they type. */
export const NO_ACCOUNT_TEXT = 'No Codex account is set up on this computer yet, so there is nothing to show here. Add one below: give it a name, and this computer makes its folder and opens the sign-in for you.'

export function environmentsMessage({ loaded, environments, complete, signedIn = true }) {
  if (!loaded) return { tone: 'note', text: 'Environments not read yet.' }
  /* Before anything about environments, because an environment belongs to an
     account: with no account, "no environment is authorized for the configured
     accounts" describes accounts that do not exist. */
  if (signedIn === false) return { tone: 'note', text: NO_ACCOUNT_TEXT }
  const usable = environments.filter(environment => environment.launchable === true).length
  if (environments.length === 0) {
    return complete
      ? { tone: 'note', text: 'No Codex Cloud environment is authorized for the configured accounts. Create one on Codex Cloud for the repository you want a task to run against.' }
      : { tone: 'refused', text: 'No environments could be read, and at least one account could not be asked, so this is not proof that none exist.' }
  }
  const partial = complete ? '' : ' At least one account could not be asked, so this list may be incomplete.'
  return {
    tone: complete ? 'confirmed' : 'note',
    text: `${usable} of ${environments.length} authorized environment${environments.length === 1 ? '' : 's'} can take a task.${partial}`,
  }
}

/* Looked up from a published STATE rather than from the controller, because the
   controller publishes its first state during its own construction: a callback
   that reached for the controller would be reaching for a binding that does not
   exist yet. */
export function findEnvironment(state, environmentId) {
  if (!state || !Array.isArray(state.environments) || !environmentId) return null
  return state.environments.find(environment => environment.environmentId === environmentId) || null
}

/* THE TASK LIST AND THE ENVIRONMENT LIST, WHEN NEITHER CAN BE READ.
 *
 * Both of these used to be seeded with `availability.note` -- the whole
 * switched-off paragraph -- so one panel printed one fact three times: once in
 * its header and once in each of these two lines. The owner's word for the
 * result was "messy" (R1528), and he was describing repetition, not the
 * refusal: the refusal is correct and stays, stated exactly once by the surface
 * that owns it.
 *
 * So these two say only what THEY know, which is that they hold nothing, and
 * why. They are per-code rather than one string because "switched off" and "not
 * in the desktop app" are different situations and a reader who is told the
 * wrong one goes looking for the wrong switch.
 */
export function emptyListMessage(availability) {
  return availability?.code === 'CLOUD_LAUNCH_SWITCHED_OFF'
    ? 'No tasks to show while launching is switched off.'
    : 'No tasks to show here.'
}

export function emptyEnvironmentsMessage(availability) {
  return availability?.code === 'CLOUD_LAUNCH_SWITCHED_OFF'
    ? 'Not read while launching is switched off.'
    : 'Not read here.'
}

/* The binding line: what a task launched right now would land in. Written from
   the discovered environment rather than from anything typed, and explicit when
   there is nothing to bind to.
 *
 * FOUR STATES, NOT TWO, and conflating them is what made this line wrong.
 * It answered "No environment chosen, so no source repository is bound." for
 * every case with no environment in hand -- including the two where nobody has
 * been offered a choice yet, because the list was never read. On the panel the
 * owner screenshotted, with launching switched off and therefore nothing ever
 * asked of the provider, that sentence diagnosed the person ("you did not
 * choose") for a state the product had put itself in. A read that was REFUSED
 * is a third thing again, and it is the one a person must not read as "empty".
 * `state` is optional so a caller that has only an environment still gets the
 * bound/unbound half it always got. */
export function bindingText(environment, state = null) {
  if (environment) {
    if (typeof environment.repository !== 'string' || !environment.repository) {
      return environment.reason || 'This environment reports no single source repository.'
    }
    return `Bound to ${environment.repository}${environment.defaultBranch ? ` · default branch ${environment.defaultBranch}` : ' · the provider states no default branch'}${environment.visibility ? ` · ${environment.visibility}` : ''}`
  }
  /* Said in three words rather than by repeating the sign-in sentence that is
     already on the panel. One condition, one paragraph. */
  if (state && state.signedIn === false) return 'Nothing is bound, because no Codex account is signed in here.'
  if (state && state.environmentsLoaded !== true) {
    if (state.environmentsTone === 'refused') {
      return 'Nothing is bound. The environments could not be read, so where a task would land is unknown.'
    }
    return state.phase === 'unavailable'
      ? 'Nothing is bound. The environments have not been read, because launching is switched off.'
      : 'Nothing is bound yet. The environments have not been read.'
  }
  return 'No environment chosen yet, so no source repository is bound.'
}

/* ---------------------------------------------------------------- *
 * GETTING THE WORK BACK.
 *
 * THE GAP. A person launches a cloud task, pays a provider for it, and gets a
 * task id. Until now the product could tell them the task FINISHED and could
 * not tell them what it did. Four cloud actions, none of which returned the
 * work. The engine's fifth tool answers exactly one question -- what changed --
 * and this is the half of the surface that decides what its answer means.
 *
 * WHAT IT IS, SAID IN THE COPY RATHER THAN IN A COMMENT. It is a DIFF. Not
 * "results", not "output", not the agent's account of what it did: the provider
 * CLI exposes none of those, so a label promising them would describe a feature
 * that does not exist. Every sentence below says diff, or says what changed.
 *
 * THE THREE ANSWERS, AND ALL THREE ARE ANSWERS.
 *   - a diff. Shown, and stated to be a copy: nothing here applies anything.
 *   - changedNothing. A task that only read, or that wrote findings it never
 *     committed, really did change no files. That is a fact about the task, not
 *     a fault in the reading, and painting it as a failure sends somebody to
 *     relaunch work that already ran.
 *   - truncated. The diff passed the cap and `bytes` is the TRUE size. This is
 *     the dangerous one and it gets the loudest sentence, because a half diff
 *     that looks whole applies cleanly and silently drops the rest of the work.
 *
 * AND THE FOURTH, WHICH IS THE ONE THAT COSTS MONEY WHEN IT IS MISREAD.
 * Retrieval is scoped to the account that created the task, so a task made by
 * another account is invisible to this one. The engine says so in its own
 * reason -- and the bridge replaces engine messages with a generic diagnosis
 * before they reach the glass (see ACCOUNTS_REGISTRY_MISSING in
 * ./refusal-copy.js), so this surface has to state the account rule itself. The
 * recurring mistake is reading that refusal as "the task is gone" and launching
 * the same work a second time.
 *
 * NOTHING HERE APPLIES A DIFF, and no control offers to. Retrieval is a read;
 * putting remotely-produced changes into a tree is a separate reviewed act, and
 * keeping them apart means fetching can never be the step that damages a tree.
 * ---------------------------------------------------------------- */

/** Only a finished task has work to fetch. */
export function offersDiff(task) {
  return Boolean(task) && typeof task === 'object' && task.state === 'SUCCEEDED' && typeof task.taskId === 'string' && task.taskId.length > 0
}

/* A size a person reads, or nothing at all. An unmeasured size returns the
   empty string so the caller can drop the clause: a placeholder like "unknown
   size" would be a machine's shrug rendered as prose. */
export function diffSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${Math.round(bytes)} bytes`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function byteLength(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  try { return new TextEncoder().encode(text).length }
  catch { return text.length }
}

const READING_MESSAGE = 'Reading the changes this task made. Nothing is being applied.'
const CHANGED_NOTHING_MESSAGE = 'This task changed no files, and that is a normal answer. Some tasks only read, and some write notes they never save. Open the task on Codex Cloud to read what it said.'

/**
 * What came back, as the sentence a person reads plus the diff itself.
 *
 * The three shapes are decided from the receipt's own flags rather than from
 * the length of the text: an empty string is `changedNothing` only when the
 * engine SAID so, because "the task changed nothing" and "the diff did not
 * arrive" are opposite facts that look identical from an empty string.
 */
export function diffAnswer(receipt) {
  const diff = typeof receipt?.diff === 'string' ? receipt.diff : ''
  const bytes = Number.isFinite(receipt?.bytes) && receipt.bytes >= 0 ? receipt.bytes : null
  const account = typeof receipt?.account?.name === 'string' && receipt.account.name ? receipt.account.name : null
  const readAs = account ? ` Read as ${account}.` : ''
  if (receipt?.changedNothing === true) {
    return Object.freeze({
      tone: 'note',
      changedNothing: true,
      truncated: false,
      bytes: bytes === null ? 0 : bytes,
      diff: '',
      message: `${CHANGED_NOTHING_MESSAGE}${readAs}`,
    })
  }
  if (receipt?.truncated === true) {
    const shownBytes = byteLength(diff)
    /* "the first 0 bytes" is a sentence no person needs. */
    const shown = shownBytes > 0 ? diffSize(shownBytes) : ''
    const whole = diffSize(bytes)
    /* THE WARNING SURVIVES A MISSING MEASUREMENT. If the true size did not
       arrive, the sentence loses the number and keeps every word that matters:
       what is on screen is a part. Dropping the whole warning because one field
       was absent would leave a clipped diff looking complete. */
    let measured
    if (shown && whole) measured = `You are seeing the first ${shown} of ${whole}.`
    else if (shown) measured = `You are seeing the first ${shown}, and there is more.`
    else measured = 'You are seeing part of it.'
    return Object.freeze({
      tone: 'partial',
      changedNothing: false,
      truncated: true,
      bytes,
      diff,
      /* The true size first, and the instruction second. This sentence is the
         only thing standing between a reader and a change that looks complete. */
      message: `This change is too big to show whole. ${measured} Treat this as a part, not the whole change. Open the task on Codex Cloud for the rest.${readAs}`,
    })
  }
  const size = diffSize(bytes === null ? byteLength(diff) : bytes)
  return Object.freeze({
    tone: 'confirmed',
    changedNothing: false,
    truncated: false,
    bytes: bytes === null ? byteLength(diff) : bytes,
    diff,
    message: `The changes came back as a diff, ${size} in all. Nothing has been applied to your computer; this is a copy to read.${readAs}`,
  })
}

/* THE REMEDIES THIS CONTROL KNOWS BETTER THAN THE TABLE DOES.
   ./refusal-copy.js sends every CLOUD_ code to "nothing was launched and
   nothing was spent, check the account and environment chosen above", which is
   written for the launch form and is wrong here twice over: this control has no
   environment picker, and the person is trying to READ something rather than
   start it. So the account rule -- the whole reason a cloud task can be
   invisible -- is stated on the one surface where it is the answer. */
function accountScopedRemedy(account) {
  const used = account ? ` This read used ${account}.` : ''
  return `Nothing was read and nothing was changed. A cloud task can only be read by the account that started it.${used} If someone else started that task, ask them for its diff.`
}

const NO_ACCOUNT_REMEDY = 'Nothing was read. No Codex account on the computer you are driving can read a cloud task right now. Sign in to Codex Cloud on that computer, then try again.'
/* The route this control posts to is not in every build that can run this
   window. Without this sentence the reader gets the generic connection advice
   and restarts the application, twice, for something no restart can change. */
const NOT_IN_THIS_COPY_REMEDY = 'Nothing was read and nothing was changed. This copy of ToolsEnabled cannot fetch a cloud task\'s changes yet. Install the newest version on the computer you are driving, then try again.'

export function diffRefusalMessage(result, { account = null } = {}) {
  const code = refusalCodeOf(result)
  /* THE ONE REFUSAL WHOSE DIAGNOSIS IS NOT ABOUT THE PERSON. This code means
     the request never had a route to travel down, and the words that come with
     it describe the router. Everywhere else the engine's own sentence is shown
     verbatim, because everywhere else it is the product's honest report of what
     it looked for; here it would put a piece of plumbing in front of somebody
     who asked what their task changed. */
  if (code === 'BRIDGE_ACTION_UNKNOWN') return NOT_IN_THIS_COPY_REMEDY
  let remedy = ''
  if (code === 'CLOUD_LAUNCH_NO_ACCOUNT_AVAILABLE') remedy = NO_ACCOUNT_REMEDY
  else if (typeof code === 'string' && /^(CLOUD_|CODEX_CLOUD_)/.test(code)) remedy = accountScopedRemedy(account)
  /* Everything else -- an unreachable service, a timeout, a guard -- keeps the
     product-wide remedy, which is already right for it. */
  return refusalSentence(result, { fallback: 'The changes did not come back.', remedy })
}

/**
 * Everything that talks to the bridge, decides what a response means, holds the
 * two-step launch, and runs the status watch.
 */
export function createCloudTaskController({
  postAction = postBridgeAction,
  onState = () => {},
  availability = cloudAvailability(),
  timers = { setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) },
  watchIntervalMs = WATCH_INTERVAL_MS,
  watchFirstDelayMs = WATCH_FIRST_DELAY_MS,
  watchMaxChecks = WATCH_MAX_CHECKS,
} = {}) {
  let destroyed = false
  let armed = null
  let watchTimer = null
  let checksLeft = 0
  /* A LAUNCH THIS PAGE ALREADY SENT AND NEVER GOT TO REPORT.
     A cloud launch is real, billable, remote work that cannot be cancelled once
     accepted, and its answer arrives on a 30-second budget from a screen the
     router will retire the instant an arrow is pressed. When that happened the
     answer -- including the task id, the only handle the person has on work they
     are paying for -- was dropped in silence. It is now filed in
     ./write-outcomes.js before the destroyed check, and restated here, on the
     surface that sent it, the next time that surface is built. */
  const missedLaunch = undeliveredWrite(WRITE_OUTCOME_KEYS.CLOUD_LAUNCH)
  let state = Object.freeze({
    phase: availability.ok ? 'idle' : 'unavailable',
    note: availability.note,
    accounts: Object.freeze([]),
    /* WHAT THE ACCOUNT READ ANSWERED, as a state rather than as the shape of a
       message. `null` is "not asked yet"; 'none' is the first run; 'refused' is
       a read that failed. The three send a person three different places, and
       the panel used to have only the third. */
    accountsPhase: null,
    signedIn: null,
    defaultAccount: null,
    environments: Object.freeze([]),
    environmentsComplete: false,
    environmentsLoaded: false,
    environmentsReadAt: null,
    environmentsTone: 'note',
    environmentsMessage: availability.ok ? 'Environments not read yet.' : emptyEnvironmentsMessage(availability),
    tasks: Object.freeze([]),
    servingAccount: null,
    listMessage: availability.ok ? 'Not loaded yet.' : emptyListMessage(availability),
    listTone: 'note',
    launchMessage: missedLaunch ? restatedMessage(missedLaunch) : '',
    launchTone: missedLaunch ? missedLaunch.tone : 'note',
    launchLabel: 'Launch on Codex Cloud',
    receipt: null,
    watchTaskId: null,
    watchTone: 'note',
    watchMessage: '',
    /* [B6] THE IDENTIFIER, KEPT — just not in the sentence. Removing the code
       from the four messages above without putting it anywhere would have
       traded one real loss (a customer facing a grep term) for another (a
       support conversation with nothing to name). Each of these is null, never
       '', so "no refusal" cannot be mistaken for "a refusal with a blank code".
       src/cloud-tasks.js stamps them as data-refusal-code. */
    listCode: null,
    environmentsCode: null,
    launchCode: null,
    watchCode: null,
    /* THE RETRIEVED DIFF, held for ONE task at a time. `diffTaskId` names which,
       and it is set before the request goes out so a reply for a task the person
       has already moved on from can be dropped rather than painted over the one
       they are reading. `diffText` is never seeded with anything: an empty
       string here means nothing has been fetched, and `diffPhase` is what tells
       the two apart from "this task changed no files". */
    diffTaskId: null,
    diffPhase: 'idle',
    diffTone: 'note',
    diffMessage: '',
    diffCode: null,
    diffText: '',
    diffBytes: null,
    diffTruncated: false,
    diffChangedNothing: false,
  })

  const publish = next => {
    state = Object.freeze({ ...state, ...next })
    if (!destroyed) onState(state)
  }
  publish({})

  /* The one place this panel turns a refusal into words. `fallback` is the
     sentence for a reply that carried no reason at all -- an absence that
     really arrives here, because a cloud call can fail before the layer has
     anything to say about it. */
  const refusal = result => refusalSentence(result, { fallback: 'The request did not complete.' })

  /* THE REMEDY FOR AN ACCOUNT LIST THAT IS THERE AND CANNOT BE READ.
     ./refusal-copy.js has no entry for the registry-parse family, so it falls to
     the product-wide remedy -- "try it once more" -- which is wrong advice for a
     file that will be exactly as malformed on the second press. Nothing about
     this is fixed by retrying.

     AND THE REMEDY IT USED TO GIVE WAS NOT ONE. It said to sign in again "so
     this copy can write itself a fresh list of accounts", which is not what
     signing in does and never was: the sign-in writes a credential into a
     folder, and the list is a separate file that nothing in the product wrote
     until the add-an-account control below existed. Adding an account is what
     writes it, so that is what this says. */
  const accountsRefusal = result => {
    const code = refusalCodeOf(result)
    const remedy = /^ACCOUNTS_(REGISTRY|ENTRY|NAME|ROLE|PROFILE)_/.test(String(code || ''))
      ? 'Nothing was read and nothing was spent. The list of accounts on the computer you are driving could not be read; adding an account again is what rewrites it.'
      : ''
    return refusalSentence(result, { fallback: 'The account list did not come back.', remedy })
  }
  const clock = () => new Date().toLocaleTimeString()

  /* ACCOUNTS AND ENVIRONMENTS ARRIVE TOGETHER, because on this provider they
     are one fact: an environment is scoped to the account that created it, so
     "which environments exist" has no answer that is not per-account. */
  async function loadAccounts() {
    if (!availability.ok) return state
    const result = await postAction('cloud-accounts', {})
    if (destroyed) return state
    if (result?.ok !== true || !Array.isArray(result.receipt?.accounts)) {
      /* ONE CONDITION, ONE PARAGRAPH. This used to publish the SAME refusal
         sentence into the task-list line and the environments line, and the
         panel drew both, one under the other. The accounts and the environments
         are one read on this provider -- the comment above loadAccounts says so
         -- so they get one line. The task list line is BLANKED rather than
         given a second wording, because a blank slot is silence and a second
         wording is the defect. */
      publish({
        accounts: Object.freeze([]),
        accountsPhase: 'refused',
        signedIn: null,
        defaultAccount: null,
        listTone: 'note',
        listMessage: '',
        listCode: null,
        /* NOT "no environments": a refused read says nothing about what exists.
           environmentsLoaded goes back to FALSE so the launch path keeps
           refusing -- and it is set here rather than left at its initial value,
           which is the bug this comment used to describe without doing. After a
           successful read followed by a refused one it stayed true, and the
           binding line then told a person "no environment chosen yet" about a
           reading that had just failed. An unread list never permits a launch,
           and a list that could not be re-read is unread. */
        environments: Object.freeze([]),
        environmentsLoaded: false,
        environmentsComplete: false,
        environmentsTone: 'refused',
        environmentsMessage: `Your Codex accounts could not be read. ${accountsRefusal(result)}`,
        environmentsCode: refusalCodeOf(result),
      })
      return state
    }
    const accounts = Object.freeze(result.receipt.accounts.map(account => Object.freeze({ ...account })))
    const environments = Object.freeze((Array.isArray(result.receipt.environments) ? result.receipt.environments : [])
      .map(environment => Object.freeze({ ...environment })))
    const complete = result.receipt.environmentsComplete === true
    /* THE FIRST RUN, AS ONE EMPTY STATE WITH ONE NEXT ACTION. `signedIn` is the
       engine's own answer where it gives one, and falls back to "are there any
       accounts", which is the same fact for every reading this panel can get. */
    const signedIn = result.receipt.signedIn === undefined ? accounts.length > 0 : result.receipt.signedIn === true
    const message = environmentsMessage({ loaded: true, environments, complete, signedIn })
    publish({
      accounts,
      accountsPhase: signedIn ? 'ready' : 'none',
      signedIn,
      defaultAccount: result.receipt.defaultAccount || null,
      environments,
      environmentsComplete: complete,
      environmentsLoaded: true,
      environmentsReadAt: typeof result.receipt.environmentsReadAt === 'string' ? result.receipt.environmentsReadAt : null,
      environmentsTone: message.tone,
      environmentsMessage: message.text,
      /* Nothing to read tasks as, and the line above already says why. */
      ...(signedIn ? {} : { listTone: 'note', listMessage: '', listCode: null }),
    })
    return state
  }

  async function loadTasks(request = {}) {
    if (!availability.ok) return state
    publish({ listTone: 'note', listMessage: 'Reading Codex Cloud…' })
    const body = {}
    if (request.environment) body.environment = request.environment
    if (request.account) body.account = request.account
    const result = await postAction('cloud-tasks', body)
    if (destroyed) return state
    if (result?.ok !== true || !Array.isArray(result.receipt?.tasks)) {
      /* WHEN THE ACCOUNTS LINE HAS ALREADY EXPLAINED THIS, SAY NOTHING. A task
         read fails for the same reason the account read did -- no account to
         read as -- and restating it here is how one condition became two
         paragraphs. `refresh()` does not even get this far in those states;
         this covers a caller that reads tasks on its own. */
      if (state.accountsPhase === 'refused' || state.accountsPhase === 'none') {
        publish({ listTone: 'note', listMessage: '', listCode: null })
        return state
      }
      publish({ listTone: 'refused', listMessage: `Your Codex tasks could not be read. ${refusal(result)}`, listCode: refusalCodeOf(result) })
      return state
    }
    const tasks = result.receipt.tasks.map(task => Object.freeze({ ...task }))
    publish({
      tasks: Object.freeze(tasks),
      servingAccount: result.receipt.account || null,
      listTone: tasks.length ? 'confirmed' : 'note',
      listMessage: tasks.length
        ? `${tasks.length} task${tasks.length === 1 ? '' : 's'} · read as ${accountSummary(result.receipt.account)}`
        : `No tasks on this account yet · read as ${accountSummary(result.receipt.account)}`,
    })
    return state
  }

  /* THE RETRIEVAL. One read, one task, no second step: fetching a diff spends
     nothing, changes nothing and cannot be undone into anything, so it does not
     get the launch's confirm gate. It also never becomes a watch -- a diff is
     read when a person asks for it and never on a timer. */
  async function readDiff(taskId, { account = null, attempt = null } = {}) {
    if (!availability.ok || destroyed || typeof taskId !== 'string' || !taskId) return state
    publish({
      diffTaskId: taskId,
      diffPhase: 'reading',
      diffTone: 'note',
      diffMessage: READING_MESSAGE,
      diffCode: null,
      diffText: '',
      diffBytes: null,
      diffTruncated: false,
      diffChangedNothing: false,
    })
    const body = { taskId }
    if (account) body.account = String(account)
    if (Number.isSafeInteger(attempt) && attempt > 0) body.attempt = attempt
    let result
    try { result = await postAction('cloud-task-diff', body) }
    catch (error) { result = { ok: false, code: 'BRIDGE_REQUEST_FAILED', reason: error?.message || 'the request for the changes did not complete' } }
    if (destroyed || state.diffTaskId !== taskId) return state
    /* A REPLY WITH NO `diff` FIELD IS A REFUSAL, not an empty diff. This is the
       absence-as-answer rule the rest of this file is built on, at the one place
       where getting it wrong would tell somebody their task did nothing. */
    if (result?.ok !== true || typeof result.receipt?.diff !== 'string') {
      publish({
        diffPhase: 'refused',
        diffTone: 'refused',
        diffMessage: diffRefusalMessage(result, { account }),
        diffCode: refusalCodeOf(result),
        diffText: '',
      })
      return state
    }
    const answer = diffAnswer(result.receipt)
    publish({
      diffPhase: 'answered',
      diffTone: answer.tone,
      diffMessage: answer.message,
      diffCode: null,
      diffText: answer.diff,
      diffBytes: answer.bytes,
      diffTruncated: answer.truncated,
      diffChangedNothing: answer.changedNothing,
    })
    return state
  }

  /* THE FIRST CLICK ARMS, THE SECOND SENDS. There is no cancel on the provider
     side, so the only place a person can change their mind is before the
     request leaves. The armed request is captured verbatim and the second click
     sends EXACTLY it -- re-reading the form on confirm would let a stray
     keystroke between the two clicks send something the person never saw
     confirmed. */
  function arm(request) {
    if (!availability.ok || destroyed) return state
    const idle = { phase: 'idle', launchTone: 'refused', launchLabel: 'Launch on Codex Cloud' }
    const environment = String(request?.environment || '').trim()
    const branch = String(request?.branch || '').trim()
    const prompt = String(request?.prompt || '')
    if (!ENVIRONMENT_ID.test(environment)) {
      publish({ ...idle, launchMessage: 'Choose the Codex Cloud environment this task runs in. Nothing was sent.' })
      return state
    }
    /* THE BINDING IS REQUIRED HERE AND CHECKED AGAIN AT THE BRIDGE. This surface
       declares the repository it has been SHOWING for the chosen environment;
       the capability layer re-reads the binding from the provider and refuses if
       the two differ. So a stale or wrong picture on this glass cannot become a
       task submitted against someone else's source -- which is the guarantee
       Machine B's offload report asked for. */
    if (!state.environmentsLoaded) {
      publish({ ...idle, launchMessage: 'The authorized environments have not been read yet, so the source repository cannot be declared. Refresh, then launch. Nothing was sent.' })
      return state
    }
    const chosen = findEnvironment(state, environment)
    if (!chosen) {
      publish({
        ...idle,
        launchMessage: state.environmentsComplete
          ? 'That environment is not one the configured accounts are authorized for. Nothing was sent.'
          : 'That environment is not in the list that could be read, and the reading was incomplete, so nothing about it is confirmed. Nothing was sent.',
      })
      return state
    }
    if (typeof chosen.repository !== 'string' || !chosen.repository) {
      publish({ ...idle, launchMessage: `${chosen.reason || 'That environment reports no single source repository.'} A task cannot be bound to it. Nothing was sent.` })
      return state
    }
    if (!branch) {
      publish({ ...idle, launchMessage: 'A branch is required, and it must already exist on the remote. Nothing was sent.' })
      return state
    }
    if (!prompt.trim()) {
      publish({ ...idle, launchMessage: 'A task needs a prompt. Nothing was sent.' })
      return state
    }
    armed = Object.freeze({
      environment,
      repository: chosen.repository,
      branch,
      prompt,
      ...(Number.isSafeInteger(request?.attempts) && request.attempts > 1 ? { attempts: request.attempts } : {}),
      ...(request?.account ? { account: String(request.account) } : {}),
      confirmed: true,
    })
    writeRemembered({ environment, branch })
    publish({
      phase: 'armed',
      launchTone: 'note',
      launchLabel: 'Confirm launch',
      launchMessage: `This starts real work on Codex Cloud as ${armed.account || 'the first account that can serve'}, in ${chosen.repository} on branch ${branch}. A cloud task cannot be cancelled once it is accepted. Select again to send it, and approve the prompt that follows.`,
    })
    return state
  }

  /* THE OUTCOME IS SAID BEFORE THIS FUNCTION ASKS WHETHER ITS SCREEN IS STILL
     THERE. `destroyed` means this controller has no panel to write into; it says
     nothing about whether a task was created on Codex Cloud, and reading it first
     is what made "your task is running as <id>" and "a task may or may not exist"
     both come out as silence. Every settled branch of confirm() goes through
     here: it always updates this controller's own state, it paints only when
     there is something to paint on, and when there is not, the sentence is filed
     where the next mount of this panel will restate it. */
  const settleLaunch = (fields, tone, message) => {
    publish({ ...fields, launchTone: tone, launchMessage: message })
    if (destroyed) recordUndeliveredWrite(WRITE_OUTCOME_KEYS.CLOUD_LAUNCH, { tone, message })
    else clearUndeliveredWrite(WRITE_OUTCOME_KEYS.CLOUD_LAUNCH)
    return state
  }

  async function confirm() {
    if (!armed || destroyed) return state
    const request = armed
    armed = null
    publish({ phase: 'launching', launchTone: 'note', launchLabel: 'Launching…', launchMessage: 'Waiting for approval, then submitting. Nothing has been created yet.' })
    let result
    try { result = await postAction('cloud-launch', request) }
    catch (error) { result = { ok: false, code: 'BRIDGE_REQUEST_FAILED', reason: error?.message || 'the launch request failed' } }
    if (result?.ok !== true || !result.receipt) {
      return settleLaunch(
        { phase: 'idle', launchLabel: 'Launch on Codex Cloud', launchCode: refusalCodeOf(result) },
        'refused',
        /* The launch gets its own remedy rather than the table's, and it
           deliberately does NOT say "nothing was created". This branch is
           reached by a timeout as well as by a refusal, and a request that
           timed out on the way out can still have made a real, billable task.
           The table's generic advice is "try once more", which on the one
           control in this product that spends money is the expensive mistake.
           So this one says LOOK first, every time, whatever refused it. */
        `Not launched · ${refusalSentence(result, {
          fallback: 'The request did not complete.',
          remedy: 'Refresh the task list above before pressing Launch again: a request that failed on its way out can still have created a task, and a second press would create a second one.',
        })}`,
      )
    }
    const receipt = result.receipt
    if (receipt.launched !== true || typeof receipt.taskId !== 'string') {
      /* NOT AN ERROR AND NOT A SUCCESS. The capability layer answers ok:true
         with state UNKNOWN and a null task id when the CLI neither confirmed a
         task nor proved it failed to make one. Saying "failed" here would
         invite a retry that could create a SECOND real task, so the wording
         names the uncertainty and points at the list, which is the only thing
         that can settle it.

         THIS IS THE BRANCH THAT MUST SURVIVE THE SCREEN. Dropped, it leaves a
         person who comes back to an idle panel with no reason not to launch a
         second time -- which is how one press becomes two real cloud tasks. */
      return settleLaunch(
        { phase: 'idle', launchLabel: 'Launch on Codex Cloud' },
        'refused',
        `${receipt.state || 'UNKNOWN'} · ${receipt.message || 'The launch did not confirm a task id.'} A task may or may not have been created — refresh the list before trying again rather than launching a second time.`,
      )
    }
    /* THE RECEIPT IS THE PROVIDER'S ANSWER, NOT THIS PAGE'S MEMORY OF THE FORM.
       Every field is copied from what came back, and it is frozen: the status
       watch below writes to its own fields and can never edit the record of what
       was submitted. */
    settleLaunch(
      {
        phase: 'idle',
        launchLabel: 'Launch on Codex Cloud',
        receipt: Object.freeze({
          taskId: receipt.taskId,
          taskUrl: receipt.taskUrl || null,
          environment: receipt.environment || null,
          environmentLabel: receipt.environmentLabel || null,
          repository: receipt.repository || null,
          branch: receipt.branch || null,
          state: receipt.state || 'UNKNOWN',
          account: receipt.account || null,
          submittedAt: receipt.submittedAt || null,
          bindingReadAt: receipt.bindingReadAt || null,
          approvalRequired: receipt.approvalRequired === true,
        }),
      },
      'confirmed',
      `${cloudStateView(receipt.state).label} · task ${receipt.taskId} on ${accountSummary(receipt.account)}${receipt.accountsConsidered?.length > 1 ? ` (after trying ${receipt.accountsConsidered.slice(0, -1).join(', ')})` : ''}.`,
    )
    /* Only NOW does being torn down matter. The launch is recorded either way;
       what a dead controller must not do is start a status watch nothing will
       read or send another bridge read after its own teardown. */
    if (destroyed) return state
    watch(receipt.taskId, { environment: receipt.environment || request.environment, account: receipt.account?.name || request.account || null })
    await loadTasks({ environment: request.environment })
    return state
  }

  function stopWatch() {
    if (watchTimer !== null) timers.clearTimeout(watchTimer)
    watchTimer = null
  }

  /* THE STATUS WATCH. It exists because "did my work start?" is the only
     question this surface is for, and answering it used to require the person to
     press Refresh at intervals they had to invent. It reads the same bounded
     status action an agent would; it never guesses; and its every message
     carries the time of the reading, because a status with no timestamp is a
     claim about now made from a measurement about then. */
  function watch(taskId, { environment = null, account = null } = {}) {
    if (destroyed || typeof taskId !== 'string' || !taskId) return state
    stopWatch()
    checksLeft = watchMaxChecks
    publish({ watchTaskId: taskId, watchTone: 'note', watchMessage: 'Watching this task; the first check is moments away.' })
    watchTimer = timers.setTimeout(() => { void check(taskId, { environment, account }) }, watchFirstDelayMs)
    return state
  }

  async function check(taskId, { environment = null, account = null } = {}) {
    if (destroyed) return state
    watchTimer = null
    const body = { taskId }
    if (environment) body.environment = environment
    if (account) body.account = account
    let result
    try { result = await postAction('cloud-task-status', body) }
    catch (error) { result = { ok: false, code: 'BRIDGE_REQUEST_FAILED', reason: error?.message || 'the status request failed' } }
    if (destroyed || state.watchTaskId !== taskId) return state

    if (result?.ok !== true || typeof result.receipt?.state !== 'string') {
      /* A failed READING is not a failed TASK. Say which one happened, and keep
         watching: the next check may well answer. */
      publish({ watchTone: 'refused', watchMessage: `Could not read the status at ${clock()} · ${refusal(result)}. The task itself is unaffected.`, watchCode: refusalCodeOf(result) })
    } else {
      const receipt = result.receipt
      const view = cloudStateView(receipt.state)
      const found = receipt.found === true
      publish({
        watchTone: view.tone === 'good' ? 'confirmed' : (view.tone === 'bad' ? 'refused' : 'note'),
        watchMessage: found
          ? `${view.label}${receipt.providerStatus && receipt.providerStatus !== view.label ? ` (${receipt.providerStatus})` : ''} at ${clock()}${receipt.updatedAt ? ` · provider updated ${receipt.updatedAt}` : ''}`
          : `not in the searched window at ${clock()} — that is not a failure, and the task may still be running`,
      })
      if (found && TERMINAL_CLOUD_STATES.includes(receipt.state)) {
        stopWatch()
        return state
      }
    }

    checksLeft -= 1
    if (checksLeft <= 0) {
      publish({ watchMessage: `${state.watchMessage} · stopped watching after ${watchMaxChecks} checks; the task may still be running.` })
      stopWatch()
      return state
    }
    watchTimer = timers.setTimeout(() => { void check(taskId, { environment, account }) }, watchIntervalMs)
    return state
  }

  function disarm() {
    armed = null
    if (destroyed) return state
    publish({ phase: 'idle', launchLabel: 'Launch on Codex Cloud', launchTone: 'note', launchMessage: 'Not sent.' })
    return state
  }

  /* THE ONE READ THE REFRESH BUTTON MAKES, IN ORDER.
   *
   * The surface used to fire loadAccounts() and loadTasks() side by side and
   * let them race. Whichever refused second painted its own version of the same
   * condition into its own box, which is how a panel with one problem showed
   * two paragraphs about it. In order, the accounts answer decides whether
   * there is anything to read tasks AS -- with no account signed in, or with
   * the account read refused, there is not, and the panel says so once. */
  async function refresh(request = {}) {
    await loadAccounts()
    if (destroyed) return state
    if (state.accountsPhase === 'refused' || state.accountsPhase === 'none') return state
    return loadTasks(request)
  }

  return Object.freeze({
    getState: () => state,
    isArmed: () => armed !== null,
    isWatching: () => watchTimer !== null,
    loadAccounts,
    loadTasks,
    refresh,
    readDiff,
    arm,
    confirm,
    disarm,
    watch,
    click(request) {
      if (destroyed || state.phase === 'launching') return Promise.resolve(state)
      if (armed) return confirm()
      return Promise.resolve(arm(request))
    },
    destroy() { destroyed = true; stopWatch() },
  })
}
