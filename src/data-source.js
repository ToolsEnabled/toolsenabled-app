/* WHERE THE DATA ON EVERY SCREEN COMES FROM -- one axis, three answers.
 *
 *   'local'  this is the desktop app; the machine in front of the person is
 *            the host, reached over its own loopback bridge and preload IPC.
 *   'relay'  this is a signed-in browser with a machine connected; every
 *            reading and every command crosses the sealed tunnel to that
 *            machine, and nothing touches the computer the browser runs on.
 *   'mock'   there is no host: a signed-out browser, or the example toggle.
 *            The screens render the product's own example fleet, and every
 *            surface showing it is badged, because the badge follows the
 *            SOURCE and never the look of the data.
 *
 * WHAT THIS REPLACES. live-flags.js held seven per-view 'mc.live.<view>' keys
 * whose off state selected a SECOND RENDER -- a separate demonstration face
 * with its own rails, its own tabs, and most of the product missing. That
 * conflated three independent things in one flag: which render runs, where
 * data comes from, and where commands go. The owner's ruling collapsed it:
 * "all simulated pages ARE the UI pages, just mock data." So there is one
 * render, and this module answers only the question that remains.
 *
 * RESOLUTION IS ASYNC AND CACHED. On a public origin the relay-versus-mock
 * answer needs the host asked for its transport, which cannot happen at import
 * time (no session, no machine pair exist yet). Views already load their data
 * asynchronously, so they resolve the source in the same breath. The cached
 * answer is exposed synchronously for render-time checks, and a host that
 * changes state (sign-in, sign-out) dispatches DATA_SOURCE_EVENT so open views
 * re-resolve rather than trusting a stale verdict.
 *
 * THE EXAMPLE TOGGLE IS ONE SWITCH, NOT SEVEN. The per-view flags were
 * Phase-2 rollback machinery -- live-flags.js said so itself -- and seven
 * independent switches meant seven ways for a screen to disagree with its
 * neighbour about what world it was in. One toggle, one world. The /example
 * route segment (main.js) survives unchanged: a URL is the right lifetime for
 * "show me one example page", where a stored preference is the wrong one.
 */
import { bridgeTransportAvailable } from './mission-bridge.js'

export const DATA_SOURCE_EVENT = 'mc:data-source-changed'

const EXAMPLE_KEY = 'mc.example'

export const DATA_SOURCE_READ_UNAVAILABLE = 'DATA_SOURCE_READ_UNAVAILABLE'

function couldNotReadDataSource(what, cause) {
  const error = new Error(`ToolsEnabled could not read ${what}; this is not a claim that it is absent.`)
  error.code = DATA_SOURCE_READ_UNAVAILABLE
  error.cause = cause
  return error
}

/* The desktop discriminator. mcShell EXISTING is not enough -- the website
 * defines one too (endpoint + relay transport). getBridgeProof is exposed by
 * the desktop preload and deliberately withheld by the site's host bridge
 * ("a second closed door behind the first"), so its presence means the shell
 * that actually hosts an engine is behind this page. */
export function onDesktop() {
  return typeof globalThis.window?.mcShell?.getBridgeProof === 'function'
}

/* THE SIGNED-OUT VISITOR ARRIVES IN THE SIMULATION.
 *
 * Owner ruling 2026-08-26: "simulation 'on' should be default on every visit
 * when a user is not logged in." A stranger who follows the site's primary
 * button already saw mock data -- resolveDataSource() correctly answers 'mock'
 * for a browser with no desktop and no relay -- but they saw it framed as a
 * DEGRADED page rather than as a working demonstration. The product's front
 * door should show the product working.
 *
 * THREE PROPERTIES THIS HAS TO HAVE, each one a trap avoided:
 *
 * 1. NOT STORED. The default lives in module state, never in localStorage, so
 *    it evaporates on reload and cannot leak into a later signed-in visit.
 *    "Default on every visit" then falls out for free instead of being
 *    maintained. Storing 'on' would also make it indistinguishable from a real
 *    choice, and the copy below has to tell those two apart.
 * 2. STRICTLY SIGNED-OUT, never merely unreachable. Only an explicit
 *    `signedIn === false` from the host seeds it. A missing bridge, a thrown
 *    read or a timeout leaves the default OFF -- because a signed-in person
 *    whose machine went quiet must keep the sentence that names THAT, which
 *    was measured on the live site being replaced with "go and install it"
 *    and fixed once already. Could-not-tell is not signed-out.
 * 3. DECLINABLE FOR THE VISIT. Turning the switch off has to work, or the
 *    toggle is decorative; it must not persist, or the ruling above stops
 *    being true on the next visit. So the decline is module state too.
 */
