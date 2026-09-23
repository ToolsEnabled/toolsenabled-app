/* TEAMS — sending one intent to several agents, and what that costs.
 *
 * The owner asked for controls for "how their agents ... work together". The
 * dispatch API sends one brief to one tier and returns one launch receipt. A
 * team is therefore not a new engine concept: it is several dispatches that
 * share a parent, which the engine already understands and already bounds.
 *
 * THE TWO BOUNDS THIS FILE EXISTS TO TELL THE TRUTH ABOUT.
 *
 * 1. CAPABILITY TIERS ARE NOT SEATS. Each tier independently names the seats it
 *    may occupy. Luna, Terra and Sol each have one; the three Claude
 *    capabilities share four Claude worker seats; local nodes share four
 *    separate seats. The presence registry refuses a second live lane on an
 *    occupied seat (`AGENT_PRESENCE_ACTIVE`, surfaced as
 *    BRIDGE_AGENT_LANE_COLLISION / HTTP 409), so the picker counts demand by
 *    pool before dispatch rather than guessing from a provider name.
 *
 * 2. THE ENGINE'S FAN-OUT CAP IS REAL BUT DORMANT. MAX_FAN_OUT = 8 and
 *    MAX_DEPTH = 3 exist at
 *    capability/src/lib/controller-launch-record.js:50-51, and are enforced at
 *    :781-787 -- but ONLY when the launch names a `parentLaunchId`. No UI has
 *    ever sent one, so every dispatch made so far has been a depth-0 orphan and
 *    the cap has never once applied.
 *
 *    A team here dispatches a LEAD first and nests every other member under its
 *    launch id. That is what makes the engine's own cap engage, and it is also
 *    the honest shape of the thing the owner asked for: members that report to
 *    a lead rather than N unrelated processes that happen to share a brief.
 *
 * WHAT A TEAM DOES NOT DO, said here because the panel must not imply it:
 * `dispatch` returns as soon as the child is RUNNING (it resolves on the first
 * heartbeat with status `running` -- agent-lane-dispatch.js:229-238). The result
 * is never returned to the dispatcher; `actions.js:678` deliberately detaches
 * the completion. So a team collects START receipts, not answers. Anything
 * claiming to "collect the results" would be inventing a channel that does not
 * exist.
 *
 * tools/test/agent-teams.test.mjs parses the engine's own source for both
 * bounds and fails if this file drifts from it.
 */

import { DISPATCH_TIERS as LAUNCH_TIERS } from './orchestration-controls.js'
/* [B6] A refused lead or member used to read `${code}: ${reason}`. */
import { currentDataSource } from './data-source.js'
import { validOperationAuditReceipt } from './mission-bridge.js'
import { readerRemedy, refusalCodeOf, refusalRemedy, refusalSentence } from './refusal-copy.js'
import {
  WRITE_OUTCOME_KEYS,
  clearUndeliveredWrite,
  recordUndeliveredWrite,
  restatedMessage,
  undeliveredWrite,
} from './write-outcomes.js'

/* Which seats each tier can run on. A seat is the key the presence registry
   collides on, so this is topology rather than display copy. LAUNCH_TIERS is
   the renderer's canonical mirror of the engine contract; derive this lookup
   from it so a tier cannot be updated there while teams keep a second literal.
   The engine-source comparison in tools/test/agent-teams.test.mjs remains the
   cross-boundary anti-drift proof. */
export const TIER_SEAT_POOL = Object.freeze(Object.fromEntries(
  LAUNCH_TIERS.map(tier => [tier.id, tier.seats]),
))

/* The seat a tier is CERTAIN to take, or null when its pool holds more than one
   and dispatch picks a free one. Null is the honest answer rather than a
   missing entry: asking which lane a pooled tier becomes, before it is
   dispatched, is a question that has no answer yet. Callers that only need a
   name for a single-seat tier still get one. */
export const TIER_AGENT_IDENTITY = Object.freeze(Object.fromEntries(
  Object.entries(TIER_SEAT_POOL).map(([tier, seats]) => [tier, seats.length === 1 ? seats[0] : null]),
))

/** Every distinct seat a team could occupy, in tier order. */
export const TEAM_IDENTITIES = Object.freeze([
  ...new Set(LAUNCH_TIERS.flatMap(tier => TIER_SEAT_POOL[tier.id] || [])),
])

