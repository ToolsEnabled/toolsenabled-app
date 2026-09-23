/* THE NODE CHATBOX — the right-hand rail's chat, opened by clicking a node.
 *
 * Owner, verbatim: "On the right when you click a node there should be a
 * chatbox along with the other buttons."
 *
 * Two things had to be true before this could be honest.
 *
 * 1. IT HAD TO BE REACHABLE. The rail already existed and already held a chat,
 *    but the only gesture that opened it was a DOUBLE click on a node
 *    (src/tree-graph.js), and a single click merely drew a selection ring.
 *    A chatbox nobody can find is the same as no chatbox, so the single click
 *    now opens the rail. The double click still works and is now a duplicate
 *    rather than the secret.
 *
 * 2. IT MUST NOT PRETEND TO REACH A PROCESS THAT CANNOT HEAR IT. This is the
 *    part that would otherwise have become the next "we can control
 *    temperature". A dispatched agent lane receives its entire prompt on stdin
 *    at spawn and the pipe is closed immediately afterwards; there is no
 *    second write. The supervisor mailbox is not a chat either — it is drained
 *    when a lane NEXT starts. So for most nodes on this page there is no live
 *    channel at all, and a composer would be a text box that silently discards
 *    what a person typed. The composer therefore appears only for an agent
 *    this app is itself running through mcAgent, and every other state says
 *    plainly why it cannot send.
 *
 * WHICH AGENTS AND RUNS APPEAR IS NOT THIS FILE'S DECISION. src/chatbox-feed.js
 * owns the person's two settings — which agents' context is shown, and whether
 * runs appear (three states: with, hidden, only). This module calls
 * planChatbox() and renders what it is told, so the settings page and this rail
 * cannot disagree about what should be on screen.
 */

import {
  CHATBOX_FEED_EVENT,
  planChatbox,
  filterTurns,
  readRunsMode,
  readAgentSelection,
} from './chatbox-feed.js'
import { resolveChatChannel, channelHasConversation } from './orchestration-controls.js'

const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const text = value => (typeof value === 'string' ? value : '')

/**
 * Everything the rail needs to draw, decided in one pure place.
 *
 * Separated from the DOM deliberately: the states that matter here are the
 * empty ones, and an empty state is exactly what a screenshot test is worst at
 * catching and a unit test is best at.
 *
 * @returns {{
 *   channel: {kind: string, canSend: boolean, reason: string|null},
 *   showContext: boolean, showRuns: boolean,
 *   turns: object[], runs: object[],
 *   hiddenAgents: number, filteredToNothing: boolean,
 *   emptyReason: string|null, composerReason: string|null
 * }}
 */
