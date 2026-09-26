'use strict'

/* WHAT A SESSION STARTED HERE WOULD ACTUALLY BE ALLOWED TO DO -- read, never
 * assumed, and never started.
 *
 * THE DEFECT THIS EXISTS TO END. The agent page carried a frozen sentence under
 * its Start button saying a session "runs with your full local access" and that
 * "no permission tier limits a running session". Tier confinement then landed
 * underneath it (capability/src/lib/agent-session-confinement.js, bound by
 * startSession() in shell/agent-host.cjs) and nothing recomputed the sentence, so
 * the screen where a person decides to start an agent went on describing the
 * product as it had been. On a machine with no record -- a fresh install, which
 * fails closed to `guided` -- the promise was "full local access" over a session
 * whose sandbox is `read-only`.
 *
 * THE RENDERER CANNOT ANSWER THIS ITSELF, which is the whole reason for a
 * channel. The level lives in a machine record under the services root and the
 * tool surface comes from the payload's own registry; a page has neither, and
 * should not. mcSetup.bootstrap already carries the recorded TIER, but the tier
 * alone cannot say what the OS will do to the process or how many tools the
 * level is offered, and those are the two facts the old sentence got wrong.
 *
 * THREE RULES IT KEEPS, each matching an existing channel rather than inventing
 * a new posture:
 *   1. IT STARTS NOTHING. Like mc-agent:availability and mc-agent:history, this
 *      is a read. It resolves modules and asks them questions; it spawns no
 *      child, opens no session and writes no file.
 *   2. IT CARRIES NO PATH. Every failure answers {ok:false, code}. The resolver
 *      messages name absolute roots -- rendering one into the DOM is BLOCKER 2,
 *      the defect that cost this bridge its first version -- so the code is the
 *      whole reply and the message stays in main.
 *   3. IT NEVER GUESSES. Anything it cannot read is {ok:false}, which the copy
 *      module renders as "cannot tell", never as a reassuring default. A
 *      reassuring default is exactly the failure being repaired.
 *
 * WHY THE COUNTS ARE MEASURED HERE AND NOT WRITTEN DOWN ANYWHERE. They are a
 * property of the INSTALLED payload, not of the product. Measured on one machine
 * on one night: this checkout's payload answers guided 109 / standard 256 of 265,
 * and the release/win-unpacked payload beside it answers guided 116 / standard
 * 296 of 305. A constant would have been true of one of them and false of the
 * other, which is the same shape of defect as the sentence above.
 */

const path = require('node:path')

/* Resolved once per process. registeredTools() walks every provider in the
 * payload, and the answer cannot change while this build runs -- so paying for
 * it on every navigation to an agent page would be a real cost for a value that
 * is fixed. The confinement RECORD is deliberately not cached with it: the
 * permission level is changeable from Settings after first run, so that half is
 * re-read every time it is asked for. */
let toolCountsCache = null

function failure(code) {
  return Object.freeze({ ok: false, code })
}

/** The payload's own modules, or null when this copy carries no payload. */
function loadPayload(capabilityRoot) {
  if (typeof capabilityRoot !== 'string' || capabilityRoot.length === 0) return null
  try {
    return {
      confinement: require(path.join(capabilityRoot, 'src', 'lib', 'agent-session-confinement.js')),
      policy: require(path.join(capabilityRoot, 'src', 'lib', 'permission-tier-policy.js')),
      registry: require(path.join(capabilityRoot, 'src', 'lib', 'tool-registry.js')),
      /* OPTIONAL, and separately, because it answers a DIFFERENT question and
         must fail apart from the other three. The tier modules say what a level
         carries; this one says whether a tool already has to be approved one use
         at a time. A payload too old to carry it still lists its tools. */
      approvals: optionalModule(capabilityRoot, 'policy.js'),
    }
  } catch {
    /* A payload that is present but unloadable is reported as absent rather than
       thrown: this is a read on a page that must still render its other half. */
    return null
  }
}

function optionalModule(capabilityRoot, leaf) {
  try { return require(path.join(capabilityRoot, 'src', 'lib', leaf)) } catch { return null }
}

/**
 * Does this program already ask the person before each use of this tool?
 *
 * IT ASKS THE SAME FUNCTION THE DISPATCH ASKS. requiresApproval() is what
 * src/lib/tool-registry.js executeTool() consults on every call, so a page built
 * on this cannot describe a gate the run would not apply -- the property that
 * makes the confinement reading above honest, applied to the second question.
 *
 * A tool the registry marks as not approval-eligible can never be gated, whatever
 * the policy says, because the dispatch requires both.
 *
 * IT NEVER GUESSES UPWARDS. Anything unreadable answers false, and false is the
 * cautious answer here: the settings page treats an ungated tool set to "ask me
 * first" as held back rather than handed over, so being wrong this way costs a
 * tool and being wrong the other way spends one without asking.
 */
function approvalGateReader(payload) {
  const module_ = payload.approvals
  if (!module_ || typeof module_.requiresApproval !== 'function' || typeof module_.loadPolicy !== 'function') {
    return () => false
  }
  let policy
  try { policy = module_.loadPolicy() } catch { return () => false }
  return tool => {
    if (!tool || tool.approvalEligible !== true || typeof tool.effect !== 'string') return false
    try { return module_.requiresApproval(tool.name, tool.effect, policy) === true } catch { return false }
  }
}

/**
 * How many tools each level is offered, from the real registry.
 *
 * `allowed: null` at a level that narrows nothing is the honest shape and not a
 * missing value -- see toolsSentence() in src/agent-confinement-copy.js, which
 * renders it as "all N" rather than as "N of N". Returns null when the registry
 * cannot be read at all, which drops the sentence rather than inventing a count.
 */