let signedOutDefault = false
let signedOutDefaultDeclined = false

function exampleWasStored() {
  /* A non-browser test/runtime genuinely has no storage. That is absence; a
     storage object which exists but cannot be read is could-not-tell. */
  if (!('localStorage' in globalThis)) return false
  try { return globalThis.localStorage.getItem(EXAMPLE_KEY) === 'on' } catch (error) {
    throw couldNotReadDataSource('the example preference', error)
  }
}

/** True only while the example is the SIGNED-OUT DEFAULT rather than a choice.
 *  The copy depends on the difference: "turn the switch off to see your own
 *  computer" is the right next step for somebody who chose the example, and a
 *  dead end for a stranger with no computer on the account to go back to. */
export function exampleIsSignedOutDefault() {
  return signedOutDefault && !signedOutDefaultDeclined && !exampleWasStored()
}

export function isExampleMode() {
  return exampleWasStored() || exampleIsSignedOutDefault()
}


/** Ask the host who is signed in. Never throws, and never guesses.
 *
 *  The website's host bridge answers `{signedIn:false}` for a 401 and THROWS
 *  when the account service could not be asked at all -- so an explicit false
 *  is the only answer meaning "nobody is signed in here". The desktop shell
 *  publishes a DIFFERENT mcAccount whose signed-out shape carries
 *  MC_ACCOUNT_SHELL_ABSENT, but this is only reached after onDesktop() has
 *  already returned, so that bridge never gets this question. */
async function nobodyIsSignedIn() {
  if (signedOutDefaultDeclined) return false
  try {
    const bridge = globalThis.window?.mcAccount
    if (!bridge || typeof bridge.current !== 'function') return false
    const answer = await bridge.current()
    return answer?.signedIn === false
  } catch { return false }
}

/* THE POSITIVE TWIN, and it has to be its own function rather than
 * `!nobodyIsSignedIn()`.
 *
 * nobodyIsSignedIn() answers FALSE for three different situations: somebody is
 * signed in, the bridge is absent, and the call threw. That is correct where it
 * is used -- it only seeds the simulation on an explicit signed-out answer -- but
 * negating it would read every one of those as "somebody is signed in", and an
 * unreachable account service would then clear the simulation seed on the
 * strength of an error.
 *
 * Clearing a seed needs a POSITIVE signal, so this returns true only for an
 * explicit signedIn === true. */
async function somebodyIsSignedIn() {
  try {
    const bridge = globalThis.window?.mcAccount
    if (!bridge || typeof bridge.current !== 'function') return false
    const answer = await bridge.current()
    return answer?.signedIn === true
  } catch { return false }
}

export function setExampleMode(on) {
  const enabled = Boolean(on)
  /* Turning it off DECLINES the signed-out default for this visit. Without
     this the switch would appear to work and the default would immediately
     re-assert itself on the next resolve, which is a control that lies. */
  try {
    /* Store only the non-default choice, so the default can evolve without a
       stale key pinning existing installs to the past -- the same rule the
       per-view flags followed. */
    if (enabled) localStorage.setItem(EXAMPLE_KEY, 'on')
    else localStorage.removeItem(EXAMPLE_KEY)
  } catch (error) {
    /* A failed write is not an applied setting. In particular, do not latch a
       decline in module state when removeItem() merely could not run. */
    throw couldNotReadDataSource('or change the example preference', error)
  }
  if (!enabled) signedOutDefaultDeclined = true
  exampleRevision += 1
  /* Event readers run synchronously, including Settings, which keeps its
     current visit and drafts. A chosen example is already known; so is the
     desktop when that choice is cleared. A public host still needs asking:
     the previous chosen example says nothing about its availability. */
  resolved = enabled ? 'mock' : onDesktop() ? 'local' : null
  announceDataSourceChange('example-toggle')
  return enabled
}