/* `maxDepth` mirrors capability/src/lib/controller-launch-record.js:50-51.
   `maxFanOut` is FOUR, not the engine's eight: a team's members are real tree
   children under the lead, and the tree seats four under one parent
   (TREE_BOUNDS.maxChildren in ./fleet-trees.js, the owner's width decision of
   2026-09-11). The engine's MAX_FAN_OUT of eight stays the backstop above it;
   tools/test/agent-teams.test.mjs holds this at or below that and equal to
   the tree's width.
   `maxConcurrent` is NOT from that file: it is the seat count above, which is
   the smaller and therefore governing limit on this machine. Both are stated
   because they fail differently -- exceeding the engine cap is
   LAUNCH_FANOUT_EXCEEDED, exceeding the seat count is a 409 collision. */
export const TEAM_BOUNDS = Object.freeze({
  maxFanOut: 4,
  maxDepth: 3,
  maxConcurrent: TEAM_IDENTITIES.length,
})

/**
 * Can these tiers run at the same time?
 *
 * Returns the conflicts rather than a boolean, because the panel has to be able
 * to say WHICH pair cannot coexist and why. A bare `false` would leave the
 * person to guess, which is the failure mode the unsupported-controls list
 * exists to prevent.
 */
export function identityConflicts(tierIds) {
  /* Demand against capacity, per pool -- NOT "have I seen this before".
     Two Claude tiers used to be a conflict because they were one identity.
     They are now two draws on a pool of four, which is fine; five draws on
     that same pool is not. Counting is the only version of this that stays
     right when a pool's size changes. */
  const demand = new Map()
  for (const tierId of tierIds) {
    const seats = TIER_SEAT_POOL[tierId]
    if (!seats) continue
    const key = seats.join(',')
    if (!demand.has(key)) demand.set(key, { seats, tiers: [] })
    demand.get(key).tiers.push(tierId)
  }

  const conflicts = []
  for (const { seats, tiers } of demand.values()) {
    if (tiers.length <= seats.length) continue
    const named = [...new Set(tiers)]
    conflicts.push(Object.freeze({
      identity: seats[0],
      seats: Object.freeze([...seats]),
      tiers: Object.freeze([...tiers]),
      reason: seats.length === 1
        ? (named.length === 1
          ? `This team names ${tiers.length} of ${named[0]}, and it runs as the declared agent "${seats[0]}", which can only have one live lane at a time.`
          : `${named.join(' and ')} are both the declared agent "${seats[0]}", which can only have one live lane at a time.`)
        : `This team names ${tiers.length} agents that share ${seats.length} seats, so ${tiers.length - seats.length} of them would have nowhere to run. Remove some, or run the rest as a second team.`,
    }))
  }
  return Object.freeze(conflicts)
}

/**
 * Validate a proposed team and say exactly why it is or is not dispatchable.
 *
 * `lead` is dispatched first and every member is nested under its launch, so
 * the lead occupies one of the seats. That is why a 7-seat machine yields a
 * lead plus at most 6 members, not a lead plus 7.
 */
export function planTeam({ lead = null, members = [] } = {}) {
  const problems = []
  const roster = [lead, ...members].filter(tier => typeof tier === 'string' && tier.length > 0)

  if (!lead) problems.push('A team needs a lead. The lead is dispatched first and every other member is nested under its launch.')
  if (members.length === 0) problems.push('A team needs at least one member besides the lead. One agent on its own is an ordinary dispatch.')

  for (const tier of roster) {
    /* Membership in the pool table, NOT a truthy identity: a pooled tier's
       identity is legitimately null until dispatch picks a seat, so testing
       the identity would reject every Claude tier as invented. */
    if (!TIER_SEAT_POOL[tier]) problems.push(`"${tier}" is not one of the six dispatchable tiers.`)
  }

  const conflicts = identityConflicts(roster)
  for (const conflict of conflicts) problems.push(conflict.reason)

  /* The engine cap counts SIBLINGS of the parent, so it applies to members
     only -- the lead is the parent, not one of its own children. Matching the
     engine's arithmetic here rather than approximating it is the difference
     between refusing early and being refused by LAUNCH_FANOUT_EXCEEDED after
     some members have already started. */
  if (members.length > TEAM_BOUNDS.maxFanOut) {
    /* Same repair as the loop panel's: "(LAUNCH_FANOUT_EXCEEDED)" named the
       refusal a person is being stopped from reaching, in a message whose whole
       job is to stop them reaching it. */
    problems.push(`At most ${TEAM_BOUNDS.maxFanOut} agents can run under one leader, and this team names ${members.length}. Remove some, or run the rest as a second team.`)
  }

  return Object.freeze({
    lead,
    members: Object.freeze([...members]),
    size: roster.length,
    /* The distinct seats this team could occupy -- not one entry per member.
       A pooled member has no seat until dispatch picks one, so mapping each
       member to an identity and dropping the nulls would silently shorten the
       list to the Codex members alone. */
    identities: Object.freeze([...new Set(roster.flatMap(tier => TIER_SEAT_POOL[tier] || []))]),
    conflicts,
    dispatchable: problems.length === 0,
    problems: Object.freeze(problems),
  })
}