function toolCounts(payload, tier) {
  if (!toolCountsCache) {
    try {
      const tools = payload.registry.registeredTools()
      if (!Array.isArray(tools) || tools.length === 0) return null
      const tiers = payload.policy.INSTALL_TIERS
      if (!tiers || typeof tiers[Symbol.iterator] !== 'function') return null
      const perTier = {}
      for (const candidate of tiers) {
        try {
          const session = payload.policy.installTierSession(candidate)
          perTier[candidate] = session.tier === 'full'
            ? null
            : payload.policy.allowedToolNames(tools, session).length
        } catch { perTier[candidate] = undefined }
      }
      toolCountsCache = { total: tools.length, perTier }
    } catch {
      /* A readable registry can still be paired with an older or incomplete
         policy module. This is optional display data, so omit it rather than
         rejecting the entire confinement-reading IPC request. */
      return null
    }
  }
  const allowed = toolCountsCache.perTier[tier]
  if (allowed === undefined) return null
  return { allowed, total: toolCountsCache.total }
}

/**
 * The reading the Start control renders.
 *
 * `resolveAgentConfinement` is the SAME function the agent host calls to build
 * the thread options it starts a session with, which is the property that makes
 * this honest: the page and the spawn read one source, so the screen cannot
 * describe a confinement the start would not apply. Asking a second source --
 * re-reading the machine record here and mapping it to a sandbox word locally --
 * is how the two answers drift, and drift is the defect.
 */
function readAgentConfinement({ capabilityRoot, servicesRoot } = {}) {
  const payload = loadPayload(capabilityRoot)
  if (!payload) return failure('AGENT_CONFINEMENT_UNAVAILABLE')

  let resolved
  try {
    resolved = payload.confinement.resolveAgentConfinement(
      servicesRoot ? { servicesRoot } : {},
    )
  } catch {
    /* resolveAgentConfinement is written not to throw. Checked anyway, because
       the cost of it being wrong is a page that cannot paint its own state. */
    return failure('AGENT_CONFINEMENT_RECORD_UNREADABLE')
  }
  if (!resolved || typeof resolved.tier !== 'string') return failure('AGENT_CONFINEMENT_RECORD_UNREADABLE')

  const counts = toolCounts(payload, resolved.tier)
  const isolated = resolved.isolated === true
  return Object.freeze({
    ok: true,
    tier: resolved.tier,
    sandbox: resolved.sandbox,
    approvalPolicy: resolved.approvalPolicy,
    isolated,
    recorded: resolved.recorded === true,
    failedClosed: resolved.failedClosed === true,
    code: resolved.code,
    /* `null` is meaningful (a level that narrows nothing); absent is not. Both
       keys are always present so the renderer never has to tell them apart. */
    toolsAllowed: counts ? counts.allowed : null,
    toolsTotal: counts ? counts.total : null,
  })
}

/**
 * The tool surface BY NAME, for the tools settings page.
 *
 * Same three rules as readAgentConfinement: it starts nothing, it carries no
 * path (tool names are registry identifiers, never filesystem paths), and it
 * never guesses ({ok:false, code} when the payload cannot answer). The tier
 * is resolved through the SAME resolveAgentConfinement the spawn uses, so the
 * `allowed` flag on each name is the truth about what a session started right
 * now would be offered -- before the person's own choices narrow it further.
 *
 * EVERY REGISTERED TOOL IS RETURNED, including the ones the level withholds.
 * That is deliberate: the page shows a withheld tool by name and says why it is
 * unavailable, where the drawer this replaced collapsed the whole set into a
 * count with no name and no door. `allowed: false` is the marking, never an
 * omission.
 */
function listAgentTools({ capabilityRoot, servicesRoot } = {}) {
  const payload = loadPayload(capabilityRoot)
  if (!payload) return failure('AGENT_CONFINEMENT_UNAVAILABLE')

  let resolved
  try {
    resolved = payload.confinement.resolveAgentConfinement(
      servicesRoot ? { servicesRoot } : {},
    )
  } catch {
    return failure('AGENT_CONFINEMENT_RECORD_UNREADABLE')
  }
  if (!resolved || typeof resolved.tier !== 'string') return failure('AGENT_CONFINEMENT_RECORD_UNREADABLE')

  let tools
  try { tools = payload.registry.registeredTools() } catch { return failure('AGENT_TOOLS_UNREADABLE') }
  if (!Array.isArray(tools) || tools.length === 0) return failure('AGENT_TOOLS_UNREADABLE')

  let allowedNames = null
  try {
    const session = payload.policy.installTierSession(resolved.tier)
    if (session.tier !== 'full') {
      allowedNames = new Set(payload.policy.allowedToolNames(tools, session))
    }
  } catch { return failure('AGENT_TOOLS_UNREADABLE') }

  const gated = approvalGateReader(payload)
  const names = []
  for (const tool of tools) {
    const name = typeof tool?.name === 'string' ? tool.name : null
    if (!name) continue
    names.push(Object.freeze({
      name,
      allowed: allowedNames === null || allowedNames.has(name),
      /* The second fact each row needs, and it is about the TOOL rather than
         about the level: whether a use of it already stops and asks. The
         settings page can only offer "ask me first" honestly where this is
         true, so it travels with the name instead of being guessed at the
         screen. */
      gated: gated(tool),
    }))
  }
  names.sort((left, right) => left.name.localeCompare(right.name))
  return Object.freeze({ ok: true, tier: resolved.tier, total: names.length, tools: Object.freeze(names) })
}

/** Test seam only. The cache is process-lifetime by design; a suite that swaps
 *  payloads has to be able to clear it. */
function resetToolCountsCache() {
  toolCountsCache = null
}

module.exports = { readAgentConfinement, listAgentTools, resetToolCountsCache }
