/* Shared permission-level copy for Settings and first-run setup. Tier IDs and
 * requested runtime policies stay aligned with the host. A denied write is not
 * proof of a read boundary: a Standard session can read beyond its project.
 */

export const TIER_CHOICES = Object.freeze([
  Object.freeze({
    tier: 'guided',
    label: 'I’m new to this',
    note: '',
    detail: 'The assistant starts in one folder you pick. Setup requests read-only work; files elsewhere on this computer may still be readable.',
  }),
  Object.freeze({
    tier: 'standard',
    label: 'I’ve used AI coding tools before',
    note: 'Recommended',
    detail: 'The assistant starts in the projects you add. Setup requests a restricted write policy; files elsewhere on this computer may still be readable.',
  }),
  Object.freeze({
    tier: 'unrestricted',
    label: 'I run agents with permissions bypassed',
    note: '',
    detail: 'The assistant can read, change, and delete any file on this computer and run any program, without asking.',
  }),
])

export const TIER_IDS = Object.freeze(TIER_CHOICES.map(choice => choice.tier))
// Recommendation for a positively unconfigured install, never an access fallback.
export const DEFAULT_TIER = 'standard'

export const TIER_QUESTION = 'How much should the assistant be allowed to do?'
export const TIER_QUESTION_SUB = 'This is the only thing you need to decide right now. You can change it later in Settings.'

/* Describe requested tool/write restrictions separately from read access and
 * from the program's resolved enforcement. Watching an externally run session
 * still leaves that process under the other program's control. */
export const TIER_LIMIT_LEAD = 'Before you choose, one thing this program will not pretend about.'
export const TIER_LIMIT_NOTICE = Object.freeze([
  'This level selects the available ToolsEnabled tools and the requested write policy. Setup writes that configuration for you. For Codex, Guided requests read-only work; Standard can request writes within your projects and the program’s temporary folders. Your choice of tools and roles can narrow this further. These modes can still read files elsewhere. Check the running session’s reported permissions before relying on a write restriction.',
  'An assistant started or resumed here receives this level’s requested permissions from that point. It does not undo what the session already did somewhere else. If you only watch a session that keeps running in another program, that program is still deciding what it may do. Choosing a level here does not reach that process.',
])

export const WORKSPACE_ACCESS_NOTICE = 'Default working folders for new assistants. The selected level sets the requested tool and write policy. The assistant may still read files elsewhere on this computer.'

/**
 * Normalize whatever the shell handed the renderer into one shape.
 *
 * Every unknown collapses to `available: false` with a code, never to a
 * cheerful default. A first-run screen that assumes it can write when it cannot
 * offers a button guaranteed to fail, which is the failure mode
 * mcAgent.availability() was added to stop.
 */
export function readSetupState(scope = globalThis) {
  const bridge = scope?.mcSetup
  if (!bridge || typeof bridge.chooseTier !== 'function') {
    return {
      available: false,
      configured: false,
      tier: null,
      code: 'MC_SETUP_SHELL_ABSENT',
      reason: 'This page is running in a browser rather than the installed application, so there is no computer here to configure.',
    }
  }
  /* mcSetup is mirrored over the relay, so its presence does not mean the
     computer described by bootstrap is the one displaying this page. The
     desktop-only proof is deliberately absent from the browser bridge. */
  const machine = typeof scope?.mcShell?.getBridgeProof === 'function'
    ? 'this computer'
    : 'the computer you are driving'
  const bootstrap = bridge.bootstrap
  /* Arrays are rejected explicitly. `typeof [] === 'object'`, so the obvious
     guard lets one through, and an array then answers `undefined` to every
     field below -- which reads as "available, nothing recorded yet" and opens
     the question with a button guaranteed to fail. That is the precise trap
     failing open exists to avoid. shell/main.cjs rejects arrays the same way in
     isPlainObject(); this is the renderer half of the same rule. */
  if (!bootstrap || typeof bootstrap !== 'object' || Array.isArray(bootstrap)) {
    return { available: false, configured: false, tier: null, code: 'MC_SETUP_STATE_ABSENT', reason: `The application did not report whether ${machine} has been set up.` }
  }
  if (bootstrap.ok === false || bootstrap.available === false) {
    return {
      available: false,
      configured: false,
      tier: null,
      code: bootstrap.code || 'MC_SETUP_UNAVAILABLE',
      reason: bootstrap.reason || 'This copy cannot record a permission level.',
    }
  }
  if (bootstrap.unreadable) {
    /* A record that exists and cannot be parsed is NOT "not set up yet".
       Treating it as absent invites this screen to overwrite a configuration
       nobody could read -- exactly what readMachineRecord refuses to do. */
    return {
      available: false,
      configured: false,
      tier: null,
      code: bootstrap.code || 'SETUP_MACHINE_RECORD_UNREADABLE',
      reason: bootstrap.reason || `${machine[0].toUpperCase()}${machine.slice(1)} already has a configuration, and it could not be read.`,
    }
  }
  const tier = TIER_IDS.includes(bootstrap.tier) ? bootstrap.tier : null
  if (!((bootstrap.configured === true && tier !== null)
      || (bootstrap.configured === false && bootstrap.tier === null))) {
    return { available: false, configured: false, tier: null, code: 'SETUP_MACHINE_RECORD_UNKNOWN',
      reason: `The recorded permission level for ${machine} is unknown. Read the existing configuration before choosing a new level.` }
  }
  return {
    available: true,
    configured: Boolean(bootstrap.configured) && tier !== null,
    tier,
    code: null,
    reason: null,
  }
}

/**
 * Should this launch open on the question instead of the fleet?
 *
 * Only when the app can actually record an answer AND no level has been
 * recorded yet. A build that cannot write one must never trap someone on a
 * screen whose only button fails, so unavailable means "carry on into the app",
 * not "block".
 */
export function firstRunPending(state) {
  return Boolean(state && state.available && !state.configured)
}

/**
 * Should the router send this navigation to the question?
 *
 * The decision lives here, as a pure function of state and route name, rather
 * than as a condition inside render(). That is not tidiness: src/main.js cannot
 * be executed without a DOM, so a guard written inline there can only be tested
 * by matching source text -- and a source match cannot tell `if (pending)` from
 * `if (false && pending)`. Both were tried; the second slipped through and the
 * gate silently stopped existing. As a function it is exercised for real.
 */
export function shouldOpenSetup(state, routeName) {
  return firstRunPending(state) && routeName !== 'setup'
}

/* The live copy, resolved once while the module graph evaluates -- the same
   moment the shell's synchronous bootstrap is available, and before the router
   paints. `noteTierRecorded` keeps it current after a save, because the
   bootstrap snapshot is from page load and would otherwise send the gate
   straight back to a question that has just been answered. */
export const SETUP_RESOLUTION = readSetupState()

export function noteTierRecorded(tier) {
  if (!TIER_IDS.includes(tier)) return SETUP_RESOLUTION
  SETUP_RESOLUTION.configured = true
  SETUP_RESOLUTION.tier = tier
  return SETUP_RESOLUTION
}