/** The receipt shape a dispatch must return before a member may be called started. */
export function verifiedDispatchReceipt(result, expectedTier) {
  const receipt = result?.receipt
  return result?.ok === true
    && receipt && typeof receipt === 'object' && !Array.isArray(receipt)
    && receipt.action === 'dispatch'
    && receipt.tier === expectedTier
    && typeof receipt.launchId === 'string' && receipt.launchId.length > 0
    && typeof receipt.agentId === 'string' && receipt.agentId.length > 0
    && validOperationAuditReceipt(receipt, 'controller.agent.launch', receipt.launchId)
}

/* `code` defaults to null, never '': absence is not a blank value. */
function memberState(tier, phase, detail, receipt = null, code = null) {
  return Object.freeze({ tier, identity: TIER_AGENT_IDENTITY[tier] || null, phase, detail, receipt, code })
}

/* A team can be launched from the installed app or by a browser driving that
   app over the relay. Translate the remedy BEFORE composing it with the
   bridge's diagnosis: readerRemedy's literal twins match the remedy itself,
   not a longer diagnosis-plus-remedy sentence. The second pass also catches
   patterned desk instructions supplied as the bridge's readable reason. */
function teamRefusalSentence(result, { fallback = '' } = {}) {
  const viaRelay = currentDataSource() === 'relay'
  const remedy = readerRemedy(refusalRemedy(refusalCodeOf(result)), { viaRelay })
  return readerRemedy(refusalSentence(result, { fallback, remedy }), { viaRelay })
}

/**
 * DOM-independent team dispatcher, modelled on createTerminateController in
 * src/mission-bridge.js: the controller owns the sequence and the honesty
 * rules, the view only renders what it publishes.
 *
 * SEQUENCE, and why it is not Promise.all:
 *   1. the lead is dispatched and must return a verified receipt;
 *   2. every member is then dispatched IN SERIES with parentLaunchId set to the
 *      lead's launch id.
 *
 * Series, not parallel, because each member takes a distinct declared identity
 * and a parallel burst races the presence registry's own admission -- two lanes
 * for one identity would be refused by the engine, but the ORDER in which they
 * are refused would be nondeterministic, and a person cannot act on a team that
 * reports a different member failing each time.
 *
 * A member that is refused does NOT abort the team: the remaining members are
 * still attempted and every outcome is reported per member. Aborting would
 * leave already-started lanes running with nothing on screen naming them.
 */