let resolved = null
let exampleRevision = 0
let sourceRevision = 0
let sourceWindow = null
const ownAnnouncements = new WeakSet()

function observeSourceWindow() {
  const scope = globalThis.window
  if (scope === sourceWindow) return
  sourceWindow = scope
  sourceRevision += 1
  scope?.addEventListener?.(DATA_SOURCE_EVENT, event => {
    if (scope !== sourceWindow || ownAnnouncements.has(event) || event?.detail?.why === 'agent-events-gap') return
    sourceRevision += 1
    resolved = null
  })
}

/**
 * Resolve where data comes from, and cache the verdict.
 * `reask: true` re-asks the host for a transport (sign-in just happened);
 * meaningless and harmless when one is already installed.
 */
export async function resolveDataSource({ reask = false } = {}) {
  observeSourceWindow()
  const readingExampleRevision = exampleRevision
  const readingSourceRevision = sourceRevision
  const readingWindow = sourceWindow
  const superseded = () => readingExampleRevision !== exampleRevision
    || readingSourceRevision !== sourceRevision || readingWindow !== globalThis.window
  /* A SEED DERIVED FROM BEING SIGNED OUT MUST NOT OUTLIVE SIGNING IN.
  
     `signedOutDefault` was set once, on the first resolve with nobody signed in,
     and never cleared. isExampleMode() reads it, and the check below returns
     'mock' before anything re-asks. So a visitor could sign in successfully and
     stay on the example fleet -- real machines and real actions hidden -- with no
     way back except turning the simulation off by hand or reloading the page.
  
     `reask` already exists for exactly this moment; its own doc says "sign-in
     just happened". It reached only the transport probe, forty lines below a
     short-circuit it could never get past.
  
     Only a POSITIVE sign-in clears it, and only when the person has not stored
     the example themselves -- a deliberate choice outranks a seed. */
  if (reask && signedOutDefault && !exampleWasStored() && !signedOutDefaultDeclined) {
    const signedIn = await somebodyIsSignedIn()
    if (superseded()) return resolveDataSource({ reask })
    if (signedIn) {
      signedOutDefault = false
      announceDataSourceChange('signed-in')
    }
  }
  if (isExampleMode()) {
    /* The person asked for the example. On any host. One rule, no surprises:
       example on means mock, badged, everywhere. */
    resolved = 'mock'
    return resolved
  }
  if (onDesktop()) {
    resolved = 'local'
    return resolved
  }
  /* A browser with nobody signed in gets the simulation deliberately, not as
     a fallback. Asked BEFORE the transport probe because a signed-out visitor
     has no session for a transport to belong to -- probing first would spend a
     round trip to learn what the account answer already settles. */
  const signedOut = await nobodyIsSignedIn()
  if (superseded()) return resolveDataSource({ reask })
  if (signedOut) {
    const seedChanged = !signedOutDefault
    signedOutDefault = true
    resolved = 'mock'
    /* ANNOUNCE, OR THE SWITCH LIES ON EVERY SURFACE THAT ALREADY PAINTED.
     *
     * This seed is decided AFTER an await -- the host has to be asked who is
     * signed in, which is a round trip to the account service. Anything that
     * painted in the meantime read isExampleMode() as false and kept it: the
     * quick-settings toggle drew unchecked, and nothing told it otherwise.
     * Measured on the live site: the simulation was on by every internal
     * measure and the switch showed OFF, which is the product contradicting
     * itself in the one place a person can see.
     *
     * setExampleMode() has always announced for exactly this reason. The seed
     * changes the same fact and must do the same thing -- the asymmetry was
     * the whole defect.
     *
     * Concurrent callers can already be awaiting the account when the first
     * one seeds the default. Announce only that transition; announcing the
     * unchanged seed again remounts visible controls during interaction. */
    if (seedChanged) announceDataSourceChange('signed-out-default')
    return resolved
  }
  /* Reachability does not choose example data. A hosted account/relay seam
     means this page reads the remote source, including when that source is
     temporarily unavailable. Its normal unavailable/retry surface can then
     recover; only deliberate Example or confirmed sign-out selected mock above.
     A standalone preview with no host seam retains its existing demo. */
  const relay = await bridgeTransportAvailable({ reask })
  /* A preference saved while this lookup waited takes precedence over its
     old answer. Resolve that choice before publishing a source verdict. */
  if (superseded()) return resolveDataSource({ reask })
  const hosted = typeof readingWindow?.mcAccount?.current === 'function'
    || typeof readingWindow?.mcShell?.getBridgeTransport === 'function'
  resolved = relay || hosted ? 'relay' : 'mock'
  return resolved
}