export function planNodeChatbox({
  agent = null,
  live = false,
  sessionAvailable = false,
  sessionAgentId = null,
  turns = [],
  runs = [],
  runsSupported = false,
} = {}) {
  const agentId = text(agent?.id) || null
  const channel = resolveChatChannel({ live, sessionAvailable, sessionAgentId, agentId })

  const allTurns = (Array.isArray(turns) ? turns : []).filter(isRecord)
  const allRuns = (Array.isArray(runs) ? runs : []).filter(isRecord)
  const selection = readAgentSelection()
  /* AVAILABILITY IS ABOUT THE SOURCE, NOT ABOUT ITS CONTENTS.
   *
   * These two flags first read `allTurns.length > 0` and `allRuns.length > 0`,
   * which quietly answers a different question: not "does this rail have a
   * conversation and a run record to draw on" but "do they happen to be
   * non-empty this second". The author of src/chatbox-feed.js flagged it, and
   * they are right about their own API's contract.
   *
   * Worth being precise about the blast radius rather than overstating it: on
   * this rail today the RENDERED output is identical either way, because the
   * runs section is guarded on `runs.length` and the empty-state layer below
   * reports the emptiness with its own specific sentence. The two symptoms
   * reported against it do not occur here — page 2 never renders
   * `chatboxNothingChosen`, and `filteredToNothing` is
   * `speaking.length > 0 && shown.length === 0`, independent of these flags.
   *
   * It is fixed anyway, because `showContext`/`showRuns` are the module's
   * vocabulary and not this file's, and a caller that means something else by
   * them is a defect waiting for the first person who trusts the name. This is
   * the same three-outcomes-not-two rule readLocalSessions() already keeps one
   * layer down: "nobody to ask", "asked and unreadable" and "asked, nothing
   * yet" are three sentences, and emptiness is the empty state's job. */
  const plan = planChatbox({
    contextAvailable: channelHasConversation(channel),
    runsAvailable: Boolean(runsSupported),
    runsMode: readRunsMode(),
    selection,
    agentsInSource: allTurns.map(turn => text(turn.who) || text(turn.sender)).filter(Boolean),
  })

  const shownTurns = plan.showContext ? filterTurns(allTurns, selection) : []
  const shownRuns = plan.showRuns ? allRuns : []

  /* The four ways this box can be empty are four different facts, and the
     screen must never report one as another. "You filtered everyone out" is
     recoverable by the person; "this agent has never said anything" is not. */
  let emptyReason = null
  if (!shownTurns.length && !shownRuns.length) {
    /* `filteredToNothing` IS A FACT ABOUT THE SELECTION, NOT ABOUT THIS BOX.
       It stays true when the conversation half is switched off entirely — in
       "show only runs" nothing is filtered out, the whole half is gone — so
       testing it first let it win over the runs-only branch and report the
       wrong cause. It is only actionable while the context half is on screen,
       so the question has to be asked by name. `contextFilteredToNothing` is
       the module's own gated form — this file no longer assembles the gate
       itself, so there is exactly one definition of it and it lives with the
       fact it gates. */
    if (plan.contextFilteredToNothing) emptyReason = 'Every agent in this conversation is hidden by your chat settings.'
    else if (plan.runsMode === 'only' && !allRuns.length) emptyReason = 'No runs recorded on the computer you are driving yet, and your chat settings show runs only.'
    else if (plan.runsMode === 'hidden' && !allTurns.length) emptyReason = 'Nothing said yet, and your chat settings hide runs.'
    else emptyReason = 'Nothing said yet.'
  }

  return Object.freeze({
    channel,
    showContext: plan.showContext,
    showRuns: plan.showRuns,
    turns: Object.freeze(shownTurns),
    runs: Object.freeze(shownRuns),
    /* BOTH HALVES OF EACH PAIR ARE PASSED THROUGH, under the module's own
       names. The raw fact answers "is every speaker unticked", which stays
       worth knowing while the conversation is off screen — a person in
       "show only runs" may want to know whether turning it back on would show
       them anything. The context- form answers "is THIS BOX empty because of
       the filter", which is the only one a rendering layer should act on.
       Keeping one and dropping the other is how the pair collapses back into
       the single ambiguous fact that caused the defect. */
    hiddenAgents: plan.hiddenAgents,
    filteredToNothing: plan.filteredToNothing,
    contextHiddenAgents: plan.contextHiddenAgents,
    contextFilteredToNothing: plan.contextFilteredToNothing,
    emptyReason,
    composerReason: channel.canSend ? null : channel.reason,
    /* "THERE IS NO CHANNEL" AND "YOU ASKED NOT TO SEE IT" ARE DIFFERENT FACTS.
       The rail draws its read-only frame whenever the conversation is not on
       screen, and that frame used to fall back to "No channel to this agent."
       — which is a lie on a simulated node in "show only runs", where the
       channel is fine and the person simply asked for runs. Found while fixing
       the gating above: same root, one layer over. Non-null only when a
       conversation EXISTS and the mode is what is hiding it.

       Keyed on channelHasConversation(), not on canSend. It read `canSend`
       first, which is the same fact only by accident: no channel kind yet has
       a conversation it cannot be written to. The first one that does — an
       interrupted session, or a read-only simulated fleet — would have flipped
       this back to null and revived the very defect it was added to fix. */
    contextHiddenReason: !plan.showContext && channelHasConversation(channel)
      ? 'Your chat settings show runs only, so this conversation is hidden here.'
      : null,
  })
}

/**
 * The sentence under the chat title. It names the channel, because "who am I
 * actually talking to" is the one question this box must always answer.
 */
export function channelCaption(channel, roleLabel = '') {
  const prefix = roleLabel ? `${roleLabel} · ` : ''
  if (!isRecord(channel)) return `${prefix}no channel`
  if (channel.kind === 'session') return `${prefix}live session · this reaches the running agent`
  if (channel.kind === 'simulated') return `${prefix}simulated fleet · replies are written by this app`
  return `${prefix}no live channel`
}

/**
 * Subscribe to the person's chat settings changing. Returns an unsubscribe.
 * The rail re-plans rather than re-reading storage in a render path, so a
 * setting changed in another window lands here too.
 */
export function onChatboxSettingsChanged(handler) {
  if (typeof handler !== 'function') return () => {}
  const listener = () => handler()
  globalThis.window?.addEventListener?.(CHATBOX_FEED_EVENT, listener)
  globalThis.window?.addEventListener?.('storage', listener)
  return () => {
    globalThis.window?.removeEventListener?.(CHATBOX_FEED_EVENT, listener)
    globalThis.window?.removeEventListener?.('storage', listener)
  }
}