export function createTeamController({
  plan,
  dispatchBody,
  postAction,
  onState = () => {},
} = {}) {
  let destroyed = false
  /* A TEAM RUN THAT FINISHED AFTER ITS PANEL CLOSED. Restated here on the next
     mount, because the launch ids it names are the only handle on lanes that are
     still running. */
  const missedTeam = undeliveredWrite(WRITE_OUTCOME_KEYS.TEAM_DISPATCH)
  let state = Object.freeze({
    phase: plan?.dispatchable ? 'idle' : 'unavailable',
    enabled: Boolean(plan?.dispatchable),
    lead: plan?.lead ? memberState(plan.lead, 'idle', 'Not dispatched.') : null,
    members: Object.freeze((plan?.members || []).map(tier => memberState(tier, 'idle', 'Not dispatched.'))),
    message: missedTeam
      ? restatedMessage(missedTeam)
      : (plan?.dispatchable
        ? `Dispatch ${plan.lead} as lead with ${plan.members.length} member${plan.members.length === 1 ? '' : 's'} nested under it.`
        : (plan?.problems || ['No team is selected.']).join(' ')),
  })

  const publish = next => {
    state = next
    if (!destroyed) onState(state)
  }
  publish(state)

  const patch = fields => publish(Object.freeze({ ...state, ...fields }))

  /* Where a finished team run says what it did. Always updates this controller's
     state; paints when a panel is listening; files the sentence for the next
     mount of the panel when there is none. */
  const settleTeam = (fields, tone, message) => {
    patch({ ...fields, message })
    if (destroyed) recordUndeliveredWrite(WRITE_OUTCOME_KEYS.TEAM_DISPATCH, { tone, message })
    else clearUndeliveredWrite(WRITE_OUTCOME_KEYS.TEAM_DISPATCH)
    return state
  }

  const withMember = (tier, next) => Object.freeze(
    state.members.map(member => (member.tier === tier ? next : member)),
  )

  async function send(tier, parentLaunchId) {
    let result
    try {
      result = await postAction('dispatch', {
        ...dispatchBody,
        tier,
        ...(parentLaunchId ? { parentLaunchId } : {}),
      })
    } catch (error) {
      result = { ok: false, code: 'BRIDGE_REQUEST_FAILED', reason: error?.message || 'dispatch request failed' }
    }
    if (verifiedDispatchReceipt(result, tier)) {
      return { ok: true, receipt: result.receipt }
    }
    /* A shaped success with an unverifiable receipt is reported as its own
       failure, not folded into "refused": the lane may well be running, and
       telling the person it was refused would invite a retry that starts a
       second one. dispatch carries no idempotency key. */
    const shapedSuccess = result?.ok === true
    return {
      ok: false,
      code: shapedSuccess ? 'BRIDGE_DISPATCH_RECEIPT_INVALID' : (result?.code || 'BRIDGE_REQUEST_FAILED'),
      /* [B6] The remedy that used to be tacked on here ("this lane may be
         running; check the fleet before retrying") is now the table's, and
         said more plainly. Keeping both printed the instruction twice. */
      reason: shapedSuccess
        ? 'The dispatch response was incomplete or named a different tier.'
        : (result?.reason || 'The dispatch was refused with no receipt.'),
    }
  }

  return Object.freeze({
    getState() { return state },
    destroy() { destroyed = true },
    async run() {
      if (destroyed || !state.enabled || state.phase !== 'idle') return state
      patch({
        phase: 'dispatching',
        enabled: false,
        lead: memberState(plan.lead, 'pending', 'Dispatching lead.'),
        message: 'Dispatching the lead. No member has been started yet.',
      })

      /* NO `if (destroyed) return` BETWEEN A DISPATCH AND ITS RECEIPT. Each
         send() starts a REAL agent lane and answers with a launch id that
         nothing else on this machine will tell you. Losing this panel is a
         reason to write the answer somewhere else, never a reason to have no
         answer -- a started lane nobody is told about keeps running. */
      const leadResult = await send(plan.lead, dispatchBody?.parentLaunchId || null)
      if (!leadResult.ok) {
        /* Nothing was spent and nothing is running, so this one is filed too but
           it is the only branch here that costs the person nothing to miss. */
        return settleTeam(
          {
            phase: 'failed',
            enabled: true,
            lead: memberState(plan.lead, 'refused',
              teamRefusalSentence(leadResult, { fallback: 'The dispatch was refused with no receipt.' }),
              null, leadResult.code || null),
          },
          'refused',
          'The lead was not started, so no member was dispatched. Nothing is running from this team.',
        )
      }

      const parentLaunchId = leadResult.receipt.launchId
      patch({
        lead: memberState(plan.lead, 'started', `Lead running as launch ${parentLaunchId}.`, leadResult.receipt),
        message: `Lead started. Nesting ${plan.members.length} member${plan.members.length === 1 ? '' : 's'} under launch ${parentLaunchId}.`,
      })

      /* Being torn down stops the team from dispatching ANOTHER member -- that
         is the right call and it is kept. What it must not do is abandon the run
         with no summary, because the lead, and every member already sent, are
         running whether or not this panel survived. */
      let unattempted = 0
      for (const tier of plan.members) {
        if (destroyed) { unattempted += 1; continue }
        patch({ members: withMember(tier, memberState(tier, 'pending', 'Dispatching.')) })
        const result = await send(tier, parentLaunchId)
        patch({
          members: withMember(tier, result.ok
            ? memberState(tier, 'started', `Running as launch ${result.receipt.launchId}, nested under ${parentLaunchId}.`, result.receipt)
            : memberState(tier, 'refused',
              teamRefusalSentence(result, { fallback: 'The dispatch was refused with no receipt.' }),
              null, result.code || null)),
        })
      }

      const started = state.members.filter(member => member.phase === 'started').length
      const refused = state.members.filter(member => member.phase === 'refused').length
      return settleTeam(
        { phase: refused === 0 && unattempted === 0 ? 'started' : 'partial', enabled: true },
        refused === 0 && unattempted === 0 ? 'confirmed' : 'refused',
        [
          `Lead ${plan.lead} and ${started} of ${plan.members.length} member${plan.members.length === 1 ? '' : 's'} started under launch ${parentLaunchId}.`,
          refused > 0 ? ` ${refused} refused; each is named above with its reason.` : '',
          unattempted > 0 ? ` ${unattempted} ${unattempted === 1 ? 'was' : 'were'} never dispatched because this panel closed first.` : '',
          ' Started means the process is running, not that it has answered: a dispatch returns no result.',
        ].join(''),
      )
    },
  })
}