/** The last resolved source, or null before the first resolution completes.
 *  Null must be treated as "not yet known", never defaulted to a source --
 *  defaulting to 'mock' would badge real data and defaulting to anything else
 *  would unbadge the example. Callers that render before resolving await
 *  resolveDataSource() in their load path instead. */
export function currentDataSource() {
  return resolved
}

/* THERE ARE TWO WAYS A SCREEN ENDS UP ON THE EXAMPLE AND THEY NEED DIFFERENT
 * WORDS, which is the whole of the free journey's front door.
 *
 * MEASURED. The website's primary button lands a stranger on /app/. Nothing
 * there is on the desktop and no relay transport answers, so resolveDataSource
 * says 'mock' -- correctly. Every sentence on the resulting screen then told
 * them to turn off "Show the example fleet" in Settings, under What the screens
 * switch is already OFF for them; the heading it names does not exist under
 * that name; and flipping it changes nothing, because the toggle is not what
 * put them in the example. So the product's front door gave an instruction that
 * cannot be followed, to the one visitor least able to tell that.
 *
 * THE CORRECT SENTENCE ALREADY EXISTED ten characters away in the same file.
 * All it needed was to be reachable, and this is the question that reaches it:
 * is the example a CHOICE this person made, or the only thing this page could
 * draw?
 *
 * `isExampleMode()` is the honest discriminator and a bridge-presence test is
 * not: on the desktop with the toggle on, the agent bridge exists and works. */
export function exampleWasChosen() {
  /* THE STORED CHOICE, NOT isExampleMode(). These were the same function until
     the signed-out simulation default landed, and the difference is the whole
     point of this one: a visitor put into the simulation by default CHOSE
     nothing, and telling them to "turn off Show the example fleet" sends them
     to a switch that hands back an empty page, because they have no computer
     on the account for it to reveal. Answering isExampleMode() here would have
     made that dead end reachable again by the exact route it was fixed on. */
  return exampleWasStored()
}

export function previewWithoutHost(source = resolved) {
  return source === 'mock' && !isExampleMode()
}

/* WHY THIS SCREEN IS ON THE EXAMPLE, WHEN THE BRIDGE KNOWS AND THE APP DOES NOT.
 *
 * previewWithoutHost() answers "is the example a choice?" — and for everybody
 * who did not choose it, the app has been saying one thing: install
 * ToolsEnabled. That is right for a stranger who followed a link and wrong for
 * everybody else, and on 2026-08-22 it was measured being told to somebody with
 * the app installed, a computer connected, and a reachability check that had
 * answered a minute earlier. Their machine had gone quiet; the page told them to
 * go and get software they already had.
 *
 * The host bridge is the only thing that knows the difference — it is what
 * failed — so it now leaves its reason on `window.mcHostFallback` as a finished
 * sentence, and this is the app's side of that channel.
 *
 * A MISSING OR MALFORMED REASON IS NOT AN ERROR. Nothing publishes this on the
 * desktop, and no version of the website is required to. null means "no better
 * words than the ones you already have", and every caller keeps its own
 * fallback rather than rendering a blank. The length bound is there because
 * this string is drawn: a bridge that somehow published a paragraph should not
 * be able to reshape a page. */
/* The host saying "I now know why I could not reach a machine", which it does
   AFTER the page it affects has been drawn -- see the note in host-bridge.js
   for why this cannot be DATA_SOURCE_EVENT. Views that draw the sentence
   listen and repaint; nothing re-resolves. */
export const HOST_FALLBACK_EVENT = 'mc:host-fallback-changed'

/* THE SAME CHANNEL, READ AS A CODE RATHER THAN AS WORDS. The host publishes
   { code, sentence } and until now only the sentence was ever taken. One of
   those codes is not a dead end at all: MC_NO_MACHINE_CHOSEN means the person
   is signed in with computers connected and simply has not said which one to
   drive -- a question the app can now ask them directly instead of sending
   them to another page for it. Bounded and shaped like its neighbour: an absent
   or malformed code is null, never an error. */

/* WHY THESE TWO READERS ARE EXEMPT FROM THE could-not-tell RULE.
 *
 * The rest of this module refuses to turn a failed read into a definite answer:
 * exampleWasStored() and setExampleMode() throw couldNotReadDataSource(),
 * because a localStorage read that dies on EIO would otherwise be CACHED as the
 * fact "the example is off", and a failed write returned as an applied setting.
 * Both are claims about the world, both are retryable, and both had a caller
 * able to hear "I could not tell".
 *
 * Neither is true here, and the same policy applied to these two is a
 * regression rather than a tightening:
 *
 * 1. NULL IS NOT A CLAIM ABOUT THE WORLD. This channel carries pre-rendered
 *    WORDS, and null means only "no better words than the ones you already
 *    have". The caller does not act on it; it draws its own sentence, which is
 *    correct for the generic reader by construction.
 * 2. THERE IS NO THIRD SENTENCE TO DRAW. Every call site is synchronous and on
 *    the render path -- exampleExitSentence() and accountDoorMarkup() are
 *    interpolated straight into a `slot.innerHTML = ...` template in
 *    views/computers.js. A throw does not surface "could not tell" to anybody;
 *    it aborts the markup expression and the rail is never written. That trades
 *    the defect this channel exists to fix (the wrong words) for a worse one
 *    (no words, and no page).
 * 3. NOBODY RETRIES. `window.mcHostFallback` is a plain property the host
 *    bridge assigns, not an IO surface with EIO/EBUSY transients. There is no
 *    second read and no backoff, so there is nothing a raised error could buy.
 *
 * So a getter that throws is survived here, exactly as an absent one is, and
 * the guarantee two paragraphs up -- "every caller keeps its own fallback
 * rather than rendering a blank" -- is a guarantee this function has to keep.
 * See tools/test/host-fallback-sentence.test.mjs, which holds it against the
 * live-site defect of 2026-08-22. */
export function hostFallbackCode() {
  try {
    const published = globalThis.window?.mcHostFallback
    const code = published && published.code
    if (typeof code === 'string' && code.length > 0 && code.length <= 64) return code
  } catch { /* no window, or a getter that throws: fall through to null -- see above */ }
  return null
}

/** The one code that means "ask them", not "tell them why not". */
export const NO_MACHINE_CHOSEN = 'MC_NO_MACHINE_CHOSEN'

export function hostFallbackSentence() {
  try {
    const published = globalThis.window?.mcHostFallback
    const sentence = published && published.sentence
    if (typeof sentence === 'string' && sentence.length > 0 && sentence.length <= 400) return sentence
  } catch { /* no window, or a getter that throws: fall through to null -- see above */ }
  return null
}

/** Badge rule, in one place so no surface derives its own: mock is badged,
 *  real data -- local or relay alike -- never is. */
export function sourceIsBadged(source = resolved) {
  return source === 'mock'
}

export function announceDataSourceChange(why) {
  /* The host (or the toggle above) says "the world changed"; open views
     re-resolve. The event deliberately carries no verdict -- a stale verdict
     in an event payload is how two views end up in different worlds. */
  try {
    const event = new CustomEvent(DATA_SOURCE_EVENT, {
      detail: Object.freeze({ why: typeof why === 'string' ? why : 'host' }),
    })
    ownAnnouncements.add(event)
    globalThis.window?.dispatchEvent(event)
  } catch { /* no window: a test importing this for the pure parts */ }
}
